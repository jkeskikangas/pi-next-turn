// Files gathered ahead of time go into the accepted turn as already read (v1 D9), the way
// pi-jev-kit's seed does: whole files with N#HH anchors when the read tool speaks them (pi-multiedit),
// numbered lines otherwise, under a size cap; each whole file is announced as `anchored-view`.
import { relative } from "node:path";
import { formatAnchored, formatNumbered } from "./anchor.ts";

export const VIEW_EVENT = "anchored-view";

export type Injection = { text: string; views: { path: string; text: string }[]; files: string[] };

export function composeInjection(cwd: string, files: Map<string, string>, maxChars: number, anchored: boolean): Injection | undefined {
  const blocks: string[] = [];
  const views: Injection["views"] = [];
  const names: string[] = [];
  let used = 0;
  for (const [abs, content] of files) {
    const lines = content.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const rel = relative(cwd, abs) || abs;
    const block = `### ${rel} (complete, ${lines.length} lines)\n${anchored ? formatAnchored(lines, 1) : formatNumbered(lines, 1)}`;
    if (used + block.length > maxChars) continue;
    blocks.push(block);
    used += block.length;
    names.push(rel);
    if (anchored) views.push({ path: abs, text: content });
  }
  if (!blocks.length) return undefined;
  const lead = anchored
    ? "Files for this request, read ahead of time while the user was typing. Each is the whole file, already read: every line carries its N#HH anchor, so edit it directly without reading it again."
    : "Files for this request, read ahead of time while the user was typing. Each is the whole file, already read, with line numbers.";
  return { text: `${lead}\n\n${blocks.join("\n\n")}`, views, files: names };
}

/** Whether the main session's read tool returns N#HH anchors (pi-multiedit, pi-hashline-edit). */
export function readIsAnchored(tools: { name: string; description: string }[]): boolean {
  const read = tools.find((t) => t.name === "read");
  return !!read && /N#HH|LINE#HASH|#HH/.test(read.description);
}
