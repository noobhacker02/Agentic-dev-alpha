// The agent-only browser profile (docs/HYBRID-AGENT-SPEC.md S2; threats D4 "two agents on one profile", D5 "profile theft"): one directory per site under the user's own agent-loop home, mode 0700, never
// inside the project or the working directory the agents write to, never reached through a link, and held by one process at a time (a lock that survives a crash and a reboot without ever being
// taken from a live holder). No browser here: the directory rules, the lock, and what is done about the files Chromium leaves behind.
//   npm run build && npm run test:profile
import assert from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, chownSync, copyFileSync, lchownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync, unlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { siteName, prepareProfile, acquireProfileLock, clearChromiumLeftovers, processStartTime, isPidAlive } from "../dist/profile.js";

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
  if (posix) {
    // readable by the group alone, or by the world alone, is still readable
    for (const loose of [0o750, 0o705, 0o770, 0o707, 0o755]) {
      chmodSync(r.dir, loose); chmodSync(join(home, "profiles"), loose);
      assert.ok(prepareProfile({ home, site: "linkedin" }).ok && mode(r.dir) === 0o700 && mode(join(home, "profiles")) === 0o700, `a ${loose.toString(8)} directory was not tightened`);
    }
    // a home that does not exist yet is made private too
    const fresh = join(scratch(), "not-yet", "agent-home");
    assert.ok(prepareProfile({ home: fresh, site: "linkedin" }).ok);
    assert.strictEqual(mode(fresh), 0o700, "a new agent-loop home was left readable by others");
    // a umask that takes away the owner's own write bit must not leave an unusable directory
    const home2 = scratch(), before = process.umask(0o277);
    try { assert.ok(prepareProfile({ home: home2, site: "linkedin" }).ok); } finally { process.umask(before); }
    assert.strictEqual(mode(join(home2, "profiles")), 0o700, "a strict umask left the profiles directory unusable");
    assert.strictEqual(mode(join(home2, "profiles", "linkedin")), 0o700, "a strict umask left the profile directory unusable");
  }
  console.log("[ok] a profile is <home>/profiles/<site>, made 0700 (and tightened if group- or world-readable), the same on the second call; a bad site name is refused");
}

