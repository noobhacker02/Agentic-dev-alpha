// Shared by the real-driver desktop tests: find a Python with tkinter, launch the tiny native test app
// (test/desktop-app/app.py), and read back its state file -- a channel independent of the driver and of
// the tool results under test.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const APP = new URL("./desktop-app/app.py", import.meta.url).pathname;

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
export function startApp(python, { title, asName, geometry } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-loop-app-"));
  const stateFile = join(dir, "state.jsonl");
  let exe = python;
  if (asName) {
    const real = spawnSync("sh", ["-c", `command -v ${python}`], { encoding: "utf8" }).stdout.trim() || python;
    exe = join(dir, asName);
    symlinkSync(real, exe);
  }
  const proc = spawn(exe, [APP, title], {
    stdio: "ignore",
    env: { ...process.env, AGENT_LOOP_TEST_APP_STATE: stateFile, ...(geometry ? { AGENT_LOOP_TEST_APP_GEOMETRY: geometry } : {}) },
  });
  const events = () => (existsSync(stateFile) ? readFileSync(stateFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    proc,
    stateFile,
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
