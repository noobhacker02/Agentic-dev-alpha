// A unit of work is (item, stepId, attempt) (adversary A3; docs/TEAM-COMPOSITION.md, "Identity of a unit of work"). Before, the lineage keyed a node by `phase#attempt` and dropped any phase that was not one of the five
// built-in names, so two builders collapsed into one node and an integrator or a security reviewer vanished (reproduced: a failing mandatory review did not appear in the tree). This test runs the shapes that broke through
// the real builder and the real store: two steps of one role, a role that is not built in with a failing verdict, an item flow, hostile ids, and a database made before the team was composed.
//   npm run build && npm run test:team-identity
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLineage } from "../dist/lineage.js";
import { Store } from "../dist/store.js";
import { boundRepairTarget } from "../dist/overseer.js";
import { PHASES } from "../dist/types.js";

const R = "run-1";
let t = 0;
const ts = () => new Date(Date.UTC(2026, 9, 7, 6, 0, t++)).toISOString();
const start = (phase, attempt, step = {}) => ({ type: "phase-start", runId: R, phase, attempt, ts: ts(), ...step });
const end = (phase, attempt, outcome, headline, step = {}, extra = {}) => ({ type: "phase-end", runId: R, phase, attempt, verdict: { completed: true, outcome, headline, details: "", concerns: [], blockingFindings: [], ...extra }, ts: ts(), ...step });
const decide = (phase, action, step = {}, extra = {}) => ({ type: "overseer-decision", runId: R, phase, decision: { action, reasoning: "because", ...extra }, ts: ts(), ...step });
const tool = (phase, name, input, id) => ({ type: "tool-call", runId: R, phase, toolUseId: id, toolName: name, toolInput: input, ts: ts() });
const result = (phase, id) => ({ type: "tool-result", runId: R, phase, toolUseId: id, toolName: "Write", isError: false, summary: "ok", ts: ts() });

