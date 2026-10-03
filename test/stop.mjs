// Ending a run early: the cost cap, Ctrl-C / SIGTERM, and the page's Stop message. Found by auditing: there was no way to stop a
// run gracefully; Ctrl-C killed the process, left the run "running" in the audit database forever and wrote no report.
// Runs with the fake SDK (which honours an abort like the real one does), so no API calls:
//   npm run build && npm run test:stop
import assert from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { EventBus } from "../dist/bus.js";
import { startServer } from "../dist/server.js";
import { runPipeline } from "../dist/pipeline.js";
import { RunControl } from "../dist/run-control.js";
import { Store } from "../dist/store.js";
import { freePort } from "./ui-extras-helpers.mjs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ok = (m) => console.log(`[ok] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.prompt !== undefined) : []);

function setup(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-loop-stop-"));
  mkdirSync(join(dir, "w"));
  const log = join(dir, "calls.log");
  process.env.FAKE_SCENARIO = "trivial-skip";
  process.env.FAKE_LOG = log;
  process.env.FAKE_DELAY_MS = env.delay ?? "0";
  const store = new Store(join(dir, "t.db"));
  const bus = new EventBus(store);
  const events = [];
  bus.on("event", (e) => events.push(e));
  const cfg = (control) => ({ task: "do it", workDir: join(dir, "w"), requireApproval: false, maxRetriesPerPhase: 2, maxTotalRepairs: 8, uiPort: 0, control });
  return { dir, log, store, bus, events, cfg };
}
const types = (events, t) => events.filter((e) => e.type === t);

// ---------- 1. stopped in the middle of a phase
{
  const t = setup({ delay: "5000" });
  const control = new RunControl();
  let askId;
  t.bus.on("event", (e) => {
    // an approval is waiting when the stop arrives
    if (e.type === "run-start") askId = t.bus.requestApproval({ runId: e.runId, phase: "planner", toolUseId: "tu1", toolName: "Bash", toolInput: { command: "npm test" } });
  });
  const p = runPipeline(t.cfg(control), t.bus, t.store);
  // The stop has to land while the model call is in flight. A fixed pause was wrong on a loaded machine: the call can start well after 500 ms, and a stop
  // before it starts is a different case (nothing to cut short). Wait for the call itself, then measure from the stop.
  for (let i = 0; i < 800 && calls(t.log).length === 0; i++) await sleep(25);
  assert.ok(calls(t.log).length >= 1, "the model call never started");
  assert.strictEqual(t.bus.pendingRequests().length, 1, "an approval is waiting");
  const stopAt = Date.now();
  assert.ok(control.stop("test stop"), "the first stop is the one that counts");
  const run = await p;
  assert.ok(Date.now() - stopAt < 2500, `the model call was cut short, not waited out (${Date.now() - stopAt} ms after the stop; the call lasts 5000 ms)`);
  assert.strictEqual(run.status, "stopped");
  assert.strictEqual(t.store.listRuns()[0].status, "stopped", "recorded in the audit database");
  const stop = types(t.events, "stop-requested");
  assert.strictEqual(stop.length, 1);
  assert.strictEqual(stop[0].reason, "test stop");
  const pe = types(t.events, "phase-end")[0];
  assert.ok(/was stopped before it finished/.test(pe.verdict.headline) && pe.verdict.outcome === "inconclusive", "the interrupted phase says so, and is not a pass");
  const od = types(t.events, "overseer-decision");
  assert.strictEqual(od.length, 1);
  assert.ok(od[0].decision.action === "stop" && /^Stopped: test stop\.$/.test(od[0].decision.reasoning), od[0].decision.reasoning);
  assert.strictEqual(types(t.events, "run-end")[0].status, "stopped");
  assert.strictEqual(types(t.events, "phase-start").length, 1, "nothing after the stop was started");
  const c = calls(t.log);
  assert.ok(c.length === 1 && c[0].abortable === true && c[0].overseer === false, `the model session was given the abort signal; no Overseer call: ${JSON.stringify(c.map((x) => ({ o: x.overseer, a: x.abortable })))}`);
  // the waiting approval was refused, nothing is left open, and a tab that connects later is not shown a dead prompt
  const answered = await Promise.race([askId.wait, sleep(1000).then(() => "never")]);
  assert.deepStrictEqual(answered, { decision: "deny", reason: "the run was stopped" });
  assert.strictEqual(t.bus.pendingRequests().length, 0);
  assert.ok(!t.bus.replay().some((e) => e.type === "approval-request"), "a late tab is not shown the dead prompt");
  assert.ok(t.events.indexOf(stop[0]) < t.events.indexOf(od[0]) && t.events.indexOf(od[0]) < t.events.indexOf(types(t.events, "run-end")[0]), "events come in the order: stop requested, decision, run end");
  assert.strictEqual(control.stop("second"), false);
  assert.strictEqual(control.reason, "test stop", "the first reason wins");
  ok("stopped mid-phase: the model call is cut short, the run is saved as stopped with the reason, nothing further starts, the waiting approval is refused, and a late tab sees no dead prompt");
}

