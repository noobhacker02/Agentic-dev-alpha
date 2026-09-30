// The real driver adapter (src/desktop-driver-cua.ts) against a stand-in for @trycua/cua-driver's SDK.
// The real SDK exposes far more than desktop tools may touch -- clipboard read/write, full-desktop
// capture, launching and killing apps, window moves, menus, hotkeys, recording -- and this test's job
// is to prove the adapter reaches none of it: the stand-in records every call, and any method not on
// the short allowlist is a trap that fails the test if it is ever touched.
//
// What this does not prove -- the real native library behaving -- is covered by test/desktop-real.mjs.
// Requires: npm run build (dist/ must exist).
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { openCuaDriver, CUA_EXPECTED_VERSION, CUA_PACKAGE, readProcessIdentity, toDriverKey, assertAllowedGenericTool } from "../dist/desktop-driver-cua.js";

const ALLOWED_SDK_METHODS = new Set(["metadata", "listWindows", "getWindowState", "click", "callTool", "shutdown", "uniffiDestroy"]);
const ALLOWED_GENERIC_TOOLS = new Set(["type_text", "press_key"]);

function makeSdk(over = {}) {
  const log = { calls: [], trapped: [], generic: [] };
  const record = (name, arg) => log.calls.push([name, arg]);
  const impl = {
    async metadata() { return { driverVersion: over.version ?? CUA_EXPECTED_VERSION }; },
    async listWindows(input) {
      record("listWindows", input);
      return { windows: [{ pid: 10, windowId: 4194336n, appName: "Tk", title: "App", bounds: { x: 1, y: 2, width: 300, height: 200 }, isOnScreen: true, zIndex: 0n }] };
    },
    async getWindowState(input) {
      record("getWindowState", input);
      return {
        pid: input.pid, windowId: input.windowId, snapshotId: "s00000001", screenshotWidth: 300, screenshotHeight: 200, screenshotFrameValid: over.frameValid ?? true,
        windowBounds: over.noBounds ? undefined : { x: 1, y: 2, width: 300, height: 200 }, degraded: true, degradedReason: "atspi_walk_failed", truncated: false,
        elements: [{ elementIndex: 3n, role: "push button", depth: 1, label: "Go", elementToken: "s00000001:3", enabled: true }],
        images: over.noImage ? [] : [{ mimeType: "image/png", dataBase64: Buffer.from("png-bytes").toString("base64") }],
      };
    },
    async click(input) {
      record("click", input);
      if (over.clickThrows) throw over.clickThrows;
      return { effect: over.clickEffect ?? 2, summary: "Clicked" };
    },
    async callTool(name, json) {
      log.generic.push([name, JSON.parse(json)]);
      record("callTool", name);
      if (!ALLOWED_GENERIC_TOOLS.has(name)) log.trapped.push(`callTool(${name})`);
      return { isError: over.toolError ?? false, text: over.toolError ? "background_unavailable" : "Typed" };
    },
    async shutdown() { record("shutdown"); },
    uniffiDestroy() { record("uniffiDestroy"); },
  };
  // Every other property is a booby trap: clipboardRead, getDesktopState, setWindowFrame, hotkey, listApps...
  const driverInstance = new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return (...args) => { log.trapped.push(String(prop)); throw new Error(`FORBIDDEN driver method touched: ${String(prop)}`); };
    },
  });
  // Enough of the SDK's record factories for the adapter to build its inputs; each just carries its fields.
  const make = (kind) => ({ new: (fields) => ({ kind, ...fields }) });
  const sdk = {
    CuaDriver: { create: () => driverInstance },
    ListWindowsInput: make("ListWindowsInput"),
    GetWindowStateInput: make("GetWindowStateInput"),
    ClickInput: make("ClickInput"),
    ActionTarget: { Window: make("Window") },
    ClickPosition: { Coordinates: make("Coordinates"), Element: make("Element") },
    InputDeliveryMode: { Background: 0, Foreground: 1 },
    ClickButton: { Left: 0, Right: 1, Middle: 2 },
    ActionEffect: { Confirmed: 0, Partial: 1, Unverifiable: 2, SuspectedNoop: 3, Refused: 4 },
  };
  return { sdk, log };
}

