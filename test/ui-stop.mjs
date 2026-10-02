// The page's side of ending a run and of watching one: the Stop button (two clicks, then the server is asked), the note when a stop
// is requested, the "still running" label on a tool call that has gone quiet, "no result" when a run ends on one, and the opt-in
// browser notification. Real Chromium, real server, fake page clock where time matters. No API calls:
//   npm run build && npm run test:ui-stop
import assert from "node:assert";
import { harness } from "./ui-extras-helpers.mjs";

const ok = (m) => console.log(`[ok] ${m}`);
const text = (page, sel) => page.locator(sel).innerText();
const shown = (page, sel) => page.evaluate((s) => { const n = document.querySelector(s); return !!n && !n.hidden && getComputedStyle(n).display !== "none"; }, sel);
const still = (page, id) => page.evaluate((i) => { const el = state.tools.get(i); const s = el && el.querySelector(".still"); return s ? s.textContent : null; }, id);
const tool = (h, id, extra = {}) => h.ev({ type: "tool-call", phase: "builder", toolUseId: id, toolName: "Bash", toolInput: { command: "npm test" }, ...extra });
// With the page's clock faked (and moved on), an event has to be stamped by that clock to be "now" for the page.
const pageNow = (page, behindMs = 0) => page.evaluate((b) => new Date(Date.now() - b).toISOString(), behindMs);

// ---------- 1. the Stop button
{
  let stops = 0;
  const h = await harness({ clock: true, onStop: () => stops++ });
  const { page } = h;
  await h.open();
  assert.strictEqual(await shown(page, "#stop-btn"), false, "no stop button before there is a run");
  h.startRun();
  await page.waitForFunction(() => !document.getElementById("stop-btn").hidden);
  assert.strictEqual(await text(page, "#stop-btn"), "stop run");

  await page.click("#stop-btn");
  assert.strictEqual(await text(page, "#stop-btn"), "really stop?", "the first click only arms it");
  assert.ok(await page.evaluate(() => document.getElementById("stop-btn").classList.contains("armed")));
  await page.clock.fastForward(4500);
  await page.waitForFunction(() => document.getElementById("stop-btn").textContent === "stop run");
  assert.strictEqual(stops, 0, "an armed button that was left alone asks the server nothing");

  await page.click("#stop-btn"); await page.click("#stop-btn");
  await page.click("#stop-btn", { force: true, noWaitAfter: true }).catch(() => {});
  await page.waitForFunction(() => document.getElementById("stop-btn").textContent === "stopping…");
  await page.waitForTimeout(300);
  assert.strictEqual(stops, 1, `two clicks ask once, and more clicks while stopping ask nothing (${stops})`);
  assert.ok(await page.evaluate(() => document.getElementById("stop-btn").disabled), "the button is disabled while stopping");

  // the run says it is stopping, then ends
  h.ev({ type: "stop-requested", reason: "you pressed Stop on the page" });
  await page.waitForSelector(".blk.stopnote");
  assert.ok((await text(page, ".blk.stopnote")).includes("Stop requested") && (await text(page, ".blk.stopnote")).includes("you pressed Stop on the page"));
  h.ev({ type: "run-end", status: "stopped" });
  await page.waitForFunction(() => document.getElementById("stop-btn").hidden);
  assert.ok((await text(page, ".blk.run-end")).includes("Run stopped"), "the run's closing card says stopped");
  assert.deepStrictEqual(h.errors, []);
  ok("the Stop button: hidden until a run, the first click arms it for 4 s, the second asks the server once, it shows stopping, the note names the reason, and it goes when the run ends");
  await h.close();
}

// ---------- 2. a stop that comes from elsewhere (Ctrl-C, the cost cap) shows on the page too, and a saved report has no button
{
  const h = await harness();
  const { page } = h;
  await h.open(); h.startRun();
  await page.waitForFunction(() => !document.getElementById("stop-btn").hidden);
  h.ev({ type: "stop-requested", reason: "the cost cap of $5.00 was reached ($5.02 spent)" });
  await page.waitForFunction(() => document.getElementById("stop-btn").textContent === "stopping…");
  assert.ok((await text(page, ".blk.stopnote")).includes("the cost cap of $5.00 was reached"));
  h.ev({ type: "run-end", status: "stopped" });
  await page.waitForFunction(() => document.getElementById("stop-btn").hidden);
  // a tab that opens later gets the whole story, and no live button for a run that is over
  const late = await h.ctx.newPage();
  await late.goto(`http://127.0.0.1:${h.port}/#token=${h.token}`);
  await late.waitForFunction(() => document.getElementById("status")?.textContent === "live");
  assert.ok((await late.locator(".blk.stopnote").innerText()).includes("cost cap"), "a late tab sees why it stopped");
  assert.strictEqual(await shown(late, "#stop-btn"), false);
  ok("a stop that came from Ctrl-C or the cost cap shows the same way, and a tab opened afterwards sees why, with no button");
  await h.close();
}

