#!/usr/bin/env node
// Benchmark runner. Deterministic suites only unless --real is passed.
//   node bench/run.mjs                 run every built suite, write bench/latest.json and bench/results/<date>-<commit>.json
//   node bench/run.mjs observability   run one suite
//   node bench/run.mjs --write-doc     also regenerate the table in docs/BENCHMARK.md
// A suite with no baseline yet gets one (first recorded value). A baseline is never overwritten here.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BENCH_DIR, ROOT, gitShort, readJsonStrict, writeJson, exists } from "./lib.mjs";
import { renderTable, START, END } from "./doc.mjs";

const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith("--"));
const writeDoc = args.includes("--write-doc");

if (!exists(join(ROOT, "dist/browser-tools.js"))) { console.error("dist/ is missing: run `npm run build` first."); process.exit(2); }

const files = readdirSync(join(BENCH_DIR, "suites")).filter((f) => f.endsWith(".mjs")).sort();
const modules = [];
for (const f of files) modules.push(await import(pathToFileURL(join(BENCH_DIR, "suites", f)).href));
const metas = modules.map((m) => m.meta);

const latestPath = join(BENCH_DIR, "latest.json");
const basePath = join(BENCH_DIR, "baseline.json");
let latest, baseline;
try {
  latest = readJsonStrict(latestPath, { suites: {} });
  baseline = readJsonStrict(basePath, { suites: {} });
} catch (e) { console.error(e.message); process.exit(2); }
const commit = gitShort();
const date = new Date().toISOString().slice(0, 10);

for (const m of modules) {
  if (only.length && !only.includes(m.meta.id)) continue;
  const t0 = Date.now();
  const r = await m.run();
  latest.suites[m.meta.id] = { value: r.value, max: r.max, detail: r.detail, ms: Date.now() - t0 };
  console.log(`${m.meta.id.padEnd(16)} ${r.value}/${r.max}  (${Date.now() - t0} ms)  ${JSON.stringify(r.detail)}`);
  if (!baseline.suites[m.meta.id]) {
    baseline.suites[m.meta.id] = { value: r.value, max: r.max, commit, date };
    console.log(`  baseline recorded for ${m.meta.id}: ${r.value}/${r.max} @ ${commit}`);
  }
}
latest.commit = commit; latest.date = date;
writeJson(latestPath, latest);
writeJson(basePath, baseline);
writeJson(join(BENCH_DIR, "results", `${date}-${commit}.json`), latest);

if (writeDoc) {
  const docPath = join(ROOT, "docs/BENCHMARK.md");
  const improvementsMd = exists(join(ROOT, "docs/IMPROVEMENTS.md")) ? readFileSync(join(ROOT, "docs/IMPROVEMENTS.md"), "utf8") : "";
  const doc = readFileSync(docPath, "utf8");
  const table = renderTable({ latest, baseline, metas, improvementsMd });
  const a = doc.indexOf(START), b = doc.indexOf(END);
  if (a < 0 || b < 0) { console.error("docs/BENCHMARK.md has no table markers"); process.exit(2); }
  writeFileSync(docPath, doc.slice(0, a) + table + doc.slice(b + END.length));
  console.log("docs/BENCHMARK.md table regenerated");
}
process.exit(0);
