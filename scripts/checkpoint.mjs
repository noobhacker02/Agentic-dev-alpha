#!/usr/bin/env node
// Saves everything in one command: for each repo (this one, and the Dev-Skill checkout one level up when that is a different repo), stage all, commit, push the
// current branch. Meant for the moment usage is nearly out or a long run is winding down: `npm run checkpoint -- "why"`.
// It never uses --no-verify and never forces a push: a blocked commit or a rejected push is reported and the exit code is non-zero.
// A checkpoint is not a claim that tests pass; the commit message says so.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findRepos(agentLoopDir) {
  const repos = [{ name: "agent-loop", dir: agentLoopDir }];
  const parent = resolve(agentLoopDir, "..");
  if (existsSync(join(parent, ".git"))) {
    const top = git(parent, ["rev-parse", "--show-toplevel"]).stdout.trim();
    if (top && resolve(top) !== resolve(agentLoopDir)) repos.push({ name: "Dev-Skill", dir: top });
  }
  return repos;
}

/** Returns one result per repo: { name, branch, state, detail } with state one of nothing-to-save, saved, commit-blocked, push-rejected, push-failed, no-branch. */
export async function checkpoint({ repos, reason = "checkpoint", trailer = process.env.CHECKPOINT_TRAILER ?? "Co-Authored-By: Claude <noreply@anthropic.com>", retryDelays = [2000, 4000, 8000, 16000] }) {
  const results = [];
  for (const { name, dir } of repos) {
    const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    if (!branch || branch === "HEAD") { results.push({ name, branch, state: "no-branch", detail: "detached HEAD: nothing is pushed from here" }); continue; }
    const dirty = git(dir, ["status", "--porcelain"]).stdout.trim().length > 0;
    let committed = false;
    if (dirty) {
      git(dir, ["add", "-A"]);
      const msg = `checkpoint: ${reason}\n\nSaved early because usage is nearly out or a long run is winding down. This commit is not a claim that the tests pass; see docs/HANDOFF.md for what is and is not verified.\n\n${trailer}`;
      const c = git(dir, ["commit", "-q", "-m", msg]);
      if (c.status !== 0) { results.push({ name, branch, state: "commit-blocked", detail: (c.stdout + c.stderr).trim().slice(0, 1500) }); continue; }
      committed = true;
    }
    const upstream = git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    const ahead = upstream.status === 0 ? Number(git(dir, ["rev-list", "--count", "@{u}..HEAD"]).stdout.trim() || 0) : 1;
    if (!committed && ahead === 0) { results.push({ name, branch, state: "nothing-to-save", detail: "clean and up to date with the remote" }); continue; }
    let pushed = false, last = "";
    for (let attempt = 0; attempt <= retryDelays.length && !pushed; attempt++) {
      const p = git(dir, ["push", "-u", "origin", branch]);
      last = (p.stdout + p.stderr).trim();
      if (p.status === 0) { pushed = true; break; }
      if (/rejected|non-fast-forward|fetch first/i.test(last)) { results.push({ name, branch, state: "push-rejected", detail: `the remote has commits this branch does not: fetch and merge, never force. ${last.slice(0, 400)}` }); pushed = null; break; }
      if (attempt < retryDelays.length) await sleep(retryDelays[attempt]);
    }
    if (pushed === null) continue;
    results.push(pushed ? { name, branch, state: "saved", detail: `${committed ? "committed and " : ""}pushed ${branch}` } : { name, branch, state: "push-failed", detail: last.slice(0, 600) });
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const reason = process.argv.slice(2).join(" ") || "save before moving on";
  try {
    const out = execFileSync("node", [join(here, "scripts/handoff-check.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (out.trim()) console.log(out.trim());
  } catch (e) { console.log("warning: docs/HANDOFF.md has problems (saving anyway):\n" + String(e.stderr ?? e.message).trim()); }
  const results = await checkpoint({ repos: findRepos(here), reason });
  for (const r of results) console.log(`${r.state === "saved" || r.state === "nothing-to-save" ? "ok  " : "FAIL"} ${r.name} (${r.branch}): ${r.state}: ${r.detail}`);
  const bad = results.filter((r) => !["saved", "nothing-to-save"].includes(r.state));
  if (bad.length) console.log("\nNot everything was saved. For a commit blocked by the scanner: read its message; allow a false positive inline with `// devskill:allow (reason)`. Never --no-verify.");
  process.exit(bad.length ? 1 : 0);
}
