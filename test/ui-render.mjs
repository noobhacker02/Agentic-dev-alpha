// Drives the real approval UI (ui/index.html, served by src/server.ts) with a synthetic event
// sequence covering every AgentEvent variant -- including the new browser-* events, which
// test/browser-approval.mjs (the existing real-browser UI test) never exercises since it only runs
// an ordinary file-editing task. No API calls: events are emitted directly via bus.emitEvent(),
// the same way test/plumbing.mjs drives the bus without a real SDK session.
//
// Requires: npm run build (dist/ must exist), the pre-installed Chromium (see README).
import { chromium } from "playwright-core";
import { readdirSync, existsSync, mkdtempSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { EventBus } from "../dist/bus.js";
import { startServer } from "../dist/server.js";

function findPreinstalledChrome() {
  const root = "/opt/pw-browsers";
  const dir = readdirSync(root).find((d) => d.startsWith("chromium-"));
  if (!dir) throw new Error(`No chromium-* directory found under ${root}`);
  const exe = join(root, dir, "chrome-linux", "chrome");
  if (!existsSync(exe)) throw new Error(`Expected chrome binary not found at ${exe}`);
  return exe;
}

const PORT = 4610;
const runId = "ui-render-test-run";
const artifactRoot = mkdtempSync(join(tmpdir(), "agent-loop-ui-artifacts-"));
mkdirSync(join(artifactRoot, runId), { recursive: true });

// A real PNG (the actual Stage 1 demo screenshot committed to the repo) so the browser panel's
// <img> has something real to load, not a broken link.
const demoShot = join(process.cwd(), "docs", "screenshots", "browser-agent", "01-open-fill-click-screenshot.png");
const shotPath = join(artifactRoot, runId, "shot.png");
copyFileSync(demoShot, shotPath);

const bus = new EventBus();
const srv = await startServer(bus, PORT, { artifactRoot });
console.log(`[setup] UI at ${srv.url}`);

const consoleErrors = [];
const pageErrors = [];
const browser = await chromium.launch({ executablePath: findPreinstalledChrome() });
const page = await browser.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => pageErrors.push(err.message));
const failedUrls = [];
page.on("response", (r) => {
  if (r.status() >= 400) failedUrls.push(`${r.status()} ${r.url()}`);
});

await page.goto(srv.url, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.getElementById("status")?.textContent === "live", undefined, { timeout: 5000 });
console.log("[ok] page loaded and WebSocket reports live");

const ts = () => new Date().toISOString();
const seq = [
  { type: "run-start", runId, task: "Add a /health route", ts: ts() },
  { type: "phase-start", runId, phase: "planner", attempt: 1, ts: ts() },
  {
    type: "phase-end",
    runId,
    phase: "planner",
    attempt: 1,
    verdict: { completed: true, outcome: "pass", headline: "Wrote PLAN.md", details: "Plan covers the /health route.", concerns: [], blockingFindings: [] },
    ts: ts(),
  },
  { type: "overseer-decision", runId, phase: "planner", decision: { action: "continue", reasoning: "Plan looks complete." }, ts: ts() },
  { type: "phase-start", runId, phase: "builder", attempt: 1, ts: ts() },
  { type: "tool-call", runId, phase: "builder", toolUseId: "t1", toolName: "Write", toolInput: { file_path: "server.js", content: "..." }, ts: ts() },
  { type: "tool-result", runId, phase: "builder", toolUseId: "t1", toolName: "Write", isError: false, summary: "File written.", ts: ts() },
  { type: "browser-session-started", runId, browserSessionId: "bs-1", ts: ts() },
  { type: "browser-action-started", runId, browserSessionId: "bs-1", actionId: "a1", toolName: "open", input: { url: "http://127.0.0.1:9999" }, ts: ts() },
  {
    type: "browser-action-completed",
    runId,
    browserSessionId: "bs-1",
    actionId: "a1",
    toolName: "open",
    result: "Opened http://127.0.0.1:9999. Title: demo",
    isError: false,
    durationMs: 42,
    ts: ts(),
  },
  { type: "browser-snapshot", runId, browserSessionId: "bs-1", url: "http://127.0.0.1:9999/", title: "agent-loop demo", screenshotPath: shotPath, ts: ts() },
  { type: "browser-artifact-created", runId, browserSessionId: "bs-1", kind: "screenshot", path: shotPath, ts: ts() },
  { type: "browser-session-ended", runId, browserSessionId: "bs-1", status: "completed", ts: ts() },
  {
    type: "phase-end",
    runId,
    phase: "builder",
    attempt: 1,
    verdict: { completed: true, outcome: "fail", headline: "Tests fail", details: "One test failed.", concerns: [], blockingFindings: ["assertion error in test_health.py"] },
    ts: ts(),
  },
  { type: "overseer-decision", runId, phase: "builder", decision: { action: "repair", repairTarget: "builder", reasoning: "Fix the failing test.", feedbackForRepair: "See VERIFY.md" }, ts: ts() },
  { type: "decisions-log-updated", runId, content: "## D-001\nUsing in-memory uptime counter.", ts: ts() },
  { type: "trusted-decision-recorded", runId, phase: "builder", text: "Use an in-memory counter, not a real clock dependency.", ts: ts() },
];