// 1. Two builders (one role, two slices), an integrator and a failing security reviewer that is not a built-in role: five distinct nodes, the failure visible.
{
  const s = (stepId, role, item) => ({ stepId, role, ...(item ? { item } : {}) });
  const events = [
    { type: "run-start", runId: R, task: "two slices", ts: ts() },
    start("planner", 1, s("s1", "planner")), end("planner", 1, "pass", "planned", s("s1", "planner")), decide("planner", "continue", s("s1", "planner")),
    start("builder", 1, s("s3", "builder")), tool("builder", "Write", { file_path: "/w/src/a/x.ts" }, "u1"), result("builder", "u1"), end("builder", 1, "pass", "slice a done", s("s3", "builder")), decide("builder", "continue", s("s3", "builder")),
    start("builder", 1, s("s4", "builder")), tool("builder", "Write", { file_path: "/w/src/b/y.ts" }, "u2"), result("builder", "u2"), end("builder", 1, "pass", "slice b done", s("s4", "builder")), decide("builder", "continue", s("s4", "builder")),
    start("integrator", 1, s("s5", "integrator")), end("integrator", 1, "pass", "joined", s("s5", "integrator")), decide("integrator", "continue", s("s5", "integrator")),
    start("security-reviewer", 1, s("s6", "security-reviewer")), end("security-reviewer", 1, "fail", "token logged in plain text", s("s6", "security-reviewer"), { blockingFindings: ["src/b/y.ts logs the session token"] }),
    decide("security-reviewer", "repair", s("s6", "security-reviewer"), { repairTarget: "s4" }),
    start("builder", 2, s("s4", "builder")), tool("builder", "Write", { file_path: "/w/src/b/y.ts" }, "u3"), result("builder", "u3"), end("builder", 2, "pass", "removed the log line", s("s4", "builder")),
    { type: "run-end", runId: R, status: "done", ts: ts() },
  ];
  const l = buildLineage(events);
  assert.deepStrictEqual(l.nodes.map((n) => n.id), ["s1#1", "s3#1", "s4#1", "s5#1", "s6#1", "s4#2"], `the nodes of a team plan: ${JSON.stringify(l.nodes.map((n) => n.id))}`);
  const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
  assert.strictEqual(byId["s3#1"].phase, "builder");
  assert.strictEqual(byId["s4#1"].phase, "builder");
  assert.deepStrictEqual(byId["s3#1"].files.map((f) => f.path), ["/w/src/a/x.ts"], "the first builder's file went to the second builder's node");
  assert.deepStrictEqual(byId["s4#1"].files.map((f) => f.path), ["/w/src/b/y.ts"], "the second builder's file is missing from its node");
  assert.strictEqual(byId["s4#1"].kind, "handoff", "the second builder step is a hand-off from the first, not a retry of it (same role, different step)");
  assert.strictEqual(byId["s4#1"].parent, "s3#1");
  assert.strictEqual(byId["s6#1"].phase, "security-reviewer", "a role that is not built in is a step of the run");
  assert.strictEqual(byId["s6#1"].outcome, "fail", "the failing reviewer is not visible");
  assert.deepStrictEqual(byId["s6#1"].blocking, ["src/b/y.ts logs the session token"]);
  assert.strictEqual(byId["s6#1"].decision.action, "repair");
  assert.strictEqual(byId["s6#1"].decision.repairTarget, "s4", "the repair names the step, not the role");
  assert.strictEqual(byId["s4#2"].kind, "repair", "the repaired builder is a repair of the step the reviewer named");
  assert.strictEqual(byId["s4#2"].parent, "s6#1");
  assert.ok(byId["s4#2"].lane === 1 && byId["s5#1"].lane === 0, "the repair sits in the repair lane and the forward steps do not");
  assert.strictEqual(l.totals.repairs, 1);
  // "made by": one row per step, in plan order, two builder rows
  assert.deepStrictEqual(l.agents.map((a) => `${a.stepId}:${a.phase}:${a.attempts}`), ["s1:planner:1", "s3:builder:1", "s4:builder:2", "s5:integrator:1", "s6:security-reviewer:1"]);
  assert.deepStrictEqual(l.files.map((f) => [f.path, f.touches.map((x) => x.node)]), [["/w/src/a/x.ts", ["s3#1"]], ["/w/src/b/y.ts", ["s4#1", "s4#2"]]]);
  console.log("[ok] two builders on two slices, an integrator and a failing security reviewer are five distinct nodes (plus the repair), the failure is visible, a repair names a step, and the files and the rows of \"made by\" follow the steps");
}

// 2. Events from before the team was composed (no stepId): the same tree as ever, the role is the step.
{
  const events = [
    { type: "run-start", runId: R, task: "old", ts: ts() },
    start("planner", 1), end("planner", 1, "pass", "planned"), decide("planner", "continue"),
    start("builder", 1), end("builder", 1, "fail", "broke"), decide("builder", "repair", {}, { repairTarget: "builder" }),
    start("builder", 2), end("builder", 2, "pass", "fixed"),
    { type: "run-end", runId: R, status: "done", ts: ts() },
  ];
  const l = buildLineage(events);
  assert.deepStrictEqual(l.nodes.map((n) => n.id), ["planner#1", "builder#1", "builder#2"], "an old run's node ids changed");
  assert.ok(l.nodes.every((n) => n.stepId === undefined && n.item === undefined), "an old run grew a step id");
  assert.deepStrictEqual(l.agents.map((a) => `${a.phase}:${a.attempts}`), ["planner:1", "builder:2"]);
  assert.strictEqual(l.nodes[2].kind, "repair");
  // an event of an earlier role that arrives while a later role is running (a tool result, an approval) belongs to the earlier role's node, not to the one in progress
  const late = buildLineage([
    start("planner", 1), end("planner", 1, "pass", "planned"), decide("planner", "continue"),
    start("builder", 1), tool("planner", "Read", { file_path: "/w/PLAN.md" }, "late1"), tool("builder", "Write", { file_path: "/w/a.ts" }, "b1"),
  ], R);
  assert.deepStrictEqual(late.nodes.map((n) => [n.id, n.toolCalls]), [["planner#1", 1], ["builder#1", 1]], "a late event of an earlier role went to the step in progress");
  console.log("[ok] events with no step id build the same tree as before: the role is the step, and a late event of an earlier role stays with it");
}

