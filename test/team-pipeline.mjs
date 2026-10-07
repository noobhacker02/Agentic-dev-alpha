// A composed team through the real pipeline, the real hook chain, the real store and the real Overseer code, with only the model replaced by the fake SDK (scripted outcomes, repair targets and file writes).
// What is checked: the steps run in the plan's order with their ids and roles in the events and the store; a report goes to the steps after it; a repair goes to the step the Overseer names (a step id); a step that
// changed files outside what its role may change fails even though the file tools were never used (Bash is outside the hooks, the diff audit is not); budgets and stop behave as in the five-phase loop; a plan that
// does not validate runs nothing; and the five-phase path is unchanged. Real disk, no API.
//   npm run build && npm run test:team-pipeline
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipeline } from "../dist/pipeline.js";
import { Store } from "../dist/store.js";
import { EventBus } from "../dist/bus.js";
import { RunControl } from "../dist/run-control.js";
import { buildLineage } from "../dist/lineage.js";
import { BUILTIN_ROSTER } from "../dist/team/roster.js";
import { judgeSkips } from "../dist/team/run-plan.js";

const PLAN = { class: "multi-module", size: "medium", reason: "two slices", steps: [
  { id: "s1", role: "planner", why: "plan it" },
  { id: "s2", role: "builder", slice: { name: "api", paths: ["src/api"] }, after: ["s1"], why: "slice 1" },
  { id: "s3", role: "verifier", checks: "s2", why: "check slice 1" },
  { id: "s4", role: "builder", slice: { name: "ui", paths: ["src/ui"] }, after: ["s1"], why: "slice 2" },
  { id: "s5", role: "verifier", checks: "s4", why: "check slice 2" },
  { id: "s6", role: "integrator", after: ["s3", "s5"], why: "join" },
  { id: "s7", role: "gatekeeper", after: ["s6"], why: "last gate" },
] };

const ENV = ["FAKE_SUGGESTED_SKIP", "FAKE_THROW", "FAKE_MAX_CALLS", "FAKE_STEP_OUTCOMES", "FAKE_OVERSEER_REPAIR", "FAKE_WRITES", "FAKE_REPORT", "FAKE_LOG", "FAKE_SCENARIO"];
let n = 0;
async function go({ plan = PLAN, env = {}, cfg = {}, control, after, teamExtra = {} } = {}) {
  for (const k of ENV) delete process.env[k];
  globalThis.__fakeRoleCalls = {};
  const dir = mkdtempSync(join(tmpdir(), `team-pipeline-${++n}-`));
  const work = join(dir, "work");
  for (const d of ["src/api", "src/ui"]) mkdirSync(join(work, d), { recursive: true });
  writeFileSync(join(work, "package.json"), "{}");
  writeFileSync(join(work, "src/api/a.ts"), "export const a = 1;\n");
  writeFileSync(join(work, "src/ui/b.ts"), "export const b = 1;\n");
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  process.env.FAKE_LOG = log;
  process.env.FAKE_MAX_CALLS = "100000"; // many pipelines run in this one process; each scenario is bounded by its own budgets
  for (const [k, v] of Object.entries(env)) process.env[k] = typeof v === "string" ? v : JSON.stringify(v);
  const store = new Store(join(dir, "t.db"));
  const bus = new EventBus(store);
  const events = [];
  bus.on("event", (e) => { events.push(e); after?.(e); });
  const config = { task: "build two slices", workDir: work, requireApproval: false, maxRetriesPerPhase: 2, maxTotalRepairs: 8, uiPort: 0, control, team: plan ? { plan, roster: BUILTIN_ROSTER, source: "file", ...teamExtra } : undefined, ...cfg };
  const run = await runPipeline(config, bus, store);
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { run, events, store, work, calls, workerCalls: calls.filter((c) => c.prompt && !c.overseer) };
}
const starts = (events) => events.filter((e) => e.type === "phase-start").map((e) => `${e.stepId}#${e.attempt}`);
const types = (events, t) => events.filter((e) => e.type === t);
const clearEnv = () => { for (const k of ENV) delete process.env[k]; };