// 3. It is never inside the project or the working directory, and never contains them
{
  const base = scratch();
  const repo = join(base, "repo"), work = join(base, "work");
  mkdirSync(repo); mkdirSync(work);
  const insideRepo = prepareProfile({ home: join(repo, ".agent-loop-home"), site: "linkedin", forbidden: [repo, work] });
  assert.ok(!insideRepo.ok && /inside/i.test(insideRepo.error) && /repo/.test(insideRepo.error), JSON.stringify(insideRepo));
  assert.ok(!existsSync(join(repo, ".agent-loop-home")), "a refused profile left a directory inside the place it was refused for");
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
  // the profile directory itself, or the profiles directory, named as forbidden; and a forbidden directory named through a link
  const exact = prepareProfile({ home: join(base, "home3"), site: "linkedin" });
  assert.ok(exact.ok);
  const same = prepareProfile({ home: join(base, "home3"), site: "linkedin", forbidden: [exact.dir] });
  assert.ok(!same.ok && /inside/i.test(same.error), `the profile directory named as forbidden was accepted: ${JSON.stringify(same)}`);
  const alias = join(base, "alias-of-repo");
  symlinkSync(repo, alias);
  const viaLink = prepareProfile({ home: join(repo, ".home-through-link"), site: "linkedin", forbidden: [alias] });
  assert.ok(!viaLink.ok && /inside/i.test(viaLink.error), `a forbidden directory named through a link was not resolved: ${JSON.stringify(viaLink)}`);
  // a forbidden directory that is not there yet, named through a link in its path (on macOS /var is such a link): it still lives where the link leads
  if (posix) {
    const linkedBase = join(scratch(), "linked-base");
    symlinkSync(base, linkedBase);
    const notThereYet = prepareProfile({ home: base, site: "linkedin", forbidden: [join(linkedBase, "profiles", "linkedin", "not-yet")] });
    assert.ok(!notThereYet.ok && /contain/i.test(notThereYet.error), `a forbidden directory that does not exist yet, named through a link, was not resolved: ${JSON.stringify(notThereYet)}`);
    const insideNotThere = prepareProfile({ home: join(linkedBase, "work", "later", "h"), site: "linkedin", forbidden: [join(linkedBase, "work")] });
    assert.ok(!insideNotThere.ok && /inside/i.test(insideNotThere.error), `a profile under a not-yet-existing forbidden directory named through a link was made: ${JSON.stringify(insideNotThere)}`);
  }
  // two directories that are not there yet, in the order they will be: the profile would be inside the second
  if (posix) {
    const linked2 = join(scratch(), "linked-2");
    symlinkSync(base, linked2);
    const deep = prepareProfile({ home: join(base, "ghost", "x", "y", "h"), site: "linkedin", forbidden: [join(linked2, "ghost", "x", "y")] });
    assert.ok(!deep.ok && /inside/i.test(deep.error), `a profile under two directories that do not exist yet was made: ${JSON.stringify(deep)}`);
    assert.ok(!existsSync(join(base, "ghost")), "a refused profile left directories behind");
  }
  // a directory whose own name starts with two dots is still a child, not a way out of its parent
  for (const name of ["..sneaky", "..", ".. x"].filter((n) => n !== "..")) {
    const dotted = prepareProfile({ home: join(repo, name), site: "linkedin", forbidden: [repo] });
    assert.ok(!dotted.ok && /inside/i.test(dotted.error), `a home named "${name}" inside the repository was accepted: ${JSON.stringify(dotted)}`);
    const dottedAbove = prepareProfile({ home: base, site: "linkedin", forbidden: [join(base, "profiles", "linkedin", name)] });
    assert.ok(!dottedAbove.ok && /contain/i.test(dottedAbove.error), `a forbidden "${name}" under the profile was not noticed: ${JSON.stringify(dottedAbove)}`);
  }
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

// 10. The lock file's holder record must be whole: a record missing its pid, host or nonce, or with the wrong type, is a broken file, never a holder to trust
{
  const dir = scratch();
  const lock = join(dir, "typed.lock");
  const env = (pid) => ({ pid, host: "h1", isAlive: () => true, startOf: () => "s", now: () => new Date(lstatSync(lock).mtimeMs + 1000) });
  const whole = { pid: 1001, start: "s", host: "h1", nonce: "n-n-n-n-n-n-n-n-n", since: "t" };
  writeFileSync(lock, JSON.stringify(whole));
  const control = acquireProfileLock(lock, env(1002));
  assert.ok(!control.ok && /in use by pid 1001/.test(control.error), `control: ${JSON.stringify(control)}`);
  for (const [name, broken] of [["no pid", { ...whole, pid: undefined }], ["pid as text", { ...whole, pid: "1001" }], ["no host", { ...whole, host: undefined }], ["host as a number", { ...whole, host: 7 }], ["no nonce", { ...whole, nonce: undefined }], ["nonce as a number", { ...whole, nonce: 7 }], ["an array", [1001, "h1", "n"]], ["null", null]]) {
    writeFileSync(lock, JSON.stringify(broken));
    const r = acquireProfileLock(lock, env(1002));
    assert.ok(!r.ok && /being written/.test(r.error) && r.holder === undefined, `${name}: a record that is not whole was trusted as a holder: ${JSON.stringify(r)}`);
  }
  console.log("[ok] a lock record missing its pid, host or nonce, or with the wrong types, is treated as a file still being written, never as a holder");
}

// 11. Nothing is left beside the lock: the temporary file is removed whether the lock was won or lost
{
  const dir = scratch();
  const lock = join(dir, "tidy.lock");
  const env = (pid) => ({ pid, host: "h1", isAlive: () => true, startOf: () => "s" });
  const a = acquireProfileLock(lock, env(1001));
  assert.ok(a.ok);
  assert.deepStrictEqual(readdirSync(dir), ["tidy.lock"], "a temporary file was left beside a won lock");
  assert.ok(!acquireProfileLock(lock, env(1002)).ok);
  assert.deepStrictEqual(readdirSync(dir), ["tidy.lock"], "a temporary file was left beside a lost lock");
  a.release();
  assert.deepStrictEqual(readdirSync(dir), [], "release left files behind");
  // a lock that cannot be created is a refusal that says why, not a crash
  const nowhere = acquireProfileLock(join(dir, "no-such-directory", "x.lock"), env(1003));
  assert.ok(!nowhere.ok && /lock could not be created \(ENOENT\)/.test(nowhere.error) && !/hard links/.test(nowhere.error), JSON.stringify(nowhere));
  assert.deepStrictEqual(readdirSync(dir), [], "a failed lock left files behind");
  console.log("[ok] winning or losing the lock leaves no temporary file behind");
}

// 12. Recovering a stale lock: two processes that both found it stale must not both end up holding the profile
{
  const dir = scratch();
  const lock = join(dir, "recover.lock");
  const dead = (p) => p !== 1001;
  const env = (pid, extra = {}) => ({ pid, host: "h1", isAlive: dead, startOf: (p) => `start-of-${p}`, ...extra });
  const plant = () => { try { unlinkSync(lock); } catch { /* none */ } writeFileSync(lock, JSON.stringify({ pid: 1001, start: "start-of-1001", host: "h1", nonce: "dead-holders-nonce-0000", since: "t" })); };

  // (a) B recovers and wins between A reading the stale lock and A removing it: A must not remove B's fresh lock
  plant();
  let b;
  const a = acquireProfileLock(lock, env(1002, { between: (stage) => { if (stage === "stale-found" && !b) b = acquireProfileLock(lock, env(1003)); } }));
  assert.ok(b?.ok, `B could not recover the stale lock: ${JSON.stringify(b)}`);
  assert.ok(!a.ok && a.holder?.pid === 1003 && /in use by pid 1003/.test(a.error), `A removed the lock B had just taken: ${JSON.stringify(a)}`);
  b.release();

  // (b) while A is inside the recovery (mutex held, about to remove the stale lock), B cannot start one of its own
  plant();
  let inner; let innerMs = 0;
  const a2 = acquireProfileLock(lock, env(1002, { now: () => new Date(), between: (stage) => { if (stage === "before-remove" && !inner) { const t = Date.now(); inner = acquireProfileLock(lock, env(1003, { now: () => new Date() })); innerMs = Date.now() - t; } } }));
  assert.ok(inner && !inner.ok && /kept changing/.test(inner.error), `a second recovery ran inside the first: ${JSON.stringify(inner)}`);
  assert.ok(innerMs >= 150, `the second recovery did not wait for the first (${innerMs} ms)`);
  assert.ok(a2.ok && a2.staleRecovered?.pid === 1001, `A did not finish its recovery: ${JSON.stringify(a2)}`);
  a2.release();

  // (c) a recovery mutex left by a process that died: waited on while fresh, cleared once old
  plant();
  const mutex = `${lock}.recovering`;
  mkdirSync(mutex);
  const start = Date.now();
  const blocked = acquireProfileLock(lock, env(1002, { now: () => new Date() }));
  assert.ok(!blocked.ok && /kept changing/.test(blocked.error), `a fresh recovery mutex was ignored: ${JSON.stringify(blocked)}`);
  assert.ok(Date.now() - start >= 150, "a held recovery mutex was not waited on");
  assert.ok(existsSync(mutex), "a fresh recovery mutex was removed");
  const old = new Date(Date.now() - 120_000);
  utimesSync(mutex, old, old);
  const cleared = acquireProfileLock(lock, env(1002, { now: () => new Date() }));
  assert.ok(cleared.ok && cleared.staleRecovered?.pid === 1001, `an old recovery mutex blocked the profile for ever: ${JSON.stringify(cleared)}`);
  assert.ok(!existsSync(mutex), "the recovery mutex was left behind");
  cleared.release();
  console.log("[ok] recovering a stale lock is serialised: a second recoverer neither removes the winner's fresh lock nor runs beside the first, and a mutex left by a dead recoverer is waited on, then cleared");
}

// 13. Real start times tell processes apart, and a reused pid is recovered without stand-ins
{
  const idle = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const mine = processStartTime(process.pid), theirs = processStartTime(idle.pid);
    assert.ok(typeof theirs === "string" && theirs.length > 3);
    assert.notStrictEqual(theirs, mine, "two different processes have the same start time");
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", `${idle.pid}`, null, undefined]) assert.strictEqual(processStartTime(bad), undefined, `a start time was invented for ${String(bad)}`);
    if (process.platform === "linux") {
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      assert.ok(mine.startsWith(`${boot}:`), `the start time does not carry the boot id, so a reboot could repeat it: ${mine}`);
    }
    // a lock written by a process that has since been replaced by another with the same pid: alive, but not the holder
    const lock = join(scratch(), "reuse.lock");
    const record = (start) => writeFileSync(lock, JSON.stringify({ pid: idle.pid, start, host: hostname(), nonce: "nonce-nonce-nonce-nonce", since: "t" }));
    record(mine);
    const taken = acquireProfileLock(lock);
    assert.ok(taken.ok && taken.staleRecovered?.pid === idle.pid, `a live pid whose start time is not the recorded one kept the lock: ${JSON.stringify(taken)}`);
    taken.release();
    record(theirs);
    const held = acquireProfileLock(lock);
    assert.ok(!held.ok && held.holder?.pid === idle.pid, `the real holder lost its lock: ${JSON.stringify(held)}`);
  } finally { idle.kill(); }
  console.log("[ok] real start times differ between processes and carry the boot id; a lock whose pid is alive but whose start time differs is recovered, and one whose start time matches is held");
}

