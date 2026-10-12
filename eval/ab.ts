// v1 step 4 gate: does read-ahead make accepted turns faster? For replayed turns where the
// prediction (k=3, p ≥ pRead) matched what the user actually sent, the real prompt runs twice in
// a fork of the context as it was: plain, and with the read-ahead files injected. Reads, grep,
// find and ls hit the disk; edits and writes are recorded but not written; shell commands run
// only if read-only (others answer "not run in eval"), so nothing in your repos changes. Reports
// tool calls, turns, wall time, and whether both variants edit the same files.
//
//   npm run ab -- [--n 10] [--scan 300] [--model provider/id]
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { readdirSync, statSync } from "node:fs";
import { agentDir, dataDir, DEFAULTS } from "../src/config.ts";
import { extractTurns, type Turn } from "../src/evalcore.ts";
import { rejectReason } from "../src/filters.ts";
import { declaredTools, openFork, type ForkSource, type ToolExec } from "../src/fork.ts";
import { composeInjection } from "../src/inject.ts";
import { sampleOnce } from "../src/predict.ts";
import { readAhead } from "../src/readahead.ts";
import { AgreementScorer, calibrate, loadCalibration } from "../src/scorer.ts";
import { similarity } from "../src/similar.ts";
import { allowedCommand, diskSearchTools, readFromDisk, resolveIn } from "../src/tools.ts";
import { zeroUsage } from "../src/usage.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const want = Number(opt("n", "10"));
const scan = Number(opt("scan", "300"));
const modelArg = opt("model", "openai-codex/gpt-6-luna");

const runtime = await ModelRuntime.create({ authPath: join(agentDir(), "auth.json"), modelsPath: join(agentDir(), "models.json") });
const [provider, ...rest] = modelArg.split("/");
const model = runtime.getModel(provider, rest.join("/"));
if (!model) throw new Error(`unknown model ${modelArg}`);

const files: string[] = [];
const root = join(agentDir(), "sessions");
for (const d of readdirSync(root)) for (const f of readdirSync(join(root, d))) if (f.endsWith(".jsonl")) files.push(join(root, d, f));
files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

const turns: { t: Turn; header: any }[] = [];
for (const f of files) {
  if (turns.length >= scan) break;
  try {
    const sm = SessionManager.open(f);
    for (const t of extractTurns(f, sm.getBranch()).slice(-20)) turns.push({ t, header: sm.getHeader() });
  } catch {}
}

const src = (t: Turn, header: any): ForkSource => ({ cwd: header?.cwd ?? process.cwd(), agentDir: agentDir(), header, branch: t.prefix, tools: declaredTools(t.prefix), options: undefined, model, thinkingLevel: "low", modelRuntime: runtime, settings: {} });
const cal = loadCalibration(dataDir(), 3);
const scorer = new AgreementScorer(DEFAULTS.agreeCut, cal);
const limits = { maxWords: DEFAULTS.maxWords, maxChars: DEFAULTS.maxChars };

type Variant = { calls: number; turns: number; ms: number; edited: string[]; cost: number };

function evalExec(cwd: string, stats: { calls: number; edited: Set<string> }): ToolExec {
  const search = diskSearchTools(cwd);
  return async (name, a, signal) => {
    stats.calls++;
    if (name === "read") return readFromDisk(cwd, a, true, new Map());
    if (search[name]) {
      const r = await (search[name] as any).execute("ab", a, signal);
      return { content: (r?.content ?? []).filter((c: any) => c.type === "text") };
    }
    if (name === "edit" || name === "write") {
      const paths = [a?.path, ...(Array.isArray(a?.edits) ? a.edits.map((e: any) => e?.path ?? e?.glob) : [])].filter((p) => typeof p === "string");
      for (const p of paths) stats.edited.add(resolveIn(cwd, p));
      return { content: [{ type: "text", text: "Applied (eval: recorded, not written)." }] };
    }
    if (name === "bash") {
      const argv = allowedCommand(String(a?.command ?? ""));
      if (!argv) return { content: [{ type: "text", text: "(not run in eval)" }] };
      try {
        const { stdout, stderr } = await run(argv[0], argv.slice(1), { cwd, timeout: 20_000, maxBuffer: 8 << 20 });
        return { content: [{ type: "text", text: (stdout + stderr).slice(-50_000) || "(no output)" }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `${e?.stdout ?? ""}${e?.stderr ?? ""}` || String(e) }], isError: true };
      }
    }
    return { content: [{ type: "text", text: `${name}: not available in eval` }], isError: true };
  };
}

