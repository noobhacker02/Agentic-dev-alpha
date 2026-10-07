// The agent-only browser profile (docs/HYBRID-AGENT-SPEC.md S2; threats D4 "two agents on one profile", D5 "profile theft"): one directory per site under the user's own agent-loop home, mode 0700, never
// inside the project or the working directory the agents write to, never reached through a link, and held by one process at a time (a lock that survives a crash and a reboot without ever being
// taken from a live holder). No browser here: the directory rules, the lock, and what is done about the files Chromium leaves behind.
//   npm run build && npm run test:profile
import assert from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { siteName, prepareProfile, acquireProfileLock, clearChromiumLeftovers, processStartTime } from "../dist/profile.js";

const posix = process.platform !== "win32";
const scratch = () => mkdtempSync(join(tmpdir(), "profile-"));
const mode = (p) => lstatSync(p).mode & 0o777;

// 1. A site is a platform name
{
  for (const ok of ["linkedin", "greenhouse", "acme-careers", "a", "x".repeat(31)]) assert.strictEqual(siteName(ok), ok, ok);
  for (const bad of ["", "LinkedIn", "linked in", "../x", "a/b", "a\\b", ".hidden", "-x", "9lives", "x".repeat(32), "a.b", "a\u0000", 7, null, undefined, "con‮"]) assert.strictEqual(siteName(bad), undefined, JSON.stringify(bad));
  console.log("[ok] a site is a lower-case platform name; a path, a dot, a space, a control or a bidi character is not one");
}

// 2. The profile directory: made 0700, idempotent, tightened if looser, real path returned
{
  const home = scratch();
  const r = prepareProfile({ home, site: "linkedin" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.dir.endsWith(join("profiles", "linkedin")) && existsSync(r.dir));
  assert.ok(r.lockPath.endsWith(join("profiles", "linkedin.lock")), r.lockPath);
  if (posix) { assert.strictEqual(mode(r.dir), 0o700); assert.strictEqual(mode(join(home, "profiles")), 0o700); }
  const again = prepareProfile({ home, site: "linkedin" });
  assert.ok(again.ok && again.dir === r.dir, "preparing twice changed the answer");
  if (posix) {
    chmodSync(r.dir, 0o755);
    const t = prepareProfile({ home, site: "linkedin" });
    assert.ok(t.ok && mode(r.dir) === 0o700, "a profile directory that others could read was not tightened");
    chmodSync(join(home, "profiles"), 0o755);
    assert.ok(prepareProfile({ home, site: "linkedin" }).ok && mode(join(home, "profiles")) === 0o700, "the profiles directory was left readable by others");
  }
  assert.ok(!prepareProfile({ home, site: "../escape" }).ok && !prepareProfile({ home, site: "Linked In" }).ok);
  console.log("[ok] a profile is <home>/profiles/<site>, made 0700 (and tightened if it was not), the same on the second call; a bad site name is refused");
}

// 3. It is never inside the project or the working directory, and never contains them
{
  const base = scratch();
  const repo = join(base, "repo"), work = join(base, "work");
  mkdirSync(repo); mkdirSync(work);
  const insideRepo = prepareProfile({ home: join(repo, ".agent-loop-home"), site: "linkedin", forbidden: [repo, work] });
  assert.ok(!insideRepo.ok && /inside/i.test(insideRepo.error) && /repo/.test(insideRepo.error), JSON.stringify(insideRepo));
  const insideWork = prepareProfile({ home: join(work, "h"), site: "linkedin", forbidden: [repo, work] });
  assert.ok(!insideWork.ok && /inside/i.test(insideWork.error), JSON.stringify(insideWork));
  // the working directory is the profile's own parent chain: --dir pointing at the home, or above it
  const homeAbove = prepareProfile({ home: base, site: "linkedin", forbidden: [base] });
  assert.ok(!homeAbove.ok, "a profile under the very directory the agents work in was made");
  const contains = prepareProfile({ home: base, site: "linkedin", forbidden: [join(base, "profiles", "linkedin", "sub")] });
  assert.ok(!contains.ok && /contain/i.test(contains.error), JSON.stringify(contains));
  const fine = prepareProfile({ home: join(base, "elsewhere"), site: "linkedin", forbidden: [repo, work] });
  assert.ok(fine.ok, JSON.stringify(fine));
  const lookalike = prepareProfile({ home: join(base, "work-home"), site: "linkedin", forbidden: [work] });
  assert.ok(lookalike.ok, "a sibling whose name only starts like the working directory was refused");
  console.log("[ok] a profile inside the repository or the working directory is refused, so is one that would contain a forbidden path; a sibling that only shares a name prefix is fine");
}

// 4. Not through a link: a symlinked profiles directory or site directory is a way to steal or plant a profile
if (posix) {
  const base = scratch();
  const home = join(base, "home"), elsewhere = join(base, "elsewhere");
  mkdirSync(home); mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(home, "profiles"));
  let r = prepareProfile({ home, site: "linkedin" });
  assert.ok(!r.ok && /link/i.test(r.error), JSON.stringify(r));
  assert.deepStrictEqual(lstatSync(elsewhere).isDirectory() && existsSync(join(elsewhere, "linkedin")), false, "a profile was made behind the link");
  unlinkSync(join(home, "profiles"));
  mkdirSync(join(home, "profiles"), { mode: 0o700 });
  symlinkSync(elsewhere, join(home, "profiles", "linkedin"));
  r = prepareProfile({ home, site: "linkedin" });
  assert.ok(!r.ok && /link/i.test(r.error), JSON.stringify(r));
  unlinkSync(join(home, "profiles", "linkedin"));
  writeFileSync(join(home, "profiles", "linkedin"), "a file");
  r = prepareProfile({ home, site: "linkedin" });
  assert.ok(!r.ok && /not a directory/i.test(r.error), JSON.stringify(r));
  // the home itself may be a link (a dotfiles setup): that is the user's own doing, and the real path is what is judged
  const linkedHome = join(base, "linked-home");
  symlinkSync(join(base, "real-home"), linkedHome);
  mkdirSync(join(base, "real-home"));
  r = prepareProfile({ home: linkedHome, site: "linkedin" });
  assert.ok(r.ok && r.dir.startsWith(join(realpathSync(base), "real-home")), JSON.stringify(r));
  console.log("[ok] a link in place of the profiles directory or a site directory, or a file in place of one, is refused and nothing is made behind it; a linked home is judged by where it really is");
}

