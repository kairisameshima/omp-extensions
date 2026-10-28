// Live CodeBuild progress in a panel above the input box.
//
// `codebuild_watch` (tool) and `/cbwatch` (command) start a background watch and
// return at once, so the agent keeps working while the panel streams the build's
// phase and newest log lines. When the build ends the panel is removed and a
// result card is posted in the chat. The card reaches the agent the way a
// background job's completion does: at its next step if it is mid-turn, or as a
// new turn if it is idle and started the watch itself.
//
// @ts-nocheck

import { replaceTabs, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

const POLL_MS = 5_000;
// A deploy build waits on the image build before it exists, so a watch keyed
// on a commit may sit this long before its build appears.
const MAX_WATCH_MS = 2 * 60 * 60 * 1000;
// Log rows inside the frame; the borders add two more.
const LOG_ROWS = 8;
const MAX_LINE_CHARS = 180;
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "FAULT", "STOPPED", "TIMED_OUT"]);
const CONTAINER_PREFIX = /^\[Container\] \d{4}\/\d\d\/\d\d (\d\d:\d\d:\d\d)\.\d+ /;
const STATUS_COLOR = {
  IN_PROGRESS: "accent",
  SUCCEEDED: "success",
  FAILED: "error",
  FAULT: "error",
  TIMED_OUT: "error",
  STOPPED: "warning",
};
const BOX = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
};

// The theme's own corners and edges, so the panel matches tool cards and overlays.
function boxGlyph(theme, part) {
  try {
    return theme.symbol?.(`boxRound.${part}`) || BOX[part];
  } catch {
    return BOX[part];
  }
}

function fitTo(text, width) {
  const cut = truncateToWidth(text, width);
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

// A rounded frame whose top edge carries the title on the left and the status on the right.
function renderFrame(theme, width, panel) {
  if (width < 8) return [truncateToWidth(panel.title, width)];
  const g = (part) => boxGlyph(theme, part);
  const border = (s) => theme.fg("borderMuted", s);
  const inner = width - 4;

  let right = ` ${panel.status} `;
  if (visibleWidth(right) > inner / 2) right = "";
  const title = truncateToWidth(` ${panel.title} `, Math.max(0, width - 4 - visibleWidth(right)));
  const fill = Math.max(0, width - 4 - visibleWidth(title) - visibleWidth(right));
  const top =
    border(g("topLeft") + g("horizontal")) +
    theme.fg("accent", title) +
    border(g("horizontal").repeat(fill)) +
    theme.fg(panel.statusColor, right) +
    border(g("horizontal") + g("topRight"));

  const rows = panel.rows.length > 0 ? panel.rows : [{ text: "waiting for log output", color: "dim" }];
  const body = rows.map(({ text, color }) => {
    const cell = fitTo(replaceTabs(text), inner);
    return `${border(g("vertical"))} ${color ? theme.fg(color, cell) : cell} ${border(g("vertical"))}`;
  });
  const bottom = border(g("bottomLeft") + g("horizontal").repeat(width - 2) + g("bottomRight"));
  return [top, ...body, bottom];
}

function frameComponent(panel) {
  return (_tui, theme) => {
    let cachedWidth = -1;
    let cached = [];
    return {
      // Each poll mounts a new component, so a width-keyed memo is enough to return
      // the same rows for an unchanged render.
      render(width) {
        if (width !== cachedWidth) {
          cached = renderFrame(theme, width, panel);
          cachedWidth = width;
        }
        return cached;
      },
      invalidate() {
        cachedWidth = -1;
      },
    };
  };
}


async function aws(pi, args, target) {
  const result = await pi.exec("aws", [
    ...args,
    ...(target.profile ? ["--profile", target.profile] : []),
    ...(target.region ? ["--region", target.region] : []),
    "--output", "json",
    "--no-cli-pager",
  ]);
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || `aws exited ${result.code}`).trim().split("\n").pop());
  }
  return JSON.parse(result.stdout || "null");
}