for (const ev of seq) bus.emitEvent(ev);

// Approval flow: request one, confirm the card + banner render, click Approve for real (a real DOM
// click, not a crafted WS message), confirm the pending banner clears.
const { requestId, wait } = bus.requestApproval({ runId, phase: "verifier", toolUseId: "t2", toolName: "Bash", toolInput: { command: "npm test" } });
await page.waitForSelector(".card.approval", { timeout: 5000 });
const bannerText = await page.locator("#pending-banner").textContent();
assert.ok(/1 tool call/.test(bannerText), "pending banner should show the one waiting approval");
console.log("[ok] approval-request renders a card and updates the pending banner");

await page.locator(".card.approval .allow").click();
const decision = await wait;
assert.strictEqual(decision.decision, "allow", "a real click on the Approve button should resolve the hook's promise");
// bus.resolveApproval() (called by the server's WS handler) only resolves the pending promise --
// broadcasting "approval-resolved" is createApprovalHook's own job after it awaits that promise
// (hooks.ts), which isn't running here since this test drives the bus directly to avoid a real API
// call. Emit it ourselves, exactly mirroring what the real hook does, so the UI's banner-clearing
// logic (which reacts to that event) gets tested the same way it would in a real run.
bus.emitEvent({ type: "approval-resolved", runId, phase: "verifier", requestId, decision: decision.decision, reason: decision.reason, auto: false, ts: ts() });
await page.waitForFunction(() => document.getElementById("pending-banner").style.display === "none", undefined, { timeout: 5000 });
console.log("[ok] a real DOM click on Approve resolves the pending hook and clears the banner");

bus.emitEvent({ type: "run-end", runId, status: "failed", ts: ts() });

// The browser panel should be showing the real screenshot -- confirm the <img> actually loaded
// (naturalWidth > 0), not just that the tag exists with a src.
await page.waitForSelector("#browser-panel.live img", { timeout: 5000 });
const imgLoaded = await page.locator("#browser-panel img").evaluate((img) => img.complete && img.naturalWidth > 0);
assert.ok(imgLoaded, "the browser panel's screenshot <img> should actually load its real file, not be a broken link");
console.log("[ok] browser panel shows a real, successfully-loaded screenshot");

const panelText = await page.locator("#browser-panel").textContent();
assert.ok(panelText.includes("agent-loop demo"), "browser panel should show the page title from browser-snapshot");
assert.ok(panelText.includes("completed"), "browser panel should reflect the session-ended status");
console.log("[ok] browser panel shows the real page title and session status");

for (const cls of [
  ".card.phase-start", ".card.phase-end.ok", ".card.phase-end.fail", ".card.overseer",
  ".card.tool-call", ".card.tool-result", ".card.browser-session", ".card.browser-action",
  ".card.decisions-log", ".card.trusted-decision", ".card.run",
]) {
  const count = await page.locator(cls).count();
  assert.ok(count > 0, `expected at least one ${cls} card to render`);
}
console.log("[ok] every event type produced its expected card class in the real rendered DOM");

assert.deepStrictEqual(consoleErrors, [], `no browser console errors expected, got: ${JSON.stringify(consoleErrors)}. Failed requests: ${JSON.stringify(failedUrls)}`);
assert.deepStrictEqual(pageErrors, [], `no uncaught page errors expected, got: ${JSON.stringify(pageErrors)}`);
console.log("[ok] zero console errors or uncaught exceptions while rendering the full event sequence");

const screenshotOut = join(
  process.cwd(),
  "docs",
  "screenshots",
  "approval-ui",
  "01-full-dashboard-with-browser-panel.png"
);
mkdirSync(join(process.cwd(), "docs", "screenshots", "approval-ui"), { recursive: true });
await page.screenshot({ path: screenshotOut, fullPage: true });
console.log(`[ok] saved a real screenshot of the rendered dashboard to ${screenshotOut}`);

await browser.close();
await srv.close();
console.log("\nALL UI RENDER TESTS PASSED");
