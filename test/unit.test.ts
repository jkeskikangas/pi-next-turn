import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { formatAnchored, lineHash } from "../src/anchor.ts";
import { DEFAULTS, loadConfig, saveSetting } from "../src/config.ts";
import { bestCut, extractTurns, fileOverlap, gate, metrics, splitOf } from "../src/evalcore.ts";
import { clean, parseCandidates, rejectReason } from "../src/filters.ts";
import { declaredTools, prefixReport } from "../src/fork.ts";
import { BackOff, skipReason } from "../src/gates.ts";
import { composeInjection, readIsAnchored } from "../src/inject.ts";
import { JevScorer, findJev, judgeSpeculation } from "../src/jev.ts";
import { stats } from "../src/log.ts";
import { AgreementScorer, calibrate, cluster, DEFAULT_CALIBRATION, fitCalibration } from "../src/scorer.ts";
import { classifySend, normalize, similarity } from "../src/similar.ts";
import { allowedCommand, readFromDisk, splitCommand } from "../src/tools.ts";
import { renderWidget, suffix } from "../src/tui.ts";

describe("similarity and outcomes", () => {
  test("normalization ignores case, punctuation and spacing", () => {
    assert.equal(normalize("  Run the TESTS!  "), "run the tests");
    assert.equal(similarity("run the tests", "Run the tests."), 1);
  });
  test("close variants are similar, different requests are not", () => {
    assert.ok(similarity("run the tests", "run tests") >= 0.6);
    assert.ok(similarity("fix the typo", "fix typos") >= 0.6);
    assert.ok(similarity("commit and push", "write the android plan") < 0.4);
  });
  test("classifySend: exact, edited, changed course", () => {
    assert.deepEqual(classifySend(["run the tests"], "Run the tests", 0.6).outcome, "accepted_exact");
    assert.equal(classifySend(["commit this", "run the tests"], "run tests please", 0.6).outcome, "accepted_edited");
    assert.equal(classifySend(["commit this", "run the tests"], "run tests please", 0.6).index, 1);
    assert.equal(classifySend(["commit this"], "explain the hub protocol", 0.6).outcome, "changed_course");
  });
});

describe("filters", () => {
  test("keeps ordinary next prompts, including conventional-commit shapes and 'greater'", () => {
    for (const ok of ["run the tests", "commit this", "fix: handle empty input", "add a greater-than check", "/compact", "yes", "write plans/native-android.md with the Android id"]) assert.equal(rejectReason(ok), undefined, ok);
  });
  test("drops what Claude Code drops", () => {
    const cases: [string, string][] = [
      ["", "empty"],
      ["done", "done"],
      ["No suggestion", "meta_text"],
      ["(silence)", "meta_text"],
      ["[nothing to add here]", "meta_wrapped"],
      ["API error: 500", "error_message"],
      ["tests", "too_few_words"],
      ["one two three four five six seven eight nine ten eleven twelve thirteen", "too_many_words"],
      ["Fix it. Then commit", "multiple_sentences"],
      ["run **all** tests", "has_formatting"],
      ["Great, now commit", "evaluative"],
      ["Let me run the tests", "assistant_voice"],
    ];
    for (const [text, reason] of cases) assert.equal(rejectReason(text), reason, text);
    assert.equal(rejectReason("x".repeat(60) + " " + "y".repeat(45)), "too_long");
  });
  test("disabled filters are skipped", () => {
    assert.equal(rejectReason("Great, now commit", undefined, new Set(["evaluative"])), undefined);
  });
  test("clean and parse strip list markers, labels, quotes; NONE gives nothing", () => {
    assert.equal(clean('1. "run the tests"'), "run the tests");
    assert.equal(clean("Suggestion: commit this"), "commit this");
    assert.deepEqual(parseCandidates("NONE"), []);
    assert.deepEqual(parseCandidates("- run the tests\n- commit this\n- push\n- deploy"), ["run the tests", "commit this", "push"]);
  });
});

