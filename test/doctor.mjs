// `agent-loop doctor`: each failure told apart, from fake probes (so every branch is tested without the machine being in that
// state), plus the real probes and the CLI. No API calls.
//   npm run build && npm run test:doctor
import assert from "node:assert";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseDesktop, doctorExitCode, realProbes, renderDoctor, runDoctor } from "../dist/doctor.js";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ok = (m) => console.log(`[ok] ${m}`);
// A canary standing in for a credential; assembled at run time so no key-shaped literal sits in the source.
const CANARY = ["canary", "credential", "value"].join("-");
const good = (over = {}) => ({
  platform: "linux", nodeVersion: "v22.22.2", env: { ANTHROPIC_API_KEY: CANARY, DISPLAY: ":0" },
  hasSqlite: async () => true, which: async () => "/usr/bin/ffmpeg", chromium: () => "/opt/chrome", writable: () => true,
  driver: async () => ({ ok: true, version: "0.30.4", expected: "0.30.4", install: "npm install @trycua/cua-driver@0.30.4" }), x11Answers: async () => true, sessionLocked: async () => false,
  ...over,
});
const by = (checks, id) => checks.find((c) => c.id === id);
const fails = (checks) => checks.filter((c) => c.level === "fail").map((c) => c.id).sort();

// everything fine
{
  const checks = await runDoctor(good(), { dataDir: "/data" });
  assert.deepStrictEqual(fails(checks), []);
  assert.ok(checks.every((c) => c.level === "ok" || c.level === "info"), JSON.stringify(checks.filter((c) => c.level !== "ok" && c.level !== "info")));
  assert.strictEqual(doctorExitCode(checks), 0);
  const text = renderDoctor(checks);
  assert.ok(/Everything checks out/.test(text) && !text.includes(CANARY), "a credential's value is never printed");
  assert.ok(by(checks, "credentials").detail.includes("ANTHROPIC_API_KEY"), "…only its name");
  ok("a healthy machine: all clear, exit 0, and the credential's name (never its value) is shown");
}

// Node and the platform basics
{
  const node = async (v) => by(await runDoctor(good({ nodeVersion: v }), { dataDir: "/d" }), "node");
  assert.strictEqual((await node("v20.11.0")).level, "fail");
  assert.strictEqual((await node("v22.4.9")).level, "fail");
  assert.strictEqual((await node("v22.5.0")).level, "warn", "22.5 to 22.12 have node:sqlite only behind a flag");
  assert.ok(/npm start/.test((await node("v22.8.0")).fix));
  assert.strictEqual((await node("v22.13.0")).level, "ok");
  assert.strictEqual((await node("v24.1.0")).level, "ok");
  assert.strictEqual((await node("garbage")).level, "fail", "an unparseable version is not assumed fine");
  assert.strictEqual(by(await runDoctor(good({ hasSqlite: async () => false }), { dataDir: "/d" }), "sqlite").level, "fail");
  assert.strictEqual(by(await runDoctor(good({ writable: () => false }), { dataDir: "/d" }), "data-dir").level, "fail");
  const none = await runDoctor(good({ env: { DISPLAY: ":0" } }), { dataDir: "/d" });
  assert.strictEqual(by(none, "credentials").level, "warn", "no credential is a warning (a Claude Code login may still work), not a failure");
  assert.strictEqual(by(await runDoctor(good({ chromium: () => undefined }), { dataDir: "/d" }), "chromium").level, "warn");
  assert.strictEqual(by(await runDoctor(good({ which: async () => undefined }), { dataDir: "/d" }), "ffmpeg").level, "info");
  // desktop problems block only when desktop is what the person is about to use
  const headless = good({ env: { ANTHROPIC_API_KEY: "x" } });
  const plain = await runDoctor(headless, { dataDir: "/d" });
  assert.deepStrictEqual(fails(plain), [], "no display is not a blocking problem for someone who is not using desktop control");
  assert.strictEqual(by(plain, "desktop-display").level, "warn");
  assert.ok(/--desktop-target/.test(by(plain, "desktop-display").detail), "…and it says why it is only a warning");
  assert.strictEqual(doctorExitCode(plain), 0);
  const wanted = await runDoctor(headless, { dataDir: "/d", desktop: true });
  assert.deepStrictEqual(fails(wanted), ["desktop-display"]);
  assert.strictEqual(doctorExitCode(wanted), 1);
  ok("node (too old / needs the flag / fine / unparseable), node:sqlite, the data folder, credentials, Chromium and ffmpeg each get the right level");
}