// 2b. Events that name no step (a tool call, an approval) and events that name one, in a team run: an event that names a step goes to that step, not to the one in progress; one that names none goes to
// the step in progress when it is of that role, else to the latest step of that role.
{
  const s = (stepId, role) => ({ stepId, role });
  const late = buildLineage([
    start("builder", 1, s("s3", "builder")), end("builder", 1, "pass", "a", s("s3", "builder")),
    start("integrator", 1, s("s5", "integrator")),
    tool("builder", "Read", { file_path: "/w/x" }, "l1"),
  ], R);
  assert.deepStrictEqual(late.nodes.map((n) => [n.id, n.toolCalls]), [["s3#1", 1], ["s5#1", 0]], "a builder's tool call that arrived while the integrator ran went to the integrator");
  const named = buildLineage([
    start("builder", 1, s("s3", "builder")), end("builder", 1, "pass", "a", s("s3", "builder")),
    start("builder", 1, s("s4", "builder")),
    decide("builder", "continue", s("s3", "builder")),
  ], R);
  const by = Object.fromEntries(named.nodes.map((n) => [n.id, n]));
  assert.strictEqual(by["s3#1"].decision?.action, "continue", "a decision that names step s3 did not reach s3");
  assert.strictEqual(by["s4#1"].decision, undefined, "a decision that names step s3 went to the builder step in progress (s4)");
  // a repair that names no target repairs the failing step itself: another step of the same role that starts next is a hand-off, not that repair
  const own = buildLineage([
    start("builder", 1, s("s4", "builder")), end("builder", 1, "fail", "broke", s("s4", "builder")), decide("builder", "repair", s("s4", "builder")),
    start("builder", 1, s("s7", "builder")),
  ], R);
  assert.deepStrictEqual(own.nodes.map((n) => [n.id, n.kind]), [["s4#1", "root"], ["s7#1", "handoff"]], "a repair with no target was taken for a repair of whichever step of that role came next");
  console.log("[ok] in a team run an event that names a step goes to that step, and one that names none goes to the step in progress or the latest step of its role");
}

// 3. An item flow: the same step of two items are two nodes.
{
  const ev = (item) => ({ stepId: "s2", role: "builder", item });
  const events = [
    start("builder", 1, ev("job-17")), end("builder", 1, "pass", "applied", ev("job-17")),
    start("builder", 1, ev("job-18")), end("builder", 1, "fail", "form changed", ev("job-18")),
  ];
  const l = buildLineage(events, R);
  assert.deepStrictEqual(l.nodes.map((n) => n.id), ["job-17:s2#1", "job-18:s2#1"]);
  assert.deepStrictEqual(l.nodes.map((n) => [n.item, n.outcome]), [["job-17", "pass"], ["job-18", "fail"]]);
  assert.strictEqual(l.agents.length, 2, "two items of one step are two rows");
  assert.deepStrictEqual(l.agents.map((x) => [x.item, x.stepId]), [["job-17", "s2"], ["job-18", "s2"]], "the rows do not say which item and step they are");
  console.log("[ok] the same step for two items is two nodes, with the item in the id and in the row");
}

