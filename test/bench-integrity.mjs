// Adversary round 1, A13: the benchmark's own integrity. A baseline cannot be lowered without a logged reason, a corrupt baseline file stops the runner instead of being
// silently re-recorded, the change column compares rates when the number of checks changed, and freshness checks fail closed in CI when the commit they name is missing.
import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBaselines } from "../bench/baseline-check.mjs";
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
r = checkBaselines({ root: repo, baseline: base(2), docMd: "| 2026-10-02 | `safety` | Baseline corrected from 5 to 2. | The first scorer was lenient. |" });
assert.deepStrictEqual(r.problems, [], "a logged baseline correction was rejected");
// 5. A changed number of checks counts as changed too.
r = checkBaselines({ root: repo, baseline: base(5, 10), docMd: "" });
assert.ok(r.problems.length === 1, "a changed max went unnoticed");
// 6. No history (shallow or new): a note, not a failure.
r = checkBaselines({ root: mkdtempSync(join(tmpdir(), "no-git-")), baseline: base(5), docMd: "" });
assert.ok(r.problems.length === 0 && r.notes.length > 0, "a missing history should be a note");
console.log("[ok] baselines: unchanged passes; lowered without a logged reason, with a row for another suite, or with a row that never says baseline fails; a logged correction passes; changed max caught");

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