// ---------- 2. stopped before it began
{
  const t = setup();
  const control = new RunControl();
  control.stop("early");
  const run = await runPipeline(t.cfg(control), t.bus, t.store);
  assert.strictEqual(run.status, "stopped");
  assert.strictEqual(types(t.events, "phase-start").length, 0, "no phase started");
  assert.strictEqual(calls(t.log).length, 0, "no model was called");
  assert.deepStrictEqual(types(t.events, "stop-requested").map((e) => e.reason), ["early"]);
  assert.strictEqual(types(t.events, "run-end")[0].status, "stopped");
  ok("stopped before it began: recorded as stopped, no phase, no model call");
}

// ---------- 3. stopped as a phase finishes: the Overseer is not paid to judge a run that is over
{
  const t = setup();
  const control = new RunControl();
  t.bus.on("event", (e) => { if (e.type === "phase-end") control.stop("at the boundary"); });
  const run = await runPipeline(t.cfg(control), t.bus, t.store);
  assert.strictEqual(run.status, "stopped");
  assert.deepStrictEqual(calls(t.log).map((c) => c.overseer), [false], "the planner ran; the Overseer was never called");
  assert.strictEqual(types(t.events, "phase-end")[0].verdict.outcome, "pass", "the finished phase keeps its real verdict");
  ok("stopped as a phase ends: the finished phase keeps its verdict, and no Overseer call is made for a run that is over");
}

// ---------- 4. a stop that never comes changes nothing
{
  const t = setup();
  const run = await runPipeline(t.cfg(new RunControl()), t.bus, t.store);
  assert.strictEqual(run.status, "done");
  assert.strictEqual(types(t.events, "stop-requested").length, 0);
  assert.ok(calls(t.log).every((c) => c.abortable), "every call carries a signal, and none fired");
  const noControl = setup();
  assert.strictEqual((await runPipeline({ ...noControl.cfg(undefined), control: undefined }, noControl.bus, noControl.store)).status, "done", "a run without a control works as before");
  ok("with no stop requested the run finishes as before, with or without a control");
}

