// The real desktop stack, end to end: the real native driver (@trycua/cua-driver), real X11 input, a
// real window manager, a real native window -- driven through the same DesktopSession and tool handlers a
// phase uses. Every claimed effect is verified through the test app's own state file, a channel that is
// independent of the driver and of the tool results being checked.
//
// Run under a virtual display:  bash test/desktop-real.sh test/desktop-real.mjs
// (Xvfb + openbox + dbus; CI sets REQUIRE_DESKTOP_REAL=1 so a missing prerequisite fails instead of skipping.)
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../dist/bus.js";
import { DesktopSession, __testDesktopHandlers } from "../dist/desktop-tools.js";
import { openCuaDriver } from "../dist/desktop-driver-cua.js";
import { findPythonWithTk, startApp, skipOrFail, until, sleep, pngSize } from "./desktop-real-helpers.mjs";

if (!process.env.DISPLAY) skipOrFail("no DISPLAY; run this through test/desktop-real.sh");
const python = findPythonWithTk();
if (!python) skipOrFail("no Python with tkinter found (apt install python3-tk)");

const artifactDir = mkdtempSync(join(tmpdir(), "agent-loop-desktop-real-"));
const title = `AgentLoop Real ${process.pid}`;
const app = startApp(python, { title });
let session;
let driver;
try {
  assert.ok(await app.ready(), "the test app should start and log ready");

  driver = await openCuaDriver();
  assert.strictEqual(driver.version, "0.30.4");
  const bus = new EventBus();
  const events = [];
  bus.on("event", (e) => events.push(e));
  // The window appears in the driver's list a moment after the app says it's ready.
  const opened = await until(async () => {
    try {
      return await DesktopSession.open({ target: title, driver, runId: "real", bus, artifactDir, requireApproval: true });
    } catch (err) {
      return /No window matches/.test(String(err.message)) ? undefined : Promise.reject(err);
    }
  }, 10_000, 300);
  assert.ok(opened, "the driver should list the app's window");
  session = opened;
  const h = __testDesktopHandlers(session);
  const call = async (name, args = {}) => {
    const res = await h[name].handler(args, {});
    return { text: res.content[0]?.text ?? "", isError: Boolean(res.isError), res };
  };
  const ok = async (name, args) => {
    const r = await call(name, args);
    assert.ok(!r.isError, `${name}(${JSON.stringify(args)}) failed: ${r.text}`);
    return r;
  };
  const snap = async () => /Snapshot (dshot-\d+)/.exec((await ok("capture")).text)[1];
  console.log(`[setup] real driver ${driver.version}; target ${session.describeTarget()}`);

  // ---- resolved by process identity read from /proc
  assert.strictEqual(session.target.pid, app.proc.pid, "the target pid is the app's real pid");
  assert.ok(/python/.test(session.target.processName), `process name comes from the OS: ${session.target.processName}`);
  console.log("[ok] target resolved to the app's real window; identity read from /proc, not from the window");

  // ---- capture: only that window's pixels
  const info = await ok("window_info");
  assert.ok(info.text.includes(`pid ${app.proc.pid}`) && /0\.30\.4/.test(info.text), info.text);
  const cap = await ok("capture");
  const png = Buffer.from(cap.res.content.find((c) => c.type === "image").data, "base64");
  const { width, height } = pngSize(png);
  assert.ok(width > 0 && width <= 421 && height > 0 && height <= 261, `the capture is the 420x260 window, not the 1280x800 screen: ${width}x${height}`);
  assert.ok(/Snapshot dshot-1: \d+x\d+ px/.test(cap.text) && /untrusted data/.test(cap.text));
  console.log(`[ok] capture: a real ${width}x${height} PNG of just the target window (the screen is 1280x800); tree ${/unavailable or partial/.test(cap.text) ? "degraded and reported as such" : "present"}`);

  // ---- click: a real X11 click lands in the real window
  let s = await snap();
  const before = app.events().filter((e) => e.event === "click").length;
  await ok("click", { x: 120, y: 50, snapshotId: s }); // the Increment button
  assert.ok(await until(() => app.last("click")?.count === before + 1, 4000), `the real button should have been pressed; state: ${JSON.stringify(app.events().slice(-3))}`);
  console.log("[ok] click: the app's own log shows the real button press");

  // ---- type_text and key: real key events land in the focused entry
  s = await snap();
  await ok("click", { x: 150, y: 130, snapshotId: s }); // the Entry
  s = await snap();
  await ok("type_text", { text: "hello", snapshotId: s });
  assert.ok(await until(() => app.last("text")?.text === "hello", 4000), `typed text should reach the entry; state: ${JSON.stringify(app.events().slice(-3))}`);
  s = await snap();
  await ok("key", { key: "x", snapshotId: s });
  assert.ok(await until(() => app.last("text")?.text === "hellox", 4000), `a key press should reach the entry; state: ${JSON.stringify(app.events().slice(-2))}`);
  s = await snap();
  await ok("key", { key: "Backspace", snapshotId: s });
  assert.ok(await until(() => app.last("text")?.text === "hello", 4000), "Backspace removed the last character");
  // Every named key in the tool's allowlist reaches the window as the keysym the app receives -- including
  // the Arrow* spellings the driver itself rejects, which the adapter maps.
  const expectKeysym = { Enter: "Return", Escape: "Escape", Delete: "Delete", Home: "Home", End: "End", PageUp: "Prior", PageDown: "Next", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Space: "space", F5: "F5", Insert: "Insert" };
  for (const [name, keysym] of Object.entries(expectKeysym)) {
    s = await snap();
    await ok("click", { x: 150, y: 130, snapshotId: s }); // make sure the entry has focus
    s = await snap();
    const n0 = app.events().length;
    await ok("key", { key: name, snapshotId: s });
    assert.ok(await until(() => app.events().slice(n0).some((e) => e.keysym === keysym), 4000), `key ${name} should reach the window as keysym ${keysym}; saw ${JSON.stringify(app.events().slice(n0))}`);
  }
  console.log(`[ok] type_text and key: hello, hellox, hello after Backspace; ${Object.keys(expectKeysym).length} named keys each arrive as the expected keysym`);

  // ---- refused inputs reach nothing
  s = await snap();
  const logLen = app.events().length;
  const r1 = await call("key", { key: "Tab", modifiers: ["alt"], snapshotId: s });
  assert.ok(r1.isError && /Alt\+Tab/.test(r1.text));
  const r2 = await call("type_text", { text: "\u001b[2J", snapshotId: s });
  assert.ok(r2.isError);
  await sleep(500);
  assert.strictEqual(app.events().length, logLen, "refused input never reached the window");
  console.log("[ok] refused chords and text reach nothing (the app's log is unchanged)");

  // ---- a stale snapshot is refused with nothing sent
  const old = await snap();
  await snap();
  const n = app.events().length;
  const stale = await call("click", { x: 120, y: 50, snapshotId: old });
  assert.ok(stale.isError && /Stale snapshotId/.test(stale.text));
  await sleep(500);
  assert.strictEqual(app.events().length, n, "a stale snapshot click never reached the window");
  console.log("[ok] a stale snapshotId is refused with nothing sent to the real window");

  assert.ok(events.some((e) => e.type === "desktop-snapshot" && /\.png$/.test(e.screenshotPath)), "snapshot events carry an artifact path");
  assert.strictEqual(events.filter((e) => e.type === "desktop-action-started").length, events.filter((e) => e.type === "desktop-action-completed").length, "events are paired");
} finally {
  await session?.close("completed").catch(() => {});
  if (!session) await driver?.close().catch(() => {});
  app.kill();
}
console.log("\nALL REAL DESKTOP TESTS PASSED");
process.exit(0);
