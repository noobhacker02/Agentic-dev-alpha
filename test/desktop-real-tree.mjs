// `click` by element ref against a REAL accessibility tree: a GTK window exposes a labelled button, a text
// entry and a password entry over AT-SPI, the real driver returns real element tokens, and the tools turn
// them into refs. Until now that path was only exercised against the scripted fake. Effects are read from
// the app's own state file.
//
//   bash test/desktop-real.sh test/desktop-real-tree.mjs      (needs python3-gi + gir1.2-gtk-3.0)
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../dist/bus.js";
import { DesktopSession, __testDesktopHandlers } from "../dist/desktop-tools.js";
import { openCuaDriver } from "../dist/desktop-driver-cua.js";
import { findPythonWithGtk, startApp, skipOrFail, until, waitForWindowManager, GTK_APP } from "./desktop-real-helpers.mjs";

if (!process.env.DISPLAY) skipOrFail("no DISPLAY; run this through test/desktop-real.sh");
const python = findPythonWithGtk();
if (!python) skipOrFail("no Python with GTK 3 bindings found (apt install python3-gi gir1.2-gtk-3.0)");

const title = `Tree Target ${process.pid}`;
const app = startApp(python, { title, script: GTK_APP });
const driver = await openCuaDriver();
let session;
try {
  assert.ok(await app.ready(), "the GTK app should start");
  session = await until(async () => {
    try {
      return await DesktopSession.open({ target: title, driver, runId: "tree", bus: new EventBus(), artifactDir: mkdtempSync(join(tmpdir(), "agent-loop-tree-")), requireApproval: true });
    } catch (e) {
      return /No window matches/.test(String(e.message)) ? undefined : Promise.reject(e);
    }
  }, 12_000, 300);
  assert.ok(session, "the GTK window should be listed");
  await waitForWindowManager(driver, { pid: session.target.pid, windowId: session.target.windowId }, { x: 410, y: 250 });
  const h = __testDesktopHandlers(session);
  const call = async (name, args = {}) => {
    const res = await h[name].handler(args, {});
    return { text: res.content[0]?.text ?? "", isError: Boolean(res.isError) };
  };
  const ok = async (name, args) => {
    const r = await call(name, args);
    assert.ok(!r.isError, `${name}(${JSON.stringify(args)}): ${r.text}`);
    return r;
  };
  /** Capture, and return the snapshot id plus a name -> ref map read off the tree lines. */
  const look = async () => {
    const r = await ok("capture");
    const snap = /Snapshot (dshot-\d+)/.exec(r.text)[1];
    const refs = {};
    for (const m of r.text.matchAll(/^\s*\[(d\d+e\d+)\] (\S+) "([^"]*)"/gm)) refs[m[3]] = { ref: m[1], role: m[2] };
    return { text: r.text, snap, refs };
  };

  // ---- the real tree reaches the model as refs, with roles and names
  let v = await look();
  assert.ok(!/unavailable or partial/.test(v.text), `the tree should be real, not degraded:\n${v.text}`);
  assert.deepStrictEqual(Object.keys(v.refs).sort(), ["Increment", "Name", "Password"].sort(), `the three labelled controls: ${JSON.stringify(v.refs)}`);
  assert.strictEqual(v.refs.Increment.role, "push-button");
  assert.strictEqual(v.refs.Password.role, "password-text");
  console.log("[ok] a real accessibility tree: push-button \"Increment\", text \"Name\", password-text \"Password\", each with a ref");

  // ---- click by ref presses the real button
  await ok("click", { ref: v.refs.Increment.ref });
  assert.ok(await until(() => app.last("click")?.count === 1, 5000), `the real GTK button should have been pressed by its element token; log: ${JSON.stringify(app.events().slice(-3))}`);
  console.log("[ok] click by ref: the GTK app's own log shows its button was pressed through a real element token");

  // ---- focus a field by ref, type into it, and read the value back through the tree
  v = await look();
  await ok("click", { ref: v.refs.Name.ref });
  v = await look();
  await ok("type_text", { text: "alice", snapshotId: v.snap });
  assert.ok(await until(() => app.last("text")?.text === "alice", 5000), `the typed text should reach the entry; log: ${JSON.stringify(app.events().slice(-3))}`);
  v = await look();
  assert.ok(/text "Name" value="alice"/.test(v.text), `a filled text field shows its value in the tree:\n${v.text}`);
  console.log("[ok] click a text field by ref, type into it, and the tree then shows value=\"alice\"");

  // ---- a password field's value never reaches the model
  await ok("click", { ref: v.refs.Password.ref });
  v = await look();
  await ok("type_text", { text: "hunter2", snapshotId: v.snap });
  assert.ok(await until(() => app.last("secret-changed")?.length === 7, 5000), `seven characters should have reached the password entry; log: ${JSON.stringify(app.events().slice(-2))}`);
  v = await look();
  assert.ok(!v.text.includes("hunter2"), "the typed password must never appear in what the model reads back");
  assert.ok(/password-text "Password"/.test(v.text));
  console.log("[ok] typing into the password entry works, and the model's view of the window never shows what was typed");

  // ---- refs from an earlier capture are refused, against the real window
  const stale = v.refs.Increment.ref;
  await look();
  const before = app.events().length;
  const r = await call("click", { ref: stale });
  assert.ok(r.isError && /Stale snapshotId/.test(r.text), r.text);
  assert.strictEqual(app.events().length, before, "a stale ref reaches nothing");
  console.log("[ok] a ref from an earlier capture is refused and nothing reaches the window");
} finally {
  await session?.close("completed").catch(() => {});
  if (!session) await driver.close().catch(() => {});
  app.kill();
}
console.log("\nALL REAL ACCESSIBILITY-TREE TESTS PASSED");
process.exit(0);
