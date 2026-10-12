// A pi SDK agent session forked from the current one (v1 D4, D10; v2 E6). The fork gets the active
// branch's entries, the same model and thinking level, the same system-prompt options the main
// session used for its last run, and the main session's tool declarations (name, description,
// parameters, snippet, guidelines) in the same order, so its first request has the same prefix as
// the main session's next one and reads the provider's prompt cache. Only the tools' execution is
// different: every call goes to the `exec` the caller supplies (read-only, draft, or blocked).
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { agentDir as defaultAgentDir } from "./config.ts";

export type ToolResult = { content: { type: "text"; text: string }[]; details?: unknown; isError?: boolean };
export type ToolExec = (name: string, args: any, signal: AbortSignal | undefined) => Promise<ToolResult>;

export type ToolDecl = {
  name: string;
  description: string;
  parameters: any;
  constrainedSampling?: any;
  promptGuidelines?: string[];
  exposure?: any;
  namespace?: any;
  annotations?: any;
};

/**
 * The tool declarations the transcript holds at its leaf, in declaration order. pi declares tools
 * in transcript system messages (`toolsAdded` / `toolsRemoved`), and requests send them in this
 * order with every field (e.g. `constrainedSampling`), so a fork that mirrors them exactly appends
 * no tool-change message and keeps the cached prefix.
 */
export function declaredTools(branch: SessionEntry[]): ToolDecl[] {
  const out: ToolDecl[] = [];
  for (const e of branch as any[]) {
    const m = e?.type === "message" ? e.message : undefined;
    if (m?.role !== "system") continue;
    for (const r of m.toolsRemoved ?? []) {
      const i = out.findIndex((t) => t.name === r.name);
      if (i >= 0) out.splice(i, 1);
    }
    for (const t of m.toolsAdded ?? []) {
      const i = out.findIndex((x) => x.name === t.name);
      if (i >= 0) out.splice(i, 1);
      out.push(clone(t));
    }
  }
  return out;
}

export type ForkSource = {
  cwd: string;
  agentDir: string;
  header: any;
  branch: SessionEntry[];
  tools: ToolDecl[];
  /** The main session's last run's system-prompt options (captured in before_agent_start). */
  options: Record<string, any> | undefined;
  model: any;
  thinkingLevel: any;
  /** The main session's ModelRuntime, so extension-registered providers and credentials resolve. */
  modelRuntime: any;
  settings: Record<string, any>;
};

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

/** Collects what a fork needs from the main session. Undefined when there is no model or no history. */
export function captureSource(pi: ExtensionAPI, ctx: ExtensionContext, options: Record<string, any> | undefined): ForkSource | undefined {
  const model = ctx.model;
  const header = ctx.sessionManager.getHeader();
  if (!model || !header) return undefined;
  const branch = ctx.sessionManager.getBranch();
  const declared = declaredTools(branch);
  const all = new Map(pi.getAllTools().map((t) => [t.name, t]));
  const info = (t: ToolDecl): ToolDecl => {
    const i = all.get(t.name);
    return i ? { ...t, promptGuidelines: i.promptGuidelines, exposure: i.exposure, namespace: i.namespace, annotations: i.annotations } : t;
  };
  const tools: ToolDecl[] = declared.map(info);
  for (const name of pi.getActiveTools()) {
    const i = all.get(name);
    if (i && !tools.some((t) => t.name === name)) tools.push({ name: i.name, description: i.description, parameters: i.parameters, promptGuidelines: i.promptGuidelines, exposure: i.exposure, namespace: i.namespace, annotations: i.annotations });
  }
  let settings: Record<string, any> = {};
  try {
    settings = clone(pi.getSettings() as any) ?? {};
  } catch {}
  return {
    cwd: ctx.cwd,
    agentDir: defaultAgentDir(),
    header: clone(header),
    branch: clone(branch),
    tools,
    options: clone(options),
    model,
    thinkingLevel: pi.getThinkingLevel(),
    modelRuntime: (ctx.modelRegistry as any)?.runtime,
    settings,
  };
}

export type Fork = {
  session: AgentSession;
  /** Id of the last copied entry: everything after it in the fork is new. */
  baseLeafId: string | null;
  /** Entries the fork appended after the copied branch, root-to-leaf. */
  newEntries(): SessionEntry[];
  /** Provider payloads the fork sent, for prefix diagnostics. */
  payloads: unknown[];
  dispose(): void;
};

export type ForkOptions = {
  exec: ToolExec;
  /** Override model ("provider/id") or thinking level; undefined keeps the session's (and its cache). */
  model?: any;
  thinkingLevel?: any;
  onPayload?: (payload: unknown) => void;
  /** A message to add before the fork's first run (the eval's read-ahead variant). */
  inject?: { customType: string; content: string; display: boolean };
};

function replaceOptions(target: Record<string, any>, source: Record<string, any>): void {
  for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
  for (const [key, value] of Object.entries(source)) target[key] = clone(value);
}

