/**
 * The one real `DesktopDriver`: an adapter over `@trycua/cua-driver`, the native driver both of the
 * reference projects build on (docs/RESEARCH-COMPUTER-USE-AND-MULTI-AGENT.md).
 *
 * What the package actually is (found by reading it and running it, which corrected the spec): an
 * in-process SDK around a native library, not an MCP server to spawn -- the `cua-driver mcp`
 * executable is a separate download this project doesn't use. Its surface is far wider than desktop
 * tools may touch: clipboard read/write, full-desktop capture, launching and killing apps, window
 * moves, menus, hotkeys, recording, trajectory replay, its own browser tools. This adapter calls
 * exactly six things -- listWindows, getWindowState, click, and `type_text` / `press_key` through the
 * generic tool entry point -- and nothing else is reachable through the `DesktopDriver` interface.
 *
 * Every input goes to an explicit window (pid + window id), with foreground delivery. Foreground is
 * the only mode that works against Chromium-based and most toolkit windows on X11, and it fails
 * closed: the driver activates the target, confirms it holds the input focus, and sends nothing if
 * it doesn't (verified against a real window manager in test/desktop-real.mjs).
 *
 * Loaded lazily, only when a run passes --desktop-target, so every other run never loads the native
 * library at all. T7: the version is pinned exactly (package.json, lockfile integrity) and checked
 * against what the native library reports.
 */
import { readFileSync, readlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DesktopDriver, DriverActionResult, DriverCapture, DriverElement, DriverWindow, DesktopWindowRef, ProcessIdentity } from "./desktop-tools.js";

const execFileAsync = promisify(execFile);

export const CUA_PACKAGE = "@trycua/cua-driver";
/** Must equal the exact version in package.json's optionalDependencies (a test asserts it). */
export const CUA_EXPECTED_VERSION = "0.30.4";

/** The driver tools this adapter is allowed to reach through the generic tool entry point. */
const GENERIC_TOOLS = new Set(["type_text", "press_key"]);

/** The one gate on the generic entry point, which can otherwise reach all ~60 of the driver's tools
 * (clipboard, launch/kill app, hotkeys, config, trajectory replay, its own browser...). Exported so the
 * tests can hit it directly: no caller passes another name, so nothing else would ever exercise it. */
export function assertAllowedGenericTool(name: string): void {
  if (!GENERIC_TOOLS.has(name)) throw new Error(`desktop adapter refuses to call driver tool "${name}"`);
}

type Sdk = Record<string, any>;

function toolMessage(err: unknown): string {
  const inner = (err as { inner?: { message?: string; errorCode?: string } } | undefined)?.inner;
  if (inner?.message) return `${inner.errorCode ? `${inner.errorCode}: ` : ""}${inner.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Key names our tool accepts (the ones a model and a browser's KeyboardEvent both use) mapped to what
 * the driver accepts. Checked against the real driver with a real window (test/desktop-real.mjs):
 * everything in the tool's allowlist passes through as-is except the Arrow* spellings, which the
 * driver rejects ("Unknown key: ArrowLeft") in favour of Up/Down/Left/Right.
 */
export function toDriverKey(key: string): string {
  const m = /^arrow(up|down|left|right)$/i.exec(key);
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : key;
}

function windowIdNumber(windowId: string): number {
  const n = Number(windowId);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`window id ${windowId} can't be passed to the driver without losing precision`);
  return n;
}

/**
 * Identity of the program behind a pid, from the operating system rather than from the driver or the
 * window: a window's own title and class are whatever the app says they are. Linux reads /proc
 * (verified in CI). macOS and Windows ask the OS through `ps` / PowerShell; those two paths are
 * written but not yet exercised by any test here. When identity can't be read the answer is
 * `undefined`, and the caller refuses the target.
 */
