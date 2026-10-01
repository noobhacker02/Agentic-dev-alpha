// The tree view in the real web UI (ui/index.html, served by src/server.ts) in a real Chromium: the toggle,
// the rows in order with their lanes, the repair branch and its fork/merge, what each phase handed on, files
// by agent, a live update, a reload, a saved report opened from disk -- and hostile text (a file path, a
// headline, a decision) staying inert. No API calls; events go through the real tracker and bus.
//
//   npm run build && npm run test:ui-lineage        (SAVE_UI_SCREENSHOTS=1 also saves docs screenshots)
import { chromium } from "playwright-core";
import { readdirSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { EventBus } from "../dist/bus.js";
import { startServer } from "../dist/server.js";
import { writeRunReport } from "../dist/report.js";
import { LineageTracker } from "../dist/lineage.js";

function findPreinstalledChrome() {
  if (process.env.AGENT_LOOP_CHROME_PATH) return process.env.AGENT_LOOP_CHROME_PATH;
  const root = "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => d.startsWith("chromium-"));
  const exe = dir && join(root, dir, "chrome-linux", "chrome");
  return exe && existsSync(exe) ? exe : undefined;
}

const RUN = "ui-lineage-run";
const EVIL = '<img src=x onerror="window.__pwned=1">';
const NOW = Date.now() - 20 * 60_000;
let t = 0;
const bus = new EventBus();
new LineageTracker(bus).attach();
const tick = () => new Promise((r) => setImmediate(r));
const emit = async (e, dt = 20) => { t += dt; bus.emitEvent({ runId: RUN, ts: new Date(NOW + t * 1000).toISOString(), ...e }); await tick(); };
const verdict = (outcome, headline, extra = {}) => ({ completed: true, outcome, headline, details: "", concerns: [], blockingFindings: [], ...extra });
let id = 0;
const write = async (phase, path, ok = true, tool = "Write") => {
  const toolUseId = `w${++id}`;
  await emit({ type: "tool-call", phase, toolUseId, toolName: tool, toolInput: { file_path: path } }, 2);
  await emit({ type: "tool-result", phase, toolUseId, toolName: tool, isError: !ok, summary: "x" }, 1);
};

const browser = await chromium.launch({ executablePath: findPreinstalledChrome() });
const errors = [];
async function open(srvUrl, url) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => { errors.push(`dialog: ${d.message()}`); d.dismiss(); });
  await page.goto(url ?? srvUrl, { waitUntil: "domcontentloaded" });
  return { page, ctx };
}
const live = (page) => page.waitForFunction(() => document.getElementById("status")?.textContent === "live", undefined, { timeout: 5000 });

const srv = await startServer(bus, 0, { humor: "off" });

// ---------- an empty run
{
  const other = new EventBus();
  const s2 = await startServer(other, 0, { humor: "off" });
  const { page, ctx } = await open(s2.url);
  await live(page);
  await page.locator("#view-toggle").click();
  assert.ok(/No phase has started yet/.test(await page.locator("#tree").innerText()), "before any phase starts, the tree says so instead of showing nothing");
  await ctx.close();
  await s2.close();
  console.log("[ok] empty state: the tree says no phase has started");
}

