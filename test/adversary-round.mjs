// Threats F4 to F6: adversary rounds are real (reproductions or arguments), numbered without gaps, and every finding is triaged. Controls: each defect is caught.
import assert from "node:assert";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRound, validateRoundNumbers } from "../bench/adversary.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "docs/adversary");
const files = readdirSync(dir).filter((f) => /^round-\d+\.md$/.test(f)).sort();
assert.deepStrictEqual(validateRoundNumbers(files), [], "round files have gaps");
assert.ok(files.length >= 1, "no adversary rounds recorded");
for (const f of files) {
  const triage = join(dir, f.replace(/\.md$/, "-triage.md"));
  const problems = validateRound(readFileSync(join(dir, f), "utf8"), existsSync(triage) ? readFileSync(triage, "utf8") : null);
  assert.deepStrictEqual(problems, [], `${f}:\n${problems.join("\n")}`);
}

// Controls on round 1.
const md = readFileSync(join(dir, "round-01.md"), "utf8");
const tri = readFileSync(join(dir, "round-01-triage.md"), "utf8");
const has = (probs, re) => probs.some((p) => re.test(p));
assert.ok(has(validateRound(md.replace(/^### A7 .*$/m, "### Removed"), tri), /A7.*no section/), "a finding without a section was not caught");
assert.ok(has(validateRound(md, tri.replace(/^\| A12 \|/m, "| X12 |")), /A12: not triaged/), "an untriaged finding was not caught");
assert.ok(has(validateRound(md, tri.replace(/^(\| A5 \|[^|]*\|)\s*SPEC/m, "$1 whatever")), /A5.*disposition/), "a made-up disposition was not accepted as a defect");
assert.ok(has(validateRound(md, null), /no triage file/), "a missing triage file was not caught");
assert.ok(validateRoundNumbers(["round-01.md", "round-03.md"]).length === 1, "a gap in round numbers was not caught");
// A confirmed finding with no reproduction, argument or scenario.
const stripped = md.replace(/(### A14 [^\n]*\n)([\s\S]*?)(?=### A15)/, "$1\n- **Problem:** vague.\n\n");
assert.ok(has(validateRound(stripped, tri), /A14: confirmed but gives no reproduction/), "a confirmed finding with no reproduction was accepted");
// Round 2 (A49): the word is not the thing, the end of the file is an end, and the letter Z is a letter.
const mk = (status, body) => `| A1 | high | ${status} | title |\n<!-- table-end -->\n\n### A1 (high, ${status}) title\n\n${body}`;
const triA1 = "| A1 | high | FIXED | done |\n";
const good = "- **Reproduction (run):** `node repro.mjs` printed the wrong thing, which is the bug.\n";
assert.deepStrictEqual(validateRound(mk("CONFIRMED (run)", good), triA1), [], "control: a finding with a real reproduction, last in the file, is accepted");
assert.ok(has(validateRound(mk("CONFIRMED (run)", "- **Reproduction (run):** none\n"), triA1), /A1: confirmed but gives no reproduction/), "the word Reproduction followed by 'none' was accepted as a reproduction");
assert.ok(has(validateRound(mk("CONFIRMED (run)", "- **Reproduction (run):** I looked at it and it seemed wrong to me in several ways\n"), triA1), /A1: confirmed but gives no reproduction/), "a reproduction with no command, code or output was accepted");
assert.ok(!has(validateRound(mk("CONFIRMED (run)", "- **Reproduction (run):** a Zebra page, then `node repro.mjs` and the Z-index output:\n  ```\n  wrong\n  ```\n"), triA1), /A1/), "a reproduction written after the letter Z was cut off");
assert.ok(!has(validateRound(mk("CONFIRMED (run)", good) + "\n### A2 (low, CONFIRMED) next\n\n- **Reproduction (run):** `x`.\n", triA1), /A1: in the table/), "control: a heading after the finding still ends its section");
assert.ok(!has(validateRound(mk("UNCONFIRMED (needs a Mac)", "- **What blocked confirmation:** no Mac.\n"), triA1), /A1/), "an unconfirmed finding needs no reproduction");
console.log(`[ok] adversary rounds: ${files.length} round(s) numbered without gaps; every finding has a section, a reproduction or argument, and a triage disposition; 12 controls caught`);
