// v1 read-ahead (D9, D10): a forked read-only agent opens the files the predicted prompt will need.
// Its output is the files, not an answer; they are injected into the turn if the user sends a
// similar prompt (inject.ts) and discarded otherwise.
import { CapGuard, type Caps } from "./caps.ts";
import { openFork, type ForkSource } from "./fork.ts";
import { readAheadInstruction } from "./prompt.ts";
import { newTracker, readOnlyExec } from "./tools.ts";
import { usageOf, type Usage } from "./usage.ts";

export type ReadAheadResult = { files: Map<string, string>; calls: number; usage: Usage; ms: number; stopped?: string; aborted: boolean };

export async function readAhead(src: ForkSource, predicted: string, opts: { caps: Caps; anchored: boolean; model?: any; thinkingLevel?: any; signal?: AbortSignal }): Promise<ReadAheadResult> {
  const t0 = Date.now();
  const tracker = newTracker();
  let guard: CapGuard | undefined;
  const fork = await openFork(src, { model: opts.model, thinkingLevel: opts.thinkingLevel, exec: readOnlyExec(src.cwd, opts.anchored, tracker, () => guard?.call(tracker.calls)) });
  const before = fork.session.messages.length;
  guard = new CapGuard(fork.session, opts.caps, before);
  const onAbort = () => guard?.stop("aborted");
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (!opts.signal?.aborted) await fork.session.prompt(readAheadInstruction(predicted)).catch(() => undefined);
    return { files: tracker.files, calls: tracker.calls, usage: usageOf(fork.session.messages, before), ms: Date.now() - t0, stopped: guard.reason, aborted: !!opts.signal?.aborted };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    guard.dispose();
    fork.dispose();
  }
}
