// Opt-in, costs a fraction of a cent: the real model writes the lines for `insights --roast api`, and the checks in
// src/roast.ts have to accept them (or fall back with a note). Never run by `npm test`.
//   AGENT_LOOP_REAL_MODEL_TESTS=1 npm run test:real-model-roast
import assert from "node:assert";
import { claudeGenerate, DEFAULT_ROAST_MODEL } from "../dist/roast-api.js";
import { allowedNumbersFor, emptyHabits, lintLine, roast, roastWithModel } from "../dist/roast.js";

if (process.env.AGENT_LOOP_REAL_MODEL_TESTS !== "1") { console.log("skipped: set AGENT_LOOP_REAL_MODEL_TESTS=1 to spend a fraction of a cent on a real model call"); process.exit(0); }

const h = {
  ...emptyHabits(), runs: 9, done: 4, failed: 4, stopped: 1, totalCostUsd: 14.2, wastedUsd: 6.7, priciestRunUsd: 3.1,
  approvals: { asked: 31, approved: 26, denied: 5, auto: 4 }, quickYes: 19, slowestAnswerMin: 14, deniedThenAllowed: 2,
  rulesCreated: 5, rulesNeverReused: 4, repairedRunsByPhase: { builder: 5, verifier: 2 }, nightRuns: 3, repeatedTaskMax: 3, longestRunMin: 47,
};
const level = "dark";
const base = roast(h, level, 99);
const res = await roastWithModel(h, level, claudeGenerate(), 90_000);
console.log(`model ${process.env.AGENT_LOOP_ROAST_MODEL || DEFAULT_ROAST_MODEL}, cost $${res.costUsd.toFixed(4)}, findings: ${base.findings.join(", ")}`);
if (!res.lines.length) { console.log("fell back:", res.note); assert.ok(res.note, "a fallback must say why"); }
else {
  console.log("\nthe model's lines:"); for (const l of res.lines) console.log("  ◦ " + l);
  const allowed = allowedNumbersFor(h);
  for (const l of res.lines) assert.deepStrictEqual(lintLine(l, allowed), [], l);
  assert.ok(res.lines.length >= 2);
}
assert.ok(res.costUsd < 0.05, `a few lines of text should cost cents at most, this cost $${res.costUsd}`);
console.log("\nALL REAL-MODEL ROAST TESTS PASSED");
