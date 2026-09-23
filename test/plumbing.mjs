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
const bus = new EventBus();

const run = store.createRun("smoke test task", dir);
assert.ok(run.id, "run should have an id");

const phase = store.startPhase(run.id, "planner", 1);
store.finishPhase(phase.id, { success: true, headline: "did the thing", details: "details here", concerns: [] });

const summaries = store.getPhaseSummaries(run.id);
assert.strictEqual(summaries.length, 1);
assert.strictEqual(summaries[0].summary, "did the thing");
console.log("[ok] store: create run, phase, verdict, summaries round-trip");

store.indexLog(run.id, "assistant-text", "the quick brown fox jumps over the lazy dog");
const hits = store.searchLogs("fox");
assert.strictEqual(hits.length, 1, "FTS5 search should find the indexed text");
console.log("[ok] store: FTS5 log_index search finds indexed content");

const PORT = 45231;
const { close } = await startServer(bus, PORT);

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
await new Promise((resolve, reject) => {
  ws.on("open", resolve);
  ws.on("error", reject);
});
console.log("[ok] server: WebSocket client connected");

const received = [];
ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));

// Simulate a PreToolUse hook requesting approval.
const { requestId, wait } = bus.requestApproval({
  runId: run.id,
  phase: "builder",
  toolUseId: "tool-1",
  toolName: "Bash",
  toolInput: { command: "echo hi" },
});

await new Promise((r) => setTimeout(r, 200));
assert.ok(
  received.some((e) => e.type === "approval-request" && e.requestId === requestId),
  "approval-request event should reach the WS client"
);
console.log("[ok] bus->server->WS: approval-request event broadcast to client");

// Simulate the human clicking "Approve" in the UI.
ws.send(JSON.stringify({ type: "decision", requestId, decision: "allow" }));
const decision = await wait;
assert.strictEqual(decision.decision, "allow");
console.log("[ok] WS->server->bus: human decision resolves the pending hook promise (full round trip)");

ws.close();
await close();
store.close();
console.log("\nALL PLUMBING SMOKE TESTS PASSED");
