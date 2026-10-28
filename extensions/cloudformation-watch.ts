// Live CloudFormation stack progress in a panel above the input box.
//
// `cloudformation_watch` (tool) and `/cfnwatch` (command) start a background
// watch and return at once, so the agent keeps working while the panel
// streams the stack's status and newest resource events. This is the usual
// way to watch a CDK deployment: CDK drives an underlying CFN stack, and this
// watches that stack directly by name or ARN. When the stack reaches a
// terminal status the panel is removed and a result card is posted in the
// chat, the way a background job's completion does: at the agent's next step
// if it is mid-turn, or as a new turn if it is idle and started the watch
// itself.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ThemeColor } from "@oh-my-pi/pi-tui/theme";
import { aws, elapsed, frameComponent, type WatchPanel } from "./watch-support";

interface CfnTarget {
  stack: string;
  profile?: string;
  region?: string;
}

interface CfnStack {
  StackId?: string;
  StackStatus?: string;
  StackStatusReason?: string;
}

interface DescribeStacksResponse {
  Stacks?: CfnStack[];
}

interface CfnStackEvent {
  EventId?: string;
  Timestamp?: string;
  LogicalResourceId?: string;
  ResourceType?: string;
  ResourceStatus?: string;
  ResourceStatusReason?: string;
}

interface DescribeStackEventsResponse {
  StackEvents?: CfnStackEvent[];
}

interface WatchState {
  stackId: string | undefined;
  status: string;
  reason: string | undefined;
  events: Map<string, CfnStackEvent>;
  error: string | undefined;
  // Fixed at watch start: the 2h timeout and the displayed elapsed time are
  // both measured from here, not from the stack's own CreationTime, since a
  // watch may sit waiting for a stack that does not exist yet.
  startedAt: number;
  endedAt: number | undefined;
  polling: boolean;
  done: boolean;
}

const POLL_MS = 5_000;
// CDK deploys can sit a while behind an asset build or a large changeset, so
// give a watch generous room before giving up on it.
const MAX_WATCH_MS = 2 * 60 * 60 * 1000;
const EVENT_ROWS = 8;
const MAX_LINE_CHARS = 180;
const MAX_EVENTS_KEPT = 500;

const SUCCESS_STATUSES: Record<string, true> = { CREATE_COMPLETE: true, UPDATE_COMPLETE: true, IMPORT_COMPLETE: true };
const FAILURE_STATUSES: Record<string, true> = {
  CREATE_FAILED: true,
  ROLLBACK_FAILED: true,
  ROLLBACK_COMPLETE: true,
  UPDATE_FAILED: true,
  UPDATE_ROLLBACK_FAILED: true,
  UPDATE_ROLLBACK_COMPLETE: true,
  DELETE_FAILED: true,
  IMPORT_ROLLBACK_FAILED: true,
  IMPORT_ROLLBACK_COMPLETE: true,
};
// DELETE_COMPLETE is genuinely ambiguous: it is the terminal status of both an
// intentional deletion and a failed *creation* (CloudFormation has nothing to
// roll back to, so it deletes the whole stack). We surface it as its own
// outcome rather than guessing; the caller has the context to know which one
// it watched for.
const STATUS_COLOR: Record<string, ThemeColor> = {
  WAITING: "muted",
  CREATE_COMPLETE: "success",
  UPDATE_COMPLETE: "success",
  IMPORT_COMPLETE: "success",
  CREATE_FAILED: "error",
  ROLLBACK_FAILED: "error",
  ROLLBACK_COMPLETE: "error",
  UPDATE_FAILED: "error",
  UPDATE_ROLLBACK_FAILED: "error",
  UPDATE_ROLLBACK_COMPLETE: "error",
  DELETE_FAILED: "error",
  IMPORT_ROLLBACK_FAILED: "error",
  IMPORT_ROLLBACK_COMPLETE: "error",
  DELETE_COMPLETE: "warning",
};

function classifyOutcome(status: string): "success" | "failure" | "deleted" | "unknown" {
  if (SUCCESS_STATUSES[status]) return "success";
  if (FAILURE_STATUSES[status]) return "failure";
  if (status === "DELETE_COMPLETE") return "deleted";
  // Includes true in-progress statuses and any status this watcher doesn't
  // recognize (e.g. added to the API later) — both keep polling.
  return "unknown";
}

function eventColor(status: string | undefined): ThemeColor | undefined {
  if (!status) return undefined;
  if (status.endsWith("_FAILED")) return "error";
  if (status.includes("ROLLBACK")) return "warning";
  if (status.endsWith("_COMPLETE")) return "success";
  return undefined;
}

function fmtTime(iso: string | undefined): string {
  const m = /T(\d\d:\d\d:\d\d)/.exec(iso ?? "");
  return m ? `${m[1]}Z` : "--:--:--";
}