export async function openFork(src: ForkSource, opts: ForkOptions): Promise<Fork> {
  const payloads: unknown[] = [];
  const snippets: Record<string, string> = src.options?.toolSnippets ?? {};
  const guidelines: Record<string, string[]> = src.options?.toolGuidelines ?? {};
  const forkExtension = (fp: ExtensionAPI) => {
    for (const t of src.tools) {
      fp.registerTool({
        name: t.name,
        label: t.name,
        description: t.description,
        parameters: t.parameters,
        ...(t.constrainedSampling !== undefined ? { constrainedSampling: t.constrainedSampling } : {}),
        promptSnippet: snippets[t.name],
        promptGuidelines: guidelines[t.name] ?? t.promptGuidelines,
        ...(t.exposure ? { exposure: t.exposure } : {}),
        ...(t.namespace ? { namespace: t.namespace } : {}),
        ...(t.annotations ? { annotations: t.annotations } : {}),
        execute: async (_id: string, params: any, signal: AbortSignal | undefined) => {
          const r = await opts.exec(t.name, params, signal);
          if (r.isError) throw new Error(r.content.map((c) => c.text).join("\n"));
          return { content: r.content, details: r.details };
        },
      } as any);
    }
    let inject = opts.inject;
    const options = src.options;
    fp.on("before_agent_start", (event) => {
      if (options) replaceOptions(event.systemPromptOptions as any, { ...options, cwd: (event.systemPromptOptions as any).cwd });
      const message = inject;
      inject = undefined;
      return message ? { message } : undefined;
    });
    fp.on("before_provider_request", (event) => {
      payloads.push(event.payload);
      opts.onPayload?.(event.payload);
      return undefined;
    });
  };
  const options = src.options ?? {};
  const loader = new DefaultResourceLoader({
    cwd: src.cwd,
    agentDir: src.agentDir,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [{ name: "pi-next-turn-fork", factory: forkExtension }],
    skillsOverride: (base) => (options.skills ? { skills: options.skills, diagnostics: [] } : base),
    agentsFilesOverride: (base) => (options.contextFiles ? { agentsFiles: options.contextFiles } : base),
    systemPromptOverride: (base) => ("customPrompt" in options ? options.customPrompt : base),
    appendSystemPromptOverride: (base) => ("appendSystemPrompt" in options ? (options.appendSystemPrompt ? [options.appendSystemPrompt] : []) : base),
  });
  await loader.reload();
  const settings = { ...src.settings, compaction: { ...(src.settings.compaction ?? {}), enabled: false } };
  const sessionManager = SessionManager.inMemory(src.cwd, undefined, [src.header, ...src.branch] as any);
  const baseLeafId = sessionManager.getLeafId();
  const { session } = await createAgentSession({
    cwd: src.cwd,
    agentDir: src.agentDir,
    model: opts.model ?? src.model,
    thinkingLevel: opts.thinkingLevel ?? src.thinkingLevel,
    ...(src.modelRuntime ? { modelRuntime: src.modelRuntime } : {}),
    resourceLoader: loader,
    sessionManager,
    settingsManager: SettingsManager.inMemory(settings as any),
    tools: src.tools.map((t) => t.name),
  });
  await session.bindExtensions({}).catch(() => undefined);
  // Declarations go out in the active-tool order; keep the main session's.
  session.setActiveToolsByName(src.tools.map((t) => t.name));
  return {
    session,
    baseLeafId,
    payloads,
    newEntries() {
      const branch = sessionManager.getBranch();
      const i = baseLeafId ? branch.findIndex((e) => e.id === baseLeafId) : -1;
      return branch.slice(i + 1);
    },
    dispose() {
      try {
        session.dispose();
      } catch {}
    },
  };
}

/** Text of an assistant message's text blocks. */
export function assistantText(message: any): string {
  if (!message || message.role !== "assistant") return "";
  return (message.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n")
    .trim();
}

/** Compares two provider payloads: which top-level keys are equal and how many leading messages match. */
export function prefixReport(main: unknown, fork: unknown): { equalKeys: string[]; differentKeys: string[]; commonMessages: number; mainMessages: number } {
  const a = (main ?? {}) as Record<string, unknown>;
  const b = (fork ?? {}) as Record<string, unknown>;
  const equalKeys: string[] = [];
  const differentKeys: string[] = [];
  const listKey = ["messages", "input", "contents"].find((k) => Array.isArray(a[k]) && Array.isArray(b[k]));
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === listKey) continue;
    (JSON.stringify(a[key]) === JSON.stringify(b[key]) ? equalKeys : differentKeys).push(key);
  }
  let commonMessages = 0;
  const am = listKey ? (a[listKey] as unknown[]) : [];
  const bm = listKey ? (b[listKey] as unknown[]) : [];
  while (commonMessages < am.length && commonMessages < bm.length && JSON.stringify(am[commonMessages]) === JSON.stringify(bm[commonMessages])) commonMessages++;
  return { equalKeys, differentKeys, commonMessages, mainMessages: am.length };
}
