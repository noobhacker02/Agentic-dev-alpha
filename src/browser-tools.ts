/**
 * A Playwright-backed browser tool adapter exposed to phases as a real in-process MCP server
 * (createSdkMcpServer + tool() -- the SDK's actual custom-tool mechanism, confirmed against
 * node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts rather than assumed). Custom tools surface as
 * `mcp__<server>__<tool>` in `tool_name`, the same field PreToolUse hooks already read for built-ins,
 * so createSafetyHook/createPathScopeHook/createSensitiveFileHook/createApprovalHook need no new
 * plumbing to see these calls.
 *
 * Deliberately local-only: `open` accepts only http://localhost or http://127.0.0.1 URLs, and the same
 * boundary is enforced on every request, WebSocket, and tab the browser context ever makes (see
 * getOrCreate). A real domain allowlist is cloud-pilot territory, not this pass.
 *
 * Computer-use Stage 1 (specs/computer-use/SPEC.md) adds element refs from `inspect`, coordinate
 * actions tied to a screenshot's `snapshotId`, tabs, and hover/select/scroll. Refs and snapshotIds are
 * both "fail closed": when the page they describe has moved on, they're rejected, never re-resolved.
 */
import { chromium, type Browser, type BrowserContext, type ElementHandle, type Locator, type Page } from "playwright-core";
import { existsSync, readdirSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { EventBus } from "./bus.js";
import { cleanText } from "./text-safety.js";

/** The installed playwright-core version doesn't reliably match the pre-installed browser's
 * revision number in every environment, so chromium.launch()'s own resolution can miss it even
 * when a real Chromium is present. Only used as a fallback after the normal launch fails. */
function findSandboxPreinstalledChrome(): string | undefined {
  const root = "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => d.startsWith("chromium-"));
  if (!dir) return undefined;
  const exe = join(root, dir, "chrome-linux", "chrome");
  return existsSync(exe) ? exe : undefined;
}

async function launchBrowser(): Promise<Browser> {
  const explicit = process.env.AGENT_LOOP_CHROME_PATH;
  if (explicit) return chromium.launch({ executablePath: explicit, headless: true });
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    const fallback = findSandboxPreinstalledChrome();
    if (!fallback) {
      throw new Error(
        `Could not launch Chromium (${err instanceof Error ? err.message : String(err)}). ` +
          `Install a browser for playwright-core (npx playwright install chromium) or set AGENT_LOOP_CHROME_PATH ` +
          `to an existing Chrome/Chromium binary.`
      );
    }
    return chromium.launch({ executablePath: fallback, headless: true });
  }
}

/** One open tab. `navGen` counts main-frame navigations, so a ref or snapshotId taken at one
 * generation can tell it's stale at the next. */
interface BrowserTab {
  id: string;
  page: Page;
  navGen: number;
}

/** The refs from one `inspect`. Each ref maps to a live ElementHandle held here, in this process --
 * never to anything stored in the page -- so page JavaScript can't forge a ref or point an existing one
 * at a different element (a `data-ref` attribute would let a page move the "Save" ref onto "Delete"). */
interface RefSnapshot {
  id: number;
  tabId: string;
  navGen: number;
  handles: Map<string, ElementHandle>;
}

/** What the page looked like when a screenshot was taken, so coordinates read off that image can be
 * refused once they no longer mean the same spot. */
interface ShotSnapshot {
  id: string;
  tabId: string;
  navGen: number;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

interface BrowserSession {
  browserSessionId: string;
  browser: Browser;
  context: BrowserContext;
  /** The active tab's page. */
  page: Page;
  activeTabId: string;
  /** Open tabs, in the order they opened. */
  tabs: BrowserTab[];
  /** Every tab this session ever adopted, closed ones included -- each has its own video recording. */
  everTabs: BrowserTab[];
  tabCounter: number;
  snapshotCounter: number;
  shotCounter: number;
  refs?: RefSnapshot;
  shot?: ShotSnapshot;
  screenshotCount: number;
  /** Popups closed on arrival because the session was already at MAX_TABS_PER_SESSION. */
  refusedTabs: number;
}

/** No size or rate limit on screenshots was a real, if minor, disk-fill DoS: nothing stopped a
 * runaway or adversarial phase from calling screenshot() in a loop. One session, one run -- a few
 * dozen screenshots is generous for any real verification flow. */
const MAX_SCREENSHOTS_PER_SESSION = 50;

/** Same reasoning for tabs: a page calling window.open() in a loop would otherwise get a Chromium
 * renderer (and a video recording) per call. Popups past this are closed as they arrive. */
const MAX_TABS_PER_SESSION = 10;

/** How many refs one `inspect` hands out. Enough for a real form or toolbar; a page with thousands of
 * links gets the first ones plus a count, not a transcript-flooding list. */
const MAX_REFS_PER_SNAPSHOT = 60;

const LOCAL_URL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;
const LOCAL_WS_RE = /^wss?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

/**
 * The one gate for the "local-only" boundary -- shared by both `open()`'s own check AND the
 * context-level request guard below, so they can never drift apart. `open()` alone isn't enough: a
 * page loaded from an allowed local origin can still contain a link, a JS redirect, a form, or a
 * background fetch/XHR pointed at an external host, and none of those go through `open()` at all
 * (confirmed empirically -- clicking a link navigated the browser to a second local server with zero
 * re-validation before this fix). `about:blank` is Playwright's own page-creation default before any
 * real navigation and never represents an actual network request.
 */
function isAllowedBrowserUrl(url: string): boolean {
  return url === "about:blank" || LOCAL_URL_RE.test(url);
}

function isAllowedWebSocketUrl(url: string): boolean {
  return LOCAL_WS_RE.test(url);
}

/**
 * WebRTC opens its own UDP/TCP sockets (STUN/TURN) that never pass through context.route -- confirmed
 * empirically: a local page's RTCPeerConnection sent STUN packets to a non-allowed host with the route
 * gate in place, and Chromium's --force-webrtc-ip-handling-policy=disable_non_proxied_udp flag did not
 * stop them. Removing the constructors in every realm before page scripts run did (fresh iframe read
 * synchronously, srcdoc, data:, blob:, and window.open('') popups all checked). Nothing agent-loop
 * verifies locally needs peer connections.
 */
const DISABLE_WEBRTC_SCRIPT = `(() => {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
    try { delete globalThis[name]; } catch {}
  }
})();`;

function adoptPage(session: BrowserSession, page: Page): BrowserTab | undefined {
  const known = session.everTabs.find((t) => t.page === page);
  if (known) return known;
  if (session.tabs.length >= MAX_TABS_PER_SESSION) {
    session.refusedTabs += 1;
    void page
      .close()
      .then(() => page.video()?.delete())
      .catch(() => {});
    return undefined;
  }
  const tab: BrowserTab = { id: `t${++session.tabCounter}`, page, navGen: 0 };
  session.tabs.push(tab);
  session.everTabs.push(tab);
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) tab.navGen += 1;
  });
  page.on("close", () => forgetTab(session, tab));
  return tab;
}

