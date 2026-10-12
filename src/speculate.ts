// v2 speculative full run (E6): the predicted prompt runs in a fork as if the user had sent it.
// Edits and reads go to a pi-multiedit draft (nothing is written), grep/find/ls read the disk,
// shell commands are limited to a read-only allowlist, and anything else ends the speculation.
// When the draft changes files and the prompt names checks, they run in a worktree (verify.ts).
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CapGuard, type Caps } from "./caps.ts";
import type { DraftClient, DraftSummary } from "./draft-client.ts";
import { openFork, type ForkSource } from "./fork.ts";
import { newTracker, speculativeExec } from "./tools.ts";
import { usageOf, type Usage } from "./usage.ts";
import { detectCheck, NAMES_CHECKS, verifyInWorktree, type VerifyResult } from "./verify.ts";

export type Speculation = {
  predicted: string;
  draftId: string;
  baseLeafId: string | null;
  /** The fork's entries after the copied branch: the predicted user message, then the run. */
  entries: SessionEntry[];
  files: Map<string, string>;
  usage: Usage;
  ms: number;
  /** The run ended normally (no cap, no refused tool, no abort, no error). Only complete runs are handed over. */
  complete: boolean;
  stopped?: string;
  refused?: { name: string; reason: string };
  summary: DraftSummary;
  verify?: VerifyResult;
};

export async function speculate(
  src: ForkSource,
  predicted: string,
  opts: { caps: Caps; draft: DraftClient; model?: any; thinkingLevel?: any; signal?: AbortSignal; verify: boolean; verifyMs: number },
): Promise<Speculation> {
  const t0 = Date.now();
  const draftId = await opts.draft.open(src.cwd);
  const tracker = newTracker();
  let guard: CapGuard | undefined;
  const fork = await openFork(src, {
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    exec: speculativeExec(
      src.cwd,
      opts.draft.ops(draftId),
      tracker,
      () => guard?.call(tracker.calls),
      () => guard?.stop(`refused ${tracker.refused?.name}`),
    ),
  });
  const before = fork.session.messages.length;
  guard = new CapGuard(fork.session, opts.caps, before);
  const onAbort = () => guard?.stop("aborted");
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (!opts.signal?.aborted) await fork.session.prompt(predicted, { expandPromptTemplates: false }).catch(() => undefined);
    const last: any = [...fork.session.messages].reverse().find((m: any) => m.role === "assistant");
    const complete = !guard.reason && !opts.signal?.aborted && !!last && last.stopReason !== "error" && last.stopReason !== "aborted" && last.stopReason !== "length";
    const summary = await opts.draft.summary(draftId).catch(() => ({ files: [], insertions: 0, deletions: 0 }));
    let verify: VerifyResult | undefined;
    if (complete && opts.verify && summary.files.length && NAMES_CHECKS.test(predicted) && !opts.signal?.aborted) {
      const check = await detectCheck(src.cwd);
      if (check) verify = await verifyInWorktree(src.cwd, check, (dir) => opts.draft.materialize(draftId, dir), { timeoutMs: opts.verifyMs, signal: opts.signal });
    }
    return {
      predicted,
      draftId,
      baseLeafId: fork.baseLeafId,
      entries: fork.newEntries(),
      files: tracker.files,
      usage: usageOf(fork.session.messages, before),
      ms: Date.now() - t0,
      complete,
      stopped: guard.reason,
      refused: tracker.refused,
      summary,
      verify,
    };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    guard.dispose();
    fork.dispose();
  }
}