export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "linux") {
      const name = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      let exe: string | undefined;
      try {
        exe = readlinkSync(`/proc/${pid}/exe`);
      } catch {
        /* not readable for another user's process */
      }
      let argv0: string | undefined;
      let script: string | undefined;
      try {
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        argv0 = argv[0] || undefined;
        script = argv.slice(1).find((a) => a && !a.startsWith("-"));
      } catch {
        /* ignore */
      }
      return { name, exe, argv0, script };
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "comm="], { timeout: 3000 });
      const exe = stdout.trim();
      if (!exe) return undefined;
      return { name: exe.split("/").pop() ?? exe, exe };
    }
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).Path`], { timeout: 5000 });
      const exe = stdout.trim();
      if (!exe) return undefined;
      return { name: exe.split(/[\\/]/).pop() ?? exe, exe };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface OpenCuaDriverOptions {
  /** Replaced in tests with a stand-in that records every call, to prove nothing else is reached. */
  loadSdk?: () => Promise<Sdk>;
  /** Replaced in tests; defaults to reading the operating system. */
  identity?: (pid: number) => Promise<ProcessIdentity | undefined>;
}

export async function openCuaDriver(opts: OpenCuaDriverOptions = {}): Promise<DesktopDriver> {
  let sdk: Sdk;
  try {
    sdk = opts.loadSdk ? await opts.loadSdk() : ((await import(CUA_PACKAGE)) as Sdk);
  } catch (err) {
    throw new Error(
      `Desktop tools need the optional ${CUA_PACKAGE} package and its native library for this platform ` +
        `(npm install ${CUA_PACKAGE}@${CUA_EXPECTED_VERSION}). Could not load it: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const raw = sdk.CuaDriver.create(undefined);
  let version: string;
  try {
    const meta = await raw.metadata();
    version = String(meta.driverVersion);
  } catch (err) {
    await Promise.resolve(raw.shutdown?.()).catch(() => {});
    throw new Error(`The desktop driver loaded but did not answer: ${toolMessage(err)}`);
  }
  if (version !== CUA_EXPECTED_VERSION) {
    await Promise.resolve(raw.shutdown?.()).catch(() => {});
    throw new Error(`The desktop driver reports version ${version}, but this build is pinned to ${CUA_EXPECTED_VERSION}; refusing to run an unreviewed driver.`);
  }

  const windowTarget = (w: DesktopWindowRef) => sdk.ActionTarget.Window.new({ pid: w.pid, windowId: BigInt(windowIdNumber(w.windowId)) });
  const refusedOrOk = (r: { effect: number; summary?: string }): DriverActionResult =>
    r.effect === sdk.ActionEffect.Refused ? { ok: false, summary: r.summary ?? "refused" } : { ok: true, summary: r.summary ?? "done" };

  /** The only door to the generic tool entry point, and it only opens for two tools. */
  const generic = async (name: string, args: Record<string, unknown>): Promise<DriverActionResult> => {
    assertAllowedGenericTool(name);
    try {
      const r = await raw.callTool(name, JSON.stringify({ ...args, delivery_mode: "foreground" }));
      return { ok: !r.isError, summary: String(r.text ?? "") };
    } catch (err) {
      return { ok: false, summary: toolMessage(err) };
    }
  };

  const driver: DesktopDriver = {
    version,

    async listWindows(pid) {
      const r = await raw.listWindows(sdk.ListWindowsInput.new({ ...(pid !== undefined ? { pid } : {}), onScreenOnly: true }));
      return (r.windows as any[]).map(
        (w): DriverWindow => ({
          pid: Number(w.pid),
          windowId: String(w.windowId),
          appName: String(w.appName ?? ""),
          title: String(w.title ?? ""),
          bounds: { x: w.bounds.x, y: w.bounds.y, width: w.bounds.width, height: w.bounds.height },
        })
      );
    },

    processIdentity: opts.identity ?? readProcessIdentity,

    async capture(w) {
      const s = await raw.getWindowState(
        sdk.GetWindowStateInput.new({
          pid: w.pid,
          windowId: BigInt(windowIdNumber(w.windowId)),
          includeAccessibilityTree: true,
          includeScreenshot: true,
          maxElements: 200,
          timeoutMs: 2000,
        })
      );
      const img = (s.images as any[] | undefined)?.[0];
      if (!img?.dataBase64) throw new Error("the driver returned no screenshot for the window");
      if (s.screenshotFrameValid === false) throw new Error("the driver reports the screenshot does not match the window's current frame");
      if (!s.windowBounds) throw new Error("the driver returned no window bounds");
      const elements: DriverElement[] = ((s.elements as any[] | undefined) ?? []).map((e) => ({
        index: Number(e.elementIndex),
        role: String(e.role ?? ""),
        label: e.label ?? undefined,
        value: e.value ?? undefined,
        token: e.elementToken ?? undefined,
        enabled: e.enabled ?? undefined,
        depth: Number(e.depth ?? 0),
      }));
      const cap: DriverCapture = {
        snapshotId: String(s.snapshotId ?? ""),
        bounds: { x: s.windowBounds.x, y: s.windowBounds.y, width: s.windowBounds.width, height: s.windowBounds.height },
        width: Number(s.screenshotWidth ?? s.windowBounds.width),
        height: Number(s.screenshotHeight ?? s.windowBounds.height),
        png: Buffer.from(String(img.dataBase64), "base64"),
        elements,
        degraded: Boolean(s.degraded),
        degradedReason: s.degradedReason ?? undefined,
        truncated: Boolean(s.truncated),
      };
      return cap;
    },

    async click(w, p) {
      try {
        const r = await raw.click(
          sdk.ClickInput.new({
            target: windowTarget(w),
            position: sdk.ClickPosition.Coordinates.new({ x: p.x, y: p.y }),
            deliveryMode: sdk.InputDeliveryMode.Foreground,
            button: p.button === "right" ? sdk.ClickButton.Right : p.button === "middle" ? sdk.ClickButton.Middle : sdk.ClickButton.Left,
            count: p.count,
          })
        );
        return refusedOrOk(r);
      } catch (err) {
        return { ok: false, summary: toolMessage(err) };
      }
    },

    async clickElement(w, token) {
      try {
        const r = await raw.click(
          sdk.ClickInput.new({
            target: windowTarget(w),
            position: sdk.ClickPosition.Element.new({ elementToken: token }),
            deliveryMode: sdk.InputDeliveryMode.Foreground,
          })
        );
        return refusedOrOk(r);
      } catch (err) {
        return { ok: false, summary: toolMessage(err) };
      }
    },

    typeText: (w, text) => generic("type_text", { pid: w.pid, window_id: windowIdNumber(w.windowId), text }),

    pressKey: (w, key, modifiers) =>
      generic("press_key", { pid: w.pid, window_id: windowIdNumber(w.windowId), key: toDriverKey(key), ...(modifiers.length ? { modifiers } : {}) }),

    async close() {
      try {
        await raw.shutdown();
      } finally {
        if (typeof raw.uniffiDestroy === "function") raw.uniffiDestroy();
      }
    },
  };
  return driver;
}
