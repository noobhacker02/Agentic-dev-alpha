// docs/HANDOFF.md must stay current: required sections, an Updated stamp, a covered commit no more than 8 behind HEAD.
// Controls: each way of going stale must be caught by the checker, or the check proves nothing.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHandoff, gitBehind, MAX_BEHIND, REQUIRED_SECTIONS } from "../scripts/handoff-check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const md = readFileSync(join(root, "docs/HANDOFF.md"), "utf8");

// 1. The real file passes.
const real = checkHandoff(md, { behind: gitBehind(root) });
for (const n of real.notes) console.log("[note]", n);
assert.deepStrictEqual(real.problems, [], "docs/HANDOFF.md has problems:\n" + real.problems.join("\n"));

// 2. Controls: the checker catches each failure on a copy of the real file.
const fresh = () => 0;
const mut = (f) => checkHandoff(f(md), { behind: fresh }).problems;
assert.ok(mut((s) => s.replace("## Next step", "## Whatever")).some((p) => /Next step/.test(p)), "missing section not caught");
assert.ok(mut((s) => s.replace(/^Updated:.*$/m, "Updated: yesterday-ish")).some((p) => /Updated/.test(p)), "bad Updated stamp not caught");
assert.ok(mut((s) => s.replace(/^Updated:.*$/m, "Updated: 2999-01-01T00:00:00Z")).some((p) => /future/.test(p)), "future stamp not caught");
assert.ok(mut((s) => s.replace(/^Covers agent-loop commit:.*$/m, "")).some((p) => /agent-loop commit/.test(p)), "missing covered commit not caught");
assert.ok(checkHandoff(md, { behind: () => MAX_BEHIND + 1 }).problems.some((p) => /behind HEAD/.test(p)), "stale commit not caught");
assert.strictEqual(checkHandoff(md, { behind: () => MAX_BEHIND }).problems.length, 0, "exactly at the limit should pass");
assert.ok(mut((s) => s.replace(/(## How to resume\s*\n)[\s\S]*$/, "$1stub\n")).some((p) => /stub/.test(p)), "stub section not caught");
assert.strictEqual(REQUIRED_SECTIONS.length, 10);
console.log(`[ok] handoff: ${REQUIRED_SECTIONS.length} sections present, freshness enforced (limit ${MAX_BEHIND} commits), 7 controls caught`);