function forgetTab(session: BrowserSession, tab: BrowserTab): void {
  session.tabs = session.tabs.filter((t) => t !== tab);
  if (session.activeTabId !== tab.id) return;
  const next = session.tabs[session.tabs.length - 1];
  if (next) activateTab(session, next);
  else clearSnapshots(session);
}

function activateTab(session: BrowserSession, tab: BrowserTab): void {
  session.activeTabId = tab.id;
  session.page = tab.page;
  clearSnapshots(session);
}

function disposeRefs(session: BrowserSession): void {
  const old = session.refs;
  session.refs = undefined;
  if (old) for (const h of old.handles.values()) void h.dispose().catch(() => {});
}

function clearSnapshots(session: BrowserSession): void {
  disposeRefs(session);
  session.shot = undefined;
}

function activeTab(session: BrowserSession): BrowserTab {
  const tab = session.tabs.find((t) => t.id === session.activeTabId);
  if (!tab || tab.page.isClosed()) throw new Error("Every tab in this browser session is closed -- call open to start a new one.");
  return tab;
}

/**
 * Owns browser lifecycle and maps runId -> browserSessionId -> live Playwright objects, so the
 * same open tabs survive across agent-loop's separate per-phase query() calls (each phase is its
 * own SDK session; the browser context is not). See docs/BROWSER-AGENT.md section 2.
 */
export class BrowserSessionManager {
  private sessions = new Map<string, BrowserSession>();

  /** `videoDirFor`, when given, records the whole browser session as a .webm in that run's artifact
   * directory -- a watchable record of what the agent actually did to the app, not just its claims. */
  constructor(private opts: { videoDirFor?: (runId: string) => string } = {}) {}

