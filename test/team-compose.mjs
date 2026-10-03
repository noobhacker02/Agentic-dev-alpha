// The composer (src/team/compose.ts): the sizing guide from docs/TEAM-COMPOSITION.md as code, the floor code puts under any proposed team, and what happens to a proposal
// that is over the cap, drops a mandatory role, or lies. The offline composer needs no model (it is also the fallback when the model's plan is refused). No model, no network:
//   npm run build && npm run test:team-compose
import assert from "node:assert";
import { BUILTIN_ROSTER } from "../dist/team/roster.js";
import { computeSignals, requiredRoles } from "../dist/team/signals.js";
import { validatePlan } from "../dist/team/plan.js";
import { composeOffline, finalizePlan, chooseFinal, composeForEach, parseComposerJson } from "../dist/team/compose.js";

const files = [
  "README.md", "package.json", "src/index.ts", "src/api/users.ts", "src/api/orders.ts", "src/worker/jobs.ts", "src/cli/main.ts", "src/report/total.ts", "src/billing/ledger.ts",
  "src/auth/session.ts", "src/auth/login.ts", "src/auth/reset.ts", "src/util/format.ts", "src/ui/Button.tsx", "src/ui/theme.css", "test/users.test.ts", "src/db/migrations/001_init.sql",
];
const roster = BUILTIN_ROSTER;
const run = (task, repoFiles = files) => {
  const signals = computeSignals(task, { files: repoFiles });
  const r = composeOffline(task, signals, roster);
  return { ...r, signals, roles: r.plan.steps.map((s) => s.role), order: r.validation.order.map((id) => r.plan.steps.find((s) => s.id === id).role) };
};
const ctxFor = (signals, over = {}) => ({ roster, writes: signals.writes, required: requiredRoles(signals), ...over });

// 1. The sizing guide, row by row (execution order, so "gatekeeper last" is part of every expectation).
const labelled = [
  ["tiny: a one-file fix, tests exist", "fix the typo in README.md", ["builder", "verifier", "gatekeeper"]],
  ["typical: one module", "add a retry to the fetchUser function", ["planner", "test-designer", "builder", "verifier", "gatekeeper"]],
  ["a bug with an unclear cause", "the report totals are sometimes wrong and nobody knows why", ["researcher", "builder", "verifier", "gatekeeper"]],
  ["an unfamiliar library", "use the zod library to validate the config", ["researcher", "planner", "builder", "verifier", "gatekeeper"]],
  ["two modules", "update src/api/users.ts and src/worker/jobs.ts", ["planner", "builder", "verifier", "builder", "verifier", "integrator", "gatekeeper"]],
  ["a sensitive path: a reviewer is added", "add a password reset endpoint in src/auth/reset.ts", ["planner", "test-designer", "builder", "verifier", "security-reviewer", "docs-writer", "gatekeeper"]],
  ["UI changed, one file", "change the colour in src/ui/theme.css", ["builder", "verifier", "ui-tester", "gatekeeper"]],
  ["a read-only question", "explain how the session refresh works", ["researcher"]],
  ["a read-only question that drives an irreversible choice", "explain the risks of dropping the users table first", ["researcher", "advisor"]],
  ["find out and patch: reads, then writes, with the floor", "find out why login fails and patch it", ["researcher", "builder", "verifier", "security-reviewer", "gatekeeper"]],
];
for (const [what, task, expected] of labelled) {
  const r = run(task);
  assert.deepStrictEqual(r.order, expected, `${what}: "${task}"\n   got      ${r.order.join(" > ")}\n   expected ${expected.join(" > ")}`);
  assert.ok(r.validation.ok, `${what}: the composed plan does not validate: ${JSON.stringify(r.validation.violations)}`);
  for (const s of r.plan.steps) assert.ok(typeof s.why === "string" && s.why.length > 5, `${what}: step ${s.id} has no real reason`);
}
console.log(`[ok] the sizing guide: ${labelled.length} labelled tasks compose to the expected team, in execution order, each plan validating, each step with a reason`);

