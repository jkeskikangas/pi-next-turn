// Replay-eval building blocks (v1 step 1), kept free of I/O so they can be tested: turn
// extraction from a session branch, the session-level split, metrics, calibration error, the
// similarity cut from hand labels, files read by a real run, and the v1 gate.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { classifySend } from "./similar.ts";
import { contentText } from "./text.ts";

export type Turn = {
  sessionFile: string;
  /** Entries before the user message (the context the prediction would have seen). */
  prefix: SessionEntry[];
  actual: string;
  /** Absolute or cwd-relative paths the real next run read (read tool calls) before the next user message. */
  readPaths: string[];
  /** Read, grep, find and ls calls the real run made. */
  searchCalls: number;
  /** Paths the real run edited or wrote (edit/write tool calls; pi-multiedit's edits[].path too). */
  editPaths: string[];
  /** Wall time of the real run: user message to the last assistant message before the next user message. */
  runMs: number;
};

const isMsg = (e: any, role: string) => e?.type === "message" && e.message?.role === role;

/** Every user message with at least two assistant messages before it on the branch. */
export function extractTurns(sessionFile: string, branch: SessionEntry[], minAssistants = 2): Turn[] {
  const turns: Turn[] = [];
  let assistants = 0;
  for (let i = 0; i < branch.length; i++) {
    const e: any = branch[i];
    if (isMsg(e, "assistant")) assistants++;
    if (!isMsg(e, "user") || assistants < minAssistants) continue;
    const actual = contentText(e.message.content).trim();
    if (!actual || actual.startsWith("/")) continue;
    const readPaths: string[] = [];
    const editPaths = new Set<string>();
    let searchCalls = 0;
    const start = Number(e.message.timestamp) || Date.parse(e.timestamp) || 0;
    let end = start;
    for (let j = i + 1; j < branch.length && !isMsg(branch[j], "user"); j++) {
      const m: any = (branch[j] as any).message;
      if (m?.role !== "assistant") continue;
      end = Math.max(end, Number(m.timestamp) || Date.parse((branch[j] as any).timestamp) || end);
      for (const c of m.content ?? []) {
        if (c.type !== "toolCall") continue;
        if (["read", "grep", "find", "ls"].includes(c.name)) searchCalls++;
        if (c.name === "read" && typeof c.arguments?.path === "string") readPaths.push(c.arguments.path);
        if (c.name === "edit" || c.name === "write") {
          if (typeof c.arguments?.path === "string") editPaths.add(c.arguments.path);
          for (const ed of Array.isArray(c.arguments?.edits) ? c.arguments.edits : []) if (typeof ed?.path === "string") editPaths.add(ed.path);
        }
      }
    }
    turns.push({ sessionFile, prefix: branch.slice(0, i), actual, readPaths, searchCalls, editPaths: [...editPaths], runMs: Math.max(0, end - start) });
  }
  return turns;
}

/** Deterministic session-level split (by file name hash) so turns of one session never straddle sets. */
export function splitOf(sessionFile: string, calibrationShare = 0.7): "calibration" | "test" {
  let h = 2166136261;
  for (const ch of sessionFile) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h / 2 ** 32 < calibrationShare ? "calibration" : "test";
}

export type Scored = { turn: Turn; candidates: { text: string; raw: number; p: number }[]; cost: number; ms: number; dropped: { text: string; reason: string }[] };

export type Metrics = {
  turns: number;
  coverage: number;
  hitTop: number;
  hitAny: number;
  hitTopWhenShown: number;
  highConfidence: { n: number; hitRate: number; meanP: number };
  ece: number;
  bins: { lo: number; hi: number; n: number; meanP: number; hitRate: number }[];
  costPerTurn: number;
  msPerTurn: number;
  filterFalseDrops: Record<string, { dropped: number; wouldHaveHit: number }>;
};

export function hit(candidate: string, actual: string, cut: number): boolean {
  return classifySend([candidate], actual, cut).outcome !== "changed_course";
}

