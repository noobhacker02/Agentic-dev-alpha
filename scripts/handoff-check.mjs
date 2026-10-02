#!/usr/bin/env node
// Checks docs/HANDOFF.md: required sections present, a parseable "Updated:" stamp, and the commit it covers is at most MAX_BEHIND
// commits behind HEAD. Used by test/handoff.mjs and runnable by hand: `node scripts/handoff-check.mjs`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_BEHIND = 8;
export const REQUIRED_SECTIONS = [
  "Standing instructions",
  "What the user asked, in their words",
  "Decisions made",
  "Where everything is",
  "Stage status",
  "Next step",
  "Verified and not verified",
  "Improvement backlog",
  "Gotchas learned",
  "How to resume",
];

/** behind(hash) returns the number of commits HEAD is ahead of `hash`, or null when it cannot tell (hash unknown, no git). */
export function checkHandoff(md, { behind = () => null, now = Date.now(), ci = Boolean(process.env.CI) } = {}) {
  const problems = [], notes = [];
  for (const s of REQUIRED_SECTIONS) {
    const m = md.match(new RegExp(`^## ${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m"));
    if (!m) { problems.push(`missing section "## ${s}"`); continue; }
    const start = m.index + m[0].length;
    const next = md.indexOf("\n## ", start);
    const body = md.slice(start, next < 0 ? undefined : next).trim();
    if (body.length < 40) problems.push(`section "${s}" is empty or a stub`);
  }
  const stamp = md.match(/^Updated:\s*(\S+)\s*$/m)?.[1];
  if (!stamp || Number.isNaN(Date.parse(stamp))) problems.push('no parseable "Updated: <ISO time>" line');
  else if (Date.parse(stamp) > now + 5 * 60_000) problems.push(`"Updated:" is in the future (${stamp})`);
  const hash = md.match(/^Covers agent-loop commit:\s*([0-9a-f]{7,40})\s*$/m)?.[1];
  if (!hash) problems.push('no "Covers agent-loop commit: <hash>" line');
  else {
    const n = behind(hash);
    if (n === null) {
      // Failing open here is when it matters most: a made-up hash, or a document more commits behind than the clone holds, would pass. In CI that is a failure.
      const msg = `${hash} is not in this clone, so how far behind it is cannot be measured`;
      if (ci) problems.push(`${msg} (CI fetches enough history for a current handoff; a hash that is not there is stale or wrong)`);
      else notes.push(`${msg}; freshness not checked (set CI=1 to make this a failure)`);
    }
    else if (n > MAX_BEHIND) problems.push(`HANDOFF.md covers ${hash}, which is ${n} commits behind HEAD (limit ${MAX_BEHIND}): update it`);
  }
  if (!/^Covers Dev-Skill commit:\s*[0-9a-f]{7,40}\s*$/m.test(md)) problems.push('no "Covers Dev-Skill commit: <hash>" line');
  return { problems, notes };
}

export function gitBehind(cwd) {
  return (hash) => {
    try {
      execFileSync("git", ["cat-file", "-e", `${hash}^{commit}`], { cwd, stdio: "ignore" });
      return Number(execFileSync("git", ["rev-list", "--count", `${hash}..HEAD`], { cwd, encoding: "utf8" }).trim());
    } catch { return null; }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { problems, notes } = checkHandoff(readFileSync(join(root, "docs/HANDOFF.md"), "utf8"), { behind: gitBehind(root) });
  for (const n of notes) console.log("note:", n);
  for (const p of problems) console.error("problem:", p);
  process.exit(problems.length ? 1 : 0);
}
