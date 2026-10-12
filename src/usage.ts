// Token and cost accounting for forks (prediction, read-ahead, speculation).

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

export const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

export function addUsage(a: Usage, b: Partial<Usage> | undefined): Usage {
  if (!b) return a;
  return { input: a.input + (b.input ?? 0), output: a.output + (b.output ?? 0), cacheRead: a.cacheRead + (b.cacheRead ?? 0), cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0), cost: a.cost + (b.cost ?? 0) };
}

/** Sum of the usage of assistant messages in `messages` after index `from`. */
export function usageOf(messages: readonly any[], from = 0): Usage {
  let u = zeroUsage();
  for (const m of messages.slice(from)) {
    if (m?.role !== "assistant" || !m.usage) continue;
    u = addUsage(u, { input: m.usage.input, output: m.usage.output, cacheRead: m.usage.cacheRead, cacheWrite: m.usage.cacheWrite, cost: m.usage.cost?.total ?? 0 });
  }
  return u;
}

export const totalTokens = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheWrite;

export function cacheShare(u: Usage): number | undefined {
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  return prompt ? u.cacheRead / prompt : undefined;
}
