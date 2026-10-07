// A team step's verdict may carry a `report`: the document its role produced (a plan, a test design, findings, a review). Read-only roles write no files, so the pipeline saves the report for the steps after it, and
// that means the report is text from a model: cleaned, capped, and only accepted for team steps. The five built-in phases keep their own verdict shape (they write their documents themselves). The verdict parser is
// otherwise unchanged, and a team planner may suggest skipping steps by role id (the pipeline decides; see the engine).
//   npm run build && npm run test:team-verdict
import assert from "node:assert";
import { parseVerdict } from "../dist/phases.js";

const block = (o) => "done\n```json\n" + JSON.stringify(o) + "\n```";
const base = { completed: true, outcome: "pass", headline: "ok", details: "d", concerns: [], blockingFindings: [] };

// 1. A team step's report is kept, cleaned and cut
{
  const v = parseVerdict(block({ ...base, report: "# Plan\n\n1. do it\n\tindented\n" }), "planner", { team: true });
  assert.strictEqual(v.report, "# Plan\n\n1. do it\n\tindented", "the report was changed beyond trimming");
  const dirty = parseVerdict(block({ ...base, report: "ok\u001b[2J\u0007 text\r\nline two\u0000end" }), "planner", { team: true });
  assert.strictEqual(dirty.report, "ok[2J text\nline two" + "end", `control bytes were kept: ${JSON.stringify(dirty.report)}`);
  const long = parseVerdict(block({ ...base, report: "x".repeat(50_000) }), "planner", { team: true });
  assert.strictEqual(long.report.length, 20_000, `the report was not cut: ${long.report.length}`);
  for (const bad of [42, null, ["a"], { a: 1 }, true]) assert.strictEqual(parseVerdict(block({ ...base, report: bad }), "planner", { team: true }).report, undefined, `a report that is not text was kept: ${JSON.stringify(bad)}`);
  assert.strictEqual(parseVerdict(block({ ...base, report: "   \n  " }), "planner", { team: true }).report, undefined, "an empty report was kept");
  console.log("[ok] a team step's report is kept as text, cleaned of control bytes, cut at 20,000 characters, and dropped when it is not text or is empty");
}

// 2. The built-in phases do not take a report (they write their own files), and their verdicts are as before
{
  const v = parseVerdict(block({ ...base, report: "# not for you" }), "builder");
  assert.strictEqual(v.report, undefined, "a built-in phase's verdict carried a report");
  assert.deepStrictEqual(v, { completed: true, outcome: "pass", headline: "ok", details: "d", concerns: [], blockingFindings: [] });
  const skip = parseVerdict(block({ ...base, suggestedSkip: ["test-designer", "builder", "researcher"] }), "planner");
  assert.deepStrictEqual(skip.suggestedSkip, ["test-designer"], "the built-in skip list is the allow-list as before");
  console.log("[ok] a built-in phase's verdict is unchanged: no report, and a skip suggestion is filtered by the allow-list");
}

// 3. A team planner names the steps to skip by role id: ids only, a bounded number, nothing else
{
  const v = parseVerdict(block({ ...base, suggestedSkip: ["test-designer", "a11y-reviewer", "Bad Id", 7, "x".repeat(60), "a1", "../etc", "docs-writer", "researcher", "advisor", "perf-reviewer", "ui-tester", "adversary", "security-reviewer"] }), "planner", { team: true });
  assert.deepStrictEqual(v.suggestedSkip, ["test-designer", "a11y-reviewer", "a1", "docs-writer", "researcher", "advisor", "perf-reviewer", "ui-tester"], `a team planner's skip suggestion: ${JSON.stringify(v.suggestedSkip)}`);
  const nested = parseVerdict(block({ ...base, suggestedSkip: [["nested"], { a: 1 }, null, "test-designer"] }), "planner", { team: true });
  assert.deepStrictEqual(nested.suggestedSkip, ["test-designer"], `a value that is not a string was taken as a role id: ${JSON.stringify(nested.suggestedSkip)}`);
  assert.strictEqual(parseVerdict(block({ ...base, suggestedSkip: "test-designer" }), "planner", { team: true }).suggestedSkip, undefined, "a skip suggestion that is not a list was kept");
  console.log("[ok] a team planner's skip suggestion is a short list of role ids; anything else is dropped (the engine decides what may be skipped)");
}

// 4. The rest of the parser: an invalid block is still inconclusive, with the phase named
{
  for (const text of ["no block at all", "```json\n{not json}\n```", block({ completed: "yes", outcome: "pass", headline: "x" }), block({ ...base, outcome: "great" })]) {
    const v = parseVerdict(text, "s3", { team: true });
    assert.strictEqual(v.outcome, "inconclusive");
    assert.strictEqual(v.completed, false);
    assert.ok(/s3 did not return a valid verdict block/.test(v.headline) && v.report === undefined);
  }
  console.log("[ok] a message with no valid verdict block is inconclusive, with no report");
}
console.log("\nALL TEAM VERDICT TESTS PASSED");
