// Replay eval (plans/v1.md step 1). Replays the user's own pi sessions: for every user message
// with at least two assistant messages before it, forks the context as it was, predicts, and
// compares with what the user actually sent. Sends past session content to the chosen model
// provider (as the original sessions did); runs only when invoked and lists the sessions it reads.
//
//   npm run eval -- [--turns 400] [--per-session 25] [--k 1,3] [--model provider/id] [--read-ahead] [--fit]
//                   [--pairs pairs.json] [--labels labels.json] [--sessions dir] [--concurrency 4]
//
// --fit writes the calibration table fitted on the calibration split to the agent dir, where the
// extension loads it. --pairs writes (prediction, actual, similarity) pairs for hand labelling;
// --labels reads them back ({similarity, same}[]) and reports the best similarity cut.
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { agentDir, dataDir, DEFAULTS } from "../src/config.ts";
import { bestCut, extractTurns, fileOverlap, gate, metrics, splitOf, type Scored, type Turn } from "../src/evalcore.ts";
import { declaredTools, type ForkSource } from "../src/fork.ts";
import { sampleOnce } from "../src/predict.ts";
import { readAhead } from "../src/readahead.ts";
import { rejectReason } from "../src/filters.ts";
import { AgreementScorer, calibrate, calibrationPath, DEFAULT_CALIBRATION, fitCalibration } from "../src/scorer.ts";
import { similarity } from "../src/similar.ts";
import { addUsage, zeroUsage } from "../src/usage.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const maxTurns = Number(opt("turns", "400"));
const perSession = Number(opt("per-session", "25"));
const ks = (opt("k", "1,3") ?? "3").split(",").map(Number).filter((n) => n > 0);
const concurrency = Number(opt("concurrency", "4"));
const sessionsDir = resolve(opt("sessions", join(agentDir(), "sessions"))!);
const modelArg = opt("model", "openai-codex/gpt-6-luna")!;

function sessionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const d of readdirSync(dir)) {
    const p = join(dir, d);
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) if (f.endsWith(".jsonl")) out.push(join(p, f));
  }
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

const runtime = await ModelRuntime.create({ authPath: join(agentDir(), "auth.json"), modelsPath: join(agentDir(), "models.json") });
const [provider, ...rest] = modelArg.split("/");
const model = runtime.getModel(provider, rest.join("/"));
if (!model) throw new Error(`unknown model ${modelArg}`);

const turns: Turn[] = [];
const used = new Set<string>();
const repos = new Set<string>();
const headers = new Map<string, any>();
for (const file of sessionFiles(sessionsDir)) {
  if (turns.length >= maxTurns) break;
  let sm: SessionManager;
  try {
    sm = SessionManager.open(file);
  } catch {
    continue;
  }
  // Newest turns of each session, at most `perSession`, so many sessions and repos are covered.
  const ts = extractTurns(file, sm.getBranch()).slice(-perSession);
  if (!ts.length) continue;
  used.add(file);
  repos.add(sm.getCwd());
  headers.set(file, sm.getHeader());
  for (const t of ts) if (turns.length < maxTurns) turns.push(t);
}
console.log(`Replaying ${turns.length} turns from ${used.size} sessions in ${repos.size} repos with ${modelArg}. Sessions read:`);
for (const f of used) console.log(`  ${f}`);
if (repos.size < 5) console.log(`note: fewer than 5 repos (${repos.size}); the plan asks for at least 5.`);

function sourceFor(t: Turn): ForkSource {
  const header = headers.get(t.sessionFile);
  return { cwd: header?.cwd ?? process.cwd(), agentDir: agentDir(), header, branch: t.prefix, tools: declaredTools(t.prefix), options: undefined, model, thinkingLevel: "low", modelRuntime: runtime, settings: {} };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
        if ((i + 1) % 20 === 0) process.stderr.write(`  ${i + 1}/${items.length}\n`);
      }
    }),
  );
  return out;
}

const limits = { maxWords: DEFAULTS.maxWords, maxChars: DEFAULTS.maxChars };
const maxK = Math.max(...ks);
// Draw maxK samples per turn once; each variant k uses the first k (same draws, fair comparison).
const draws = await pool(turns, concurrency, async (t) => {
  const t0 = Date.now();
  const runs = await Promise.all(Array.from({ length: maxK }, () => sampleOnce(sourceFor(t), { samples: 1, limits }).catch(() => ({ lines: [] as string[], usage: zeroUsage() }))));
  return { runs, ms: Date.now() - t0 };
});

