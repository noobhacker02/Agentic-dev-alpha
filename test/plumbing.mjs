// Smoke test for agent-loop's non-LLM plumbing: store, bus, server, WS round-trip.
// Does NOT call the Agent SDK / spend API tokens. Run against the built dist/ output:
//   npm run build && npm run test:plumbing
import { EventBus } from "../dist/bus.js";
import { Store } from "../dist/store.js";
import { startServer } from "../dist/server.js";
import WebSocket from "ws";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agent-loop-smoke-"));
const store = new Store(join(dir, "test.db"));
const bus = new EventBus(store);

const run = store.createRun("smoke test task", dir);
assert.ok(run.id, "run should have an id");

const phase = store.startPhase(run.id, "planner", 1);
store.finishPhase(phase.id, {
  completed: true,
  outcome: "pass",
  headline: "did the thing",
  details: "details here",
  concerns: [],
  blockingFindings: [],
});

const summaries = store.getPhaseSummaries(run.id);
assert.strictEqual(summaries.length, 1);
assert.strictEqual(summaries[0].summary, "did the thing");
console.log("[ok] store: create run, phase, verdict, summaries round-trip");

store.indexLog(run.id, "assistant-text", "the quick brown fox jumps over the lazy dog");
const hits = store.searchLogs("fox");
assert.strictEqual(hits.length, 1, "FTS5 search should find the indexed text");
console.log("[ok] store: FTS5 log_index search finds indexed content");

const PORT = 45231;
const { close, token } = await startServer(bus, PORT);

