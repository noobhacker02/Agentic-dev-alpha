// scripts/checkpoint.mjs: saves everything in one command, and reports honestly when it cannot. Temp repos with a bare remote each.
// Controls: a clean repo makes no commit; a blocking hook is respected (no --no-verify); a rejected push is reported, never forced.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkpoint, findRepos } from "../scripts/checkpoint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function makePair(label, { scanner = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), `ckpt-${label}-`));
  const remote = join(base, "remote.git"), work = join(base, "work");
  git(base, "init", "-q", "--bare", remote);
  git(base, "clone", "-q", remote, work);
  git(work, "config", "user.email", "t@example.com"); git(work, "config", "user.name", "t");
  git(work, "checkout", "-q", "-b", "main");
  writeFileSync(join(work, "a.txt"), "one");
  if (scanner) { mkdirSync(join(work, ".githooks")); copyFileSync(join(ROOT, ".githooks", "check_staged.py"), join(work, ".githooks", "check_staged.py")); } // tracked from the start, as in the real repositories
  git(work, "add", "-A"); git(work, "commit", "-qm", "init"); git(work, "push", "-q", "-u", "origin", "main");
  return { base, remote, work };
}
const remoteLog = (remote) => git(remote, "log", "--format=%s", "main").trim().split("\n");
// Cases 1 to 6 are about staging, committing and pushing, in repositories that have no scanner; the scanner and the branch and origin guards are cases 7 to 11.
const opts = { retryDelays: [], requireScanner: false };
const staged = (work) => git(work, "diff", "--cached", "--name-only").trim();
const branchesOn = (remote) => git(remote, "branch", "--format=%(refname:short)").trim().split("\n").filter(Boolean);