// 2. More modules, more slices: one builder and one verifier each, an integrator, and a cap on slices that keeps the plan within the agent cap.
{
  const three = run("update src/api/users.ts, src/worker/jobs.ts and src/cli/main.ts");
  assert.strictEqual(three.plan.steps.length, 9, "three modules: planner, three builders, three verifiers, integrator, gatekeeper");
  const five = run("update src/api/users.ts, src/worker/jobs.ts, src/cli/main.ts, src/report/total.ts and src/billing/ledger.ts");
  assert.ok(five.validation.ok && five.plan.steps.length <= 12, `five modules: ${five.plan.steps.length} agents, ${JSON.stringify(five.validation.violations)}`);
  const slices = five.plan.steps.filter((s) => s.slice);
  assert.strictEqual(slices.length, 4, "five modules should fold into four slices (the cap)");
  assert.ok(slices.some((s) => s.slice.paths.length === 2), "the fifth module should be owned by the last slice");
  assert.ok(five.changes.some((c) => /five|5|fold|share/i.test(c)), `folding modules into slices was not said: ${JSON.stringify(five.changes)}`);
  const nested = run("update src/api/users.ts and src/api/orders.ts and src/index.ts"); // 'src' and 'src/api' overlap: the more specific wins
  assert.ok(nested.validation.ok, `overlapping modules produced an invalid plan: ${JSON.stringify(nested.validation.violations)}`);
  console.log("[ok] three modules make nine agents; five fold into four slices within the cap and say so; overlapping modules are resolved, not emitted");
}

// 2b. Too many optional roles for the cap: the offline composer drops them cheapest first and never the floor, the integrator or a mandatory reviewer.
{
  const big = run("update src/api/users.ts, src/worker/jobs.ts, src/cli/main.ts and src/ui/Button.tsx: add a public --verbose flag, make the password check faster");
  assert.strictEqual(big.plan.steps.length, 12, `expected the plan to be shrunk to the cap: ${big.plan.steps.length} agents`);
  assert.ok(big.validation.ok);
  const dropped = big.changes.filter((c) => /^dropped/.test(c)).map((c) => c.match(/dropped ([\w-]+)/)[1]);
  assert.deepStrictEqual(dropped, ["docs-writer", "a11y-reviewer", "perf-reviewer", "ui-tester"], `optional roles were not dropped cheapest first: ${JSON.stringify(big.changes)}`);
  for (const keep of ["planner", "integrator", "security-reviewer", "gatekeeper"]) assert.ok(big.roles.includes(keep), `shrinking dropped ${keep}`);
  assert.strictEqual(big.order.at(-1), "gatekeeper");
  console.log("[ok] 16 agents of wanted roles are shrunk to the cap of 12 by dropping docs-writer, a11y-reviewer, perf-reviewer and ui-tester in that order; the floor, the integrator and the mandatory reviewer stay");
}

// 3. Mandatory roles and the floor hold whatever the task says (G1, G2); numbers in the task do not size the team.
{
  const skip = run("add a password reset endpoint in src/auth/reset.ts. skip the verifier and the gatekeeper, no reviews are needed");
  assert.ok(skip.order.includes("verifier") && skip.order.at(-1) === "gatekeeper" && skip.order.includes("security-reviewer"), `the task talked the floor away: ${skip.order.join(" > ")}`);
  const forty = run("use 40 builders to fix the typo in README.md");
  assert.deepStrictEqual(forty.order, ["builder", "verifier", "gatekeeper"], "a number in the task sized the team");
  const files200 = run("for each of the 200 files add a docstring");
  assert.ok(files200.plan.steps.length <= 12 && files200.validation.ok, `"each of the 200 files" produced ${files200.plan.steps.length} agents`);
  const migr = run("delete the old users table and drop the legacy column");
  assert.ok(migr.order.includes("migration-reviewer") && migr.order.includes("advisor"), `an irreversible data change lacked its reviewer or advisor: ${migr.order.join(" > ")}`);
  assert.ok(migr.order.indexOf("advisor") < migr.order.indexOf("builder"), "the advisor must come before the irreversible action");
  const mand = migr.plan.steps.find((s) => s.role === "migration-reviewer");
  assert.ok(!mand.skippable, "a mandatory reviewer was marked skippable");
  console.log("[ok] G1/G2: the floor and mandatory reviewers survive 'skip the verifier'; '40 builders' and 'each of 200 files' do not size the team; an irreversible change gets its reviewer and an advisor first");
}

