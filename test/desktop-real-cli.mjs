// The whole command line, end to end, against a real window: `agent-loop run ... --desktop-target "<title>"`
// with the real native driver, a real native window and the scripted fake model (no API calls). The other
// suites call the pieces directly; this is the one that runs cli.ts's own glue on the success path: the
// driver loading, the target resolving, the startup lines a person reads, the session starting with the run
// and ending with it, and `agent-loop insights` seeing it afterwards.
//
//   bash test/desktop-real.sh test/desktop-real-cli.mjs
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPythonWithTk, startApp, skipOrFail, until } from "./desktop-real-helpers.mjs";
import { fileURLToPath } from "node:url";

if (!process.env.DISPLAY) skipOrFail("no DISPLAY; run this through test/desktop-real.sh");
const python = findPythonWithTk();
if (!python) skipOrFail("no Python with tkinter found (apt install python3-tk)");

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fakeSdk = new URL("./stress/fake-sdk/register.mjs", import.meta.url).href;
const scratch = mkdtempSync(join(tmpdir(), "agent-loop-desktop-cli-real-"));
const title = `CLI Real Target ${process.pid}`;
const app = startApp(python, { title });
const sh = (args, env = {}) =>
  spawnSync(process.execPath, ["--experimental-sqlite", "--no-warnings", ...args], { encoding: "utf8", timeout: 120_000, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
try {
  assert.ok(await app.ready());
  // Give the window a moment to be listed by the driver.
  await until(() => true, 1500, 100);

  const common = ["--import", fakeSdk, cli, "run", "build a thing", "--dir", join(scratch, "ws"), "--data-dir", join(scratch, "data"), "--port", "0"];
  let r;
  for (let attempt = 0; attempt < 5; attempt++) {
    r = sh([...common, "--desktop-target", title], { FAKE_SCENARIO: "trivial-skip" });
    if (!/No window matches/.test(r.stdout + r.stderr)) break; // the window can take a moment to appear in the list
    await until(() => false, 800, 100);
  }
  const out = `${r.stdout}${r.stderr}`;
  assert.strictEqual(r.status, 0, `the run should finish cleanly:\n${out.slice(-900)}`);
  assert.ok(/agent-loop UI: http:\/\/127\.0\.0\.1:\d+\/#token=/.test(out), "the approval UI came up first");
  const on = /Desktop tools: ON — builder\/verifier may see and operate ONLY (.+)/.exec(out);
  assert.ok(on, `the startup line names the one window:\n${out.slice(0, 900)}`);
  assert.ok(new RegExp(`python.* \\(pid ${app.proc.pid}, window \\d+\\) "${title}`).test(on[1]), `it names this app's real pid and title: ${on[1]}`);
  assert.ok(/driver 0\.30\.4; every input action asks, one at a time/.test(out), "it says which driver and that every action asks");
  assert.ok(/finished with status: done/.test(out));
  console.log(`[ok] the CLI resolves a real window, says exactly which one (${on[1].slice(0, 70)}), and the run finishes`);

  // The session was started with the run and ended with it, and insights sees it.
  const ins = sh([cli, "insights", "--data-dir", join(scratch, "data")]);
  assert.strictEqual(ins.status, 0, ins.stderr);
  assert.ok(/Desktop tools: 1 session\(s\), 0 capture\(s\)/.test(ins.stdout), `insights should count the session:\n${ins.stdout}`);
  console.log("[ok] `agent-loop insights` afterwards counts the desktop session");

  // Ambiguity and absence, at the command line, with the same real driver.
  const none = sh([...common.slice(0, -2), "--port", "0", "--desktop-target", `No Such Window ${process.pid}`], { FAKE_SCENARIO: "trivial-skip" });
  assert.strictEqual(none.status, 1);
  assert.ok(/desktop target not available\. No window matches/.test(none.stdout + none.stderr), none.stdout + none.stderr);
  assert.ok(!/finished with status/.test(none.stdout), "no run starts when the target can't be resolved");
  console.log("[ok] a name matching no real window fails at startup, before any run");
} finally {
  app.kill();
}
console.log("\nALL REAL DESKTOP CLI TESTS PASSED");
process.exit(0);