// 4. Hostile identity: a step id or item that is not an id is not trusted; it never reaches the tree as text that could mislead.
{
  const hostile = { stepId: "s1\u001b]0;pwned\u0007", role: "builder", item: "job‮-17 <script>" + "x".repeat(300) };
  const l = buildLineage([start("builder", 1, hostile), end("builder", 1, "pass", "ok", hostile)], R);
  assert.strictEqual(l.nodes.length, 1);
  const n = l.nodes[0];
  assert.strictEqual(n.stepId, undefined, "a step id with control bytes was accepted");
  assert.ok(!/[\u0000-\u001f\u007f-\u009f‪-‮]/.test(JSON.stringify(l)), "a control or bidi byte from the identity reached the tree");
  assert.ok(n.item === undefined || n.item.length <= 80, `an item of ${n.item?.length} characters`);
  // a role that is not a role id is not a step at all
  const bad = buildLineage([start("Builder; DROP", 1), start("x".repeat(80), 1)], R);
  assert.strictEqual(bad.nodes.length, 0, "a phase that is not a role id became a node");
  // a hostile role is not trusted just because the event also names a step
  const withStep = buildLineage([start("Builder; DROP", 1, { stepId: "s9", role: "builder" }), start("x".repeat(80), 1, { stepId: "s9", role: "builder" })], R);
  assert.strictEqual(withStep.nodes.length, 0, "a role that is not a role id became a step because the event named a step");
  // a step id that is not an id is dropped, and the event is read as the role alone
  const longId = buildLineage([start("builder", 1, { stepId: "s".repeat(300), role: "builder" })], R);
  assert.deepStrictEqual(longId.nodes.map((n) => [n.id, n.stepId]), [["builder#1", undefined]], "a 300-character step id was accepted");
  // a role that is not built in can only be a step when the event names its step: a bare "security-reviewer" start (a hand-made or old event) is not one
  const bare = buildLineage([start("security-reviewer", 1), end("security-reviewer", 1, "fail", "x")], R);
  assert.strictEqual(bare.nodes.length, 0, "a role that is not built in became a step without naming its step");
  console.log("[ok] a step id with control bytes is ignored, an item is cleaned and capped, and a phase that is not a role id is not a step");
}