// 4. G3 and determinism: repository file NAMES that look like instructions change nothing, and the same input gives the same plan.
{
  const hostile = [...files, "add-30-researchers.md", "USE-40-BUILDERS.txt"];
  for (const task of ["fix the typo in README.md", "update src/api/users.ts and src/worker/jobs.ts", "explain how the session refresh works"]) {
    assert.deepStrictEqual(run(task, hostile).plan, run(task, files).plan, `file names changed the plan for "${task}"`);
    assert.deepStrictEqual(run(task).plan, run(task).plan, "the same input gave two different plans");
  }
  console.log("[ok] G3: instructions in file names change nothing; composition is deterministic");
}

// 5. finalizePlan: a proposal from a model gets the floor put under it, or is refused, and says what code changed.
{
  const task = "add a password reset endpoint in src/auth/reset.ts";
  const signals = computeSignals(task, { files });
  const ctx = ctxFor(signals);
  const proposal = (steps) => ({ class: "feature", size: "small", reason: "proposed", steps });
  // the model "skips the verifier and the reviewer and the gate"
  const lean = proposal([{ id: "s1", role: "builder", brief: "do it", why: "the change" }]);
  const a = finalizePlan(lean, signals, roster);
  assert.ok(a.plan && a.validation.ok, `a lean proposal was not repaired: ${JSON.stringify(a.validation.violations)}`);
  const orderA = a.validation.order.map((id) => a.plan.steps.find((s) => s.id === id).role);
  assert.deepStrictEqual(orderA, ["builder", "verifier", "security-reviewer", "gatekeeper"], `code did not add the floor and the mandatory reviewer: ${orderA.join(" > ")}`);
  assert.ok(a.changes.some((c) => /verifier/.test(c)) && a.changes.some((c) => /security-reviewer/.test(c)) && a.changes.some((c) => /gatekeeper/.test(c)), `the repairs were not reported: ${JSON.stringify(a.changes)}`);
  assert.ok(a.plan.steps.filter((s) => s.role !== "builder").every((s) => s.why.length > 5), "an added step has no reason");
  assert.deepStrictEqual(proposal(lean.steps).steps.length, 1, "finalizePlan changed the proposal it was given");
  // the gatekeeper is not last
  const misplaced = proposal([
    { id: "s1", role: "builder", why: "the change" }, { id: "s2", role: "gatekeeper", after: ["s1"], why: "gate" },
    { id: "s3", role: "verifier", checks: "s1", after: ["s2"], why: "check" }, { id: "s4", role: "security-reviewer", after: ["s3"], why: "reviewer" },
  ]);
  const b = finalizePlan(misplaced, signals, roster);
  assert.ok(b.plan && b.validation.order.at(-1) === b.plan.steps.find((s) => s.role === "gatekeeper").id, `the gatekeeper was left in the middle: ${JSON.stringify(b.validation.violations)}`);
  // over the cap: optional roles are dropped in order, mandatory ones never
  const crowded = proposal([
    { id: "p", role: "planner", why: "plan" },
    ...[1, 2, 3].flatMap((i) => [{ id: `b${i}`, role: "builder", slice: { name: `m${i}`, paths: [`src/m${i}`] }, after: ["p"], why: `slice ${i}` }, { id: `v${i}`, role: "verifier", checks: `b${i}`, why: `check ${i}` }]),
    { id: "i", role: "integrator", after: ["v1", "v2", "v3"], why: "join" },
    { id: "sr", role: "security-reviewer", after: ["i"], why: "auth changed" },
    { id: "d", role: "docs-writer", after: ["sr"], skippable: true, why: "docs" }, { id: "a", role: "a11y-reviewer", after: ["d"], skippable: true, why: "ui" },
    { id: "r", role: "researcher", after: ["a"], skippable: true, why: "reading" },
    { id: "g", role: "gatekeeper", after: ["r"], why: "gate" },
  ]);
  const c = finalizePlan(crowded, signals, roster);
  assert.ok(c.plan && c.plan.steps.length <= 12 && c.validation.ok, `an over-cap proposal was not shrunk: ${JSON.stringify(c.validation.violations)}`);
  assert.ok(c.plan.steps.some((s) => s.role === "security-reviewer") && c.plan.steps.some((s) => s.role === "gatekeeper"), "shrinking dropped a mandatory role");
  assert.strictEqual(c.plan.steps.length, 12, "exactly one step over the cap: exactly one should go");
  assert.ok(!c.plan.steps.some((s) => s.role === "docs-writer") && c.plan.steps.some((s) => s.role === "a11y-reviewer") && c.plan.steps.some((s) => s.role === "researcher"), "the cheapest optional role should go first, and only that one");
  assert.ok(c.changes.some((x) => /dropped/i.test(x)), "dropping was not reported");
  // refused: an unknown role, 40 builders, a verifier checking itself: no plan, with reasons
  const wizard = finalizePlan(proposal([{ id: "s1", role: "wizard", why: "magic" }]), signals, roster);
  assert.ok(!wizard.plan && wizard.validation.violations.some((v) => v.rule === "V1"), "an unknown role was repaired into a plan");
  const forty = finalizePlan(proposal([{ id: "p", role: "planner", why: "p" }, ...Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, role: "builder", slice: { name: `m${i}`, paths: [`src/m${i}`] }, after: ["p"], why: "x" }))]), signals, roster);
  assert.ok(!forty.plan, "a proposal with 40 builders was accepted");
  const selfCheck = finalizePlan(proposal([{ id: "s1", role: "builder", why: "x" }, { id: "s2", role: "verifier", checks: "s2", after: ["s1"], why: "x" }]), signals, roster);
  assert.ok(selfCheck.plan?.steps.some((s) => s.role === "verifier" && s.checks === "s1") || !selfCheck.plan, "a self-checking verifier was accepted as it stood");
  for (const junk of [null, 7, "plan", { steps: "no" }, []]) assert.ok(!finalizePlan(junk, signals, roster).plan, `junk ${JSON.stringify(junk)} became a plan`);
  console.log("[ok] a proposed plan gets the floor and mandatory reviewers added (and reported), a misplaced gatekeeper moved last, an over-cap plan shrunk (cheapest optional role first), and the unknown, the oversized and the junk refused");
}

