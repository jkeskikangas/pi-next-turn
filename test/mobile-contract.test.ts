// The events pi-next-turn emits parse in pi-mobile (its `next-turn` branch), when a checkout is
// available: PI_MOBILE_PATH, or ../pi-mobile-nt next to this repo.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { createHarness, type Harness } from "./harness.ts";

const path = resolve(process.env.PI_MOBILE_PATH ?? join(import.meta.dirname, "..", "..", "pi-mobile-nt"));
const suggest = join(path, "src", "suggest.ts");

let h: Harness | undefined;
afterEach(() => {
  h?.dispose();
  h = undefined;
});

test("pi-mobile parses the prediction events this extension emits", { skip: existsSync(suggest) ? false : `no pi-mobile suggest.ts at ${suggest}` }, async () => {
  const { parsePrediction } = await import(suggest);
  h = await createHarness({ predict: () => "run the tests\ncommit this", main: () => ({ text: "done" }) }, { PI_NEXT_TURN_AHEAD: "read" });
  await h.prompt("a");
  await h.prompt("b");
  const ready = await h.waitFor("next-turn:prediction", (d) => d.readAhead === "ready");
  const parsed = parsePrediction(ready);
  assert.ok(parsed, "accepted");
  assert.equal(parsed.id, ready.id);
  assert.equal(parsed.sessionId, h.session.sessionManager.getSessionId());
  assert.deepEqual(parsed.candidates.map((c: any) => c.text), ["run the tests"]);
  assert.equal(parsed.readAhead, "ready");
});
