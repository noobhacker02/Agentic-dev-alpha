// Does the team plan validator say yes to a good plan and no, for the right rule, to a plan broken in exactly one way? 500 generated cases from a seeded generator that is
// written independently of the validator: valid plans of many shapes (no slices, up to four, a foreach over items, optional roles) and, for each valid plan, mutants that break
// one rule (V1 to V8, V10 to V12, V15; V9 belongs to the usage governor). A mutant counts only if the validator names the rule the mutation breaks.
// The scorer takes the validator as a parameter so test/bench-suites.mjs can feed it a lenient one, a strict one and a wrong-rule one and require each to score badly.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../lib.mjs";

export const meta = {
  id: "team-invariants",
  title: "Generated team plans: valid accepted, every invalid one rejected for the right rule (V1 to V8, V10 to V12, V15)",
  unit: "of 500",
  higherIsBetter: true,
  stage: "S3a",
};

/** A small seeded generator (mulberry32): the same cases every run. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const DIRS = ["api", "ui", "db", "worker", "cli", "report", "search", "mail", "queue", "cache"];
const OPTIONAL = [["researcher", "reading first"], ["advisor", "a second opinion"], ["docs-writer", "public docs"], ["perf-reviewer", "performance goal"], ["a11y-reviewer", "UI changed"]];

/** One valid plan and the context it is valid under. */
function validCase(rand) {
  let slices = Math.floor(rand() * 5); // 0 to 4
  const foreach = rand() < 0.15;
  const required = rand() < 0.3 ? ["security-reviewer"] : [];
  const researcher = rand() < 0.3;
  // keep the plan within the cap of 12 including the gatekeeper, the integrator and a mandatory reviewer: four slices leave room for neither a researcher nor a reviewer
  if (researcher || required.length) slices = Math.min(slices, 3);
  const steps = [];
  const add = (s) => { steps.push({ id: `s${steps.length + 1}`, ...s }); return steps[steps.length - 1].id; };
  let last;
  if (researcher) last = add({ role: "researcher", why: "read first" });
  if (slices >= 2 || rand() < 0.6) last = add({ role: "planner", ...(last ? { after: [last] } : {}), why: "plan" });
  if (foreach) {
    const n = 1 + Math.floor(rand() * 30);
    const planner = last ?? add({ role: "planner", why: "plan once" });
    let lastV;
    for (let i = 1; i <= n; i++) {
      const b = add({ role: "builder", item: `item-${i}`, after: [planner], why: `work on item ${i}` });
      lastV = add({ role: "verifier", item: `item-${i}`, checks: b, why: `check item ${i}` });
    }
    add({ role: "gatekeeper", after: [lastV], why: "final gate" });
    return { plan: { class: "foreach", size: "large", reason: "items", steps }, ctx: { writes: true, required: [], cap: 12, itemCap: 30 } };
  }
  const dirs = [...DIRS].sort(() => rand() - 0.5).slice(0, slices);
  const tails = [];
  if (slices >= 2) {
    dirs.forEach((d, i) => { const b = add({ role: "builder", slice: { name: d, paths: [`src/${d}${rand() < 0.5 ? "/**" : ""}`] }, ...(last ? { after: [last] } : {}), why: `slice ${i + 1}` }); tails.push(add({ role: "verifier", checks: b, why: `check slice ${i + 1}` })); });
    last = add({ role: "integrator", after: tails, why: "join" });
  } else {
    const b = add({ role: "builder", ...(slices === 1 ? { slice: { name: dirs[0], paths: [`src/${dirs[0]}`] } } : {}), ...(last ? { after: [last] } : {}), why: "the change" });
    last = add({ role: "verifier", checks: b, why: "check" });
  }
  for (const r of required) last = add({ role: r, after: [last], why: "mandatory by signal" });
  const room = 12 - steps.length - 1;
  for (const [role, why] of OPTIONAL.filter(() => rand() < 0.3).slice(0, Math.max(0, room))) last = add({ role, after: [last], skippable: true, why });
  add({ role: "gatekeeper", after: [last], why: "final gate" });
  return { plan: { class: "feature", size: "medium", reason: "generated", steps }, ctx: { writes: true, required, cap: 12, itemCap: 30 } };
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const byRole = (p, role) => p.steps.filter((s) => s.role === role);
/** Each mutation breaks exactly one rule and says which. A mutation that does not apply to a plan returns undefined. */
const MUTATIONS = [
  ["V1", (p) => { p.steps[p.steps.length - 1].role = "wizard"; return p; }],
  ["WHY", (p) => { p.steps[0].why = "  "; return p; }],
  ["V2", (p) => { const g = byRole(p, "gatekeeper")[0]; p.steps = p.steps.filter((s) => s !== g); return p.steps.some((s) => s.after?.includes(g.id)) ? undefined : p; }],
  ["V2", (p) => { const v = byRole(p, "verifier")[0]; const rest = p.steps.filter((s) => s !== v); if (rest.some((s) => s.after?.includes(v.id))) { for (const s of rest) if (s.after?.includes(v.id)) s.after = s.after.filter((x) => x !== v.id).concat(v.checks); } p.steps = rest; return p; }],
  ["V2", (p) => { p.steps.push({ id: "tail", role: "researcher", after: [byRole(p, "gatekeeper")[0].id], why: "after the gate" }); return p; }],
  ["V3", (p) => { const v = byRole(p, "verifier")[0]; v.checks = v.id; return p; }],
  ["V3", (p) => { const v = byRole(p, "verifier")[0]; delete v.checks; return p; }],
  ["V4", (p, c) => { const r = c.required[0]; if (!r) return undefined; const s = byRole(p, r)[0]; for (const o of p.steps) if (o.after?.includes(s.id)) o.after = o.after.filter((x) => x !== s.id).concat(s.after); p.steps = p.steps.filter((x) => x !== s); return p; }],
  ["V5", (p) => { if (p.steps.some((s) => s.item)) return undefined; const last = p.steps.filter((s) => s.role !== "gatekeeper").pop(); for (let i = 0; i < 3; i++) p.steps.splice(p.steps.length - 1, 0, { id: `x${i}`, role: "researcher", after: [i ? `x${i - 1}` : last.id], why: "extra" }); const g = byRole(p, "gatekeeper")[0]; g.after = ["x2"]; return p; }],
  ["V6", (p) => { p.steps[0].after = [p.steps[p.steps.length - 1].id]; return p; }],
  ["V6", (p) => { p.steps.splice(1, 0, { id: "root2", role: "researcher", why: "another root" }); return p; }],
  ["V6", (p) => { p.steps[p.steps.length - 1].after = ["nowhere"]; return p; }],
  ["V8", (p) => { const b = p.steps.filter((s) => s.slice); if (b.length < 2) return undefined; b[1].slice.paths = [`${b[0].slice.paths[0].replace(/\/\*\*$/, "")}/deeper`]; return p; }],
  ["V8", (p) => { const b = p.steps.filter((s) => s.slice); if (b.length < 2) return undefined; b[1].slice.paths = [b[0].slice.paths[0].replace(/\/\*\*$/, "").toUpperCase()]; return p; }],
  ["V8", (p) => { const b = p.steps.filter((s) => s.slice); if (!b.length) return undefined; b[0].slice.paths = ["dist"]; return p; }],
  ["V8", (p) => { const b = p.steps.filter((s) => s.slice); if (!b.length) return undefined; b[0].slice.paths = ["src/**/*.ts"]; return p; }],
  ["V8", (p) => { const i = p.steps.findIndex((s) => s.role === "integrator"); if (i < 0) return undefined; const id = p.steps[i].id; const after = p.steps[i].after; p.steps.splice(i, 1); for (const s of p.steps) if (s.after?.includes(id)) s.after = [...new Set(s.after.filter((x) => x !== id).concat(after))]; return p; }],
  ["V10", (p) => { p.steps[0].origin = "agent"; return p; }],
  ["V10", (p) => { p.steps[0].origin = "overseer"; return p; }],
  ["V15", (p) => { if (!p.steps.some((s) => s.item)) return undefined; const n = new Set(p.steps.filter((s) => s.item).map((s) => s.item)).size; const base = p.steps.find((s) => s.role === "planner").id; const g = byRole(p, "gatekeeper")[0]; for (let i = n + 1; i <= 31; i++) { const b = `xb${i}`; p.steps.splice(p.steps.length - 1, 0, { id: b, role: "builder", item: `item-${i}`, after: [base], why: "more" }, { id: `xv${i}`, role: "verifier", item: `item-${i}`, checks: b, why: "more" }); } g.after = [p.steps[p.steps.length - 2].id]; return p; }],
  ["FIELD", (p) => { p.steps[0].tools = ["Write"]; return p; }],
  ["FIELD", (p) => { p.itemCap = 9999; return p; }],
];

/** The cases: `n` of them, about a fifth valid. */
export function generate(n = 500, seed = 20261003) {
  const rand = rng(seed);
  const cases = [];
  let guard = 0;
  while (cases.length < n && guard++ < n * 20) {
    const { plan, ctx } = validCase(rand);
    if (cases.length % 5 === 0) { cases.push({ kind: "valid", plan, ctx }); continue; }
    const [rule, mutate] = MUTATIONS[Math.floor(rand() * MUTATIONS.length)];
    const mutant = mutate(clone(plan), ctx);
    if (mutant) cases.push({ kind: "mutant", expect: rule, plan: mutant, ctx });
  }
  return cases;
}

/** How many cases a validator gets right, and which kinds it misses. `validate(plan, ctx)` returns { ok, violations: [{ rule }] }. */
export function scoreWith(validate, cases) {
  let right = 0;
  const wrong = {};
  for (const c of cases) {
    let v;
    try { v = validate(c.plan, c.ctx); } catch { v = { ok: true, violations: [] }; } // a crash is not a refusal
    const good = c.kind === "valid" ? v.ok === true && v.violations.length === 0 : v.ok === false && v.violations.some((x) => x.rule === c.expect);
    if (good) right += 1; else wrong[c.kind === "valid" ? "valid-refused" : c.expect] = (wrong[c.kind === "valid" ? "valid-refused" : c.expect] ?? 0) + 1;
  }
  return { right, total: cases.length, wrong };
}

export async function run() {
  const { validatePlan } = await import(pathToFileURL(join(ROOT, "dist/team/plan.js")).href);
  const { BUILTIN_ROSTER } = await import(pathToFileURL(join(ROOT, "dist/team/roster.js")).href);
  const cases = generate(500);
  const { right, total, wrong } = scoreWith((plan, ctx) => validatePlan(plan, { roster: BUILTIN_ROSTER, ...ctx }), cases);
  return { value: right, max: total, detail: { valid: cases.filter((c) => c.kind === "valid").length, mutants: cases.filter((c) => c.kind === "mutant").length, wrong } };
}
