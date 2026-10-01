// A video of the desktop tools driving a REAL native window, filmed off a virtual display with ffmpeg: the
// chosen window, a terminal-named window the agent must never touch, "what the agent sees" (the capture
// tool's actual result), clicks and typing landing, a reused capture refused, a window that moved after the
// capture refused. The tools are called through the same handlers a model's calls go through; the approval
// prompt is shown in the other video (desktop-agent-ui), so this one is about what the tools do to a window.
//
// Run it under the virtual display the real-driver tests use (Xvfb + a window manager + dbus):
//   AGENT_LOOP_VIDEO_OUT=/some/dir bash test/desktop-real.sh test/e2e/record-desktop-real.mjs
//
// It ends by checking the claim the video makes: the chosen window got exactly what was sent, and the
// terminal-named decoy's own log shows it received nothing. If that fails, the run fails and no video is kept.
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../dist/bus.js";
import { DesktopSession, __testDesktopHandlers } from "../../dist/desktop-tools.js";
import { openCuaDriver } from "../../dist/desktop-driver-cua.js";
import { findPythonWithTk, startApp, skipOrFail, until, sleep, waitForWindowManager } from "../desktop-real-helpers.mjs";

if (!process.env.DISPLAY) skipOrFail("no DISPLAY; run this through test/desktop-real.sh");
const python = findPythonWithTk();
if (!python) skipOrFail("no Python with tkinter found (apt install python3-tk)");
const out = process.env.AGENT_LOOP_VIDEO_OUT ?? mkdtempSync(join(tmpdir(), "agent-loop-desktop-video-"));
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "agent-loop-desktop-video-work-"));
const captionFile = join(work, "caption.txt");
const viewFile = join(work, "view.png");
const caption = (text) => writeFileSync(captionFile, text);
process.env.AGENT_LOOP_CAPTION_FILE = captionFile;
process.env.AGENT_LOOP_VIEW_FILE = viewFile;

const here = new URL("../desktop-app/", import.meta.url).pathname;
caption("");
const captionWin = startApp(python, { title: "caption", script: join(here, "caption.py") });
const viewer = startApp(python, { title: "viewer", script: join(here, "viewer.py") });
const decoy = startApp(python, { title: "Notes (a normal-looking window)", asName: "xterm", geometry: "380x230+30+440" });
const TITLE = `Notes - demo app ${process.pid}`;
const app = startApp(python, { title: TITLE, geometry: "560x380+30+40" });

