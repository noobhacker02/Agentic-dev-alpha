// The table in docs/BENCHMARK.md must be exactly what bench/latest.json + baseline.json + the improvement log produce.
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderTable, START, END, improvementIds } from "../bench/doc.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const latest = JSON.parse(read("bench/latest.json")), baseline = JSON.parse(read("bench/baseline.json"));
const improvementsMd = read("docs/IMPROVEMENTS.md");
const metas = [];
for (const f of readdirSync(join(root, "bench/suites")).filter((f) => f.endsWith(".mjs")).sort()) metas.push((await import(pathToFileURL(join(root, "bench/suites", f)).href)).meta);

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
console.log(`[ok] bench table: matches latest.json/baseline.json for ${metas.length} built suites; change and freshness controls hold`);
