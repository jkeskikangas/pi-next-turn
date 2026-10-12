// Event log outside the workspace (v1 D11): NDJSON at <agent dir>/next-turn/log.ndjson. Records
// outcomes, lengths, probabilities, usage and timing; full texts only with debug on.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./config.ts";

export function logPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), "log.ndjson");
}

export class EventLog {
  private readonly path: string;
  private readonly debug: boolean;
  constructor(path: string = logPath(), debug = false) {
    this.path = path;
    this.debug = debug;
  }

  write(type: string, data: Record<string, unknown>, texts: Record<string, unknown> = {}): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify({ t: new Date().toISOString(), type, ...data, ...(this.debug ? texts : {}) }) + "\n");
    } catch {}
  }
}

export function readLog(path: string = logPath()): Record<string, any>[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export type Stats = { shown: number; accepted_exact: number; accepted_edited: number; changed_course: number; ignored: number; cost: number; predictions: number; readAheads: number; speculations: number; handovers: number };

export function stats(entries: Record<string, any>[], since?: number): Stats {
  const s: Stats = { shown: 0, accepted_exact: 0, accepted_edited: 0, changed_course: 0, ignored: 0, cost: 0, predictions: 0, readAheads: 0, speculations: 0, handovers: 0 };
  for (const e of entries) {
    if (since && Date.parse(e.t) < since) continue;
    if (e.type === "prediction") {
      s.predictions++;
      if (e.shown) s.shown++;
    }
    if (e.type === "outcome" && e.outcome in s) (s as any)[e.outcome]++;
    if (e.type === "read_ahead") s.readAheads++;
    if (e.type === "speculation") s.speculations++;
    if (e.type === "handover" && e.ok) s.handovers++;
    if (typeof e.cost === "number") s.cost += e.cost;
  }
  return s;
}