  async getOrCreate(runId: string, bus: EventBus): Promise<BrowserSession> {
    const existing = this.sessions.get(runId);
    if (existing) return existing;
    const browser = await launchBrowser();
    const videoDir = this.opts.videoDirFor?.(runId);
    if (videoDir) mkdirSync(videoDir, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      // Playwright's own docs: route() doesn't see requests a service worker answers, and they
      // recommend blocking service workers whenever request interception matters. It does here.
      serviceWorkers: "block",
      ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } } : {}),
    });
    await context.addInitScript(DISABLE_WEBRTC_SCRIPT);
    // Enforced at the network-request level, not just on open()'s own argument: a page loaded from
    // an allowed local origin can still contain a link, a JS redirect, a form, or a background
    // fetch/XHR pointed at an external host, and none of those go through open() at all. This
    // aborts every navigation and every sub-resource request the context ever makes -- from any
    // page or tab, at any point -- unless it targets an allowed local URL, closing that gap at its
    // root instead of re-checking after the fact (confirmed empirically: before this, clicking a
    // link navigated the browser to a second server with zero re-validation).
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (isAllowedBrowserUrl(url)) await route.continue();
      else await route.abort("blockedbyclient");
    });
    // WebSockets never go through route() -- confirmed empirically: a local page's `new WebSocket()`
    // reached a non-allowed host with the route gate above in place. Non-local ones are intercepted
    // here and closed without ever connecting; local ones aren't matched, so they behave natively.
    await context.routeWebSocket(
      (url) => !isAllowedWebSocketUrl(url.href),
      (ws) => ws.close({ code: 1008, reason: "Blocked: only localhost or 127.0.0.1 WebSockets are allowed" })
    );
    const page = await context.newPage();
    const session: BrowserSession = {
      browserSessionId: randomUUID(),
      browser,
      context,
      page,
      activeTabId: "",
      tabs: [],
      everTabs: [],
      tabCounter: 0,
      snapshotCounter: 0,
      shotCounter: 0,
      screenshotCount: 0,
      refusedTabs: 0,
    };
    session.activeTabId = adoptPage(session, page)!.id;
    // Popups (window.open, target=_blank) join the session as tabs. They share this one context, so
    // the route/WebSocket gates and the WebRTC removal above already cover them.
    context.on("page", (p) => adoptPage(session, p));
    this.sessions.set(runId, session);
    bus.emitEvent({
      type: "browser-session-started",
      runId,
      browserSessionId: session.browserSessionId,
      ts: new Date().toISOString(),
    });
    return session;
  }

  get(runId: string): BrowserSession | undefined {
    return this.sessions.get(runId);
  }

  /**
   * Always call this, even after a worker error -- an unclosed Chromium process and temp profile
   * leaking past the run is exactly the failure mode docs/BROWSER-AGENT.md's MVP boundary rules
   * out. That means this method itself must never throw: pipeline.ts calls it as the *first*
   * statement in its own `finally` block, ahead of store.finishRun and the run-end event, with no
   * try/catch of its own -- an exception here doesn't just skip below it, it escapes that finally
   * block entirely and skips finishRun/run-end too, leaving the run stuck "running" forever in the
   * DB on top of the leaked browser. Confirmed empirically: video.path() throws by contract when a
   * video wasn't actually saved (a crash, a disk issue, a race -- all realistic), which is exactly
   * the kind of failure this method must survive.
   */
  async close(runId: string, bus: EventBus, status: "completed" | "failed" | "interrupted"): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session) return;
    this.sessions.delete(runId);
    try {
      try {
        // Each tab records its own video, and a video file is only complete once its context
        // closes -- so collect them, close the context, then give each a stable name and announce
        // it. Best-effort, per video: losing one recording is never worth losing the others, the
        // run's terminal state, or leaking the browser below. The first tab keeps the
        // session-<id>.webm name it always had.
        const videos = session.everTabs.map((tab) => ({ tab, video: tab.page.video() }));
        await session.context.close();
        for (const { tab, video } of videos) {
          if (!video) continue;
          try {
            const recorded = await video.path();
            const suffix = tab.id === "t1" ? "" : `-${tab.id}`;
            const named = join(dirname(recorded), `session-${session.browserSessionId}${suffix}.webm`);
            renameSync(recorded, named);
            bus.emitEvent({
              type: "browser-artifact-created",
              runId,
              browserSessionId: session.browserSessionId,
              kind: "video",
              path: named,
              ts: new Date().toISOString(),
            });
          } catch (err) {
            console.error(`agent-loop: could not save the browser video for tab ${tab.id} of run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        console.error(`agent-loop: could not save the browser session video for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await session.browser.close();
    } catch (err) {
      console.error(`agent-loop: error closing the browser session for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      bus.emitEvent({
        type: "browser-session-ended",
        runId,
        browserSessionId: session.browserSessionId,
        status,
        ts: new Date().toISOString(),
      });
    }
  }

  async closeAll(bus: EventBus): Promise<void> {
    for (const runId of [...this.sessions.keys()]) await this.close(runId, bus, "interrupted");
  }
}

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, summary, [role], [contenteditable=""], [contenteditable="true"]';

interface ElementDescription {
  role: string;
  name: string;
  id: string;
  value: string | null;
  checked: boolean | null;
  options: string[] | null;
  disabled: boolean;
}

/** Runs inside the page, once per element handle -- so each ref line is computed from exactly the
 * element that ref resolves to, and a page can't misalign the two by tampering with a shared array.
 * A page can still make its own elements describe themselves however it likes; it can do that with
 * aria-label anyway, so that's no new power. No DOM lib in this tsconfig, hence the `any`. */
function describeElementInPage(el: any): ElementDescription {
  const tag = String(el.tagName || "").toLowerCase();
  const type = String(el.getAttribute("type") || "text").toLowerCase();
  const inputRoles: Record<string, string> = {
    checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", image: "button",
    range: "slider", search: "searchbox", number: "spinbutton",
  };
  const implicit =
    tag === "a" ? (el.hasAttribute("href") ? "link" : "generic")
    : tag === "button" || tag === "summary" ? "button"
    : tag === "select" ? (el.multiple || el.size > 1 ? "listbox" : "combobox")
    : tag === "textarea" ? "textbox"
    : tag === "input" ? (inputRoles[type] ?? "textbox")
    : el.isContentEditable ? "textbox"
    : "generic";
  const doc = el.ownerDocument;
  const labelledBy = el.getAttribute("aria-labelledby");
  const fromIds = labelledBy
    ? String(labelledBy).split(/\s+/).map((id: string) => doc.getElementById(id)?.textContent ?? "").join(" ")
    : "";
  const fromLabels = el.labels && el.labels.length ? Array.from(el.labels as ArrayLike<any>).map((l) => l.textContent).join(" ") : "";
  const isFormField = tag === "input" || tag === "textarea" || tag === "select";
  const buttonValue = tag === "input" && ["submit", "button", "reset"].includes(type) ? el.value : "";
  const name =
    el.getAttribute("aria-label") || fromIds || fromLabels || buttonValue || el.getAttribute("alt") ||
    (isFormField ? "" : el.innerText || el.textContent || "") || el.getAttribute("title") || el.getAttribute("placeholder") || "";
  const holdsText = (tag === "input" && !["checkbox", "radio", "submit", "button", "reset", "image", "file"].includes(type)) || tag === "textarea";
  const value =
    tag === "input" && type === "password" ? (el.value ? "(hidden)" : "")
    : holdsText ? String(el.value ?? "")
    : tag === "select" ? Array.from(el.selectedOptions ?? [] as ArrayLike<any>).map((o: any) => o.text).join(", ")
    : null;
  return {
    role: el.getAttribute("role") || implicit,
    name: String(name),
    id: el.id ? String(el.id) : "",
    value,
    checked: tag === "input" && (type === "checkbox" || type === "radio") ? Boolean(el.checked) : null,
    options: tag === "select" ? Array.from(el.options as ArrayLike<any>).slice(0, 12).map((o: any) => String(o.label || o.text)) : null,
    disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
  };
}

function formatRefLine(ref: string, d: ElementDescription): string {
  // Role goes in bare, so it's cut to identifier characters; everything else is JSON-quoted, so page
  // text can't close a quote and forge a second "[s1e2] button ..." entry on the same line.
  const parts = [`[${ref}]`, String(d.role).replace(/[^\w-]/g, "").slice(0, 30) || "generic", JSON.stringify(cleanText(d.name, 80))];
  if (d.id) parts.push(`id=${JSON.stringify(cleanText(d.id, 60))}`);
  if (d.value !== null) parts.push(`value=${JSON.stringify(cleanText(d.value, 80))}`);
  if (d.checked !== null) parts.push(d.checked ? "checked" : "unchecked");
  if (d.options) parts.push(`options=${JSON.stringify(d.options.map((o) => cleanText(o, 40)))}`);
  if (d.disabled) parts.push("disabled");
  return parts.join(" ");
}

/** Replaces the session's refs with a fresh set for the active tab. Refs are `s<snapshot>e<n>`, and
 * the snapshot number never repeats within a session, so a ref from any earlier inspect -- on this
 * tab or another -- can never collide with a current one. */
async function takeRefSnapshot(session: BrowserSession, tab: BrowserTab): Promise<{ lines: string[]; total: number }> {
  disposeRefs(session);
  const found = await tab.page.evaluateHandle(
    ({ selector, max }) => {
      const doc = (globalThis as any).document;
      const els: unknown[] = [];
      let total = 0;
      for (const el of doc.querySelectorAll(selector)) {
        if (el.tagName === "INPUT" && String(el.type).toLowerCase() === "hidden") continue;
        const visible = typeof el.checkVisibility === "function" ? el.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0;
        if (!visible) continue;
        total += 1;
        if (els.length < max) els.push(el);
      }
      return { els, total };
    },
    { selector: INTERACTIVE_SELECTOR, max: MAX_REFS_PER_SNAPSHOT }
  );
  const total = Number(await (await found.getProperty("total")).jsonValue()) || 0;
  const props = await (await found.getProperty("els")).getProperties();
  await found.dispose();
  const snap: RefSnapshot = { id: ++session.snapshotCounter, tabId: tab.id, navGen: tab.navGen, handles: new Map() };
  const lines: string[] = [];
  const ordered = [...props].filter(([k]) => /^\d+$/.test(k)).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [, handle] of ordered) {
    const el = handle.asElement();
    if (!el) {
      await handle.dispose();
      continue;
    }
    const ref = `s${snap.id}e${snap.handles.size + 1}`;
    snap.handles.set(ref, el);
    const d = await el.evaluate(describeElementInPage).catch(
      (): ElementDescription => ({ role: "generic", name: "", id: "", value: null, checked: null, options: null, disabled: false })
    );
    lines.push(formatRefLine(ref, d));
  }
  session.refs = snap;
  return { lines, total };
}

function resolveRef(session: BrowserSession, ref: string): ElementHandle {
  const m = /^s(\d+)e(\d+)$/.exec(ref);
  if (!m) throw new Error(`"${cleanText(ref, 40)}" isn't a ref. Refs look like s3e12 and come from the latest inspect.`);
  const tab = activeTab(session);
  const snap = session.refs;
  if (!snap || String(snap.id) !== m[1]) {
    throw new Error(
      `Stale ref ${ref}: it came from snapshot s${m[1]}, but the current snapshot is ${snap ? `s${snap.id}` : "none"}. ` +
        `Call inspect again and use a ref from the new result.`
    );
  }
  if (snap.tabId !== tab.id || snap.navGen !== tab.navGen) {
    throw new Error(`Stale ref ${ref}: the page navigated since snapshot s${snap.id}. Call inspect again and use a ref from the new result.`);
  }
  const handle = snap.handles.get(ref);
  if (!handle) throw new Error(`Unknown ref ${ref}: snapshot s${snap.id} has no element e${m[2]}.`);
  return handle;
}

interface TargetArgs {
  ref?: string;
  selector?: string;
}

/** A ref or a CSS selector, never both. Refs resolve to the exact element inspect described; a
 * selector is re-queried each time, which is what existing callers expect. */
function resolveTarget(session: BrowserSession, args: TargetArgs): { label: string; el: ElementHandle | Locator; isRef: boolean } {
  if (args.ref && args.selector) throw new Error("Pass either ref or selector, not both.");
  if (args.ref) return { label: args.ref, el: resolveRef(session, args.ref), isRef: true };
  if (args.selector) return { label: args.selector, el: session.page.locator(args.selector), isRef: false };
  throw new Error("Pass a ref from inspect (like s1e3) or a CSS selector.");
}

/** Runs an action on a target, turning "that element is gone" into the same stale-ref advice the ref
 * checks give. A handle to a node the page removed (or a document that navigated away) can't be
 * clicked -- Playwright refuses -- but its raw error doesn't tell the model what to do next. */
async function onTarget<T>(t: { label: string; el: ElementHandle | Locator; isRef: boolean }, fn: (el: ElementHandle | Locator) => Promise<T>): Promise<T> {
  try {
    return await fn(t.el);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (t.isRef && /not attached|Execution context was destroyed|has been closed|disposed/i.test(msg)) {
      throw new Error(`Stale ref ${t.label}: that element is no longer on the page. Call inspect again and use a ref from the new result.`);
    }
    throw err;
  }
}

/**
 * A click, key press or click-by-coordinates can close the very page it landed on: a popup's "Close"
 * button, say. Playwright may then finish the action against a target that is gone and report a closed
 * context or a detached node -- a race that comes out differently from one run to the next (about one click
 * in twelve on a fast machine, more on a slow one; first seen as a CI failure). That is the action working,
 * not failing, so it is reported as a note rather than an error the model would answer by retrying.
 */
async function closedByAction(tab: BrowserTab, err: unknown): Promise<boolean> {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/closed|disposed|destroyed|not attached|no longer on the page/i.test(msg)) return false;
  for (let i = 0; i < 10 && !tab.page.isClosed(); i++) await new Promise((r) => setTimeout(r, 50));
  return tab.page.isClosed();
}

async function readScroll(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => ({ x: Number((globalThis as any).scrollX), y: Number((globalThis as any).scrollY) }));
}

/**
 * Coordinates only mean something against the exact screenshot they were read from. Only the latest
 * screenshot's snapshotId is honored, and only while the page it captured is still in the same place:
 * same tab, no navigation, same viewport size, same scroll position. A layout change in place (content
 * inserted above, say) isn't detected -- the page controls its own layout, and nothing cheap and
 * tamper-proof can watch for that -- so the tool descriptions steer toward refs first.
 */
async function checkShot(session: BrowserSession, snapshotId: string, x: number, y: number): Promise<BrowserTab> {
  const tab = activeTab(session);
  const shot = session.shot;
  const id = cleanText(snapshotId, 40);
  if (!shot || shot.id !== snapshotId) {
    throw new Error(
      `Stale snapshotId ${id}: the latest screenshot is ${shot ? shot.id : "none"}. Coordinates are only valid against ` +
        `the screenshot they were read from -- take a new screenshot and use its snapshotId.`
    );
  }
  if (shot.tabId !== tab.id || shot.navGen !== tab.navGen) {
    throw new Error(`Stale snapshotId ${id}: the page navigated since that screenshot. Take a new screenshot.`);
  }
  const vp = tab.page.viewportSize();
  if (!vp || vp.width !== shot.width || vp.height !== shot.height) {
    throw new Error(`Stale snapshotId ${id}: the viewport changed size since that screenshot. Take a new screenshot.`);
  }
  const scroll = await readScroll(tab.page);
  if (scroll.x !== shot.scrollX || scroll.y !== shot.scrollY) {
    throw new Error(`Stale snapshotId ${id}: the page scrolled since that screenshot. Take a new screenshot.`);
  }
  if (!(x >= 0 && x < shot.width && y >= 0 && y < shot.height)) {
    throw new Error(`(${x}, ${y}) is outside the ${shot.width}x${shot.height} screenshot ${shot.id}.`);
  }
  return tab;
}

export interface CreateBrowserToolServerOptions {
  runId: string;
  bus: EventBus;
  sessions: BrowserSessionManager;
  /** Where screenshots get written -- always outside the agent's --dir, alongside the rest of the
   * run's audit artifacts, never in SQLite (docs/BROWSER-AGENT.md section 3). */
  artifactDir: string;
}

/** Wraps a tool handler to always emit browser-action-started/completed with timing, regardless of
 * which specific tool ran or whether it threw -- one place for this instead of repeating it per tool. */
function instrumented(
  opts: CreateBrowserToolServerOptions,
  toolName: string,
  input: unknown,
  fn: () => Promise<{ text: string }>
) {
  return (async () => {
    const actionId = randomUUID();
    const startedAt = Date.now();
    opts.bus.emitEvent({
      type: "browser-action-started",
      runId: opts.runId,
      browserSessionId: opts.sessions.get(opts.runId)?.browserSessionId ?? "",
      actionId,
      toolName,
      input,
      ts: new Date().toISOString(),
    });
    let result: { text: string };
    let isError = false;
    try {
      result = await fn();
    } catch (err) {
      isError = true;
      result = { text: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
    opts.bus.emitEvent({
      type: "browser-action-completed",
      runId: opts.runId,
      browserSessionId: opts.sessions.get(opts.runId)?.browserSessionId ?? "",
      actionId,
      toolName,
      result: result.text.slice(0, 2000),
      isError,
      durationMs: Date.now() - startedAt,
      ts: new Date().toISOString(),
    });
    return { result, isError };
  })();
}

const refArg = z.string().optional().describe("An element ref from the latest inspect, like s1e3 (preferred)");
const selectorArg = z.string().optional().describe("A CSS selector, if there's no ref for the element");

/** The browser tool definitions, keyed by name. Exported (as __testHandlers) so tests can call a
 * handler directly without standing up a real MCP client/transport -- the same reasoning
 * test/safety-net.mjs and test/approval-server.mjs already apply to hooks and the server. */
export function __testHandlers(opts: CreateBrowserToolServerOptions) {
  const { runId, bus, sessions } = opts;

  const requireSession = (): BrowserSession => {
    const session = sessions.get(runId);
    if (!session) throw new Error("No open browser session -- call open first.");
    return session;
  };

  /** Runs `fn` as the tool body and returns an MCP text result -- every tool but screenshot. */
  const textTool = (name: string, input: unknown, fn: () => Promise<{ text: string }>) =>
    instrumented(opts, name, input, fn).then(({ result, isError }) => ({ content: [{ type: "text" as const, text: result.text }], isError }));

  /** Names any tabs that opened during an action, so the model hears about a popup without polling. */
  const newTabsNote = (session: BrowserSession, before: Set<string>): string => {
    const fresh = session.tabs.filter((t) => !before.has(t.id)).map((t) => t.id);
    return fresh.length ? ` New tab opened: ${fresh.join(", ")} (list_tabs to see it, switch_tab to use it).` : "";
  };

  const open = tool(
    "open",
    "Navigate the active tab to a URL. Only http://localhost or http://127.0.0.1 URLs are allowed.",
    { url: z.string().describe("The URL to navigate to") },
    async ({ url }) =>
      textTool("open", { url }, async () => {
        if (!isAllowedBrowserUrl(url)) {
          throw new Error(`Refused: only http://localhost or http://127.0.0.1 URLs are allowed in this stage, got: ${url}`);
        }
        const session = await sessions.getOrCreate(runId, bus);
        if (!session.tabs.some((t) => t.id === session.activeTabId && !t.page.isClosed())) {
          // Every tab was closed (by the page itself -- close_tab refuses the last one). Start fresh.
          const tab = adoptPage(session, await session.context.newPage());
          if (!tab) throw new Error(`Refused: this session already has ${MAX_TABS_PER_SESSION} tabs open.`);
          activateTab(session, tab);
        }
        const tab = activeTab(session);
        await tab.page.goto(url, { waitUntil: "domcontentloaded" });
        return { text: `Opened ${url} in ${tab.id}. Title: ${cleanText(await tab.page.title(), 200)}` };
      })
  );

  const inspect = tool(
    "inspect",
    "Get the active tab's URL, title, visible text, and its interactive elements, each with a ref like s1e3. " +
      "Pass a ref to click, fill, press, hover, select_option, or scroll. Refs expire when you inspect again, the page navigates, or you switch tabs.",
    {},
    async () =>
      textTool("inspect", {}, async () => {
        const session = requireSession();
        const tab = activeTab(session);
        const url = tab.page.url();
        const title = cleanText(await tab.page.title(), 200);
        const text = (await tab.page.locator("body").innerText().catch(() => "")).slice(0, 3000);
        const { lines, total } = await takeRefSnapshot(session, tab);
        const more = total > lines.length ? `\n(${total - lines.length} more not shown -- scroll or use a selector)` : "";
        return {
          text:
            `URL: ${url}\nTitle: ${title}\nTab: ${tab.id} (${session.tabs.length} open)\n\n` +
            `Visible text (truncated):\n${text}\n\n` +
            `Interactive elements (snapshot s${session.refs!.id}):\n${lines.join("\n") || "(none)"}${more}`,
        };
      })
  );

  const click = tool(
    "click",
    "Click an element by ref (from inspect) or CSS selector.",
    { ref: refArg, selector: selectorArg },
    async ({ ref, selector }) =>
      textTool("click", { ref, selector }, async () => {
        const session = requireSession();
        const target = resolveTarget(session, { ref, selector });
        const before = new Set(session.tabs.map((t) => t.id));
        const tab = activeTab(session);
        try {
          await onTarget(target, (el) => el.click({ timeout: 5000 }));
        } catch (err) {
          if (!(await closedByAction(tab, err))) throw err;
          return { text: `Clicked ${target.label}. Tab ${tab.id} closed while this ran (most likely this click closed it).${newTabsNote(session, before)}` };
        }
        return { text: `Clicked ${target.label}.${newTabsNote(session, before)}` };
      })
  );

  const fill = tool(
    "fill",
    "Fill a form field, by ref (from inspect) or CSS selector, with a value.",
    { ref: refArg, selector: selectorArg, value: z.string() },
    async ({ ref, selector, value }) =>
      textTool("fill", { ref, selector, value }, async () => {
        const session = requireSession();
        const target = resolveTarget(session, { ref, selector });
        await onTarget(target, (el) => el.fill(value, { timeout: 5000 }));
        return { text: `Filled ${target.label}` };
      })
  );

  const press = tool(
    "press",
    "Press a keyboard key, optionally focusing an element (by ref or CSS selector) first.",
    {
      key: z.string().describe('Key name, e.g. "Enter", "Tab", "ArrowDown"'),
      ref: refArg,
      selector: selectorArg,
    },
    async ({ key, ref, selector }) =>
      textTool("press", { key, ref, selector }, async () => {
        const session = requireSession();
        const target = ref || selector ? resolveTarget(session, { ref, selector }) : undefined;
        if (target) await onTarget(target, (el) => el.focus());
        const before = new Set(session.tabs.map((t) => t.id));
        const tab = activeTab(session);
        try {
          await tab.page.keyboard.press(key);
        } catch (err) {
          if (!(await closedByAction(tab, err))) throw err;
          return { text: `Pressed ${key}${target ? ` on ${target.label}` : ""}. Tab ${tab.id} closed while this ran (most likely this key closed it).${newTabsNote(session, before)}` };
        }
        return { text: `Pressed ${key}${target ? ` on ${target.label}` : ""}.${newTabsNote(session, before)}` };
      })
  );

  const hover = tool(
    "hover",
    "Move the mouse over an element, by ref (from inspect) or CSS selector -- for menus and tooltips that open on hover.",
    { ref: refArg, selector: selectorArg },
    async ({ ref, selector }) =>
      textTool("hover", { ref, selector }, async () => {
        const session = requireSession();
        const target = resolveTarget(session, { ref, selector });
        await onTarget(target, (el) => el.hover({ timeout: 5000 }));
        return { text: `Hovering over ${target.label}` };
      })
  );

  const selectOption = tool(
    "select_option",
    "Choose option(s) in a <select>, by ref (from inspect) or CSS selector. Each value matches an option's value or its visible label.",
    { ref: refArg, selector: selectorArg, values: z.array(z.string()).min(1).max(20) },
    async ({ ref, selector, values }) =>
      textTool("select_option", { ref, selector, values }, async () => {
        const session = requireSession();
        const target = resolveTarget(session, { ref, selector });
        const chosen = await onTarget(target, (el) => el.selectOption(values, { timeout: 5000 }));
        return { text: `Selected ${JSON.stringify(chosen.map((v) => cleanText(v, 60)))} in ${target.label}` };
      })
  );

  const scroll = tool(
    "scroll",
    "Scroll an element (by ref or CSS selector) into view, or scroll the page by dx/dy CSS pixels.",
    {
      ref: refArg,
      selector: selectorArg,
      dx: z.number().int().min(-20000).max(20000).optional(),
      dy: z.number().int().min(-20000).max(20000).optional().describe("Positive scrolls down"),
    },
    async ({ ref, selector, dx, dy }) =>
      textTool("scroll", { ref, selector, dx, dy }, async () => {
        const session = requireSession();
        const tab = activeTab(session);
        if (ref || selector) {
          if (dx || dy) throw new Error("Pass a ref/selector to scroll into view, or dx/dy to scroll the page -- not both.");
          const target = resolveTarget(session, { ref, selector });
          await onTarget(target, (el) => el.scrollIntoViewIfNeeded({ timeout: 5000 }));
          const at = await readScroll(tab.page);
          return { text: `Scrolled ${target.label} into view; page scroll is now (${at.x}, ${at.y})` };
        }
        if (!dx && !dy) throw new Error("Pass a ref or selector to scroll into view, or a non-zero dx/dy.");
        await tab.page.evaluate(([x, y]) => (globalThis as any).scrollBy({ left: x, top: y, behavior: "instant" }), [dx ?? 0, dy ?? 0]);
        const at = await readScroll(tab.page);
        return { text: `Scrolled the page; scroll is now (${at.x}, ${at.y})` };
      })
  );

  const screenshot = tool(
    "screenshot",
    "Capture the active tab's viewport. Returns the image plus a snapshotId; its pixels are CSS pixels, so a point read " +
      "off it can be passed straight to click_at or scroll_at with that snapshotId.",
    {},
    async () => {
      let pngBase64 = "";
      const { result, isError } = await instrumented(opts, "screenshot", {}, async () => {
        const session = requireSession();
        const tab = activeTab(session);
        if (session.screenshotCount >= MAX_SCREENSHOTS_PER_SESSION) {
          throw new Error(`Refused: this session already took ${MAX_SCREENSHOTS_PER_SESSION} screenshots, the limit for one run.`);
        }
        session.screenshotCount += 1;
        const scroll = await readScroll(tab.page);
        // scale "css": one image pixel per CSS pixel whatever the device scale factor, so a
        // coordinate read off the image is the coordinate click_at dispatches.
        const buf = await tab.page.screenshot({ type: "png", scale: "css" });
        const vp = tab.page.viewportSize() ?? { width: 0, height: 0 };
        session.shot = {
          id: `shot-${++session.shotCounter}`,
          tabId: tab.id,
          navGen: tab.navGen,
          width: vp.width,
          height: vp.height,
          scrollX: scroll.x,
          scrollY: scroll.y,
        };
        pngBase64 = buf.toString("base64");
        mkdirSync(opts.artifactDir, { recursive: true });
        const fileName = `screenshot-${Date.now()}-${randomUUID().slice(0, 8)}.png`;
        const filePath = join(opts.artifactDir, fileName);
        writeFileSync(filePath, buf);
        const url = tab.page.url();
        const title = await tab.page.title();
        bus.emitEvent({
          type: "browser-snapshot",
          runId,
          browserSessionId: session.browserSessionId,
          url,
          title,
          screenshotPath: filePath,
          ts: new Date().toISOString(),
        });
        bus.emitEvent({
          type: "browser-artifact-created",
          runId,
          browserSessionId: session.browserSessionId,
          kind: "screenshot",
          path: filePath,
          ts: new Date().toISOString(),
        });
        // The filename is enough for a human reading the transcript to know a screenshot was taken;
        // the full path is local-machine/sandbox structure (temp dir layout, possibly a username)
        // that has no reason to be visible text in the transcript, the SQLite index, every
        // WebSocket message, and by extension any screenshot or saved report someone shares --
        // exactly what happened to this project's own docs/UI.md demo media. The real path is
        // still available internally via the browser-snapshot/browser-artifact-created events above.
        return {
          text: `Screenshot saved (${fileName}). snapshotId ${session.shot.id}, ${vp.width}x${vp.height} CSS pixels, tab ${tab.id}.`,
        };
      });
      return {
        content: [
          { type: "text", text: result.text },
          ...(pngBase64 ? [{ type: "image" as const, data: pngBase64, mimeType: "image/png" }] : []),
        ],
        isError,
      };
    }
  );

  const clickAt = tool(
    "click_at",
    "Click a point read off a screenshot. Needs that screenshot's snapshotId; it's refused if the page navigated, " +
      "scrolled, or resized since. Prefer click with a ref when the element has one.",
    {
      x: z.number().describe("CSS pixels from the screenshot's left edge"),
      y: z.number().describe("CSS pixels from the screenshot's top edge"),
      snapshotId: z.string().describe("The snapshotId the screenshot returned, like shot-2"),
      button: z.enum(["left", "right", "middle"]).optional(),
    },
    async ({ x, y, snapshotId, button }) =>
      textTool("click_at", { x, y, snapshotId, button }, async () => {
        const session = requireSession();
        const tab = await checkShot(session, snapshotId, x, y);
        const before = new Set(session.tabs.map((t) => t.id));
        try {
          await tab.page.mouse.click(x, y, { button: button ?? "left" });
        } catch (err) {
          if (!(await closedByAction(tab, err))) throw err;
          return { text: `Clicked (${x}, ${y}) on ${snapshotId}. Tab ${tab.id} closed while this ran (most likely this click closed it).${newTabsNote(session, before)}` };
        }
        return { text: `Clicked (${x}, ${y}) on ${snapshotId}.${newTabsNote(session, before)}` };
      })
  );

  const scrollAt = tool(
    "scroll_at",
    "Scroll with the mouse wheel at a point read off a screenshot -- for scrollable panels. Needs that screenshot's " +
      "snapshotId. The page moves, so take a new screenshot before using coordinates again.",
    {
      x: z.number(),
      y: z.number(),
      snapshotId: z.string(),
      dx: z.number().int().min(-20000).max(20000).optional(),
      dy: z.number().int().min(-20000).max(20000).optional().describe("Positive scrolls down"),
    },
    async ({ x, y, snapshotId, dx, dy }) =>
      textTool("scroll_at", { x, y, snapshotId, dx, dy }, async () => {
        const session = requireSession();
        if (!dx && !dy) throw new Error("Pass a non-zero dx or dy.");
        const tab = await checkShot(session, snapshotId, x, y);
        await tab.page.mouse.move(x, y);
        await tab.page.mouse.wheel(dx ?? 0, dy ?? 0);
        return { text: `Scrolled at (${x}, ${y}) by (${dx ?? 0}, ${dy ?? 0}). Take a new screenshot before using coordinates again.` };
      })
  );

  const listTabs = tool(
    "list_tabs",
    "List this session's open tabs -- including popups the page opened -- and which one is active.",
    {},
    async () =>
      textTool("list_tabs", {}, async () => {
        const session = requireSession();
        const lines = await Promise.all(
          session.tabs.map(async (t) => {
            const title = cleanText(await t.page.title().catch(() => ""), 80);
            const active = t.id === session.activeTabId ? " (active)" : "";
            return `${t.id}${active} ${JSON.stringify(title)} ${cleanText(t.page.url(), 200)}`;
          })
        );
        const refused = session.refusedTabs
          ? `\n${session.refusedTabs} more popup(s) were closed as they opened: a session holds at most ${MAX_TABS_PER_SESSION} tabs.`
          : "";
        return { text: `${session.tabs.length} tab(s) open:\n${lines.join("\n")}${refused}` };
      })
  );

  const switchTab = tool(
    "switch_tab",
    "Make another tab the active one. Refs and snapshotIds from the previous tab stop working.",
    { tabId: z.string().describe("A tab id from list_tabs, like t2") },
    async ({ tabId }) =>
      textTool("switch_tab", { tabId }, async () => {
        const session = requireSession();
        const tab = session.tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No open tab ${cleanText(tabId, 20)}. Open tabs: ${session.tabs.map((t) => t.id).join(", ") || "none"}.`);
        if (tab.id === session.activeTabId) return { text: `${tab.id} is already the active tab.` };
        await tab.page.bringToFront();
        activateTab(session, tab);
        return { text: `Switched to ${tab.id}: ${cleanText(tab.page.url(), 200)}. Call inspect or screenshot to act on it.` };
      })
  );

  const closeTab = tool(
    "close_tab",
    "Close a tab. The last open tab can't be closed.",
    { tabId: z.string().describe("A tab id from list_tabs, like t2") },
    async ({ tabId }) =>
      textTool("close_tab", { tabId }, async () => {
        const session = requireSession();
        const tab = session.tabs.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No open tab ${cleanText(tabId, 20)}. Open tabs: ${session.tabs.map((t) => t.id).join(", ") || "none"}.`);
        if (session.tabs.length === 1) throw new Error(`Refused: ${tab.id} is the only open tab.`);
        await tab.page.close();
        forgetTab(session, tab); // the page's own "close" event does this too; doing it here makes it certain before we answer
        return { text: `Closed ${tab.id}. Active tab: ${session.activeTabId}.` };
      })
  );

  const wait = tool(
    "wait",
    "Wait for a selector to appear, or for a fixed timeout if no selector is given.",
    {
      selector: z.string().optional(),
      timeoutMs: z.number().int().positive().max(30000).optional(),
    },
    async ({ selector, timeoutMs }) =>
      textTool("wait", { selector, timeoutMs }, async () => {
        const session = requireSession();
        const page = activeTab(session).page;
        const timeout = timeoutMs ?? 5000;
        if (selector) await page.locator(selector).waitFor({ timeout });
        else await page.waitForTimeout(timeout);
        return { text: selector ? `${selector} appeared` : `waited ${timeout}ms` };
      })
  );

  return {
    open,
    inspect,
    click,
    fill,
    press,
    hover,
    select_option: selectOption,
    scroll,
    wait,
    screenshot,
    click_at: clickAt,
    scroll_at: scrollAt,
    list_tabs: listTabs,
    switch_tab: switchTab,
    close_tab: closeTab,
  };
}

export function createBrowserToolServer(opts: CreateBrowserToolServerOptions): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "browser",
    version: "0.1.0",
    tools: Object.values(__testHandlers(opts)),
  });
}