// 14. A process's start time does not change when it renames itself, even to a name with spaces and brackets (the kernel prints the name between brackets)
if (process.platform === "linux") {
  const child = spawn(process.execPath, ["-e", `process.stdin.on("data", () => { process.title = "x) (y z 1 2 3"; console.log("renamed"); }); console.log("ready"); setInterval(() => {}, 1000);`], { stdio: ["pipe", "pipe", "ignore"] });
  const lines = []; let wake;
  child.stdout.on("data", (d) => { lines.push(...String(d).split("\n").filter(Boolean)); wake?.(); });
  const next = () => new Promise((resolve) => { const check = () => (lines.length ? resolve(lines.shift()) : (wake = check)); check(); });
  try {
    assert.strictEqual(await next(), "ready");
    const before = processStartTime(child.pid);
    child.stdin.write("go\n");
    assert.strictEqual(await next(), "renamed");
    assert.ok(readFileSync(`/proc/${child.pid}/stat`, "utf8").includes("(x) (y z"), "the test could not give the process a name with a bracket");
    assert.strictEqual(processStartTime(child.pid), before, "a process's start time changed when its name did");
  } finally { child.kill(); }
  console.log("[ok] the start time is read past the process name, however many spaces and brackets it holds");
}

// 15. Things only another user can show: a directory we cannot look into, and a live process that is not ours (run as the user "nobody" when this is root)
if (posix) {
  const nobody = 65534;
  // The child runs as another user, who may not be able to read this checkout (a scratch directory under /root, say): it imports a copy of the module (it needs nothing but Node's own modules) from a directory anyone can read.
  const shared = scratch();
  chmodSync(shared, 0o755);
  copyFileSync(new URL("../dist/profile.js", import.meta.url), join(shared, "profile.mjs"));
  chmodSync(join(shared, "profile.mjs"), 0o644);
  const asOther = (body) => {
    const mod = pathToFileURL(join(shared, "profile.mjs")).href;
    const drop = process.getuid() === 0 ? `process.setgid(${nobody}); process.setuid(${nobody});` : "";
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", `${drop}\nconst P = await import(${JSON.stringify(mod)});\n${body}`], { encoding: "utf8" });
    return JSON.parse(out.trim().split("\n").pop());
  };
  const give = (p) => { if (process.getuid() === 0) chownSync(p, nobody, nobody); };
  const give2 = (p) => { if (process.getuid() === 0) lchownSync(p, nobody, nobody); };
  const home = scratch();
  chmodSync(home, 0o755); give(home);
  mkdirSync(join(home, "profiles"), { mode: 0o700 }); give(join(home, "profiles"));
  chmodSync(join(home, "profiles"), 0o000);
  try {
    const r = asOther(`console.log(JSON.stringify(P.prepareProfile({ home: ${JSON.stringify(home)}, site: "linkedin" })));`);
    assert.ok(r.ok === false && /cannot be (read|created) \((EACCES|EPERM)\)/.test(r.error), `a profiles directory we could not look into was not reported: ${JSON.stringify(r)}`);
  } finally { chmodSync(join(home, "profiles"), 0o700); }
  // Chromium's leftovers in a directory we may not write to: a refusal that names the file, not a crash
  const stuck = scratch();
  chmodSync(stuck, 0o755); give(stuck);
  symlinkSync("somewhere-else-9", join(stuck, "SingletonLock"));
  give2(join(stuck, "SingletonLock"));
  chmodSync(stuck, 0o555);
  try {
    const c = asOther(`console.log(JSON.stringify(P.clearChromiumLeftovers(${JSON.stringify(stuck)}, { host: "somewhere-else", isAlive: () => false })));`);
    assert.ok(c.ok === false && /leftover SingletonLock.*could not be removed \((EACCES|EPERM)\)/.test(c.error), `a leftover that could not be removed was not reported: ${JSON.stringify(c)}`);
  } finally { chmodSync(stuck, 0o755); }
  const alive = asOther(`console.log(JSON.stringify({ init: P.isPidAlive(1), own: P.isPidAlive(process.pid), gone: P.isPidAlive(${2 ** 22 + 12345}) }));`);
  assert.deepStrictEqual(alive, { init: true, own: true, gone: false }, `liveness of a process that belongs to someone else: ${JSON.stringify(alive)}`);
  assert.strictEqual(isPidAlive(process.pid), true);
  console.log("[ok] a directory the user cannot look into is reported, not assumed fine; a live process owned by someone else counts as alive");
}

console.log("\nALL PROFILE TESTS PASSED");
