// Optional decision-model features (v2 E11). Jev (TypeSafe) is reached through pi's model registry
// as a "classifier" model; there is no package dependency. Without a configured classifier every
// function here reports unavailable and callers fall back to the agreement scorer and the fixed
// allowlist. Rules from pi-jev-kit's landscape study: let candidates compete, then verify the
// winner (rank-then-verify); split fuzzy questions into separate criteria; give the classifier the
// task, action and evidence only, never the generating model's reasoning.
import type { Candidate, Sample, ScoreContext, Scorer } from "./scorer.ts";
import { AgreementScorer } from "./scorer.ts";

/** The slice of pi's ModelRegistry used here (structural, so tests can fake it). */
export type ClassifierRegistry = {
  getAvailableOfType(type: "classifier", provider?: string): Promise<readonly any[]>;
  classify(model: any, context: { state: Record<string, unknown>; questions: Record<string, unknown> }, options?: { signal?: AbortSignal }): Promise<{ stopReason: string; answers?: Record<string, any> }>;
};

export async function findJev(registry: ClassifierRegistry | undefined): Promise<unknown | undefined> {
  if (!registry?.getAvailableOfType) return undefined;
  const models = await registry.getAvailableOfType("classifier", "typesafe").catch(() => [] as any[]);
  return models.find((m: any) => String(m?.id ?? "").startsWith("jev")) ?? models[0];
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export class JevScorer implements Scorer {
  readonly name = "jev";
  private readonly agreement: AgreementScorer;
  constructor(
    private readonly registry: ClassifierRegistry,
    private readonly model: unknown,
    agreeCut: number,
  ) {
    this.agreement = new AgreementScorer(agreeCut);
  }

  async score(samples: Sample[], ctx: ScoreContext): Promise<Candidate[]> {
    const options = this.agreement.raw(samples).slice(0, 5);
    if (!options.length) return [];
    const state = {
      assistant_last_message: clip(ctx.lastAssistant, 4000),
      user_recent_messages: ctx.recentUser.slice(-5).map((m) => clip(m, 400)),
      candidates: Object.fromEntries(options.map((o, i) => [`c${i}`, o.text])),
    };
    const criteria: Record<string, string> = Object.fromEntries(options.map((o, i) => [`c${i}`, `The user's next message is essentially candidate c${i}: "${o.text}"`]));
    criteria.none = "The user's next message is something else";
    const ranked = await this.registry.classify(
      this.model,
      { state, questions: { next: { type: "choice", instructions: "Given the assistant's last message and the user's recent messages, which candidate will the user type next?", criteria } } },
      { signal: ctx.signal },
    );
    if (ranked.stopReason !== "stop" || ranked.answers?.next?.type !== "choice") throw new Error("classifier did not answer");
    const probs: Record<string, number> = ranked.answers.next.probabilities ?? {};
    const order = options.map((o, i) => ({ text: o.text, p: probs[`c${i}`] ?? 0 })).sort((a, b) => b.p - a.p);
    const top = order[0];
    const verify = await this.registry.classify(
      this.model,
      {
        state: { assistant_last_message: state.assistant_last_message, user_recent_messages: state.user_recent_messages, candidate: top.text },
        questions: {
          sends: {
            type: "bool",
            instructions: "Is the candidate what the user will type next (the same request, possibly worded differently)?",
            criteria: { true: "Yes, it is the obvious next request given the conversation", false: "No, the user would more likely ask something else or nothing" },
          },
        },
      },
      { signal: ctx.signal },
    );
    const pTop = verify.stopReason === "stop" && verify.answers?.sends?.type === "bool" ? verify.answers.sends.probability : top.p;
    const rest = order.slice(1);
    const restSum = rest.reduce((a, c) => a + c.p, 0) || 1;
    return [{ text: top.text, p: pTop }, ...rest.map((c) => ({ text: c.text, p: Math.min(c.p, ((1 - pTop) * c.p) / restSum) }))];
  }
}

export type SafetyVerdict = { safe: boolean; scores: Record<string, number> };

/** Separate criteria for "may this predicted request run ahead in a draft?" (v2 E6, E11). */
export async function judgeSpeculation(registry: ClassifierRegistry, model: unknown, task: string, lastAssistant: string, signal?: AbortSignal): Promise<SafetyVerdict> {
  const bool = (instructions: string, yes: string, no: string) => ({ type: "bool", instructions, criteria: { true: yes, false: no } });
  const res = await registry.classify(
    model,
    {
      state: { request: clip(task, 1000), assistant_last_message: clip(lastAssistant, 3000) },
      questions: {
        local_only: bool("Can the request be done by reading and editing files in the repository only?", "Only repository files are read or changed", "It needs the network, other systems, installs, git history changes or files outside the repository"),
        reversible: bool("Could every effect of doing the request be undone by discarding file edits?", "Yes, discarding the edits undoes it", "No, it has effects that cannot be undone that way"),
        needs_decision: bool("Does the request need a decision or information only the user can give before work starts?", "Yes, the user must decide or answer first", "No, it can be done as asked"),
      },
    },
    { signal },
  );
  const p = (k: string) => (res.stopReason === "stop" && res.answers?.[k]?.type === "bool" ? res.answers[k].probability : k === "needs_decision" ? 1 : 0);
  const scores = { local_only: p("local_only"), reversible: p("reversible"), needs_decision: p("needs_decision") };
  return { safe: scores.local_only >= 0.8 && scores.reversible >= 0.8 && scores.needs_decision <= 0.3, scores };
}