function formatEvent(e: CfnStackEvent): string {
  const reason = e.ResourceStatusReason ? ` — ${e.ResourceStatusReason}` : "";
  const text = `${fmtTime(e.Timestamp)} ${e.LogicalResourceId ?? "?"} ${e.ResourceStatus ?? "?"}${reason}`;
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS - 1)}…` : text;
}

function shortName(stackRef: string): string {
  const m = /^arn:[^:]+:cloudformation:[^:]+:[^:]+:stack\/([^/]+)\/.+$/.exec(stackRef);
  return m ? m[1] : stackRef;
}

function label(target: CfnTarget): string {
  const name = shortName(target.stack);
  return target.region ? `${name} (${target.region})` : name;
}

function summarize(status: string, state: WatchState): string | undefined {
  const parts: string[] = [];
  if (state.reason) parts.push(`Stack: ${state.reason}`);
  if (classifyOutcome(status) === "failure") {
    const relevant = [...state.events.values()].filter(
      (e) => e.ResourceStatus && (e.ResourceStatus.endsWith("_FAILED") || e.ResourceStatus.includes("ROLLBACK")),
    );
    const failedOnly = relevant.filter((e) => e.ResourceStatus?.endsWith("_FAILED"));
    const pool = failedOnly.length > 0 ? failedOnly : relevant;
    const worst = pool.reduce<CfnStackEvent | undefined>(
      (latest, e) => (!latest || Date.parse(e.Timestamp ?? "0") > Date.parse(latest.Timestamp ?? "0") ? e : latest),
      undefined,
    );
    if (worst) {
      parts.push(
        `${worst.LogicalResourceId ?? "?"} (${worst.ResourceType ?? "?"}) ${worst.ResourceStatus}: ${worst.ResourceStatusReason ?? "no reason given"}`,
      );
    }
  }
  return parts.join(" — ") || undefined;
}

// `wakeAgent`: the agent started this watch and is waiting on the result, so
// the result card starts a turn when the agent is idle. A watch the user
// started only shows the card.
function startWatch(pi: ExtensionAPI, ctx: ExtensionContext, target: CfnTarget, opts: { wakeAgent: boolean }): string {
  const key = `cloudformation:${target.profile ?? ""}:${target.region ?? ""}:${target.stack}`;
  const state: WatchState = {
    stackId: undefined,
    status: "WAITING",
    reason: undefined,
    events: new Map(),
    error: undefined,
    startedAt: Date.now(),
    endedAt: undefined,
    polling: false,
    done: false,
  };

  const recentEvents = (): CfnStackEvent[] =>
    [...state.events.values()]
      .sort((a, b) => Date.parse(a.Timestamp ?? "0") - Date.parse(b.Timestamp ?? "0"))
      .slice(-EVENT_ROWS);

  const render = () => {
    if (!ctx.hasUI) return;
    const events = state.status === "WAITING" || state.error ? [] : recentEvents();
    const panel: WatchPanel = {
      title: `CloudFormation · ${label(target)}`,
      status: [state.status, elapsed(state.startedAt, state.endedAt)].filter(Boolean).join(" · "),
      statusColor: STATUS_COLOR[state.status] ?? "accent",
      rows: state.error
        ? [{ text: state.error, color: "error" }]
        : state.status === "WAITING"
          ? [{ text: `Waiting for stack ${shortName(target.stack)} to appear…`, color: "dim" }]
          : events.length > 0
            ? events.map((e) => ({ text: formatEvent(e), color: eventColor(e.ResourceStatus) }))
            : [{ text: "No stack events yet.", color: "dim" }],
    };
    ctx.ui.setWidget(key, frameComponent(panel), { placement: "aboveEditor" });
  };

  const finish = (status: string, summary: string | undefined) => {
    state.done = true;
    ctx.clearTimer(timer);
    if (ctx.hasUI) ctx.ui.setWidget(key, undefined);
    const outcome = classifyOutcome(status);
    const content = [
      `CloudFormation stack ${label(target)} ${status} after ${elapsed(state.startedAt, state.endedAt)}.`,
      summary,
    ]
      .filter(Boolean)
      .join("\n");
    pi.sendMessage(
      {
        customType: "cloudformation-watch.result",
        content,
        display: true,
        details: { stack: target.stack, stackId: state.stackId, status, outcome },
      },
      // Mid-turn, the agent gets it at its next step (and a `wait` returns).
      ctx.isIdle() ? { triggerTurn: opts.wakeAgent } : { deliverAs: "aside" },
    );
  };

  const fetchEvents = async () => {
    const events = await aws<DescribeStackEventsResponse>(
      pi,
      ["cloudformation", "describe-stack-events", "--stack-name", state.stackId ?? target.stack, "--no-paginate"],
      target,
    );
    for (const e of events?.StackEvents ?? []) {
      if (e.EventId) state.events.set(e.EventId, e);
    }
    if (state.events.size > MAX_EVENTS_KEPT) {
      const sorted = [...state.events.values()].sort(
        (a, b) => Date.parse(a.Timestamp ?? "0") - Date.parse(b.Timestamp ?? "0"),
      );
      state.events = new Map(sorted.slice(-MAX_EVENTS_KEPT).map((e) => [e.EventId as string, e]));
    }
  };

  const poll = async () => {
    if (state.polling || state.done) return;
    state.polling = true;
    try {
      if (Date.now() - state.startedAt > MAX_WATCH_MS) {
        state.endedAt = Date.now();
        finish(
          "UNKNOWN",
          `Stopped watching after ${MAX_WATCH_MS / 60000} minutes without a terminal status (last seen: ${state.status}).`,
        );
        return;
      }

      let stack: CfnStack | undefined;
      try {
        const described = await aws<DescribeStacksResponse>(
          pi,
          ["cloudformation", "describe-stacks", "--stack-name", state.stackId ?? target.stack],
          target,
        );
        stack = described?.Stacks?.[0];
      } catch (error) {
        const msg = String((error as Error)?.message ?? error);
        // Only a stack that has genuinely never existed under this name
        // resolves to this specific error; anything else (throttling, auth,
        // a typo'd region, a stack that existed and was then deleted and is
        // now outside CloudFormation's retention) must surface as a real
        // error, never be mistaken for "still waiting to be created".
        if (!state.stackId && /ValidationError/i.test(msg) && /does not exist/i.test(msg)) {
          state.status = "WAITING";
          state.error = undefined;
          return;
        }
        throw error;
      }
      if (!stack) throw new Error(`describe-stacks returned no stack for "${target.stack}".`);

      if (!state.stackId && stack.StackId) state.stackId = stack.StackId;
      state.status = stack.StackStatus ?? state.status;
      state.reason = stack.StackStatusReason;
      await fetchEvents();
      state.error = undefined;

      if (classifyOutcome(state.status) !== "unknown") {
        state.endedAt = Date.now();
        finish(state.status, summarize(state.status, state));
        return;
      }
    } catch (error) {
      // Typically an expired SSO session or a transient API error; keep
      // polling (without touching status) so a fresh login resumes the watch.
      state.error = String((error as Error)?.message ?? error);
    } finally {
      state.polling = false;
      if (!state.done) render();
    }
  };

  const timer = ctx.setInterval(poll, POLL_MS);
  render();
  poll();
  return key;
}

function parseTarget(params: { stack?: unknown; profile?: unknown; region?: unknown }): CfnTarget {
  const stack = String(params.stack ?? "").trim();
  if (!stack) throw new Error("Give a stack name or ARN.");
  return {
    stack,
    profile: (params.profile as string) || undefined,
    region: (params.region as string) || undefined,
  };
}

// Strict flag parsing for the slash command: unknown flags and flags missing
// their value are errors, never silently absorbed as the stack name.
function parseCommandArgs(argsStr: string): CfnTarget {
  const words = argsStr.trim().split(/\s+/).filter(Boolean);
  let profile: string | undefined;
  let region: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "--profile" || w === "--region") {
      const value = words[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${w} requires a value.`);
      }
      if (w === "--profile") profile = value;
      else region = value;
      i++;
    } else if (w.startsWith("--")) {
      throw new Error(`Unknown flag "${w}".`);
    } else {
      positional.push(w);
    }
  }
  if (positional.length === 0) throw new Error("Give a stack name or ARN.");
  if (positional.length > 1) throw new Error(`Unexpected extra argument "${positional[1]}".`);
  return parseTarget({ stack: positional[0], profile, region });
}

