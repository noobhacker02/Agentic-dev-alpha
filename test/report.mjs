// The saved run report (src/report.ts): the live UI's own page with the run's events embedded,
// opened straight from disk with no server. No API calls:   npm run build && npm run test:report
import assert from "node:assert";
import { chromium } from "playwright-core";
import { mkdtempSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRunReport } from "../dist/report.js";

const chrome = process.env.AGENT_LOOP_CHROME_PATH ||
  (existsSync("/opt/pw-browsers") ? join("/opt/pw-browsers", readdirSync("/opt/pw-browsers").find((d) => d.startsWith("chromium-")), "chrome-linux", "chrome") : undefined);
const dir = mkdtempSync(join(tmpdir(), "agent-loop-report-"));
copyFileSync("docs/screenshots/browser-agent/01-open-fill-click-screenshot.png", join(dir, "shot.png"));
const ts = () => new Date().toISOString();
const r = "run-1";
const nasty = '</script><script>window.__pwned = 1</script><img src=x onerror="window.__pwned=2">';
const events = [
  { type: "run-start", runId: r, task: "Build a todo app " + nasty, workDir: "/w", ts: ts() },
  { type: "phase-start", runId: r, phase: "builder", attempt: 1, ts: ts() },
  { type: "tool-call", runId: r, phase: "builder", toolUseId: "t1", toolName: "Bash", toolInput: { command: "echo " + nasty }, ts: ts() },
  { type: "tool-result", runId: r, phase: "builder", toolUseId: "t1", toolName: "", isError: false, summary: nasty, ts: ts() },
  { type: "browser-snapshot", runId: r, browserSessionId: "b", url: "http://127.0.0.1:8080/", title: "Todo", screenshotPath: "/somewhere/else/shot.png", ts: ts() },
  { type: "usage", runId: r, phase: "builder", role: "phase", costUsd: 0.5, turns: 3, durationMs: 1, ts: ts() },
  { type: "phase-end", runId: r, phase: "builder", attempt: 1, verdict: { completed: true, outcome: "pass", headline: "Built it", details: "", concerns: [], blockingFindings: [] }, ts: ts() },
  { type: "run-end", runId: r, status: "done", ts: ts() },
];
const path = writeRunReport(dir, events);
const browser = await chromium.launch({ executablePath: chrome });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const sockets = [];
page.on("websocket", (w) => sockets.push(w.url()));
await page.goto("file://" + path);
await page.waitForSelector(".blk.run-end");
assert.strictEqual(await page.locator("#status").innerText(), "saved report");
assert.strictEqual(await page.locator("#run-state").innerText(), "done");
assert.strictEqual(await page.locator("#cost").innerText(), "0.50");
assert.deepStrictEqual(sockets, [], "a saved report never opens a WebSocket");
console.log("[ok] report opens from disk, renders the run (status, cost) and opens no socket");
assert.strictEqual(await page.evaluate(() => window.__pwned), undefined, "event text must not be able to run script in the report");
assert.ok((await page.locator("#transcript").innerText()).includes("</script>"), "the text shows up as text");
console.log("[ok] event text containing </script> and onerror= stays inert text");
const img = page.locator("#browser-panel img");
assert.strictEqual(await img.getAttribute("src"), "shot.png", "artifacts are referenced relative to the report");
assert.ok(await img.evaluate((i) => i.complete && i.naturalWidth > 0), "the screenshot next to the report loads");
console.log("[ok] screenshots load by relative path from the report's own folder");
assert.deepStrictEqual(errors, []);
await browser.close();
console.log("\nALL REPORT TESTS PASSED");
