// Shared setup for the UI extras suites (ui-mascot, ui-offline, ui-sound): a real server on a real port, a real
// Chromium, and a way to feed the page events. No API calls.
import { chromium } from "playwright-core";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { EventBus } from "../dist/bus.js";
import { startServer } from "../dist/server.js";

export function chromePath() {
  if (process.env.AGENT_LOOP_CHROME_PATH) return process.env.AGENT_LOOP_CHROME_PATH;
  const root = "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => d.startsWith("chromium-"));
  const exe = dir && join(root, dir, "chrome-linux", "chrome");
  return exe && existsSync(exe) ? exe : undefined;
}

export async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

/**
 * opts: viewport, historyLimit (the bus's replay history, to make trimming happen with few events), plain (the server's default, --plain), onStop (what the Stop button calls), abort (URL substrings the page may not load, to prove it survives without them),
 *       fullChromium (a real Chromium instead of the default headless shell, for the browser's own notification permission),
 *       serverClock (what the server reports as its time to every page; defaults to the real clock), clock (install Playwright's fake clock before the page loads), reducedMotion, init (script to run first).
 * Returns { bus, srv, browser, ctx, page, ev, errors, restartServer, close }.
 */
export async function harness(opts = {}) {
  const port = await freePort();
  const token = "t".repeat(48);
  const bus = new EventBus(undefined, opts.historyLimit ? { historyLimit: opts.historyLimit } : {});
  const h = { bus, port, token, errors: [] };
  h.srv = await startServer(bus, port, { token, plain: opts.plain, onStop: opts.onStop, clock: opts.serverClock });
  // fullChromium: a real Chromium, not the headless shell Playwright picks by default. The shell has no notification permission of its own
  // (Permissions API says "granted" while Notification.permission says "denied"); anything about the real permission mechanics needs the real thing.
  h.browser = await chromium.launch(opts.fullChromium && !chromePath() ? { channel: "chromium" } : { executablePath: chromePath() });
  h.ctx = await h.browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 }, reducedMotion: opts.reducedMotion ? "reduce" : "no-preference" });
  for (const part of opts.abort ?? []) await h.ctx.route((u) => u.pathname.includes(part), (r) => r.abort());
  h.page = await h.ctx.newPage();
  // A server that is meant to disappear makes the browser log failed WebSocket connections; those are not bugs.
  const expected = /WebSocket|ERR_CONNECTION|ERR_FAILED|Failed to load resource/;
  h.page.on("pageerror", (e) => h.errors.push("pageerror: " + e.message));
  h.page.on("console", (m) => m.type() === "error" && !expected.test(m.text()) && h.errors.push("console: " + m.text()));
  // The page survives a script that did not load (the cat, the sound), so a test that then reads that script's API fails with "undefined" and no hint why (ui-plain on Windows at a035a87: AL.mascot undefined).
  // A page, script or stylesheet that answers 4xx or 5xx or fails (other than what the test aborted on purpose) is remembered, and open() names it.
  h.badLoads = [];
  const aborted = (url) => (opts.abort ?? []).some((part) => url.includes(part));
  const asset = (rq) => ["document", "script", "stylesheet"].includes(rq.resourceType());
  h.page.on("response", (res) => { const rq = res.request(); if (asset(rq) && res.status() >= 400 && !aborted(rq.url())) h.badLoads.push(`${new URL(rq.url()).pathname} answered ${res.status()}`); });
  h.page.on("requestfailed", (rq) => { if (asset(rq) && !aborted(rq.url())) h.badLoads.push(`${new URL(rq.url()).pathname} failed (${rq.failure()?.errorText ?? "unknown"})`); });
  if (opts.init) await h.page.addInitScript(opts.init);
  if (opts.clock) await h.page.clock.install({ time: Date.now() });
  const runId = "extras-run";
  h.ev = (o) => bus.emitEvent({ runId, ts: new Date().toISOString(), ...o });
  h.open = async (search = "") => {
    h.badLoads.length = 0;
    const named = () => new Error(`the page did not load everything it needs: ${[...new Set(h.badLoads)].join("; ")}`);
    try {
      await h.page.goto(`http://127.0.0.1:${port}/${search}#token=${token}`);
      await h.page.waitForFunction(() => document.getElementById("status")?.textContent === "live", undefined, { timeout: 8000 });
    } catch (err) {
      if (h.badLoads.length) throw named();
      throw err;
    }
    if (h.badLoads.length) throw named();
  };
  h.startRun = () => {
    h.ev({ type: "run-start", task: "Add a /health route", workDir: "/work/app" });
    h.ev({ type: "phase-start", phase: "builder", attempt: 1 });
  };
  h.askApproval = (id = "q1", extra = {}) => {
    h.ev({ type: "tool-call", phase: "builder", toolUseId: "tu-" + id, toolName: "Bash", toolInput: { command: "npm test" } });
    h.ev({ type: "approval-request", phase: "builder", requestId: id, toolUseId: "tu-" + id, toolName: "Bash", toolInput: { command: "npm test" }, rule: "Bash(npm test)", ...extra });
  };
  h.restartServer = async () => { h.srv = await startServer(bus, port, { token, plain: opts.plain, onStop: opts.onStop, clock: opts.serverClock }); };
  h.close = async () => { await h.browser.close(); try { await h.srv.close(); } catch {} };
  return h;
}

/** Waits until the cat has stopped moving (its box is the same twice, 120 ms apart) and returns that box. */
export async function catBox(page) {
  // Settled means two things: it has stopped, and it is where the mascot says it is going. The second matters because a transition only advances
  // when the browser draws frames: a slow or busy machine (a macOS CI run) can show the cat at its start position twice in a row, 120 ms apart,
  // which "stopped" alone accepts. The mascot's own state() holds the position it set; the box has to reach it.
  const read = () => page.evaluate(() => {
    const r = document.getElementById("cat").getBoundingClientRect(), s = AL.mascot.state();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, wantX: s.x, wantY: s.y };
  });
  const strip = ({ left, top, right, bottom }) => ({ left, top, right, bottom });
  let a = await read();
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(120);
    const b = await read();
    const still = Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5;
    const there = Math.abs(b.left - b.wantX) <= 1.5 && Math.abs(b.top - b.wantY) <= 1.5;
    if (still && there) return strip(b);
    a = b;
  }
  throw new Error(`the cat never settled where the mascot put it: at ${a.left},${a.top}; the mascot says ${a.wantX},${a.wantY}`);
}
export const box = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }, sel);