// 5. Someone else's directory is not ours to use
if (posix) {
  const home = scratch();
  assert.ok(prepareProfile({ home, site: "linkedin" }).ok);
  const r = prepareProfile({ home, site: "linkedin", uid: process.getuid() + 1 });
  assert.ok(!r.ok && /not owned by you/i.test(r.error), JSON.stringify(r));
  console.log("[ok] a profile directory owned by another user is refused");
}

// 6. The lock: one holder; a dead holder, or a pid reused by another process (after a reboot), is recovered; a live one never
{
  const dir = scratch();
  const lock = join(dir, "site.lock");
  const env = (pid, extra = {}) => ({ pid, host: "h1", isAlive: () => true, startOf: (p) => `start-of-${p}`, now: () => new Date("2026-10-07T12:00:00Z"), ...extra });
  const a = acquireProfileLock(lock, env(1001));
  assert.ok(a.ok, JSON.stringify(a));
  if (posix) assert.strictEqual(mode(lock), 0o600);
  const held = JSON.parse(readFileSync(lock, "utf8"));
  assert.deepStrictEqual([held.pid, held.start, held.host], [1001, "start-of-1001", "h1"]);
  assert.ok(typeof held.nonce === "string" && held.nonce.length >= 16);

  let b = acquireProfileLock(lock, env(1002));
  assert.ok(!b.ok && /in use by pid 1001/i.test(b.error) && b.holder?.pid === 1001, `a live holder's lock was taken: ${JSON.stringify(b)}`);
  b = acquireProfileLock(lock, env(1002, { isAlive: (p) => p !== 1001 }));
  assert.ok(b.ok && b.staleRecovered?.pid === 1001, `a dead holder's lock was not recovered: ${JSON.stringify(b)}`);
  b.release();

  // the pid is alive but it is another process now (a reboot reused the number): its start time differs from the one written
  const c = acquireProfileLock(lock, env(1001, { startOf: () => "boot-1" }));
  assert.ok(c.ok);
  let d = acquireProfileLock(lock, env(1003, { startOf: () => "boot-2" }));
  assert.ok(d.ok && d.staleRecovered?.pid === 1001, `a reused pid kept the lock: ${JSON.stringify(d)}`);
  d.release();

  // cannot tell: alive and no start time to compare, on either side, is held
  const e1 = acquireProfileLock(lock, env(1001, { startOf: () => undefined }));
  assert.ok(e1.ok);
  assert.ok(!acquireProfileLock(lock, env(1004, { startOf: () => "anything" })).ok, "a holder recorded without a start time was treated as dead");
  e1.release();
  const e2 = acquireProfileLock(lock, env(1001));
  assert.ok(e2.ok);
  assert.ok(!acquireProfileLock(lock, env(1005, { startOf: () => undefined })).ok, "a live holder was taken when the start time could not be read now");
  e2.release();

  // the same start time and alive: held
  const f = acquireProfileLock(lock, env(1001));
  assert.ok(f.ok);
  assert.ok(!acquireProfileLock(lock, env(1006)).ok);
  // another machine's lock cannot be proven stale from here
  const g = acquireProfileLock(lock, env(1007, { host: "other-host" }));
  assert.ok(!g.ok && /other-host|h1/.test(g.error) && /another computer|different host|h1/i.test(g.error), JSON.stringify(g));
  f.release();
  assert.ok(!existsSync(lock), "release left the lock");

  // a lock file being written (not yet readable) is held for a few seconds, then it is just a broken file
  writeFileSync(lock, "{");
  assert.ok(!acquireProfileLock(lock, env(1008, { now: () => new Date(lstatSync(lock).mtimeMs + 1000) })).ok, "a lock mid-write was taken");
  const old = acquireProfileLock(lock, env(1008, { now: () => new Date(lstatSync(lock).mtimeMs + 60_000) }));
  assert.ok(old.ok, "a broken lock file blocked the profile for ever");
  // release removes only our own lock
  writeFileSync(lock, JSON.stringify({ pid: 1, start: "x", host: "h1", nonce: "not-ours-not-ours-not-ours", since: "t" }));
  old.release();
  assert.ok(existsSync(lock) && JSON.parse(readFileSync(lock, "utf8")).nonce === "not-ours-not-ours-not-ours", "release removed a lock that was not ours");
  console.log("[ok] one holder at a time; a dead holder or a reused pid is recovered, a live or unprovable one never; a broken file blocks briefly then not for ever; release removes only its own lock");
}