describe("scoring", () => {
  test("agreement: clusters similar tops; raw share of samples", () => {
    const s = new AgreementScorer(0.6);
    const raw = s.raw([["run the tests", "commit"], ["run tests"], ["commit this", "run the tests"]]);
    assert.equal(raw[0].raw, 2 / 3);
    assert.match(raw[0].text, /run (the )?tests/);
    assert.equal(raw[1].raw, 1 / 3);
  });
  test("one sample: rank weights stand in for agreement", () => {
    const raw = new AgreementScorer(0.6).raw([["a b", "c d", "e f"]]);
    assert.ok(raw[0].raw > raw[1].raw && raw[1].raw > raw[2].raw);
    assert.ok(Math.abs(raw.reduce((a, r) => a + r.raw, 0) - 1) < 1e-9);
  });
  test("calibration is piecewise linear and the default discounts agreement", () => {
    assert.equal(calibrate(1), 0.75);
    assert.equal(calibrate(0), 0);
    assert.ok(calibrate(0.5) > 0.25 && calibrate(0.5) < 0.5);
    assert.equal(calibrate(1, { points: [[0, 0], [1, 1]] }), 1);
  });
  test("fitCalibration is monotone and smoothed", () => {
    const pairs = [...Array(10)].flatMap((_, i) => [
      { raw: 1, hit: i < 9 },
      { raw: 2 / 3, hit: i < 3 },
      { raw: 1 / 3, hit: i < 5 },
    ]);
    const cal = fitCalibration(pairs, 3);
    const ys = cal.points.map((p) => p[1]);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] >= ys[i - 1], JSON.stringify(cal.points));
    assert.ok(calibrate(1, cal) > 0.8 && calibrate(1, cal) < 0.9);
  });
  test("cluster orders by top-1 votes", () => {
    const c = cluster([["x y"], ["p q"], ["p q"]], 0.6);
    assert.equal(c[0].votes, 2);
  });
  test("agreement scorer probabilities come from the table", async () => {
    const out = await new AgreementScorer(0.6, DEFAULT_CALIBRATION).score([["run the tests"], ["run the tests"], ["run the tests"]]);
    assert.deepEqual(out, [{ text: "run the tests", p: 0.75, raw: 1 }]);
  });
});

describe("Jev (optional)", () => {
  const registry = (answers: Record<string, any>[], models: any[] = [{ id: "jev-1" }]) => {
    const calls: any[] = [];
    return {
      calls,
      getAvailableOfType: async () => models,
      classify: async (_m: unknown, ctx: any) => {
        calls.push(ctx);
        return { stopReason: "stop", answers: answers.shift() };
      },
    };
  };
  test("findJev: undefined without a classifier, a model when one is configured", async () => {
    assert.equal(await findJev(undefined), undefined);
    assert.equal(await findJev(registry([], [])), undefined);
    assert.deepEqual(await findJev(registry([])), { id: "jev-1" });
  });
  test("rank then verify: choice picks the winner, bool sets its probability", async () => {
    const r = registry([{ next: { type: "choice", choice: "c1", probabilities: { c0: 0.2, c1: 0.7, none: 0.1 } } }, { sends: { type: "bool", probability: 0.82 } }]);
    const out = await new JevScorer(r, { id: "jev-1" }, 0.6).score([["commit this"], ["run the tests"], ["commit this"]], { lastAssistant: "done", recentUser: ["fix it"] });
    assert.equal(out[0].text, "run the tests");
    assert.equal(out[0].p, 0.82);
    assert.ok(out[1].p <= 0.18 + 1e-9);
    assert.equal(r.calls.length, 2);
    assert.ok(!JSON.stringify(r.calls[0]).includes("thinking"));
  });
  test("safety: separate criteria, all must pass", async () => {
    const safe = await judgeSpeculation(registry([{ local_only: { type: "bool", probability: 0.95 }, reversible: { type: "bool", probability: 0.9 }, needs_decision: { type: "bool", probability: 0.1 } }]), {}, "rename foo", "");
    assert.equal(safe.safe, true);
    const unsafe = await judgeSpeculation(registry([{ local_only: { type: "bool", probability: 0.3 }, reversible: { type: "bool", probability: 0.9 }, needs_decision: { type: "bool", probability: 0.1 } }]), {}, "deploy", "");
    assert.equal(unsafe.safe, false);
  });
});

