// Controls for the job-redteam suite (bench/suites/job-redteam.mjs). Four things must hold: the real engine scores every row (max); three bad implementations score below max
// (an engine that submits everything, one that refuses everything, and one that gets the statuses right but leaks an application and a ledger row); the status-only judge is shown
// next to the full judge for each of them; and each one-line mutant of dist/ lowers the score. The mutants run the real engine in a copy of the tree (dist/ and package.json; node_modules linked).
import assert from "node:assert";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../bench/lib.mjs";
import { meta, ROWS, run, judge, judgeStatusOnly, scoreWith, exemplarStatus } from "../bench/suites/job-redteam.mjs";

const t0 = Date.now();
const real = await run(ROOT);
assert.strictEqual(real.max, ROWS.length, "the suite's max is not its row count");
assert.strictEqual(real.value, real.max, `the real engine scores ${real.value} of ${real.max}: ${JSON.stringify(real.detail)}`);
assert.strictEqual(meta.id, "job-redteam");
console.log(`[ok] job-redteam: the real engine scores ${real.value} of ${real.max} (${Date.now() - t0} ms, the suite's own run)`);

// The board's listing is the page's state, not the engine's decision: a fake engine is given it as the board serves it (the honeypots are hidden in every case).
const listing = (row) => (row.honeypot ? { offered: false, hiddenNamed: true } : {});
const second = (row, s) => (row.second ? { second: s } : {});
const fakes = {
  "submits everything": (row) => ({ status: "submitted", text: "", scam: false, apps: 1, hp: "", ledger: ["confirmed"], requests: [], ...second(row, { status: "submitted", apps: 2 }), ...listing(row) }),
  "refuses everything (no cause)": (row) => ({ status: "parked", text: "", scam: false, apps: 0, hp: "", ledger: [], requests: [], ...second(row, { status: "parked", apps: 0 }), ...listing(row) }),
  "refuses everything (with the cause copied, an upper bound)": (row) => ({ status: "parked", text: row.cause ? row.cause.source : "", scam: !!row.scam, apps: 0, hp: "", ledger: [], requests: [], ...second(row, { status: "parked", apps: 0 }), ...listing(row) }),
  // the statuses and the causes are right; what is wrong is what reaches the board and the ledger on the rows that must not send
  "right status, leaks an application": (row) => {
    const w = row.want;
    const ex = exemplarStatus(row);
    const leak = ex !== "submitted";
    const apps = (w.apps ?? w.appsMin ?? w.appsMax ?? 0) + (leak ? 1 : 0);
    const ledger = Array.from({ length: w.ledger ?? 0 }, () => w.state ?? "confirmed");
    if (leak && ledger.length === 0) ledger.push("intended");
    return { status: ex, text: row.cause ? row.cause.source : "", scam: !!row.scam, apps, hp: "", ledger, requests: [], ...second(row, { status: row.second?.status ?? "duplicate", apps }), ...listing(row) };
  },
};
const scores = {};
for (const [name, fake] of Object.entries(fakes)) {
  const full = scoreWith(fake, judge);
  const status = scoreWith(fake, judgeStatusOnly);
  scores[name] = { full: full.value, status: status.value };
  console.log(`      ${name.padEnd(62)} full judge ${String(full.value).padStart(2)} / ${full.max}   status-only judge ${String(status.value).padStart(2)} / ${status.max}`);
  assert.ok(full.value < full.max, `${name} scores full marks under the full judge`);
}
assert.ok(scores["submits everything"].full < 0.5 * ROWS.length, "an engine that submits everything scores too well");
assert.ok(scores["refuses everything (no cause)"].full === 0, "a refuser with no cause should score nothing (every row names one)");
assert.ok(scores["refuses everything (with the cause copied, an upper bound)"].full < ROWS.length, "a refuser never scores the controls");
// the status-only judge is blind to the leak: it scores the leaking engine as the real one. That is the reason the full judge exists.
assert.strictEqual(scores["right status, leaks an application"].status, ROWS.length, "control: the status-only judge reads the leaking engine's statuses as right");
assert.ok(scores["right status, leaks an application"].full < ROWS.length, "the full judge does not catch the leak");
console.log(`[ok] three bad implementations score below max under the full judge: submits everything ${scores["submits everything"].full}, refuses everything ${scores["refuses everything (no cause)"].full} (${scores["refuses everything (with the cause copied, an upper bound)"].full} with the cause copied), leaks an application ${scores["right status, leaks an application"].full}; the status-only judge reads the leak as ${scores["right status, leaks an application"].status} of ${ROWS.length}`);

// ---- mutants: one line each, in a copy of the tree. The score must drop, and the rows that fall are printed.
const MUTANTS = [
  ["slowDown: the 520-529 range removed", "job-apply.js", "|| (c >= 520 && c <= 529)", ""],
  ["slowDown(postCode) after a submit off", "job-apply.js", "if (slowDown(postCode)) {", "if (false) {"],
  ["the pre-submit confirmation check removed", "job-apply.js", "!CONFIRMED.test(preText)", "true"],
  ["post-fill re-check (forbidden or attestation text) off", "job-apply.js", "if (forbiddenIn(visible(page)) || attestationIn(visible(page)))", "if (false)"],
  ["label-length guard (>= 190 characters) off", "facts.js", "if (field.label.length >= 190)", "if (false)"],
];
for (const [name, file, needle, repl] of MUTANTS) {
  const m = mkdtempSync(join(tmpdir(), "redteam-mut-"));
  cpSync(join(ROOT, "dist"), join(m, "dist"), { recursive: true });
  copyFileSync(join(ROOT, "package.json"), join(m, "package.json"));
  symlinkSync(join(ROOT, "node_modules"), join(m, "node_modules"));
  const path = join(m, "dist", file);
  const src = readFileSync(path, "utf8");
  const hits = src.split(needle).length - 1;
  assert.strictEqual(hits, 1, `mutant "${name}": the line occurs ${hits} times in dist/${file} (need exactly 1)`);
  writeFileSync(path, src.replace(needle, repl));
  const after = await run(m);
  console.log(`      mutant: ${name.padEnd(56)} before ${real.value} / ${real.max}  after ${after.value} / ${after.max}  (${real.value - after.value} lost: ${after.detail.wrong.join(", ")})`);
  assert.ok(after.value < real.value, `mutant "${name}" did not lower the score (${after.value} of ${after.max})`);
}
console.log(`[ok] ${MUTANTS.length} one-line mutants each lower the score (the real engine is ${real.value} of ${real.max})`);
console.log(`\nJOB REDTEAM CONTROLS PASSED in ${Date.now() - t0} ms`);
process.exit(0);
