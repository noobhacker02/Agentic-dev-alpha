// The driver's own fail-closed behaviour, checked rather than assumed: with no window manager the target can't
// be made the active window, and the driver must then send *nothing* (not fall back to whatever has focus).
// Reads are unaffected. Run with the window manager left out:
//   AGENT_LOOP_TEST_NO_WM=1 bash test/desktop-real.sh test/desktop-real-nowm.mjs
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../dist/bus.js";
import { DesktopSession, __testDesktopHandlers } from "../dist/desktop-tools.js";
import { openCuaDriver } from "../dist/desktop-driver-cua.js";
import { findPythonWithTk, startApp, skipOrFail, until, sleep } from "./desktop-real-helpers.mjs";

if (!process.env.DISPLAY) skipOrFail("no DISPLAY; run this through test/desktop-real.sh");
if (process.env.AGENT_LOOP_TEST_NO_WM !== "1") skipOrFail("this test needs a display with NO window manager (AGENT_LOOP_TEST_NO_WM=1)");
const python = findPythonWithTk();
if (!python) skipOrFail("no Python with tkinter found (apt install python3-tk)");

const title = `NoWM Target ${process.pid}`;
const app = startApp(python, { title });
const driver = await openCuaDriver();
let session;
try {
  assert.ok(await app.ready());
  session = await until(async () => {
    try {
      return await DesktopSession.open({ target: title, driver, runId: "nowm", bus: new EventBus(), artifactDir: mkdtempSync(join(tmpdir(), "agent-loop-nowm-")), requireApproval: true });
    } catch (e) {
      return /No window matches/.test(String(e.message)) ? undefined : Promise.reject(e);
    }
  }, 10_000, 300);
  assert.ok(session, "the window should be listed even with no window manager");
  const h = __testDesktopHandlers(session);
  const call = async (name, args = {}) => {
    const res = await h[name].handler(args, {});
    return { text: res.content[0]?.text ?? "", isError: Boolean(res.isError) };
  };

  // Reading works: a capture needs no focus.
  const cap = await call("capture");
  assert.ok(!cap.isError, cap.text);
  console.log("[ok] without a window manager, capture (read-only) still works");

  // Every input is refused, by the driver, with nothing sent.
  const before = app.events().length;
  for (const [name, mk] of [
    ["click", (s) => ({ x: 120, y: 50, snapshotId: s })],
    ["type_text", (s) => ({ text: "hello", snapshotId: s })],
    ["key", (s) => ({ key: "x", snapshotId: s })],
  ]) {
    const s = /Snapshot (dshot-\d+)/.exec((await call("capture")).text)[1];
    const r = await call(name, mk(s));
    assert.ok(r.isError && /driver refused the action[\s\S]*foreground_unavailable|foreground_unavailable/.test(r.text), `${name} must be refused when the target can't be focused: ${r.text}`);
  }
  await sleep(800);
  assert.strictEqual(app.events().length, before, `nothing may reach the window: ${JSON.stringify(app.events().slice(before))}`);
  console.log("[ok] T5-adjacent: with no window manager the target can't be focused, so click, type_text and key are each refused by the driver and the app's own log shows nothing arrived (the driver fails closed rather than sending to whatever has focus)");
} finally {
  await session?.close("completed").catch(() => {});
  if (!session) await driver.close().catch(() => {});
  app.kill();
}
console.log("\nALL REAL NO-WINDOW-MANAGER TESTS PASSED");
process.exit(0);
