// Settings: defaults < user file < project file < environment. Files live outside the workspace
// under pi's agent directory (v1 D11); `/next-turn set` writes the user file.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ScorerChoice = "agreement" | "jev" | "auto";

export type Config = {
  enabled: boolean;
  /** Forked samples per prediction (v1 D6). */
  samples: number;
  /** Calibrated probability from which a prediction is shown / read ahead / drafted (v1 D7, v2 E6). */
  pShow: number;
  pRead: number;
  pDraft: number;
  /** Similarity from which a send counts as an edited acceptance (v1 D11); hand-over needs `handoverCut` (v2 E7). */
  editedCut: number;
  handoverCut: number;
  /** Similarity from which two samples count as the same prediction (v1 D6). */
  agreeCut: number;
  maxWords: number;
  maxChars: number;
  /** "session" or "provider/model" for predictions and speculative runs. */
  model: string;
  /** "session" or a thinking level. Same as the session keeps the prompt cache warm. */
  thinking: string;
  readAhead: boolean;
  /** v2: run the whole predicted turn ahead, edits in a pi-multiedit draft. Off until the v1 gate passes. */
  draft: boolean;
  /** v2 E5: run the repo's check command against the draft in a throwaway worktree. */
  verify: boolean;
  /** v2 E11: "agreement" (no dependency), "jev" (TypeSafe classifier through pi's model registry), "auto" (jev when available). */
  scorer: ScorerChoice;
  /** v2 E11: ask the classifier whether a speculation is safe before running it (only with a Jev scorer). */
  jevSafety: boolean;
  keys: { fill: string; cycle: string };
  readCaps: { toolCalls: number; ms: number; tokens: number };
  draftCaps: { toolCalls: number; ms: number; tokens: number };
  verifyMs: number;
  /** Chars of files injected into an accepted turn (same cap as pi-jev-kit's seed). */
  injectChars: number;
  backoff: { unused: number; every: number };
  debug: boolean;
};

export const DEFAULTS: Config = {
  enabled: true,
  samples: 3,
  pShow: 0.35,
  pRead: 0.7,
  pDraft: 0.85,
  editedCut: 0.6,
  handoverCut: 0.85,
  agreeCut: 0.6,
  maxWords: 12,
  maxChars: 100,
  model: "session",
  thinking: "session",
  readAhead: true,
  draft: false,
  verify: true,
  scorer: "agreement",
  jevSafety: false,
  keys: { fill: "alt+n", cycle: "alt+]" },
  readCaps: { toolCalls: 8, ms: 20_000, tokens: 60_000 },
  draftCaps: { toolCalls: 40, ms: 120_000, tokens: 400_000 },
  verifyMs: 120_000,
  injectChars: 40_000,
  backoff: { unused: 20, every: 10 },
  debug: false,
};

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "next-turn");
}

export function projectKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), "config.json");
}

export function projectConfigPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), "projects", projectKey(cwd), "config.json");
}

function readJson(path: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function merge<T>(base: T, over: Record<string, unknown>): T {
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in (base as any))) continue;
    const b = (base as any)[k];
    if (b && typeof b === "object" && !Array.isArray(b) && v && typeof v === "object") out[k] = merge(b, v as Record<string, unknown>);
    else if (typeof v === typeof b) out[k] = v;
  }
  return out;
}

const ENV: Record<string, keyof Config> = {
  PI_NEXT_TURN: "enabled",
  PI_NEXT_TURN_SAMPLES: "samples",
  PI_NEXT_TURN_P_SHOW: "pShow",
  PI_NEXT_TURN_P_READ: "pRead",
  PI_NEXT_TURN_P_DRAFT: "pDraft",
  PI_NEXT_TURN_MODEL: "model",
  PI_NEXT_TURN_THINKING: "thinking",
  PI_NEXT_TURN_READ_AHEAD: "readAhead",
  PI_NEXT_TURN_DRAFT: "draft",
  PI_NEXT_TURN_VERIFY: "verify",
  PI_NEXT_TURN_SCORER: "scorer",
  PI_NEXT_TURN_JEV_SAFETY: "jevSafety",
  PI_NEXT_TURN_DEBUG: "debug",
};

function fromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, key] of Object.entries(ENV)) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const kind = typeof DEFAULTS[key];
    if (kind === "boolean") out[key] = /^(1|true|on|yes)$/i.test(raw);
    else if (kind === "number" && Number.isFinite(Number(raw))) out[key] = Number(raw);
    else if (kind === "string") out[key] = raw;
  }
  return out;
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
  let c = merge(DEFAULTS, readJson(userConfigPath(env)));
  c = merge(c, readJson(projectConfigPath(cwd, env)));
  c = merge(c, fromEnv(env));
  if (!["agreement", "jev", "auto"].includes(c.scorer)) c.scorer = "agreement";
  c.samples = Math.max(1, Math.min(8, Math.round(c.samples)));
  return c;
}

/** Sets one dotted key in the user (or project) config file; returns the error text on a bad key or value. */
export function saveSetting(key: string, raw: string, scope: { cwd?: string } = {}, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = scope.cwd ? projectConfigPath(scope.cwd, env) : userConfigPath(env);
  const file = readJson(path);
  const parts = key.split(".");
  let base: any = DEFAULTS;
  for (const p of parts) {
    if (!base || typeof base !== "object" || !(p in base)) return `unknown setting ${key}`;
    base = base[p];
  }
  let value: unknown;
  if (typeof base === "boolean") {
    if (!/^(true|false|on|off|1|0)$/i.test(raw)) return `${key} takes on or off`;
    value = /^(true|on|1)$/i.test(raw);
  } else if (typeof base === "number") {
    if (!Number.isFinite(Number(raw))) return `${key} takes a number`;
    value = Number(raw);
  } else if (typeof base === "string") value = raw;
  else return `${key} is not a single value`;
  let node: any = file;
  for (const p of parts.slice(0, -1)) node = node[p] && typeof node[p] === "object" ? node[p] : (node[p] = {});
  node[parts[parts.length - 1]] = value;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  return undefined;
}