async function variant(s: ForkSource, prompt: string, inject?: { customType: string; content: string; display: boolean }): Promise<Variant> {
  const stats = { calls: 0, edited: new Set<string>() };
  const fork = await openFork(s, { exec: evalExec(s.cwd, stats), inject });
  const before = fork.session.messages.length;
  const t0 = Date.now();
  const timer = setTimeout(() => void fork.session.abort(), 180_000);
  const unsub = fork.session.subscribe((e: any) => {
    if (e.type === "tool_execution_start" && stats.calls >= 30) void fork.session.abort();
  });
  try {
    await fork.session.prompt(prompt, { expandPromptTemplates: false }).catch(() => undefined);
  } finally {
    clearTimeout(timer);
    unsub();
  }
  const msgs = fork.session.messages.slice(before) as any[];
  const cost = msgs.filter((m) => m.role === "assistant").reduce((a, m) => a + (m.usage?.cost?.total ?? 0), 0);
  const v = { calls: stats.calls, turns: msgs.filter((m) => m.role === "assistant").length, ms: Date.now() - t0, edited: [...stats.edited].sort(), cost };
  fork.dispose();
  return v;
}

const rows: { prompt: string; predicted: string; p: number; plain: Variant; ahead: Variant; files: number }[] = [];
for (const { t, header } of turns) {
  if (rows.length >= want) break;
  const s = src(t, header);
  try {
    statSync(s.cwd);
  } catch {
    continue;
  }
  const samples = await Promise.all([0, 1, 2].map(() => sampleOnce(s, { samples: 1, limits }).catch(() => ({ lines: [] as string[], usage: zeroUsage() }))));
  const raw = scorer.raw(samples.map((x) => x.lines.filter((l) => !rejectReason(l, limits))));
  if (!raw.length) continue;
  const p = calibrate(raw[0].raw, cal);
  if (p < DEFAULTS.pRead || similarity(raw[0].text, t.actual) < DEFAULTS.editedCut) continue;
  const ra = await readAhead(s, raw[0].text, { caps: DEFAULTS.readCaps, anchored: true });
  const inj = composeInjection(s.cwd, ra.files, DEFAULTS.injectChars, true);
  const plain = await variant(s, t.actual);
  const ahead = await variant(s, t.actual, inj ? { customType: "pi-next-turn-files", content: inj.text, display: false } : undefined);
  rows.push({ prompt: t.actual.slice(0, 80), predicted: raw[0].text, p, plain, ahead, files: ra.files.size });
  console.log(`${rows.length}. "${t.actual.slice(0, 60)}" p=${p.toFixed(2)} files=${ra.files.size} | plain ${plain.calls} calls ${plain.turns} turns ${(plain.ms / 1000).toFixed(1)}s | ahead ${ahead.calls} calls ${ahead.turns} turns ${(ahead.ms / 1000).toFixed(1)}s | same edits: ${JSON.stringify(plain.edited) === JSON.stringify(ahead.edited)}`);
}

const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
if (!rows.length) {
  console.log(`No turn in the ${turns.length} scanned had a matching prediction at p ≥ ${DEFAULTS.pRead}.`);
  process.exit(0);
}
const wall = sum((r) => r.ahead.ms) / sum((r) => r.plain.ms) - 1;
const calls = sum((r) => r.ahead.calls) / Math.max(1, sum((r) => r.plain.calls)) - 1;
const turnsDelta = sum((r) => r.ahead.turns) / Math.max(1, sum((r) => r.plain.turns)) - 1;
const same = rows.filter((r) => JSON.stringify(r.plain.edited) === JSON.stringify(r.ahead.edited)).length;
console.log(`\n${rows.length} accepted turns: wall ${(wall * 100).toFixed(0)}%, tool calls ${(calls * 100).toFixed(0)}%, turns ${(turnsDelta * 100).toFixed(0)}%, same edited files in ${same}/${rows.length}`);
console.log(`gate (wall ≤ −15% with unchanged outcome): ${wall <= -0.15 && same === rows.length ? "PASS" : "FAIL"}`);