// ---------- a run with a repair, files, a human decision, and hostile text
await emit({ type: "run-start", task: "Add a settings page", workDir: "/w" }, 1);
await emit({ type: "phase-start", phase: "planner", attempt: 1 });
await emit({ type: "usage", phase: "planner", role: "phase", costUsd: 0.24, turns: 3, durationMs: 1 }, 5);
await emit({ type: "phase-end", phase: "planner", attempt: 1, verdict: verdict("pass", "Plan written", { details: "Two files and a test.", concerns: ["scope is tight"] }) }, 30);
await emit({ type: "overseer-decision", phase: "planner", decision: { action: "continue", reasoning: "plan is clear" } }, 1);
await emit({ type: "phase-start", phase: "builder", attempt: 1 });
await write("builder", "/w/src/settings.js");
await write("builder", "/w/src/settings.js", true, "Edit");
await write("builder", "/w/src/denied.js", false);
await emit({ type: "tool-call", phase: "builder", toolUseId: "evil-tool", toolName: EVIL, toolInput: {} }, 1);
await emit({ type: "approval-request", phase: "builder", requestId: "q1", toolUseId: "q1", toolName: "Bash", toolInput: { command: "npm test" } }, 3);
await emit({ type: "approval-resolved", phase: "builder", requestId: "q1", toolUseId: "q1", decision: "allow", auto: false }, 4);
await emit({ type: "usage", phase: "builder", role: "phase", costUsd: 0.9, turns: 9, durationMs: 1 }, 5);
await emit({ type: "phase-end", phase: "builder", attempt: 1, verdict: verdict("pass", "Settings page built") }, 60);
await emit({ type: "overseer-decision", phase: "builder", decision: { action: "continue", reasoning: "tests pass" } }, 1);
await emit({ type: "phase-start", phase: "verifier", attempt: 1 });
await emit({ type: "phase-end", phase: "verifier", attempt: 1, verdict: verdict("fail", `State is lost on reload ${EVIL}`, { blockingFindings: [`Preference isn't persisted ${EVIL}`] }) }, 40);
await emit({ type: "overseer-decision", phase: "verifier", decision: { action: "repair", repairTarget: "builder", reasoning: `persist it, then re-verify ${EVIL}`, feedbackForRepair: "use localStorage" } }, 1);
await emit({ type: "trusted-decision-recorded", phase: "builder", text: `Use localStorage, not cookies ${EVIL}` }, 2);
await emit({ type: "phase-start", phase: "builder", attempt: 2 });
await write("builder", "/w/src/settings.js", true, "Edit");
await write("builder", `/w/src/${EVIL}.js`);
await emit({ type: "phase-end", phase: "builder", attempt: 2, verdict: verdict("pass", "Persisted") }, 40);
await emit({ type: "overseer-decision", phase: "builder", decision: { action: "continue", reasoning: "ok" } }, 1);
await emit({ type: "phase-start", phase: "verifier", attempt: 2 });
await emit({ type: "phase-end", phase: "verifier", attempt: 2, verdict: verdict("pass", "Verified") }, 30);
await emit({ type: "overseer-decision", phase: "verifier", decision: { action: "continue", reasoning: "good" } }, 1);
await emit({ type: "phase-start", phase: "gatekeeper", attempt: 1 });

