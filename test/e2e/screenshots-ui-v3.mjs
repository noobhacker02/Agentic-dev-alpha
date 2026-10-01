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
console.log("[saved]", out);
