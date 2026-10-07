// Adversary round 1, A13: the benchmark's own integrity. A baseline cannot be lowered without a logged reason, a corrupt baseline file stops the runner instead of being
// silently re-recorded, the change column compares rates when the number of checks changed, and freshness checks fail closed in CI when the commit they name is missing.
import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBaselines, mentionsValue } from "../bench/baseline-check.mjs";
import { renderTable } from "../bench/doc.mjs";
import { checkHandoff } from "../scripts/handoff-check.mjs";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const repo = mkdtempSync(join(tmpdir(), "bench-int-"));
git(repo, "init", "-q"); git(repo, "config", "user.email", "t@example.com"); git(repo, "config", "user.name", "t");
mkdirSync(join(repo, "bench"));
const base = (v, max = 8) => ({ suites: { safety: { value: v, max, commit: "abc1234", date: "2026-10-02" } } });
writeFileSync(join(repo, "bench/baseline.json"), JSON.stringify(base(5), null, 2));
git(repo, "add", "-A"); git(repo, "commit", "-qm", "first baseline");

// 1. Unchanged: fine. (control)
let r = checkBaselines({ root: repo, baseline: base(5), docMd: "" });
assert.deepStrictEqual(r.problems, [], "control: an unchanged baseline was reported");
// 2. Hand-lowered with no logged reason: caught.
r = checkBaselines({ root: repo, baseline: base(2), docMd: "| 2026-10-02 | `observability` | Something | else |" });
assert.ok(r.problems.some((p) => /safety.*5\/8.*2\/8/.test(p)), `a lowered baseline was not caught: ${JSON.stringify(r)}`);
// 3. A row for a different suite does not excuse it; a row for this suite that does not say baseline does not either.
r = checkBaselines({ root: repo, baseline: base(2), docMd: "| 2026-10-02 | `observability` | Baseline corrected | x |\n| 2026-10-02 | `safety` | Denominator changed | x |" });
assert.ok(r.problems.length === 1, "a row that does not say baseline for this suite excused a changed baseline");
// 4. A real, logged reason passes.
r = checkBaselines({ root: repo, baseline: base(2), docMd: "| 2026-10-02 | `safety` | Baseline corrected from 5 of 8 to 2 of 8. | The first scorer was lenient. |" });
assert.deepStrictEqual(r.problems, [], "a logged baseline correction was rejected");
assert.deepStrictEqual(checkBaselines({ root: repo, baseline: base(2), docMd: "| 2026-10-02 | `safety` | Baseline corrected from 5/8 to 2/8. | x |" }).problems, [], "the 5/8 spelling of the values was rejected");
// 5. A changed number of checks counts as changed too.
r = checkBaselines({ root: repo, baseline: base(5, 10), docMd: "" });
assert.ok(r.problems.length === 1, "a changed max went unnoticed");
// 6. No history (shallow or new): a note, not a failure.
r = checkBaselines({ root: mkdtempSync(join(tmpdir(), "no-git-")), baseline: base(5), docMd: "" });
assert.ok(r.problems.length === 0 && r.notes.length > 0, "a missing history should be a note");
console.log("[ok] baselines: unchanged passes; lowered without a logged reason, with a row for another suite, or with a row that never says baseline fails; a logged correction passes; changed max caught");

