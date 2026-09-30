// Drives the real approval UI (ui/index.html, served by src/server.ts) in a real Chromium with a
// synthetic event sequence covering every event the UI renders. No API calls: events go straight
// through bus.emitEvent(), the approval round trip goes through the real WebSocket.
//
//   npm run build && npm run test:ui
//
// Checks the parts a person actually relies on: the phase stepper, live cost, tool calls merged
// with their output, the permission prompt pinned to the bottom and answerable from the keyboard,
// "don't ask again" rules, and a reload restoring the whole transcript. Saves screenshots to
// docs/screenshots/approval-ui/.
import { chromium } from "playwright-core";
import { readdirSync, existsSync, mkdtempSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { EventBus } from "../dist/bus.js";
import { Store } from "../dist/store.js";
import { startServer } from "../dist/server.js";

/** The sandbox's pre-installed Chromium when present; otherwise playwright-core's own install
 * (`npx playwright-core install chromium`, as CI does). */
function findPreinstalledChrome() {
  if (process.env.AGENT_LOOP_CHROME_PATH) return process.env.AGENT_LOOP_CHROME_PATH;
  const root = "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => d.startsWith("chromium-"));
  const exe = dir && join(root, dir, "chrome-linux", "chrome");
  return exe && existsSync(exe) ? exe : undefined;
}

const PORT = 4610;
const runId = "ui-render-test-run";
const workDir = "/tmp/demo-project";
const artifactRoot = mkdtempSync(join(tmpdir(), "agent-loop-ui-artifacts-"));
mkdirSync(join(artifactRoot, runId), { recursive: true });
const demoShot = join(process.cwd(), "docs", "screenshots", "browser-agent", "01-open-fill-click-screenshot.png");
const shotPath = join(artifactRoot, runId, "shot.png");
copyFileSync(demoShot, shotPath);
// The committed demo screenshots are only rewritten on request (SAVE_UI_SCREENSHOTS=1): a test run that
// quietly rewrote tracked binary files left the working tree dirty after every `npm test`.
const shotsOut = process.env.SAVE_UI_SCREENSHOTS === "1"
  ? join(process.cwd(), "docs", "screenshots", "approval-ui")
  : mkdtempSync(join(tmpdir(), "agent-loop-ui-shots-"));
mkdirSync(shotsOut, { recursive: true });

const store = new Store(join(mkdtempSync(join(tmpdir(), "agent-loop-ui-db-")), "t.db"));
const bus = new EventBus(store);
const srv = await startServer(bus, PORT, { artifactRoot });

const consoleErrors = [];
const pageErrors = [];
const browser = await chromium.launch({ executablePath: findPreinstalledChrome() });
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
page.on("console", (msg) => msg.type() === "error" && consoleErrors.push(msg.text()));
page.on("pageerror", (err) => pageErrors.push(err.message));

await page.goto(srv.url, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.getElementById("status")?.textContent === "live", undefined, { timeout: 5000 });
console.log("[ok] page loaded and WebSocket reports live");

const ts = () => new Date().toISOString();
const verdictJson = '```json\n{"completed":true,"outcome":"pass","headline":"x"}\n```';
const seq = [
  { type: "run-start", runId, task: "Add a /health route that returns uptime", workDir, ts: ts() },
  { type: "phase-start", runId, phase: "planner", attempt: 1, ts: ts() },
  { type: "thinking", runId, phase: "planner", text: "The repo has server.js with a /ping route…", ts: ts() },
  { type: "tool-call", runId, phase: "planner", toolUseId: "r1", toolName: "Read", toolInput: { file_path: `${workDir}/server.js` }, ts: ts() },
  { type: "tool-result", runId, phase: "planner", toolUseId: "r1", toolName: "", isError: false, summary: Array.from({ length: 12 }, (_, i) => `line ${i + 1} of server.js`).join("\n"), ts: ts() },
  { type: "assistant-text", runId, phase: "planner", text: "I'll add **/health** next to `/ping`.\n\n" + verdictJson, ts: ts() },
  { type: "usage", runId, phase: "planner", role: "phase", costUsd: 0.07, turns: 4, durationMs: 40000, ts: ts() },
  {
    type: "phase-end", runId, phase: "planner", attempt: 1,
    verdict: { completed: true, outcome: "pass", headline: "Wrote PLAN.md", details: "Plan covers the /health route.", concerns: [], blockingFindings: [] },
    ts: ts(),
  },
  { type: "overseer-decision", runId, phase: "planner", decision: { action: "continue", reasoning: "Plan looks complete." }, ts: ts() },
  { type: "usage", runId, phase: "planner", role: "overseer", costUsd: 0.01, turns: 1, durationMs: 3000, ts: ts() },
  { type: "phase-start", runId, phase: "test-designer", attempt: 1, ts: ts() },
  {
    type: "phase-end", runId, phase: "test-designer", attempt: 1,
    verdict: { completed: true, outcome: "pass", headline: "Skipped", details: "Planner suggested skipping.", concerns: [], blockingFindings: [] },
    ts: ts(),
  },
  { type: "phase-start", runId, phase: "builder", attempt: 1, ts: ts() },
  { type: "tool-call", runId, phase: "builder", toolUseId: "t1", toolName: "Write", toolInput: { file_path: `${workDir}/server.js`, content: "..." }, ts: ts() },
  { type: "tool-result", runId, phase: "builder", toolUseId: "t1", toolName: "", isError: false, summary: "File created successfully", ts: ts() },
  { type: "tool-call", runId, phase: "builder", toolUseId: "b1", toolName: "mcp__browser__open", toolInput: { url: "http://127.0.0.1:9999" }, ts: ts() },
  { type: "browser-session-started", runId, browserSessionId: "bs-1", ts: ts() },
  { type: "browser-snapshot", runId, browserSessionId: "bs-1", url: "http://127.0.0.1:9999/", title: "agent-loop demo (before)", screenshotPath: shotPath, ts: ts() },
  { type: "tool-result", runId, phase: "builder", toolUseId: "b1", toolName: "", isError: false, summary: "Opened http://127.0.0.1:9999. Title: demo", ts: ts() },
  { type: "tool-call", runId, phase: "builder", toolUseId: "b2", toolName: "mcp__browser__click", toolInput: { ref: "s1e3" }, ts: ts() },
  { type: "tool-result", runId, phase: "builder", toolUseId: "b2", toolName: "", isError: false, summary: "Clicked s1e3.", ts: ts() },
  { type: "tool-call", runId, phase: "builder", toolUseId: "b3", toolName: "mcp__browser__click_at", toolInput: { x: 640, y: 212, snapshotId: "shot-1" }, ts: ts() },
  { type: "tool-result", runId, phase: "builder", toolUseId: "b3", toolName: "", isError: false, summary: "Clicked (640, 212) on shot-1.", ts: ts() },
  { type: "browser-snapshot", runId, browserSessionId: "bs-1", url: "http://127.0.0.1:9999/done", title: "agent-loop demo (after)", screenshotPath: shotPath, ts: ts() },
  // browser-session-ended is emitted later (after the browser-panel checks below), not here, so
  // there's a real window where the session is still live to assert the live indicator against --
  // otherwise this whole scenario would already be over before any interactive test block runs.
  { type: "usage", runId, phase: "builder", role: "phase", costUsd: 0.3, turns: 12, durationMs: 90000, ts: ts() },
  {
    type: "phase-end", runId, phase: "builder", attempt: 1,
    verdict: { completed: true, outcome: "fail", headline: "Tests fail", details: "One test failed.", concerns: [], blockingFindings: ["assertion error in test_health.py"] },
    ts: ts(),
  },
  { type: "overseer-decision", runId, phase: "builder", decision: { action: "repair", repairTarget: "builder", reasoning: "Fix the failing test.", feedbackForRepair: "See VERIFY.md" }, ts: ts() },
  { type: "decisions-log-updated", runId, content: "## D-001\nUsing in-memory uptime counter.", ts: ts() },
  { type: "trusted-decision-recorded", runId, phase: "builder", text: "Use an in-memory counter, not a real clock dependency.", ts: ts() },
  { type: "phase-start", runId, phase: "builder", attempt: 2, ts: ts() },
  { type: "tool-call", runId, phase: "builder", toolUseId: "t2", toolName: "Bash", toolInput: { command: "npm test" }, ts: ts() },
];
for (const ev of seq) bus.emitEvent(ev);

// --- transcript: tool calls merged with their output, collapsed like Claude Code
await page.waitForSelector(".blk.tool .name");
assert.ok((await page.locator(".blk.tool", { hasText: "Read(server.js)" }).count()) === 1, "Read shows as one line with a workDir-relative path");
assert.ok((await page.locator(".blk.tool", { hasText: "+9 lines (click to expand)" }).count()) === 1, "long output collapses to 3 lines + a count");
await page.locator(".more").first().click();
assert.ok((await page.locator(".blk.tool", { hasText: "line 12 of server.js" }).count()) === 1, "clicking expands the full output");
assert.ok((await page.locator("text=browser.open").count()) >= 1, "browser tools get a readable label");
assert.strictEqual(await page.locator(".blk.tool", { hasText: "browser.click(s1e3)" }).count(), 1, "a click by ref shows the ref");
assert.strictEqual(await page.locator(".blk.tool", { hasText: "browser.click_at(640, 212 @ shot-1)" }).count(), 1, "click_at shows the point and its snapshotId");
const bodyText = await page.locator("#transcript").innerText();
assert.ok(!bodyText.includes('"outcome":"pass"'), "the raw ```json verdict block must not be dumped into the transcript");
console.log("[ok] transcript: one line per tool call, output attached and collapsed, no raw verdict JSON");

// --- stepper + header
const stepStates = await page.$$eval(".step", (els) => Object.fromEntries(els.map((e) => [e.dataset.phase, e.dataset.state])));
assert.deepStrictEqual(stepStates, { planner: "pass", "test-designer": "skipped", builder: "active", verifier: "pending", gatekeeper: "pending" });
assert.ok((await page.locator('.step[data-phase="builder"] .badge').innerText()).includes("↺1"), "repair count shows on the step");
assert.strictEqual(await page.locator("#cost").innerText(), "0.38", "header cost sums every usage event");
console.log("[ok] stepper shows pass/skipped/active/pending + repair badge; header shows live cost");

// --- permission prompt: pinned at the bottom, answerable with the keyboard
const req1 = bus.requestApproval({ runId, phase: "builder", toolUseId: "t2", toolName: "Bash", toolInput: { command: "npm test" }, rule: "Bash(npm test:*)" });
await page.waitForSelector("#prompt");
assert.ok(await page.locator("#prompt").isVisible(), "the prompt is visible without scrolling");
assert.ok((await page.locator("#prompt").innerText()).includes("Bash(npm test:*)"), "option 2 names the exact rule it would create");
assert.ok((await page.locator(".blk.tool .tag.wait").count()) === 1, "the tool line is tagged as awaiting approval");
assert.ok((await page.title()).startsWith("(1)"), "tab title shows the pending count");
await page.screenshot({ path: join(shotsOut, "02-permission-prompt.png") });
await page.keyboard.press("2");
const d1 = await req1.wait;
assert.deepStrictEqual([d1.decision, d1.remember], ["allow", true], "pressing 2 approves and asks to remember");
bus.addAllowRule("Bash(npm test:*)");
bus.emitEvent({ type: "approval-resolved", runId, phase: "builder", requestId: req1.requestId, toolUseId: "t2", decision: "allow", auto: false, rememberedRule: "Bash(npm test:*)", ts: ts() });
// The prompt disappears the moment the key is pressed; the rule arrives with the server's
// approval-resolved event a moment later, so wait for the rule itself, not just the input box.
await page.waitForSelector("#decision-input");
await page.waitForFunction(() => document.getElementById("rules").innerText.includes("Bash(npm test:*)"), undefined, { timeout: 5000 });
console.log("[ok] prompt pinned at the bottom; key 2 = approve + don't ask again; rule shows in the side panel");

// --- several approvals pending at once: real parallel tool calls within the SAME phase, the only
// way this can happen (pipeline.ts awaits each phase fully before starting the next, so two
// DIFFERENT phases can never both have a pending approval -- confirmed against pipeline.ts's own
// control flow, not assumed, since an earlier draft of this screenshot showed two phases waiting at
// once, which is impossible in the real product).
{
  const calls = [
    { toolUseId: "p1", toolName: "Bash", toolInput: { command: "npm run lint" } },
    { toolUseId: "p2", toolName: "Bash", toolInput: { command: "npm run typecheck" } },
    { toolUseId: "p3", toolName: "Write", toolInput: { file_path: `${workDir}/health.test.js`, content: "..." } },
  ];
  for (const c of calls) bus.emitEvent({ type: "tool-call", runId, phase: "builder", ts: ts(), ...c });
  const reqs = calls.map((c) => bus.requestApproval({ runId, phase: "builder", ...c }));
  await page.waitForFunction(() => document.querySelector(".wait-badge")?.textContent === "3", undefined, { timeout: 5000 });
  assert.ok((await page.locator("#prompt .count").innerText()).includes("3 waiting"), "the dock names how many are waiting and which phase");
  await page.screenshot({ path: join(shotsOut, "07-multiple-pending-approvals.png") });
  for (const [i, r] of reqs.entries()) {
    bus.resolveApproval(r.requestId, { decision: "allow" });
    bus.emitEvent({ type: "approval-resolved", runId, phase: "builder", requestId: r.requestId, toolUseId: calls[i].toolUseId, decision: "allow", auto: false, ts: ts() });
  }
  await page.waitForFunction(() => !document.querySelector("#prompt"), undefined, { timeout: 5000 });
  console.log("[ok] several real parallel tool calls in one phase all show as pending; dock names the breakdown");
}

// --- reject with feedback
bus.emitEvent({ type: "tool-call", runId, phase: "builder", toolUseId: "t3", toolName: "Bash", toolInput: { command: "rm -r build && npm run build" }, ts: ts() });
const req2 = bus.requestApproval({ runId, phase: "builder", toolUseId: "t3", toolName: "Bash", toolInput: { command: "rm -r build && npm run build" } });
await page.waitForSelector("#prompt");
assert.strictEqual(await page.locator('#prompt .opt[data-choice="remember"]').count(), 0, "a chained command never offers 'don't ask again'");
await page.keyboard.press("n");
await page.locator("#fb-text").fill("don't delete build/, just rebuild");
await page.keyboard.press("Enter");
const d2 = await req2.wait;
assert.deepStrictEqual([d2.decision, d2.reason], ["deny", "don't delete build/, just rebuild"]);
bus.emitEvent({ type: "approval-resolved", runId, phase: "builder", requestId: req2.requestId, toolUseId: "t3", decision: "deny", reason: d2.reason, auto: false, ts: ts() });
await page.waitForSelector(".blk.tool.denied");
console.log("[ok] n → type what to do instead → Enter rejects with that feedback; tool line marked rejected");

// --- a trusted decision from the bottom input
await page.locator("#decision-input").fill("Keep uptime in memory");
await page.keyboard.press("Enter");
await page.waitForSelector('.blk.trusted:has-text("Keep uptime in memory")');
console.log("[ok] typing a decision in the bottom input records it as trusted");

bus.emitEvent({ type: "approval-auto-allowed", runId, phase: "builder", toolUseId: "t2", toolName: "Bash", rule: "Bash(npm test:*)", ts: ts() });
bus.emitEvent({ type: "run-end", runId, status: "failed", ts: ts() });
await page.waitForSelector(".blk.run-end");
assert.ok((await page.locator(".blk.run-end").innerText()).includes("$0.38"), "the final summary carries total cost");

// --- browser panel: live indicator, and a gallery of every snapshot this run (not just the latest)
await page.waitForSelector("#browser-panel.live img.shot-main");
const imgLoaded = await page.locator("#browser-panel img.shot-main").evaluate((img) => img.complete && img.naturalWidth > 0);
assert.ok(imgLoaded, "the browser panel's screenshot actually loads");
assert.ok((await page.locator("#browser-panel").innerText()).includes("agent-loop demo"));
console.log("[ok] browser panel shows the real screenshot and page title");
assert.strictEqual(await page.locator("#browser-panel .live-dot").count(), 1, "an active browser session shows a live indicator");
assert.strictEqual(await page.locator("#browser-panel .shot-gallery img").count(), 2, "every snapshot this run appears in the gallery, not just the latest");
assert.ok((await page.locator("#browser-panel div").first().innerText()) === "agent-loop demo (after)", "the main view follows the newest snapshot by default");
await page.locator('#browser-panel .shot-gallery img[data-idx="0"]').click();
assert.ok((await page.locator("#browser-panel div").first().innerText()) === "agent-loop demo (before)", "clicking an older thumbnail pins the view to it");
assert.strictEqual(await page.locator("#browser-panel .shot-jump-live").count(), 1, "pinned to an old snapshot: a way back to live appears");
await page.locator("#browser-panel .shot-jump-live").click();
assert.ok((await page.locator("#browser-panel div").first().innerText()) === "agent-loop demo (after)", "jump to live returns to the newest snapshot");
assert.strictEqual(await page.locator("#browser-panel .shot-jump-live").count(), 0, "back at live: the jump-back control is gone");
console.log("[ok] browser panel: live indicator, full snapshot gallery, pin-to-older + jump back to live");
await page.screenshot({ path: join(shotsOut, "01-full-dashboard-with-browser-panel.png") });

bus.emitEvent({ type: "browser-session-ended", runId, browserSessionId: "bs-1", status: "completed", ts: ts() });
await page.waitForFunction(() => !document.querySelector("#browser-panel .live-dot"));
assert.strictEqual(await page.locator("#browser-panel .shot-gallery img").count(), 2, "the gallery survives the session ending");
console.log("[ok] the live indicator disappears once the browser session actually ends");

// --- Desktop theme: same DOM, same events, pure CSS reskin -- captured at the same populated state
// as the shot above so the two are a fair visual comparison. Toggled back afterward so it doesn't
// change what theme every later assertion/screenshot in this file runs under.
await page.locator("#theme-toggle").click();
await page.waitForFunction(() => document.documentElement.dataset.theme === "desktop");
await page.screenshot({ path: join(shotsOut, "06-desktop-theme.png") });
await page.locator("#theme-toggle").click();
await page.waitForFunction(() => document.documentElement.dataset.theme !== "desktop");
console.log("[ok] desktop theme toggles via the header button and back");

// --- reload: the whole transcript comes back from the server's replay
const before = await page.locator("#transcript .blk").count();
await page.reload();
await page.waitForFunction(() => document.getElementById("status")?.textContent === "live");
await page.waitForFunction((n) => document.querySelectorAll("#transcript .blk").length >= n, before, { timeout: 5000 });
assert.strictEqual(await page.locator("#cost").innerText(), "0.38", "cost is rebuilt from replayed usage events");
console.log(`[ok] reload replays the full transcript (${before} blocks) and header state`);

// --- adversarial: a real page's title/URL reach the browser panel and its gallery thumbnails
// (title/url attribute) as literal text, not markup -- a compromised or malicious page could set
// document.title to anything, and this is a new sink this session added (the gallery's per-thumbnail
// title attribute), so it gets its own check rather than assuming the file's existing escaping
// coverage automatically extends to code written after it.
const nastyTitle = '</script><script>window.__pwned=1</script><img src=x onerror="window.__pwned=2">';
bus.emitEvent({ type: "browser-snapshot", runId, browserSessionId: "bs-1", url: "http://127.0.0.1:9999/" + nastyTitle, title: nastyTitle, screenshotPath: shotPath, ts: ts() });
await page.waitForFunction((n) => document.querySelectorAll("#browser-panel .shot-gallery img").length === n, 3, { timeout: 5000 });
assert.ok((await page.locator("#browser-panel").innerText()).includes(nastyTitle), "the nasty title reaches the DOM as literal text");
assert.strictEqual(await page.evaluate(() => window.__pwned), undefined, "it never actually executes");
console.log("[ok] a hostile page title/URL in the browser panel and its gallery thumbnails stays inert text");

assert.deepStrictEqual(consoleErrors, [], `console errors: ${JSON.stringify(consoleErrors)}`);
assert.deepStrictEqual(pageErrors, [], `page errors: ${JSON.stringify(pageErrors)}`);
console.log("[ok] zero console errors or uncaught exceptions");

// --- the run is over and the live server stops: the page keeps everything it showed
const blocksBefore = await page.locator("#transcript .blk").count();
await srv.close();
await page.waitForFunction(() => document.getElementById("status").textContent.includes("run over"), undefined, { timeout: 5000 });
await page.waitForTimeout(2000); // longer than the old reconnect delay that used to wipe it
assert.strictEqual(await page.locator("#transcript .blk").count(), blocksBefore, "the transcript must survive the server shutting down");
console.log("[ok] when the live server stops after the run, the transcript stays on screen");

await browser.close();
console.log("\nALL UI RENDER TESTS PASSED");