export default function (pi: ExtensionAPI) {
  const z = pi.zod;

  pi.registerTool({
    name: "cloudformation_watch",
    label: "CloudFormation Watch",
    description:
      "Watch a CloudFormation stack in a live panel above the user's input box, streaming its status and newest " +
      "resource events. Useful for watching a CDK deployment by its underlying CFN stack. Give the stack name or " +
      "ARN; if the stack does not exist yet (e.g. a deploy that has not created it), the watch waits for it to " +
      "appear. Returns immediately; when the stack reaches a terminal status (CREATE_COMPLETE, UPDATE_COMPLETE, " +
      "*_FAILED, *_ROLLBACK_COMPLETE, DELETE_COMPLETE, etc.) a result message with the final status and any " +
      "failure reason is delivered.",
    approval: "read",
    parameters: z.object({
      stack: z.string().describe("Stack name or ARN"),
      profile: z.string().optional().describe("AWS profile owning the stack (defaults to AWS CLI configuration)"),
      region: z.string().optional().describe("AWS region (defaults to AWS CLI configuration)"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const target = parseTarget(params);
      startWatch(pi, ctx, target, { wakeAgent: true });
      return {
        content: [
          {
            type: "text",
            text: `Watching stack ${label(target)} in a panel above the input box. A result message arrives when it reaches a terminal status.`,
          },
        ],
        details: target,
      };
    },
  });

  pi.registerCommand("cfnwatch", {
    description: "Watch a CloudFormation stack: /cfnwatch <stack-name-or-arn> [--profile p] [--region r]",
    handler: async (args: string, ctx: ExtensionContext) => {
      let target: CfnTarget;
      try {
        target = parseCommandArgs(args);
      } catch (error) {
        ctx.ui.notify(
          `${String((error as Error)?.message ?? error)} Usage: /cfnwatch <stack-name-or-arn> [--profile p] [--region r]`,
          "warning",
        );
        return;
      }
      startWatch(pi, ctx, target, { wakeAgent: false });
      ctx.ui.notify(`Watching stack ${label(target)}`, "info");
    },
  });
}
