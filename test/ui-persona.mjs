// The voice in the real web UI (ui/index.html, served by src/server.ts) in a real Chromium: the idle line,
// the jokes toggle and its levels, notes in the transcript, the per-agent tooltips -- and the things that
// must NOT happen: a joke inside an approval prompt, a hostile note running script, a page turning the
// run's ceiling up. No API calls; events go straight through bus.emitEvent().
//
//   npm run build && npm run test:ui-persona
import { chromium } from "playwright-core";
import { readdirSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { EventBus } from "../dist/bus.js";
import { startServer } from "../dist/server.js";
import { writeRunReport } from "../dist/report.js";
import { CATALOG } from "../dist/persona.js";

function findPreinstalledChrome() {
  if (process.env.AGENT_LOOP_CHROME_PATH) return process.env.AGENT_LOOP_CHROME_PATH;
  const root = "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => d.startsWith("chromium-"));
  const exe = dir && join(root, dir, "chrome-linux", "chrome");
  return exe && existsSync(exe) ? exe : undefined;
}

const all = Object.values(CATALOG).flat();
const IDLE_ALL = new Set(CATALOG.idle.map((x) => x.text));
const IDLE_DRY = new Set(CATALOG.idle.filter((x) => !x.dark).map((x) => x.text));
const PLAIN = "Waiting for a run to start.";
const ts = () => new Date().toISOString();
const runId = "ui-persona-run";

const browser = await chromium.launch({ executablePath: findPreinstalledChrome() });
const errors = [];
async function open(srvUrl) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => { errors.push(`dialog: ${d.message()}`); d.dismiss(); });
  await page.goto(srvUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "live", undefined, { timeout: 5000 });
  return { page, ctx };
}
const idle = (page) => page.locator("#dock .statusline").innerText();
const toggle = (page) => page.locator("#humor-toggle");