const W = { pid: 10, windowId: "4194336" };

// ---------------------------------------------------------------- the whole surface, nothing else
{
  const { sdk, log } = makeSdk();
  const d = await openCuaDriver({ loadSdk: async () => sdk, identity: async () => ({ name: "x" }) });
  assert.strictEqual(d.version, CUA_EXPECTED_VERSION);

  const wins = await d.listWindows(10);
  assert.deepStrictEqual(wins, [{ pid: 10, windowId: "4194336", appName: "Tk", title: "App", bounds: { x: 1, y: 2, width: 300, height: 200 } }], "bigint window ids become strings");
  await d.listWindows();
  assert.strictEqual(log.calls.find((c) => c[0] === "listWindows")[1].pid, 10, "a pid filter is passed through");
  assert.strictEqual(log.calls.filter((c) => c[0] === "listWindows")[1][1].pid, undefined);

  const cap = await d.capture(W);
  assert.ok(cap.png.equals(Buffer.from("png-bytes")) && cap.width === 300 && cap.height === 200 && cap.degraded && cap.elements[0].token === "s00000001:3" && cap.elements[0].index === 3);
  const stateArg = log.calls.find((c) => c[0] === "getWindowState")[1];
  assert.strictEqual(stateArg.windowId, 4194336n);
  assert.ok(stateArg.includeScreenshot && stateArg.includeAccessibilityTree, "a window capture is requested, never a desktop-wide one");

  assert.deepStrictEqual(await d.click(W, { x: 5, y: 6, button: "right", count: 2 }), { ok: true, summary: "Clicked" });
  assert.deepStrictEqual(await d.clickElement(W, "s00000001:3"), { ok: true, summary: "Clicked" });
  const clicks = log.calls.filter((c) => c[0] === "click").map((c) => c[1]);
  for (const c of clicks) {
    assert.strictEqual(c.deliveryMode, 1, "foreground delivery, which fails closed when the target can't take focus");
    assert.strictEqual(c.target.kind, "Window", "a click always names a window target, never the desktop");
    assert.deepStrictEqual([c.target.pid, c.target.windowId], [10, 4194336n]);
  }
  assert.deepStrictEqual([clicks[0].position.kind, clicks[0].position.x, clicks[0].position.y, clicks[0].button, clicks[0].count], ["Coordinates", 5, 6, 1, 2]);
  assert.deepStrictEqual([clicks[1].position.kind, clicks[1].position.elementToken], ["Element", "s00000001:3"]);

  await d.typeText(W, "hello");
  await d.pressKey(W, "c", ["ctrl"]);
  await d.pressKey(W, "Enter", []);
  assert.deepStrictEqual(log.generic.map((g) => g[0]), ["type_text", "press_key", "press_key"]);
  for (const [, args] of log.generic) {
    assert.strictEqual(args.delivery_mode, "foreground");
    assert.strictEqual(args.pid, 10, "typing and key presses always name the window's pid...");
    assert.strictEqual(args.window_id, 4194336, "...and its window id -- without them the driver would send keys to whatever has focus");
  }
  assert.deepStrictEqual(log.generic[1][1].modifiers, ["ctrl"]);
  assert.ok(!("modifiers" in log.generic[2][1]), "no modifiers field when there are none");

  await d.pressKey(W, "ArrowDown", []);
  assert.strictEqual(log.generic.at(-1)[1].key, "Down", "ArrowDown is spelled Down for the driver, which rejects 'ArrowDown'");
  for (const [ours, theirs] of [["ArrowUp", "Up"], ["arrowleft", "Left"], ["ARROWRIGHT", "Right"], ["Enter", "Enter"], ["PageUp", "PageUp"], ["F5", "F5"], ["a", "a"]]) {
    assert.strictEqual(toDriverKey(ours), theirs);
  }

  await d.close();
  assert.deepStrictEqual(log.trapped, [], `the adapter touched driver methods it must never reach: ${log.trapped}`);
  for (const [name] of log.calls) assert.ok(ALLOWED_SDK_METHODS.has(name), `unexpected SDK method ${name}`);
  assert.ok(log.calls.some((c) => c[0] === "shutdown") && log.calls.some((c) => c[0] === "uniffiDestroy"), "close shuts the driver down and releases it");
  console.log("[ok] adapter: listWindows, getWindowState, click, type_text and press_key only -- zero trapped calls (no clipboard, desktop capture, app launch/kill, window moves, menus, hotkeys); every input names pid + window id with foreground delivery");
}

