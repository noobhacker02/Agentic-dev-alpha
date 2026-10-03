// The team plan validator (src/team/plan.ts): the floor and the caps from docs/TEAM-COMPOSITION.md, rule by rule: V1 to V8, V10 to V12 and V15 (V9 comes with the usage
// governor, V13 is the roster's, V14 is the post-build re-check in signals). Every "it is refused" check sits next to an "it is accepted" twin that differs in the one thing
// the rule is about, so the validator is shown to be able to say no AND yes. No model, no network:  npm run build && npm run test:team-plan
import assert from "node:assert";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_ROSTER } from "../dist/team/roster.js";
import { validatePlan, appendSteps, skipStep, auditDiffScope, executionOrder } from "../dist/team/plan.js";

const roster = BUILTIN_ROSTER;
const ctx = (over = {}) => ({ roster, writes: true, required: [], ...over });
const clone = (x) => JSON.parse(JSON.stringify(x));
const rules = (v) => [...new Set(v.violations.map((x) => x.rule))].sort();
const only = (v, rule) => v.violations.filter((x) => x.rule === rule);

/** The plan from the design document. */
const example = () => ({
  class: "feature", size: "large", reason: "touches auth and adds a dependency; two independent modules",
  steps: [
    { id: "s1", role: "researcher", brief: "how does the session library refresh tokens?", why: "unfamiliar library" },
    { id: "s2", role: "planner", after: ["s1"], why: "multi-module change" },
    { id: "s3", role: "builder", slice: { name: "api", paths: ["src/api/**"] }, after: ["s2"], why: "slice 1 of 2" },
    { id: "s4", role: "verifier", checks: "s3", why: "independent check of slice 1" },
    { id: "s5", role: "builder", slice: { name: "ui", paths: ["src/ui/**"] }, after: ["s2"], why: "slice 2 of 2" },
    { id: "s6", role: "verifier", checks: "s5", why: "independent check of slice 2" },
    { id: "s7", role: "integrator", after: ["s4", "s6"], why: "join slices, run the full suite" },
    { id: "s8", role: "security-reviewer", after: ["s7"], why: "auth path changed (mandatory by signal)" },
    { id: "s9", role: "gatekeeper", after: ["s8"], why: "final gate" },
  ],
});
const small = () => ({
  class: "fix", size: "small", reason: "one-file fix",
  steps: [
    { id: "s1", role: "builder", brief: "fix the typo", why: "the change" },
    { id: "s2", role: "verifier", checks: "s1", why: "independent check" },
    { id: "s3", role: "gatekeeper", after: ["s2"], why: "final gate" },
  ],
});
const set = (plan, id, patch) => { const p = clone(plan); Object.assign(p.steps.find((s) => s.id === id), patch); return p; };
const without = (plan, id) => { const p = clone(plan); p.steps = p.steps.filter((s) => s.id !== id); return p; };

