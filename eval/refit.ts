// v1 step 6: refit the calibration table from live outcomes in the event log (agreement scorer
// only: Jev's probabilities are its own). A shown prediction counts as a hit when it was
// accepted exactly or edited. Usage: npm run refit [-- --since 2026-10-01] [--dry-run]
import { mkdirSync, writeFileSync } from "node:fs";
import { dataDir, loadConfig } from "../src/config.ts";
import { readLog } from "../src/log.ts";
import { calibrate, calibrationPath, fitCalibration, loadCalibration } from "../src/scorer.ts";

const args = process.argv.slice(2);
const since = args.includes("--since") ? Date.parse(args[args.indexOf("--since") + 1]) : 0;
const samples = loadConfig(process.cwd()).samples;
const rows = readLog().filter((e) => e.type === "outcome" && e.scorer === "agreement" && typeof e.raw === "number" && e.samples === samples && (!since || Date.parse(e.t) >= since));
const pairs = rows.map((e) => ({ raw: e.raw as number, hit: e.outcome === "accepted_exact" || e.outcome === "accepted_edited" }));
console.log(`${pairs.length} live outcomes (k=${samples}); hit rate ${pairs.length ? ((pairs.filter((p) => p.hit).length / pairs.length) * 100).toFixed(0) : "–"}%`);
if (pairs.length < 20) {
  console.log("Fewer than 20 outcomes: keeping the current table.");
  process.exit(0);
}
const old = loadCalibration(dataDir(), samples);
const fitted = fitCalibration(pairs, samples);
for (const raw of [...new Set(pairs.map((p) => Math.round(p.raw * 1000) / 1000))].sort()) {
  const g = pairs.filter((p) => Math.round(p.raw * 1000) / 1000 === raw);
  console.log(`raw ${raw.toFixed(2)}: n ${g.length}, live hit ${((g.filter((p) => p.hit).length / g.length) * 100).toFixed(0)}%, table ${calibrate(raw, old).toFixed(2)} → ${calibrate(raw, fitted).toFixed(2)}`);
}
if (!args.includes("--dry-run")) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(calibrationPath(dataDir(), samples), JSON.stringify(fitted, null, 2) + "\n");
  console.log(`written to ${calibrationPath(dataDir(), samples)}`);
}