// ---------- 3. a tool call that goes quiet says so
{
  const h = await harness({ clock: true });
  const { page } = h;
  await h.open(); h.startRun();
  tool(h, "slow", { ts: await pageNow(page) });
  await page.waitForSelector(".blk.tool");
  await page.clock.runFor(29_000);
  assert.strictEqual(await still(page, "slow"), null, "nothing to say before 30 s");
  await page.clock.runFor(2_000);
  assert.strictEqual(await still(page, "slow"), "still running · 31s");
  await page.clock.runFor(34_000);
  assert.strictEqual(await still(page, "slow"), "still running · 1m 5s");
  h.ev({ type: "tool-result", phase: "builder", toolUseId: "slow", toolName: "", isError: false, summary: "ok" });
  await page.waitForFunction(() => state.tools.get("slow").classList.contains("ok"));
  assert.strictEqual(await still(page, "slow"), null, "the label goes when the result arrives");

  // waiting for you is not 'running': no label while a prompt is open; the clock starts when you say yes
  tool(h, "ask", { ts: await pageNow(page) }); h.ev({ type: "approval-request", phase: "builder", requestId: "q1", toolUseId: "ask", toolName: "Bash", toolInput: { command: "npm test" }, ts: await pageNow(page) });
  await page.waitForSelector("#prompt");
  await page.clock.runFor(90_000);
  assert.strictEqual(await still(page, "ask"), null, "a call waiting on you is not 'still running'");
  h.ev({ type: "approval-resolved", phase: "builder", requestId: "q1", toolUseId: "ask", decision: "allow", ts: await pageNow(page) });
  await page.waitForFunction(() => !state.pending.length);
  await page.clock.runFor(10_000);
  assert.strictEqual(await still(page, "ask"), null, "10 s after you said yes is not long");
  await page.clock.runFor(25_000);
  assert.ok(/^still running · 3\ds$/.test(await still(page, "ask")), `the clock started when you approved: ${await still(page, "ask")}`);

  // a refused call never ran, so it is never 'still running'
  tool(h, "no", { ts: await pageNow(page) }); h.ev({ type: "approval-request", phase: "builder", requestId: "q2", toolUseId: "no", toolName: "Bash", toolInput: { command: "rm x" }, ts: await pageNow(page) });
  await page.waitForSelector("#prompt");
  h.ev({ type: "approval-resolved", phase: "builder", requestId: "q2", toolUseId: "no", decision: "deny" });
  await page.waitForFunction(() => !state.pending.length);
  await page.clock.runFor(120_000);
  assert.strictEqual(await still(page, "no"), null);

  // the run ends with calls that never answered: they say so, once
  h.ev({ type: "run-end", status: "stopped" });
  await page.waitForFunction(() => state.status === "stopped");
  assert.strictEqual(await still(page, "ask"), "no result · the run ended");
  assert.strictEqual(await still(page, "no"), null, "a refused call is not 'no result'");
  assert.strictEqual(await still(page, "slow"), null, "a call that answered is not either");
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll(".still").length), 1);
  assert.deepStrictEqual(h.errors, []);
  ok("a quiet tool call is labelled after 30 s with the time, not while it waits on you (the clock starts at your yes), never for a refused call, and a call that never answered is marked when the run ends");
  await h.close();
}