// ---------------------------------------------------------------- the generic door opens for two tools
{
  // The generic tool entry point reaches all ~60 of the driver's tools. Its gate, hit directly:
  for (const ok of ["type_text", "press_key"]) assert.doesNotThrow(() => assertAllowedGenericTool(ok));
  for (const bad of ["clipboard_read", "clipboard_write", "get_desktop_state", "launch_app", "kill_app", "hotkey", "set_config", "replay_trajectory", "browser_navigate", "set_window_frame", "invoke_menu", "start_recording", "type_text ", "TYPE_TEXT", ""]) {
    assert.throws(() => assertAllowedGenericTool(bad), /refuses to call driver tool/, `driver tool ${JSON.stringify(bad)} must be unreachable`);
  }
  console.log("[ok] adapter: the generic tool gate opens for type_text and press_key only (clipboard, desktop state, launch/kill app, hotkey, config, replay, browser tools all refused)");
}
{
  // The only route to the driver's broad tool surface is callTool. The adapter's own allowlist is the gate,
  // so prove it can't be talked into another name: there is no code path that passes one, and a direct
  // attempt through the exported helper surface doesn't exist. We assert that by exhausting the public API.
  const { sdk, log } = makeSdk();
  const d = await openCuaDriver({ loadSdk: async () => sdk, identity: async () => undefined });
  assert.deepStrictEqual(Object.keys(d).sort(), ["capture", "click", "clickElement", "close", "listWindows", "pressKey", "processIdentity", "typeText", "version"].sort(), "the adapter's public surface is exactly the DesktopDriver interface");
  for (const k of ["clipboardRead", "clipboardWrite", "getDesktopState", "callTool", "launchApp", "killApp", "hotkey", "setWindowFrame"]) assert.strictEqual(d[k], undefined, `${k} must not exist on the adapter`);
  await d.close();
  assert.deepStrictEqual(log.trapped, []);
  console.log("[ok] adapter: its public surface is exactly the DesktopDriver interface; clipboard, desktop capture, app launch/kill, hotkey and window-frame methods don't exist on it");
}

