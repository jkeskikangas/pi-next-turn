import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { createHarness, type Harness } from "./harness.ts";
import { readLog } from "../src/log.ts";

let h: Harness | undefined;
afterEach(() => {
  h?.dispose();
  h = undefined;
});

const userTexts = (h: Harness) => h.session.messages.filter((m: any) => m.role === "user").map((m: any) => (typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text).join("")));

describe("v1: predict, show, read ahead, inject", () => {
  test("settled run → forked predictions → widget and event → read-ahead → accepted send gets the files", async () => {
    h = await createHarness({ predict: () => "run the tests\ncommit this", main: () => ({ text: "done" }) });
    await h.prompt("look at math.ts");
    assert.equal(h.events.filter((e) => e.name === "next-turn:prediction").length, 0, "no prediction after one assistant message");
    await h.prompt("what is wrong with it");
    const first = await h.waitFor("next-turn:prediction");
    assert.equal(first.candidates[0].text, "run the tests");
    assert.equal(first.candidates[0].p, 0.75);
    assert.equal(h.calls.filter((c) => c.kind === "predict").length, 3, "three samples");
    const ready = await h.waitFor("next-turn:prediction", (d) => d.readAhead === "ready");
    assert.equal(ready.id, first.id);
    assert.ok(h.widgets.some((w) => w?.[0]?.includes("run the tests") && w[0].includes("files ready")), JSON.stringify(h.widgets));
    // Forks see the same history as the main session: the prediction request carries it.
    const pc = h.calls.find((c) => c.kind === "predict")!;
    assert.ok(pc.messages.some((m: any) => m.role === "user" && JSON.stringify(m.content).includes("what is wrong with it")));
    await h.prompt("run the tests");
    const main = h.calls.filter((c) => c.kind === "main").pop()!;
    const injected = main.messages.find((m: any) => m.role === "custom" || JSON.stringify(m).includes("read ahead of time"));
    assert.ok(injected, "read-ahead files went into the accepted turn");
    assert.match(JSON.stringify(injected), /math\.ts \(complete, 3 lines\)/);
    const outcome = await h.waitFor("next-turn:outcome");
    assert.equal(outcome.outcome, "accepted_exact");
    assert.ok(h.events.some((e) => e.name === "next-turn:clear" && e.data.id === first.id));
    const log = readLog(join(h.agentDir, "next-turn", "log.ndjson"));
    assert.ok(log.some((e) => e.type === "prediction" && e.shown));
    assert.ok(log.some((e) => e.type === "read_ahead" && e.files === 1));
    assert.ok(log.some((e) => e.type === "inject" && e.files === 1));
    assert.ok(!log.some((e) => "sent" in e), "texts are not logged without debug");
  });

  test("changed course: no injection, outcome recorded", async () => {
    h = await createHarness({ predict: () => "run the tests", main: () => ({ text: "done" }) });
    await h.prompt("a");
    await h.prompt("b");
    await h.waitFor("next-turn:prediction", (d) => d.readAhead === "ready");
    await h.prompt("explain the hub protocol in detail");
    const main = h.calls.filter((c) => c.kind === "main").pop()!;
    assert.ok(!JSON.stringify(main.messages).includes("read ahead of time"));
    assert.equal((await h.waitFor("next-turn:outcome")).outcome, "changed_course");
  });

  test("a prediction fork that calls a tool yields no prediction", async () => {
    h = await createHarness({ predict: () => ({ tool: "bash", args: { command: "ls" } }), main: () => ({ text: "done" }) });
    await h.prompt("a");
    await h.prompt("b");
    await h.idle(500);
    assert.equal(h.events.filter((e) => e.name === "next-turn:prediction").length, 0);
    const log = readLog(join(h.agentDir, "next-turn", "log.ndjson"));
    assert.ok(log.some((e) => e.type === "prediction" && e.shown === false));
  });

  test("low agreement below the show threshold shows nothing", async () => {
    h = await createHarness({ predict: (n) => ["run the tests", "commit and push", "explain the protocol"][n % 3], main: () => ({ text: "done" }) });
    await h.prompt("a");
    await h.prompt("b");
    await h.idle(500);
    assert.equal(h.events.filter((e) => e.name === "next-turn:prediction").length, 0, "1/3 agreement → p 0.25 < 0.35");
  });

  test("fill key puts the prediction into the editor; typing hides the widget", async () => {
    h = await createHarness({ predict: (n) => (n % 3 === 2 ? "commit this" : "run the tests"), main: () => ({ text: "done" }) }, { PI_NEXT_TURN_READ_AHEAD: "off", PI_NEXT_TURN_P_SHOW: "0.2" });
    await h.prompt("a");
    await h.prompt("b");
    await h.waitFor("next-turn:prediction");
    const runner: any = (h.session as any).extensionRunner;
    const shortcuts: Map<string, any> = runner.getShortcuts({});
    const ctx = runner.createContext();
    const find = (key: string) => shortcuts.get(key);
    await find("alt+n").handler(ctx);
    assert.equal(h.editor, "run the tests");
    await find("alt+]").handler(ctx);
    assert.equal(h.editor, "commit this", "cycling replaces a filled prediction");
    assert.ok(h.widgets[h.widgets.length - 1]?.length, "widget still shown for the filled text");
    await h.type("commit this and push");
    assert.equal(h.widgets[h.widgets.length - 1], undefined, "typing hides the widget");
    await h.type("");
    assert.ok(h.widgets[h.widgets.length - 1]?.length, "an empty editor shows it again");
  });
});