// ---------- 3b. a browser whose clock is minutes off the server's does not see false "still running" labels or wrong elapsed times
for (const behind of [-7 * 60_000, 7 * 60_000]) {   // the page's clock 7 minutes ahead of the server's, and 7 minutes behind
  const h = await harness({ clock: true });
  const { page } = h;
  await h.open();
  const stamp = (ms = 0) => pageNow(page, behind + ms);   // the server's clock: the page's, minus the difference
  h.ev({ type: "run-start", task: "t", workDir: "/w", ts: await stamp() });
  h.ev({ type: "phase-start", phase: "builder", attempt: 1, ts: await stamp() });
  tool(h, "x", { ts: await stamp() });
  await page.waitForSelector(".blk.tool");
  await page.clock.runFor(5_000);
  // a later live event lets the page see the difference
  h.ev({ type: "assistant-text", phase: "builder", text: "working", ts: await stamp() });
  await page.waitForFunction(() => document.querySelectorAll(".blk.text").length >= 2);
  await page.clock.runFor(2_000);
  assert.strictEqual(await still(page, "x"), null, `${behind / 60000} min skew: a call that has been quiet 7 s is not "still running" (${await still(page, "x")})`);
  const elapsed = await text(page, "#elapsed");
  assert.ok(/^\d+s$/.test(elapsed) && parseInt(elapsed) < 30, `${behind / 60000} min skew: elapsed shows ${elapsed}, not minutes`);
  await page.clock.runFor(30_000);
  assert.ok(/^still running · 3\ds$/.test(await still(page, "x")), `${behind / 60000} min skew: after 37 s it says so, correctly (${await still(page, "x")})`);
  await h.close();
}
ok("a page whose clock is 7 minutes ahead of or behind the server's still shows correct elapsed time and a correct, not false, 'still running'");

// ---------- 4. a tab opened mid-run shows how long a call has really been quiet; a saved report marks the dangling call
{
  const h = await harness();
  await h.open(); h.startRun();
  tool(h, "old", { ts: new Date(Date.now() - 45_000).toISOString() });
  const late = await h.ctx.newPage();
  await late.goto(`http://127.0.0.1:${h.port}/#token=${h.token}`);
  await late.waitForFunction(() => document.getElementById("status")?.textContent === "live");
  await late.waitForFunction(() => { const s = state.tools.get("old")?.querySelector(".still"); return !!s; }, undefined, { timeout: 4000 });
  assert.ok(/^still running · 4\ds$/.test(await still(late, "old")), `from the call's own timestamp, not from when the tab opened: ${await still(late, "old")}`);
  await h.close();

  const { writeRunReport } = await import("../dist/report.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = writeRunReport(mkdtempSync(join(tmpdir(), "agent-loop-stuck-")), [
    { type: "run-start", runId: "r", task: "t", ts: "2026-01-01T00:00:00Z" },
    { type: "tool-call", runId: "r", phase: "builder", toolUseId: "d", toolName: "Bash", toolInput: { command: "sleep 999" }, ts: "2026-01-01T00:00:01Z" },
    { type: "run-end", runId: "r", status: "stopped", ts: "2026-01-01T00:00:20Z" },
  ], "dark");
  const r = await harness();
  await r.page.goto("file://" + file);
  await r.page.waitForFunction(() => document.getElementById("status")?.textContent === "saved report");
  assert.strictEqual(await still(r.page, "d"), "no result · the run ended", "a saved report of a stopped run marks the call that never answered");
  assert.strictEqual(await shown(r.page, "#stop-btn"), false, "and has no stop button");
  assert.deepStrictEqual(r.errors, []);
  ok("a tab opened mid-run counts from the call's own timestamp; a saved report of a stopped run marks the dangling call and has no stop button");
  await r.close();
}