// 1. A dirty repo is committed and pushed; the remote has the new file.
{
  const r = makePair("dirty");
  writeFileSync(join(r.work, "b.txt"), "two");
  const res = await checkpoint({ repos: [{ name: "x", dir: r.work }], reason: "usage low", ...opts });
  assert.strictEqual(res[0].state, "saved", JSON.stringify(res));
  assert.ok(remoteLog(r.remote)[0].startsWith("checkpoint: usage low"), "the remote did not get the checkpoint commit");
  assert.ok(/not a claim that the tests pass/.test(git(r.remote, "log", "-1", "--format=%B", "main")), "the message does not say it is not a claim of green");
  assert.deepStrictEqual(res[0].files, ["A\tb.txt"], "the result does not list what went into the commit");
  console.log("[ok] a dirty repo is committed and pushed, and the message says it is not a claim of green");
}
// 2. Clean and up to date: nothing is committed (control for 1).
{
  const r = makePair("clean");
  const before = remoteLog(r.remote).length;
  const res = await checkpoint({ repos: [{ name: "x", dir: r.work }], ...opts });
  assert.strictEqual(res[0].state, "nothing-to-save");
  assert.strictEqual(remoteLog(r.remote).length, before, "a clean repo made a commit");
  console.log("[ok] a clean repo makes no commit");
}
// 3. Clean tree but ahead of the remote: the unpushed commit is pushed.
{
  const r = makePair("ahead");
  writeFileSync(join(r.work, "c.txt"), "x"); git(r.work, "add", "-A"); git(r.work, "commit", "-qm", "local only");
  const res = await checkpoint({ repos: [{ name: "x", dir: r.work }], ...opts });
  assert.strictEqual(res[0].state, "saved");
  assert.ok(remoteLog(r.remote).includes("local only"), "an unpushed commit was not pushed");
  console.log("[ok] an unpushed commit on a clean tree is pushed");
}
// 4. A blocking pre-commit hook is respected: reported, not bypassed, remote unchanged.
{
  const r = makePair("hook");
  const hook = join(r.work, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'BLOCKED by scanner: possible secret'\nexit 1\n"); chmodSync(hook, 0o755);
  writeFileSync(join(r.work, "secret.txt"), "x");
  const before = remoteLog(r.remote).length;
  const res = await checkpoint({ repos: [{ name: "x", dir: r.work }], ...opts });
  assert.strictEqual(res[0].state, "commit-blocked", JSON.stringify(res));
  assert.ok(/BLOCKED by scanner/.test(res[0].detail), "the scanner's message was not shown");
  assert.strictEqual(remoteLog(r.remote).length, before, "the commit got through a blocking hook");
  console.log("[ok] a blocking pre-commit hook is respected and its message is shown");
}
// 5. A rejected push is reported and not forced.
{
  const r = makePair("reject");
  const other = join(r.base, "other");
  git(r.base, "clone", "-q", r.remote, other); git(other, "config", "user.email", "o@example.com"); git(other, "config", "user.name", "o"); git(other, "checkout", "-q", "-B", "main", "origin/main");
  writeFileSync(join(other, "theirs.txt"), "t"); git(other, "add", "-A"); git(other, "commit", "-qm", "theirs"); git(other, "push", "-q", "origin", "main");
  writeFileSync(join(r.work, "mine.txt"), "m");
  const res = await checkpoint({ repos: [{ name: "x", dir: r.work }], ...opts });
  assert.strictEqual(res[0].state, "push-rejected", JSON.stringify(res));
  assert.ok(remoteLog(r.remote)[0] === "theirs", "the remote history was overwritten (a force push)");
  console.log("[ok] a rejected push is reported and never forced");
}
// 6. Two repos: results are per repo, and findRepos finds a parent repo that is a different one.
{
  const a = makePair("two-a"), b = makePair("two-b");
  writeFileSync(join(a.work, "n.txt"), "1");
  const res = await checkpoint({ repos: [{ name: "a", dir: a.work }, { name: "b", dir: b.work }], ...opts });
  assert.deepStrictEqual(res.map((x) => [x.name, x.state]), [["a", "saved"], ["b", "nothing-to-save"]]);
  const parent = mkdtempSync(join(tmpdir(), "ckpt-parent-")); git(parent, "init", "-q");
  mkdirSync(join(parent, "agent-loop")); git(join(parent, "agent-loop"), "init", "-q");
  const found = findRepos(join(parent, "agent-loop"));
  assert.deepStrictEqual(found.map((f) => f.name), ["agent-loop", "Dev-Skill"], "the parent repo was not found");
  assert.deepStrictEqual(findRepos(a.work).map((f) => f.name), ["agent-loop"], "control: a lone repo should find only itself");
  console.log("[ok] per-repo results; the Dev-Skill checkout one level up is found, and a lone repo finds only itself");
}
// 7. A32: the scanner is run by the command itself, and a repository without one is not staged. (Before: `.env.local` and a cookie file reached the remote of a fresh clone, where no hook was wired in.)
{
  const missing = makePair("noscan");
  writeFileSync(join(missing.work, "b.txt"), "two");
  const before = remoteLog(missing.remote).length;
  const res = await checkpoint({ repos: [{ name: "x", dir: missing.work }], retryDelays: [] }); // requireScanner is on by default
  assert.strictEqual(res[0].state, "scanner-missing", JSON.stringify(res));
  assert.strictEqual(staged(missing.work), "", "files were left staged after a refusal");
  assert.strictEqual(remoteLog(missing.remote).length, before, "a repository with no scanner was committed and pushed");
  // control: the same file with a scanner present is saved
  const ok = makePair("scan-ok", { scanner: true });
  writeFileSync(join(ok.work, "b.txt"), "two");
  const saved = await checkpoint({ repos: [{ name: "x", dir: ok.work }], retryDelays: [] });
  assert.strictEqual(saved[0].state, "saved", JSON.stringify(saved));
  // the scanner blocks a credential file and a key-shaped string with NO hook installed (a fresh clone): refused, unstaged, remote unchanged
  const bad = makePair("scan-bad", { scanner: true });
  const fakeKey = "sk_" + "live_" + "A1b2C3d4E5f6G7h8I9j0K1L2"; // built at run time so this file holds no key-shaped literal
  writeFileSync(join(bad.work, ".env.local"), "X=1\n");
  writeFileSync(join(bad.work, "notes.txt"), `payment key ${fakeKey}\n`); // devskill:allow (a made-up value: this test checks that the scanner blocks it)
  const beforeBad = remoteLog(bad.remote).length;
  const hooksPath = (() => { try { return git(bad.work, "config", "--get", "core.hooksPath").trim(); } catch { return "unset"; } })();
  assert.strictEqual(hooksPath, "unset", "the temp repository must have no hook wired in, as in a fresh clone");
  const blocked = await checkpoint({ repos: [{ name: "x", dir: bad.work }], retryDelays: [] });
  assert.strictEqual(blocked[0].state, "commit-blocked", JSON.stringify(blocked));
  assert.ok(/scanner blocked/.test(blocked[0].detail) && /env|secret|key/i.test(blocked[0].detail), `the scanner's reason is not shown: ${blocked[0].detail}`);
  assert.strictEqual(staged(bad.work), "", "files were left staged after the scanner blocked them");
  assert.strictEqual(remoteLog(bad.remote).length, beforeBad, "a credential file reached the remote");
  console.log("[ok] the command runs the repository's scanner itself: no scanner means nothing is staged, a credential file and a key-shaped string are blocked with no hook installed, and a clean file is saved");
}
// 8. A33: only the designated branch is pushed.
{
  const r = makePair("branch");
  git(r.work, "checkout", "-q", "-b", "scratch/not-designated");
  writeFileSync(join(r.work, "b.txt"), "two");
  const res = await checkpoint({ repos: [{ name: "x", dir: r.work, designated: "main" }], ...opts });
  assert.strictEqual(res[0].state, "branch-not-designated", JSON.stringify(res));
  assert.ok(/--allow-branch x=scratch\/not-designated/.test(res[0].detail), "the way out is not named");
  assert.ok(!branchesOn(r.remote).includes("scratch/not-designated"), "an undesignated branch was pushed");
  assert.strictEqual(git(r.work, "log", "--format=%s", "-1").trim(), "init", "an undesignated branch got a checkpoint commit");
  // controls: on the designated branch it saves; an explicit allowance for another branch saves too
  const onMain = makePair("branch-main");
  writeFileSync(join(onMain.work, "b.txt"), "two");
  assert.strictEqual((await checkpoint({ repos: [{ name: "x", dir: onMain.work, designated: "main" }], ...opts }))[0].state, "saved");
  assert.strictEqual((await checkpoint({ repos: [{ name: "x", dir: r.work, designated: "scratch/not-designated" }], ...opts }))[0].state, "saved");
  assert.ok(branchesOn(r.remote).includes("scratch/not-designated"), "an allowed branch was not pushed");
  console.log("[ok] a checkout on a branch that is not the designated one is neither committed nor pushed, and says how to allow it; the designated branch and an explicit allowance still save");
}
// 9. A33: a repository that is not the expected one (a parent directory that is some other project) is not staged.
{
  const r = makePair("origin");
  writeFileSync(join(r.work, "b.txt"), "two");
  const before = remoteLog(r.remote).length;
  const res = await checkpoint({ repos: [{ name: "x", dir: r.work, origin: /noobhacker02\/dev-skill$/i }], ...opts });
  assert.strictEqual(res[0].state, "unexpected-origin", JSON.stringify(res));
  assert.strictEqual(staged(r.work), "", "an unexpected repository was staged");
  assert.strictEqual(remoteLog(r.remote).length, before, "an unexpected repository was pushed");
  const same = await checkpoint({ repos: [{ name: "x", dir: r.work, origin: /remote\.git$/ }], ...opts });
  assert.strictEqual(same[0].state, "saved", "control: an origin that matches is saved");
  console.log("[ok] a repository whose origin is not the expected one is left alone, and one that matches is saved");
}
// 10. The built-in table: agent-loop pushes main to Agentic-dev-alpha, the parent repo pushes the Dev-Skill branch to Dev-Skill, and an override changes a branch.
{
  const parent = mkdtempSync(join(tmpdir(), "ckpt-table-")); git(parent, "init", "-q");
  mkdirSync(join(parent, "agent-loop")); git(join(parent, "agent-loop"), "init", "-q");
  const found = findRepos(join(parent, "agent-loop"));
  assert.deepStrictEqual(found.map((f) => [f.name, f.designated]), [["agent-loop", "main"], ["Dev-Skill", "claude/dev-workflow-process-v4kafr"]]);
  assert.ok(found[0].origin.test("https://github.com/noobhacker02/Agentic-dev-alpha.git") && found[0].origin.test("http://local_proxy@127.0.0.1:1234/git/noobhacker02/Agentic-dev-alpha"), "the agent-loop origin pattern misses its own URLs");
  assert.ok(found[1].origin.test("https://github.com/noobhacker02/Dev-Skill") && found[1].origin.test("https://github.com/noobhacker02/dev-skill.git") && !found[1].origin.test("https://github.com/someone/dotfiles") && !found[1].origin.test("https://github.com/noobhacker02/another-project") && !found[0].origin.test("https://github.com/noobhacker02/another-project"), "the Dev-Skill origin pattern is wrong, or accepts another repository of the same owner");
  assert.ok(!found[0].origin.test("https://github.com/noobhacker02/Dev-Skill"), "agent-loop's pattern accepts the other repository");
  assert.strictEqual(findRepos(join(parent, "agent-loop"), { "agent-loop": "scratch" })[0].designated, "scratch", "an override did not apply");
  console.log("[ok] the designated branch and origin of each repository are in the command, and an override changes one branch");
}
// 11. The ignore list covers credential and profile files that a git add -A would otherwise take.
{
  const ignored = (p) => { try { git(ROOT, "check-ignore", "-q", p); return true; } catch { return false; } };
  for (const p of [".env", ".env.local", ".env.production", "config/.env.staging", "server.pem", "certs/private.key", "store.p12", "store.pfx", "profile/Default/Cookies", "x/Login Data", "data/app.sqlite", ".agent-loop/profile/Default/Preferences"]) assert.ok(ignored(p), `${p} is not ignored`);
  for (const p of [".env.example", "src/keys.ts", "docs/secrets.md", "README.md"]) assert.ok(!ignored(p), `control: ${p} is an ordinary file and must not be ignored`);
  console.log("[ok] .gitignore covers .env.*, keys, certificates, cookie and login files, sqlite files and the agent profile, and leaves .env.example and ordinary source alone");
}
console.log("\nALL CHECKPOINT TESTS PASSED");