// 0. The example from the design validates, in the stable topological order; a small plan too.
{
  const v = validatePlan(example(), ctx({ required: ["security-reviewer"] }));
  assert.deepStrictEqual(v.violations, [], `the design's own example plan was refused: ${JSON.stringify(v.violations)}`);
  assert.ok(v.ok);
  assert.deepStrictEqual(v.order, ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"], "not the stable topological order");
  assert.ok(validatePlan(small(), ctx()).ok, "a three-step plan was refused");
  console.log("[ok] the design's nine-step example and a three-step plan validate; execution order is the stable topological order");
}

// 1. V1: an unknown role is rejected, never defaulted. And every step has a reason.
{
  const bad = clone(small());
  bad.steps[0].after = ["w"];
  bad.steps.unshift({ id: "w", role: "wizard", why: "an unknown role as the first step" });
  const v = validatePlan(bad, ctx());
  assert.ok(!v.ok && only(v, "V1").length === 1 && only(v, "V1")[0].step === "w", `unknown role: ${JSON.stringify(v.violations)}`);
  const known = [...roster, { ...roster.find((r) => r.id === "researcher"), id: "wizard", builtin: false }];
  assert.ok(validatePlan(bad, ctx({ roster: known })).ok, "control: the same plan is fine once the role is on the roster");
  for (const why of ["", "   ", undefined, 42]) {
    const p = clone(small());
    if (why === undefined) delete p.steps[0].why; else p.steps[0].why = why;
    assert.ok(only(validatePlan(p, ctx()), "WHY").length === 1, `a step with why=${JSON.stringify(why)} was accepted`);
  }
  console.log("[ok] V1: an unknown role is refused (and accepted once it is on the roster); a step without a reason is refused");
}

// 2. V2: a task that writes or acts has a builder, a verifier after it, and a gatekeeper last.
{
  assert.ok(only(validatePlan(without(without(small(), "s3"), "s2"), ctx()), "V2").length >= 1, "a writing task with no verifier and no gate was accepted");
  const noBuilder = { class: "fix", size: "small", reason: "x", steps: [{ id: "s1", role: "researcher", why: "look" }, { id: "s2", role: "gatekeeper", after: ["s1"], why: "gate" }] };
  assert.ok(only(validatePlan(noBuilder, ctx({ writes: true })), "V2").some((x) => /builder/.test(x.message)), "a task that writes with no builder was accepted");
  assert.ok(validatePlan(noBuilder, ctx({ writes: false })).violations.every((x) => x.rule !== "V2" || !/builder/.test(x.message)), "control: a read-only task needs no builder");
  const noVerifier = clone(small()); noVerifier.steps = [noVerifier.steps[0], { id: "s3", role: "gatekeeper", after: ["s1"], why: "gate" }];
  assert.ok(only(validatePlan(noVerifier, ctx()), "V2").some((x) => /verifier/.test(x.message)), "a builder with no verifier checking it was accepted");
  assert.ok(only(validatePlan(without(small(), "s3"), ctx()), "V2").some((x) => /gatekeeper/.test(x.message)), "a writing plan with no gatekeeper was accepted");
  const notLast = clone(small()); notLast.steps.push({ id: "s4", role: "researcher", after: ["s3"], why: "after the gate" });
  assert.ok(only(validatePlan(notLast, ctx()), "V2").some((x) => /last/.test(x.message)), "a step after the gatekeeper was accepted");
  const two = clone(small()); two.steps.push({ id: "s4", role: "gatekeeper", after: ["s3"], why: "second gate" });
  assert.ok(only(validatePlan(two, ctx()), "V2").some((x) => /exactly one gatekeeper/.test(x.message)), "two gatekeepers were accepted, or refused by some other rule (the per-role cap would also catch them)");
  const readOnly = { class: "question", size: "tiny", reason: "explain", steps: [{ id: "s1", role: "researcher", why: "find out" }] };
  assert.ok(validatePlan(readOnly, ctx({ writes: false })).ok, "control: a read-only question is one researcher, no builder, no gate");
  assert.ok(!validatePlan(readOnly, ctx({ writes: true })).ok, "a task that writes was accepted as a single researcher");
  console.log("[ok] V2: builder, then a verifier after it, then a gatekeeper last; a read-only question needs none of it; a task that writes cannot pass as one");
}

// 3. V3: a verifier names the step it checks, which must be a different, earlier, building step.
{
  const noChecks = set(small(), "s2", { checks: undefined });
  assert.ok(only(validatePlan(noChecks, ctx()), "V3").length >= 1, "a verifier that checks nothing was accepted");
  assert.ok(only(validatePlan(set(small(), "s2", { checks: "s9" }), ctx()), "V3").some((x) => /unknown|no step/i.test(x.message)) || !validatePlan(set(small(), "s2", { checks: "s9" }), ctx()).ok, "a verifier that checks an unknown step was accepted");
  assert.ok(only(validatePlan(set(small(), "s2", { checks: "s2" }), ctx()), "V3").some((x) => /itself/.test(x.message)), "a verifier that checks itself was accepted, or refused for the wrong reason");
  const checksResearcher = example(); checksResearcher.steps[3].checks = "s1";
  assert.ok(only(validatePlan(checksResearcher, ctx({ required: ["security-reviewer"] })), "V3").some((x) => /build/.test(x.message)), "a verifier that checks a researcher was accepted");
  const sibling = { ...small(), steps: [small().steps[0], { id: "s2", role: "verifier", checks: "s1", why: "check" }, { id: "s2b", role: "verifier", checks: "s2", why: "a verifier checking a verifier" }, { id: "s3", role: "gatekeeper", after: ["s2b"], why: "gate" }] };
  assert.ok(only(validatePlan(sibling, ctx()), "V3").some((x) => /build/.test(x.message)), "a verifier that checks a verifier was accepted");
  assert.ok(validatePlan(small(), ctx()).ok, "control: the ordinary verifier is fine");
  console.log("[ok] V3: a verifier with no target, an unknown target, itself, a researcher or another verifier is refused");
}

// 4. V4: a role that is mandatory by signal cannot be dropped, whatever the composer says.
{
  const dropped = without(example(), "s8"); dropped.steps.find((s) => s.id === "s9").after = ["s7"];
  const v = validatePlan(dropped, ctx({ required: ["security-reviewer"] }));
  assert.ok(only(v, "V4").length === 1 && /security-reviewer/.test(only(v, "V4")[0].message), `a dropped mandatory reviewer was accepted: ${JSON.stringify(v.violations)}`);
  assert.ok(validatePlan(dropped, ctx({ required: [] })).ok, "control: the same plan is fine when no signal made the reviewer mandatory");
  const marked = set(dropped, "s7", { skippable: true });
  assert.ok(only(validatePlan(marked, ctx({ required: ["security-reviewer"] })), "V4").length === 1, "marking another step skippable made a mandatory role optional");
  assert.ok(validatePlan(example(), ctx({ required: ["security-reviewer"] })).ok, "control: with the reviewer present the plan passes");
  console.log("[ok] V4: a mandatory reviewer cannot be dropped; the same plan passes when no signal required it");
}

// 5. V5: caps. Total agents (default 12) and per-role caps, with the drop order that would fit.
{
  const sliced = (n, extra = []) => {
    const steps = [{ id: "p", role: "planner", why: "plan" }];
    for (let i = 1; i <= n; i++) { steps.push({ id: `b${i}`, role: "builder", slice: { name: `m${i}`, paths: [`pkg/m${i}`] }, after: ["p"], why: `slice ${i}` }); steps.push({ id: `v${i}`, role: "verifier", checks: `b${i}`, why: `check ${i}` }); }
    steps.push({ id: "i", role: "integrator", after: Array.from({ length: n }, (_, k) => `v${k + 1}`), why: "join" });
    let last = "i";
    for (const e of extra) { steps.push({ ...e, after: [last] }); last = e.id; }
    steps.push({ id: "g", role: "gatekeeper", after: [last], why: "gate" });
    return { class: "feature", size: "large", reason: "many modules", steps };
  };
  assert.ok(validatePlan(sliced(5), ctx()).violations.every((x) => x.rule !== "V5") === false, "13 agents were accepted under a cap of 12");
  assert.ok(validatePlan(sliced(4), ctx()).ok, "control: 4 slices (11 agents) are within the cap");
  assert.ok(validatePlan(sliced(5), ctx({ cap: 13 })).ok, "control: the same plan passes when the configured cap is 13");
  const over = sliced(3, [
    { id: "d1", role: "docs-writer", why: "docs" }, { id: "a1", role: "a11y-reviewer", why: "ui" }, { id: "x1", role: "perf-reviewer", why: "perf" }, { id: "r1", role: "researcher", why: "look" },
  ]);
  const v = validatePlan(over, ctx());
  assert.deepStrictEqual(only(v, "V5").length, 1);
  assert.ok(Array.isArray(v.dropOrder) && v.dropOrder.length === 1 && v.dropOrder[0] === "d1", `the drop order that would fit was ${JSON.stringify(v.dropOrder)} (the cheapest skippable role goes first)`);
  const manyResearchers = { class: "q", size: "s", reason: "x", steps: [{ id: "r1", role: "researcher", why: "a" }, { id: "r2", role: "researcher", after: ["r1"], why: "b" }, { id: "r3", role: "researcher", after: ["r2"], why: "c" }] };
  assert.ok(only(validatePlan(manyResearchers, ctx({ writes: false })), "V5").some((x) => /researcher/.test(x.message)), "three researchers were accepted (the cap is two)");
  assert.ok(!only(validatePlan({ ...manyResearchers, steps: manyResearchers.steps.slice(0, 2) }, ctx({ writes: false })), "V5").length, "control: two researchers are fine");
  const wontFit = sliced(6); // 15 agents and nothing skippable to drop
  const w = validatePlan(wontFit, ctx());
  assert.ok(only(w, "V5").length === 1 && /cannot be made to fit|ask/i.test(only(w, "V5")[0].message), `a plan that cannot be shrunk should say so: ${JSON.stringify(only(w, "V5"))}`);
  console.log("[ok] V5: 13 agents over a cap of 12 are refused with the drop order that would fit; per-role caps hold; a plan nothing can shrink says to ask");
}

// 6. V6: acyclic, one root, no unknown or duplicate steps.
{
  const cyc = clone(example()); cyc.steps[1].after = ["s9"];
  assert.ok(only(validatePlan(cyc, ctx({ required: ["security-reviewer"] })), "V6").some((x) => /cycle/i.test(x.message)), "a cyclic plan was accepted");
  const selfDep = set(small(), "s3", { after: ["s3"] });
  assert.ok(only(validatePlan(selfDep, ctx()), "V6").length >= 1, "a step that waits for itself was accepted");
  const twoRoots = clone(small()); twoRoots.steps.splice(1, 0, { id: "r", role: "researcher", why: "a second root" });
  assert.ok(only(validatePlan(twoRoots, ctx()), "V6").some((x) => /root/i.test(x.message)), "a plan with two roots was accepted");
  const unknown = set(small(), "s3", { after: ["nope"] });
  assert.ok(only(validatePlan(unknown, ctx()), "V6").some((x) => /unknown/i.test(x.message)), "a dependency on an unknown step was accepted");
  const dup = clone(small()); dup.steps[1].id = "s1";
  assert.ok(only(validatePlan(dup, ctx()), "V6").some((x) => /duplicate/i.test(x.message)), "two steps with one id were accepted");
  const noSteps = { class: "x", size: "x", reason: "x", steps: [] };
  assert.ok(!validatePlan(noSteps, ctx({ writes: false })).ok, "an empty plan was accepted");
  assert.deepStrictEqual(executionOrder(small()), ["s1", "s2", "s3"], "control: the order of an ordinary plan");
  assert.strictEqual(executionOrder(cyc), undefined, "an order was invented for a cyclic plan");
  console.log("[ok] V6: a cycle, a step waiting for itself, two roots, an unknown dependency, a duplicate id and an empty plan are each refused");
}

// 7. V7 and the field list: a step cannot carry tools, a session, a model; a role definition cannot be both read-only and writing.
{
  for (const field of ["tools", "session", "model", "itemCap", "permissions"]) {
    const p = set(small(), "s1", { [field]: field === "tools" ? ["Write"] : "x" });
    assert.ok(only(validatePlan(p, ctx()), "FIELD").length === 1 || only(validatePlan(p, ctx()), "V7").length === 1, `a step carrying "${field}" was accepted`);
  }
  assert.ok(validatePlan(set(small(), "s1", { brief: "ok" }), ctx()).ok, "control: a brief is an ordinary field");
  const planWithCap = { ...small(), itemCap: 500 };
  assert.ok(only(validatePlan(planWithCap, ctx()), "FIELD").length === 1, "a plan that sets its own item cap was accepted");
  const bad = roster.map((r) => (r.id === "verifier" ? { ...r, writeScope: "slice" } : r));
  assert.ok(only(validatePlan(small(), ctx({ roster: bad })), "V7").length >= 1, "a verifier role with a write scope passed V7");
  console.log("[ok] V7: tools, a session, a model or an item cap on a step or plan are refused; a read-only role with a write scope is caught");
}

// 8. V8: slices own directory prefixes that cannot overlap; reserved files belong to the integrator; the diff is audited afterwards.
{
  const slices = (a, b) => { const p = clone(example()); p.steps[2].slice = { name: "api", paths: a }; p.steps[4].slice = { name: "ui", paths: b }; return p; };
  const req = ctx({ required: ["security-reviewer"] });
  assert.ok(validatePlan(slices(["src/api/**"], ["src/ui"]), req).ok, "control: disjoint slices, one written with a trailing /** and one bare");
  assert.ok(only(validatePlan(slices(["src/api"], ["src/api/v2"]), req), "V8").some((x) => /overlap/i.test(x.message)), "a slice inside another was accepted");
  assert.ok(only(validatePlan(slices(["src/API"], ["src/api"]), req), "V8").some((x) => /overlap/i.test(x.message)), "src/API and src/api were treated as different (a case-insensitive disk makes them one)");
  assert.ok(only(validatePlan(slices(["src/api/"], ["src//api"]), req), "V8").some((x) => /overlap/i.test(x.message)), "trailing and doubled slashes hid an overlap");
  assert.ok(only(validatePlan(slices(["src\\api"], ["src/api"]), req), "V8").some((x) => /overlap/i.test(x.message)), "a backslash path hid an overlap");
  for (const [what, bad] of [["a free-form glob", "src/**/*.ts"], ["a question mark", "src/a?i"], ["a parent segment", "../outside"], ["an absolute path", "/etc"], ["an empty path", ""], ["the whole repo", "."], ["a drive path", "C:\\work"]]) {
    assert.ok(only(validatePlan(slices([bad], ["src/ui"]), req), "V8").length >= 1, `${what} was accepted as a slice`);
  }
  for (const reserved of ["package.json", "dist", "build/out", "package-lock.json", "src/__snapshots__"]) {
    assert.ok(only(validatePlan(slices([reserved], ["src/ui"]), req), "V8").some((x) => /reserved/i.test(x.message)), `a slice claiming ${reserved} (reserved for the integrator) was accepted`);
  }
  const noIntegrator = without(slices(["src/api"], ["src/ui"]), "s7"); noIntegrator.steps.find((s) => s.id === "s8").after = ["s4", "s6"];
  assert.ok(only(validatePlan(noIntegrator, req), "V8").some((x) => /integrator/i.test(x.message)), "two slices with no integrator were accepted");
  const noSlice = clone(example()); delete noSlice.steps[2].slice;
  assert.ok(only(validatePlan(noSlice, req), "V8").some((x) => /slice/i.test(x.message)), "one of two builders had no slice");
  assert.ok(validatePlan(small(), ctx()).ok, "control: one builder needs no slice");
  console.log("[ok] V8: nested, case-folded, slash-disguised and backslash-disguised overlaps, six kinds of path that are not a directory prefix, reserved files, and a missing integrator are each refused");
}
if (process.platform !== "win32") {
  // real-path resolution: a symlink from one slice into another is one directory, whatever the names say
  const work = mkdtempSync(join(tmpdir(), "team-plan-"));
  mkdirSync(join(work, "src", "a"), { recursive: true });
  symlinkSync(join(work, "src", "a"), join(work, "src", "b"));
  mkdirSync(join(work, "src", "c"), { recursive: true });
  const p = clone(example()); p.steps[2].slice = { name: "a", paths: ["src/a"] }; p.steps[4].slice = { name: "b", paths: ["src/b"] };
  assert.ok(only(validatePlan(p, ctx({ required: ["security-reviewer"], workDir: work })), "V8").some((x) => /overlap/i.test(x.message)), "src/b is a link to src/a and the slices were accepted as disjoint");
  assert.ok(!only(validatePlan(p, ctx({ required: ["security-reviewer"] })), "V8").length, "control: without the directory to look at, the names alone are disjoint");
  p.steps[4].slice.paths = ["src/c"];
  assert.ok(validatePlan(p, ctx({ required: ["security-reviewer"], workDir: work })).ok, "control: with a real second directory the slices are disjoint");
  console.log("[ok] V8: a symlink from one slice into another is seen as the overlap it is");
}
{
  const slice = { name: "api", paths: ["src/api/**"] };
  assert.deepStrictEqual(auditDiffScope(["src/api/a.ts", "src/api/deep/b.ts"], slice), { ok: true, outside: [] }, "control: files inside the slice");
  const r = auditDiffScope(["src/api/a.ts", "src/ui/x.ts", "package.json", "src/api2/y.ts", "SRC/API/ok.ts", "../outside.txt", "/etc/passwd", "src/api/../ui/z.ts"], slice);
  assert.deepStrictEqual(r.outside.sort(), ["../outside.txt", "/etc/passwd", "package.json", "src/api/../ui/z.ts", "src/api2/y.ts", "src/ui/x.ts"].sort(), `the diff-scope audit let through: ${JSON.stringify(r)}`);
  assert.ok(!r.ok);
  assert.ok(!auditDiffScope(["src/api/a.ts"], slice, { allowShared: false }).outside.length, "control: nothing outside");
  const gen = auditDiffScope(["src/api/dist/bundle.js", "src/api/__snapshots__/a.snap", "src/api/ok.ts"], slice);
  assert.deepStrictEqual(gen.outside, ["src/api/dist/bundle.js", "src/api/__snapshots__/a.snap"], `a build that regenerates dist/ or snapshots inside the slice was let through: ${JSON.stringify(gen)}`);
  assert.deepStrictEqual(auditDiffScope(["package.json", "dist/x.js"], { name: "int", paths: [] }, { integrator: true }), { ok: true, outside: [] }, "the integrator owns the shared files");
  console.log("[ok] V8: the diff-scope audit names every changed path outside the slice (sibling prefixes, parent segments, absolute paths, reserved files) and lets the integrator own the shared files");
}

// 9. V10: an agent cannot create a step. Only the composer and the Overseer's append do.
{
  const forged = set(small(), "s1", { origin: "agent" });
  assert.ok(only(validatePlan(forged, ctx()), "V10").length === 1, "a step created by an agent was accepted");
  assert.ok(validatePlan(set(small(), "s1", { origin: "composer" }), ctx()).ok, "control: composer origin is fine");
  const overseerNoReason = set(small(), "s1", { origin: "overseer" });
  assert.ok(only(validatePlan(overseerNoReason, ctx()), "V10").length === 1, "an overseer-origin step with no stored reason was accepted");
  assert.ok(validatePlan(set(small(), "s1", { origin: "overseer", appendedReason: "a finding called for it" }), ctx()).ok, "control: overseer origin with a reason is fine");
  console.log("[ok] V10: only the composer and the Overseer (with a stored reason) create steps");
}

// 10. V11: the Overseer may append at most four steps, each with a reason, each passing V1 to V10.
{
  const base = example();
  const req = ctx({ required: ["security-reviewer"] });
  const one = appendSteps(base, [{ id: "a1", role: "perf-reviewer", after: ["s8"], why: "the verifier found a slow path" }], "verifier s4 reported a slow query", req);
  assert.ok(one.plan && one.validation.violations.length === 0, `a valid append was refused: ${JSON.stringify(one.validation.violations)}`);
  const added = one.plan.steps.find((s) => s.id === "a1");
  assert.ok(added.origin === "overseer" && added.appendedReason === "verifier s4 reported a slow query", "the append did not store its origin and reason");
  assert.ok(!base.steps.some((s) => s.id === "a1"), "appendSteps changed the plan it was given");
  // gatekeeper must still be last: append before it by re-pointing is the overseer's job; a step after the gate is refused (V2)
  const afterGate = appendSteps(base, [{ id: "a1", role: "researcher", after: ["s9"], why: "x" }], "reason", req);
  assert.ok(!afterGate.plan && only(afterGate.validation, "V2").length >= 1, "an append after the gatekeeper was accepted");
  const noReason = appendSteps(base, [{ id: "a1", role: "perf-reviewer", after: ["s8"], why: "slow" }], "", req);
  assert.ok(!noReason.plan && only(noReason.validation, "V11").length === 1, "an append with no reason was accepted");
  const unknownRole = appendSteps(base, [{ id: "a1", role: "wizard", after: ["s8"], why: "x" }], "r", req);
  assert.ok(!unknownRole.plan && only(unknownRole.validation, "V1").length === 1, "an appended step with an unknown role was accepted (V1 applies to appends)");
  const fakeVerifier = appendSteps(base, [{ id: "a1", role: "verifier", checks: "a1", after: ["s8"], why: "x" }], "r", req);
  assert.ok(!fakeVerifier.plan, "an appended verifier that checks itself was accepted");
  // four are allowed, the fifth is not, counted across appends; each is inserted before the gatekeeper, which stays last
  const bigCtx = ctx({ required: ["security-reviewer"], cap: 20 });
  const roles = ["advisor", "advisor", "advisor", "researcher"];
  let cur = base;
  for (let i = 0; i < 4; i++) {
    const r = appendSteps(cur, [{ id: `a${i + 1}`, role: roles[i], after: [i === 0 ? "s8" : `a${i}`], why: "more advice or reading" }], `reason ${i + 1}`, bigCtx);
    assert.ok(r.plan, `append ${i + 1} of 4 was refused: ${JSON.stringify(r.validation.violations)}`);
    cur = r.plan;
  }
  assert.strictEqual(cur.steps.filter((s) => s.origin === "overseer").length, 4);
  assert.strictEqual(validatePlan(cur, bigCtx).order.at(-1), "s9", "the gatekeeper is no longer last after four appends");
  const fifth = appendSteps(cur, [{ id: "a5", role: "a11y-reviewer", after: ["a4"], why: "x" }], "reason 5", bigCtx);
  assert.ok(!fifth.plan && only(fifth.validation, "V11").some((x) => /4/.test(x.message)), `a fifth appended step was accepted: ${JSON.stringify(fifth.validation.violations)}`);
  console.log("[ok] V11: an append stores its origin and reason, passes V1 to V10 like any step, never changes the plan it was given, and stops at four");
}

// 11. V12: never-skippable roles cannot be skipped; others only when the plan marks them, with a stored reason.
{
  const req = ctx({ required: ["security-reviewer"] });
  const plan = set(example(), "s1", { skippable: true });
  for (const id of ["s3", "s4", "s9"]) {
    const r = skipStep(plan, id, "the Overseer thinks it is fine", req);
    assert.ok(!r.plan && r.violations.some((x) => x.rule === "V12"), `${id} (${plan.steps.find((s) => s.id === id).role}) was skipped`);
  }
  const marked = skipStep(plan, "s1", "the planner already knows the library", req);
  assert.ok(marked.plan && !marked.plan.steps.some((s) => s.id === "s1") && marked.skipped?.reason === "the planner already knows the library", `a marked skippable role was not skipped: ${JSON.stringify(marked.violations)}`);
  assert.ok(marked.plan.steps.find((s) => s.id === "s2").after === undefined || !marked.plan.steps.find((s) => s.id === "s2").after.includes("s1"), "the skipped step is still waited for");
  const notMarked = skipStep(example(), "s1", "reason", req);
  assert.ok(!notMarked.plan && notMarked.violations.some((x) => /mark/i.test(x.message)), "a skippable role the plan did not mark was skipped");
  const noReason = skipStep(plan, "s1", "  ", req);
  assert.ok(!noReason.plan && noReason.violations.some((x) => /reason/i.test(x.message)), "a skip with no reason was accepted");
  const mandatory = set(example(), "s8", { skippable: true });
  const mand = skipStep(mandatory, "s8", "no need", req);
  assert.ok(!mand.plan && mand.violations.some((x) => x.rule === "V12" && /mandatory/.test(x.message)), `a mandatory-by-signal reviewer was skipped, or refused only because the result failed V4: ${JSON.stringify(mand.violations)}`);
  // the never-skippable list stands on its own: a roster that (wrongly) calls the builder skippable does not make it so
  const lax = roster.map((r) => (r.id === "builder" || r.id === "verifier" || r.id === "gatekeeper" ? { ...r, skippable: "yes" } : r));
  for (const id of ["s3", "s4", "s9"]) {
    const r = skipStep(set(set(set(plan, "s3", { skippable: true }), "s4", { skippable: true }), "s9", { skippable: true }), id, "reason", ctx({ roster: lax, required: ["security-reviewer"] }));
    assert.ok(!r.plan && r.violations.some((x) => x.rule === "V12" && /never be skipped/.test(x.message)), `${id}: the never-skippable list did not hold against a lax roster: ${JSON.stringify(r.violations)}`);
  }
  assert.ok(skipStep(mandatory, "s8", "no need", ctx()).plan, "control: the same step can be skipped when no signal made it mandatory");
  assert.ok(!skipStep(plan, "zz", "r", req).plan, "a skip of a step that does not exist was accepted");
  console.log("[ok] V12: builder, verifier and gatekeeper cannot be skipped; a marked skippable role can, with a reason, and the plan closes up; a mandatory reviewer cannot");
}

// 12. V15: a foreach over items: bounded by a cap the composer cannot set, exempt from per-role and total caps, not from the rest.
{
  const items = (n, over = {}) => {
    const steps = [{ id: "p", role: "planner", why: "plan once" }];
    for (let i = 1; i <= n; i++) {
      steps.push({ id: `b${i}`, role: "builder", item: `job-${i}`, after: ["p"], why: `apply to job ${i}`, ...(over.builder ?? {}) });
      steps.push({ id: `v${i}`, role: "verifier", item: `job-${i}`, checks: `b${i}`, why: `check job ${i}`, ...(over.verifier ?? {}) });
    }
    steps.push({ id: "g", role: "gatekeeper", after: [`v${n}`], why: "final gate" });
    return { class: "foreach", size: "large", reason: "job applications", steps };
  };
  assert.ok(validatePlan(items(3), ctx()).ok, `control: three items: ${JSON.stringify(validatePlan(items(3), ctx()).violations)}`);
  assert.ok(validatePlan(items(30), ctx()).ok, "30 items (62 agents) are within the item cap: per-role and total caps do not apply to a step per item");
  const v31 = validatePlan(items(31), ctx());
  assert.ok(only(v31, "V15").length === 1 && /30/.test(only(v31, "V15")[0].message), `31 items were accepted: ${JSON.stringify(v31.violations)}`);
  assert.ok(validatePlan(items(31), ctx({ itemCap: 40 })).ok, "control: the cap is the user's configuration, and 40 allows 31");
  assert.ok(!validatePlan(items(3, {}), ctx({ itemCap: 2 })).ok, "a user cap of 2 did not stop 3 items");
  assert.ok(only(validatePlan({ ...items(3), itemCap: 500 }, ctx()), "FIELD").length === 1, "the composer set its own item cap");
  assert.ok(only(validatePlan(items(3, { builder: { role: "wizard" } }), ctx()), "V1").length >= 1, "V1 did not apply to item steps");
  assert.ok(only(validatePlan(items(3, { builder: { tools: ["Write"] } }), ctx()), "FIELD").length >= 1, "V7 did not apply to item steps");
  assert.ok(only(validatePlan(items(3, { builder: { origin: "agent" } }), ctx()), "V10").length >= 1, "V10 did not apply to item steps");
  const noVerifier = items(3); noVerifier.steps = noVerifier.steps.filter((s) => s.id !== "v2"); noVerifier.steps.find((s) => s.id === "g").after = ["v3"];
  assert.ok(only(validatePlan(noVerifier, ctx()), "V2").some((x) => /job-2/.test(x.message)), "an item with a builder and no verifier was accepted");
  const itemsMarkedSkippable = items(3, { verifier: { skippable: true } });
  assert.ok(!skipStep(itemsMarkedSkippable, "v1", "r", ctx()).plan, "V12 did not apply to item steps");
  console.log("[ok] V15: 30 items pass, 31 are refused, the user's cap is the only cap, and V1, V2, V7, V10 and V12 still apply to every item");
}

// 13. Garbage in, a clean refusal out.
{
  for (const junk of [null, undefined, 7, "plan", [], { steps: "no" }, { steps: [null] }, { steps: [7] }, { steps: [{}] }, { class: "x", size: "y", reason: "z", steps: [{ id: "__proto__", role: "builder", why: "x" }] }]) {
    const v = validatePlan(junk, ctx());
    assert.ok(!v.ok && v.violations.length >= 1, `junk ${JSON.stringify(junk)?.slice(0, 40)} was accepted or crashed`);
  }
  // ids: an otherwise valid plan with an odd id is refused for the id, not for something else
  const rename = (from, to) => JSON.parse(JSON.stringify(small()).split(`"${from}"`).join(JSON.stringify(to)));
  for (const odd of ["S1", "has space", "x".repeat(40), "__proto__", "a.b", "1abc", "s1\n"]) {
    assert.ok(only(validatePlan(rename("s1", odd), ctx()), "ID").length === 1, `an odd id ${JSON.stringify(odd)} was not refused as an id`);
  }
  assert.ok(validatePlan(rename("s1", "step_1-a"), ctx()).ok, "control: letters, digits, dash and underscore are fine in an id");
  const at501 = { class: "x", size: "y", reason: "z", steps: Array.from({ length: 501 }, (_, i) => ({ id: `s${i}`, role: "researcher", why: "x" })) };
  assert.ok(only(validatePlan(at501, ctx({ writes: false })), "SIZE").length === 1, "a 501-step plan was not refused as too big");
  const at500 = { class: "x", size: "y", reason: "z", steps: [{ id: "s0", role: "researcher", why: "x" }, ...Array.from({ length: 10 }, (_, i) => ({ id: `s${i + 1}`, role: "builder", item: `i${i}`, after: ["s0"], why: "x" }))] };
  assert.ok(!only(validatePlan(at500, ctx({ writes: false, itemCap: 50 })), "SIZE").length, "control: a short plan is not too big");
  const huge = { class: "x", size: "y", reason: "z", steps: Array.from({ length: 5000 }, (_, i) => ({ id: `s${i}`, role: "researcher", why: "x" })) };
  const t0 = Date.now(); const hv = validatePlan(huge, ctx({ writes: false }));
  assert.ok(!hv.ok && Date.now() - t0 < 2000, `a 5,000-step plan took ${Date.now() - t0} ms or was accepted`);
  const longText = clone(small()); longText.steps[0].why = "x".repeat(100_000);
  assert.ok(JSON.stringify(validatePlan(longText, ctx())).length < 5000, "a 100 KB reason came back in a refusal");
  console.log("[ok] junk, prototype-looking ids, a 5,000-step plan and a 100 KB reason each get a clean, bounded refusal");
}
// 13. Text in a refusal never carries control bytes, C0 or C1 (U+0080 to U+009F): a role name, an id or a reason is whatever a proposer typed.
{
  const bad = clone(small());
  bad.steps[0].role = "ghost\u001b[2J\u009b2J\u0007";
  bad.steps[1].why = "ok\u009b";
  bad.steps[2].id = "g\u009b";
  const v = validatePlan(bad, ctx());
  assert.ok(!v.ok && v.violations.length > 0, "control: the plan with a made-up role is refused");
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(v.violations.map((x) => `${x.rule}${x.step ?? ""}${x.message}`).join("")), "a control byte from the proposal came back in a refusal");
  console.log("[ok] a role name, a reason and an id full of C0 and C1 control bytes are refused without echoing any of them");
}
console.log("\nALL TEAM PLAN TESTS PASSED");
