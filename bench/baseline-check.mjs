// A baseline is the first value ever recorded for a suite. This checks, from git history, that none was changed since without a row in BENCHMARK.md's
// "Definition changes" table that mentions that suite and says "baseline" (adversary round 1, A13: a hand-lowered baseline made the table show a gain that never happened).
import { execFileSync } from "node:child_process";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** Returns { problems, notes }. `docMd` is the text of docs/BENCHMARK.md; `baseline` the parsed current baseline.json. */
export function checkBaselines({ root, baseline, docMd, file = "bench/baseline.json" }) {
  const problems = [], notes = [];
  const rows = docMd.split("\n").filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(l));
  for (const [id, now] of Object.entries(baseline.suites ?? {})) {
    let first;
    try { first = git(root, ["log", "--format=%H", "--reverse", `-S"${id}": {`, "--", file]).split("\n").filter(Boolean)[0]; }
    catch { notes.push(`no git history available: baseline of ${id} not checked against history`); continue; }
    if (!first) { notes.push(`${id}: baseline not in this clone's history yet (new, or a shallow clone)`); continue; }
    let then;
    try { then = JSON.parse(git(root, ["show", `${first}:${file}`])).suites?.[id]; } catch { notes.push(`${id}: could not read the first committed baseline`); continue; }
    if (!then) continue;
    if (then.value !== now.value || then.max !== now.max) {
      const justified = rows.some((r) => r.includes(`\`${id}\``) && /baseline/i.test(r));
      if (!justified) problems.push(`baseline of ${id} was ${then.value}/${then.max} when first committed and is ${now.value}/${now.max} now, with no row in "Definition changes" that mentions ${id} and "baseline"`);
    }
  }
  return { problems, notes };
}