{
  const { page, ctx } = await open(srv.url);
  await live(page);

  // the toggle, and the transcript underneath
  assert.strictEqual(await page.locator("#view-toggle").innerText(), "tree");
  assert.ok(await page.locator("#scroll").isVisible() && !(await page.locator("#tree").isVisible()), "the transcript is the default view");
  await page.locator("#view-toggle").click();
  assert.ok(await page.locator("#tree").isVisible() && !(await page.locator("#scroll").isVisible()), "the toggle swaps the transcript for the tree");
  assert.strictEqual(await page.locator("#view-toggle").innerText(), "transcript");

  // rows, in order, with lanes and the branch
  const rows = page.locator("#tree .tn[data-id]");
  assert.deepStrictEqual(await rows.evaluateAll((els) => els.map((e) => e.dataset.id)), ["planner#1", "builder#1", "verifier#1", "builder#2", "verifier#2", "gatekeeper#1"], "every attempt, in order");
  assert.deepStrictEqual(await rows.evaluateAll((els) => els.map((e) => e.classList.contains("lane1") ? 1 : 0)), [0, 0, 0, 1, 1, 0], "the repair re-runs sit on the second lane");
  assert.strictEqual(await page.locator('#tree .tn[data-id="builder#2"]').getAttribute("data-kind"), "repair");
  assert.ok((await page.locator('#tree .tn[data-id="builder#2"]').innerText()).includes("sent back"), "the repair is labelled");
  const order = await page.locator("#tree .tn").evaluateAll((els) => els.map((e) => (e.classList.contains("conn") ? "conn" : e.dataset.id)));
  assert.deepStrictEqual(order, ["planner#1", "builder#1", "verifier#1", "conn", "builder#2", "verifier#2", "conn", "gatekeeper#1"], "a fork before the re-runs and a merge after them");
  assert.strictEqual(await page.locator("#tree .conn svg path").count(), 2);
  assert.strictEqual(await page.locator('#tree .tn[data-id="gatekeeper#1"]').getAttribute("data-outcome"), "running", "the attempt in flight shows as running");
  console.log("[ok] rows: every attempt in order, the repair on its own lane with a fork before it and a merge after, the one in flight marked running");

  // what each attempt carries
  const planner = await page.locator('#tree .tn[data-id="planner#1"]').innerText();
  assert.ok(/pass/.test(planner) && /\$0\.24/.test(planner) && /Plan written/.test(planner) && (await page.locator('#tree .tn[data-id="planner#1"] .says').count()) >= 1 && /Overseer → CONTINUE/.test(planner) && /plan is clear/.test(planner), planner);
  await page.locator('#tree .tn[data-id="planner#1"] summary', { hasText: "what it told the next phase" }).click();
  assert.ok(/Two files and a test\./.test(await page.locator('#tree .tn[data-id="planner#1"]').innerText()) && /scope is tight/.test(await page.locator('#tree .tn[data-id="planner#1"]').innerText()), "the full note it handed on is one click away");
  const b1 = await page.locator('#tree .tn[data-id="builder#1"]').innerText();
  assert.ok(/1 prompt \(1 yes, 0 no\)/.test(b1) && /\$0\.90/.test(b1), b1);
  await page.locator('#tree .tn[data-id="builder#1"] summary', { hasText: "written or edited" }).click();
  const files = await page.locator('#tree .tn[data-id="builder#1"] .files').innerText();
  assert.ok(files.includes("+ /w/src/settings.js") || files.includes("+ src/settings.js"), files);
  assert.ok(/~ (\/w\/)?src\/settings\.js/.test(files), "an edit is marked ~");
  assert.ok(!/denied\.js/.test(files), "a refused write is not listed as the agent's file");
  const sidebar = await page.locator("#files").innerText();
  assert.ok(/settings\.js/.test(sidebar) && !/denied\.js/.test(sidebar), `the old "Files changed" panel agrees: a refused write isn't a changed file (it listed it before): ${sidebar}`);
  assert.ok(/1 refused/.test(await page.locator('#tree .tn[data-id="builder#1"] summary').first().innerText().catch(() => "")) || /1 refused/.test(await page.locator('#tree .tn[data-id="builder#1"]').innerText()), "...but the refusal is counted");
  const v1 = await page.locator('#tree .tn[data-id="verifier#1"]').innerText();
  assert.ok(/fail/.test(v1) && /Overseer → REPAIR builder/.test(v1) && /persist it, then re-verify/.test(v1), v1);
  assert.ok(/you decided: Use localStorage, not cookies/.test(await page.locator('#tree .tn[data-id="builder#1"]').innerText()), "a human decision is attached to the attempt it was made against");
  console.log("[ok] attempts: outcome, cost, prompts, what it handed on (and the full note on click), files written (a refused write counted, never listed), the Overseer's call, and your decisions");

  // the tables
  const made = await page.locator("#tree table").first().innerText();
  assert.ok(/planner[\s\S]*builder[\s\S]*2 \(pass, pass\)[\s\S]*verifier[\s\S]*gatekeeper/.test(made.replace(/\t/g, " ")), made);
  const filesTable = await page.locator("#tree table").nth(1).innerText();
  assert.ok(/settings\.js[\s\S]*builder#1 \(write\), builder#1 \(edit\), builder#2 \(edit\)/.test(filesTable), `blame: who touched settings.js: ${filesTable}`);
  assert.ok(/decisions you recorded/i.test(await page.locator("#tree").innerText()), "the heading is there (it is shown in capitals by CSS)");
  console.log("[ok] tables: made-by per agent, and which attempts touched each file, in order");

  // hostile text
  assert.deepStrictEqual(await page.evaluate(() => typeof window.__pwned), "undefined", "no script ran");
  assert.strictEqual(await page.locator('#tree img[src="x"]').count(), 0, "no element was injected");
  await page.locator('#tree .tn[data-id="builder#1"] summary', { hasText: "tools" }).click();
  const tree = await page.locator("#tree").innerText();
  assert.ok(tree.includes(EVIL), "the hostile text is shown as text");
  const where = await page.locator("#tree").evaluate((el) => ({
    tool: el.querySelector('.tn[data-id="builder#1"] details:last-of-type')?.textContent ?? "",
    reasoning: el.querySelector('.tn[data-id="verifier#1"] .dec')?.textContent ?? "",
    human: el.querySelector('.tn[data-id="builder#1"] .human')?.textContent ?? "",
  }));
  assert.ok(where.tool.includes(EVIL) && where.reasoning.includes(EVIL) && where.human.includes(EVIL), `a hostile tool name, Overseer reason and human decision are each shown as text: ${JSON.stringify(where).slice(0, 200)}`);
  console.log("[ok] hostile: markup in a headline, a blocking finding and a file path is shown as text; nothing ran, nothing was injected");

  // the approval prompt still works from the tree view
  await emit({ type: "approval-request", phase: "gatekeeper", requestId: "q9", toolUseId: "q9", toolName: "Bash", toolInput: { command: "npm test" } }, 2);
  await page.waitForSelector("#dock .prompt");
  assert.ok(await page.locator("#dock .prompt").isVisible() && await page.locator("#tree").isVisible(), "an approval prompt is pinned at the bottom while the tree is showing");
  bus.resolveApproval("q9", { decision: "allow" });
  await emit({ type: "approval-resolved", phase: "gatekeeper", requestId: "q9", toolUseId: "q9", decision: "allow", auto: false }, 1);

  // live: a new attempt appears without reloading
  await emit({ type: "phase-end", phase: "gatekeeper", attempt: 1, verdict: verdict("pass", "Ship it") }, 30);
  await emit({ type: "overseer-decision", phase: "gatekeeper", decision: { action: "continue", reasoning: "done" } }, 1);
  await emit({ type: "run-end", status: "done" }, 1);
  await page.waitForFunction(() => document.querySelector('#tree .tn[data-id="gatekeeper#1"]')?.dataset.outcome === "pass");
  assert.ok(/done/.test(await page.locator("#tree .summary").innerText()) && /2 repairs?|1 repair/.test(await page.locator("#tree .summary").innerText()), "the summary follows the run to its end");
  console.log("[ok] live: the tree updates as the run goes, and the approval prompt stays pinned while it is showing");

  // switch back
  await page.locator("#view-toggle").click();
  assert.ok(await page.locator("#scroll").isVisible() && !(await page.locator("#tree").isVisible()));

  // screenshots for the docs: a clean run of its own (the one above is full of hostile strings on purpose)
  if (process.env.SAVE_UI_SCREENSHOTS === "1") {
    const out = join(process.cwd(), "docs", "screenshots", "lineage");
    mkdirSync(out, { recursive: true });
    const cbus = new EventBus();
    new LineageTracker(cbus).attach();
    const csrv = await startServer(cbus, 0, { humor: "off" });
    const base = Date.now() - 12 * 60_000;
    let ct = 0, cid = 0;
    const ce = async (e, dt = 20) => { ct += dt; cbus.emitEvent({ runId: "demo", ts: new Date(base + ct * 1000).toISOString(), ...e }); await tick(); };
    const cw = async (phase, path, tool = "Write", ok = true) => { const u = `c${++cid}`; await ce({ type: "tool-call", phase, toolUseId: u, toolName: tool, toolInput: { file_path: path } }, 2); await ce({ type: "tool-result", phase, toolUseId: u, toolName: tool, isError: !ok, summary: "x" }, 1); };
    await ce({ type: "run-start", task: "Add a dark-mode toggle to the settings page", workDir: "/w" }, 1);
    await ce({ type: "phase-start", phase: "planner", attempt: 1 });
    await ce({ type: "usage", phase: "planner", role: "phase", costUsd: 0.24, turns: 3, durationMs: 1 }, 5);
    await ce({ type: "phase-end", phase: "planner", attempt: 1, verdict: verdict("pass", "Plan written: two files and one test", { details: "Toggle in settings.js, persisted in localStorage, one Playwright test.", concerns: ["no design for the icon yet"] }) }, 30);
    await ce({ type: "overseer-decision", phase: "planner", decision: { action: "continue", reasoning: "the plan is specific enough to build" } }, 1);
    await ce({ type: "phase-start", phase: "builder", attempt: 1 });
    await cw("builder", "src/settings.js"); await cw("builder", "src/theme.css"); await cw("builder", "src/settings.js", "Edit"); await cw("builder", "src/.env", "Write", false);
    await ce({ type: "approval-request", phase: "builder", requestId: "c1", toolUseId: "c1", toolName: "Bash", toolInput: { command: "npm test" } }, 3);
    await ce({ type: "approval-resolved", phase: "builder", requestId: "c1", toolUseId: "c1", decision: "allow", auto: false }, 4);
    await ce({ type: "usage", phase: "builder", role: "phase", costUsd: 0.62, turns: 9, durationMs: 1 }, 5);
    await ce({ type: "phase-end", phase: "builder", attempt: 1, verdict: verdict("pass", "Toggle renders and switches the theme") }, 70);
    await ce({ type: "overseer-decision", phase: "builder", decision: { action: "continue", reasoning: "tests pass" } }, 1);
    await ce({ type: "phase-start", phase: "verifier", attempt: 1 });
    await ce({ type: "phase-end", phase: "verifier", attempt: 1, verdict: verdict("fail", "The choice is lost on reload", { blockingFindings: ["Theme isn't persisted across page loads"] }) }, 45);
    await ce({ type: "overseer-decision", phase: "verifier", decision: { action: "repair", repairTarget: "builder", reasoning: "persist it, then verify again", feedbackForRepair: "read and write localStorage" } }, 1);
    await ce({ type: "trusted-decision-recorded", phase: "builder", text: "Use localStorage, not cookies" }, 2);
    await ce({ type: "phase-start", phase: "builder", attempt: 2 });
    await cw("builder", "src/settings.js", "Edit"); await cw("builder", "tests/theme.spec.js");
    await ce({ type: "usage", phase: "builder", role: "phase", costUsd: 0.31, turns: 5, durationMs: 1 }, 5);
    await ce({ type: "phase-end", phase: "builder", attempt: 2, verdict: verdict("pass", "Theme is saved and restored") }, 40);
    await ce({ type: "overseer-decision", phase: "builder", decision: { action: "continue", reasoning: "fixed" } }, 1);
    await ce({ type: "phase-start", phase: "verifier", attempt: 2 });
    await ce({ type: "phase-end", phase: "verifier", attempt: 2, verdict: verdict("pass", "Verified in the browser") }, 35);
    await ce({ type: "overseer-decision", phase: "verifier", decision: { action: "continue", reasoning: "good" } }, 1);
    await ce({ type: "phase-start", phase: "gatekeeper", attempt: 1 });
    await ce({ type: "phase-end", phase: "gatekeeper", attempt: 1, verdict: verdict("pass", "Ready to ship") }, 30);
    await ce({ type: "overseer-decision", phase: "gatekeeper", decision: { action: "continue", reasoning: "done" } }, 1);
    await ce({ type: "run-end", status: "done" }, 1);
    const shot = await open(csrv.url);
    await live(shot.page);
    await shot.page.locator("#view-toggle").click();
    await shot.page.locator('#tree .tn[data-id="builder#1"] summary', { hasText: "written or edited" }).click();
    await shot.page.waitForTimeout(500);
    await shot.page.screenshot({ path: join(out, "01-tree.png") });
    await shot.page.evaluate(() => { document.getElementById("tree").scrollTop = 1e9; });
    await shot.page.waitForTimeout(300);
    await shot.page.screenshot({ path: join(out, "02-made-by-and-files.png") });
    console.log("[saved] docs/screenshots/lineage/01-tree.png, 02-made-by-and-files.png");
    await shot.ctx.close();
    await csrv.close();
  }

  // When the page reconnects it resets and takes the replay from scratch: an old tree must not linger while it does.
  await page.locator("#view-toggle").click();
  await page.evaluate(() => resetForReplay());
  assert.ok(/No phase has started yet/.test(await page.locator("#tree").innerText()), "a reconnect clears the tree before the replay refills it");

  // a tab opened later gets the latest tree (and only that one) from the replay
  const late = await open(srv.url);
  await live(late.page);
  await late.page.locator("#view-toggle").click();
  await late.page.waitForSelector("#tree .tn[data-id]");
  assert.deepStrictEqual(await late.page.locator("#tree .tn[data-id]").evaluateAll((els) => els.map((e) => e.dataset.id)), ["planner#1", "builder#1", "verifier#1", "builder#2", "verifier#2", "gatekeeper#1"], "a tab that connects afterwards sees the whole tree");
  await late.ctx.close();
  console.log("[ok] reload: a tab that connects later gets the whole tree from the replay");

  // a saved report, opened from disk, has the tree too
  const dir = mkdtempSync(join(tmpdir(), "agent-loop-ui-lineage-"));
  const report = writeRunReport(dir, bus.allEvents(), "off");
  const rp = await ctx.newPage();
  rp.on("pageerror", (e) => errors.push(`report: ${e.message}`));
  await rp.goto(`file://${report}`);
  assert.ok(/^\d+m \d+s$/.test(await rp.locator("#elapsed").innerText()), `a finished run's header shows how long it took as soon as the report opens, not "0s" until the first tick: ${await rp.locator("#elapsed").innerText()}`);
  await rp.locator("#view-toggle").click();
  assert.deepStrictEqual(await rp.locator("#tree .tn[data-id]").evaluateAll((els) => els.map((e) => e.dataset.id)), ["planner#1", "builder#1", "verifier#1", "builder#2", "verifier#2", "gatekeeper#1"]);
  assert.strictEqual(await rp.evaluate(() => typeof window.__pwned), "undefined");
  // A report of a run that never ended (the process died) also shows how long it had been going straight away.
  const unfinished = writeRunReport(mkdtempSync(join(tmpdir(), "agent-loop-ui-lineage-")), bus.allEvents().filter((e) => e.type !== "run-end"), "off");
  const up = await ctx.newPage();
  await up.goto(`file://${unfinished}`);
  assert.ok(/^\d+m \d+s$/.test(await up.locator("#elapsed").innerText()), `an unfinished run's header shows its elapsed time at once: ${await up.locator("#elapsed").innerText()}`);
  console.log("[ok] a saved report opened straight from disk has the tree, and the header shows how long the run took (or had been going) at once");

  await ctx.close();
}

await srv.close();
await browser.close();
assert.deepStrictEqual(errors, [], `no console errors, page errors or dialogs:\n${errors.join("\n")}`);
console.log("\nALL UI LINEAGE TESTS PASSED");
process.exit(0);