// ---------- 5. the opt-in browser notification
{
  const stub = () => {
    window.__notes = [];
    window.__perm = "default";
    window.Notification = class { constructor(title, opts) { window.__notes.push({ title, body: opts && opts.body, tag: opts && opts.tag }); }
      static get permission() { return window.__perm; }
      static requestPermission() { window.__perm = window.__answer || "granted"; return Promise.resolve(window.__perm); } };
  };
  const hide = (page, on) => page.evaluate((v) => { Object.defineProperty(document, "hidden", { configurable: true, get: () => v }); document.dispatchEvent(new Event("visibilitychange")); }, on);
  const notes = (page) => page.evaluate(() => window.__notes);

  const h = await harness({ init: stub });
  const { page } = h;
  await h.open(); h.startRun();
  tool(h, "t1"); h.ev({ type: "approval-request", phase: "builder", requestId: "a1", toolUseId: "t1", toolName: "Bash", toolInput: { command: "npm test" } });
  await page.waitForSelector("#prompt");
  await hide(page, true);
  assert.deepStrictEqual(await notes(page), [], "off by default: no notification, even with the tab in the background");
  // turn it on from the help window
  await hide(page, false);
  await page.keyboard.press("?");
  await page.locator("#opt-notify").check();
  await page.waitForFunction(() => localStorage.getItem("agent-loop-notify") === "on");
  assert.ok(await page.locator("#opt-notify").isChecked());
  await page.keyboard.press("Escape");
  h.ev({ type: "approval-resolved", phase: "builder", requestId: "a1", toolUseId: "t1", decision: "allow" });
  // visible tab: nothing; background tab: one, with only the agent's name
  tool(h, "t2"); h.ev({ type: "approval-request", phase: "builder", requestId: "a2", toolUseId: "t2", toolName: "Bash", toolInput: { command: "cat ~/.ssh/id_rsa" } });
  await page.waitForFunction(() => state.pending.some((p) => p.requestId === "a2"));
  assert.deepStrictEqual(await notes(page), [], "a visible tab is not notified");
  h.ev({ type: "approval-resolved", phase: "builder", requestId: "a2", toolUseId: "t2", decision: "deny" });
  await hide(page, true);
  tool(h, "t3"); h.ev({ type: "approval-request", phase: "verifier", requestId: "a3", toolUseId: "t3", toolName: "Bash", toolInput: { command: "echo SECRET_COMMAND_TEXT" } });
  await page.waitForFunction(() => window.__notes.length === 1);
  const [n] = await notes(page);
  assert.deepStrictEqual(n, { title: "verifier needs you", body: "A permission prompt is waiting in agent-loop.", tag: "agent-loop-approval" });
  assert.ok(!JSON.stringify(n).includes("SECRET_COMMAND_TEXT") && !JSON.stringify(n).includes("npm test"), "the notification never carries the command");
  // turn it off again
  await hide(page, false);
  await page.keyboard.press("?");
  await page.locator("#opt-notify").uncheck();
  await page.keyboard.press("Escape");
  await hide(page, true);
  h.ev({ type: "approval-resolved", phase: "verifier", requestId: "a3", toolUseId: "t3", decision: "allow" });
  tool(h, "t4"); h.ev({ type: "approval-request", phase: "builder", requestId: "a4", toolUseId: "t4", toolName: "Bash", toolInput: { command: "ls" } });
  await page.waitForFunction(() => state.pending.some((p) => p.requestId === "a4"));
  await page.waitForTimeout(200);
  assert.strictEqual((await notes(page)).length, 1, "switched off again: no more");
  assert.deepStrictEqual(h.errors, []);
  await h.close();

  // permission refused: the box un-ticks, says why, and nothing is sent
  // (an init script is serialised into the page, so the stub is inlined as source, not referenced)
  const d = await harness({ init: `(${stub})(); window.__answer = "denied";` });
  await d.open(); d.startRun();
  await d.page.keyboard.press("?");
  await d.page.locator("#opt-notify").click();   // (not check(): the page un-ticks it again, which is what is being tested)
  await d.page.waitForFunction(() => !document.getElementById("opt-notify").checked && document.getElementById("notify-fine").textContent !== "");
  assert.ok((await text(d.page, "#notify-fine")).includes("did not allow"), "it says the browser refused");
  assert.strictEqual(await d.page.evaluate(() => window.__perm), "denied", "(the stub, not the real browser, answered)");
  assert.strictEqual(await d.page.evaluate(() => localStorage.getItem("agent-loop-notify")), "off");
  await d.close();

  // a tab opened while a prompt is already waiting does not announce the old prompt
  const l = await harness({ init: `(${stub})(); window.__perm = "granted"; localStorage.setItem("agent-loop-notify", "on"); Object.defineProperty(document, "hidden", { configurable: true, get: () => true });` });
  l.startRun(); tool(l, "t9");
  l.bus.requestApproval({ runId: "extras-run", phase: "builder", toolUseId: "t9", toolName: "Bash", toolInput: { command: "ls" } });   // really pending, so a late tab is shown it
  await l.page.goto(`http://127.0.0.1:${l.port}/#token=${l.token}`);
  await l.page.waitForFunction(() => document.getElementById("status")?.textContent === "live");
  await l.page.waitForSelector("#prompt");
  await l.page.waitForTimeout(300);
  assert.deepStrictEqual(await notes(l.page), [], "replayed history never notifies");
  await l.close();

  // no Notification support at all: the option is disabled and nothing breaks
  const u = await harness({ init: () => { delete window.Notification; } });
  await u.open(); u.startRun(); tool(u, "t1"); u.ev({ type: "approval-request", phase: "builder", requestId: "a1", toolUseId: "t1", toolName: "Bash", toolInput: { command: "ls" } });
  await u.page.keyboard.press("?");
  assert.ok(await u.page.locator("#opt-notify").isDisabled());
  assert.deepStrictEqual(u.errors, []);
  await u.close();
  ok("notifications: off by default, opt-in from the help window, only for a background tab, only the agent's name (never the command), off again works, a refusal is explained, history never notifies, and no Notification support breaks nothing");
}

