// TUI rendering (v1 D8): a widget below the editor, never a replaced editor. Shown only while the
// editor is empty; the fill key puts the highlighted candidate into the editor, the cycle key
// moves the highlight.
import type { Candidate } from "./scorer.ts";

export type WidgetState = {
  candidates: Candidate[];
  selected: number;
  readAhead: "none" | "running" | "ready";
  draft?: { files: number; insertions: number; deletions: number; checks?: "pass" | "fail" | "none" };
  keys: { fill: string; cycle: string };
};

type ThemeLike = { fg(color: string, text: string): string } | undefined;

const paint = (theme: ThemeLike, color: string, s: string) => {
  try {
    return theme ? theme.fg(color as any, s) : s;
  } catch {
    return s;
  }
};

export function suffix(state: Pick<WidgetState, "readAhead" | "draft">): string {
  if (state.draft) {
    const d = state.draft;
    const files = `${d.files} file${d.files === 1 ? "" : "s"}`;
    const checks = d.checks === "pass" ? ", tests pass" : d.checks === "fail" ? ", tests fail" : "";
    return ` · draft: ${files}${checks}`;
  }
  if (state.readAhead === "ready") return " · files ready";
  if (state.readAhead === "running") return " · reading ahead…";
  return "";
}

export function renderWidget(state: WidgetState, theme?: ThemeLike): string[] {
  if (!state.candidates.length) return [];
  const lines: string[] = [];
  state.candidates.forEach((c, i) => {
    const on = i === state.selected;
    const mark = on ? "›" : " ";
    const text = on ? paint(theme, "text", c.text) : paint(theme, "dim", c.text);
    const tail = on ? paint(theme, "muted", suffix(state)) : "";
    lines.push(`${paint(theme, on ? "accent" : "dim", mark)} ${text}${tail}`);
  });
  const hint = state.candidates.length > 1 ? `${state.keys.fill} to use · ${state.keys.cycle} next` : `${state.keys.fill} to use`;
  lines[0] += `  ${paint(theme, "dim", hint)}`;
  return lines;
}