const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${token}`);
await new Promise((resolve, reject) => {
  ws.on("open", resolve);
  ws.on("error", reject);
});
console.log("[ok] server: WebSocket client connected");

const received = [];
ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));

// A fixed sleep-then-check-once wait is a race: it passed 22 straight local/CI runs, then failed for
// real in CI (a WS round-trip -- send, server, bus, a synchronous SQLite write, broadcast, client
// receive -- taking just over 200ms under a loaded runner). Polling for the real condition is both
// faster on a healthy machine (resolves the moment the event arrives, not after a fixed wait) and
// correct under load (keeps waiting up to a generous ceiling instead of giving up at a fixed point).
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return true;
}

// Simulate a PreToolUse hook requesting approval.
const { requestId, wait } = bus.requestApproval({
  runId: run.id,
  phase: "builder",
  toolUseId: "tool-1",
  toolName: "Bash",
  toolInput: { command: "echo hi" },
});

assert.ok(
  await waitFor(() => received.some((e) => e.type === "approval-request" && e.requestId === requestId)),
  "approval-request event should reach the WS client"
);
console.log("[ok] bus->server->WS: approval-request event broadcast to client");

// A run with nobody watching the live UI must still leave a durable record: emitEvent should
// persist to the store, not only broadcast over the (possibly-unwatched) WebSocket. This regresses
// a real bug found in production use: the bus used to only ever `emit()` in-process, so an
// unattended run had zero SQLite history of its own phase transitions/decisions.
{
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(join(dir, "test.db"), { readOnly: true });
  const rows = raw.prepare("SELECT type FROM events WHERE type = 'approval-request'").all();
  assert.ok(rows.length > 0, "EventBus.emitEvent should persist events to the store, not just broadcast over WS");
  raw.close();
}
console.log("[ok] bus->store: emitEvent persists to SQLite even when no WS client is attached to see it");

// Simulate the human clicking "Approve" in the UI.
ws.send(JSON.stringify({ type: "decision", requestId, decision: "allow" }));
const decision = await wait;
assert.strictEqual(decision.decision, "allow");
console.log("[ok] WS->server->bus: human decision resolves the pending hook promise (full round trip)");

// A human recording a decision through the UI's WS connection is the ONLY way to add a trusted
// decision -- a worker phase writing to DECISIONS.md never reaches this path. See overseer.ts's
// distinction between DECISIONS.md (informal, worker-writable) and trusted decisions (this).
{
  const before = received.length;
  ws.send(JSON.stringify({ type: "record-decision", runId: run.id, phase: "planner", text: "Use SQLite, not Postgres." }));
  assert.ok(
    await waitFor(() => received.slice(before).some((e) => e.type === "trusted-decision-recorded" && e.text === "Use SQLite, not Postgres.")),
    "recording a decision over WS should broadcast a trusted-decision-recorded event"
  );
  const stored = store.getTrustedDecisions(run.id);
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].text, "Use SQLite, not Postgres.");
  console.log("[ok] WS->server->bus->store: recording a decision persists it as a trusted decision");
}

// --- getInsights(): the self-analysis report agent-loop's own CLI (`agent-loop insights`) prints,
// built entirely from data already recorded for other reasons. Uses a second run with distinct
// phase names (builder/verifier) so its assertions aren't coupled to the planner phase set up above.
{
  const run2 = store.createRun("insights test task", dir);
  let p = store.startPhase(run2.id, "builder", 1);
  store.finishPhase(p.id, { completed: true, outcome: "fail", headline: "fail1", details: "", concerns: [], blockingFindings: ["x"] });
  p = store.startPhase(run2.id, "builder", 2);
  store.finishPhase(p.id, { completed: true, outcome: "fail", headline: "fail2", details: "", concerns: [], blockingFindings: ["x"] });
  p = store.startPhase(run2.id, "builder", 3);
  store.finishPhase(p.id, { completed: true, outcome: "pass", headline: "pass", details: "", concerns: [], blockingFindings: [] });
  p = store.startPhase(run2.id, "verifier", 1);
  store.finishPhase(p.id, { completed: true, outcome: "pass", headline: "ok", details: "", concerns: [], blockingFindings: [] });

  store.logEvent(run2.id, "builder", "usage", { costUsd: 0.05 });
  store.logEvent(run2.id, "builder", "usage", { costUsd: 0.07 });
  store.logEvent(run2.id, "verifier", "usage", { costUsd: 0.02 });

  store.logEvent(run2.id, "builder", "approval-auto-allowed", { rule: "Bash(npm test:*)" });
  store.logEvent(run2.id, "builder", "approval-auto-allowed", { rule: "Bash(npm test:*)" });
  store.logEvent(run2.id, "builder", "approval-resolved", { rememberedRule: "Bash(npm test:*)" });
  store.logEvent(run2.id, "builder", "approval-resolved", { rememberedRule: "Bash(npm run lint:*)" }); // never reused

  // Desktop computer use: two sessions' worth of events. Three clicks reach the driver and one is stopped
  // by the tools' own checks, a key press goes through, one type_text is refused; capture/window_info are
  // not input and aren't counted as actions. Of four human answers about desktop tools, one is a denial;
  // a Bash approval in the same run must not be mixed in.
  store.logEvent(run2.id, "builder", "desktop-session-started", { desktopSessionId: "a" });
  store.logEvent(run2.id, "verifier", "desktop-session-started", { desktopSessionId: "b" });
  for (let n = 0; n < 5; n++) store.logEvent(run2.id, "builder", "desktop-snapshot", { snapshotId: `dshot-${n}` });
  for (const [toolName, isError] of [["click", false], ["click", false], ["click", false], ["click", true], ["key", false], ["type_text", true], ["capture", false], ["window_info", false], ["capture", true]]) {
    store.logEvent(run2.id, "builder", "desktop-action-completed", { toolName, isError });
  }
  for (const [requestId, toolName] of [["r1", "mcp__desktop__click"], ["r2", "mcp__desktop__click"], ["r3", "mcp__desktop__type_text"], ["r4", "mcp__desktop__key"], ["r5", "Bash"]]) {
    store.logEvent(run2.id, "builder", "approval-request", { requestId, toolName });
  }
  for (const [requestId, decision] of [["r1", "allow"], ["r2", "allow"], ["r3", "deny"], ["r4", "allow"], ["r5", "deny"]]) {
    store.logEvent(run2.id, "builder", "approval-resolved", { requestId, decision });
  }

  store.finishRun(run2.id, "failed");

  const insights = store.getInsights();
  assert.strictEqual(insights.totalRuns, 2, "counts every run recorded, not just the latest");
  assert.strictEqual(insights.byStatus.failed, 1);
  const builderStats = insights.byPhase.find((x) => x.name === "builder");
  assert.strictEqual(builderStats.runs, 1);
  assert.strictEqual(builderStats.repairedRuns, 1, "3 attempts on one run counts as one repaired run, not three");
  assert.strictEqual(builderStats.avgAttempts, 3);
  const verifierStats = insights.byPhase.find((x) => x.name === "verifier");
  assert.strictEqual(verifierStats.repairedRuns, 0);
  assert.ok(Math.abs(insights.totalCost - 0.14) < 1e-9, `totalCost was ${insights.totalCost}`);
  assert.ok(Math.abs(insights.costByPhase.builder - 0.12) < 1e-9);
  assert.ok(Math.abs(insights.costByPhase.verifier - 0.02) < 1e-9);
  assert.deepStrictEqual(insights.topRules, [{ rule: "Bash(npm test:*)", count: 2 }]);
  assert.deepStrictEqual(insights.neverReusedRules, ["Bash(npm run lint:*)"]);
  assert.deepStrictEqual(insights.desktop, {
    sessions: 2, captures: 5,
    actions: { click: { sent: 3, refused: 1 }, key: { sent: 1, refused: 0 }, type_text: { sent: 0, refused: 1 } },
    humanApproved: 3, humanDenied: 1,
  }, `desktop insights: ${JSON.stringify(insights.desktop)}`);
  console.log("[ok] store.getInsights(): repair frequency, cost, and rule-reuse aggregate correctly across runs");
  console.log("[ok] store.getInsights(): desktop sessions, captures, input actions sent vs stopped, and human approvals vs denials (Bash answers not mixed in)");
}

ws.close();
await close();
store.close();
console.log("\nALL PLUMBING SMOKE TESTS PASSED");