export function metrics(rows: Scored[], opts: { pShow: number; pHigh: number; cut: number }): Metrics {
  const n = rows.length || 1;
  let shown = 0;
  let hitTop = 0;
  let hitAny = 0;
  let hitShown = 0;
  let cost = 0;
  let ms = 0;
  const high = { n: 0, hits: 0, p: 0 };
  const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, n: 0, sumP: 0, hits: 0 }));
  const drops: Metrics["filterFalseDrops"] = {};
  for (const r of rows) {
    cost += r.cost;
    ms += r.ms;
    const vis = r.candidates.filter((c) => c.p >= opts.pShow).slice(0, 3);
    const top = r.candidates[0];
    const topHit = !!top && hit(top.text, r.turn.actual, opts.cut);
    if (topHit) hitTop++;
    if (vis.some((c) => hit(c.text, r.turn.actual, opts.cut))) hitAny++;
    if (vis.length) {
      shown++;
      if (hit(vis[0].text, r.turn.actual, opts.cut)) hitShown++;
    }
    if (top) {
      const b = bins[Math.min(9, Math.floor(top.p * 10))];
      b.n++;
      b.sumP += top.p;
      if (topHit) b.hits++;
      if (top.p >= opts.pHigh) {
        high.n++;
        high.p += top.p;
        if (topHit) high.hits++;
      }
    }
    for (const d of r.dropped) {
      const f = (drops[d.reason] ??= { dropped: 0, wouldHaveHit: 0 });
      f.dropped++;
      if (hit(d.text, r.turn.actual, opts.cut)) f.wouldHaveHit++;
    }
  }
  const scoredN = bins.reduce((a, b) => a + b.n, 0) || 1;
  const ece = bins.reduce((a, b) => (b.n ? a + (b.n / scoredN) * Math.abs(b.sumP / b.n - b.hits / b.n) : a), 0);
  return {
    turns: rows.length,
    coverage: shown / n,
    hitTop: hitTop / n,
    hitAny: hitAny / n,
    hitTopWhenShown: shown ? hitShown / shown : 0,
    highConfidence: { n: high.n, hitRate: high.n ? high.hits / high.n : 0, meanP: high.n ? high.p / high.n : 0 },
    ece,
    bins: bins.map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, meanP: b.n ? b.sumP / b.n : 0, hitRate: b.n ? b.hits / b.n : 0 })),
    costPerTurn: cost / n,
    msPerTurn: ms / n,
    filterFalseDrops: drops,
  };
}

/** The v1 step-1 gate. */
export function gate(m: Metrics): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (m.hitTop < 0.25) reasons.push(`top-candidate hit rate ${(m.hitTop * 100).toFixed(0)}% < 25%`);
  if (m.coverage < 0.4) reasons.push(`coverage ${(m.coverage * 100).toFixed(0)}% < 40%`);
  if (m.highConfidence.n === 0) reasons.push("no predictions at p ≥ 0.7");
  else {
    if (m.highConfidence.hitRate < 0.6) reasons.push(`hit rate at p ≥ 0.7 ${(m.highConfidence.hitRate * 100).toFixed(0)}% < 60%`);
    if (Math.abs(m.highConfidence.meanP - m.highConfidence.hitRate) > 0.1) reasons.push(`calibration at p ≥ 0.7 off by ${(Math.abs(m.highConfidence.meanP - m.highConfidence.hitRate) * 100).toFixed(0)} points`);
  }
  return { pass: reasons.length === 0, reasons };
}

/** The similarity cut with the best F1 against hand labels (same intent or not). */
export function bestCut(labelled: { similarity: number; same: boolean }[]): { cut: number; f1: number } {
  let best = { cut: 0.6, f1: -1 };
  for (let cut = 0.3; cut <= 0.951; cut += 0.05) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const l of labelled) {
      const pred = l.similarity >= cut;
      if (pred && l.same) tp++;
      else if (pred && !l.same) fp++;
      else if (!pred && l.same) fn++;
    }
    const f1 = tp ? (2 * tp) / (2 * tp + fp + fn) : 0;
    if (f1 > best.f1) best = { cut: Math.round(cut * 100) / 100, f1 };
  }
  return best;
}

/** Precision/recall of files read ahead against files the real run read. */
export function fileOverlap(readAhead: string[], real: string[]): { precision: number; recall: number } {
  const A = new Set(readAhead);
  const B = new Set(real);
  let inter = 0;
  for (const a of A) if (B.has(a)) inter++;
  return { precision: A.size ? inter / A.size : 0, recall: B.size ? inter / B.size : 0 };
}
