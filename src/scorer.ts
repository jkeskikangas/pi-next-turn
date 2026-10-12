// Confidence for predictions (v1 D2, D6). A `Scorer` turns the raw samples into ranked candidates
// with probabilities. `AgreementScorer` needs nothing but the samples: candidates whose texts are
// similar form a cluster; a cluster's raw score is the share of samples whose top candidate fell
// in it, mapped to a probability through a calibration table fitted by the replay eval.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { similarity } from "./similar.ts";

export type Candidate = { text: string; p: number };

/** One forked sample: its candidates, most likely first. */
export type Sample = string[];

export type ScoreContext = {
  /** The last assistant message and the user's recent prompts, for scorers that judge text. */
  lastAssistant: string;
  recentUser: string[];
  signal?: AbortSignal;
};

export interface Scorer {
  readonly name: string;
  score(samples: Sample[], ctx: ScoreContext): Promise<Candidate[]>;
}

/** Raw score (share of samples, 0..1) → calibrated probability. Piecewise linear between points. */
export type Calibration = { points: [number, number][]; fittedAt?: string; samples?: number; n?: number };

/** Before any eval: agreement is optimistic, so the table discounts it. Replaced by the fitted table. */
export const DEFAULT_CALIBRATION: Calibration = {
  points: [
    [0, 0],
    [0.34, 0.25],
    [0.67, 0.5],
    [1, 0.75],
  ],
};

export function calibrate(raw: number, cal: Calibration = DEFAULT_CALIBRATION): number {
  const pts = [...cal.points].sort((a, b) => a[0] - b[0]);
  if (!pts.length) return raw;
  if (raw <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (raw <= x1) return x1 === x0 ? y1 : y0 + ((raw - x0) / (x1 - x0)) * (y1 - y0);
  }
  return pts[pts.length - 1][1];
}

export function calibrationPath(dir: string, samples: number): string {
  return join(dir, `calibration-k${samples}.json`);
}

export function loadCalibration(dir: string, samples: number): Calibration {
  try {
    const c = JSON.parse(readFileSync(calibrationPath(dir, samples), "utf8"));
    if (Array.isArray(c?.points) && c.points.every((p: unknown) => Array.isArray(p) && p.length === 2)) return c;
  } catch {}
  return DEFAULT_CALIBRATION;
}

/**
 * Fits a calibration table from (raw, hit) pairs: the hit rate at each distinct raw value, with
 * add-one smoothing toward 0.5 and made monotone (pool-adjacent-violators).
 */
export function fitCalibration(pairs: { raw: number; hit: boolean }[], samples: number): Calibration {
  const groups = new Map<number, { n: number; hits: number }>();
  for (const { raw, hit } of pairs) {
    const key = Math.round(raw * 1000) / 1000;
    const g = groups.get(key) ?? { n: 0, hits: 0 };
    g.n++;
    if (hit) g.hits++;
    groups.set(key, g);
  }
  let blocks = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([x, g]) => ({ x: [x], n: g.n, hits: g.hits }));
  const rate = (b: { n: number; hits: number }) => (b.hits + 1) / (b.n + 2);
  for (let i = 1; i < blocks.length; ) {
    if (rate(blocks[i - 1]) > rate(blocks[i])) {
      const merged = { x: [...blocks[i - 1].x, ...blocks[i].x], n: blocks[i - 1].n + blocks[i].n, hits: blocks[i - 1].hits + blocks[i].hits };
      blocks.splice(i - 1, 2, merged);
      i = Math.max(1, i - 1);
    } else i++;
  }
  const points: [number, number][] = [];
  for (const b of blocks) for (const x of b.x) points.push([x, Math.round(rate(b) * 1000) / 1000]);
  if (!points.length || points[0][0] > 0) points.unshift([0, 0]);
  return { points, fittedAt: new Date().toISOString(), samples, n: pairs.length };
}

type Cluster = { texts: string[]; votes: number; weight: number; first: number };

/** Groups candidate texts across samples by similarity; returns clusters by top-1 votes, then weight. */
export function cluster(samples: Sample[], cut: number): Cluster[] {
  const clusters: Cluster[] = [];
  let order = 0;
  for (const sample of samples) {
    sample.forEach((text, rank) => {
      let c = clusters.find((c) => c.texts.some((t) => similarity(t, text) >= cut));
      if (!c) {
        c = { texts: [], votes: 0, weight: 0, first: order++ };
        clusters.push(c);
      }
      c.texts.push(text);
      if (rank === 0) c.votes++;
      c.weight += 1 / (rank + 1);
    });
  }
  return clusters.sort((a, b) => b.votes - a.votes || b.weight - a.weight || a.first - b.first);
}

/** The cluster's representative: the text most similar to the others, ties to the earliest. */
function representative(c: Cluster): string {
  let best = c.texts[0];
  let bestScore = -1;
  for (const t of c.texts) {
    const s = c.texts.reduce((acc, u) => acc + similarity(t, u), 0);
    if (s > bestScore) {
      best = t;
      bestScore = s;
    }
  }
  return best;
}

export class AgreementScorer implements Scorer {
  readonly name = "agreement";
  constructor(
    private readonly cut: number,
    private readonly calibration: Calibration = DEFAULT_CALIBRATION,
  ) {}

  /** The raw agreement of each cluster (share of samples), before calibration; used by the eval. */
  raw(samples: Sample[]): { text: string; raw: number }[] {
    const n = samples.length || 1;
    return cluster(samples, this.cut).map((c) => ({ text: representative(c), raw: c.votes / n }));
  }

  async score(samples: Sample[]): Promise<Candidate[]> {
    return this.raw(samples).map(({ text, raw }) => ({ text, p: calibrate(raw, this.calibration) }));
  }
}