let ffmpeg, session, driver;
const raw = join(work, "desktop-real.mp4");
try {
  assert.ok(await app.ready() && await decoy.ready(), "both windows start");
  driver = await openCuaDriver();
  const bus = new EventBus();
  const artifactDir = join(work, "artifacts");
  mkdirSync(artifactDir);

  // The chosen window has to be listed before anything starts.
  session = await until(async () => {
    try { return await DesktopSession.open({ target: TITLE, driver, runId: "video", bus, artifactDir, requireApproval: true }); }
    catch (e) { return /No window matches/.test(String(e.message)) ? undefined : Promise.reject(e); }
  }, 12_000, 300);
  assert.ok(session, "the driver lists the chosen window");
  await waitForWindowManager(driver, { pid: session.target.pid, windowId: session.target.windowId });
  const h = __testDesktopHandlers(session);
  const call = async (name, args = {}) => {
    const r = await h[name].handler(args, {});
    return { text: r.content[0]?.text ?? "", isError: Boolean(r.isError), res: r };
  };
  const snapshot = async () => {
    const r = await call("capture");
    const img = r.res.content.find((c) => c.type === "image");
    writeFileSync(viewFile + ".tmp", Buffer.from(img.data, "base64"));
    renameSync(viewFile + ".tmp", viewFile); // the viewer never sees half a file
    return /Snapshot (dshot-\d+)/.exec(r.text)[1];
  };

  // ---- start filming
  ffmpeg = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "x11grab", "-video_size", "1280x800", "-framerate", "12", "-i", process.env.DISPLAY, "-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-pix_fmt", "yuv420p", "-movflags", "+faststart", raw], { stdio: ["pipe", "ignore", "inherit"] });
  await sleep(1200);

  caption("A real desktop, two windows. The one you chose at startup — and a terminal-named app the agent must never touch (bottom left).");
  await sleep(4500);

  // ---- 1. a terminal as the target is refused before anything starts
  let refusal = "";
  try {
    await DesktopSession.open({ target: "xterm", driver, runId: "video-refused", bus: new EventBus(), artifactDir, requireApproval: true });
  } catch (e) { refusal = String(e.message); }
  assert.ok(refusal, "a terminal-named target is refused");
  caption(`1. Asking to control that terminal-named window is refused up front: “${refusal.replace(/\s+/g, " ").split(/(?<=\.) /)[0].slice(0, 120)}”`);
  await sleep(6500);

  // ---- 2. the chosen window: what the agent sees
  caption(`2. The chosen window: “${TITLE}”. capture returns its pixels only, which is what the agent sees (right).`);
  let snap = await snapshot();
  await sleep(4200);

  // ---- 3. clicks land, each needs a fresh capture
  caption("3. click: window-local coordinates read off a capture. The window's own title counts the clicks.");
  for (let i = 1; i <= 3; i++) {
    const r = await call("click", { x: 120, y: 50, snapshotId: snap });
    assert.ok(!r.isError, `click ${i} should land: ${r.text}`);
    await until(() => app.events().filter((e) => e.event === "click").length >= i, 4000);
    await sleep(1300);
    snap = await snapshot();
    if (i === 1) caption("   Every action needs a fresh capture first (single-use), so it acts on what was actually on screen.");
  }

  // ---- 4. typing
  caption("4. type_text goes to whatever has focus inside that window, so click the field first. The text is exactly what was approved.");
  await call("click", { x: 150, y: 130, snapshotId: snap });
  await sleep(800);
  snap = await snapshot();
  const typed = await call("type_text", { text: "hello from the agent", snapshotId: snap });
  assert.ok(!typed.isError, `typing should land: ${typed.text}`);
  await until(() => app.events().some((e) => e.event === "text" && /hello from the agent/.test(e.text ?? "")), 5000);
  await sleep(1500);
  const afterTyping = await snapshot();
  await sleep(3000);

  // ---- 5. a capture can't be reused
  const stale = await call("click", { x: 120, y: 50, snapshotId: snap });
  assert.ok(stale.isError, "a used capture is refused");
  caption(`5. Reusing an old capture is refused: “${stale.text.replace(/\s+/g, " ").slice(0, 130)}”`);
  await sleep(6500);

  // ---- 6. a window that moved after the capture
  caption("6. The window gets moved after the agent looked. Acting on the old picture would click the wrong thing…");
  const fresh = afterTyping;
  app.command("move 520 260");
  await sleep(1800);
  const moved = await call("click", { x: 120, y: 50, snapshotId: fresh });
  assert.ok(moved.isError, "an action after the window moved is refused");
  caption(`   …so it is refused: “${moved.text.replace(/\s+/g, " ").slice(0, 150)}”`);
  await sleep(6500);

  // ---- 7. the claim, checked
  const clicks = app.events().filter((e) => e.event === "click").length;
  assert.strictEqual(clicks, 3, "exactly the three approved clicks landed");
  const decoyGot = decoy.events().filter((e) => e.event !== "ready" && e.event !== "command");
  assert.deepStrictEqual(decoyGot, [], "the terminal-named window received nothing at all");
  caption(`Checked from the windows' own logs: 3 clicks and the typed text reached the chosen window; the terminal-named one received nothing.`);
  await sleep(6000);
} finally {
  if (ffmpeg) {
    ffmpeg.stdin.write("q\n");
    await new Promise((r) => { ffmpeg.on("exit", r); setTimeout(r, 8000); });
  }
  try { await session?.close(); } catch { /* ignore */ }
  try { await driver?.close(); } catch { /* ignore */ }
  for (const w of [app, decoy, viewer, captionWin]) w.kill();
}
renameSync(raw, join(out, "desktop-real-window.mp4"));
console.log(`[recorded] ${join(out, "desktop-real-window.mp4")}`);
process.exit(0);