// ---------- a run at the default ceiling (dark)
{
  const bus = new EventBus();
  const srv = await startServer(bus, 0, { humor: "dark" });
  const { page, ctx } = await open(srv.url);

  // idle: a line from the catalog, and the toggle says where it is
  assert.ok(IDLE_ALL.has(await idle(page)), `the idle line is a catalog line: ${await idle(page)}`);
  assert.strictEqual(await toggle(page).innerText(), "jokes: dark");
  assert.ok(await toggle(page).isVisible());
  console.log("[ok] idle: a catalog line, and the header says `jokes: dark`");

  // the toggle cycles within the ceiling, and each level does what it says
  await toggle(page).click();
  assert.strictEqual(await toggle(page).innerText(), "jokes: off");
  assert.strictEqual(await idle(page), PLAIN, "off: the plain sentence, no joke");
  await toggle(page).click();
  assert.strictEqual(await toggle(page).innerText(), "jokes: dry");
  assert.ok(IDLE_DRY.has(await idle(page)), `dry: only dry lines: ${await idle(page)}`);
  await toggle(page).click();
  assert.strictEqual(await toggle(page).innerText(), "jokes: dark");
  console.log("[ok] toggle: dark -> off (plain) -> dry (dry lines only) -> dark, wrapping around");

  // a run, with notes of both kinds
  const dry = CATALOG["phase-start:builder"].find((x) => !x.dark);
  const dark = CATALOG["phase-start:builder"].find((x) => x.dark);
  const emit = (e) => bus.emitEvent({ runId, ts: ts(), ...e });
  emit({ type: "run-start", task: "Build the thing", workDir: "/tmp/x" });
  emit({ type: "phase-start", phase: "builder", attempt: 1 });
  emit({ type: "persona-note", phase: "builder", moment: "phase-start:builder", text: dry.text, dark: false, speaker: "builder" });
  emit({ type: "persona-note", phase: "builder", moment: "phase-start:builder", text: dark.text, dark: true, speaker: "builder" });
  await page.waitForSelector(".blk.persona.dark");
  const note = (t) => page.locator(".blk.persona", { hasText: t });
  assert.ok(await note(dry.text).isVisible() && await note(dark.text).isVisible(), "dark: both kinds show");
  assert.ok((await note(dry.text).innerText()).includes("Builder"), "the note names who is speaking");
  assert.strictEqual(await note(dry.text).locator(".who").getAttribute("title"), "ships first, explains later", "hovering the name shows the persona's tagline");
  await toggle(page).click(); // off
  assert.ok(!(await note(dry.text).isVisible()) && !(await note(dark.text).isVisible()), "off: every note hidden");
  await toggle(page).click(); // dry
  assert.ok(await note(dry.text).isVisible() && !(await note(dark.text).isVisible()), "dry: the dark note is hidden, the dry one stays");
  await toggle(page).click(); // dark
  assert.ok(await note(dark.text).isVisible());
  console.log("[ok] notes: dark shows both, dry hides the dark ones, off hides all; the speaker's tagline is on hover");

  // persisted per page, and a reload replays the run at the chosen level
  await toggle(page).click(); // off
  await toggle(page).click(); // dry
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "live");
  assert.strictEqual(await toggle(page).innerText(), "jokes: dry", "the choice survives a reload");
  await page.waitForSelector(".blk.persona:not(.dark)");
  assert.ok(!(await note(dark.text).isVisible()), "the replayed dark note is still hidden at dry");
  console.log("[ok] the level is remembered per page, and a reload replays the run at that level");
  await toggle(page).click(); // dark again for the rest

  // the stepper names each agent by temperament
  for (const [phase, tag] of [["planner", "optimist with a spreadsheet"], ["test-designer", "pessimist, usually right"], ["verifier", "trust issues, professionally"], ["gatekeeper", "a bouncer with a checklist"]]) {
    assert.ok((await page.locator(`button.step[data-phase="${phase}"]`).getAttribute("title")).includes(tag), `${phase} has its tagline`);
  }
  console.log("[ok] the phase stepper names each agent by temperament");

  // THE RULE: an approval prompt never carries the voice, even with notes on screen and the level at dark
  emit({ type: "approval-request", phase: "builder", requestId: "q1", toolUseId: "t1", toolName: "Bash", toolInput: { command: "rm -rf build && npm test" }, rule: undefined });
  await page.waitForSelector("#dock .prompt");
  const promptText = await page.locator("#dock").innerText();
  assert.strictEqual(await page.locator("#dock .persona").count(), 0, "no persona element inside the dock");
  for (const line of all) {
    const text = line.text.replace(/\{phase\}|\{n\}|\{cost\}/g, "").trim();
    if (text.length >= 12) assert.ok(!promptText.includes(text), `the approval prompt contains a persona line: ${text}`);
  }
  assert.ok(/rm -rf build/.test(promptText), "control: the prompt does show the real command, so the check above reads the real prompt");
  console.log(`[ok] the approval prompt carries none of the ${all.length} lines and no persona element, with the level at dark and notes on screen`);
  bus.resolveApproval("q1", { decision: "deny" });

  // hostile notes (as a tampered store or a bad replay could carry) stay inert text
  emit({ type: "persona-note", phase: "builder", moment: "idle", text: '<img src=x onerror="window.__pwned=1">', dark: false, speaker: "narrator" });
  emit({ type: "persona-note", phase: "builder", moment: "idle", text: "hostile speaker", dark: false, speaker: '<img src=x onerror="window.__pwned2=1">' });
  emit({ type: "persona-note", phase: "builder", moment: "idle", text: "proto speaker", dark: false, speaker: "__proto__" });
  emit({ type: "persona-note", phase: "builder", moment: "idle", text: "constructor speaker", dark: false, speaker: "constructor" });
  await page.waitForSelector(".blk.persona:has-text('constructor speaker')");
  assert.deepStrictEqual(await page.evaluate(() => [typeof window.__pwned, typeof window.__pwned2]), ["undefined", "undefined"], "no script ran");
  assert.strictEqual(await page.locator('#transcript img[src="x"]').count(), 0, "no element was injected");
  assert.ok((await page.locator("#transcript").innerText()).includes('<img src=x onerror="window.__pwned=1">'), "the hostile text is shown as text");
  for (const t of ["hostile speaker", "proto speaker", "constructor speaker"]) {
    const block = page.locator(".blk.persona", { hasText: t });
    assert.strictEqual(await block.locator(".who").count(), 0, `an unknown speaker shows no name at all (${t}): ${await block.innerText()}`);
    assert.ok(!/undefined|\[object|Object/.test(await block.innerText()), `nothing odd in ${t}: ${await block.innerText()}`);
  }
  console.log("[ok] hostile notes (markup in the text, markup/__proto__/constructor as the speaker) render as inert text; nothing ran");

  // the end of a run sits after the verdict, in its own line
  emit({ type: "run-end", status: "done" });
  emit({ type: "persona-note", moment: "run-done-clean", text: CATALOG["run-done-clean"][0].text, dark: false, speaker: "narrator" });
  await page.waitForSelector(".blk.run-end");
  const order = await page.locator("#transcript > .blk").evaluateAll((els) => els.map((e) => e.className.split(" ").slice(0, 2).join(" ")));
  assert.ok(order.lastIndexOf("blk persona") > order.indexOf("blk run-end"), `the ending's line comes after the run-end block: ${order.slice(-3)}`);

  // a saved report, opened from disk, has the voice too
  const dir = mkdtempSync(join(tmpdir(), "agent-loop-ui-persona-"));
  const report = writeRunReport(dir, bus.allEvents(), "dark");
  const rp = await ctx.newPage();
  rp.on("pageerror", (e) => errors.push(`report: ${e.message}`));
  await rp.goto(`file://${report}`);
  await rp.waitForSelector(".blk.persona");
  assert.strictEqual(await toggle(rp).innerText().catch(() => ""), "jokes: dark", "the saved report has the toggle");
  assert.ok(await rp.locator("button.step[data-phase='verifier']").getAttribute("title"), "...and the persona tooltips");
  await toggle(rp).click(); // off
  assert.strictEqual(await rp.locator(".blk.persona:visible").count(), 0, "off hides every note in the saved report too");
  console.log("[ok] a saved report opened straight from disk has the notes, the toggle and the tooltips");

  await ctx.close();
  await srv.close();
}

