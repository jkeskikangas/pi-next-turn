// v2 against the real pi-multiedit draft channel (not a stand-in). Runs when a pi-multiedit
// checkout with draft support is available: PI_MULTIEDIT_PATH, or ../pi-multiedit next to this repo.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { readLog } from "../src/log.ts";
import { createHarness, type Harness } from "./harness.ts";

const path = resolve(process.env.PI_MULTIEDIT_PATH ?? join(import.meta.dirname, "..", "..", "pi-multiedit"));
const available = existsSync(join(path, "src", "draft.ts"));

let h: Harness | undefined;
afterEach(() => {
  h?.dispose();
  h = undefined;
});

describe("v2 with pi-multiedit drafts", { skip: available ? false : `no pi-multiedit with drafts at ${path}` }, () => {
  const script = {
    predict: () => "fix the bug and run the tests",
    main: (user: string, toolResults: number) => {
      if (user !== "fix the bug and run the tests") return { text: "done" };
      if (toolResults === 0) return { tool: "read", args: { path: "math.ts" } };
      if (toolResults === 1) return { tool: "edit", args: { edits: [{ path: "math.ts", old: "a - b", new: "a + b" }] } };
      return { text: "fixed add" };
    },
  };

  test("speculation edits a real draft (disk untouched), hand-over applies it", async () => {
    const multiedit = (await import(join(path, "index.ts"))).default;
    h = await createHarness(script, { PI_NEXT_TURN_AHEAD: "draft", PI_NEXT_TURN_P_DRAFT: "0.7", PI_NEXT_TURN_VERIFY: "off" }, [{ name: "pi-multiedit", factory: multiedit }]);
    h.speculating.add("fix the bug and run the tests");
    await h.prompt("a");
    await h.prompt("b");
    const ev = await h.waitFor("next-turn:prediction", (d) => !!d.draft, 10_000);
    assert.equal(ev.draft.files, 1);
    assert.ok(readFileSync(join(h.cwd, "math.ts"), "utf8").includes("a - b"), "disk untouched before the send");
    const spec = h.calls.filter((c) => c.kind === "speculation");
    assert.ok(spec.some((c) => JSON.stringify(c.messages).includes("drafted, not written")), "edit went to the draft");
    await h.prompt("fix the bug and run the tests");
    await h.waitFor("next-turn:outcome");
    await h.idle(300);
    assert.ok(readFileSync(join(h.cwd, "math.ts"), "utf8").includes("a + b"), "applied on hand-over");
    assert.ok(readLog(join(h.agentDir, "next-turn", "log.ndjson")).some((e) => e.type === "handover" && e.ok));
  });

  test("checks run on the materialized draft in a worktree: tests pass, working tree untouched", async () => {
    const multiedit = (await import(join(path, "index.ts"))).default;
    h = await createHarness(script, { PI_NEXT_TURN_AHEAD: "draft", PI_NEXT_TURN_P_DRAFT: "0.7", PI_NEXT_TURN_VERIFY: "on" }, [{ name: "pi-multiedit", factory: multiedit }]);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: h!.cwd, stdio: "pipe" });
    writeFileSync(join(h.cwd, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node check.mjs" } }));
    writeFileSync(join(h.cwd, "check.mjs"), 'import { readFileSync } from "node:fs";\nif (!readFileSync("math.ts", "utf8").includes("a + b")) process.exit(1);\n');
    git("init", "-q");
    git("-c", "user.email=a@b", "-c", "user.name=a", "add", "-A");
    git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init");
    h.speculating.add("fix the bug and run the tests");
    await h.prompt("a");
    await h.prompt("b");
    const ev = await h.waitFor("next-turn:prediction", (d) => !!d.draft, 30_000);
    assert.equal(ev.draft.checks, "pass");
    assert.ok(readFileSync(join(h.cwd, "math.ts"), "utf8").includes("a - b"), "working tree untouched");
    assert.equal(execFileSync("git", ["worktree", "list"], { cwd: h.cwd, encoding: "utf8" }).trim().split("\n").length, 1);
  });

  test("a conflicting change under the drafted line: nothing written, the prompt runs normally", async () => {
    const multiedit = (await import(join(path, "index.ts"))).default;
    h = await createHarness(script, { PI_NEXT_TURN_AHEAD: "draft", PI_NEXT_TURN_P_DRAFT: "0.7", PI_NEXT_TURN_VERIFY: "off" }, [{ name: "pi-multiedit", factory: multiedit }]);
    h.speculating.add("fix the bug and run the tests");
    await h.prompt("a");
    await h.prompt("b");
    await h.waitFor("next-turn:prediction", (d) => !!d.draft, 10_000);
    writeFileSync(join(h.cwd, "math.ts"), "export function add(a: number, b: number) {\n  return b - a;\n}\n");
    h.speculating.delete("fix the bug and run the tests");
    await h.prompt("fix the bug and run the tests");
    await h.idle(500);
    const log = readLog(join(h.agentDir, "next-turn", "log.ndjson"));
    assert.ok(log.some((e) => e.type === "handover" && e.ok === false && /draft not applied/.test(e.reason)), JSON.stringify(log.filter((e) => e.type === "handover")));
    assert.ok(h.calls.filter((c) => c.kind === "main" && c.user === "fix the bug and run the tests").length >= 1, "ran normally");
  });
});
