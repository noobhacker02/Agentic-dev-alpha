// Opt-in, a few cents: does stopping work with the REAL Claude SDK, not the stand-in test/stop.mjs uses?
//   part A  a bare query aborted while it is writing: does the stream end quickly, and is no child process left behind?
//   part B  the real pipeline's Planner aborted through RunControl: stopped run, event order, no leftover process
// Never run by `npm test`.   AGENT_LOOP_REAL_MODEL_TESTS=1 npm run test:real-model-stop
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { EventBus } from "../dist/bus.js";
import { minimalEnv } from "../dist/env.js";
import { runPipeline } from "../dist/pipeline.js";
import { RunControl } from "../dist/run-control.js";
import { Store } from "../dist/store.js";

if (process.env.AGENT_LOOP_REAL_MODEL_TESTS !== "1") { console.log("skipped: set AGENT_LOOP_REAL_MODEL_TESTS=1 to spend a few cents on real model calls"); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = () => { try { return execFileSync("ps", ["-o", "pid=,args=", "--ppid", String(process.pid)], { encoding: "utf8" }).trim().split("\n").filter((l) => l && !/\bps -o pid=,args= --ppid\b/.test(l)); } catch { return []; } };   // (not the ps we just ran)
const before = children();

// ---------- A
{
  const ac = new AbortController();
  const t0 = Date.now();
  let first = 0, ended = "normally", cost = 0, text = "";
  const stream = query({ prompt: "Count from 1 to 400, one number per line, and nothing else.", options: { tools: [], model: "claude-haiku-4-5-20251001", env: minimalEnv(), abortController: ac, maxTurns: 1 } });
  const timer = setTimeout(() => ac.abort(), 2500);
  try {
    for await (const m of stream) {
      if (m.type === "assistant") { first ||= Date.now() - t0; for (const b of m.message?.content ?? []) if (b.type === "text") text = b.text; }
      if (m.type === "result") cost = Number(m.total_cost_usd ?? 0);
    }
  } catch (err) { ended = `threw ${err && err.name}: ${String(err && err.message).slice(0, 80)}`; }
  clearTimeout(timer);
  const took = Date.now() - t0;
  console.log(`A: aborted at 2.5 s; the stream ended ${ended} after ${took} ms (${first ? `first text at ${first} ms, ${text.length} chars` : "no text had arrived yet"}, cost reported $${cost})`);
  assert.ok(/abort/i.test(ended), `an abort should end the stream with an abort error, got: ${ended}`);
  assert.ok(took < 8000, `the stream must end soon after the abort, took ${took} ms`);
  await sleep(1500);
  const left = children().filter((l) => !before.includes(l));
  assert.deepStrictEqual(left, [], `no child process may be left behind: ${left.join(" | ")}`);
  console.log("[ok] A: a real query aborted in flight ends promptly with an abort error and leaves no child process");
}

// ---------- B
{
  const dir = mkdtempSync(join(tmpdir(), "agent-loop-stopreal-"));
  mkdirSync(join(dir, "w"));
  const store = new Store(join(dir, "t.db"));
  const bus = new EventBus(store);
  const events = [];
  bus.on("event", (e) => events.push(e));
  const control = new RunControl();
  const t0 = Date.now();
  setTimeout(() => control.stop("test: stopped after 6 s"), 6000);
  const run = await runPipeline({ task: "Create hello.txt containing the word hi, and a README.md describing it.", workDir: join(dir, "w"), requireApproval: false, maxRetriesPerPhase: 1, maxTotalRepairs: 2, uiPort: 0, control }, bus, store);
  const took = Date.now() - t0;
  const t = (x) => events.filter((e) => e.type === x);
  console.log(`B: stopped at 6 s; the run ended ${took} ms in as "${run.status}"; phases started: ${t("phase-start").map((e) => e.phase).join(",")}; overseer decisions: ${t("overseer-decision").map((e) => e.decision.action).join(",")}`);
  assert.strictEqual(run.status, "stopped", `status ${run.status}`);
  assert.ok(took < 20000, `took ${took} ms`);
  assert.strictEqual(t("stop-requested").length, 1);
  assert.strictEqual(t("run-end")[0].status, "stopped");
  assert.strictEqual(store.listRuns()[0].status, "stopped");
  assert.ok(t("overseer-decision").every((e) => e.decision.action === "stop"), "the Overseer was not asked to judge an interrupted phase");
  await sleep(1500);
  const left = children().filter((l) => !before.includes(l));
  assert.deepStrictEqual(left, [], `no child process may be left behind: ${left.join(" | ")}`);
  console.log("[ok] B: the real pipeline stopped mid-Planner is saved as stopped, in order, with no Overseer call and no child process left");
}

console.log("\nALL REAL-MODEL STOP TESTS PASSED");