// the four desktop failures, told apart
{
  const run = async (over) => diagnoseDesktop(good(over));
  let d = await run({ env: {} });
  assert.deepStrictEqual(fails(d), ["desktop-display"]);
  assert.strictEqual(by(d, "desktop-display").title, "No display");
  assert.ok(/xvfb-run/.test(by(d, "desktop-display").fix));

  d = await run({ env: { DISPLAY: ":99" }, x11Answers: async () => false });
  assert.deepStrictEqual(fails(d), ["desktop-display"]);
  assert.strictEqual(by(d, "desktop-display").title, "The display does not answer");
  assert.ok(by(d, "desktop-display").detail.includes(":99"), "it names the variable that is stale");

  d = await run({ sessionLocked: async () => true });
  assert.deepStrictEqual(fails(d), ["desktop-locked"]);
  assert.strictEqual(by(d, "desktop-locked").title, "The session is locked");

  d = await run({ driver: async () => ({ ok: false, stage: "missing", message: "Could not load it: Cannot find package", install: "npm install @trycua/cua-driver@0.30.4" }) });
  assert.deepStrictEqual(fails(d), [], "a missing driver is a warning: it is only needed with --desktop-target");
  assert.strictEqual(by(d, "desktop-driver").level, "warn");
  assert.ok(/npm install @trycua\/cua-driver@\d/.test(by(d, "desktop-driver").fix), "it names the pinned version to install");

  d = await run({ driver: async () => ({ ok: false, stage: "silent", message: "The desktop driver loaded but did not answer: timeout", install: "npm install @trycua/cua-driver@0.30.4" }) });
  assert.deepStrictEqual(fails(d), ["desktop-driver"]);
  assert.strictEqual(by(d, "desktop-driver").title, "Desktop driver is unhealthy");

  d = await run({ driver: async () => ({ ok: true, version: "0.31.0", expected: "0.30.4", install: "npm install @trycua/cua-driver@0.30.4" }) });
  assert.deepStrictEqual(fails(d), ["desktop-driver"]);
  assert.strictEqual(by(d, "desktop-driver").title, "Desktop driver is the wrong version");
  assert.ok(/refuses an unreviewed driver/.test(by(d, "desktop-driver").detail));

  // several at once are all reported, not just the first
  d = await run({ env: {}, sessionLocked: async () => true, driver: async () => ({ ok: false, stage: "silent", message: "x", install: "npm install @trycua/cua-driver@0.30.4" }) });
  assert.deepStrictEqual(fails(d), ["desktop-display", "desktop-driver", "desktop-locked"]);
  // Wayland, an unchecked remote display, an unknown lock state: said plainly, not failed
  d = await run({ env: { WAYLAND_DISPLAY: "wayland-0" }, sessionLocked: async () => undefined });
  assert.deepStrictEqual(fails(d), []);
  assert.strictEqual(by(d, "desktop-display").level, "info");
  d = await run({ env: { DISPLAY: "remote:0" }, x11Answers: async () => undefined, sessionLocked: async () => undefined });
  assert.strictEqual(by(d, "desktop-display").level, "info");
  assert.ok(!by(d, "desktop-locked"), "an unknown lock state says nothing rather than guessing");
  for (const platform of ["darwin", "win32"]) {
    d = await run({ platform, env: {} });
    assert.deepStrictEqual(fails(d), [], `${platform}: no Linux display rules apply`);
    assert.ok(by(d, "desktop-permission"), `${platform}: permissions are mentioned`);
  }
  ok("desktop: no display, a display that does not answer, a locked session, and a missing / silent / wrong-version driver are each told apart; several at once are all reported; macOS/Windows/Wayland/unknown are info, not guesses");
}

