import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { detectCheck, NAMES_CHECKS, verifyInWorktree } from "../src/verify.ts";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "nt-verify-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node check.mjs" } }));
  writeFileSync(join(dir, "check.mjs"), 'import { readFileSync } from "node:fs";\nif (!readFileSync("math.js", "utf8").includes("a + b")) { console.error("add is broken"); process.exit(1); }\nif (readFileSync("extra.txt", "utf8") !== "untracked\\n") process.exit(2);\n');
  writeFileSync(join(dir, "math.js"), "export const add = (a, b) => a - b;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return dir;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel = "") => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      if (name.name === ".git") continue;
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p, rel + name.name + "/");
      else out[rel + name.name] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

const worktrees = (dir: string) => execFileSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" }).trim().split("\n").length;

describe("worktree verification (v2 E5)", () => {
  test("checks run against HEAD + the user's uncommitted changes + the draft; the working tree is untouched; the worktree is removed", async () => {
    const dir = repo();
    writeFileSync(join(dir, "math.js"), "export const add = (a, b) => a - b; // user edit\n");
    writeFileSync(join(dir, "extra.txt"), "untracked\n");
    const before = snapshot(dir);
    const check = (await detectCheck(dir))!;
    assert.deepEqual(check.argv, ["npm", "run", "test"]);
    let seen = "";
    const pass = await verifyInWorktree(
      dir,
      check,
      async (wt) => {
        seen = readFileSync(join(wt, "math.js"), "utf8");
        writeFileSync(join(wt, "math.js"), "export const add = (a, b) => a + b; // user edit\n");
      },
      { timeoutMs: 60_000 },
    );
    assert.equal(seen, "export const add = (a, b) => a - b; // user edit\n", "uncommitted change is in the worktree");
    assert.equal(pass.checks, "pass", pass.output ?? "");
    assert.deepEqual(snapshot(dir), before, "working tree byte-identical");
    assert.equal(worktrees(dir), 1, "worktree removed");
    const fail = await verifyInWorktree(dir, check, async () => {}, { timeoutMs: 60_000 });
    assert.equal(fail.checks, "fail");
    assert.match(fail.output ?? "", /add is broken/);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(worktrees(dir), 1);
  });

  test("abort before the check: no result, worktree removed", async () => {
    const dir = repo();
    const ac = new AbortController();
    const r = await verifyInWorktree(dir, { argv: ["node", "-e", "setTimeout(()=>{}, 10000)"], label: "slow" }, async () => ac.abort(), { timeoutMs: 60_000, signal: ac.signal });
    assert.equal(r.checks, "none");
    assert.equal(worktrees(dir), 1);
  });

  test("not a git repo: no checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nt-nogit-"));
    mkdirSync(join(dir, "x"));
    assert.equal((await verifyInWorktree(dir, { argv: ["true"], label: "t" }, async () => {}, { timeoutMs: 1000 })).checks, "none");
  });

  test("which prompts name checks", () => {
    assert.ok(NAMES_CHECKS.test("fix it and run the tests"));
    assert.ok(NAMES_CHECKS.test("make typecheck pass"));
    assert.ok(!NAMES_CHECKS.test("rename foo to bar"));
  });
});
