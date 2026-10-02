// Several runs against the same audit database at once (two terminals, a script that starts a few): every one must finish, none may hit
// "database is locked", and each run's events must stay its own. Fake SDK, no API calls.
//   npm run build && npm run test:concurrent
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/store.js";
import { freePort } from "./ui-extras-helpers.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const N = +process.env.CONCURRENT_RUNS || 5;
const base = mkdtempSync(join(tmpdir(), "agent-loop-concurrent-"));
const data = join(base, "shared-data");
const runs = await Promise.all(Array.from({ length: N }, async (_, i) => {
  const port = await freePort();
  const child = spawn(process.execPath, ["--experimental-sqlite", "--no-warnings", "--import", "./test/stress/fake-sdk/register.mjs", "dist/cli.js", "run", `task number ${i}`, "--dir", join(base, "w" + i), "--data-dir", data, "--port", String(port), "--no-approval", "--humor", "off"],
    { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_SCENARIO: "trivial-skip", FAKE_DELAY_MS: "400" } });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("close", (c) => r(c)));
  return { i, code, out };
}));
for (const r of runs) assert.strictEqual(r.code, 0, `run ${r.i} exited ${r.code}:\n${r.out.slice(-500)}`);
for (const r of runs) assert.ok(!/locked|SQLITE_BUSY/i.test(r.out), `run ${r.i} reported a locked database:\n${r.out.slice(-300)}`);
const s = new Store(join(data, "agent-loop.db"));
const stored = s.listRuns(50);
assert.strictEqual(stored.length, N, "every run is in the shared database");
assert.ok(stored.every((r) => r.status === "done"), JSON.stringify(stored.map((r) => r.status)));
for (const r of stored) {
  const ev = s.getRunEvents(r.id);
  assert.ok(ev.length > 5 && ev.every((e) => e.runId === r.id), `run ${r.task}: its events are its own`);
  assert.strictEqual(ev.filter((e) => e.type === "run-end").length, 1);
}
const h = s.getHabits();
assert.strictEqual(h.runs, N);
s.close();
console.log(`[ok] ${N} runs at once against one audit database: all finish done, no locked-database error, each run's events stay its own, insights reads all ${N}`);

// ---------- and when the database really does fail: the run must live, say so, and still finish and report
{
  const { EventBus } = await import("../dist/bus.js");
  const { runPipeline } = await import("../dist/pipeline.js");
  const { existsSync, mkdirSync } = await import("node:fs");
  process.env.FAKE_SCENARIO = "trivial-skip"; process.env.FAKE_DELAY_MS = "0"; delete process.env.FAKE_LOG;
  const dir = mkdtempSync(join(tmpdir(), "agent-loop-dbfail-"));
  mkdirSync(join(dir, "w"));
  const real = new Store(join(dir, "t.db"));
  let fail = false, writes = 0;
  const flaky = new Proxy(real, { get: (t, k) => (k === "logEvent" ? (...a) => { if (fail) { writes++; throw new Error("disk I/O error"); } return t.logEvent(...a); } : k === "finishRun" ? (...a) => { if (fail) throw new Error("database is locked"); return t.finishRun(...a); } : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
  const bus = new EventBus(flaky);
  const events = [];
  bus.on("event", (e) => { events.push(e); if (e.type === "phase-start" && e.phase === "planner") fail = true; });
  const errs = [];
  const orig = console.error; console.error = (...a) => errs.push(a.join(" "));
  let run;
  try { run = await runPipeline({ task: "do it", workDir: join(dir, "w"), requireApproval: false, maxRetriesPerPhase: 2, maxTotalRepairs: 8, uiPort: 0 }, bus, flaky); } finally { console.error = orig; }
  assert.strictEqual(run.status, "done", "the run finished although the audit database failed from the first phase on");
  assert.ok(events.some((e) => e.type === "run-end" && e.status === "done"), "the page still got run-end, so a live tab and the report are complete");
  assert.ok(writes > 5, `the database really was failing the whole time (${writes} failed writes)`);
  assert.strictEqual(errs.filter((l) => /could not write to the audit database/.test(l)).length, 1, `said once, not on every event: ${errs.length} messages`);
  assert.ok(errs.some((l) => /could not record the end of the run/.test(l) && /still say "running"/.test(l)), "and says plainly that the end could not be recorded");
  assert.ok(bus.allEvents().some((e) => e.type === "run-end"), "the in-memory history, which feeds the saved report, is whole");
  real.close();
  console.log("[ok] when the audit database fails mid-run the run still finishes, the page and the report are whole from memory, and it says (once) that events are not being recorded and (at the end) that the run will still read 'running' there");
}

console.log("\nALL CONCURRENT RUN TESTS PASSED");
