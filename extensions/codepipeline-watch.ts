// Live CodePipeline execution progress in a panel above the input box.
//
// `codepipeline_watch` (tool) and `/cpwatch` (command) start a background
// watch and return at once. Without an execution id the watch discovers and
// pins the pipeline's newest execution (waiting for one to appear first, if
// needed); every poll after that targets the pinned id. When the execution
// reaches a terminal status the panel is removed and a result card is
// posted, the way a background job's completion does: at the agent's next
// step if it is mid-turn, or as a new turn if it is idle and started the
// watch itself.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ThemeColor } from "@oh-my-pi/pi-tui/theme";
import { aws, elapsed, frameComponent, type WatchPanel } from "./watch-support";

const POLL_MS = 5_000;
// 2h timeout and the panel's elapsed time are both measured from
// `state.startedAt` (watch start), never from a remote timestamp.
const MAX_WATCH_MS = 2 * 60 * 60 * 1000;
// Stage/action rows inside the frame; the borders add two more.
const ROWS = 8;
const MAX_LINE_CHARS = 180;

// PipelineExecutionStatus: Cancelled | InProgress | Stopped | Stopping |
// Succeeded | Superseded | Failed. Anything not in TERMINAL (including a
// status value added to the API after this was written) is treated as
// nonterminal, so an unrecognized status never causes a premature "done" —
// it just keeps polling.
const TERMINAL: Record<string, true> = { Succeeded: true, Failed: true, Stopped: true, Superseded: true, Cancelled: true };
const STATUS_COLOR: Record<string, ThemeColor> = {
  WAITING: "muted",
  InProgress: "accent",
  Stopping: "warning",
  Succeeded: "success",
  Failed: "error",
  Stopped: "warning",
  Superseded: "muted",
  Cancelled: "warning",
};
// ActionExecutionDetail.status: InProgress | Abandoned | Succeeded | Failed.
const ACTION_STATUS_COLOR: Record<string, ThemeColor> = {
  InProgress: "accent",
  Succeeded: "success",
  Failed: "error",
  Abandoned: "warning",
};

interface CodePipelineTarget {
  pipeline: string;
  executionId?: string;
  profile?: string;
  region?: string;
}

interface PipelineExecutionSummary {
  pipelineExecutionId?: string;
  status?: string;
  startTime?: string;
}

interface ListPipelineExecutionsOutput {
  pipelineExecutionSummaries?: PipelineExecutionSummary[];
}

interface ArtifactRevision {
  revisionId?: string;
  revisionSummary?: string;
}

interface PipelineExecution {
  pipelineExecutionId?: string;
  status?: string;
  statusSummary?: string;
  artifactRevisions?: ArtifactRevision[];
}

interface GetPipelineExecutionOutput {
  pipelineExecution?: PipelineExecution;
}

interface ActionExecutionErrorDetails {
  code?: string;
  message?: string;
}

interface ActionExecutionResult {
  errorDetails?: ActionExecutionErrorDetails;
  externalExecutionSummary?: string;
}

interface ActionExecutionOutput {
  executionResult?: ActionExecutionResult;
}

interface ActionExecutionDetail {
  actionName?: string;
  pipelineExecutionId?: string;
  stageName?: string;
  status?: string;
  startTime?: string;
  output?: ActionExecutionOutput;
}

interface ListActionExecutionsOutput {
  actionExecutionDetails?: ActionExecutionDetail[];
}

interface WatchState {
  executionId?: string;
  pinned: boolean;
  status: string;
  statusSummary?: string;
  revision?: string;
  actions: ActionExecutionDetail[];
  error?: string;
  // See MAX_WATCH_MS.
  startedAt: number;
  endedAt?: number;
  polling: boolean;
  done: boolean;
}

function tidy(text: string): string {
  const t = text.replace(/[\r\n\t]+/g, " ").trim();
  return t.length > MAX_LINE_CHARS ? `${t.slice(0, MAX_LINE_CHARS - 1)}…` : t;
}

function label(target: CodePipelineTarget): string {
  return target.executionId ? `${target.pipeline}@${target.executionId.slice(0, 8)}` : target.pipeline;
}

