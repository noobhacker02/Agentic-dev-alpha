// Controls for the job-redteam suite (bench/suites/job-redteam.mjs). Four things must hold: the real engine scores every row (max); three bad implementations score below max
// (an engine that submits everything, one that refuses everything, and one that gets the statuses right but leaks an application and a ledger row); the status-only judge is shown
// next to the full judge for each of them; and four one-line mutants of dist/job-apply.js each lower the score. The mutants run the real engine in a copy of the tree.
import assert from "node:assert";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../bench/lib.mjs";
import { meta, ROWS, run, judge, judgeStatusOnly, scoreWith } from "../bench/suites/job-redteam.mjs";

const t0 = Date.now();
const real = await run(ROOT);
assert.strictEqual(real.max, ROWS.length, "the suite's max is not its row count");
assert.strictEqual(real.value, real.max, `the real engine scores ${real.value} of ${real.max}: ${JSON.stringify(real.detail)}`);
assert.strictEqual(meta.id, "job-redteam");
console.log(`[ok] job-redteam: the real engine scores ${real.value} of ${real.max} (${Date.now() - t0} ms, the suite's own run)`);

// The board's listing is the page's state, not the engine's decision: a fake engine is given it as the board serves it (the honeypots are hidden in every case).
const listing = (row) => (row.honeypot ? { offered: false, hiddenNamed: true } : {});
const fakes = {
  "submits everything": (row) => ({ status: "submitted", text: "", scam: false, apps: 1, hp: "", ledger: ["confirmed"], requests: [], ...listing(row) }),
  "refuses everything (no cause)": (row) => ({ status: "parked", text: "", scam: false, apps: 0, hp: "", ledger: [], requests: [], ...listing(row) }),
  "refuses everything (with the cause copied, an upper bound)": (row) => ({ status: "parked", text: row.cause ? row.cause.source : "", scam: !!row.scam, apps: 0, hp: "", ledger: [], requests: [], ...listing(row) }),
  // the statuses and the causes are right; what is wrong is what reaches the board and the ledger on the rows that must not send
  "right status, leaks an application": (row) => {
    const w = row.want;
    const leak = w.status !== "submitted";
    return { status: w.status, text: row.cause ? row.cause.source : "", scam: !!row.scam, apps: w.apps + (leak ? 1 : 0), hp: "", ledger: leak ? ["intended"] : Array.from({ length: w.ledger }, () => "confirmed"), requests: [], ...listing(row) };
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

// ---- mutants: one line each, in a copy of the tree (dist/ and package.json; node_modules linked). The score must drop, and the rows that fall are printed.
const MUTANTS = [
  ["attestation check off", "if (attestationIn(visible(page)) || attestationIn(full))", "if (false)"],
  ["frame-button check off", "if (submits.some((e) => e.frame !== undefined))", "if (false)"],
  ["pause on a 'go away' status off (first occurrence, in applyToJob)", "if (slowDown(code)) {", "if (false) {"],
  ["intent taken back off (a park after the fill keeps its row)", "d.ledger.retract(intent.seq);", "void 0;"],
];
const before = real;
for (const [name, needle, repl] of MUTANTS) {
  const m = mkdtempSync(join(tmpdir(), "redteam-mut-"));
  cpSync(join(ROOT, "dist"), join(m, "dist"), { recursive: true });
  copyFileSync(join(ROOT, "package.json"), join(m, "package.json"));
  symlinkSync(join(ROOT, "node_modules"), join(m, "node_modules"));
  const file = join(m, "dist", "job-apply.js");
  const src = readFileSync(file, "utf8");
  const hits = src.split(needle).length - 1;
  assert.ok(hits >= 1, `mutant "${name}": the line is not in dist/job-apply.js`);
  if (!name.includes("first occurrence")) assert.strictEqual(hits, 1, `mutant "${name}": the line is not unique (${hits})`);
  writeFileSync(file, src.replace(needle, repl));
  const after = await run(m);
  console.log(`      mutant: ${name.padEnd(64)} before ${before.value} / ${before.max}  after ${after.value} / ${after.max}  (${before.value - after.value} lost)`);
  assert.ok(after.value < before.value, `mutant "${name}" did not lower the score (${after.value} of ${after.max})`);
}
console.log(`[ok] four one-line mutants of dist/job-apply.js each lower the score (the real engine is ${before.value} of ${before.max})`);
console.log(`\nJOB REDTEAM CONTROLS PASSED in ${Date.now() - t0} ms`);
process.exit(0);