// ---------- 5b. the same, with the browser's REAL permission mechanics: only a wrapper counts what the real Notification constructor was asked
// to make; permission state, requestPermission and the constructor are Chromium's own (the stub above proved the page's logic; this proves it
// against the real thing, which is where a stand-in could have been wrong).
{
  const counting = `(() => { const Real = window.Notification; window.__made = []; window.__err = [];
    window.Notification = class extends Real { constructor(t, o) { super(t, o); window.__made.push({ title: t, body: o && o.body, tag: o && o.tag }); this.addEventListener("error", () => window.__err.push("error")); } }; })();`;
  const hideReal = (page, on) => page.evaluate((v) => { Object.defineProperty(document, "hidden", { configurable: true, get: () => v }); document.dispatchEvent(new Event("visibilitychange")); }, on);

  // permission granted by the browser
  const g = await harness({ init: counting });
  await g.ctx.grantPermissions(["notifications"]);
  await g.open(); g.startRun();
  assert.strictEqual(await g.page.evaluate(() => Notification.permission), "granted", "the browser really reports granted");
  await g.page.keyboard.press("?");
  await g.page.locator("#opt-notify").check();
  await g.page.waitForFunction(() => localStorage.getItem("agent-loop-notify") === "on");
  await g.page.keyboard.press("Escape");
  await hideReal(g.page, true);
  tool(g, "r1"); g.ev({ type: "approval-request", phase: "builder", requestId: "r1", toolUseId: "r1", toolName: "Bash", toolInput: { command: "echo SECRET_COMMAND_TEXT" } });
  await g.page.waitForFunction(() => window.__made.length === 1, undefined, { timeout: 4000 });
  const made = await g.page.evaluate(() => window.__made);
  assert.deepStrictEqual(made, [{ title: "builder needs you", body: "A permission prompt is waiting in agent-loop.", tag: "agent-loop-approval" }]);
  await g.page.waitForTimeout(300);
  assert.deepStrictEqual(await g.page.evaluate(() => window.__err), [], "the real constructor raised no error");
  assert.ok(!JSON.stringify(made).includes("SECRET_COMMAND_TEXT"), "and nothing from the command is in it");
  // the same prompt while the tab is visible makes none
  await hideReal(g.page, false);
  g.ev({ type: "approval-resolved", phase: "builder", requestId: "r1", toolUseId: "r1", decision: "allow" });
  tool(g, "r2"); g.ev({ type: "approval-request", phase: "builder", requestId: "r2", toolUseId: "r2", toolName: "Bash", toolInput: { command: "ls" } });
  await g.page.waitForFunction(() => state.pending.some((p) => p.requestId === "r2"));
  await g.page.waitForTimeout(300);
  assert.strictEqual((await g.page.evaluate(() => window.__made)).length, 1, "a visible tab is not notified");
  assert.deepStrictEqual(g.errors, []);
  await g.close();

  // permission not yet answered (headless Chromium never answers, like a person who has not clicked Allow yet): ticked and waiting, nothing saved, nothing sent
  const d = await harness({ init: counting });
  await d.open(); d.startRun();
  await d.page.keyboard.press("?");
  await d.page.locator("#opt-notify").click();
  await d.page.waitForTimeout(500);
  assert.deepStrictEqual(await d.page.evaluate(() => ({ perm: Notification.permission, stored: localStorage.getItem("agent-loop-notify") })), { perm: "default", stored: null }, "while the browser's prompt is unanswered nothing is saved as 'on'");
  await d.page.keyboard.press("Escape");
  await hideReal(d.page, true);
  tool(d, "p1"); d.ev({ type: "approval-request", phase: "builder", requestId: "p1", toolUseId: "p1", toolName: "Bash", toolInput: { command: "ls" } });
  await d.page.waitForFunction(() => state.pending.length === 1);
  await d.page.waitForTimeout(300);
  assert.deepStrictEqual(await d.page.evaluate(() => window.__made), [], "no notification is made before permission is granted");
  assert.deepStrictEqual(d.errors, []);
  await d.close();
  ok("notifications against the browser's real permission mechanics: granted → a real Notification is made for a background tab with only the agent's name and none for a visible tab; unanswered → nothing saved, nothing made");
}

console.log("\nALL STOP UI TESTS PASSED");
