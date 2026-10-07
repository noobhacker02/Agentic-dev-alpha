// The last-resort handlers (src/fatal.ts): an error nothing caught stops the run the ordinary way instead of ending the process with the browser running and the run left "running"
// (adversary round 2, A39 and A41). The events come from a stand-in emitter and the clock is mocked, so nothing waits and nothing real is thrown.
//   npm run build && npm run test:fatal
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { mock } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installFatalHandlers } from "../dist/fatal.js";
import { Store } from "../dist/store.js";
import { freePort } from "./ui-extras-helpers.mjs";

const rig = (graceMs) => {
  const target = new EventEmitter();
  const calls = { stop: [], exit: [], log: [] };
  const remove = installFatalHandlers({ target, stop: (w) => calls.stop.push(w), exit: (c) => calls.exit.push(c), log: (m) => calls.log.push(m), graceMs });
  return { target, calls, remove };
};

// 1. The first error stops the run, with the reason, and does not quit.
{
  const { target, calls, remove } = rig();
  target.emit("uncaughtException", new RangeError("Invalid status code: 99"));
  assert.strictEqual(calls.stop.length, 1, "the first error did not stop the run");
  assert.ok(/unexpected error \(RangeError: Invalid status code: 99\)/.test(calls.stop[0]), `the reason does not name the error: ${calls.stop[0]}`);
  assert.deepStrictEqual(calls.exit, [], "the first error quit the process instead of stopping the run");
  assert.ok(calls.log.some((l) => /Unexpected error: RangeError/.test(l)), "the error was not shown");
  remove();
  console.log("[ok] an uncaught exception stops the run with its reason and does not quit the process");
}

// 2. A rejected promise is the same; a second error quits at once.
{
  const { target, calls, remove } = rig();
  target.emit("unhandledRejection", new Error("TargetClosedError: route.continue"));
  assert.strictEqual(calls.stop.length, 1);
  assert.ok(/unexpected rejection/.test(calls.stop[0]));
  target.emit("uncaughtException", new Error("another"));
  assert.deepStrictEqual(calls.exit, [1], "a second error did not quit");
  assert.strictEqual(calls.stop.length, 1, "a second error asked for another stop");
  remove();
  console.log("[ok] an unhandled rejection stops the run too; a second error quits at once with status 1");
}

// 3. A run that does not finish stopping is quit after the grace period; one that does is left alone.
{
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const a = rig(5000);
    a.target.emit("uncaughtException", new Error("x"));
    mock.timers.tick(4999);
    assert.deepStrictEqual(a.calls.exit, [], "quit before the grace period ended");
    mock.timers.tick(2);
    assert.deepStrictEqual(a.calls.exit, [1], "a run that never finished stopping was not quit");
    assert.ok(a.calls.log.some((l) => /did not finish stopping/.test(l)));
    const b = rig(5000);
    b.target.emit("uncaughtException", new Error("y"));
    b.remove(); // the run ended and the CLI removed the handlers
    mock.timers.tick(10_000);
    assert.deepStrictEqual(b.calls.exit, [], "the timer outlived the handlers");
  } finally { mock.timers.reset(); }
  console.log("[ok] a run that never finishes stopping is quit after the grace period; one that ends and removes the handlers is not");
}

// 4. The handlers come off, control bytes in an error never reach the log, and removal is complete.
{
  const { target, calls, remove } = rig();
  target.emit("uncaughtException", new Error("\u001b[2J\u001b]0;pwned\u0007 bad\u0000 news \u009b2J"));
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(calls.log.join("") + calls.stop.join("")), "a control byte from an error reached the log or the stop reason");
  remove();
  assert.strictEqual(target.listenerCount("uncaughtException"), 0);
  assert.strictEqual(target.listenerCount("unhandledRejection"), 0);
  console.log("[ok] control bytes in an error are stripped before they are shown, and removing the handlers leaves none behind");
}

// 5. Wired into the real command: an error nobody catches in the middle of a run ends it the ordinary way (saved as stopped, with the reason, report written), not by killing the process
// with the run left "running" in the audit database. The fake SDK and a test-only preload that raises the error once the first model call is in flight; no API calls.
{
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const runCli = async (kind) => {
    const base = mkdtempSync(join(tmpdir(), "agent-loop-fatal-"));
    mkdirSync(join(base, "w"));
    const log = join(base, "calls.log");
    const port = await freePort();
    const child = spawn(process.execPath, ["--experimental-sqlite", "--no-warnings", "--import", "./test/stress/fake-sdk/register.mjs", "--import", "./test/stress/fake-sdk/fatal-preload.mjs", "dist/cli.js", "run", "do the thing", "--dir", join(base, "w"), "--data-dir", join(base, "d"), "--port", String(port), "--no-approval", "--humor", "off"],
      { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_SCENARIO: "trivial-skip", FAKE_LOG: log, FAKE_DELAY_MS: "20000", FATAL_KIND: kind, FATAL_WAIT_FOR_FILE: log } });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
    const started = Date.now();
    const killer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    const code = await new Promise((r) => child.on("close", (c, sig) => r(c ?? sig)));
    clearTimeout(killer);
    const dbPath = join(base, "d", "agent-loop.db");
    const store = existsSync(dbPath) ? new Store(dbPath) : undefined;
    const runs = store ? store.listRuns() : [];
    const events = runs[0] ? store.getRunEvents(runs[0].id) : [];
    store?.close();
    return { code, out, err, runs, events, ms: Date.now() - started };
  };
  for (const [kind, what] of [["rejection", /unexpected rejection \(Error: TargetClosedError: route\.continue\)/], ["throw", /unexpected error \(RangeError: Invalid status code: 99\)/]]) {
    for (let round = 1; round <= 2; round++) {
      const r = await runCli(kind);
      assert.strictEqual(r.runs.length, 1, `${kind}, round ${round}: the run was not recorded (exit ${r.code}): ${(r.out + r.err).slice(-400)}`);
      assert.strictEqual(r.runs[0].status, "stopped", `${kind}, round ${round}: the run is "${r.runs[0].status}" in the audit database, not stopped (exit ${r.code}): ${(r.out + r.err).slice(-400)}`);
      const stop = r.events.find((e) => e.type === "stop-requested");
      assert.ok(stop && what.test(stop.reason), `${kind}, round ${round}: the stop reason does not name the error: ${JSON.stringify(stop)}`);
      assert.ok(/finished with status: stopped/.test(r.out) && /Report: file:/.test(r.out), `${kind}, round ${round}: a stopped run still finishes properly and writes its report: ${r.out.slice(-300)}`);
      assert.ok(new RegExp(`Unexpected ${kind === "throw" ? "error" : "rejection"}:`).test(r.err), `${kind}, round ${round}: the error was not shown: ${r.err.slice(-300)}`);
      assert.ok(r.ms < 60_000, `${kind}, round ${round}: stopping took ${r.ms} ms (the model call lasts 20 s: it should have been cut short)`);
    }
  }
  console.log("[ok] the real command: an uncaught exception and an unhandled rejection in the middle of a run each end it as stopped (reason named, report written, model call cut short), twice each");
}
console.log("\nALL FATAL HANDLER TESTS PASSED");
