// docs/IMPROVEMENTS.md: every entry has every field, ids are unique and increasing, suites exist, "Measured" has a number or a reason.
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateImprovements, parseEntries } from "../bench/improvements.mjs";
import { planned } from "../bench/planned.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const md = readFileSync(join(root, "docs/IMPROVEMENTS.md"), "utf8");
const built = [];
for (const f of readdirSync(join(root, "bench/suites")).filter((f) => f.endsWith(".mjs"))) built.push((await import(pathToFileURL(join(root, "bench/suites", f)).href)).meta.id);
const knownSuites = [...built, ...planned.map((p) => p.id)];

const problems = validateImprovements(md, { knownSuites });
assert.deepStrictEqual(problems, [], "docs/IMPROVEMENTS.md has problems:\n" + problems.join("\n"));
const entries = parseEntries(md);
assert.ok(entries.length >= 7, `expected at least the 7 seeded entries, found ${entries.length}`);

// Controls: the validator must object to each defect.
const one = entries[0];
const probe = (f) => validateImprovements(f(md), { knownSuites });
assert.ok(probe((s) => s.replace(/(## IMP-001[\s\S]*?)- \*\*Why it matters:\*\*/, "$1- **Why:**")).some((p) => /Why it matters/.test(p)), "missing field not caught");
assert.ok(probe((s) => s.replace("- **Suites:** safety", "- **Suites:** no-such-suite")).some((p) => /unknown benchmark suite/.test(p)), "unknown suite not caught");
assert.ok(probe((s) => s.replace(/- \*\*Measured:\*\* safety suite 3 of 27[^\n]*/, "- **Measured:** it got better")).some((p) => /Measured/.test(p)), "unmeasured entry not caught");
assert.ok(probe((s) => s.replace("## IMP-002", "## IMP-001")).some((p) => /duplicate|increase/.test(p)), "duplicate id not caught");
assert.ok(probe((s) => s.replace("· backfilled · Safety", "· someday · Safety")).some((p) => /date must be/.test(p)), "bad date not caught");
assert.ok(one.fields["Problem"].length > 40);
console.log(`[ok] improvements log: ${entries.length} entries complete; 5 controls caught`);