try {
  // 1. A clean run: every step in order with its id and role, the team plan first, the store holds the identity, reports reach the next steps
  {
    const r = await go({ env: { FAKE_STEP_OUTCOMES: {}, FAKE_REPORT: "# Report\n\nthe plan: do a then b" } });
    assert.strictEqual(r.run.status, "done", `the run ended ${r.run.status}`);
    assert.deepStrictEqual(starts(r.events), ["s1#1", "s2#1", "s3#1", "s4#1", "s5#1", "s6#1", "s7#1"]);
    const teamPlan = types(r.events, "team-plan");
    assert.strictEqual(teamPlan.length, 1, "the team plan is emitted once");
    assert.ok(r.events.indexOf(teamPlan[0]) < r.events.findIndex((e) => e.type === "phase-start"), "the team plan comes before the first step");
    assert.deepStrictEqual(teamPlan[0].steps.map((s) => [s.stepId, s.role, s.kind]), [["s1", "planner", "plan"], ["s2", "builder", "build"], ["s3", "verifier", "check"], ["s4", "builder", "build"], ["s5", "verifier", "check"], ["s6", "integrator", "build"], ["s7", "gatekeeper", "gate"]]);
    assert.strictEqual(teamPlan[0].steps[2].verifies, "s2");
    assert.strictEqual(teamPlan[0].source, "file");
    assert.deepStrictEqual(types(r.events, "phase-start").map((e) => [e.stepId, e.role, e.phase]), ["planner", "builder", "verifier", "builder", "verifier", "integrator", "gatekeeper"].map((role, i) => [`s${i + 1}`, role, role]));
    const rows = r.store.getPhaseSummaries(r.run.id);
    assert.deepStrictEqual(rows.map((x) => `${x.stepId}:${x.name}`), ["s1:planner", "s2:builder", "s3:verifier", "s4:builder", "s5:verifier", "s6:integrator", "s7:gatekeeper"]);
    assert.strictEqual(types(r.events, "overseer-decision").filter((e) => e.decision.action === "continue").length, 7);
    // reports: saved as files and named to the next steps
    assert.ok(existsSync(join(r.work, "team-reports/s1.md")) && /the plan: do a then b/.test(readFileSync(join(r.work, "team-reports/s1.md"), "utf8")), "the planner's report was not saved");
    const builderPrompt = r.workerCalls.find((c) => /You are the Builder step/.test(c.system ?? "") || /s1 planner/.test(c.prompt));
    assert.ok(r.workerCalls.some((c) => /\[report: team-reports\/s1\.md\]/.test(c.prompt)), "the steps after the planner are not told where its report is");
    assert.ok(r.workerCalls.length === 7 && r.workerCalls.every((c) => c.teamStep), "every step of a team runs with its role's own spec (a step of a team), not a built-in phase's");
    assert.ok(r.workerCalls.some((c) => /- s1 planner \(attempt 1, ok\)/.test(c.prompt)), "the history the next steps see does not name the step ids");
    assert.strictEqual(types(r.events, "usage").filter((e) => e.role === "overseer").length, 7, "the Overseer's cost was not reported for every step");
    // the lineage of the run is the plan: seven distinct nodes
    assert.deepStrictEqual(buildLineage(r.events).nodes.map((x) => x.id), ["s1#1", "s2#1", "s3#1", "s4#1", "s5#1", "s6#1", "s7#1"]);
    console.log("[ok] a clean team run: seven steps in plan order with ids and roles in the events and the store, the team plan first, reports saved and named to the next steps, seven distinct lineage nodes");
  }

  // 2. A repair goes to the step the Overseer names, by id; the steps after it run again
  {
    const r = await go({ env: { FAKE_STEP_OUTCOMES: { verifier: ["fail", "pass", "pass"] }, FAKE_OVERSEER_REPAIR: { s3: "s2" } } });
    assert.strictEqual(r.run.status, "done");
    assert.deepStrictEqual(starts(r.events), ["s1#1", "s2#1", "s3#1", "s2#2", "s3#2", "s4#1", "s5#1", "s6#1", "s7#1"], `the order of a repair: ${starts(r.events)}`);
    const l = buildLineage(r.events);
    const s2b = l.nodes.find((x) => x.id === "s2#2");
    assert.strictEqual(s2b.kind, "repair", "the repaired builder is not a repair node");
    assert.strictEqual(s2b.parent, "s3#1");
    const decision = types(r.events, "overseer-decision").find((e) => e.decision.action === "repair");
    assert.deepStrictEqual([decision.stepId, decision.decision.repairTarget], ["s3", "s2"]);
    const byStart = r.workerCalls.map((c) => c.prompt);
    const s2second = byStart[3]; // calls: s1, s2, s3, s2 again, s3 again, ...
    assert.ok(/This is a retry\. Feedback from the Overseer on the previous attempt:\s*fix it/.test(s2second), "the repaired step was not given the Overseer's feedback");
    assert.ok(!/This is a retry/.test(byStart[4]) && !/This is a retry/.test(byStart[1]), "the feedback outlived the repair it was for");
    console.log("[ok] a failing checker sends the work back to the step the Overseer names by id, and the steps after it run again");
  }

  // 3. A repair target that is not in the plan, or is later, falls back to the step itself
  {
    for (const bad of ["s9", "s5", "builder"]) {
      const r = await go({ env: { FAKE_STEP_OUTCOMES: { verifier: ["fail", "pass", "pass"] }, FAKE_OVERSEER_REPAIR: { s3: bad } } });
      assert.deepStrictEqual(starts(r.events).slice(0, 5), ["s1#1", "s2#1", "s3#1", "s3#2", "s4#1"], `a repair to ${bad} went somewhere else: ${starts(r.events)}`);
    }
    console.log("[ok] a repair target that is not a step of the plan, or is a later one, or is a role name, falls back to the step that just ran");
  }

  // 4. A builder that writes outside its slice with a shell: the file tools never saw it, the diff audit does
  {
    const r = await go({ env: { FAKE_STEP_OUTCOMES: {}, FAKE_WRITES: [{ role: "builder", call: 1, path: "src/ui/leak.ts", content: "x" }] } });
    const s2 = types(r.events, "phase-end").find((e) => e.stepId === "s2" && e.attempt === 1);
    assert.strictEqual(s2.verdict.outcome, "fail", "a builder that wrote in another slice passed");
    assert.ok(s2.verdict.blockingFindings.some((f) => /src\/ui\/leak\.ts/.test(f) && /outside its scope/.test(f)), `the finding: ${s2.verdict.blockingFindings}`);
    assert.ok(starts(r.events).includes("s2#2"), "the step was not sent back");
    // a write inside its own slice is fine, and so is one in a derived directory
    const ok = await go({ env: { FAKE_STEP_OUTCOMES: {}, FAKE_WRITES: [{ role: "builder", call: 1, path: "src/api/new.ts", content: "x" }, { role: "builder", call: 1, path: "dist/out.js", content: "built" }] } });
    assert.strictEqual(types(ok.events, "phase-end").find((e) => e.stepId === "s2").verdict.outcome, "pass", "a write inside the slice (and a build output) failed the step");
    // the integrator may change the shared files and any slice
    const integ = await go({ env: { FAKE_STEP_OUTCOMES: {}, FAKE_WRITES: [{ role: "integrator", call: 1, path: "package.json", content: '{"name":"x"}' }, { role: "integrator", call: 1, path: "src/ui/b.ts", content: "joined" }] } });
    assert.strictEqual(types(integ.events, "phase-end").find((e) => e.stepId === "s6").verdict.outcome, "pass");
    // but not a path outside every slice
    const bad = await go({ env: { FAKE_STEP_OUTCOMES: {}, FAKE_WRITES: [{ role: "integrator", call: 1, path: "src/other/x.ts", content: "x" }] } });
    assert.strictEqual(types(bad.events, "phase-end").find((e) => e.stepId === "s6" && e.attempt === 1).verdict.outcome, "fail");
    console.log("[ok] a shell write outside a step's slice fails the step (the file tools never saw it); its own slice and build output pass; the integrator owns the shared files and the slices");
  }

  // 5. A read-only step that changes what exists fails; one that only leaves a new file passes with a concern
  {
    const tamper = await go({ env: { FAKE_STEP_OUTCOMES: {}, FAKE_WRITES: [{ role: "verifier", call: 1, path: "src/api/a.ts", content: "tampered" }] } });
    const v = types(tamper.events, "phase-end").find((e) => e.stepId === "s3" && e.attempt === 1);
    assert.strictEqual(v.verdict.outcome, "fail");
    assert.ok(v.verdict.blockingFindings.some((f) => /read-only but changed src\/api\/a\.ts/.test(f)), `the finding: ${v.verdict.blockingFindings}`);
    const del = await go({ env: { FAKE_STEP_OUTCOMES: {}, FAKE_WRITES: [{ role: "verifier", call: 1, path: "src/api/a.ts", content: null }] } });
    assert.ok(types(del.events, "phase-end").find((e) => e.stepId === "s3" && e.attempt === 1).verdict.blockingFindings.some((f) => /deleted it/.test(f)), "a deleted file was not reported as deleted");
    const note = await go({ env: { FAKE_STEP_OUTCOMES: {}, FAKE_WRITES: [{ role: "verifier", call: 1, path: "test-results.json", content: "{}" }] } });
    const nv = types(note.events, "phase-end").find((e) => e.stepId === "s3" && e.attempt === 1);
    assert.strictEqual(nv.verdict.outcome, "pass", "a checker that left a results file failed");
    assert.ok(nv.verdict.concerns.some((c) => /created test-results\.json/.test(c)), "the new file is not mentioned");
    console.log("[ok] a checker that changes or deletes an existing file fails; one that only leaves a new file passes with a concern");
  }

  // 6. Budgets and stop, as in the five-phase loop
  {
    const r = await go({ env: { FAKE_STEP_OUTCOMES: { verifier: ["fail", "fail", "fail", "fail", "fail", "fail"] } }, cfg: { maxRetriesPerPhase: 2 } });
    assert.strictEqual(r.run.status, "failed");
    const last = types(r.events, "overseer-decision").at(-1);
    assert.ok(last.decision.action === "stop" && /[Rr]etry budget \(2\) exhausted for s3/.test(last.decision.reasoning), `the end: ${JSON.stringify(last.decision)}`);
    assert.deepStrictEqual(starts(r.events).filter((x) => x.startsWith("s3")), ["s3#1", "s3#2", "s3#3"]);
    const budget = await go({ env: { FAKE_STEP_OUTCOMES: { verifier: ["fail", "fail", "fail", "fail", "fail", "fail"] }, FAKE_OVERSEER_REPAIR: { s3: "s2" } }, cfg: { maxTotalRepairs: 2, maxRetriesPerPhase: 5 } });
    assert.strictEqual(budget.run.status, "failed");
    assert.ok(/Total repair budget \(2\)/.test(types(budget.events, "overseer-decision").at(-1).decision.reasoning));
    assert.deepStrictEqual(starts(budget.events), ["s1#1", "s2#1", "s3#1", "s2#2", "s3#2", "s2#3", "s3#3"], `exactly two repairs under a budget of two: ${starts(budget.events)}`);
    const control = new RunControl();
    const stopped = await go({ control, after: (e) => { if (e.type === "phase-end" && e.stepId === "s1") control.stop("test stop"); } });
    assert.strictEqual(stopped.run.status, "stopped");
    assert.deepStrictEqual(starts(stopped.events), ["s1#1"], "a step started after the run was stopped");
    assert.ok(types(stopped.events, "overseer-decision").some((e) => e.decision.action === "stop" && /test stop/.test(e.decision.reasoning)));
    assert.ok(types(stopped.events, "overseer-decision").every((e) => e.decision.action === "stop"), "the Overseer was asked about a step after the run was stopped");
    assert.strictEqual(types(stopped.events, "usage").filter((e) => e.role === "overseer").length, 0, "the Overseer was paid for after the run was stopped");
    console.log("[ok] a step's retry budget, the run's repair budget and a stop each end the run as they do in the five-phase loop (failed, failed, stopped)");
  }

  // 7. A plan that does not validate runs nothing and says why
  {
    const bad = { ...PLAN, steps: PLAN.steps.filter((s) => s.role !== "gatekeeper") };
    const r = await go({ plan: bad });
    assert.strictEqual(r.run.status, "failed");
    assert.strictEqual(starts(r.events).length, 0, "a step ran under a plan that did not validate");
    assert.ok(types(r.events, "team-plan").length === 0, "a team plan that did not validate was announced");
    const d = types(r.events, "overseer-decision")[0];
    assert.ok(d.decision.action === "stop" && /refused before any step ran/.test(d.decision.reasoning), `the refusal: ${JSON.stringify(d.decision)}`);
    assert.strictEqual(r.workerCalls.length, 0, "the model was called under a plan that did not validate");
    console.log("[ok] a plan that fails validation runs no step, calls no model and says so");
  }

  // 7b. The order is the validated order, not the order the steps were written in
  {
    const scrambled = { ...PLAN, steps: ["s7", "s5", "s3", "s6", "s4", "s2", "s1"].map((id) => PLAN.steps.find((x) => x.id === id)) };
    const r = await go({ plan: scrambled, env: { FAKE_STEP_OUTCOMES: {} } });
    assert.strictEqual(r.run.status, "done");
    assert.deepStrictEqual(starts(r.events), ["s1#1", "s4#1", "s5#1", "s2#1", "s3#1", "s6#1", "s7#1"], `a plan written out of order ran as written: ${starts(r.events)}`);
    console.log("[ok] steps run in the plan's validated order (a step after the ones it needs), not the order they were written in");
  }

  // 7c. A checker that fails and an Overseer that names no target: the work goes back to the step the checker checks
  {
    const r = await go({ env: { FAKE_STEP_OUTCOMES: { verifier: ["fail", "pass", "pass"] }, FAKE_OVERSEER_REPAIR: { s3: "-" } } });
    assert.deepStrictEqual(starts(r.events).slice(0, 5), ["s1#1", "s2#1", "s3#1", "s2#2", "s3#2"], `no target named: ${starts(r.events)}`);
    console.log("[ok] a failing checker with no repair target named sends the work back to the step it checks");
  }

  // 7d. A step that is not a step of the work (a watchdog in a plan) gets no model session
  {
    const withWatch = { ...PLAN, steps: [PLAN.steps[0], { id: "w1", role: "watchdog", after: ["s1"], why: "watches the live flow" }, ...PLAN.steps.slice(1).map((x) => (x.id === "s2" || x.id === "s4" ? { ...x, after: ["w1"] } : x))] };
    const r = await go({ plan: withWatch, env: { FAKE_STEP_OUTCOMES: {} } });
    assert.strictEqual(r.run.status, "done");
    assert.ok(starts(r.events).includes("w1#1"));
    assert.strictEqual(r.workerCalls.length, 7, "the watchdog step was given a model session");
    assert.strictEqual(types(r.events, "phase-end").find((e) => e.stepId === "w1").verdict.headline, "Skipped");
    console.log("[ok] a watchdog in a plan is recorded as skipped and gets no model session");
  }

  // 7e. DECISIONS.md written by a step is indexed and announced once
  {
    const r = await go({ env: { FAKE_STEP_OUTCOMES: {}, FAKE_WRITES: [{ role: "planner", call: 1, path: "DECISIONS.md", content: "## D-1\nUse sqlite.\n" }] } });
    const logs = types(r.events, "decisions-log-updated");
    assert.strictEqual(logs.length, 1, `the decisions log was announced ${logs.length} times`);
    assert.ok(/Use sqlite/.test(logs[0].content));
    console.log("[ok] a DECISIONS.md written by a step is announced once, as in the five-phase loop");
  }

  // 7f. The Overseer failing ends the run as failed with its message; a step failing to answer is an inconclusive verdict that is retried
  {
    const r = await go({ env: { FAKE_SCENARIO: "overseer-throws" } });
    assert.strictEqual(r.run.status, "failed");
    assert.ok(/Overseer call raised an exception/.test(types(r.events, "overseer-decision").at(-1).decision.reasoning));
    const t = await go({ env: { FAKE_STEP_OUTCOMES: {}, FAKE_THROW: { role: "builder", call: 1 } } });
    const first = types(t.events, "phase-end").find((e) => e.stepId === "s2" && e.attempt === 1);
    assert.strictEqual(first.verdict.outcome, "inconclusive");
    assert.ok(/threw an unhandled error/.test(first.verdict.headline) && first.verdict.blockingFindings.length === 1);
    assert.ok(starts(t.events).includes("s2#2") && t.run.status === "done", "a step that failed to answer was not retried");
    console.log("[ok] an Overseer failure ends the run as failed with its message; a step that fails to answer is an inconclusive verdict and is retried");
  }

  // 7f2. A project too large to compare completely: the audit refuses to vouch for any step, so no step passes
  {
    assert.strictEqual((await go({ env: { FAKE_STEP_OUTCOMES: {} } })).run.status, "done", "the ordinary case with the default limit");
    const small = await go({ env: { FAKE_STEP_OUTCOMES: {} }, teamExtra: { maxTreeFiles: 2 }, cfg: { maxRetriesPerPhase: 1 } });
    const first = types(small.events, "phase-end").find((e) => e.stepId === "s1");
    assert.strictEqual(first.verdict.outcome, "fail", "a step passed although the project was too large to audit");
    assert.ok(first.verdict.blockingFindings.some((f) => /could not be checked/.test(f) && /incomplete/.test(f)), `the finding: ${first.verdict.blockingFindings}`);
    assert.strictEqual(small.run.status, "failed");
    console.log("[ok] a project over the file limit cannot be audited, so no step passes (the limit is configurable)");
  }

  // 7g. A stop that arrives between steps (while the Overseer is deciding) is honoured before the next step starts
  {
    const control = new RunControl();
    const r = await go({ control, after: (e) => { if (e.type === "overseer-decision" && e.stepId === "s1") control.stop("stop between steps"); } });
    assert.strictEqual(r.run.status, "stopped");
    assert.deepStrictEqual(starts(r.events), ["s1#1"]);
    console.log("[ok] a stop that arrives after the Overseer's decision is honoured before the next step starts");
  }

  // 7h. A report is never written through a link that leads out of the project
  if (process.platform !== "win32") {
    const { symlinkSync, readdirSync } = await import("node:fs");
    const outside = mkdtempSync(join(tmpdir(), "team-report-outside-"));
    const r = await go({ env: { FAKE_STEP_OUTCOMES: {}, FAKE_REPORT: "# should stay inside" } });
    assert.ok(existsSync(join(r.work, "team-reports/s1.md")), "the report was not written in the ordinary case");
    const dir = mkdtempSync(join(tmpdir(), "team-pipeline-link-"));
    const work = join(dir, "work");
    mkdirSync(join(work, "src/api"), { recursive: true }); mkdirSync(join(work, "src/ui"), { recursive: true });
    writeFileSync(join(work, "package.json"), "{}");
    symlinkSync(outside, join(work, "team-reports"));
    for (const k of ENV) delete process.env[k];
    globalThis.__fakeRoleCalls = {};
    process.env.FAKE_MAX_CALLS = "100000"; process.env.FAKE_REPORT = "# should stay inside"; process.env.FAKE_STEP_OUTCOMES = "{}";
    const store = new Store(join(dir, "t.db")); const bus = new EventBus(store);
    const run = await runPipeline({ task: "t", workDir: work, requireApproval: false, maxRetriesPerPhase: 2, maxTotalRepairs: 8, uiPort: 0, team: { plan: PLAN, roster: BUILTIN_ROSTER, source: "file" } }, bus, store);
    assert.strictEqual(run.status, "done", "a report that could not be saved failed the run");
    assert.deepStrictEqual(readdirSync(outside), [], "a report was written through a link that leads out of the project");
    console.log("[ok] a report is not written through a team-reports link that leads out of the project, and the run carries on");
  }

  // 8. The five-phase path is untouched: no team plan, no step ids
  {
    const r = await go({ plan: null, env: { FAKE_SCENARIO: "trivial-skip" } });
    assert.strictEqual(r.run.status, "done");
    assert.strictEqual(types(r.events, "team-plan").length, 0);
    assert.ok(types(r.events, "phase-start").every((e) => e.stepId === undefined), "a five-phase event grew a step id");
    assert.deepStrictEqual(types(r.events, "phase-start").map((e) => e.phase), ["planner", "test-designer", "builder", "verifier", "gatekeeper"], "the five built-in phases, the skipped one included (it is recorded, not silent)");
    console.log("[ok] without a team the five built-in phases run as before: no team plan, no step ids");
  }
  // 9. The planner's suggestion to skip a step (planner skip, IMP-024): it is applied only when the planner passes, only to a step the plan marked skippable, only while the step has not run, through the same V12
  //    rule as an Overseer skip, and every refusal is said. A skipped step is recorded with its id, costs no model call, and whatever waited for it waits for what it waited for.
  const SKIP_PLAN = { class: "single", size: "small", reason: "one slice", steps: [
    { id: "s1", role: "planner", why: "plan it" },
    { id: "s2", role: "advisor", after: ["s1"], skippable: true, why: "advise before building" },
    { id: "s3", role: "builder", slice: { name: "api", paths: ["src/api"] }, after: ["s2"], why: "the slice" },
    { id: "s4", role: "verifier", checks: "s3", why: "check it" },
    { id: "s5", role: "docs-writer", after: ["s4"], skippable: true, why: "update the docs" },
    { id: "s6", role: "gatekeeper", after: ["s5"], why: "last gate" },
  ] };
  const s2details = (r) => types(r.events, "phase-end").find((e) => e.stepId === "s2").verdict.details;
  const goSkip = (o) => go({ ...o, env: { FAKE_STEP_OUTCOMES: {}, ...o.env } }); // every step passes unless a scenario says otherwise
  const skippedRows = (r) => r.store.getPhaseSummaries(r.run.id).filter((x) => x.summary === "Skipped").map((x) => x.stepId);
  const overseerPlans = (r) => r.calls.filter((c) => c.overseer).map((c) => c.prompt.split("\n").filter((l) => /^- s\d: /.test(l)).map((l) => l.slice(2, 4)));
  {
    const r = await goSkip({ plan: SKIP_PLAN, env: { FAKE_SUGGESTED_SKIP: { planner: ["advisor", "advisor"] } } });
    assert.strictEqual(r.run.status, "done", `the run ended ${r.run.status}`);
    assert.deepStrictEqual(starts(r.events), ["s1#1", "s2#1", "s3#1", "s4#1", "s5#1", "s6#1"], "a skipped step is recorded as a step (start and end), not dropped silently");
    const said = types(r.events, "overseer-decision")[0].decision.reasoning;
    assert.ok(/skipping s2 \(advisor\) on the planner's suggestion/.test(said), `the decision does not say what was skipped: ${said}`);
    assert.ok(!/refused/.test(said), `a role named twice was refused the second time: ${said}`);
    assert.ok(/step s1/.test(s2details(r)), "the skip does not say which step asked");
    const s2 = types(r.events, "phase-end").find((e) => e.stepId === "s2");
    assert.ok(s2 && s2.role === "advisor" && /skipped/i.test(s2.verdict.headline), "the skipped step's end event does not say it was skipped");
    assert.ok(/planner/i.test(s2.verdict.details), "the skip does not say who asked");
    assert.strictEqual(r.workerCalls.length, 5, "a skipped step still cost a model call (planner, builder, verifier, docs-writer, gatekeeper ran)");
    assert.deepStrictEqual(skippedRows(r), ["s2"], "the store does not hold the skipped step");
    // the plan the Overseer sees after the planner no longer lists the skipped step; the steps after it still run in order
    assert.ok(overseerPlans(r).slice(1).every((ids) => !ids.includes("s2")), "the Overseer is still told about a skipped step");
    assert.ok(overseerPlans(r)[0].includes("s2"), "the Overseer's first look at the plan should still have it (the skip is applied after the planner passes)");
    assert.deepStrictEqual(types(r.events, "overseer-decision").filter((e) => e.decision.action === "continue").length, 5);
    console.log("[ok] the planner's suggestion skips a pending step the plan marked skippable: it is recorded with its id and asker, costs no model call, and later steps carry on");
  }

  // 10. Refusals: a never-skippable role, a role the plan did not mark, a role a signal made mandatory, a role not in the plan, and a role that already ran are not skipped, and the decision says why
  {
    for (const [name, suggest, teamExtra, plan, want] of [
      ["a never-skippable role", ["gatekeeper", "verifier", "builder"], {}, SKIP_PLAN, /gatekeeper[^|]*never|never[^|]*gatekeeper/i],
      ["a step the plan did not mark skippable", ["advisor"], {}, { ...SKIP_PLAN, steps: SKIP_PLAN.steps.map((s) => (s.id === "s2" ? { id: "s2", role: "advisor", after: ["s1"], why: "advise before building" } : s)) }, /did not mark s2/i],
      ["a role a signal made mandatory", ["advisor"], { required: ["advisor"] }, SKIP_PLAN, /mandatory/i],
      ["a role with no step waiting", ["security-reviewer", "not-a-role"], {}, SKIP_PLAN, /no step.*security-reviewer|security-reviewer.*no step/i],
    ]) {
      const r = await goSkip({ plan, teamExtra, env: { FAKE_SUGGESTED_SKIP: { planner: suggest } } });
      assert.strictEqual(r.run.status, "done", `${name}: the run ended ${r.run.status}`);
      assert.deepStrictEqual(skippedRows(r), [], `${name}: a step was skipped`);
      assert.ok(r.workerCalls.length === plan.steps.length, `${name}: not every step ran (${r.workerCalls.length})`);
      const first = types(r.events, "overseer-decision")[0];
      assert.ok(want.test(first.decision.reasoning), `${name}: the refusal is not in the decision: ${first.decision.reasoning}`);
      assert.ok(first.decision.reasoning.length < 1200, `${name}: the refusal note is not bounded`);
    }
    console.log("[ok] a skip of a never-skippable role, an unmarked step, a mandatory role, a role with no step waiting or one that is not a role is refused, nothing is skipped, and the decision says why");
  }

  // 11. Only the planner may ask, only when it passes, and only for steps that have not run
  {
    const r = await goSkip({ plan: SKIP_PLAN, env: { FAKE_SUGGESTED_SKIP: { advisor: ["docs-writer"], verifier: ["docs-writer"], builder: ["docs-writer"] } } });
    assert.strictEqual(r.run.status, "done");
    assert.deepStrictEqual(skippedRows(r), [], "a step other than the planner got a step skipped");
    assert.strictEqual(r.workerCalls.length, 6);

    // the planner fails first (its suggestion is not acted on), is repaired to itself, passes, and only then is the skip applied
    const f = await goSkip({ plan: SKIP_PLAN, env: { FAKE_STEP_OUTCOMES: { planner: ["fail", "pass"] }, FAKE_SUGGESTED_SKIP: { planner: ["advisor"] } } });
    assert.strictEqual(f.run.status, "done", `the run ended ${f.run.status}`);
    assert.deepStrictEqual(starts(f.events), ["s1#1", "s1#2", "s2#1", "s3#1", "s4#1", "s5#1", "s6#1"]);
    const iFail = f.events.findIndex((e) => e.type === "phase-end" && e.stepId === "s1" && e.attempt === 1);
    const iSkip = f.events.findIndex((e) => e.type === "phase-start" && e.stepId === "s2");
    const iPass = f.events.findIndex((e) => e.type === "phase-end" && e.stepId === "s1" && e.attempt === 2);
    assert.ok(iFail < iPass && iPass < iSkip, "the skip was applied before the planner passed");
    assert.deepStrictEqual(skippedRows(f), ["s2"]);
    const repairDecision = types(f.events, "overseer-decision")[0].decision;
    assert.strictEqual(repairDecision.action, "repair");
    assert.ok(!/skip/i.test(repairDecision.reasoning), `a failing planner's decision announced a skip: ${repairDecision.reasoning}`);
    assert.strictEqual(f.workerCalls.length, 6, "two planner attempts and the four steps that ran");

    // the planner runs again after the builder failed: the skip it suggests again finds nothing waiting, the advisor is not recorded twice
    const g = await goSkip({ plan: SKIP_PLAN, env: { FAKE_STEP_OUTCOMES: { builder: ["fail", "pass"] }, FAKE_OVERSEER_REPAIR: { s3: "s1" }, FAKE_SUGGESTED_SKIP: { planner: ["advisor"] } } });
    assert.strictEqual(g.run.status, "done", `the run ended ${g.run.status}`);
    assert.deepStrictEqual(skippedRows(g), ["s2"], "a second planner pass recorded the skip again");
    assert.deepStrictEqual(starts(g.events).filter((x) => x.startsWith("s2")), ["s2#1"]);
    console.log("[ok] only the planner can ask, only a passing planner is acted on, and a step that already ran or was already skipped is not skipped twice");
  }

  // 12. Several steps of one role are all skipped; the one that cannot be skipped stays and is named
  {
    const plan = { ...SKIP_PLAN, steps: [
      { id: "s1", role: "planner", why: "plan it" },
      { id: "s2", role: "advisor", after: ["s1"], skippable: true, why: "first opinion" },
      { id: "s3", role: "advisor", after: ["s2"], skippable: true, why: "second opinion" },
      { id: "s4", role: "advisor", after: ["s3"], why: "third opinion, not marked" },
      { id: "s5", role: "builder", slice: { name: "api", paths: ["src/api"] }, after: ["s4"], why: "the slice" },
      { id: "s6", role: "verifier", checks: "s5", why: "check it" },
      { id: "s7", role: "gatekeeper", after: ["s6"], why: "last gate" },
    ] };
    const r = await goSkip({ plan, env: { FAKE_SUGGESTED_SKIP: { planner: ["advisor"] } } });
    assert.strictEqual(r.run.status, "done", `the run ended ${r.run.status}`);
    assert.deepStrictEqual(skippedRows(r), ["s2", "s3"]);
    assert.strictEqual(r.workerCalls.length, 5, "planner, the unmarked advisor, builder, verifier, gatekeeper");
    assert.ok(/did not mark s4/i.test(types(r.events, "overseer-decision")[0].decision.reasoning), "the advisor that stayed is not named");
    console.log("[ok] every waiting step of the named role that the plan marked is skipped; one that is not marked stays, and is named");
  }
  // 13. A step that ran before the planner (a researcher) is not waiting, so it cannot be "skipped" into the record afterwards
  {
    const plan = { class: "single", size: "small", reason: "x", steps: [
      { id: "s1", role: "researcher", skippable: true, why: "find out first" },
      { id: "s2", role: "planner", after: ["s1"], why: "plan it" },
      { id: "s3", role: "builder", slice: { name: "api", paths: ["src/api"] }, after: ["s2"], why: "the slice" },
      { id: "s4", role: "verifier", checks: "s3", why: "check it" },
      { id: "s5", role: "gatekeeper", after: ["s4"], why: "last gate" },
    ] };
    const r = await goSkip({ plan, env: { FAKE_SUGGESTED_SKIP: { planner: ["researcher"] } } });
    assert.strictEqual(r.run.status, "done", `the run ended ${r.run.status}`);
    assert.deepStrictEqual(skippedRows(r), [], "a step that had already run was recorded as skipped");
    assert.strictEqual(r.workerCalls.length, 5);
    assert.ok(/researcher: no step of that role is waiting/.test(types(r.events, "overseer-decision")[1].decision.reasoning), "the refusal for a step that already ran is not in the planner's decision");
    console.log("[ok] a step that ran before the planner is not waiting: asking to skip it changes nothing and says so");
  }

  // 14. What the decision says about refusals is bounded, however many roles the planner names
  {
    const names = Array.from({ length: 8 }, (_, i) => "a" + String(i).repeat(40));
    const r = await goSkip({ plan: SKIP_PLAN, env: { FAKE_SUGGESTED_SKIP: { planner: names } } });
    assert.strictEqual(r.run.status, "done");
    const said = types(r.events, "overseer-decision")[0].decision.reasoning;
    assert.ok(/skip refused/.test(said) && said.length < 660, `the refusal note is ${said.length} characters long`);
    console.log("[ok] eight refused names are said in a bounded note");
  }

  // 15. The mandatory roles are checked against the plan before anything runs (V4), and the judgement of a skip is pure and rewires the plan
  {
    const r = await goSkip({ plan: SKIP_PLAN, teamExtra: { required: ["security-reviewer"] } });
    assert.strictEqual(r.run.status, "failed");
    assert.strictEqual(r.workerCalls.length, 0, "a plan missing a mandatory role ran");
    assert.ok(/V4/.test(types(r.events, "overseer-decision")[0].decision.reasoning), "the refusal does not name the rule");
    const ctx = { roster: BUILTIN_ROSTER, writes: true, workDir: "/tmp" };
    const before = JSON.stringify(SKIP_PLAN);
    const j = judgeSkips(SKIP_PLAN, ["s2", "s3", "s4", "s5", "s6"], ["advisor", "docs-writer", "builder"], "why", ctx);
    assert.strictEqual(JSON.stringify(SKIP_PLAN), before, "judging a skip changed the plan it was given");
    assert.deepStrictEqual(j.skipped.map((s) => s.id), ["s2", "s5"]);
    assert.deepStrictEqual(j.plan.steps.map((s) => s.id), ["s1", "s3", "s4", "s6"], "the skipped steps are still in the plan");
    assert.deepStrictEqual(j.plan.steps.find((s) => s.id === "s3").after, ["s1"], "what waited for the advisor does not wait for what the advisor waited for");
    assert.deepStrictEqual(j.plan.steps.find((s) => s.id === "s6").after, ["s4"], "the gatekeeper does not wait for what the skipped docs step waited for");
    assert.strictEqual(j.refused.length, 1);
    assert.ok(/builder: .*never/i.test(j.refused[0]), j.refused[0]);
    const none = judgeSkips(SKIP_PLAN, ["s2"], ["not-a-role"], "why", ctx);
    assert.strictEqual(none.plan, SKIP_PLAN, "a judgement that skipped nothing returned another plan");
    console.log("[ok] a plan missing a mandatory role is refused before anything runs; judging skips is pure, rewires what waited, and names each refusal");
  }
} finally {
  clearEnv();
}
console.log("\nALL TEAM PIPELINE TESTS PASSED");
process.exit(0);