// ---------- 5. the page's Stop message
{
  const dir = mkdtempSync(join(tmpdir(), "agent-loop-stopws-"));
  const bus = new EventBus();
  const port = await freePort();
  let stops = 0;
  const token = "t".repeat(48);
  const srv = await startServer(bus, port, { token, onStop: () => stops++ });
  const open = (headers = {}, q = `?token=${token}`) => new Promise((resolve, reject) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${q}`, { headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, ...headers } }); ws.on("open", () => resolve(ws)); ws.on("error", reject); ws.on("unexpected-response", (_r, res) => reject(new Error("HTTP " + res.statusCode))); });
  const ws = await open();
  ws.send("not json"); ws.send(JSON.stringify({ type: "stop-run", extra: 1 })); ws.send(JSON.stringify({ type: "stop" })); ws.send(JSON.stringify({ type: "stop-run" }));
  await sleep(300);
  assert.strictEqual(stops, 2, `two valid stop-run messages, garbage and a wrong type ignored (got ${stops})`);
  await assert.rejects(open({}, "?token=wrong"), /401/, "no token, no stop");
  await assert.rejects(open({ origin: "http://evil.example" }), /403/, "a page from another origin cannot stop a run");
  await assert.rejects(open({ host: "evil.example" }), /403/, "…nor can a rebinding host");
  assert.strictEqual(stops, 2);
  ws.close();
  const quiet = await startServer(new EventBus(), await freePort(), { token });
  await quiet.close();
  await srv.close();
  void dir;
  ok("the page's stop-run message calls onStop only from a connection with the token, the right host and origin; garbage and other types are ignored");
}

// ---------- 6. the command line: cost cap, Ctrl-C, SIGTERM
const cliArgs = (base, extra, flags = []) => ["--experimental-sqlite", "--no-warnings", "--import", "./test/stress/fake-sdk/register.mjs", "dist/cli.js", "run", ...extra, "do the thing", "--dir", join(base, "w"), "--data-dir", join(base, "d"), "--no-approval", "--humor", "off", ...flags];
async function runCli(extra, { env = {}, flags = [], signal, after = 0, second } = {}) {
  const base = mkdtempSync(join(tmpdir(), "agent-loop-stopcli-"));
  const port = await freePort();
  const log = join(base, "calls.log");
  const child = spawn(process.execPath, cliArgs(base, extra, ["--port", String(port), ...flags]), { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_SCENARIO: "trivial-skip", FAKE_LOG: log, ...env } });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
  let signalledAt = 0;
  if (signal) {
    while (!/Task: do the thing/.test(out)) await sleep(30);
    while (calls(log).length === 0) await sleep(30); // the signal has to land while a model call is in flight, however slowly the process started
    await sleep(after);
    signalledAt = Date.now();
    child.kill(signal);
    if (second) { await sleep(second); child.kill(signal); }
  }
  const code = await new Promise((r) => child.on("close", (c, s) => r(c ?? s)));
  const dbPath = join(base, "d", "agent-loop.db");
  const store = existsSync(dbPath) ? new Store(dbPath) : undefined;
  const runs = store ? store.listRuns() : [];
  const events = runs[0] ? store.getRunEvents(runs[0].id) : [];
  store?.close();
  return { base, code, out, err, runs, events, calls: calls(log), tookAfterSignal: signalledAt ? Date.now() - signalledAt : 0 };
}

{
  // the cap: costs are $0.01 per fake call. After the planner ($0.01) and its Overseer call ($0.02) the cap of $0.02 is reached.
  const r = await runCli(["--max-cost", "0.02"]);
  assert.strictEqual(r.code, 1);
  assert.ok(/Cost cap: \$0\.02/.test(r.out), r.out);
  assert.ok(/finished with status: stopped/.test(r.out) && /Report: file:/.test(r.out), "a stopped run still finishes properly and writes its report");
  assert.strictEqual(r.runs[0].status, "stopped");
  const stop = r.events.find((e) => e.type === "stop-requested");
  assert.strictEqual(stop.reason, "the cost cap of $0.02 was reached ($0.02 spent)");
  assert.deepStrictEqual(r.calls.map((c) => c.overseer), [false, true], "the planner and its Overseer call ran, then nothing more");
  assert.deepStrictEqual(r.events.filter((e) => e.type === "phase-start").map((e) => e.phase), ["planner", "test-designer"], "the planner ran (and its skip of the test-designer was recorded); the builder never started");
  // a cap that is never reached changes nothing
  const big = await runCli(["--max-cost", "100"]);
  assert.strictEqual(big.code, 0);
  assert.strictEqual(big.runs[0].status, "done");
  assert.ok(!big.events.some((e) => e.type === "stop-requested"));
  // between phases: a cap of $0.025 is passed by the builder's own call, and the Overseer is not paid to judge it
  const mid = await runCli(["--max-cost", "0.025"]);
  assert.strictEqual(mid.runs[0].status, "stopped");
  assert.ok(/\$0\.03 spent/.test(mid.events.find((e) => e.type === "stop-requested").reason), mid.events.find((e) => e.type === "stop-requested").reason);
  assert.deepStrictEqual(mid.calls.map((c) => c.overseer), [false, true, false], "planner, its Overseer call, builder; no Overseer call after the cap was passed");
  // bad values
  for (const bad of ["0", "-1", "abc", "NaN", "Infinity"]) {
    const e = await runCli(["--max-cost", bad]);
    assert.strictEqual(e.code, 1, `--max-cost ${bad}`);
    assert.ok(/--max-cost needs a positive amount/.test(e.err), `${bad}: ${e.err}`);
    assert.strictEqual(e.calls.length, 0, "nothing ran");
  }
  ok("--max-cost: stops after the step that passes it (saved as stopped, with the reason and the report), never stops a run under it, and bad values are refused before anything runs");
}

const POSIX = process.platform !== "win32";   // a child cannot be sent SIGINT/SIGTERM on Windows (kill() just ends it): those cases are POSIX-only
for (const [signal, code, word] of POSIX ? [["SIGINT", 130, "Ctrl-C"], ["SIGTERM", 143, "Terminated"]] : []) {
  const r = await runCli([], { env: { FAKE_DELAY_MS: "6000" }, signal, after: 700 });
  assert.strictEqual(r.code, code, `${signal}: exit code ${r.code}\n${r.err}`);
  assert.ok(r.tookAfterSignal < 4000, `${signal}: stopped in ${r.tookAfterSignal} ms, not after the 6 s model call`);
  assert.ok(new RegExp(`${word}: stopping the run`).test(r.err), r.err);
  assert.strictEqual(r.runs[0].status, "stopped", `${signal}: the run is recorded as stopped, not left "running"`);
  assert.ok(/finished with status: stopped/.test(r.out), r.out);
  const report = (r.out.match(/Report: (file:\/\/\S+)/) || []).slice(1).map((u) => fileURLToPath(u))[0];
  assert.ok(report && existsSync(report), `${signal}: the report was written`);
  assert.ok(readFileSync(report, "utf8").includes(signal === "SIGINT" ? "you pressed Ctrl-C" : "the process was terminated"), "…and says why");
  const stop = r.events.find((e) => e.type === "stop-requested");
  assert.ok(stop && stop.reason === (signal === "SIGINT" ? "you pressed Ctrl-C" : "the process was terminated"));
  assert.ok(r.events.some((e) => e.type === "run-end" && e.status === "stopped"));
}
ok("Ctrl-C and SIGTERM: the run stops within moments (not after the long model call), is saved as stopped with the reason, the report is written, and the exit codes are 130 and 143");

if (POSIX) {
  // a model call that ignores the stop (so the first Ctrl-C cannot finish quickly): the second one quits at once
  const r = await runCli([], { env: { FAKE_DELAY_MS: "20000", FAKE_IGNORE_ABORT: "1" }, signal: "SIGINT", after: 700, second: 900 });
  assert.strictEqual(r.code, 130);
  assert.ok(/Ctrl-C: stopping the run/.test(r.err) && /Interrupted again: quitting now\. The run is left unfinished/.test(r.err), r.err);
  assert.ok(r.tookAfterSignal < 5000, `quit in ${r.tookAfterSignal} ms instead of waiting out the 20 s call`);
  assert.strictEqual(r.runs[0].status, "running", "and, as it says, the run is left unfinished");
  ok("a second Ctrl-C quits at once when a model call will not stop, and says the run is left unfinished");
}

console.log("\nALL STOP TESTS PASSED");