// 6. chooseFinal: a refused proposal falls back to the offline plan and says why; a good one is used.
{
  const task = "update src/api/users.ts and src/worker/jobs.ts";
  const signals = computeSignals(task, { files });
  const offline = composeOffline(task, signals, roster);
  const bad = chooseFinal({ class: "x", size: "y", reason: "z", steps: [{ id: "s1", role: "wizard", why: "magic" }] }, task, signals, roster);
  assert.strictEqual(bad.source, "offline-fallback");
  assert.deepStrictEqual(bad.plan, offline.plan, "the fallback is not the offline plan");
  assert.ok(bad.changes.some((c) => /refused/i.test(c) && /wizard|V1/.test(c)), `the refusal was not recorded: ${JSON.stringify(bad.changes)}`);
  const good = chooseFinal(offline.plan, task, signals, roster);
  assert.strictEqual(good.source, "proposal");
  assert.deepStrictEqual(good.plan, offline.plan, "a valid proposal was changed");
  assert.strictEqual(chooseFinal(undefined, task, signals, roster).source, "offline", "no proposal means the offline composer");
  console.log("[ok] a refused proposal falls back to the offline plan with the reason; a valid one is used as it stands; no proposal means offline");
}

// 7. composeForEach: the job flow's shape. The cap is the user's, never the composer's.
{
  const items = Array.from({ length: 5 }, (_, i) => `job-${i + 1}`);
  const r = composeForEach(items, { roster });
  assert.ok(r.plan && r.validation.ok, `a foreach plan was refused: ${JSON.stringify(r.validation.violations)}`);
  assert.strictEqual(r.plan.steps.length, 1 + 2 * 5 + 1, "planner once, a builder and a verifier per item, one gatekeeper");
  assert.deepStrictEqual(r.plan.steps.filter((s) => s.item).map((s) => s.role).sort(), [...Array(5).fill("builder"), ...Array(5).fill("verifier")].sort());
  assert.ok(composeForEach(Array.from({ length: 30 }, (_, i) => `j${i}`), { roster }).validation.ok, "30 items are within the default cap");
  const over = composeForEach(Array.from({ length: 31 }, (_, i) => `j${i}`), { roster });
  assert.ok(!over.plan && over.validation.violations.some((v) => v.rule === "V15"), "31 items were composed");
  assert.ok(composeForEach(Array.from({ length: 31 }, (_, i) => `j${i}`), { roster, itemCap: 40 }).validation.ok, "control: the user's own cap of 40 allows 31");
  assert.ok(composeForEach([], { roster }).plan === undefined, "an empty item list produced a plan");
  assert.ok(composeForEach(["a", "a", "b"], { roster }).plan.steps.filter((s) => s.role === "builder").length === 2, "duplicate items were not folded");
  console.log("[ok] a foreach over items: planner once, builder and verifier per item, gatekeeper last; 30 items pass, 31 are refused unless the user raised the cap; duplicates fold");
}

