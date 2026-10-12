// One prediction (v1 D4, D6): k forked samples in parallel, each asked for up to three candidate
// next prompts; candidates are cleaned and filtered (filters.ts), then scored (scorer.ts).
import { assistantText, openFork, type ForkSource } from "./fork.ts";
import { parseCandidates, rejectReason, type FilterLimits, type FilterReason } from "./filters.ts";
import { predictionInstruction } from "./prompt.ts";
import type { Candidate, Sample, ScoreContext, Scorer } from "./scorer.ts";
import { blockedExec } from "./tools.ts";
import { addUsage, usageOf, zeroUsage, type Usage } from "./usage.ts";

export type PredictOptions = {
  samples: number;
  limits: FilterLimits;
  model?: any;
  thinkingLevel?: any;
  disabledFilters?: ReadonlySet<FilterReason>;
  signal?: AbortSignal;
};

export type PredictResult = {
  candidates: Candidate[];
  samples: Sample[];
  /** Raw candidate lines that were dropped, with the filter that dropped them. */
  dropped: { text: string; reason: FilterReason }[];
  usage: Usage;
  ms: number;
};

/** Asks one fork for candidates. Any tool call ends it with no candidates. */
export async function sampleOnce(src: ForkSource, opts: PredictOptions): Promise<{ lines: string[]; usage: Usage }> {
  let blocked = false;
  const fork = await openFork(src, {
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    exec: blockedExec(() => {
      blocked = true;
      void fork.session.abort();
    }),
  });
  const onAbort = () => void fork.session.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const before = fork.session.messages.length;
  try {
    if (opts.signal?.aborted) return { lines: [], usage: zeroUsage() };
    await fork.session.prompt(predictionInstruction(opts.limits.maxWords, 3));
    const usage = usageOf(fork.session.messages, before);
    if (blocked || opts.signal?.aborted) return { lines: [], usage };
    const last = [...fork.session.messages].reverse().find((m: any) => m.role === "assistant");
    if ((last as any)?.stopReason === "error" || (last as any)?.stopReason === "aborted") return { lines: [], usage };
    return { lines: parseCandidates(assistantText(last), 3), usage };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    fork.dispose();
  }
}

export async function predict(src: ForkSource, scorer: Scorer, scoreCtx: ScoreContext, opts: PredictOptions): Promise<PredictResult> {
  const t0 = Date.now();
  const runs = await Promise.all(Array.from({ length: opts.samples }, () => sampleOnce(src, opts).catch(() => ({ lines: [] as string[], usage: zeroUsage() }))));
  let usage = zeroUsage();
  const dropped: PredictResult["dropped"] = [];
  const samples: Sample[] = runs.map((r) => {
    usage = addUsage(usage, r.usage);
    return r.lines.filter((line) => {
      const reason = rejectReason(line, opts.limits, opts.disabledFilters);
      if (reason) dropped.push({ text: line, reason });
      return !reason;
    });
  });
  const candidates = samples.some((s) => s.length) ? await scorer.score(samples, { ...scoreCtx, signal: opts.signal }) : [];
  return { candidates, samples, dropped, usage, ms: Date.now() - t0 };
}
