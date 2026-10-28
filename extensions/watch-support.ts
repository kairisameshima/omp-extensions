import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { replaceTabs, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-tui/theme";

export interface AwsTarget {
  profile?: string;
  region?: string;
}

export interface WatchPanel {
  title: string;
  status: string;
  statusColor: ThemeColor;
  rows: { text: string; color?: ThemeColor }[];
}

type WidgetFactory = Exclude<Parameters<ExtensionContext["ui"]["setWidget"]>[1], string[] | undefined>;

const BOX = {
  topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯",
  horizontal: "─", vertical: "│",
};

function boxGlyph(theme: Theme, part: keyof typeof BOX): string {
  return theme.symbol(`boxRound.${part}`) || BOX[part];
}

function fitTo(text: string, width: number): string {
  const cut = truncateToWidth(text, width);
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

function renderFrame(theme: Theme, width: number, panel: WatchPanel): string[] {
  if (width < 8) return [truncateToWidth(panel.title, width)];
  const inner = width - 4;
  let right = ` ${panel.status} `;
  if (visibleWidth(right) > inner / 2) right = "";
  const title = truncateToWidth(` ${panel.title} `, Math.max(0, inner - visibleWidth(right)));
  const fill = Math.max(0, inner - visibleWidth(title) - visibleWidth(right));
  const top = theme.fg("borderMuted", boxGlyph(theme, "topLeft") + boxGlyph(theme, "horizontal")) +
    theme.fg("accent", title) + theme.fg("borderMuted", boxGlyph(theme, "horizontal").repeat(fill)) +
    theme.fg(panel.statusColor, right) +
    theme.fg("borderMuted", boxGlyph(theme, "horizontal") + boxGlyph(theme, "topRight"));
  const rows = panel.rows.length ? panel.rows : [{ text: "waiting for progress", color: "dim" as const }];
  const body = rows.map(({ text, color }) => {
    const cell = fitTo(replaceTabs(text.replace(/[\r\n]/g, " ")), inner);
    return `${theme.fg("borderMuted", boxGlyph(theme, "vertical"))} ${color ? theme.fg(color, cell) : cell} ${theme.fg("borderMuted", boxGlyph(theme, "vertical"))}`;
  });
  return [top, ...body, theme.fg("borderMuted", boxGlyph(theme, "bottomLeft") +
    boxGlyph(theme, "horizontal").repeat(width - 2) + boxGlyph(theme, "bottomRight"))];
}

export function frameComponent(panel: WatchPanel): WidgetFactory {
  return (_tui, theme) => {
    let cachedWidth = -1;
    let cached: string[] = [];
    return {
      render(width: number): string[] {
        if (width !== cachedWidth) {
          cached = renderFrame(theme, width, panel);
          cachedWidth = width;
        }
        return cached;
      },
      invalidate(): void { cachedWidth = -1; },
    };
  };
}

export async function aws<T = unknown>(pi: Pick<ExtensionAPI, "exec">, args: string[], target: AwsTarget): Promise<T> {
  const response = await pi.exec("aws", [
    ...args,
    ...(target.profile ? ["--profile", target.profile] : []),
    ...(target.region ? ["--region", target.region] : []),
    "--output", "json", "--no-cli-pager",
  ]);
  if (response.code !== 0) {
    throw new Error((response.stderr || response.stdout || `aws exited ${response.code}`).trim());
  }
  return JSON.parse(response.stdout || "null") as T;
}

export function elapsed(startMs: number, endMs: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
