// Screenshots of the redesigned UI for docs/screenshots/ui-v3 (the welcome card, the cat on a waiting prompt, a finished
// run, the offline dinosaur mid-game, help, the light look, a phone). Nothing calls a model: events are scripted and go
// through the real server into the real page.
//
//   npm run build && node --experimental-sqlite --no-warnings test/e2e/screenshots-ui-v3.mjs [outDir]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { harness } from "../ui-extras-helpers.mjs";

const out = process.argv[2] ?? join(process.cwd(), "docs", "screenshots", "ui-v3");
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const verdict = (outcome, headline) => ({ completed: true, outcome, headline, details: "", concerns: [], blockingFindings: [] });

const h = await harness();
const { page } = h;
await h.open();
await sleep(900);
await page.screenshot({ path: join(out, "01-welcome.png") });

h.ev({ type: "run-start", task: "Add a /health route that returns uptime", workDir: "/home/dev/todo-app" });
h.ev({ type: "phase-start", phase: "planner", attempt: 1 });
h.ev({ type: "tool-call", phase: "planner", toolUseId: "r1", toolName: "Read", toolInput: { file_path: "/home/dev/todo-app/server.js" } });
h.ev({ type: "tool-result", phase: "planner", toolUseId: "r1", toolName: "", isError: false, summary: "const http = require('http');\nconst PORT = 3000;\n// routes live below" });
h.ev({ type: "assistant-text", phase: "planner", text: "I'll add **/health** next to `/ping`." });
h.ev({ type: "phase-end", phase: "planner", attempt: 1, verdict: verdict("pass", "Wrote PLAN.md") });
h.ev({ type: "phase-start", phase: "builder", attempt: 1 });
h.ev({ type: "tool-call", phase: "builder", toolUseId: "g1", toolName: "Grep", toolInput: { pattern: "ping", path: "/home/dev/todo-app" } });
h.ev({ type: "tool-result", phase: "builder", toolUseId: "g1", toolName: "", isError: false, summary: "server.js:14: app.get('/ping'" });
await sleep(1500);
h.askApproval("q1");
await page.waitForSelector("#prompt");
await page.waitForFunction(() => AL.mascot.state().anchor === "prompt");
await sleep(1500);
await page.screenshot({ path: join(out, "02-needs-you.png") });

await page.keyboard.press("y");
await sleep(900);
h.ev({ type: "phase-end", phase: "builder", attempt: 1, verdict: verdict("pass", "Built it") });
h.ev({ type: "usage", phase: "builder", role: "phase", costUsd: 0.42, turns: 5, durationMs: 90000 });
h.ev({ type: "run-end", status: "done" });
await page.waitForSelector(".blk.run-end");
await page.waitForFunction(() => AL.mascot.state().mood === "win");
await sleep(2200);
await page.screenshot({ path: join(out, "03-done.png") });

await page.keyboard.press("?");
await page.waitForSelector("#help:not([hidden])");
await sleep(500);
await page.screenshot({ path: join(out, "05-help.png") });
await page.keyboard.press("Escape");

await page.locator("#theme-toggle").click();
await sleep(700);
await page.screenshot({ path: join(out, "06-light.png") });
await page.locator("#theme-toggle").click();

await page.setViewportSize({ width: 390, height: 780 });
await sleep(700);
await page.screenshot({ path: join(out, "07-phone.png") });
await page.setViewportSize({ width: 1280, height: 800 });
await h.close();

// the offline dinosaur, mid-game (a run that is still going when its server goes away)
const o = await harness();
await o.open(); o.startRun();
o.ev({ type: "tool-call", phase: "builder", toolUseId: "w1", toolName: "Write", toolInput: { file_path: "/work/app/auth.js", content: "x" } });
o.ev({ type: "tool-result", phase: "builder", toolUseId: "w1", toolName: "", isError: false, summary: "File created" });
await sleep(500);
await o.srv.close();
await o.page.waitForSelector("#offline:not([hidden])", { timeout: 6000 });
await o.page.keyboard.press("Space");
await sleep(700);
await o.page.keyboard.press("Space");
await sleep(260);
await o.page.screenshot({ path: join(out, "04-offline-dino.png") });
await o.close();
// a command that has gone quiet, the Stop button armed (the first of its two clicks), and the run after it ended on that command.
// The page's clock is faked and moved on 75 s, so the "still running" label is the real one, not painted.
const q = await harness({ clock: true, onStop: () => {} });
await q.open();
q.ev({ type: "run-start", task: "Run the database migration and check the data", workDir: "/work/app" });
q.ev({ type: "phase-start", phase: "builder", attempt: 1 });
q.ev({ type: "tool-call", phase: "builder", toolUseId: "r1", toolName: "Read", toolInput: { file_path: "db/migrate.sql" } });
q.ev({ type: "tool-result", phase: "builder", toolUseId: "r1", toolName: "", isError: false, summary: "(64 lines)" });
q.ev({ type: "tool-call", phase: "builder", toolUseId: "m1", toolName: "Bash", toolInput: { command: "npm run migrate -- --all" } });
await q.page.waitForSelector(".blk.tool");
await sleep(400);
await q.page.clock.fastForward(75_000);
await q.page.waitForSelector(".blk.tool .still", { timeout: 5000 });
await q.page.locator("#stop-btn").click();
await q.page.mouse.move(640, 400);
await sleep(500);
await q.page.screenshot({ path: join(out, "08-stop-armed-still-running.png") });
await q.page.locator("#stop-btn").click();
await sleep(300);
const later = () => new Date(Date.now() + 76_000).toISOString();   // the server's clock is not faked, so its stamps are moved on by hand
q.ev({ type: "stop-requested", reason: "you pressed Stop on the page", ts: later() });
q.ev({ type: "run-end", status: "stopped", ts: later() });
await q.page.waitForSelector(".blk.run-end");
await sleep(1200);
await q.page.screenshot({ path: join(out, "09-stopped-no-result.png") });
await q.close();

// a run longer than the page's history: the replay says how many earlier tool events were dropped (the audit database has all of them)
const t = await harness({ historyLimit: 60 });
t.startRun();   // the events exist before the page does, so what it sees is a replay (a goto to the same URL with only a hash would not reload it)
for (let i = 0; i < 90; i++) {
  t.ev({ type: "tool-call", phase: "builder", toolUseId: `t${i}`, toolName: "Read", toolInput: { file_path: `src/file${i}.js` } });
  t.ev({ type: "tool-result", phase: "builder", toolUseId: `t${i}`, toolName: "", isError: false, summary: `(${10 + i} lines)` });
}
await t.open();
await t.page.waitForSelector(".blk.trimmed", { timeout: 5000 });
await sleep(600);
await t.page.evaluate(() => document.querySelector(".blk.trimmed").scrollIntoView({ block: "start" }));   // a replay ends scrolled to the newest line
await sleep(500);
await t.page.screenshot({ path: join(out, "10-history-trimmed.png") });
await t.close();
console.log("[saved]", out);
