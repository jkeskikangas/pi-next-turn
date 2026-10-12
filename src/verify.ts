// v2 E5: run the repository's check command against a draft in a throwaway git worktree, so the
// user's working tree is never touched. The worktree starts at HEAD plus the user's uncommitted
// changes (tracked diff and untracked files), then gets the draft, runs the command with a time
// cap, and is removed on success, failure and abort.
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Check requests a predicted prompt can name (E5: only then are checks run). */
export const NAMES_CHECKS = /\b(tests?|testing|spec|specs|typecheck|type-check|types|lint|build|ci|checks?|verify|compile)\b/i;

export type CheckCommand = { argv: string[]; label: string };

const exists = (p: string) => stat(p).then(() => true, () => false);

/** The repo's check command, by manifest: package.json test (or typecheck) script, Cargo, Go, Mix, pytest. */
export async function detectCheck(cwd: string): Promise<CheckCommand | undefined> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    const scripts = pkg?.scripts ?? {};
    const runner = (await exists(join(cwd, "pnpm-lock.yaml"))) ? "pnpm" : (await exists(join(cwd, "yarn.lock"))) ? "yarn" : (await exists(join(cwd, "bun.lockb"))) || (await exists(join(cwd, "bun.lock"))) ? "bun" : "npm";
    if (scripts.test && !/no test specified/.test(scripts.test)) return { argv: [runner, "run", "test"], label: `${runner} test` };
    if (scripts.typecheck) return { argv: [runner, "run", "typecheck"], label: `${runner} run typecheck` };
  } catch {}
  if (await exists(join(cwd, "Cargo.toml"))) return { argv: ["cargo", "test", "--quiet"], label: "cargo test" };
  if (await exists(join(cwd, "go.mod"))) return { argv: ["go", "test", "./..."], label: "go test ./..." };
  if (await exists(join(cwd, "mix.exs"))) return { argv: ["mix", "test"], label: "mix test" };
  if ((await exists(join(cwd, "pyproject.toml"))) || (await exists(join(cwd, "pytest.ini")))) return { argv: ["python3", "-m", "pytest", "-q"], label: "pytest" };
  return undefined;
}

export type VerifyResult = { checks: "pass" | "fail" | "none"; label?: string; output?: string; ms: number };

/** Directories that are usually ignored and needed to run checks; linked from the main tree. */
const LINKED = ["node_modules", "deps", "_build", ".venv", "venv", "vendor"];

export async function gitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates the worktree, lets `materialize(dir)` write the draft into it (dir = the worktree path
 * corresponding to `cwd`), runs the check, and removes the worktree.
 */
export async function verifyInWorktree(cwd: string, check: CheckCommand, materialize: (dir: string) => Promise<void>, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<VerifyResult> {
  const t0 = Date.now();
  const root = await gitRoot(cwd);
  if (!root) return { checks: "none", ms: 0 };
  const base = await mkdtemp(join(tmpdir(), "pi-next-turn-verify-"));
  const tree = join(base, "tree");
  const sub = cwd.startsWith(root) ? cwd.slice(root.length).replace(/^\//, "") : "";
  const dir = sub ? join(tree, sub) : tree;
  let added = false;
  try {
    await run("git", ["worktree", "add", "--detach", "--quiet", tree, "HEAD"], { cwd: root });
    added = true;
    const { stdout: diff } = await run("git", ["diff", "HEAD", "--binary"], { cwd: root, maxBuffer: 256 << 20 });
    if (diff.trim()) await applyPatch(tree, diff);
    const { stdout: untracked } = await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, maxBuffer: 64 << 20 });
    for (const rel of untracked.split("\0").filter(Boolean)) await cp(join(root, rel), join(tree, rel), { recursive: true, force: true }).catch(() => undefined);
    for (const name of LINKED) {
      const from = join(cwd, name);
      if ((await exists(from)) && !(await exists(join(dir, name)))) await symlink(from, join(dir, name)).catch(() => undefined);
    }
    if (opts.signal?.aborted) return { checks: "none", ms: Date.now() - t0 };
    await materialize(dir);
    try {
      const { stdout, stderr } = await run(check.argv[0], check.argv.slice(1), { cwd: dir, timeout: opts.timeoutMs, signal: opts.signal, maxBuffer: 32 << 20, env: { ...process.env, CI: "1" } });
      return { checks: "pass", label: check.label, output: (stdout + stderr).slice(-4000), ms: Date.now() - t0 };
    } catch (e: any) {
      if (opts.signal?.aborted) return { checks: "none", label: check.label, ms: Date.now() - t0 };
      return { checks: "fail", label: check.label, output: `${e?.stdout ?? ""}${e?.stderr ?? ""}`.slice(-4000) || String(e?.message ?? e), ms: Date.now() - t0 };
    }
  } catch (e: any) {
    return { checks: "none", output: String(e?.message ?? e), ms: Date.now() - t0 };
  } finally {
    if (added) await run("git", ["worktree", "remove", "--force", tree], { cwd: root }).catch(() => undefined);
    await rm(base, { recursive: true, force: true }).catch(() => undefined);
    await run("git", ["worktree", "prune"], { cwd: root }).catch(() => undefined);
  }
}

function applyPatch(cwd: string, patch: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile("git", ["apply", "--whitespace=nowarn", "-"], { cwd }, (err) => (err ? reject(err) : resolvePromise()));
    child.stdin?.end(patch);
  });
}