// 6b. A35: a row covers ONE change, the one whose old and new values it names, and is used once. (Before: any row that mentioned the suite and the word "baseline" excused every later change to any value.)
{
  // a row about this suite's baseline for other numbers does not excuse this change (the reproduction: observability's "1 of 8 to 0 of 8" rows excused 0 -> 3 and 0 -> 8)
  const other = "| 2026-10-02 | `safety` | Baseline corrected from 1 of 8 to 0 of 8. | The first scorer was lenient. |";
  for (const v of [0, 3, 8]) assert.strictEqual(checkBaselines({ root: repo, baseline: base(v), docMd: other }).problems.length, 1, `a row for other numbers excused 5 -> ${v}`);
  // it must name the new value as well as the old, and the old as well as the new
  assert.strictEqual(checkBaselines({ root: repo, baseline: base(2), docMd: "| 2026-10-02 | `safety` | Baseline corrected from 5 of 8. | x |" }).problems.length, 1, "a row that names only the old value excused the change");
  assert.strictEqual(checkBaselines({ root: repo, baseline: base(2), docMd: "| 2026-10-02 | `safety` | Baseline corrected to 2 of 8. | x |" }).problems.length, 1, "a row that names only the new value excused the change");
  // the right numbers in a row for another suite, or in a row that never says baseline, excuse nothing either (these rows name 5 of 8 and 2 of 8)
  assert.strictEqual(checkBaselines({ root: repo, baseline: base(2), docMd: "| 2026-10-02 | `observability` | Baseline corrected from 5 of 8 to 2 of 8. | x |" }).problems.length, 1, "a row for another suite with the right numbers excused the change");
  assert.strictEqual(checkBaselines({ root: repo, baseline: base(2), docMd: "| 2026-10-02 | `safety` | Denominator corrected from 5 of 8 to 2 of 8. | x |" }).problems.length, 1, "a row that never says baseline excused the change");
  // a second change in the history needs a second row
  writeFileSync(join(repo, "bench/baseline.json"), JSON.stringify(base(2), null, 2));
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "baseline 5 -> 2");
  const first = "| 2026-10-02 | `safety` | Baseline corrected from 5 of 8 to 2 of 8. | x |";
  const second = "| 2026-10-04 | `safety` | Baseline corrected from 2 of 8 to 3 of 8. | x |";
  assert.deepStrictEqual(checkBaselines({ root: repo, baseline: base(2), docMd: first }).problems, [], "control: the committed 5 -> 2 change with its row");
  r = checkBaselines({ root: repo, baseline: base(3), docMd: first });
  assert.ok(r.problems.length === 1 && /2\/8 to 3\/8/.test(r.problems[0]), `one row covered two changes: ${JSON.stringify(r)}`);
  assert.deepStrictEqual(checkBaselines({ root: repo, baseline: base(3), docMd: `${first}\n${second}` }).problems, [], "both changes have rows and were rejected");
  // one row cannot cover a change and its reverse (5 -> 2, then 2 -> 5 name the same two values): the second use needs its own row
  writeFileSync(join(repo, "bench/baseline.json"), JSON.stringify(base(5), null, 2));
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "baseline 2 -> 5");
  r = checkBaselines({ root: repo, baseline: base(5), docMd: first });
  assert.ok(r.problems.length === 1 && /2\/8 to 5\/8/.test(r.problems[0]), `one row covered a change and its reverse: ${JSON.stringify(r)}`);
  assert.deepStrictEqual(checkBaselines({ root: repo, baseline: base(5), docMd: `${first}\n| 2026-10-05 | \`safety\` | Baseline restored from 2 of 8 to 5 of 8. | x |` }).problems, [], "a change and its reverse, each with its own row, were rejected");
  writeFileSync(join(repo, "bench/baseline.json"), JSON.stringify(base(2), null, 2));
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "baseline back to 2 for the checks below");
  // the committed history is checked, not only the working copy: the 5 -> 2 commit with no row is reported even when the file is unchanged since
  r = checkBaselines({ root: repo, baseline: base(2), docMd: "" });
  assert.ok(r.problems.length === 3 && r.problems.every((x) => /in an earlier commit/.test(x)) && /5\/8 to 2\/8/.test(r.problems[0]), `past changes with no row went unnoticed (three changes in the history, none of them in the working copy): ${JSON.stringify(r)}`);
  // a suite with no maximum names plain numbers
  assert.ok(mentionsValue("| x | baseline 20 to 1 |", 20, null) && mentionsValue("| x | baseline 20 to 1 |", 1, null) && !mentionsValue("| x | baseline 120 to 11 |", 20, null) && !mentionsValue("| x | 1.5 |", 5, null), "plain-number matching is loose");
  assert.ok(mentionsValue("1 of 8", 1, 8) && mentionsValue("1/8", 1, 8) && !mentionsValue("11 of 8", 1, 8) && !mentionsValue("1 of 80", 1, 8) && !mentionsValue("1 of 10", 1, 8), "value matching is loose");
  console.log("[ok] baselines (A35): a row for other numbers, or naming only one side, excuses nothing; one row covers one change; a past change with no row is reported even when the file has not changed since");
}

// 7. The runner refuses to continue over a corrupt baseline file and leaves it exactly as it found it.
{
  const copy = mkdtempSync(join(tmpdir(), "bench-run-"));
  cpSync(join(here, "bench"), join(copy, "bench"), { recursive: true });
  mkdirSync(join(copy, "dist")); writeFileSync(join(copy, "dist/browser-tools.js"), "export {};");
  const corrupt = '{ "suites": { "safety": ';
  writeFileSync(join(copy, "bench/baseline.json"), corrupt);
  const run = spawnSync("node", ["bench/run.mjs", "safety"], { cwd: copy, encoding: "utf8" });
  assert.strictEqual(run.status, 2, `the runner continued over a corrupt baseline (exit ${run.status}): ${run.stdout}${run.stderr}`);
  assert.ok(/not valid JSON/.test(run.stderr), "the refusal does not say why");
  assert.strictEqual(readFileSync(join(copy, "bench/baseline.json"), "utf8"), corrupt, "the runner rewrote a corrupt baseline file");
  console.log("[ok] a corrupt baseline file stops the runner (exit 2) and is left untouched");
}

// 8. The change column compares pass rates when the number of checks changed.
{
  const metas = [{ id: "s", title: "t", unit: "x", higherIsBetter: true }];
  const mk = (b, n) => renderTable({ latest: { suites: { s: n }, commit: "c", date: "d" }, baseline: { suites: { s: b } }, metas, improvementsMd: "" });
  assert.ok(/-5 points \(worse; 8 -> 10 checks\)/.test(mk({ value: 6, max: 8, commit: "x" }, { value: 7, max: 10 })), "6/8 -> 7/10 was not shown as worse in points");
  assert.ok(/\| \+1 \(better\) \|/.test(mk({ value: 6, max: 8, commit: "x" }, { value: 7, max: 8 })), "control: same max should still show the plain count");
  console.log("[ok] change column: 6/8 -> 7/10 reads -5 points (worse), not +1 (better)");
}

// 9. Freshness fails closed in CI when the commit a document names is not in the clone, and is only a note elsewhere.
{
  const md = readFileSync(join(here, "docs/HANDOFF.md"), "utf8").replace(/^Covers agent-loop commit:.*$/m, "Covers agent-loop commit: deadbeef");
  const unknown = { behind: () => null };
  const local = checkHandoff(md, { ...unknown, ci: false });
  assert.ok(local.problems.length === 0 && local.notes.length > 0, "outside CI an unknown commit should be a note");
  const ci = checkHandoff(md, { ...unknown, ci: true });
  assert.ok(ci.problems.some((p) => /deadbeef/.test(p) && /not in this clone/.test(p)), `in CI an unknown commit must fail: ${JSON.stringify(ci)}`);
  console.log("[ok] freshness: an unknown commit is a note locally and a failure in CI");
}
console.log("\nALL BENCH INTEGRITY TESTS PASSED");