describe("gates and back-off", () => {
  const base = { enabled: true, mode: "tui", assistantMessages: 3, aborted: false, dialogOpen: false, pendingMessages: false };
  test("skip reasons", () => {
    assert.equal(skipReason(base), undefined);
    assert.equal(skipReason({ ...base, enabled: false }), "disabled");
    assert.equal(skipReason({ ...base, mode: "print" }), "mode");
    assert.equal(skipReason({ ...base, mode: "json" }), "mode");
    assert.equal(skipReason({ ...base, mode: "rpc" }), undefined);
    assert.equal(skipReason({ ...base, assistantMessages: 1 }), "too_early");
    assert.equal(skipReason({ ...base, aborted: true }), "aborted");
    assert.equal(skipReason({ ...base, lastStopReason: "error" }), "error");
    assert.equal(skipReason({ ...base, dialogOpen: true }), "dialog");
    assert.equal(skipReason({ ...base, pendingMessages: true }), "pending");
  });
  test("after 20 unused, one turn in 10; using one resets", () => {
    const b = new BackOff(20, 10);
    for (let i = 0; i < 20; i++) {
      assert.equal(b.allow(), true);
      b.unusedOne();
    }
    const allowed = [...Array(20)].map(() => b.allow()).filter(Boolean).length;
    assert.equal(allowed, 2);
    b.used();
    assert.equal(b.allow(), true);
    assert.equal(b.active, false);
  });
});

describe("tools", () => {
  test("shell allowlist: read-only commands without shell features", () => {
    assert.deepEqual(allowedCommand("git status --short"), ["git", "status", "--short"]);
    assert.deepEqual(allowedCommand("rg -n 'foo bar' src"), ["rg", "-n", "foo bar", "src"]);
    for (const bad of ["rm -rf x", "git push", "git commit -m x", "git branch -D main", "cat a > b", "ls; rm x", "echo $(id)", "rg --pre=sh x", "git diff --output=x", "npm test", "cat `x`"]) assert.equal(allowedCommand(bad), undefined, bad);
    assert.equal(splitCommand("a 'b"), undefined);
  });
  test("disk read: anchored lines byte-compatible with pi-multiedit, paging, whole-file tracking", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nt-read-"));
    writeFileSync(join(dir, "a.ts"), "const a = 1;\n}\nexport { a };\n");
    const seen = new Map<string, string>();
    const r = await readFromDisk(dir, { path: "a.ts" }, true, seen);
    assert.equal(r.content[0].text, formatAnchored(["const a = 1;", "}", "export { a };"], 1));
    assert.equal(seen.get(join(dir, "a.ts")), "const a = 1;\n}\nexport { a };\n");
    const part = await readFromDisk(dir, { path: "a.ts", offset: 2, limit: 1 }, false, new Map());
    assert.match(part.content[0].text, /^2: }\n\n\[lines 2-2 of 3; continue with offset=3\]$/);
    assert.equal((await readFromDisk(dir, { path: "nope" }, true, seen)).isError, true);
  });
  test("line hash matches pi-hashline-edit's known values", () => {
    assert.equal(lineHash(1, "const a = 1;"), lineHash(7, "const a = 1;   "));
    assert.notEqual(lineHash(1, "}"), lineHash(2, "}"));
  });
});

