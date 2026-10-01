// The bus's replay history (src/bus.ts) never forgets the shape of a run, however long it gets. Trimming used to cut from the
// front and, after ~2,500 tool calls, lost run-start and phase-start: a reloaded page (and a saved report) then showed no task
// and the wrong stepper. No API calls:   npm run build && node test/bus-history.mjs
import assert from "node:assert";
import { EventBus, STRUCTURAL_EVENTS } from "../dist/bus.js";

const ts = () => new Date().toISOString();
const bus = new EventBus(undefined, { historyLimit: 100 });
const ev = (o) => bus.emitEvent({ runId: "r", ts: ts(), ...o });
ev({ type: "run-start", task: "t", workDir: "/w" });
ev({ type: "phase-start", phase: "planner", attempt: 1 });
ev({ type: "usage", phase: "planner", role: "phase", costUsd: 0.5, turns: 1, durationMs: 1 });
ev({ type: "phase-end", phase: "planner", attempt: 1, verdict: { completed: true, outcome: "pass", headline: "ok", details: "", concerns: [], blockingFindings: [] } });
ev({ type: "overseer-decision", phase: "planner", decision: { action: "continue", reasoning: "ok" } });
ev({ type: "phase-start", phase: "builder", attempt: 1 });
for (let i = 0; i < 1000; i++) {
  ev({ type: "tool-call", phase: "builder", toolUseId: "t" + i, toolName: "Read", toolInput: { file_path: "/w/" + i } });
  ev({ type: "tool-result", phase: "builder", toolUseId: "t" + i, toolName: "", isError: false, summary: "x" });
}
ev({ type: "usage", phase: "builder", role: "phase", costUsd: 1.5, turns: 9, durationMs: 1 });
ev({ type: "run-end", status: "done" });

const all = bus.allEvents();
const types = (t) => all.filter((e) => e.type === t).length;
assert.ok(all.length <= 100 + 25 + 1, `history stays near its limit (${all.length})`);
assert.strictEqual(types("run-start"), 1, "run-start survives 2,000 tool events");
assert.strictEqual(types("phase-start"), 2, "both phase-starts survive");
assert.strictEqual(types("phase-end"), 1);
assert.strictEqual(types("overseer-decision"), 1);
assert.strictEqual(types("usage"), 2, "every cost record survives, so the replayed total is right");
assert.strictEqual(types("run-end"), 1);
assert.strictEqual(all[0].type, "run-start", "and order is kept");
const calls = all.filter((e) => e.type === "tool-call");
assert.ok(calls.length > 0 && calls.at(-1).toolUseId === "t999", "the newest bulk events are the ones kept");
assert.ok(!all.some((e) => e.toolUseId === "t0"), "the oldest bulk events are the ones dropped");
assert.deepStrictEqual(bus.replay().map((e) => e.type), all.map((e) => e.type), "a connecting page is sent the same trimmed history");
for (const t of ["run-start", "phase-start", "usage", "overseer-decision", "approval-resolved"]) assert.ok(STRUCTURAL_EVENTS.has(t), t + " is structural");
assert.ok(!STRUCTURAL_EVENTS.has("tool-call") && !STRUCTURAL_EVENTS.has("tool-result"), "bulk is not");
console.log(`[ok] after 2,000 tool events the replay history is ${all.length} events and still holds run-start, both phase-starts, every usage record, the decision and run-end; the oldest tool calls were the ones dropped`);

// the default limit is unchanged for ordinary use, and an unbounded structural flood still cannot grow forever
const flood = new EventBus(undefined, { historyLimit: 40 });
for (let i = 0; i < 500; i++) flood.emitEvent({ type: "usage", runId: "r", phase: "builder", role: "phase", costUsd: 0.01, turns: 1, durationMs: 1, ts: ts() });
assert.ok(flood.allEvents().length <= 40 + 10, `even only structural events stay bounded (${flood.allEvents().length})`);
console.log("[ok] a run that is nothing but structural events is still bounded");
console.log("\nALL BUS HISTORY TESTS PASSED");