// 8. parseComposerJson: strict, bounded, and it never executes anything.
{
  const plan = { class: "fix", size: "small", reason: "r", steps: [{ id: "s1", role: "builder", why: "x" }] };
  assert.deepStrictEqual(parseComposerJson(JSON.stringify(plan)), plan);
  assert.deepStrictEqual(parseComposerJson("Here is the plan:\n```json\n" + JSON.stringify(plan) + "\n```\nHope that helps"), plan, "fenced JSON with chatter around it was not read");
  for (const bad of ["", "no json here", "{ not: json }", "[1,2,3]", "7", "null", "x".repeat(200_000), '{"steps":[' + '{"a":'.repeat(5000)]) {
    assert.strictEqual(parseComposerJson(bad), undefined, `junk ${bad.slice(0, 20)} was parsed`);
  }
  const bigButValid = JSON.stringify({ ...plan, reason: "r".repeat(80_000) });
  assert.strictEqual(parseComposerJson(bigButValid), undefined, "a valid but 80 KB answer was parsed (the bound is 50 KB)");
  assert.ok(parseComposerJson(JSON.stringify({ ...plan, reason: "r".repeat(2_000) })), "control: a 2 KB answer is read");
  const proto = parseComposerJson('{"class":"x","size":"y","reason":"z","__proto__":{"polluted":true},"steps":[{"id":"s1","role":"builder","why":"x"}]}');
  assert.ok(({}).polluted === undefined, "parsing polluted Object.prototype");
  assert.ok(!validatePlan(proto, { roster, writes: false }).ok, "a plan carrying __proto__ was accepted");
  console.log("[ok] composer JSON: fenced or bare objects are read; junk, oversized and deeply nested text is not; __proto__ cannot pollute or pass");
}
// 12. Whatever the task contains, the plan does not carry control bytes: not C0 and not C1 (U+0080 to U+009F), which some terminals act on.
{
  const task = "fix \u001b]0;pwned\u0007 the \u009b2J typo \u0000 in README.md";
  const r = composeOffline(task, computeSignals(task, { files: ["README.md", "test/a.test.ts"] }), roster);
  assert.ok(r.plan, "control: the sanitised task still gets a plan");
  const raw = /[\u0000-\u001f\u007f-\u009f]/;
  assert.ok(!raw.test(r.plan.reason), "a control byte from the task is in the plan's reason");
  assert.ok(r.plan.steps.every((x) => !raw.test(x.brief ?? "") && !raw.test(x.why)), "a control byte from the task is in a step");
  console.log("[ok] a task full of C0 and C1 control bytes gets a plan with none of them in it");
}
console.log("\nALL TEAM COMPOSE TESTS PASSED");