// AWS CLI JSON renders Timestamp fields as ISO8601 strings. A missing/unparseable
// value sorts first rather than producing NaN.
function startTimeMs(iso: string | undefined): number {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

async function discoverExecutionId(pi: ExtensionAPI, target: CodePipelineTarget): Promise<string | undefined> {
  const listed = await aws<ListPipelineExecutionsOutput>(
    pi,
    ["codepipeline", "list-pipeline-executions", "--pipeline-name", target.pipeline, "--max-items", "20"],
    target,
  );
  const summaries = listed?.pipelineExecutionSummaries ?? [];
  // Documented API order: newest execution first.
  return summaries[0]?.pipelineExecutionId;
}

async function fetchExecution(
  pi: ExtensionAPI,
  target: CodePipelineTarget,
  executionId: string,
): Promise<PipelineExecution | undefined> {
  const got = await aws<GetPipelineExecutionOutput>(
    pi,
    [
      "codepipeline",
      "get-pipeline-execution",
      "--pipeline-name",
      target.pipeline,
      "--pipeline-execution-id",
      executionId,
    ],
    target,
  );
  return got?.pipelineExecution;
}

async function fetchActions(
  pi: ExtensionAPI,
  target: CodePipelineTarget,
  executionId: string,
): Promise<ActionExecutionDetail[]> {
  // No --max-items/--no-paginate: the AWS CLI auto-paginates list-action-executions,
  // following nextToken on our behalf and merging every page's
  // actionExecutionDetails into this one array.
  const listed = await aws<ListActionExecutionsOutput>(
    pi,
    [
      "codepipeline",
      "list-action-executions",
      "--pipeline-name",
      target.pipeline,
      "--filter",
      `pipelineExecutionId=${executionId}`,
    ],
    target,
  );
  // Defensive: the server-side filter should already scope results to this
  // execution, but never let an action from another execution of the same
  // pipeline leak into this watch's displayed/reported state.
  return (listed?.actionExecutionDetails ?? []).filter((a) => a.pipelineExecutionId === executionId);
}

function buildRows(actions: ActionExecutionDetail[]): { text: string; color?: ThemeColor }[] {
  const sorted = [...actions].sort((a, b) => startTimeMs(a.startTime) - startTimeMs(b.startTime));
  return sorted.slice(-ROWS).map((a) => ({
    text: tidy(`${a.stageName ?? "?"} / ${a.actionName ?? "?"}: ${a.status ?? "UNKNOWN"}`),
    color: a.status ? ACTION_STATUS_COLOR[a.status] : undefined,
  }));
}

function findFailureDetail(actions: ActionExecutionDetail[]): string | undefined {
  const failed = actions.filter((a) => a.status === "Failed");
  if (failed.length === 0) return undefined;
  return failed
    .map((a) => {
      const err = a.output?.executionResult?.errorDetails;
      const detail = err?.message
        ? `${err.code ? `${err.code}: ` : ""}${err.message}`
        : (a.output?.executionResult?.externalExecutionSummary ?? "no error detail reported");
      return tidy(`${a.stageName ?? "?"} / ${a.actionName ?? "?"}: ${detail}`);
    })
    .join("\n");
}

function revisionLabel(execution: PipelineExecution | undefined): string | undefined {
  const rev = execution?.artifactRevisions?.[0];
  if (!rev) return undefined;
  return rev.revisionId ? rev.revisionId.slice(0, 7) : rev.revisionSummary?.slice(0, 20);
}

// `wakeAgent`: the agent started this watch and is waiting on the result, so
// the result card starts a turn when the agent is idle. A watch the user
// started only shows the card.
function startWatch(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  target: CodePipelineTarget,
  { wakeAgent }: { wakeAgent: boolean },
): string {
  // Identifies this watch for the widget and result card; includes the
  // execution id once discovery pins one.
  const key = `codepipeline:${target.profile ?? ""}:${target.region ?? ""}:${target.pipeline}:${target.executionId ?? "latest"}`;
  const state: WatchState = {
    executionId: target.executionId,
    pinned: Boolean(target.executionId),
    status: "WAITING",
    statusSummary: undefined,
    revision: undefined,
    actions: [],
    error: undefined,
    startedAt: Date.now(),
    endedAt: undefined,
    polling: false,
    done: false,
  };

  const render = () => {
    if (!ctx.hasUI) return;
    const rev = state.revision ? ` @ ${state.revision}` : "";
    const panel: WatchPanel = {
      title: `CodePipeline · ${target.pipeline}${rev}`,
      status: [state.status, state.statusSummary, elapsed(state.startedAt, state.endedAt)].filter(Boolean).join(" · "),
      statusColor: STATUS_COLOR[state.status] ?? "muted",
      rows: state.error
        ? [{ text: state.error, color: "error" as const }]
        : !state.pinned
          ? [{ text: `Waiting for an execution of ${target.pipeline}…`, color: "dim" as const }]
          : buildRows(state.actions),
    };
    ctx.ui.setWidget(key, frameComponent(panel), { placement: "aboveEditor" });
  };

  const finish = (status: string, summary: string | undefined) => {
    state.done = true;
    ctx.clearTimer(timer);
    if (ctx.hasUI) ctx.ui.setWidget(key, undefined);
    const content = [
      `CodePipeline ${target.pipeline} execution ${state.executionId ?? "?"} ${status} after ${elapsed(state.startedAt, state.endedAt)}.`,
      summary,
    ]
      .filter(Boolean)
      .join("\n");
    pi.sendMessage(
      {
        customType: "codepipeline-watch.result",
        content,
        display: true,
        details: {
          pipeline: target.pipeline,
          executionId: state.executionId,
          status,
          revision: state.revision,
        },
      },
      // Mid-turn, the agent gets it at its next step (and a `wait` returns).
      ctx.isIdle() ? { triggerTurn: wakeAgent } : { deliverAs: "aside" },
    );
  };

  const poll = async () => {
    if (state.polling || state.done) return;
    state.polling = true;
    try {
      if (Date.now() - state.startedAt > MAX_WATCH_MS) {
        state.endedAt = Date.now();
        finish("UNKNOWN", `Stopped watching after ${MAX_WATCH_MS / 60000} minutes.`);
        return;
      }

      if (!state.pinned) {
        const found = await discoverExecutionId(pi, target);
        if (!found) return; // No execution yet; keep waiting.
        state.executionId = found;
        state.pinned = true;
      }
      const executionId = state.executionId as string;

      const execution = await fetchExecution(pi, target, executionId);
      if (!execution) throw new Error(`get-pipeline-execution returned no execution for "${executionId}".`);
      state.status = execution.status ?? "UNKNOWN";
      state.statusSummary = execution.statusSummary;
      state.revision = revisionLabel(execution);
      state.actions = await fetchActions(pi, target, executionId);
      state.error = undefined;

      if (TERMINAL[state.status]) {
        state.endedAt = Date.now();
        finish(state.status, findFailureDetail(state.actions));
        return;
      }
    } catch (error) {
      // Typically an expired SSO session or a transient API error; keep
      // polling (without touching status) so a fresh login resumes the watch.
      state.error = error instanceof Error ? error.message : String(error);
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

function parseTarget(params: {
  pipeline?: unknown;
  execution_id?: unknown;
  profile?: unknown;
  region?: unknown;
}): CodePipelineTarget {
  const pipeline = String(params.pipeline ?? "").trim();
  if (!pipeline) throw new Error("Give a pipeline name.");
  const executionId = params.execution_id ? String(params.execution_id).trim() || undefined : undefined;
  return {
    pipeline,
    executionId,
    profile: params.profile ? String(params.profile) : undefined,
    region: params.region ? String(params.region) : undefined,
  };
}

// Strict flag parsing for the slash command: unknown flags and flags missing
// their value are errors, never silently absorbed as the pipeline name.
function parseCommandArgs(argsStr: string): CodePipelineTarget {
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
  if (positional.length === 0) throw new Error("Give a pipeline name.");
  if (positional.length > 2) throw new Error(`Unexpected extra argument "${positional[2]}".`);
  return parseTarget({ pipeline: positional[0], execution_id: positional[1], profile, region });
}

export default function (pi: ExtensionAPI) {
  const z = pi.zod;

  pi.registerTool({
    name: "codepipeline_watch",
    label: "CodePipeline Watch",
    description:
      "Watch a CodePipeline execution in a live panel above the user's input box, streaming its stage/action " +
      "progress. Give pipeline alone to watch its newest execution (waiting for one to exist if there isn't one " +
      "yet), or pipeline plus execution_id to watch a specific execution. Returns immediately; when the execution " +
      "reaches a terminal status (Succeeded, Failed, Stopped, Superseded, Cancelled) a result message with the " +
      "final status and any failed action's error detail is delivered.",
    approval: "read",
    parameters: z.object({
      pipeline: z.string().describe("CodePipeline pipeline name"),
      execution_id: z.string().optional().describe("Pipeline execution id to watch (defaults to the newest execution)"),
      profile: z.string().optional().describe("AWS profile owning the pipeline (defaults to AWS CLI configuration)"),
      region: z.string().optional().describe("AWS region (defaults to AWS CLI configuration)"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const target = parseTarget(params);
      startWatch(pi, ctx, target, { wakeAgent: true });
      return {
        content: [
          {
            type: "text",
            text: `Watching ${label(target)} in a panel above the input box. A result message arrives when it reaches a terminal status.`,
          },
        ],
        details: target,
      };
    },
  });

  pi.registerCommand("cpwatch", {
    description: "Watch a CodePipeline execution: /cpwatch <pipeline> [execution-id] [--profile p] [--region r]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      let target: CodePipelineTarget;
      try {
        target = parseCommandArgs(args);
      } catch (error) {
        ctx.ui.notify(
          `${error instanceof Error ? error.message : String(error)} Usage: /cpwatch <pipeline> [execution-id] [--profile p] [--region r]`,
          "warning",
        );
        return;
      }
      startWatch(pi, ctx, target, { wakeAgent: false });
      ctx.ui.notify(`Watching ${label(target)}`, "info");
    },
  });
}
