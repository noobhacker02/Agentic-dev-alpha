// The table in docs/BENCHMARK.md must be exactly what bench/latest.json + baseline.json + the improvement log produce.
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderTable, START, END, improvementIds } from "../bench/doc.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n"); // a checkout with CRLF endings (autocrlf) must not change what is compared
const latest = JSON.parse(read("bench/latest.json")), baseline = JSON.parse(read("bench/baseline.json"));
const improvementsMd = read("docs/IMPROVEMENTS.md");
const metas = [], modules = [];
for (const f of readdirSync(join(root, "bench/suites")).filter((f) => f.endsWith(".mjs")).sort()) { const m = await import(pathToFileURL(join(root, "bench/suites", f)).href); modules.push(m); metas.push(m.meta); }

const doc = read("docs/BENCHMARK.md");
const a = doc.indexOf(START), b = doc.indexOf(END);
assert.ok(a >= 0 && b > a, "docs/BENCHMARK.md lost its table markers");
const committed = doc.slice(a, b + END.length);
const expected = renderTable({ latest, baseline, metas, improvementsMd });
assert.strictEqual(committed, expected, "docs/BENCHMARK.md table is out of date: run `npm run bench -- --write-doc`");

// Every built suite has a baseline and a latest value.
for (const m of metas) { assert.ok(baseline.suites[m.id], `no baseline for ${m.id}`); assert.ok(latest.suites[m.id], `no latest value for ${m.id}`); }

// Controls: the comparison notices a changed number, and links come from the log.
const bumped = JSON.parse(JSON.stringify(latest)); bumped.suites[metas[0].id].value += 1;
assert.notStrictEqual(renderTable({ latest: bumped, baseline, metas, improvementsMd }), committed, "table ignores a changed number");
assert.deepStrictEqual(improvementIds(improvementsMd, "safety"), ["IMP-001", "IMP-006"].filter((i) => improvementIds(improvementsMd, "safety").includes(i)));
assert.ok(improvementIds(improvementsMd, "safety").includes("IMP-001"), "IMP-001 should be linked to safety");

// Freshness: the numbers were produced no more than 25 commits ago (skipped when the commit is not in this clone).
try {
  execFileSync("git", ["cat-file", "-e", `${latest.commit}^{commit}`], { cwd: root, stdio: "ignore" });
  const n = Number(execFileSync("git", ["rev-list", "--count", `${latest.commit}..HEAD`], { cwd: root, encoding: "utf8" }).trim());
  assert.ok(n <= 25, `bench/latest.json is ${n} commits old: run \`npm run bench -- --write-doc\``);
} catch (e) {
  if (e.code === "ERR_ASSERTION") throw e;
  assert.ok(!process.env.CI, `bench/latest.json names commit ${latest.commit}, which is not in this clone: stale or wrong (CI fails closed; a local run only notes it)`);
  console.log("[note] bench freshness not checked (commit not in this clone; CI=1 would fail)");
}

// Baselines may not change without a logged reason (adversary A13).
{
  const { checkBaselines } = await import("../bench/baseline-check.mjs");
  const res = checkBaselines({ root, baseline, docMd: doc });
  for (const n of res.notes) console.log("[note]", n);
  assert.deepStrictEqual(res.problems, [], "a baseline was changed without a logged reason:\n" + res.problems.join("\n"));
}

// The numbers are measured again, here, on this checkout (adversary round 2, A48): until now the table, its test and CI compared a document with a file the last person to run the benchmark
// wrote, so a change that lowered a score left everything green for up to 25 commits. A suite that is not at the value in latest.json fails this test with the names of the checks it lost.
// A suite that scores full marks must keep scoring full marks; a suite may say its number of checks differs on a platform (`maxVariesOn`: shell-readonly drops the rows that need a symlink on Windows).
const drift = (meta, was, measured, platform = process.platform) => {
  if (measured.value === was.value && measured.max === was.max) return null;
  if (meta.maxVariesOn === platform && was.value === was.max && measured.value === measured.max) return null;
  return `${meta.id}: latest.json says ${was.value}/${was.max} and this checkout measures ${measured.value}/${measured.max}${measured.detail ? ` ${JSON.stringify(measured.detail).slice(0, 300)}` : ""}`;
};
{
  const problems = [];
  for (const m of modules) {
    const was = latest.suites[m.meta.id];
    const measured = await m.run();
    const d = drift(m.meta, was, measured);
    if (d) problems.push(d);
  }
  assert.deepStrictEqual(problems, [], "benchmark numbers differ from what the code measures now (a regression, or latest.json is stale: run `npm run bench -- --write-doc`):\n" + problems.join("\n"));
  // the comparison has teeth: one point lower, one point higher, a different number of checks, and a platform allowance that only applies where it says it does
  const meta = { id: "x" }, was = { value: 8, max: 8 };
  assert.ok(drift(meta, was, { value: 7, max: 8 }), "a lost point went unnoticed");
  assert.ok(drift(meta, was, { value: 9, max: 8 }) && drift(meta, { value: 5, max: 8 }, { value: 6, max: 8 }), "a gained point went unnoticed (latest.json is stale)");
  assert.ok(drift(meta, was, { value: 9, max: 9 }), "a changed number of checks with full marks went unnoticed");
  assert.strictEqual(drift(meta, was, { value: 8, max: 8 }), null, "control: the same score was flagged");
  assert.ok(drift({ id: "s", maxVariesOn: "win32" }, was, { value: 7, max: 7 }, "linux") && drift({ id: "s", maxVariesOn: "win32" }, { value: 5, max: 8 }, { value: 5, max: 7 }, "win32"), "the platform allowance applies where it should not");
  assert.strictEqual(drift({ id: "s", maxVariesOn: "win32" }, was, { value: 7, max: 7 }, "win32"), null, "the platform allowance does not apply on its own platform");
  console.log(`[ok] bench numbers re-measured on this checkout: ${modules.length} suites match latest.json; a lost or gained point, a changed number of checks and a misapplied platform allowance are caught`);
}
console.log(`[ok] bench table: matches latest.json/baseline.json for ${metas.length} built suites; change and freshness controls hold`);
