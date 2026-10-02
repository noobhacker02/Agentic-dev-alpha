import { existsSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
// NOTE: nothing here may import the desktop driver module at load time: cli.ts imports this file, and a run that is refused from its
// arguments must never load the native driver (test/desktop-cli.mjs checks that with a module-resolution trace). The real probe loads it lazily.

const execFileAsync = promisify(execFile);

/**
 * `agent-loop doctor`: what is missing or broken on this machine, in plain words, before a run finds out the hard way.
 * The desktop checks tell four failures apart that a generic "could not start" lumps together (the idea is Hermes's:
 * "no display", "the screen is locked" and "the driver is unhealthy" are different problems with different fixes):
 * no display at all, a display variable that points at nothing, a locked session, and a driver that is missing, wrong or silent.
 * Every probe is injectable, so each branch is tested without the machine being in that state.
 */
export type Level = "ok" | "warn" | "fail" | "info";
export interface Check { id: string; level: Level; title: string; detail: string; fix?: string }

export interface Probes {
  platform: NodeJS.Platform;
  nodeVersion: string;
  env: Record<string, string | undefined>;
  /** `import("node:sqlite")` works in this process. */
  hasSqlite(): Promise<boolean>;
  /** A command on PATH, or undefined. */
  which(cmd: string): Promise<string | undefined>;
  /** A usable Chromium for --browser, or undefined. */
  chromium(): string | undefined;
  /** Can a file be created in this directory. */
  writable(dir: string): boolean;
  /** Loads the optional desktop driver package. */
  driver(): Promise<{ ok: true; version: string; expected: string; install: string } | { ok: false; stage: "missing" | "silent"; message: string; install: string }>;
  /** Linux only: does something answer on this X11 display. undefined when it cannot be told. */
  x11Answers(display: string): Promise<boolean | undefined>;
  /** Linux only: does the login session report itself locked. undefined when it cannot be told. */
  sessionLocked(): Promise<boolean | undefined>;
}

const parseNode = (v: string): [number, number] => {
  const m = /^v?(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};
const one = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 240);

export async function diagnoseDesktop(p: Probes): Promise<Check[]> {
  const out: Check[] = [];
  if (p.platform === "linux") {
    const display = p.env.DISPLAY, wayland = p.env.WAYLAND_DISPLAY;
    if (!display && !wayland) {
      out.push({ id: "desktop-display", level: "fail", title: "No display", detail: "Neither DISPLAY nor WAYLAND_DISPLAY is set, so there is no screen to look at.", fix: "Run from a desktop session, or start a virtual one: xvfb-run -a <command>." });
    } else if (display) {
      const answers = await p.x11Answers(display);
      if (answers === false) out.push({ id: "desktop-display", level: "fail", title: "The display does not answer", detail: `DISPLAY is ${one(display)}, but nothing is listening there (a stale variable from an old session, or the X server is not running).`, fix: "Start the X server (or Xvfb) for that display, or fix DISPLAY." });
      else out.push({ id: "desktop-display", level: answers === true ? "ok" : "info", title: "A display is set", detail: answers === true ? `DISPLAY ${one(display)} answers.` : `DISPLAY is ${one(display)}; whether it answers could not be checked.` });
    } else {
      out.push({ id: "desktop-display", level: "info", title: "A Wayland display is set", detail: `WAYLAND_DISPLAY is ${one(wayland ?? "")}. Reaching a window under Wayland depends on the driver's support for your compositor.` });
    }
    const locked = await p.sessionLocked();
    if (locked === true) out.push({ id: "desktop-locked", level: "fail", title: "The session is locked", detail: "The login session reports it is locked, so windows cannot be captured or clicked.", fix: "Unlock the screen and keep it from locking during the run." });
    else if (locked === false) out.push({ id: "desktop-locked", level: "ok", title: "The session is not locked", detail: "The login session reports it is active and unlocked." });
  } else if (p.platform === "darwin") {
    out.push({ id: "desktop-permission", level: "info", title: "macOS permissions", detail: "Screen Recording and Accessibility must be allowed for the terminal you run from; macOS asks the first time, and a denied permission shows up as an empty capture." });
  } else if (p.platform === "win32") {
    out.push({ id: "desktop-permission", level: "info", title: "Windows", detail: "Windows is not verified; the window must not be elevated above the terminal, or input is blocked." });
  }
  const d = await p.driver();
  if (d.ok) {
    if (d.version === d.expected) out.push({ id: "desktop-driver", level: "ok", title: "Desktop driver", detail: `@trycua/cua-driver ${one(d.version)} loaded and answered.` });
    else out.push({ id: "desktop-driver", level: "fail", title: "Desktop driver is the wrong version", detail: `It reports ${one(d.version)}, but this build is pinned to ${d.expected} and refuses an unreviewed driver.`, fix: d.install });
  } else if (d.stage === "missing") {
    out.push({ id: "desktop-driver", level: "warn", title: "Desktop driver not installed", detail: `Needed only for --desktop-target. ${one(d.message)}`, fix: d.install });
  } else {
    out.push({ id: "desktop-driver", level: "fail", title: "Desktop driver is unhealthy", detail: `It loaded but did not answer: ${one(d.message)}`, fix: "Reinstall it, and check the display and permissions above." });
  }
  return out;
}

/** `desktop`: the person means to use --desktop-target, so a desktop problem blocks. Otherwise it is reported as something to look at only. */
export async function runDoctor(p: Probes, opts: { dataDir: string; desktop?: boolean }): Promise<Check[]> {
  const out: Check[] = [];
  const [major, minor] = parseNode(p.nodeVersion);
  if (major < 22 || (major === 22 && minor < 5)) out.push({ id: "node", level: "fail", title: "Node is too old", detail: `${p.nodeVersion}; agent-loop needs 22.5 or newer for node:sqlite.`, fix: "Install a current Node LTS." });
  else if (major === 22 && minor < 13) out.push({ id: "node", level: "warn", title: "Node needs a flag", detail: `${p.nodeVersion} has node:sqlite only behind --experimental-sqlite.`, fix: "Use npm start (it passes the flag), or upgrade to Node 22.13 or newer." });
  else out.push({ id: "node", level: "ok", title: "Node", detail: p.nodeVersion });

  out.push((await p.hasSqlite())
    ? { id: "sqlite", level: "ok", title: "node:sqlite", detail: "available, so the audit database works." }
    : { id: "sqlite", level: "fail", title: "node:sqlite is not available", detail: "The audit database cannot open.", fix: "Run with --experimental-sqlite (npm start does) or upgrade Node." });

  out.push(p.writable(opts.dataDir)
    ? { id: "data-dir", level: "ok", title: "Audit database folder", detail: `${one(opts.dataDir)} is writable.` }
    : { id: "data-dir", level: "fail", title: "Audit database folder is not writable", detail: `${one(opts.dataDir)} cannot be created or written to.`, fix: "Choose another with --data-dir, or fix its permissions." });

  const keys = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"].filter((k) => p.env[k]);
  out.push(keys.length
    ? { id: "credentials", level: "ok", title: "Credentials", detail: `${keys.join(", ")} set (the value is never printed).` }
    : { id: "credentials", level: "warn", title: "No API credential in the environment", detail: "None of ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_AUTH_TOKEN is set. A Claude Code login on this machine may still work.", fix: "Set ANTHROPIC_API_KEY, or log in with Claude Code." });

  const chrome = p.chromium();
  out.push(chrome
    ? { id: "chromium", level: "ok", title: "Chromium", detail: `found (${one(chrome)}), for --browser and the UI tests.` }
    : { id: "chromium", level: "warn", title: "No Chromium", detail: "Needed only for --browser and the UI tests.", fix: "npx playwright install chromium, or set AGENT_LOOP_CHROME_PATH." });

  const ff = await p.which("ffmpeg");
  out.push(ff
    ? { id: "ffmpeg", level: "ok", title: "ffmpeg", detail: "found, for recording walkthrough videos." }
    : { id: "ffmpeg", level: "info", title: "No ffmpeg", detail: "Needed only to record the walkthrough videos; nothing else uses it." });

  const desk = await diagnoseDesktop(p);
  out.push(...(opts.desktop ? desk : desk.map((c): Check => (c.level === "fail" ? { ...c, level: "warn", detail: `${c.detail} (Only matters with --desktop-target; run "doctor --desktop" to treat it as blocking.)` } : c))));
  return out;
}

const MARK: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗", info: "·" };

export function renderDoctor(checks: Check[]): string {
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`  ${MARK[c.level]} ${c.title}: ${c.detail}`);
    if (c.fix && c.level !== "ok") lines.push(`      → ${c.fix}`);
  }
  const fails = checks.filter((c) => c.level === "fail").length, warns = checks.filter((c) => c.level === "warn").length;
  lines.push("", fails ? `${fails} problem(s) to fix${warns ? `, ${warns} to look at` : ""}.` : warns ? `Nothing blocking; ${warns} to look at.` : "Everything checks out.");
  return lines.join("\n");
}

