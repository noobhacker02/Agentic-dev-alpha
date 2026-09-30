// Desktop tools wired into a real runPipeline (dist/pipeline.js + dist/phases.js), with the scripted fake
// SDK standing in for the model (run via `node --import test/stress/fake-sdk/register.mjs`, see the
// npm script). The fake never dispatches tool calls, so this checks the wiring, not the tools: which
// phases are handed the desktop server, that the session starts once and ends once, and that the
// driver is released whether the run succeeds or fails. The tools themselves are test/desktop-tools.mjs.
import assert from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../dist/bus.js";
import { Store } from "../dist/store.js";
import { runPipeline } from "../dist/pipeline.js";
import { resolveDesktopTarget } from "../dist/desktop-tools.js";
import { FakeDesktopDriver } from "./fake-desktop-driver.mjs";

const root = mkdtempSync(join(tmpdir(), "agent-loop-desktop-pipeline-"));

async function run(scenario, { withDesktop = true } = {}) {
  process.env.FAKE_SCENARIO = scenario;
  process.env.FAKE_LOG = join(root, `${scenario}-${withDesktop}.log`);
  const driver = new FakeDesktopDriver();
  const bus = new EventBus();
  const events = [];
  bus.on("event", (e) => events.push(e));
  const store = new Store(join(root, `${scenario}-${withDesktop}.db`));
  const resolved = await resolveDesktopTarget({ target: "AgentLoop Test App", driver, requireApproval: true });
  const result = await runPipeline(
    {
      task: "build a thing", workDir: join(root, "ws"), requireApproval: true, maxRetriesPerPhase: 1, maxTotalRepairs: 2, uiPort: 0,
      browserArtifactDir: join(root, "artifacts"), ...(withDesktop ? { desktop: resolved } : {}),
    },
    bus,
    store
  );
  store.close();
  const calls = readFileSync(process.env.FAKE_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.prompt);
  return { result, events, driver, calls, resolved };
}

// A run that reaches "done".
{
  const { result, events, driver, calls } = await run("trivial-skip");
  assert.strictEqual(result.status, "done");
  const workers = calls.filter((c) => !c.overseer);
  assert.ok(workers.length >= 3, `expected several worker phases, saw ${workers.length}`);
  const withDesktop = calls.filter((c) => c.mcp.includes("desktop"));
  const without = calls.filter((c) => !c.mcp.includes("desktop"));
  assert.ok(withDesktop.length >= 2, "builder and verifier each get the desktop server");
  for (const c of withDesktop) {
    assert.ok(/mcp__desktop__\*/.test(c.prompt) && /exactly one desktop\s+window/.test(c.prompt), "the phase is told what it can and can't do");
    assert.ok(/untrusted data/.test(c.prompt) && /at most\s+\d+ input actions/.test(c.prompt), "...including that screen text is data and that input is capped");
    assert.ok(/python3\.12 \(pid 4242, window 8388611\)/.test(c.prompt), "...and which one window it is");
  }
  assert.ok(without.length >= 3, "planner, gatekeeper and the Overseer never get desktop tools");
  assert.ok(without.every((c) => !/mcp__desktop__/.test(c.prompt)), "and aren't told about them");
  assert.strictEqual(events.filter((e) => e.type === "desktop-session-started").length, 1, "one session per run, not one per phase");
  const ended = events.filter((e) => e.type === "desktop-session-ended");
  assert.strictEqual(ended.length, 1);
  assert.strictEqual(ended[0].status, "completed");
  assert.strictEqual(events.find((e) => e.type === "desktop-session-started").runId, result.id, "the session's events carry the run's id");
  assert.strictEqual(driver.of("close").length, 1, "the driver is released exactly once");
  assert.ok(events.findIndex((e) => e.type === "desktop-session-ended") < events.findIndex((e) => e.type === "run-end"), "the session closes before the run is marked ended");
  console.log(`[ok] pipeline (done): one desktop session for the run; ${withDesktop.length} builder/verifier calls got it (and were briefed), ${without.length} other calls didn't; driver closed once, before run-end`);
}

// A run that fails still releases the driver.
{
  const { result, events, driver } = await run("always-retry");
  assert.strictEqual(result.status, "failed");
  const ended = events.filter((e) => e.type === "desktop-session-ended");
  assert.strictEqual(ended.length, 1);
  assert.strictEqual(ended[0].status, "failed");
  assert.strictEqual(driver.of("close").length, 1);
  console.log("[ok] pipeline (failed): the desktop session still ends once, as failed, and the driver is released");
}

// Without a desktop target, nothing changes.
{
  const { result, events, calls } = await run("trivial-skip", { withDesktop: false });
  assert.strictEqual(result.status, "done");
  assert.ok(calls.every((c) => !c.mcp.includes("desktop")), "no desktop server without --desktop-target");
  assert.ok(events.every((e) => !e.type.startsWith("desktop-")), "no desktop events either");
  console.log("[ok] pipeline (no desktop target): no desktop server, no desktop events");
}

// Screenshots need a home outside --dir.
{
  const driver = new FakeDesktopDriver();
  const resolved = await resolveDesktopTarget({ target: "AgentLoop Test App", driver, requireApproval: true });
  const store = new Store(join(root, "noartifacts.db"));
  await assert.rejects(
    () => runPipeline({ task: "t", workDir: join(root, "ws2"), requireApproval: true, maxRetriesPerPhase: 0, maxTotalRepairs: 0, uiPort: 0, desktop: resolved }, new EventBus(), store),
    /artifact directory/
  );
  assert.strictEqual(driver.of("close").length, 1, "a refused start still releases the driver");
  store.close();
  console.log("[ok] pipeline: desktop tools without an artifact directory are refused, and the driver is released");
}

console.log("\nALL DESKTOP PIPELINE TESTS PASSED");