describe("v2: speculative draft and hand-over", () => {
  /** A minimal stand-in for pi-multiedit's draft channel: whole-file `{path, content}` edits in memory. */
  function fakeDrafts(h: Harness) {
    const drafts = new Map<string, Map<string, string>>();
    let n = 0;
    const log: string[] = [];
    h.eventBus.on("multiedit:draft", (req: any) => {
      log.push(req.op);
      const d = drafts.get(req.draftId);
      switch (req.op) {
        case "open":
          drafts.set(`d${++n}`, new Map());
          return req.reply({ draftId: `d${n}` });
        case "edit":
          if (!d) return req.reply({ error: "unknown draft" });
          {
            const abs = join(h.cwd, req.params.path);
            let text = d.get(abs) ?? readFileSync(abs, "utf8");
            for (const e of req.params.edits ?? []) text = text.replace(e.oldText, e.newText);
            d.set(abs, text);
          }
          return req.reply({ content: [{ type: "text", text: `drafted, not written: ${req.params.path}` }], details: { written: false } });
        case "read": {
          const abs = join(h.cwd, req.path);
          const text = d?.get(abs) ?? readFileSync(abs, "utf8");
          return req.reply({ content: [{ type: "text", text }], abs, fileText: text });
        }
        case "summary":
          if (!d) return req.reply({ error: "unknown draft" });
          return req.reply({ files: [...d.keys()].map((p) => ({ path: p.slice(h.cwd.length + 1), status: "modified" })), insertions: d.size, deletions: d.size });
        case "apply": {
          if (!d) return req.reply({ ok: false, error: "unknown draft" });
          for (const [p, c] of d) writeFileSync(p, c);
          drafts.delete(req.draftId);
          return req.reply({ ok: true, content: [{ type: "text", text: "Applied 1 step(s)" }] });
        }
        case "discard":
          drafts.delete(req.draftId);
          return req.reply({ ok: true });
        case "materialize":
          return req.reply({ ok: true });
        default:
          return req.reply({ error: "unknown op" });
      }
    });
    return { drafts, log };
  }
  const fixed = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
  const script = {
    predict: () => "fix the bug",
    main: (user: string, toolResults: number) => {
      if (user === "fix the bug") return toolResults === 0 ? { tool: "edit", args: { path: "math.ts", edits: [{ oldText: "a - b", newText: "a + b" }] } } : { text: "fixed add" };
      return { text: "done" };
    },
  };

  test("exact send of a complete speculation: draft applied, prepared turn handed over without a new model run", async () => {
    h = await createHarness(script, { PI_NEXT_TURN_DRAFT: "on", PI_NEXT_TURN_P_DRAFT: "0.7", PI_NEXT_TURN_VERIFY: "off" });
    const fake = fakeDrafts(h);
    h.speculating.add("fix the bug");
    await h.prompt("a");
    await h.prompt("b");
    const ev = await h.waitFor("next-turn:prediction", (d) => !!d.draft, 8000);
    assert.deepEqual(ev.draft, { files: 1, insertions: 1, deletions: 1, checks: "none" });
    assert.equal(readFileSync(join(h.cwd, "math.ts"), "utf8").includes("a - b"), true, "nothing written before the send");
    assert.ok(h.widgets.some((w) => w?.[0]?.includes("draft: 1 file")));
    const mainCallsBefore = h.calls.filter((c) => c.kind === "main").length;
    await h.prompt("fix the bug");
    await h.waitFor("next-turn:outcome");
    await h.idle(300);
    assert.equal(readFileSync(join(h.cwd, "math.ts"), "utf8"), fixed, "draft applied");
    assert.equal(h.calls.filter((c) => c.kind === "main").length, mainCallsBefore, "no new main model run");
    const users = userTexts(h);
    assert.equal(users[users.length - 1], "fix the bug");
    const assistants: any[] = h.session.messages.filter((m: any) => m.role === "assistant");
    assert.match(JSON.stringify(assistants[assistants.length - 1].content), /fixed add/);
    assert.ok(h.session.messages.some((m: any) => m.role === "custom" && m.customType === "pi-next-turn" && String(m.content).includes("draft was applied")));
    assert.ok(fake.log.includes("apply"));
    const log = readLog(join(h.agentDir, "next-turn", "log.ndjson"));
    assert.ok(log.some((e) => e.type === "handover" && e.ok === true));
    assert.ok(log.some((e) => e.type === "outcome" && e.outcome === "accepted_exact" && e.handover === true));
  });

  test("a different send discards the draft and runs normally", async () => {
    h = await createHarness(script, { PI_NEXT_TURN_DRAFT: "on", PI_NEXT_TURN_P_DRAFT: "0.7", PI_NEXT_TURN_VERIFY: "off" });
    const fake = fakeDrafts(h);
    h.speculating.add("fix the bug");
    await h.prompt("a");
    await h.prompt("b");
    await h.waitFor("next-turn:prediction", (d) => !!d.draft, 8000);
    await h.prompt("explain the hub protocol in detail");
    await h.idle(100);
    assert.ok(readFileSync(join(h.cwd, "math.ts"), "utf8").includes("a - b"), "draft not applied");
    assert.ok(fake.log.includes("discard"));
    assert.equal(fake.drafts.has("d1"), false, "the first speculation's draft is gone");
    assert.ok(userTexts(h).includes("explain the hub protocol in detail"));
  });

  test("a refused tool ends the speculation: no hand-over, the send runs normally", async () => {
    const s = { predict: () => "fix the bug", main: (user: string, tr: number) => (user === "fix the bug" && tr === 0 ? { tool: "bash", args: { command: "npm install left-pad" } } : { text: "done" }) };
    h = await createHarness(s, { PI_NEXT_TURN_DRAFT: "on", PI_NEXT_TURN_P_DRAFT: "0.7" });
    fakeDrafts(h);
    h.speculating.add("fix the bug");
    await h.prompt("a");
    await h.prompt("b");
    await h.waitFor("next-turn:prediction");
    await h.idle(500);
    const log = readLog(join(h.agentDir, "next-turn", "log.ndjson"));
    const spec = log.find((e) => e.type === "speculation");
    assert.equal(spec?.complete, false);
    assert.equal(spec?.refused, "bash");
    const mainBefore = h.calls.filter((c) => c.kind === "main").length;
    await h.prompt("fix the bug");
    assert.equal(h.calls.filter((c) => c.kind === "main").length, mainBefore + 2, "ran normally");
  });
});
