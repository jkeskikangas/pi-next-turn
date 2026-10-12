// What a fork's tool calls actually do (v1 D10, v2 E6). Declarations are mirrored from the main
// session (fork.ts); execution is decided here: read-only tools run against the disk, `edit` and
// `read` go to a pi-multiedit draft in v2, a short allowlist of read-only shell commands runs
// without a shell, and everything else is refused.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { createFindTool, createGrepTool, createLsTool } from "@earendil-works/pi-coding-agent";
import { formatAnchored, formatNumbered } from "./anchor.ts";
import type { ToolExec, ToolResult } from "./fork.ts";

const run = promisify(execFile);

export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

export function resolveIn(cwd: string, path: string): string {
  const p = String(path ?? "").replace(/^@/, "").replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
  return isAbsolute(p) ? p : resolve(cwd, p);
}

export function inside(cwd: string, abs: string): boolean {
  const r = relative(cwd, abs);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** A read tool over the disk: anchored (`N#HH:`) or numbered lines, with offset/limit paging. Records whole files read. */
export async function readFromDisk(cwd: string, args: any, anchored: boolean, seen: Map<string, string>): Promise<ToolResult> {
  const abs = resolveIn(cwd, args?.path);
  const info = await stat(abs).catch(() => undefined);
  if (!info) return text(`${args?.path}: no such file`, true);
  if (info.isDirectory()) return text(`${args?.path} is a directory; use ls or find`, true);
  const buf = await readFile(abs);
  if (buf.subarray(0, 8192).includes(0)) return text(`${args?.path} is a binary file`, true);
  const content = buf.toString("utf8");
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const offset = Math.max(1, Number(args?.offset) || 1);
  const limit = Math.max(1, Number(args?.limit) || MAX_LINES);
  let slice = lines.slice(offset - 1, offset - 1 + Math.min(limit, MAX_LINES));
  let bytes = 0;
  const kept: string[] = [];
  for (const l of slice) {
    bytes += Buffer.byteLength(l) + 1;
    if (bytes > MAX_BYTES) break;
    kept.push(l);
  }
  slice = kept;
  if (offset === 1 && slice.length === lines.length) seen.set(abs, content);
  const body = anchored ? formatAnchored(slice, offset) : formatNumbered(slice, offset);
  const end = offset + slice.length - 1;
  const more = end < lines.length ? `\n\n[lines ${offset}-${end} of ${lines.length}; continue with offset=${end + 1}]` : "";
  return text(body + more);
}

type AgentToolLike = { execute: (id: string, params: any, signal?: AbortSignal, onUpdate?: any) => Promise<any> };

export function diskSearchTools(cwd: string): Record<string, AgentToolLike> {
  return { grep: createGrepTool(cwd) as any, find: createFindTool(cwd) as any, ls: createLsTool(cwd) as any };
}

async function runAgentTool(tool: AgentToolLike, args: any, signal?: AbortSignal): Promise<ToolResult> {
  try {
    const r = await tool.execute("next-turn", args, signal);
    const content = (r?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => ({ type: "text" as const, text: c.text }));
    return { content: content.length ? content : [{ type: "text", text: "" }], details: r?.details };
  } catch (e) {
    return text((e as Error)?.message ?? String(e), true);
  }
}

// ── read-only shell commands (v2 E6) ──

const GIT_READ = new Set(["status", "diff", "log", "show", "blame", "ls-files", "grep", "rev-parse", "branch"]);
const PLAIN = new Set(["rg", "ls", "cat", "head", "tail", "wc", "pwd", "tree", "file", "stat"]);

/** Splits a command line into words with single/double quotes; undefined if it uses any shell feature. */
export function splitCommand(command: string): string[] | undefined {
  const words: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let has = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (quote === '"' && (ch === "$" || ch === "`" || ch === "\\")) return undefined;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || has) words.push(cur);
      cur = "";
      has = false;
      continue;
    }
    if (/[;&|<>`$(){}\\*?!#~\n]/.test(ch)) return undefined;
    cur += ch;
  }
  if (quote) return undefined;
  if (cur || has) words.push(cur);
  return words.length ? words : undefined;
}

/** Whether a shell command is on the read-only allowlist; returns its argv. */
export function allowedCommand(command: string): string[] | undefined {
  const argv = splitCommand(command);
  if (!argv) return undefined;
  const [cmd, ...rest] = argv;
  if (cmd === "git") {
    const sub = rest.find((a) => !a.startsWith("-"));
    if (!sub || !GIT_READ.has(sub)) return undefined;
    if (sub === "branch" && rest.some((a) => /^-(d|D|m|M|c|C|-delete|-move|-copy|-set-upstream|-unset-upstream|-edit-description)/.test(a))) return undefined;
    if (rest.some((a) => a === "--output" || a.startsWith("--output=") || a === "-o")) return undefined;
    return argv;
  }
  if (!PLAIN.has(cmd)) return undefined;
  if (cmd === "rg" && rest.some((a) => a === "--pre" || a.startsWith("--pre="))) return undefined;
  return argv;
}

async function runAllowed(cwd: string, argv: string[], signal?: AbortSignal): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await run(argv[0], argv.slice(1), { cwd, maxBuffer: 8 << 20, timeout: 20_000, signal, env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" } });
    const out = (stdout + (stderr ? `\n${stderr}` : "")).slice(-MAX_BYTES);
    return text(out || "(no output)");
  } catch (e: any) {
    const out = `${e?.stdout ?? ""}${e?.stderr ?? ""}`.slice(-MAX_BYTES);
    return text(`exit ${e?.code ?? "error"}\n${out || e?.message || e}`, true);
  }
}

// ── executors ──

export type Tracker = {
  calls: number;
  /** Whole files read, abs path → content (disk content in v1, drafted content in v2). */
  files: Map<string, string>;
  /** First refused call, which ends a speculation (v2 E6). */
  refused?: { name: string; reason: string };
};

export function newTracker(): Tracker {
  return { calls: 0, files: new Map() };
}

/** v1 read-ahead: read, grep, find, ls on disk; everything else refused. */
export function readOnlyExec(cwd: string, anchored: boolean, tracker: Tracker, onCall: () => void): ToolExec {
  const search = diskSearchTools(cwd);
  return async (name, args, signal) => {
    tracker.calls++;
    onCall();
    if (name === "read") return readFromDisk(cwd, args, anchored, tracker.files);
    if (search[name]) return runAgentTool(search[name], args, signal);
    tracker.refused ??= { name, reason: "read-ahead allows read, grep, find and ls only" };
    return text(`${name} is not available while reading ahead: only read, grep, find and ls. Stop and list what you read.`, true);
  };
}

export type DraftOps = {
  edit(params: any): Promise<ToolResult>;
  read(args: any): Promise<ToolResult & { fileText?: string; abs?: string }>;
};

/** v2 speculation: edit and read through the draft; grep/find/ls on disk; allowlisted read-only shell; else refused. */
export function speculativeExec(cwd: string, draft: DraftOps, tracker: Tracker, onCall: () => void, onRefused: () => void): ToolExec {
  const search = diskSearchTools(cwd);
  return async (name, args, signal) => {
    tracker.calls++;
    onCall();
    if (name === "edit") return draft.edit(args);
    if (name === "read") {
      const r = await draft.read(args);
      if (r.abs && r.fileText !== undefined) tracker.files.set(r.abs, r.fileText);
      return { content: r.content, details: r.details, isError: r.isError };
    }
    if (search[name]) return runAgentTool(search[name], args, signal);
    if (name === "bash") {
      const argv = allowedCommand(String(args?.command ?? ""));
      if (argv) return runAllowed(cwd, argv, signal);
    }
    tracker.refused ??= { name, reason: name === "bash" ? `command not on the read-only allowlist: ${String(args?.command ?? "").slice(0, 120)}` : `${name} is not available ahead of time` };
    onRefused();
    return text(`${name} is not available while this request is prepared ahead of time. Stop here.`, true);
  };
}

/** Prediction forks: any tool call ends the sample. */
export function blockedExec(onCall: () => void): ToolExec {
  return async (name) => {
    onCall();
    return text(`${name}: tools are disabled in this mode`, true);
  };
}