// ---------------------------------------------------------------- pins and failure modes
{
  const { sdk, log } = makeSdk({ version: "0.31.0" });
  await assert.rejects(() => openCuaDriver({ loadSdk: async () => sdk }), /reports version 0\.31\.0.*pinned to 0\.30\.4/);
  assert.ok(log.calls.some((c) => c[0] === "shutdown"), "a refused driver is shut down, not left loaded");
  assert.strictEqual(log.calls.filter((c) => ["listWindows", "getWindowState", "click", "callTool"].includes(c[0])).length, 0, "an unreviewed driver version is never asked to do anything");

  await assert.rejects(() => openCuaDriver({ loadSdk: async () => { throw new Error("Cannot find package"); } }), new RegExp(`${CUA_PACKAGE.replace("/", "\\/")}@${CUA_EXPECTED_VERSION}[\\s\\S]*Cannot find package|npm install`));

  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.strictEqual(pkg.optionalDependencies?.[CUA_PACKAGE], CUA_EXPECTED_VERSION, "package.json pins the driver exactly, as an optional dependency");
  assert.strictEqual(pkg.dependencies?.[CUA_PACKAGE], undefined, "it is not a hard dependency");
  assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.optionalDependencies[CUA_PACKAGE]), "no range operator: an exact version");
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const entry = lock.packages?.[`node_modules/${CUA_PACKAGE}`];
  assert.ok(entry?.integrity?.startsWith("sha512-") && entry.version === CUA_EXPECTED_VERSION, "the lockfile carries the driver's integrity hash");
  console.log("[ok] adapter: a driver reporting another version is refused before it does anything; a missing package gets an install hint; the pin is exact, optional, and integrity-locked");
}
{
  for (const [over, re] of [[{ noImage: true }, /no screenshot/], [{ frameValid: false }, /does not match the window's current frame/], [{ noBounds: true }, /no window bounds/]]) {
    const { sdk } = makeSdk(over);
    const d = await openCuaDriver({ loadSdk: async () => sdk });
    await assert.rejects(() => d.capture(W), re);
  }
  await assert.rejects(async () => { const { sdk } = makeSdk(); const d = await openCuaDriver({ loadSdk: async () => sdk }); await d.typeText({ pid: 1, windowId: "9007199254740993" }, "x"); }, /without losing precision/);
  await assert.rejects(async () => { const { sdk } = makeSdk(); const d = await openCuaDriver({ loadSdk: async () => sdk }); await d.typeText({ pid: 1, windowId: "abc" }, "x"); }, /without losing precision/);

  // Driver-side refusals come back as { ok: false }, never as a throw that skips the tools' fences.
  let { sdk, log } = makeSdk({ clickThrows: { inner: { message: "Background delivery is not available", errorCode: "background_unavailable" } } });
  let d = await openCuaDriver({ loadSdk: async () => sdk });
  assert.deepStrictEqual(await d.click(W, { x: 1, y: 1, button: "left", count: 1 }), { ok: false, summary: "background_unavailable: Background delivery is not available" });
  ({ sdk } = makeSdk({ clickEffect: 4 }));
  d = await openCuaDriver({ loadSdk: async () => sdk });
  assert.strictEqual((await d.click(W, { x: 1, y: 1, button: "left", count: 1 })).ok, false, "an action the driver reports as refused is not ok");
  ({ sdk } = makeSdk({ toolError: true }));
  d = await openCuaDriver({ loadSdk: async () => sdk });
  assert.strictEqual((await d.typeText(W, "x")).ok, false);
  assert.strictEqual((await d.pressKey(W, "a", [])).ok, false);
  console.log("[ok] adapter: missing screenshot/bounds or an invalid frame fail the capture; imprecise window ids are refused; driver refusals come back as ok:false");
}

// ---------------------------------------------------------------- process identity comes from the OS
{
  if (process.platform === "linux") {
    const id = await readProcessIdentity(process.pid);
    assert.ok(id && /node/i.test(id.name) && id.exe && /node/.test(id.exe), `this process should identify as node, got ${JSON.stringify(id)}`);
    assert.ok(id.script?.endsWith("desktop-adapter.mjs"), `the script run through the interpreter is captured: ${id.script}`);
    assert.strictEqual(await readProcessIdentity(2 ** 22 + 12345), undefined, "an unknown pid has no identity (the caller then refuses)");
    assert.strictEqual(await readProcessIdentity(-1), undefined);
    console.log("[ok] adapter: process identity is read from /proc (name, exe, interpreter script); an unknown pid has none");
  } else {
    console.log(`[skip] process identity is only exercised on Linux in this suite (platform: ${process.platform})`);
  }
}

console.log("\nALL DESKTOP ADAPTER TESTS PASSED");