/** Exit code for the CLI: 1 only when something blocking was found. */
export const doctorExitCode = (checks: Check[]) => (checks.some((c) => c.level === "fail") ? 1 : 0);

/** The real probes. Each one swallows its own errors into "could not tell". */
export function realProbes(): Probes {
  return {
    platform: process.platform,
    nodeVersion: process.version,
    env: process.env,
    async hasSqlite() { try { await import("node:sqlite"); return true; } catch { return false; } },
    async which(cmd) {
      try { const { stdout } = await execFileAsync(process.platform === "win32" ? "where" : "which", [cmd], { timeout: 3000 }); return stdout.split("\n")[0].trim() || undefined; } catch { return undefined; }
    },
    chromium() {
      if (process.env.AGENT_LOOP_CHROME_PATH && existsSync(process.env.AGENT_LOOP_CHROME_PATH)) return process.env.AGENT_LOOP_CHROME_PATH;
      const root = "/opt/pw-browsers";
      try {
        const dir = existsSync(root) ? readdirSync(root).find((d) => d.startsWith("chromium-")) : undefined;
        const exe = dir && join(root, dir, "chrome-linux", "chrome");
        if (exe && existsSync(exe)) return exe;
      } catch { /* fall through */ }
      const home = process.env.HOME ?? process.env.USERPROFILE;
      for (const base of [process.env.PLAYWRIGHT_BROWSERS_PATH, home && join(home, ".cache", "ms-playwright"), home && join(home, "Library", "Caches", "ms-playwright")]) {
        try {
          const dir = base && existsSync(base) ? readdirSync(base).find((d) => d.startsWith("chromium")) : undefined;
          if (dir && base) return join(base, dir);
        } catch { /* try the next */ }
      }
      return undefined;
    },
    writable(dir) {
      try { mkdirSync(dir, { recursive: true }); const f = join(dir, `.doctor-${process.pid}`); writeFileSync(f, ""); rmSync(f); return true; } catch { return false; }
    },
    async driver() {
      const { openCuaDriver, CUA_EXPECTED_VERSION, CUA_PACKAGE } = await import("./desktop-driver-cua.js");
      const install = `npm install ${CUA_PACKAGE}@${CUA_EXPECTED_VERSION}`;
      try {
        // openCuaDriver only returns when the driver answered and its version is the pinned one.
        const d = await openCuaDriver();
        await d.close().catch(() => {});
        return { ok: true, version: CUA_EXPECTED_VERSION, expected: CUA_EXPECTED_VERSION, install };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/did not answer/.test(message)) return { ok: false, stage: "silent", message, install };
        if (/reports version/.test(message)) {
          const m = /reports version (\S+),/.exec(message);
          return { ok: true, version: m ? m[1] : "unknown", expected: CUA_EXPECTED_VERSION, install };
        }
        return { ok: false, stage: "missing", message, install };
      }
    },
    async x11Answers(display) {
      // :N or host:N.S ; a unix socket for a local display. Anything else (a remote host) cannot be checked cheaply.
      const m = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display);
      if (!m) return undefined;
      return new Promise((resolve) => {
        const s = createConnection({ path: `/tmp/.X11-unix/X${m[1]}` });
        const done = (v: boolean) => { s.destroy(); resolve(v); };
        s.setTimeout(1500, () => done(false));
        s.once("connect", () => done(true));
        s.once("error", () => done(false));
      });
    },
    async sessionLocked() {
      const id = process.env.XDG_SESSION_ID;
      if (!id) return undefined;
      try {
        const { stdout } = await execFileAsync("loginctl", ["show-session", id, "-p", "LockedHint", "--value"], { timeout: 3000 });
        const v = stdout.trim();
        return v === "yes" ? true : v === "no" ? false : undefined;
      } catch { return undefined; }
    },
  };
}
