// Step 0 spike (plans/v1.md): wires a main SDK session and a fork the way the extension does and
// measures (1) fork start time, (2) whether the fork's first request has the same prefix as the main
// session's (provider payload comparison) and its cache-read share, (3) that dispose() aborts a
// running fork. Usage: npm run spike -- [provider/model]   (default openai-codex/gpt-6-luna)
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../src/config.ts";
import { captureSource, openFork, prefixReport } from "../src/fork.ts";
import { predictionInstruction } from "../src/prompt.ts";

const [provider, id] = (process.argv[2] ?? "openai-codex/gpt-6-luna").split("/");
const cwd = mkdtempSync(join(tmpdir(), "next-turn-spike-"));
writeFileSync(join(cwd, "math.ts"), "export function add(a: number, b: number) {\n  return a - b;\n}\n");
writeFileSync(join(cwd, "math.test.ts"), 'import { add } from "./math.ts";\nif (add(2, 2) !== 4) throw new Error("add is broken");\n');

let pi!: ExtensionAPI;
let ctx!: ExtensionContext;
let options: Record<string, any> | undefined;
const mainPayloads: unknown[] = [];
const capture = (api: ExtensionAPI) => {
  pi = api;
  api.on("before_agent_start", (event, c) => {
    options = event.systemPromptOptions as any;
    ctx = c;
  });
  api.on("before_provider_request", (event, c) => {
    mainPayloads.push(event.payload);
    ctx = c;
  });
  api.on("agent_settled", (_e, c) => {
    ctx = c;
  });
};

const loader = new DefaultResourceLoader({ cwd, agentDir: agentDir(), noExtensions: true, extensionFactories: [{ name: "spike-capture", factory: capture }] });
await loader.reload();
const { session } = await createAgentSession({ cwd, agentDir: agentDir(), resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: ["read", "bash", "edit", "write", "grep", "find", "ls"] });
const model = session.modelRuntime.getModel(provider, id);
if (!model) throw new Error(`unknown model ${provider}/${id}`);
await session.setModel(model);
await session.bindExtensions({});

const usageOf = (s: any) => {
  const msgs = s.messages.filter((m: any) => m.role === "assistant");
  return msgs[msgs.length - 1]?.usage;
};

console.log(`cwd ${cwd}, model ${provider}/${id}`);
await session.prompt("Look at math.ts and math.test.ts and tell me in one sentence what is wrong. Don't change anything.");
await session.prompt("Fix it.");
console.log("main last usage:", usageOf(session));

const t0 = Date.now();
const src = captureSource(pi, ctx, options);
if (!src) throw new Error("no fork source");
const fork = await openFork(src, { exec: async (name) => ({ content: [{ type: "text", text: `${name} is unavailable here` }], isError: true }) });
console.log(`fork start: ${Date.now() - t0} ms`);
await fork.session.prompt(predictionInstruction(12, 3));
const forkUsage = usageOf(fork.session);
console.log("fork usage:", forkUsage);
const reply = fork.session.messages.filter((m: any) => m.role === "assistant").pop();
console.log("fork reply:", JSON.stringify((reply as any)?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text)));
const report = prefixReport(mainPayloads[mainPayloads.length - 1], fork.payloads[0]);
console.log("prefix vs main's last request:", report);
if (forkUsage) {
  const total = (forkUsage.input ?? 0) + (forkUsage.cacheRead ?? 0) + (forkUsage.cacheWrite ?? 0);
  console.log(`cache-read share: ${total ? (((forkUsage.cacheRead ?? 0) / total) * 100).toFixed(1) : "n/a"}%`);
}
console.log("new fork entries:", fork.newEntries().map((e: any) => `${e.type}:${e.message?.role ?? ""}`));
for (const e of fork.newEntries() as any[]) if (e.message?.role === "system") console.log("system patch:", JSON.stringify({ ...e.message, toolsAdded: e.message.toolsAdded?.map((t: any) => t.name) }).slice(0, 1500));
for (const m of session.messages as any[]) if (m.role === "system") console.log("main system msg keys:", Object.keys(m), "toolsAdded:", m.toolsAdded?.map((t: any) => t.name), "toolsRemoved:", m.toolsRemoved);
const mainRead = (session.messages as any[]).find((m) => m.role === "system" && m.toolsAdded)?.toolsAdded?.find((t: any) => t.name === "read");
const forkRead = (fork.newEntries() as any[]).find((e) => e.message?.toolsAdded)?.message.toolsAdded.find((t: any) => t.name === "read");
if (mainRead && forkRead) for (const k of new Set([...Object.keys(mainRead), ...Object.keys(forkRead)])) if (JSON.stringify(mainRead[k]) !== JSON.stringify(forkRead[k])) console.log(`read.${k}: main=${JSON.stringify(mainRead[k])?.slice(0, 200)} fork=${JSON.stringify(forkRead[k])?.slice(0, 200)}`);
if (report.differentKeys.length) {
  const a = (mainPayloads[mainPayloads.length - 1] as any) ?? {};
  const b = (fork.payloads[0] as any) ?? {};
  for (const k of report.differentKeys) {
    const av = a[k];
    const bv = b[k];
    if (Array.isArray(av) && Array.isArray(bv)) {
      console.log(`${k}: main ${av.length}, fork ${bv.length}`);
      av.forEach((x: any, i: number) => {
        if (JSON.stringify(x) !== JSON.stringify(bv[i])) console.log(` [${i}] main:`, JSON.stringify(x).slice(0, 300), "\n     fork:", JSON.stringify(bv[i]).slice(0, 300));
      });
    } else console.log(k, JSON.stringify(av)?.slice(0, 300), JSON.stringify(bv)?.slice(0, 300));
  }
}
fork.dispose();

// (3) abort mid-run
const src2 = captureSource(pi, ctx, options)!;
const fork2 = await openFork(src2, { exec: async () => ({ content: [{ type: "text", text: "x" }] }) });
const running = fork2.session.prompt("Write a 400-word essay about addition.").then(
  () => "finished",
  (e) => `rejected: ${e?.message ?? e}`,
);
let firstDelta = 0;
fork2.session.subscribe((ev: any) => {
  if (!firstDelta && ev.type === "message_update") firstDelta = Date.now();
});
await new Promise((r) => setTimeout(r, 300));
const t1 = Date.now();
await fork2.session.abort();
fork2.dispose();
console.log(`abort: ${await running} after ${Date.now() - t1} ms; streaming had ${firstDelta ? "started" : "not started"}; final stop: ${(fork2.session.messages.filter((m: any) => m.role === "assistant").pop() as any)?.stopReason}`);
session.dispose();
