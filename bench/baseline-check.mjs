// A baseline is the first value ever recorded for a suite. This checks, from git history, that none was changed since without a row in BENCHMARK.md's "Definition changes" table
// that covers THAT change: it names the suite, says "baseline", and names both the old and the new value (adversary round 1, A13: a hand-lowered baseline made the table show a gain
// that never happened; round 2, A35: one row that merely mentioned the suite and the word "baseline" excused every later change to any value). A row covers one change and is used once.
import { execFileSync } from "node:child_process";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** True when the text names this value of this suite, as "5 of 8" or "5/8" (or, for a suite with no maximum, as a number on its own). */
export function mentionsValue(row, value, max) {
  const re = max === null || max === undefined
    ? new RegExp(`(^|[^\\d.])${value}($|[^\\d])`)
    : new RegExp(`(^|[^\\d.])${value}\\s*(of|/)\\s*${max}($|[^\\d])`);
  return re.test(row);
}

/** Returns { problems, notes }. `docMd` is the text of docs/BENCHMARK.md; `baseline` the parsed current baseline.json. */
export function checkBaselines({ root, baseline, docMd, file = "bench/baseline.json" }) {
  const problems = [], notes = [];
  const rows = docMd.split("\n").filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(l));
  const used = new Set();
  let snapshots;
  try {
    const shas = git(root, ["log", "--format=%H", "--reverse", "--", file]).split("\n").filter(Boolean);
    snapshots = [];
    for (const sha of shas) {
      try { snapshots.push(JSON.parse(git(root, ["show", `${sha}:${file}`]))); } catch { /* a commit where the file did not parse: skipped */ }
    }
  } catch {
    notes.push("no git history available: baselines not checked against history");
    return { problems, notes };
  }
  snapshots.push(baseline); // the working copy is the last step of the chain
  for (const [id, now] of Object.entries(baseline.suites ?? {})) {
    const chain = snapshots.map((s) => s.suites?.[id]).filter(Boolean);
    if (chain.length < 2) { notes.push(`${id}: baseline not in this clone's history yet (new, or a shallow clone)`); continue; }
    for (let i = 1; i < chain.length; i++) {
      const was = chain[i - 1], is = chain[i];
      if (was.value === is.value && was.max === is.max) continue;
      const covering = rows.findIndex((r, k) => !used.has(k) && r.includes(`\`${id}\``) && /baseline/i.test(r) && mentionsValue(r, was.value, was.max) && mentionsValue(r, is.value, is.max));
      if (covering >= 0) { used.add(covering); continue; }
      const fmt = (b) => (b.max === null || b.max === undefined ? `${b.value}` : `${b.value}/${b.max}`);
      problems.push(`baseline of ${id} changed from ${fmt(was)} to ${fmt(is)}${is === now ? "" : " in an earlier commit"} with no unused row in "Definition changes" that mentions ${id}, "baseline", and both ${fmt(was).replace("/", " of ")} and ${fmt(is).replace("/", " of ")}`);
    }
  }
  return { problems, notes };
}