describe("injection", () => {
  test("whole files, anchored when the read tool is, under the cap", () => {
    const files = new Map([
      ["/r/a.ts", "x\ny\n"],
      ["/r/big.ts", "z".repeat(500)],
    ]);
    const inj = composeInjection("/r", files, 200, true)!;
    assert.deepEqual(inj.files, ["a.ts"]);
    assert.match(inj.text, /### a\.ts \(complete, 2 lines\)\n1#..:x\n2#..:y/);
    assert.deepEqual(inj.views, [{ path: "/r/a.ts", text: "x\ny\n" }]);
    const plain = composeInjection("/r", files, 1000, false)!;
    assert.match(plain.text, /1: x/);
    assert.deepEqual(plain.views, []);
    assert.equal(composeInjection("/r", new Map(), 100, true), undefined);
  });
  test("anchored read detection", () => {
    assert.equal(readIsAnchored([{ name: "read", description: "Read a file. Lines come back as N#HH:content" }]), true);
    assert.equal(readIsAnchored([{ name: "read", description: "Read the contents of a file." }]), false);
  });
});

describe("fork helpers", () => {
  test("declaredTools replays toolsAdded/toolsRemoved in order", () => {
    const sys = (added: any[], removed: any[] = []) => ({ type: "message", message: { role: "system", toolsAdded: added, toolsRemoved: removed } });
    const branch: any[] = [sys([{ name: "read", description: "r", parameters: {}, constrainedSampling: { type: "json_schema" } }, { name: "bash", description: "b", parameters: {} }]), { type: "message", message: { role: "user" } }, sys([{ name: "read", description: "r2", parameters: {} }], [{ name: "read" }, { name: "bash" }])];
    const tools = declaredTools(branch);
    assert.deepEqual(tools.map((t) => [t.name, t.description]), [["read", "r2"]]);
    assert.deepEqual(declaredTools(branch.slice(0, 1)).map((t) => t.name), ["read", "bash"]);
    assert.deepEqual(declaredTools(branch.slice(0, 1))[0].constrainedSampling, { type: "json_schema" });
  });
  test("prefixReport", () => {
    const r = prefixReport({ model: "m", tools: [1], messages: [1, 2, 3] }, { model: "m", tools: [2], messages: [1, 2, 4, 5] });
    assert.deepEqual(r, { equalKeys: ["model"], differentKeys: ["tools"], commonMessages: 2, mainMessages: 3 });
  });
});

describe("tui widget", () => {
  test("selected candidate, suffixes, key hints", () => {
    const lines = renderWidget({ candidates: [{ text: "run the tests", p: 0.8 }, { text: "commit", p: 0.4 }], selected: 0, readAhead: "ready", keys: { fill: "alt+n", cycle: "alt+]" } });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /› run the tests · files ready  alt\+n to use · alt\+\] next/);
    assert.equal(suffix({ readAhead: "ready", draft: { files: 3, insertions: 1, deletions: 0, checks: "pass" } }), " · draft: 3 files, tests pass");
    assert.equal(suffix({ readAhead: "none", draft: { files: 1, insertions: 1, deletions: 0, checks: "fail" } }), " · draft: 1 file, tests fail");
    assert.deepEqual(renderWidget({ candidates: [], selected: 0, readAhead: "none", keys: { fill: "a", cycle: "b" } }), []);
  });
});

