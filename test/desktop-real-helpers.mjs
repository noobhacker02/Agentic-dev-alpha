// Shared by the real-driver desktop tests: find a Python with tkinter, launch the tiny native test app
// (test/desktop-app/app.py), and read back its state file -- a channel independent of the driver and of
// the tool results under test.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, symlinkSync, appendFileSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = fileURLToPath(new URL("./desktop-app/app.py", import.meta.url));
export const DECOY = fileURLToPath(new URL("./desktop-app/decoy.py", import.meta.url));
export const GTK_APP = fileURLToPath(new URL("./desktop-app/gtk_app.py", import.meta.url));

/** A copy of the test app under another file name, so the interpreter's script (argv[1]) says what you like. */
export function copyAppAs(name) {
  const dir = mkdtempSync(join(tmpdir(), "agent-loop-script-"));
  const path = join(dir, name);
  copyFileSync(APP, path);
  return path;
}

/** Missing prerequisites are a skip locally and a failure in CI (REQUIRE_DESKTOP_REAL=1): a check that
 * silently didn't run is the failure mode this whole project keeps finding. */
export function skipOrFail(reason) {
  if (process.env.REQUIRE_DESKTOP_REAL === "1") {
    console.error(`FAIL: ${reason} (REQUIRE_DESKTOP_REAL=1, so this is not allowed to be skipped)`);
    process.exit(1);
  }
  console.log(`[skip] ${reason}`);
  process.exit(0);
}

export function findPythonWithTk() {
  const candidates = [process.env.AGENT_LOOP_TEST_PYTHON, "python3", "/usr/bin/python3", "/usr/bin/python3.12", "python3.12", "python3.13", "python3.11"].filter(Boolean);
  for (const py of candidates) {
    const r = spawnSync(py, ["-c", "import tkinter"], { encoding: "utf8" });
    if (r.status === 0) return py;
  }
  return undefined;
}

/** A Python that can import GTK 3 (python3-gi + gir1.2-gtk-3.0), for the test that needs a real accessibility tree. */
export function findPythonWithGtk() {
  const candidates = [process.env.AGENT_LOOP_TEST_PYTHON, "/usr/bin/python3", "python3", "/usr/bin/python3.12", "python3.12", "/usr/bin/python3.13"].filter(Boolean);
  for (const py of candidates) {
    const r = spawnSync(py, ["-c", "import gi; gi.require_version('Gtk','3.0'); from gi.repository import Gtk"], { encoding: "utf8" });
    if (r.status === 0) return py;
  }
  return undefined;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 8000, step = 80) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return undefined;
}

/**
 * Starts the test app. `asName` runs it through a symlink of the interpreter with that name, so the
 * process's own name (/proc/<pid>/comm) is, say, "xterm" while its window title says something innocent.
 */
export function startApp(python, { title, asName, geometry, script = APP } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-loop-app-"));
  const stateFile = join(dir, "state.jsonl");
  const cmdFile = join(dir, "commands.txt");
  let exe = python;
  if (asName) {
    const real = spawnSync("sh", ["-c", `command -v ${python}`], { encoding: "utf8" }).stdout.trim() || python;
    exe = join(dir, asName);
    symlinkSync(real, exe);
  }
  const proc = spawn(exe, [script, title], {
    stdio: "ignore",
    env: { ...process.env, AGENT_LOOP_TEST_APP_STATE: stateFile, AGENT_LOOP_TEST_APP_CMD: cmdFile, ...(geometry ? { AGENT_LOOP_TEST_APP_GEOMETRY: geometry } : {}) },
  });
  const events = () => (existsSync(stateFile) ? readFileSync(stateFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    proc,
    stateFile,
    /** Tell the running app to move, resize, retitle or iconify itself (see test/desktop-app/app.py). */
    command: (line) => appendFileSync(cmdFile, line + "\n"),
    events,
    ready: () => until(() => events().some((e) => e.event === "ready"), 10_000),
    last: (kind) => events().filter((e) => e.event === kind).pop(),
    kill: () => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } },
  };
}

/** PNG width and height from the IHDR chunk. */
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Waits until the window manager can activate windows. The driver fails closed -- "foreground_unavailable:
 * ... no input was sent" -- until the WM has set _NET_ACTIVE_WINDOW, and a WM that has only just started
 * hasn't yet, so the first real action of a test run would otherwise race it. Probes with a click in an
 * empty corner of the test app (nothing there to press) through the driver directly.
 */
export async function waitForWindowManager(driver, target, { x = 405, y = 245 } = {}) {
  let last = "";
  const ok = await until(async () => {
    const r = await driver.click(target, { x, y, button: "left", count: 1 });
    last = r.summary;
    return r.ok;
  }, 20_000, 400);
  if (!ok) {
    const wm = spawnSync("pgrep", ["-x", "openbox"], { encoding: "utf8" }).stdout.trim() ? "openbox is running" : "openbox is NOT running";
    throw new Error(`the window manager never became ready to focus windows (${wm}); last driver answer: ${last}`);
  }
}

/** A Chromium to decode PNGs in: $AGENT_LOOP_CHROME_PATH, the sandbox's pre-installed one when present, or
 * undefined to let playwright-core resolve its own install (what CI has, after `playwright-core install`). */
export function findChrome() {
  if (process.env.AGENT_LOOP_CHROME_PATH) return process.env.AGENT_LOOP_CHROME_PATH;
  const root = "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => d.startsWith("chromium-"));
  const exe = dir && join(root, dir, "chrome-linux", "chrome");
  return exe && existsSync(exe) ? exe : undefined;
}
