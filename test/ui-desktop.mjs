// The desktop parts of the real approval UI (ui/index.html, served by src/server.ts) in a real Chromium:
// the side panel for the one window, and -- the part a person actually relies on -- the approval prompt for
// a desktop action: the exact action, the window it targets, and the window as it was captured, with a
// marker on the spot a click would land. No API calls; events go straight through bus.emitEvent().
//
//   npm run build && npm run test:ui-desktop        (SAVE_UI_SCREENSHOTS=1 also saves demo screenshots)
import { chromium } from "playwright-core";
import { readdirSync, existsSync, mkdtempSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { EventBus } from "../dist/bus.js";
import { Store } from "../dist/store.js";
import { startServer } from "../dist/server.js";

function findPreinstalledChrome() {
  if (process.env.AGENT_LOOP_CHROME_PATH) return process.env.AGENT_LOOP_CHROME_PATH;
  const root = "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => d.startsWith("chromium-"));
  const exe = dir && join(root, dir, "chrome-linux", "chrome");
  return exe && existsSync(exe) ? exe : undefined;
}

const PORT = 4611;
const runId = "ui-desktop-test-run";
const artifactRoot = mkdtempSync(join(tmpdir(), "agent-loop-ui-desktop-"));
mkdirSync(join(artifactRoot, runId), { recursive: true });
// A real capture of the real test window (saved by test/desktop-real.mjs with SAVE_DESKTOP_DEMO=1).
const demo = join(process.cwd(), "docs", "screenshots", "desktop", "01-window-capture.png");
assert.ok(existsSync(demo), "docs/screenshots/desktop/01-window-capture.png should exist (run test/desktop-real.mjs with SAVE_DESKTOP_DEMO=1)");
copyFileSync(demo, join(artifactRoot, runId, "cap1.png"));
copyFileSync(demo, join(artifactRoot, runId, "cap2.png"));
const shotsOut = join(process.cwd(), "docs", "screenshots", "approval-ui");

const store = new Store(join(mkdtempSync(join(tmpdir(), "agent-loop-ui-desktop-db-")), "t.db"));
const bus = new EventBus(store);
const srv = await startServer(bus, PORT, { artifactRoot });

const consoleErrors = [];
const pageErrors = [];
const browser = await chromium.launch({ executablePath: findPreinstalledChrome() });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on("console", (msg) => msg.type() === "error" && consoleErrors.push(msg.text()));
page.on("pageerror", (err) => pageErrors.push(err.message));
const dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
await page.goto(srv.url, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.getElementById("status")?.textContent === "live", undefined, { timeout: 5000 });

const ts = () => new Date().toISOString();
const DS = "ds-1";
const emit = (e) => bus.emitEvent({ runId, desktopSessionId: DS, ts: ts(), ...e });
const TITLE = "AgentLoop Test App | ready";
const HOSTILE_TITLE = 'Notes <img src=x onerror="window.__pwned=1"> & "quotes"';

emit({ type: "run-start", task: "Verify the settings dialog", workDir: "/tmp/demo" });
emit({ type: "phase-start", phase: "verifier", attempt: 1 });
emit({ type: "desktop-session-started", target: { processName: "python3.12", appName: "Tk", pid: 4242, windowId: "8388611", title: TITLE }, driverVersion: "0.30.4" });

// ---- the panel: target, live indicator, no capture yet
await page.waitForSelector("#desktop-panel.live");
let panel = await page.locator("#desktop-panel").innerText();
assert.ok(/Desktop · active/i.test(panel) && /python3\.12 \(pid 4242\)/.test(panel) && /no capture yet/.test(panel), panel);
assert.ok(await page.locator("#desktop-panel .live-dot").count() === 1, "a live indicator while the session is active");
assert.ok(/Desktop target/.test(await page.locator("#transcript").innerText()), "the transcript records which window was chosen");
console.log("[ok] panel: shows the one target window and a live indicator before any capture");

// ---- captures: panel shows the newest, a gallery appears, older ones can be pinned
const snap = (n, file) => emit({ type: "desktop-snapshot", snapshotId: `dshot-${n}`, title: TITLE, width: 420, height: 260, screenshotPath: `/somewhere/else/${file}` });
snap(1, "cap1.png");
emit({ type: "desktop-action-started", actionId: "a1", toolName: "capture", input: {} });
emit({
  type: "desktop-action-completed", actionId: "a1", toolName: "capture", isError: false, durationMs: 5,
  result: 'Window python3.12 (pid 4242, window 8388611).\nSnapshot dshot-1: 420x260 px, window-local coordinates.\nAccessibility tree:\n[d1e0] window "App"\n  [d1e1] push-button "Increment"\n  [d1e2] text "Name" value="alice"',
});
await page.waitForSelector("#desktop-panel img.desk-main");
assert.ok(await page.locator("#desktop-panel img.desk-main").evaluate((img) => img.complete && img.naturalWidth > 0), "the capture actually loads (served from the run's artifact dir by file name only)");
snap(2, "cap2.png");
await page.waitForSelector("#desktop-panel .desk-gallery img");
assert.strictEqual(await page.locator("#desktop-panel .desk-gallery img").count(), 2);
await page.locator("#desktop-panel .desk-gallery img").first().click();
await page.waitForSelector("#desktop-panel .desk-jump-live");
await page.locator("#desktop-panel .desk-jump-live").click();
await page.waitForFunction(() => !document.querySelector("#desktop-panel .desk-jump-live"));
panel = await page.locator("#desktop-panel").innerText();
assert.ok(/2 captures · 0 input actions/.test(panel), panel);
console.log("[ok] panel: newest capture, a gallery of every capture, pin an older one and jump back to live");

// ---- approval prompt: click by coordinates -- the exact action, the window, the capture, a marker on the spot
const ask = (toolName, toolInput, id, rule) => {
  bus.emitEvent({ type: "tool-call", runId, phase: "verifier", toolUseId: id, toolName, toolInput, ts: ts() });
  return bus.requestApproval({ runId, phase: "verifier", toolUseId: id, toolName, toolInput, rule });
};
const settle = async (r, id, toolName, decision = "allow") => {
  bus.resolveApproval(r.requestId, { decision });
  bus.emitEvent({ type: "approval-resolved", runId, phase: "verifier", requestId: r.requestId, toolUseId: id, decision, auto: false, ts: ts() });
  await page.waitForFunction(() => !document.querySelector("#prompt"), undefined, { timeout: 5000 });
};
{
  const r = ask("mcp__desktop__click", { x: 105, y: 65, snapshotId: "dshot-2" }, "c1");
  await page.waitForSelector("#prompt");
  const text = await page.locator("#prompt").innerText();
  assert.ok(/Desktop: click/.test(text) && /Window: python3\.12 \(pid 4242\)/.test(text), text);
  assert.ok(/Click at \(105, 65\)/.test(text), "the exact coordinates are in the prompt");
  assert.ok(/the window as captured · dshot-2, 420×260/.test(text), "the prompt names the capture the action was planned from");
  assert.ok(await page.locator("#prompt .desk-shot img").evaluate((img) => img.complete && img.naturalWidth > 0), "...and shows the window as it was captured");
  assert.strictEqual(await page.locator('#prompt .opt[data-choice="remember"]').count(), 0, "a desktop action never offers 'don't ask again'");
  assert.ok(/desktop input: asked every time, one action at a time/.test(text), "and says why");
  const pos = await page.locator("#prompt .desk-mark").evaluate((m) => ({ left: m.style.left, top: m.style.top }));
  assert.ok(Math.abs(parseFloat(pos.left) - (105 / 420) * 100) < 0.01 && Math.abs(parseFloat(pos.top) - (65 / 260) * 100) < 0.01 && pos.left.endsWith("%"), `the marker sits at x/width, y/height of the capture: ${JSON.stringify(pos)}`);
  // The marker lands on the same spot of the picture that the coordinates name.
  const geo = await page.evaluate(() => {
    const img = document.querySelector("#prompt .desk-shot img").getBoundingClientRect();
    const m = document.querySelector("#prompt .desk-mark").getBoundingClientRect();
    return { fx: (m.x + m.width / 2 - img.x) / img.width, fy: (m.y + m.height / 2 - img.y) / img.height };
  });
  assert.ok(Math.abs(geo.fx - 105 / 420) < 0.02 && Math.abs(geo.fy - 65 / 260) < 0.02, `marker centre at ${JSON.stringify(geo)}`);
  if (process.env.SAVE_UI_SCREENSHOTS === "1") await page.screenshot({ path: join(shotsOut, "08-desktop-approval.png") });
  await settle(r, "c1", "mcp__desktop__click");
  console.log("[ok] prompt (click at a point): exact coordinates, the window, the capture it came from, a marker on the exact spot, and no 'don't ask again'");
}

// ---- click by ref says what the element is; an unknown capture is called out
{
  const r = ask("mcp__desktop__click", { ref: "d1e1" }, "c2");
  await page.waitForSelector("#prompt");
  const text = await page.locator("#prompt").innerText();
  assert.ok(/Click element d1e1/.test(text) && /push-button "Increment"/.test(text), `the prompt says what d1e1 is: ${text}`);
  assert.strictEqual(await page.locator("#prompt .desk-mark").count(), 0, "no marker for a click by element");
  await settle(r, "c2", "mcp__desktop__click");

  const r2 = ask("mcp__desktop__click", { x: 5, y: 5, snapshotId: "dshot-77" }, "c3");
  await page.waitForSelector("#prompt");
  assert.ok(/No capture on screen for dshot-77/.test(await page.locator("#prompt").innerText()), "an action whose capture the UI never saw is called out");
  await settle(r2, "c3", "mcp__desktop__click", "deny");
  console.log("[ok] prompt (click by element): names the element from the capture; an unknown capture is flagged");
}

// ---- typed text is shown exactly, with invisible characters made visible, and stays inert
{
  const text = 'hello\n\tworld <script>window.__pwned2=1</script> "x"\u001b[2J';
  const r = ask("mcp__desktop__type_text", { text, snapshotId: "dshot-2" }, "t1");
  await page.waitForSelector("#prompt");
  const shown = await page.locator("#prompt .desk-text").innerText();
  assert.ok(shown.includes("hello↵") && shown.includes("⇥world") && shown.includes("<script>window.__pwned2=1</script>"), `exact text with visible newline/tab: ${JSON.stringify(shown)}`);
  assert.ok(shown.includes("⟨0x1b⟩"), "a control byte in the typed text is shown as a visible marker, not hidden");
  assert.ok(new RegExp("Type " + text.length + " characters, exactly:").test(await page.locator("#prompt").innerText()), "the count is the real length of what would be typed");
  assert.strictEqual(await page.evaluate(() => window.__pwned2), undefined, "typed text is inert in the prompt");
  assert.strictEqual(await page.locator("#prompt .desk-text script").count(), 0);
  await settle(r, "t1", "mcp__desktop__type_text");
  console.log("[ok] prompt (type_text): the exact text, newline and tab made visible, markup inert");
}

// ---- a key press, with modifiers
{
  const r = ask("mcp__desktop__key", { key: "z", modifiers: ["ctrl", "shift"], snapshotId: "dshot-2" }, "k1");
  await page.waitForSelector("#prompt");
  assert.ok(/Press ctrl\+shift\+z/.test(await page.locator("#prompt").innerText()));
  await settle(r, "k1", "mcp__desktop__key");
  console.log("[ok] prompt (key): the key and its modifiers");
}

// ---- observation may earn a rule; input in the same run still can't
{
  // The approval hook offers a rule for capture (approvalPlan in src/hooks.ts), so the request carries one.
  const r = ask("mcp__desktop__capture", {}, "cap", "mcp__desktop__capture");
  await page.waitForSelector("#prompt");
  assert.strictEqual(await page.locator('#prompt .opt[data-choice="remember"]').count(), 1, "capture only looks, so 'don't ask again' is on offer");
  await settle(r, "cap", "mcp__desktop__capture");
}

// ---- labels in the transcript, counts in the panel, and the end of the session
{
  const t = await page.locator("#transcript").innerText();
  assert.ok(/desktop\.click\(105, 65 @ dshot-2\)/.test(t), "a coordinate click reads desktop.click(105, 65 @ dshot-2)");
  assert.ok(/desktop\.click\(d1e1\)/.test(t), "a ref click reads desktop.click(d1e1)");
  assert.ok(/desktop\.key\(ctrl\+shift\+z\)/.test(t), "a key press reads desktop.key(ctrl+shift+z)");
  assert.ok(/desktop\.type_text\(hello world <script>window\.__pwned2=1<\/script> "x"\[2J\)/.test(t), `typed text is one line in the label, with control bytes dropped: ${JSON.stringify(t.match(/desktop\.type_text.*/)?.[0])}`);
  assert.ok(!/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.test(t.replace(/\n/g, "")), "no control byte reaches the transcript text");
  emit({ type: "desktop-action-started", actionId: "a2", toolName: "click", input: {} });
  emit({ type: "desktop-action-started", actionId: "a3", toolName: "type_text", input: {} });
  emit({ type: "desktop-action-started", actionId: "a4", toolName: "window_info", input: {} });
  await page.waitForFunction(() => /2 input actions/.test(document.getElementById("desktop-panel").innerText));
  emit({ type: "desktop-session-ended", status: "completed" });
  await page.waitForFunction(() => /Desktop · completed/i.test(document.getElementById("desktop-panel").innerText));
  assert.strictEqual(await page.locator("#desktop-panel .live-dot").count(), 0, "the live indicator goes away when the session ends");
  if (process.env.SAVE_UI_SCREENSHOTS === "1") await page.screenshot({ path: join(shotsOut, "09-desktop-panel.png") });
  console.log("[ok] transcript labels name what was acted on; the panel counts input actions (not captures or window_info) and drops the live dot at the end");
}

// ---- a hostile window title (the app controls it) is inert everywhere it is shown
{
  emit({ type: "desktop-session-started", target: { processName: "evil<b>app", appName: "x", pid: 7, windowId: "1", title: HOSTILE_TITLE }, driverVersion: "0.30.4" });
  emit({ type: "desktop-snapshot", snapshotId: "dshot-9", title: HOSTILE_TITLE, width: 420, height: 260, screenshotPath: "/somewhere/else/cap1.png" });
  const r = ask("mcp__desktop__click", { x: 1, y: 1, snapshotId: "dshot-9" }, "h1");
  await page.waitForSelector("#prompt");
  assert.ok((await page.locator("#prompt").innerText()).includes('onerror="window.__pwned=1"'), "the hostile title shows up as text in the prompt");
  assert.ok((await page.locator("#desktop-panel").innerText()).includes("<img src=x"), "...and in the panel");
  assert.ok((await page.locator("#transcript").innerText()).includes("evil<b>app"), "...and in the transcript");
  assert.strictEqual(await page.locator("#prompt img[src=x], #desktop-panel img[src=x], #transcript img[src=x]").count(), 0, "none of it became an element");
  assert.ok(!(await page.evaluate(() => [...document.querySelectorAll("b")].some((b) => b.textContent === "app"))), "the <b> in a process name did not become bold markup");
  assert.strictEqual(await page.evaluate(() => window.__pwned), undefined, "and no handler ran");
  await settle(r, "h1", "mcp__desktop__click", "deny");
  console.log("[ok] a hostile window title and process name stay inert in the panel, the prompt and the transcript");
}

assert.deepStrictEqual(dialogs, [], "no script ever ran");
assert.deepStrictEqual([...consoleErrors, ...pageErrors], [], `console/page errors: ${[...consoleErrors, ...pageErrors].join(" | ")}`);
console.log("[ok] zero console errors or uncaught exceptions");

await browser.close();
await srv.close();
store.close();
console.log("\nALL DESKTOP UI TESTS PASSED");