describe("config", () => {
  test("defaults < user file < project file < env; set writes the user file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nt-cfg-"));
    const env = { PI_CODING_AGENT_DIR: dir } as NodeJS.ProcessEnv;
    assert.deepEqual(loadConfig("/x", env), DEFAULTS);
    assert.equal(saveSetting("pRead", "0.8", {}, env), undefined);
    assert.equal(saveSetting("keys.fill", "alt+j", {}, env), undefined);
    assert.equal(saveSetting("draft", "on", { cwd: "/x" }, env), undefined);
    assert.match(saveSetting("nope", "1", {}, env)!, /unknown/);
    assert.match(saveSetting("pRead", "high", {}, env)!, /number/);
    const c = loadConfig("/x", { ...env, PI_NEXT_TURN_SAMPLES: "5", PI_NEXT_TURN_SCORER: "jev" });
    assert.equal(c.pRead, 0.8);
    assert.equal(c.keys.fill, "alt+j");
    assert.equal(c.keys.cycle, DEFAULTS.keys.cycle);
    assert.equal(c.draft, true);
    assert.equal(loadConfig("/y", env).draft, false);
    assert.equal(c.samples, 5);
    assert.equal(c.scorer, "jev");
    assert.ok(JSON.parse(readFileSync(join(dir, "next-turn", "config.json"), "utf8")).keys.fill === "alt+j");
  });
});

describe("eval core", () => {
  const msg = (role: string, content: any, extra: any = {}) => ({ type: "message", id: Math.random().toString(36), message: { role, content, ...extra } });
  test("extractTurns: after two assistant messages, with the real run's reads", () => {
    const branch: any[] = [
      msg("user", "hi"),
      msg("assistant", [{ type: "text", text: "a" }]),
      msg("user", "next"),
      msg("assistant", [{ type: "text", text: "b" }]),
      msg("user", "fix it"),
      msg("assistant", [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }, { type: "toolCall", name: "grep", arguments: {} }]),
      msg("user", "/compact"),
    ];
    const turns = extractTurns("f", branch);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].actual, "fix it");
    assert.deepEqual(turns[0].readPaths, ["a.ts"]);
    assert.equal(turns[0].searchCalls, 2);
    assert.equal(turns[0].prefix.length, 4);
  });
  test("split is by session and stable", () => {
    assert.equal(splitOf("a.jsonl"), splitOf("a.jsonl"));
    const n = [...Array(200)].filter((_, i) => splitOf(`s${i}.jsonl`) === "calibration").length;
    assert.ok(n > 110 && n < 170, String(n));
  });
  test("metrics, gate, best cut, overlap", () => {
    const turn = (actual: string) => ({ sessionFile: "f", prefix: [], actual, readPaths: [], searchCalls: 0 });
    const rows = [
      { turn: turn("run the tests"), candidates: [{ text: "run the tests", raw: 1, p: 0.8 }], cost: 0.01, ms: 100, dropped: [] },
      { turn: turn("commit"), candidates: [{ text: "push it", raw: 0.3, p: 0.2 }], cost: 0.01, ms: 100, dropped: [{ text: "commit", reason: "too_few_words" }] },
    ];
    const m = metrics(rows, { pShow: 0.35, pHigh: 0.7, cut: 0.6 });
    assert.equal(m.coverage, 0.5);
    assert.equal(m.hitTop, 0.5);
    assert.equal(m.highConfidence.n, 1);
    assert.equal(m.highConfidence.hitRate, 1);
    assert.deepEqual(m.filterFalseDrops, { too_few_words: { dropped: 1, wouldHaveHit: 1 } });
    const g = gate(m);
    assert.equal(g.pass, false);
    assert.ok(g.reasons.some((r) => r.includes("calibration")));
    assert.equal(bestCut([{ similarity: 0.9, same: true }, { similarity: 0.7, same: true }, { similarity: 0.5, same: false }]).cut, 0.55);
    assert.deepEqual(fileOverlap(["a", "b"], ["a", "c", "d"]), { precision: 0.5, recall: 1 / 3 });
  });
  test("log stats", () => {
    const s = stats([
      { t: "2026-01-01", type: "prediction", shown: true, cost: 0.01 },
      { t: "2026-01-01", type: "outcome", outcome: "accepted_exact" },
      { t: "2026-01-01", type: "handover", ok: true },
    ]);
    assert.equal(s.shown, 1);
    assert.equal(s.accepted_exact, 1);
    assert.equal(s.handovers, 1);
  });
});