const report: Record<string, unknown> = { model: modelArg, turns: turns.length, sessions: used.size, repos: repos.size, variants: {} };
const pairs: { prediction: string; actual: string; similarity: number }[] = [];
for (const k of ks) {
  const scorer = new AgreementScorer(DEFAULTS.agreeCut);
  const rawRows = turns.map((turn, i) => {
    const runs = draws[i].runs.slice(0, k);
    let usage = zeroUsage();
    const dropped: { text: string; reason: string }[] = [];
    const samples = runs.map((r) => {
      usage = addUsage(usage, r.usage);
      return r.lines.filter((l) => {
        const reason = rejectReason(l, limits);
        if (reason) dropped.push({ text: l, reason });
        return !reason;
      });
    });
    return { turn, raw: scorer.raw(samples), cost: usage.cost, ms: draws[i].ms, dropped };
  });
  const fitPairs = rawRows.filter((r) => splitOf(r.turn.sessionFile) === "calibration" && r.raw.length).map((r) => ({ raw: r.raw[0].raw, hit: similarity(r.raw[0].text, r.turn.actual) >= DEFAULTS.editedCut }));
  const cal = fitPairs.length >= 20 ? fitCalibration(fitPairs, k) : DEFAULT_CALIBRATION;
  const toScored = (r: (typeof rawRows)[number]): Scored => ({ turn: r.turn, candidates: r.raw.map((c) => ({ ...c, p: calibrate(c.raw, cal) })), cost: r.cost, ms: r.ms, dropped: r.dropped });
  const test = rawRows.filter((r) => splitOf(r.turn.sessionFile) === "test").map(toScored);
  const all = rawRows.map(toScored);
  const m = metrics(test.length ? test : all, { pShow: DEFAULTS.pShow, pHigh: DEFAULTS.pRead, cut: DEFAULTS.editedCut });
  const g = gate(m);
  (report.variants as any)[`k${k}`] = { calibration: cal, test: m, all: metrics(all, { pShow: DEFAULTS.pShow, pHigh: DEFAULTS.pRead, cut: DEFAULTS.editedCut }), gate: g };
  console.log(`\n== k=${k} (test split: ${test.length} turns) ==`);
  console.log(`coverage ${(m.coverage * 100).toFixed(0)}% · top hit ${(m.hitTop * 100).toFixed(0)}% · any shown hit ${(m.hitAny * 100).toFixed(0)}% · p≥0.7: ${m.highConfidence.n} turns, hit ${(m.highConfidence.hitRate * 100).toFixed(0)}% (mean p ${m.highConfidence.meanP.toFixed(2)}) · ECE ${m.ece.toFixed(3)} · $${m.costPerTurn.toFixed(4)}/turn · ${m.msPerTurn.toFixed(0)} ms/turn`);
  console.log(`filters: ${JSON.stringify(m.filterFalseDrops)}`);
  console.log(`gate: ${g.pass ? "PASS" : "FAIL — " + g.reasons.join("; ")}`);
  if (flag("fit")) {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(calibrationPath(dataDir(), k), JSON.stringify(cal, null, 2) + "\n");
    console.log(`calibration written to ${calibrationPath(dataDir(), k)}`);
  }
  if (k === ks[ks.length - 1]) for (const r of all) if (r.candidates[0]) pairs.push({ prediction: r.candidates[0].text, actual: r.turn.actual, similarity: similarity(r.candidates[0].text, r.turn.actual) });
}

if (flag("read-ahead")) {
  const k = ks[ks.length - 1];
  const scorer = new AgreementScorer(DEFAULTS.agreeCut);
  const candidatesFor = (i: number) => scorer.raw(draws[i].runs.slice(0, k).map((r) => r.lines.filter((l) => !rejectReason(l, limits))));
  const cal = ((report.variants as any)[`k${k}`]?.calibration ?? DEFAULT_CALIBRATION) as any;
  const chosen = turns.map((t, i) => ({ t, top: candidatesFor(i)[0] })).filter((x) => x.top && calibrate(x.top.raw, cal) >= DEFAULTS.pRead).slice(0, 50);
  const rows = await pool(chosen, concurrency, async ({ t, top }) => {
    const src = sourceFor(t);
    const r = await readAhead(src, top!.text, { caps: DEFAULTS.readCaps, anchored: true });
    const rel = (p: string) => resolve(src.cwd, p);
    const overlap = fileOverlap([...r.files.keys()], t.readPaths.map(rel));
    const saved = t.searchCalls ? Math.min(1, [...new Set(t.readPaths.map(rel))].filter((p) => r.files.has(p)).length / t.searchCalls) : 0;
    return { ...overlap, saved, cost: r.usage.cost, hit: similarity(top!.text, t.actual) >= DEFAULTS.editedCut };
  });
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const hits = rows.filter((r) => r.hit);
  const ra = { turns: rows.length, precision: mean(rows.map((r) => r.precision)), recall: mean(rows.map((r) => r.recall)), recallOnHits: mean(hits.map((r) => r.recall)), searchCallsSaved: mean(hits.map((r) => r.saved)), costPerReadAhead: mean(rows.map((r) => r.cost)) };
  report.readAhead = ra;
  console.log(`\n== read-ahead (${rows.length} turns at p ≥ ${DEFAULTS.pRead}) ==\n${JSON.stringify(ra)}`);
}

const pairsPath = opt("pairs");
if (pairsPath) {
  writeFileSync(pairsPath, JSON.stringify(pairs.slice(0, 100).map((p) => ({ ...p, same: null })), null, 2) + "\n");
  console.log(`\n${Math.min(100, pairs.length)} pairs written to ${pairsPath}; set "same" to true/false and pass --labels.`);
}
const labelsPath = opt("labels");
if (labelsPath) {
  const labelled = JSON.parse(readFileSync(labelsPath, "utf8")).filter((l: any) => typeof l.same === "boolean");
  const b = bestCut(labelled);
  report.bestCut = b;
  console.log(`\nbest similarity cut from ${labelled.length} labels: ${b.cut} (F1 ${b.f1.toFixed(2)}); set it with /next-turn set editedCut ${b.cut}`);
}

mkdirSync(join(import.meta.dirname, "out"), { recursive: true });
const outPath = join(import.meta.dirname, "out", `replay-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
console.log(`\nreport: ${outPath}`);
