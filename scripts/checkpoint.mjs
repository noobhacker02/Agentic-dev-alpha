#!/usr/bin/env node
// Saves everything in one command: for each repo (this one, and the Dev-Skill checkout one level up when that is a different repo), stage all, commit, push the
// current branch. Meant for the moment usage is nearly out or a long run is winding down: `npm run checkpoint -- "why"`.
// It never uses --no-verify and never forces a push: a blocked commit or a rejected push is reported and the exit code is non-zero.
// It also does not trust a hook to be installed (adversary round 2, A32): after staging it runs the repository's own scanner (.githooks/check_staged.py) itself and refuses to commit when the
// scanner is missing or blocks; it pushes only the designated branch of each repository and only to the expected origin (A33).
// A checkpoint is not a claim that tests pass; the commit message says so.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The branch each repository is allowed to push from this command, and the origin it must have (A33). `--allow-branch <name>=<branch>` on the command line overrides a branch. */
const DESIGNATED = {
  "agent-loop": { designated: "main", origin: /noobhacker02\/agentic-dev-alpha(\.git)?$/i },
  "Dev-Skill": { designated: "claude/dev-workflow-process-v4kafr", origin: /noobhacker02\/dev-skill(\.git)?$/i },
};

export function findRepos(agentLoopDir, overrides = {}) {
  const make = (name, dir) => ({ name, dir, ...DESIGNATED[name], ...(overrides[name] ? { designated: overrides[name] } : {}) });
  const repos = [make("agent-loop", agentLoopDir)];
  const parent = resolve(agentLoopDir, "..");
  if (existsSync(join(parent, ".git"))) {
    const top = git(parent, ["rev-parse", "--show-toplevel"]).stdout.trim();
    if (top && resolve(top) !== resolve(agentLoopDir)) repos.push(make("Dev-Skill", top));
  }
  return repos;
}

/** A Python 3 interpreter name, or undefined (the same search the pre-commit hook makes). */
function python3() {
  for (const c of [process.env.PYTHON, "python3", "python"].filter(Boolean)) {
    const r = spawnSync(c, ["-c", "import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return undefined;
}

/** Returns one result per repo: { name, branch, state, detail } with state one of nothing-to-save, saved, commit-blocked, push-rejected, push-failed, no-branch, branch-not-designated, unexpected-origin, scanner-missing.
 * `requireScanner` is true unless a caller (a test with no scanner in its repository) says otherwise; the command line never turns it off. A repo entry may carry `designated` (the only branch it may push) and `origin` (a pattern its origin URL must match). */
export async function checkpoint({ repos, reason = "checkpoint", trailer = process.env.CHECKPOINT_TRAILER ?? "Co-Authored-By: Claude <noreply@anthropic.com>", retryDelays = [2000, 4000, 8000, 16000], requireScanner = true }) {
  const results = [];
  for (const { name, dir, designated, origin } of repos) {
    const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    if (!branch || branch === "HEAD") { results.push({ name, branch, state: "no-branch", detail: "detached HEAD: nothing is pushed from here" }); continue; }
    if (designated && branch !== designated) { results.push({ name, branch, state: "branch-not-designated", detail: `this checkout is on "${branch}" and only "${designated}" is pushed from here; switch branches, or pass --allow-branch ${name}=${branch} if that is meant` }); continue; }
    if (origin) {
      const url = git(dir, ["remote", "get-url", "origin"]).stdout.trim();
      if (!origin.test(url)) { results.push({ name, branch, state: "unexpected-origin", detail: `origin is "${url.replace(/\/\/[^@/]*@/, "//")}", not the repository ${name} belongs to: nothing was staged or pushed` }); continue; }
    }
    const dirty = git(dir, ["status", "--porcelain"]).stdout.trim().length > 0;
    let committed = false, files = [];
    if (dirty) {
      git(dir, ["add", "-A"]);
      files = git(dir, ["diff", "--cached", "--name-status"]).stdout.trim().split("\n").filter(Boolean);
      if (requireScanner) {
        const scanner = join(dir, ".githooks", "check_staged.py");
        const py = existsSync(scanner) ? python3() : undefined;
        if (!py) {
          git(dir, ["reset", "-q"]);
          results.push({ name, branch, state: "scanner-missing", detail: existsSync(scanner) ? "no Python 3 interpreter was found to run the secret scanner (.githooks/check_staged.py); nothing was committed" : `the secret scanner .githooks/check_staged.py is not in ${name}; nothing was committed (a checkpoint does not stage files nobody has scanned)` });
          continue;
        }
        const sc = spawnSync(py, [scanner, "--mode=commit"], { cwd: dir, encoding: "utf8" });
        if (sc.status !== 0) { git(dir, ["reset", "-q"]); results.push({ name, branch, state: "commit-blocked", detail: `the secret scanner blocked this save (nothing was committed): ${(sc.stdout + sc.stderr).trim().slice(0, 1500)}` }); continue; }
      }
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
    results.push(pushed ? { name, branch, state: "saved", detail: `${committed ? "committed and " : ""}pushed ${branch}`, files } : { name, branch, state: "push-failed", detail: last.slice(0, 600) });
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const argv = process.argv.slice(2);
  const overrides = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--allow-branch") continue;
    const m = /^([^=]+)=(.+)$/.exec(argv[i + 1] ?? "");
    if (!m) { console.error("--allow-branch needs <repo>=<branch>, for example --allow-branch agent-loop=scratch"); process.exit(2); }
    overrides[m[1]] = m[2];
    argv.splice(i, 2); i--;
  }
  const reason = argv.join(" ") || "save before moving on";
  try {
    const out = execFileSync("node", [join(here, "scripts/handoff-check.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (out.trim()) console.log(out.trim());
  } catch (e) { console.log("warning: docs/HANDOFF.md has problems (saving anyway):\n" + String(e.stderr ?? e.message).trim()); }
  const results = await checkpoint({ repos: findRepos(here, overrides), reason });
  for (const r of results) {
    console.log(`${r.state === "saved" || r.state === "nothing-to-save" ? "ok  " : "FAIL"} ${r.name} (${r.branch}): ${r.state}: ${r.detail}`);
    // what went into the commit, so a person reading the output after the fact can see it (the list is capped; the full one is in the commit)
    if (r.files?.length) console.log(`       ${r.files.length} file(s): ${r.files.slice(0, 40).map((f) => f.replace("\t", " ")).join(", ")}${r.files.length > 40 ? ", ..." : ""}`);
  }
  const bad = results.filter((r) => !["saved", "nothing-to-save"].includes(r.state));
  if (bad.length) console.log("\nNot everything was saved. For a commit blocked by the scanner: read its message; allow a false positive inline with `// devskill:allow (reason)`. Never --no-verify.");
  process.exit(bad.length ? 1 : 0);
}