async function findBuildId(pi, target) {
  if (target.buildId) return target.buildId;
  const listed = await aws(pi, [
    "codebuild", "list-builds-for-project",
    "--project-name", target.project,
    "--sort-order", "DESCENDING",
    "--max-items", "10",
  ], target);
  const ids = listed?.ids ?? [];
  if (!target.sourceVersion) return ids[0];
  if (ids.length === 0) return undefined;
  const builds = await aws(pi, ["codebuild", "batch-get-builds", "--ids", ...ids], target);
  const match = (builds?.builds ?? []).find((b) =>
    (b.resolvedSourceVersion ?? b.sourceVersion ?? "").startsWith(target.sourceVersion),
  );
  return match?.id;
}

function tidy(line) {
  const text = line.replace(/\r?\n$/, "").replace(/\t/g, "  ").replace(CONTAINER_PREFIX, "$1 ");
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS - 1)}…` : text;
}

function elapsed(startMs, endMs = Date.now()) {
  const s = Math.max(0, Math.round((endMs - startMs) / 1000));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function label(target) {
  return target.buildId ?? `${target.project}${target.sourceVersion ? `@${target.sourceVersion}` : ""}`;
}

// `wakeAgent`: the agent started this watch and is waiting on the result, so the
// result card starts a turn when the agent is idle. A watch the user started
// only shows the card.
function startWatch(pi, ctx, target, { wakeAgent }) {
  const key = `codebuild:${label(target)}`;
  const state = {
    buildId: target.buildId,
    status: "WAITING",
    phase: target.sourceVersion ? `waiting for a build of ${target.sourceVersion}` : "locating build",
    source: undefined,
    log: undefined,
    nextToken: undefined,
    lines: [],
    error: undefined,
    startedAt: Date.now(),
    endedAt: undefined,
    polling: false,
    done: false,
  };

  const render = () => {
    if (!ctx.hasUI) return;
    const name = state.buildId ? state.buildId.split(":")[0] : label(target);
    const sha = state.source ? ` · ${state.source.slice(0, 7)}` : "";
    const panel = {
      title: `CodeBuild · ${name}${sha}`,
      status: [state.status, state.phase, elapsed(state.startedAt)].filter(Boolean).join(" · "),
      statusColor: STATUS_COLOR[state.status] ?? "muted",
      rows: state.error
        ? [{ text: state.error, color: "error" }]
        : state.lines.slice(-LOG_ROWS).map((text) => ({ text })),
    };
    ctx.ui.setWidget(key, frameComponent(panel), { placement: "aboveEditor" });
  };

  const readNewLogLines = async () => {
    if (!state.log?.groupName || !state.log?.streamName) return;
    // get-log-events returns the same forward token once it has caught up.
    for (let page = 0; page < 10; page++) {
      const args = [
        "logs", "get-log-events",
        "--log-group-name", state.log.groupName,
        "--log-stream-name", state.log.streamName,
        "--start-from-head",
      ];
      if (state.nextToken) args.push("--next-token", state.nextToken);
      const events = await aws(pi, args, target);
      for (const e of events?.events ?? []) {
        const text = tidy(e.message ?? "");
        if (text.trim()) state.lines.push(text);
      }
      if (state.lines.length > 200) state.lines = state.lines.slice(-200);
      const token = events?.nextForwardToken;
      if (!token || token === state.nextToken) break;
      state.nextToken = token;
    }
  };

  const finish = (status, summary) => {
    state.done = true;
    ctx.clearTimer(timer);
    if (ctx.hasUI) ctx.ui.setWidget(key, undefined);
    const content = [
      `CodeBuild ${state.buildId ?? label(target)} ${status}${state.source ? ` (${state.source.slice(0, 7)})` : ""} after ${elapsed(state.startedAt, state.endedAt)}.`,
      summary,
    ].filter(Boolean).join("\n");
    pi.sendMessage(
      {
        customType: "codebuild-watch.result",
        content,
        display: true,
        details: { buildId: state.buildId, status, sourceVersion: state.source },
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
        finish("UNKNOWN", `Stopped watching after ${MAX_WATCH_MS / 60000} minutes.`);
        return;
      }
      if (!state.buildId) {
        state.buildId = await findBuildId(pi, target);
        if (!state.buildId) return;
      }
      const builds = await aws(pi, ["codebuild", "batch-get-builds", "--ids", state.buildId], target);
      const build = builds?.builds?.[0];
      if (!build) throw new Error(`build ${state.buildId} not found`);
      state.status = build.buildStatus;
      state.phase = build.currentPhase ?? "";
      state.source = build.resolvedSourceVersion ?? build.sourceVersion;
      if (build.logs?.streamName) state.log = build.logs;
      if (build.startTime) state.startedAt = Date.parse(build.startTime);
      if (build.endTime) state.endedAt = Date.parse(build.endTime);
      await readNewLogLines();
      state.error = undefined;
      if (TERMINAL.has(build.buildStatus)) {
        const failed = (build.phases ?? []).find((p) => p.phaseStatus && p.phaseStatus !== "SUCCEEDED");
        const reason = failed
          ? `Failed phase ${failed.phaseType}: ${failed.contexts?.[0]?.message ?? failed.phaseStatus}`
          : "";
        finish(build.buildStatus, reason);
        return;
      }
    } catch (error) {
      // Typically an expired SSO session; keep polling so a fresh login resumes the watch.
      state.error = String(error?.message ?? error);
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

function parseTarget(params) {
  const target = {
    buildId: params.build_id || undefined,
    project: params.project || undefined,
    sourceVersion: params.source_version || undefined,
    profile: params.profile || undefined,
    region: params.region || undefined,
  };
  if (!target.buildId && !target.project) throw new Error("Give build_id or project.");
  if (target.buildId && !target.buildId.includes(":")) {
    throw new Error(`build_id must look like "<project>:<uuid>", got "${target.buildId}".`);
  }
  return target;
}

export default function (pi) {
  const z = pi.zod;

  pi.registerTool({
    name: "codebuild_watch",
    label: "CodeBuild Watch",
    description:
      "Watch a CodeBuild build in a live panel above the user's input box, streaming its phase and newest log lines. " +
      "Returns immediately; when the build ends a result message (status and failed phase) is delivered. " +
      "Give build_id, or project for its newest build, or project plus source_version to wait for the build of that commit " +
      "(e.g. a deploy build that has not started yet).",
    approval: "read",
    parameters: z.object({
      build_id: z.string().optional().describe('Build id, "<project>:<uuid>"'),
      project: z.string().optional().describe("CodeBuild project name"),
      source_version: z.string().optional().describe("Commit sha prefix the build must have resolved"),
      profile: z.string().optional().describe("AWS profile owning the project (defaults to AWS CLI configuration)"),
      region: z.string().optional().describe("AWS region (defaults to AWS CLI configuration)"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const target = parseTarget(params);
      startWatch(pi, ctx, target, { wakeAgent: true });
      return {
        content: [{
          type: "text",
          text: `Watching ${label(target)} in a panel above the input box. A result message arrives when it ends.`,
        }],
        details: target,
      };
    },
  });

  pi.registerCommand("cbwatch", {
    description: "Watch a CodeBuild build: /cbwatch <project:uuid> | <project> [sha] [--profile p] [--region r]",
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const profileAt = words.indexOf("--profile");
      const profile = profileAt >= 0 ? words.splice(profileAt, 2)[1] : undefined;
      const regionAt = words.indexOf("--region");
      const region = regionAt >= 0 ? words.splice(regionAt, 2)[1] : undefined;
      const [first, second] = words;
      if (!first) {
        ctx.ui.notify("Usage: /cbwatch <project:uuid> | <project> [sha] [--profile p] [--region r]", "warning");
        return;
      }
      const target = parseTarget(
        first.includes(":")
          ? { build_id: first, profile, region }
          : { project: first, source_version: second, profile, region },
      );
      startWatch(pi, ctx, target, { wakeAgent: false });
      ctx.ui.notify(`Watching ${label(target)}`, "info");
    },
  });
}