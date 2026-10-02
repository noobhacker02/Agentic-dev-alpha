// scripts/checkpoint.mjs: saves everything in one command, and reports honestly when it cannot. Temp repos with a bare remote each.
// Controls: a clean repo makes no commit; a blocking hook is respected (no --no-verify); a rejected push is reported, never forced.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpoint, findRepos } from "../scripts/checkpoint.mjs";

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function makePair(label) {
  const base = mkdtempSync(join(tmpdir(), `ckpt-${label}-`));
  const remote = join(base, "remote.git"), work = join(base, "work");
  git(base, "init", "-q", "--bare", remote);
  git(base, "clone", "-q", remote, work);
  git(work, "config", "user.email", "t@example.com"); git(work, "config", "user.name", "t");
  git(work, "checkout", "-q", "-b", "main");
  writeFileSync(join(work, "a.txt"), "one"); git(work, "add", "-A"); git(work, "commit", "-qm", "init"); git(work, "push", "-q", "-u", "origin", "main");
  return { base, remote, work };
}
const remoteLog = (remote) => git(remote, "log", "--format=%s", "main").trim().split("\n");
const opts = { retryDelays: [] };

// 1. A dirty repo is committed and pushed; the remote has the new file.
{
  const r = makePair("dirty");
  writeFileSync(join(r.work, "b.txt"), "two");
  const res = await checkpoint({ repos: [{ name: "x", dir: r.work }], reason: "usage low", ...opts });
  assert.strictEqual(res[0].state, "saved", JSON.stringify(res));
  assert.ok(remoteLog(r.remote)[0].startsWith("checkpoint: usage low"), "the remote did not get the checkpoint commit");
  assert.ok(/not a claim that the tests pass/.test(git(r.remote, "log", "-1", "--format=%B", "main")), "the message does not say it is not a claim of green");
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
console.log("\nALL CHECKPOINT TESTS PASSED");