// the real probes
{
  const p = realProbes();
  assert.strictEqual(p.platform, process.platform);
  assert.strictEqual(await p.hasSqlite(), true);
  assert.ok(await p.which("node"), "which finds node");
  assert.strictEqual(await p.which("definitely-not-a-command-xyz"), undefined);
  // A search of PATH, not a `which`/`where` subprocess with a time limit: that reported "not installed" when a loaded Windows CI runner was
  // merely slow, and doctor must never say so about something that is there. A fake command in a temporary PATH directory is found; a directory
  // with the name, a file that is not executable (POSIX), a path-like name and an empty PATH are not.
  {
    const bin = mkdtempSync(join(tmpdir(), "agent-loop-which-"));
    const win = process.platform === "win32";
    const fake = join(bin, "agent-loop-fake-tool" + (win ? ".cmd" : ""));
    writeFileSync(fake, win ? "@echo off\r\n" : "#!/bin/sh\n", { mode: 0o755 });
    mkdirSync(join(bin, "agent-loop-a-directory" + (win ? ".cmd" : "")));
    if (!win) writeFileSync(join(bin, "agent-loop-not-executable"), "#!/bin/sh\n", { mode: 0o644 });
    const saved = process.env.PATH;
    try {
      // PATH is only the fake directory: no `which`, no `where` can even be launched, so a probe that depends on one finds nothing. That is the
      // difference between a search and a subprocess, and the reason a slow runner could make the subprocess say "not installed".
      process.env.PATH = bin;
      // Windows paths are case-insensitive and the extension comes from PATHEXT (".CMD"), so the same file may be spelled ".cmd" on disk.
      const found = await p.which("agent-loop-fake-tool");
      assert.ok(found && (win ? found.toLowerCase() === fake.toLowerCase() : found === fake), `a command in a PATH directory is found, by its full path, with no subprocess to launch (${found})`);
      assert.strictEqual(await p.which("agent-loop-a-directory"), undefined, "a directory with the name is not a command");
      if (!win) assert.strictEqual(await p.which("agent-loop-not-executable"), undefined, "a file without the executable bit is not a command");
      assert.strictEqual(await p.which("../agent-loop-fake-tool"), undefined, "a path-like name is refused, not searched");
      process.env.PATH = "";
      assert.strictEqual(await p.which("node"), undefined, "an empty PATH finds nothing");
    } finally { process.env.PATH = saved; rmSync(bin, { recursive: true, force: true }); }
  }
  const dir = mkdtempSync(join(tmpdir(), "agent-loop-doctor-"));
  assert.strictEqual(p.writable(join(dir, "a", "b")), true, "a folder that can be created is writable");
  writeFileSync(join(dir, "file"), "x");
  assert.strictEqual(p.writable(join(dir, "file", "sub")), false, "a folder under a regular file is not");
  assert.deepStrictEqual(existsSync(join(dir, "a", "b", `.doctor-${process.pid}`)), false, "the probe cleans up after itself");
  assert.strictEqual(await p.x11Answers(":79"), false, "no socket, no answer");
  assert.strictEqual(await p.x11Answers("remote:0"), undefined, "a remote display cannot be checked cheaply");
  // a real listener on a real X11 socket path: answers (X11 sockets are a Unix thing; Windows has no /tmp/.X11-unix)
  if (process.platform !== "win32") {
  mkdirSync("/tmp/.X11-unix", { recursive: true });
  const sock = "/tmp/.X11-unix/X78";
  rmSync(sock, { force: true });
  const srv = net.createServer((c) => c.end());
  await new Promise((r) => srv.listen(sock, r));
  assert.strictEqual(await p.x11Answers(":78"), true);
  assert.strictEqual(await p.x11Answers(":78.0"), true, "the screen number is ignored");
  await new Promise((r) => srv.close(r));
  rmSync(sock, { force: true });
  }
  ok("real probes: sqlite, which, a writable folder (and its clean-up), and an X11 socket that answers or does not");
}

// the CLI
{
  const run = (args, env = {}) => spawnSync(process.execPath, ["--experimental-sqlite", "--no-warnings", "dist/cli.js", ...args], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
  const dir = mkdtempSync(join(tmpdir(), "agent-loop-doctor-cli-"));
  const r = run(["doctor", "--data-dir", join(dir, "d")], { ANTHROPIC_API_KEY: CANARY });
  assert.ok(/^agent-loop doctor/.test(r.stdout) && /Node: v/.test(r.stdout) && /node:sqlite/.test(r.stdout), r.stdout);
  assert.ok(!r.stdout.includes(CANARY), "the CLI never prints a credential");
  assert.ok(r.status === 0 || r.status === 1);
  assert.strictEqual(r.status === 1, /✗/.test(r.stdout), "exit 1 exactly when something blocking is shown");
  if (process.platform === "linux") {
    assert.strictEqual(r.status, 0, `with no display and no --desktop, doctor is not blocked by it:\n${r.stdout}`);
    const dd = run(["doctor", "--data-dir", join(dir, "d"), "--desktop"], { ANTHROPIC_API_KEY: "x" });
    assert.strictEqual(dd.status, 1, "--desktop makes the missing display blocking");
    assert.ok(/✗ No display/.test(dd.stdout), dd.stdout);
  }
  writeFileSync(join(dir, "afile"), "x");
  const bad = run(["doctor", "--data-dir", join(dir, "afile", "sub")], { ANTHROPIC_API_KEY: "x" });
  assert.strictEqual(bad.status, 1, "an unwritable data folder is a blocking problem");
  assert.ok(/Audit database folder is not writable/.test(bad.stdout), bad.stdout);
  const esc = run(["doctor", "--data-dir", join(dir, "d")], { DISPLAY: "\u001b[2J:99", ANTHROPIC_API_KEY: "x" });
  assert.ok(!/\u001b/.test(esc.stdout), "a hostile DISPLAY cannot put control codes on the terminal");
  assert.ok(/agent-loop doctor/.test(run([]).stdout), "doctor is in the help");
  // a desktop target that cannot start says why, not just that it could not
  if (process.platform === "linux") {
    const base = mkdtempSync(join(tmpdir(), "agent-loop-doctor-desk-"));
    const { freePort } = await import("./ui-extras-helpers.mjs");
    const port = await freePort();
    const d = run(["run", "do a thing", "--desktop-target", "Some App", "--dir", join(base, "w"), "--data-dir", join(base, "d"), "--port", String(port)]);
    assert.strictEqual(d.status, 1);
    assert.ok(/Error: desktop target not available/.test(d.stderr), d.stderr);
    assert.ok(/No display/.test(d.stderr), `with no DISPLAY the failure is named: ${d.stderr}`);
  }
  ok("CLI: doctor prints, exits 1 only for a blocking problem, never prints a credential, strips control bytes; a desktop target that cannot start names the cause");
}

console.log("\nALL DOCTOR TESTS PASSED");