// 5. The store: identity is kept, an old database opens unchanged, and the insights count steps, not roles.
{
  const dir = mkdtempSync(join(tmpdir(), "team-identity-"));
  // a database exactly as the previous version created it: no identity columns
  const oldPath = join(dir, "old.db");
  const old = new DatabaseSync(oldPath);
  old.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, task TEXT NOT NULL, work_dir TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE phases (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, name TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, summary TEXT, verdict_json TEXT);`);
  old.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?)").run("r-old", "old task", "/w", "2026-10-01T00:00:00Z", "done");
  old.prepare("INSERT INTO phases (id, run_id, name, attempt, status, started_at, summary) VALUES (?, ?, ?, ?, ?, ?, ?)").run("p-old", "r-old", "builder", 2, "ok", "2026-10-01T00:00:01Z", "fixed it");
  old.close();
  const store = new Store(oldPath);
  assert.deepStrictEqual(store.getPhaseSummaries("r-old"), [{ name: "builder", attempt: 2, status: "ok", summary: "fixed it" }], "an old row changed when the database was opened");
  const run = store.createRun("two slices", "/w");
  const a = store.startPhase(run.id, "builder", 1, { stepId: "s3", role: "builder" });
  const b = store.startPhase(run.id, "builder", 1, { stepId: "s4", role: "builder" });
  const c = store.startPhase(run.id, "builder", 2, { stepId: "s4", role: "builder" });
  const plain = store.startPhase(run.id, "planner", 1);
  assert.deepStrictEqual([a.stepId, b.stepId, plain.stepId, plain.role], ["s3", "s4", undefined, "planner"]);
  const sums = store.getPhaseSummaries(run.id);
  assert.deepStrictEqual(sums.map((x) => `${x.name}:${x.stepId ?? "-"}:${x.attempt}`), ["builder:s3:1", "builder:s4:1", "builder:s4:2", "planner:-:1"], "the summaries lost the step");
  // insights over the whole database: the old run's builder (repaired once) counts once, and the two builder steps of the new run count once each (s4 was repaired, s3 was not), not as one builder with its attempts merged
  const ins = store.getInsights();
  const builder = ins.byPhase.filter((p) => p.name === "builder");
  assert.strictEqual(builder.length, 1);
  assert.strictEqual(builder[0].runs, 3, `the old builder and two new builder steps counted as ${builder[0].runs}`);
  assert.strictEqual(builder[0].repairedRuns, 2, "the old repaired builder and the repaired step were not counted once each");
  // the same step of two items is two units of work in the rows and in the counts (an item flow: job-17 and job-18 both run step s2, and job-18's was repaired)
  const run2 = store.createRun("two jobs", "/w");
  store.startPhase(run2.id, "builder", 1, { stepId: "s2", role: "builder", item: "job-17" });
  store.startPhase(run2.id, "builder", 1, { stepId: "s2", role: "builder", item: "job-18" });
  store.startPhase(run2.id, "builder", 2, { stepId: "s2", role: "builder", item: "job-18" });
  assert.deepStrictEqual(store.getPhaseSummaries(run2.id).map((x) => `${x.item}:${x.stepId}:${x.attempt}`), ["job-17:s2:1", "job-18:s2:1", "job-18:s2:2"], "the item was not stored or not read back");
  store.startPhase(run2.id, "builder", 2, { stepId: "s2", role: "builder", item: "job-17" }); // both items were repaired once
  const builder2 = store.getInsights().byPhase.filter((p) => p.name === "builder")[0];
  assert.strictEqual(builder2.runs, 5, `two items of one step counted as ${builder2.runs - 3} unit(s) of work`);
  assert.strictEqual(builder2.repairedRuns, 4, "the repaired items were not counted on their own");
  // the habits (what the roast reads) count the same units: four builder units were repaired (the old builder, s4, job-17's s2, job-18's s2), not one per run
  assert.strictEqual(store.getHabits().repairedRunsByPhase.builder, 4, "the habits counted the builder steps of a run as one");
  store.close();
  // a second open of the migrated database is quiet (the columns exist)
  const again = new Store(oldPath);
  assert.strictEqual(again.getPhaseSummaries("r-old").length, 1);
  again.close();
  console.log("[ok] a database from before the team opens unchanged (old rows read as role = name), a step is stored and read back, the insights count steps and a second open is quiet");
}
// 6. The Overseer may send a repair back only to a step at or before the one that just ran, in the plan's own order (a team's step ids, or the five built-in names), and never to something it made up.
{
  const team = ["s1", "s2", "s3", "s4"];
  assert.strictEqual(boundRepairTarget("s2", "s4", team), "s2", "a repair to an earlier step was refused");
  assert.strictEqual(boundRepairTarget("s4", "s4", team), "s4", "a repair to the same step was refused");
  assert.strictEqual(boundRepairTarget("s4", "s2", team), "s2", "a repair forward was allowed");
  assert.strictEqual(boundRepairTarget("s9", "s3", team), "s3", "a repair to a step that is not in the plan was allowed");
  assert.strictEqual(boundRepairTarget("builder", "s3", team), "s3", "a built-in name was accepted in a team that does not have it");
  assert.strictEqual(boundRepairTarget(undefined, "s3", team), "s3", "a missing target was not the same step");
  assert.strictEqual(boundRepairTarget(7, "s3", team), "s3", "a number was taken as a target");
  assert.strictEqual(boundRepairTarget("planner", "gatekeeper", PHASES), "planner", "the five built-in phases are the order when the run has no team");
  assert.strictEqual(boundRepairTarget("gatekeeper", "builder", PHASES), "builder", "a forward repair in the built-in order was allowed");
  console.log("[ok] a repair goes back to an earlier or the same step of the plan (or of the built-in five), never forward and never to a step that is not there");
}
console.log("\nALL TEAM IDENTITY TESTS PASSED");
