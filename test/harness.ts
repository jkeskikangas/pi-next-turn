// An in-process pi session with the extension loaded and a scripted (faux) model, so the whole
// loop — settle, forked predictions, read-ahead, speculation, input, injection, hand-over — runs
// without a network. The faux model answers by request kind (prediction, read-ahead, or a script).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

export type Kind = "predict" | "readahead" | "main";

export type Script = {
  /** Prediction fork reply. */
  predict: (n: number) => string | { tool: string; args: any };
  /** Main session and speculation replies: given the last user text and how many tool results followed it. */
  main: (userText: string, toolResults: number, kind: "main" | "speculation") => { text?: string; tool?: string; args?: any };
  /** Read-ahead fork: which file to read first. */
  readPath?: string;
};

function textOf(m: any): string {
  if (typeof m?.content === "string") return m.content;
  return (m?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function createHarness(script: Script, env: Record<string, string> = {}, extraFactories: { name: string; factory: any }[] = []) {
  const agentDir = mkdtempSync(join(tmpdir(), "nt-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "nt-cwd-"));
  writeFileSync(join(cwd, "math.ts"), "export function add(a: number, b: number) {\n  return a - b;\n}\n");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;

  const calls: { kind: Kind | "speculation"; user: string; messages: any[] }[] = [];
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 200_000, maxTokens: 8000 }] });
  let predictN = 0;
  const speculating = new Set<string>();
  const factory = (context: any) => {
    const msgs: any[] = context.messages;
    let ui = msgs.length - 1;
    while (ui >= 0 && msgs[ui].role !== "user") ui--;
    const user = textOf(msgs[ui]);
    const toolResults = msgs.slice(ui + 1).filter((m) => m.role === "toolResult").length;
    if (user.startsWith("[NEXT PROMPT MODE")) {
      calls.push({ kind: "predict", user, messages: msgs });
      const r = script.predict(predictN++);
      if (typeof r === "string") return fauxAssistantMessage(r);
      return fauxAssistantMessage(fauxToolCall(r.tool, r.args), { stopReason: "toolUse" });
    }
    if (user.startsWith("[READ-AHEAD MODE")) {
      calls.push({ kind: "readahead", user, messages: msgs });
      if (toolResults === 0) return fauxAssistantMessage(fauxToolCall("read", { path: script.readPath ?? "math.ts" }), { stopReason: "toolUse" });
      return fauxAssistantMessage("read math.ts");
    }
    const kind = speculating.has(user) && !harness.mainRunning ? "speculation" : "main";
    calls.push({ kind, user, messages: msgs });
    const r = script.main(user, toolResults, kind);
    if (r.tool) return fauxAssistantMessage(fauxToolCall(r.tool, r.args ?? {}), { stopReason: "toolUse" });
    return fauxAssistantMessage([fauxText(r.text ?? "ok")]);
  };
  faux.setResponses(Array.from({ length: 500 }, () => factory));

  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
  runtime.registerNativeProvider(faux.provider);
  const model = faux.getModel();
  const eventBus = createEventBus();
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, eventBus, extensionFactories: [...extraFactories, { name: "pi-next-turn", factory: extension }] });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } } as any),
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  });

  let editorText = "";
  const terminalHandlers: ((data: string) => unknown)[] = [];
  const widgets: (string[] | undefined)[] = [];
  const notices: string[] = [];
  const ui: any = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (m: string) => notices.push(m),
    onTerminalInput: (handler: (data: string) => unknown) => {
      terminalHandlers.push(handler);
      return () => {};
    },
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: (key: string, content: string[] | undefined) => {
      if (key === "next-turn") widgets.push(content);
    },
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    pasteToEditor: (t: string) => (editorText += t),
    setEditorText: (t: string) => (editorText = t),
    getEditorText: () => editorText,
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
  await session.bindExtensions({
    mode: "tui",
    uiContext: ui,
    commandContextActions: {
      waitForIdle: () => session.agent.waitForIdle?.() ?? Promise.resolve(),
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async (id: string, o?: any) => {
        const r = await session.navigateTree(id, o);
        return { cancelled: r.cancelled };
      },
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {},
    } as any,
  });

  const events: { name: string; data: any }[] = [];
  for (const name of ["next-turn:prediction", "next-turn:clear", "next-turn:outcome", "next-turn:ready", "anchored-view"]) eventBus.on(name, (data) => events.push({ name, data }));

  const harness = {
    session: session as AgentSession,
    cwd,
    agentDir,
    faux,
    calls,
    events,
    widgets,
    notices,
    eventBus,
    speculating,
    mainRunning: false,
    get editor() {
      return editorText;
    },
    setEditor(t: string) {
      editorText = t;
    },
    /** Simulates a keystroke in the TUI: the editor holds `t` afterwards. */
    async type(t: string) {
      editorText = t;
      for (const fn of terminalHandlers) fn(t);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    async prompt(text: string) {
      harness.mainRunning = true;
      try {
        await session.prompt(text);
      } finally {
        harness.mainRunning = false;
      }
    },
    /** Resolves when an event matching `pred` has been seen (already or later). */
    async waitFor(name: string, pred: (d: any) => boolean = () => true, ms = 5000): Promise<any> {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const e = events.find((e) => e.name === name && pred(e.data));
        if (e) return e.data;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for ${name}; saw ${events.map((e) => e.name).join(", ")}`);
    },
    async idle(ms = 300) {
      await new Promise((r) => setTimeout(r, ms));
    },
    dispose() {
      session.dispose();
      for (const k of Object.keys(env)) delete process.env[k];
    },
  };
  return harness;
}