// 7. Real processes racing for the same lock: exactly one wins, and the rest are told who has it
{
  const dir = scratch();
  const lock = join(dir, "race.lock");
  const mod = new URL("../dist/profile.js", import.meta.url).href;
  const script = `import { acquireProfileLock } from ${JSON.stringify(mod)}; const r = acquireProfileLock(${JSON.stringify(lock)}); console.log(r.ok ? "WON" : "LOST " + r.error); if (r.ok) setTimeout(() => { r.release(); process.exit(0); }, 700); else process.exit(0);`;
  const run = () => new Promise((resolve) => { const c = spawn(process.execPath, ["--input-type=module", "-e", script]); let out = ""; c.stdout.on("data", (d) => (out += d)); c.on("close", () => resolve(out.trim())); });
  const results = await Promise.all(Array.from({ length: 6 }, run));
  const won = results.filter((r) => r === "WON").length;
  assert.strictEqual(won, 1, `${won} processes got the lock: ${JSON.stringify(results)}`);
  assert.ok(results.filter((r) => r.startsWith("LOST")).every((r) => /in use by pid \d+/.test(r)), JSON.stringify(results));
  assert.ok(!existsSync(lock), "the winner did not release");
  console.log("[ok] six real processes race for one lock: exactly one wins, the others are told which pid has it, and the lock is gone when the winner exits");
}

// 8. What Chromium leaves in a persistent profile (SingletonLock and friends) is removed only when its owner is provably gone
if (posix) {
  const dir = scratch();
  const lockOf = (target) => { for (const n of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) { try { unlinkSync(join(dir, n)); } catch { /* none yet */ } symlinkSync(n === "SingletonLock" ? target : "/tmp/not-followed-" + n, join(dir, n)); } };
  const env = (extra = {}) => ({ pid: 4242, host: "h1", isAlive: () => false, ...extra });
  assert.deepStrictEqual(clearChromiumLeftovers(dir, env()), { ok: true, removed: [] });
  lockOf("h1-5555");
  const dead = clearChromiumLeftovers(dir, env());
  assert.ok(dead.ok && dead.removed.sort().join() === "SingletonCookie,SingletonLock,SingletonSocket", JSON.stringify(dead));
  for (const n of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) assert.ok(!existsSync(join(dir, n)) && (() => { try { lstatSync(join(dir, n)); return false; } catch { return true; } })(), `${n} is still there`);
  lockOf("h1-5555");
  const live = clearChromiumLeftovers(dir, env({ isAlive: (p) => p === 5555 }));
  assert.ok(!live.ok && /running/i.test(live.error) && /5555/.test(live.error), JSON.stringify(live));
  assert.ok(lstatSync(join(dir, "SingletonLock")).isSymbolicLink(), "a live Chromium's lock was removed");
  const ours = clearChromiumLeftovers(dir, env({ isAlive: () => true, pid: 5555 }));
  assert.ok(ours.ok, "our own earlier lock was treated as someone else's");
  lockOf("other-host-77");
  const away = clearChromiumLeftovers(dir, env());
  assert.ok(!away.ok && /other-host/.test(away.error), JSON.stringify(away));
  lockOf("not a valid target");
  assert.ok(clearChromiumLeftovers(dir, env()).ok, "a lock with an unreadable target blocked the profile");
  assert.ok(existsSync("/tmp") && !existsSync("/tmp/not-followed-SingletonCookie"), "a link's target was followed");
  console.log("[ok] Chromium's leftover lock files are removed when their owner is gone, kept when it is running or on another machine, and links are removed, never followed");
}

// 9. The start time of a process: stable for a live one, absent for one that is not there
{
  const mine = processStartTime(process.pid);
  assert.ok(typeof mine === "string" && mine.length > 3, `no start time for this process: ${mine}`);
  assert.strictEqual(processStartTime(process.pid), mine, "a process's start time changed between two reads");
  assert.strictEqual(processStartTime(2 ** 22 + 12345), undefined, "a start time was invented for a pid that is not running");
  assert.strictEqual(processStartTime(-1), undefined);
  assert.strictEqual(processStartTime(Number.NaN), undefined);
  assert.ok(hostname().length > 0);
  console.log("[ok] a process's start time can be read, is stable, and is absent for a process that is not there");
}
console.log("\nALL PROFILE TESTS PASSED");
