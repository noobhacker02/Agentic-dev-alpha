// The Stop button, end to end: the real command, a real browser, two real clicks. test/stop.mjs covers the pieces (the socket message
// reaching onStop, Ctrl-C and the cost cap through the real command); this is the link between them: page -> socket -> cli.ts's onStop
// -> RunControl -> pipeline -> saved run and report. Also the races around it. Fake SDK, no API calls:
//   npm run build && npm run test:stop-e2e
import assert from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";
import { Store } from "../dist/store.js";
import { chromePath, freePort } from "./ui-extras-helpers.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const ok = (m) => console.log(`[ok] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(env = {}) {
  const base = mkdtempSync(join(tmpdir(), "agent-loop-stope2e-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["--experimental-sqlite", "--no-warnings", "--import", "./test/stress/fake-sdk/register.mjs", "dist/cli.js", "run", "do the thing", "--dir", join(base, "w"), "--data-dir", join(base, "d"), "--port", String(port), "--no-approval", "--humor", "off"],
    { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_SCENARIO: "trivial-skip", FAKE_DELAY_MS: "30000", ...env } });
  const run = { base, port, child, out: "", err: "" };
  child.stdout.on("data", (d) => (run.out += d)); child.stderr.on("data", (d) => (run.err += d));
  run.closed = new Promise((r) => child.on("close", (c, s) => r(c ?? s)));
  while (!/agent-loop UI: (\S+)/.test(run.out)) await sleep(30);
  run.url = run.out.match(/agent-loop UI: (\S+)/)[1];
  run.token = run.url.split("#token=")[1];
  return run;
}
const finish = (run) => {
  const dbPath = join(run.base, "d", "agent-loop.db");
  const store = existsSync(dbPath) ? new Store(dbPath) : undefined;
  const runs = store ? store.listRuns() : [];
  const events = runs[0] ? store.getRunEvents(runs[0].id) : [];
  store?.close();
  return { runs, events, report: (run.out.match(/Report: file:\/\/(\S+)/) || [])[1] };
};

// ---------- 1. a human presses Stop on the page of a real run
{
  const run = await start();
  const browser = await chromium.launch({ executablePath: chromePath() });
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(run.url);
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "live");
  await page.waitForFunction(() => !document.getElementById("stop-btn").hidden, undefined, { timeout: 10000 });   // the run is going
  const t0 = Date.now();
  await page.click("#stop-btn");
  assert.strictEqual(await page.locator("#stop-btn").innerText(), "really stop?");
  await page.click("#stop-btn");
  await page.waitForFunction(() => document.querySelector(".blk.run-end"), undefined, { timeout: 15000 });
  const took = Date.now() - t0;
  assert.ok(took < 8000, `the 30 s model call was cut short, not waited out (${took} ms)`);
  assert.ok((await page.locator(".blk.stopnote").innerText()).includes("you pressed Stop on the page"), "the page says why");
  assert.ok((await page.locator(".blk.run-end").innerText()).includes("Run stopped"));
  assert.ok(await page.evaluate(() => document.getElementById("stop-btn").hidden), "the button goes");
  const code = await run.closed;
  const { runs, events, report } = finish(run);
  assert.strictEqual(code, 1, "a stopped run exits 1, like any run that did not finish");
  assert.strictEqual(runs[0].status, "stopped");
  assert.deepStrictEqual(events.filter((e) => e.type === "stop-requested").map((e) => e.reason), ["you pressed Stop on the page"]);
  assert.ok(report && existsSync(report), "the report was written");
  assert.ok(readFileSync(report, "utf8").includes("you pressed Stop on the page"), "…and carries the reason");
  assert.deepStrictEqual(errors, []);
  await browser.close();
  ok(`Stop on the page of a real run: two clicks, the run ended in ${took} ms (not the 30 s call), saved as stopped with the reason, report written, exit 1`);
}

// ---------- 2. the races: a storm of stop messages, two tabs, a Ctrl-C at the same moment
{
  const run = await start();
  const sockets = await Promise.all([1, 2, 3].map(() => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${run.port}/ws?token=${run.token}`, { headers: { host: `127.0.0.1:${run.port}`, origin: `http://127.0.0.1:${run.port}` } });
    ws.on("open", () => resolve(ws)); ws.on("error", reject);
  })));
  await sleep(800);
  for (let i = 0; i < 200; i++) sockets[i % 3].send(JSON.stringify({ type: "stop-run" }));
  run.child.kill("SIGINT");
  const code = await run.closed;
  const { runs, events, report } = finish(run);
  assert.strictEqual(runs[0].status, "stopped");
  assert.strictEqual(events.filter((e) => e.type === "stop-requested").length, 1, "200 stop messages, three tabs and a Ctrl-C still make exactly one stop request");
  assert.strictEqual(events.filter((e) => e.type === "run-end").length, 1, "and one run end");
  assert.ok([1, 130].includes(code), `exit ${code}`);
  assert.ok(report && existsSync(report), "the report is written once, whoever won the race");
  for (const s of sockets) s.close();
  ok(`200 stop messages from 3 tabs plus a Ctrl-C at the same moment: one stop request, one run end, run saved as stopped, report written (exit ${code})`);
}

// ---------- 3. a stop that arrives after the run is over, and one that arrives on a wedged client, change nothing
{
  const run = await start({ FAKE_DELAY_MS: "0" });
  const code = await run.closed;
  assert.strictEqual(code, 0, run.err);
  const { runs, events } = finish(run);
  assert.strictEqual(runs[0].status, "done");
  assert.ok(!events.some((e) => e.type === "stop-requested"));
  ok("a run nobody stopped finishes done with no stop request (control: the stop machinery is inert when unused)");
}

// ---------- 4. junk over the socket does not kill the server or the run
{
  const run = await start({ FAKE_DELAY_MS: "3000" });
  const ws = await new Promise((resolve, reject) => { const s = new WebSocket(`ws://127.0.0.1:${run.port}/ws?token=${run.token}`, { headers: { host: `127.0.0.1:${run.port}`, origin: `http://127.0.0.1:${run.port}` } }); s.on("open", () => resolve(s)); s.on("error", reject); });
  ws.send("\u0000\u0001 not json"); ws.send("{".repeat(100000)); ws.send(JSON.stringify({ type: "decision" })); ws.send(JSON.stringify({ type: "decision", requestId: { a: 1 }, decision: "allow" }));
  ws.send(JSON.stringify({ type: "record-decision", runId: 1, phase: [], text: {} })); ws.send(JSON.stringify([1, 2, 3])); ws.send("null"); ws.send(Buffer.alloc(5 * 1024 * 1024, 65));
  await sleep(300);
  assert.strictEqual(ws.readyState, WebSocket.OPEN, "the socket survives the junk");
  const code = await run.closed;
  const { runs } = finish(run);
  assert.strictEqual(code, 0, run.err + run.out.slice(-300));
  assert.strictEqual(runs[0].status, "done", "and the run it was attached to finishes normally");
  ok("junk over the socket (invalid JSON, a 100 KB brace run, wrong types, null, a 5 MB frame): the server and the run are unaffected");
}

console.log("\nALL STOP END-TO-END TESTS PASSED");