// ---------- a run whose ceiling is "dry": dark can't be reached from the page
{
  const bus = new EventBus();
  const srv = await startServer(bus, 0, { humor: "dry" });
  const { page, ctx } = await open(srv.url);
  assert.ok(IDLE_DRY.has(await idle(page)), "idle at a dry ceiling is a dry line");
  const seen = new Set([await toggle(page).innerText()]);
  for (let i = 0; i < 5; i++) { await toggle(page).click(); seen.add(await toggle(page).innerText()); }
  assert.deepStrictEqual([...seen].sort(), ["jokes: dry", "jokes: off"], "the page can turn it down, never up to dark");
  // A saved preference for a higher level is ignored.
  await page.evaluate(() => localStorage.setItem("agent-loop-humor", "dark"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "live");
  assert.notStrictEqual(await toggle(page).innerText(), "jokes: dark", "a stored 'dark' can't lift a dry ceiling");
  // A dark note that arrives anyway is hidden at dry.
  bus.emitEvent({ type: "persona-note", runId, moment: "idle", text: "A dark one that should stay hidden.", dark: true, speaker: "narrator", ts: ts() });
  await page.waitForSelector(".blk.persona.dark", { state: "attached" });
  if ((await toggle(page).innerText()) === "jokes: dry") assert.ok(!(await page.locator(".blk.persona.dark").first().isVisible()), "a dark note is hidden under a dry ceiling");
  console.log("[ok] a dry ceiling: the page can only go down to off; a stored 'dark' can't raise it; a dark note that arrives is hidden");
  await ctx.close();
  await srv.close();
}

// ---------- a run started with --humor off: no toggle, no jokes, plain status
{
  const bus = new EventBus();
  const srv = await startServer(bus, 0, { humor: "off" });
  const { page, ctx } = await open(srv.url);
  assert.ok(!(await toggle(page).isVisible()), "no toggle when the run was started with --humor off");
  assert.strictEqual(await idle(page), PLAIN);
  await page.evaluate(() => localStorage.setItem("agent-loop-humor", "dark"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "live");
  assert.strictEqual(await idle(page), PLAIN, "a stored 'dark' can't override --humor off");
  bus.emitEvent({ type: "persona-note", runId, moment: "idle", text: "Should never show when off.", dark: false, speaker: "narrator", ts: ts() });
  await page.waitForSelector(".blk.persona", { state: "attached" });
  assert.ok(!(await page.locator(".blk.persona").first().isVisible()), "a note that arrives anyway is hidden");
  console.log("[ok] --humor off: no toggle, the plain status line, nothing shown even if a note arrives or a preference says otherwise");
  await ctx.close();
  await srv.close();
}

// ---------- docs screenshots (only when asked: SAVE_UI_SCREENSHOTS=1), from a realistic simulated run
if (process.env.SAVE_UI_SCREENSHOTS === "1") {
  const { mkdirSync } = await import("node:fs");
  const { simulateRun } = await import("./persona-sim.mjs");
  const { PersonaDirector } = await import("../dist/persona.js");
  const out = join(process.cwd(), "docs", "screenshots", "persona");
  mkdirSync(out, { recursive: true });
  const bus = new EventBus();
  new PersonaDirector(bus, { level: "dark", clock: { hourOf: () => 15, dayOf: () => 2 } }).attach();
  const srv = await startServer(bus, 0, { humor: "dark" });
  const { page, ctx } = await open(srv.url);
  // Start it "20 minutes ago", so the header's clock reads like a real run; leave out the tool-call filler the
  // simulator adds only so the director can count them -- the screenshots are about the voice, not about Read(a).
  const { events: all } = simulateRun("rough", { runId: "demo-run", startMs: Date.now() - 20 * 60_000 });
  const events = all.filter((e) => e.type !== "tool-call");
  const tick = () => new Promise((r) => setImmediate(r));
  const play = async (list) => { for (const e of list) { bus.emitEvent(e); await tick(); } };
  // Stop just after the second veto and its reply, and leave a real approval prompt open.
  let vetoes = 0, cut = events.findIndex((e) => e.type === "overseer-decision" && e.decision.action === "repair" && ++vetoes === 2);
  cut = events.findIndex((e, i) => i > cut && e.type === "phase-start") + 12;
  // Drop approvals that are still open at the cut so the demo prompt is the only one pending.
  const head = events.slice(0, cut);
  const open_ = new Set(head.filter((e) => e.type === "approval-request").map((e) => e.requestId));
  for (const e of head) if (e.type === "approval-resolved") open_.delete(e.requestId);
  await play(head.filter((e) => !(e.type === "approval-request" && open_.has(e.requestId))));
  await play([{ type: "approval-request", runId: "demo-run", phase: "builder", requestId: "demo-q", toolUseId: "demo-t", toolName: "Bash", toolInput: { command: "npm test -- settings" }, ts: head.at(-1).ts }]);
  await page.waitForSelector("#dock .prompt");
  await page.evaluate(() => { document.getElementById("scroll").scrollTop = 1e9; });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(out, "01-voice-in-the-transcript.png") });
  console.log("[saved] docs/screenshots/persona/01-voice-in-the-transcript.png");
  bus.resolveApproval("demo-q", { decision: "allow" });
  bus.emitEvent({ type: "approval-resolved", runId: "demo-run", phase: "builder", requestId: "demo-q", toolUseId: "demo-t", decision: "allow", auto: false, ts: head.at(-1).ts });
  await play(events.slice(cut));
  await page.waitForSelector(".blk.run-end");
  await page.evaluate(() => { document.getElementById("scroll").scrollTop = 1e9; });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(out, "02-end-of-run-and-awards.png") });
  console.log("[saved] docs/screenshots/persona/02-end-of-run-and-awards.png");
  await page.locator("#humor-toggle").click(); await page.locator("#humor-toggle").click(); // dark -> off -> dry
  await page.evaluate(() => { document.getElementById("scroll").scrollTop = 1e9; });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(out, "03-dry-level.png") });
  console.log("[saved] docs/screenshots/persona/03-dry-level.png");
  await ctx.close();
  await srv.close();
}

await browser.close();
assert.deepStrictEqual(errors, [], `no console errors, page errors or dialogs:\n${errors.join("\n")}`);
console.log("\nALL UI PERSONA TESTS PASSED");
process.exit(0);
