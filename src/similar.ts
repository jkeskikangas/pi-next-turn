// Text normalization and similarity for comparing predictions with each other (agreement) and
// with what the user actually sent (outcomes). Short prompts: token-set Jaccard and character
// bigram Dice, whichever is higher, so "run the tests" ~ "run tests" and "fix typo" ~ "fix typos".

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\p{L}\p{N}\s/._-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(normalize(text).split(" ").filter(Boolean));
}

function bigrams(text: string): Map<string, number> {
  const s = normalize(text).replace(/ /g, "");
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

export function jaccard(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function dice(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  let total = 0;
  for (const n of A.values()) total += n;
  for (const n of B.values()) total += n;
  if (!total) return normalize(a) === normalize(b) ? 1 : 0;
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) ?? 0);
  return (2 * inter) / total;
}

export function similarity(a: string, b: string): number {
  if (normalize(a) === normalize(b)) return 1;
  return Math.max(jaccard(a, b), dice(a, b));
}

export type OutcomeKind = "accepted_exact" | "accepted_edited" | "changed_course" | "ignored";

/**
 * How a sent prompt relates to the shown candidates. `exact` when equal after normalization,
 * `edited` when similar above `cut`, otherwise `changed_course`. Returns the matched index.
 */
export function classifySend(shown: string[], sent: string, cut: number): { outcome: OutcomeKind; index: number; similarity: number } {
  let best = -1;
  let bestSim = 0;
  for (let i = 0; i < shown.length; i++) {
    if (normalize(shown[i]) === normalize(sent)) return { outcome: "accepted_exact", index: i, similarity: 1 };
    const s = similarity(shown[i], sent);
    if (s > bestSim) {
      bestSim = s;
      best = i;
    }
  }
  if (best >= 0 && bestSim >= cut) return { outcome: "accepted_edited", index: best, similarity: bestSim };
  return { outcome: "changed_course", index: -1, similarity: bestSim };
}
