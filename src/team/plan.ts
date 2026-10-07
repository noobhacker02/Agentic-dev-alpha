// The team plan and what code enforces about it (docs/TEAM-COMPOSITION.md, "What code enforces"). A plan is data a model proposes; this file is the floor under it.
// Nothing here trusts the proposer: every field is checked, unknown fields are refused, text in a refusal is cut short, and a plan that is not an object, is huge, or has
// strange ids gets a clean "no". V9 (the usage budget) comes with the governor; V13 is the roster's; V14 (the post-build re-check) is in signals.ts.
import { isAbsolute, join, relative } from "node:path";
import { canonicalPath } from "../hooks.js";
import { NEVER_SKIPPABLE, isReadOnly, type RoleDef, type RoleKind } from "./roster.js";

export const DEFAULT_CAP = 12;
export const DEFAULT_ITEM_CAP = 30;
export const MAX_APPENDED = 4;
const MAX_STEPS = 500;

export interface TeamStep {
  id: string;
  role: string;
  why: string;
  after?: string[];
  /** A verifier names the step it checks. */
  checks?: string;
  brief?: string;
  slice?: { name: string; paths: string[] };
  /** The item of a foreach (a job id, a file): steps with an item are bounded by the item cap, not by the per-role caps. */
  item?: string;
  /** The plan marks this step as one that may be skipped. */
  skippable?: boolean;
  /** Who created the step: the composer, or the Overseer's append (never an agent). */
  origin?: string;
  appendedReason?: string;
}
export interface TeamPlan {
  class: string;
  size: string;
  reason: string;
  steps: TeamStep[];
}
export interface Violation {
  rule: string;
  step?: string;
  message: string;
}
export interface ValidationContext {
  roster: RoleDef[];
  /** Whether the task writes or acts, decided by code (V14), not by the composer. A plan with a builder writes whatever this says. */
  writes: boolean;
  /** Roles the signals made mandatory (V4). */
  required?: string[];
  /** Total agents outside a foreach (V5). */
  cap?: number;
  /** Items in a foreach (V15): the user's configuration, never the plan's. */
  itemCap?: number;
  /** The project directory, for resolving slice paths through links (V8). */
  workDir?: string;
}
export interface Validation {
  ok: boolean;
  violations: Violation[];
  /** The stable topological execution order; empty when the plan has no valid order. */
  order: string[];
  /** When the plan is over the cap: step ids to drop, in the order that would make it fit. */
  dropOrder?: string[];
}

const clip = (s: unknown, n = 60): string => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, n);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const ID_RE = /^[a-z][a-z0-9_-]{0,30}$/;
const PLAN_FIELDS = new Set(["class", "size", "reason", "steps"]);
const STEP_FIELDS = new Set(["id", "role", "why", "after", "checks", "brief", "slice", "item", "skippable", "origin", "appendedReason"]);
const READ_ONLY_KINDS: RoleKind[] = ["read", "advise", "check", "gate", "meta", "monitor"];
/** Roles dropped first when a plan is over the cap, cheapest first. Planner, integrator and the floor are never in it. */
const DROP_ORDER = ["docs-writer", "a11y-reviewer", "perf-reviewer", "ui-tester", "desktop-tester", "adversary", "researcher", "advisor", "test-designer"];
const RESERVED_NAMES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "requirements.txt", "poetry.lock", "pyproject.toml", "cargo.toml", "cargo.lock",
  "go.mod", "go.sum", "gemfile.lock", "composer.lock",
]);
const RESERVED_DIRS = new Set(["dist", "build", "out", "coverage", ".git", "node_modules", "__snapshots__", "snapshots"]);

interface Parsed {
  steps: TeamStep[];
  deps: Map<string, string[]>;
}

/** The stable topological order: among the steps whose dependencies are done, the one that comes first in the plan. Undefined for a cycle. */
function topoOrder(ids: string[], deps: Map<string, string[]>): string[] | undefined {
  const done = new Set<string>();
  const order: string[] = [];
  while (order.length < ids.length) {
    const next = ids.find((id) => !done.has(id) && (deps.get(id) ?? []).every((d) => done.has(d)));
    if (next === undefined) return undefined;
    done.add(next);
    order.push(next);
  }
  return order;
}

export function executionOrder(plan: unknown): string[] | undefined {
  if (!isObj(plan) || !Array.isArray(plan.steps) || plan.steps.length > MAX_STEPS) return undefined;
  const ids: string[] = [], deps = new Map<string, string[]>();
  for (const s of plan.steps) {
    if (!isObj(s) || typeof s.id !== "string" || deps.has(s.id)) return undefined;
    ids.push(s.id);
    deps.set(s.id, [...(Array.isArray(s.after) ? s.after.filter((x): x is string => typeof x === "string") : []), ...(typeof s.checks === "string" ? [s.checks] : [])]);
  }
  for (const d of deps.values()) if (d.some((x) => !deps.has(x))) return undefined;
  return topoOrder(ids, deps);
}

type PrefixResult = { prefix: string } | { error: string };

/** A slice path as a directory prefix: slashes folded, a trailing /** or /* removed, nothing free-form, nothing that leaves the project. Folded to lower case and NFC. */
export function slicePrefix(raw: unknown): PrefixResult {
  if (typeof raw !== "string") return { error: "a slice path must be text" };
  let p = raw.trim().replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(p)) return { error: `"${clip(raw)}" is a drive path, not a directory inside the project` };
  if (p.startsWith("/")) return { error: `"${clip(raw)}" is an absolute path, not a directory inside the project` };
  p = p.replace(/\/\*\*?$/, "");
  const segs = p.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.some((s) => s === "..")) return { error: `"${clip(raw)}" leaves the project with ..` };
  if (/[*?[\]{}!]/.test(segs.join("/"))) return { error: `"${clip(raw)}" is a free-form glob: a slice owns a directory prefix, such as src/api` };
  if (!segs.length) return { error: `"${clip(raw)}" is empty or the whole project: a slice owns one directory` };
  return { prefix: segs.join("/").normalize("NFC").toLowerCase() };
}

export function reservedReason(prefix: string): string | undefined {
  const segs = prefix.split("/");
  if (RESERVED_NAMES.has(segs[segs.length - 1])) return segs[segs.length - 1];
  const dir = segs.find((s) => RESERVED_DIRS.has(s));
  return dir;
}

/** A path inside the project as the scope rules read it: slashes folded, links resolved when there is a project directory, relative to it, lower case, NFC. Undefined for anything that is not a plain
 * relative path inside the project (absolute, a drive, `..`, empty, or a link that leads out). The one place V8's diff audit and the write-scope hook agree on what "inside" means. */
export function scopeTarget(raw: string, workDir?: string): string | undefined {
  const p = String(raw).trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const segs = p.split("/").filter((x) => x !== "" && x !== ".");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p) || segs.includes("..") || !segs.length) return undefined;
  let target = segs.join("/").normalize("NFC").toLowerCase();
  if (workDir) {
    const real = canonicalPath(join(workDir, p), workDir);
    const root = canonicalPath(workDir, workDir);
    if (real !== undefined && root !== undefined) {
      const rel = relative(root, real).replace(/\\/g, "/");
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
      target = rel.normalize("NFC").toLowerCase();
    }
  }
  return target;
}

/** Whether a scope target is one of the prefixes or below one (a sibling that merely shares a name prefix is not). */
export const insidePrefixes = (target: string, prefixes: string[]): boolean => prefixes.some((x) => target === x || target.startsWith(`${x}/`));

/** The prefixes of a slice, as the audit compares them: valid ones only, links resolved when there is a project directory. */
export function slicePrefixes(slice: { name: string; paths: string[] }, workDir?: string): string[] {
  return slice.paths.map((p) => slicePrefix(p)).flatMap((r) => ("prefix" in r ? [(realPrefix(r.prefix, workDir) as { prefix: string }).prefix] : []));
}

/** The prefix after resolving links in the project directory (when there is one), relative to it. */
function realPrefix(prefix: string, workDir: string | undefined): PrefixResult {
  if (!workDir) return { prefix };
  const root = canonicalPath(workDir, workDir);
  const real = canonicalPath(join(workDir, prefix), workDir);
  if (root === undefined || real === undefined) return { error: `"${clip(prefix)}" could not be resolved on disk` };
  const rel = relative(root, real).replace(/\\/g, "/");
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { error: `"${clip(prefix)}" resolves outside the project or to all of it` };
  return { prefix: rel.normalize("NFC").toLowerCase() };
}

const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

export function validatePlan(input: unknown, ctx: ValidationContext): Validation {
  const violations: Violation[] = [];
  const add = (rule: string, message: string, step?: string): void => { violations.push({ rule, message: clip(message, 220), ...(step !== undefined ? { step: clip(step, 40) } : {}) }); };
  const finish = (ord: string[] | undefined, drop?: string[]): Validation => ({ ok: violations.length === 0, violations, order: ord ?? [], ...(drop ? { dropOrder: drop } : {}) });
  const roleOf = new Map(ctx.roster.map((r) => [r.id, r]));
  const cap = ctx.cap ?? DEFAULT_CAP;
  const itemCap = ctx.itemCap ?? DEFAULT_ITEM_CAP;

  if (!isObj(input)) { add("SHAPE", "the plan is not an object"); return finish(undefined); }
  for (const k of Object.keys(input)) if (!PLAN_FIELDS.has(k)) add("FIELD", `the plan has a field the composer may not set: "${clip(k, 30)}"`);
  for (const k of ["class", "size", "reason"]) if (typeof input[k] !== "string") add("SHAPE", `the plan needs a text "${k}"`);
  if (!Array.isArray(input.steps)) { add("SHAPE", "the plan needs a list of steps"); return finish(undefined); }
  if (input.steps.length === 0) { add("SHAPE", "the plan has no steps"); return finish(undefined); }
  if (input.steps.length > MAX_STEPS) { add("SIZE", `the plan has ${input.steps.length} steps; the most that is read is ${MAX_STEPS}`); return finish(undefined); }

  // Each step on its own: shape, fields, id, role (V1), reason, origin (V10).
  const steps: TeamStep[] = [];
  const seen = new Set<string>();
  input.steps.forEach((raw, i) => {
    if (!isObj(raw)) { add("SHAPE", `step number ${i + 1} is not an object`); return; }
    const id = typeof raw.id === "string" ? raw.id : "";
    const label = id || `#${i + 1}`;
    if (!ID_RE.test(id)) { add("ID", `step number ${i + 1} has an id that is not lowercase letters, digits, dash or underscore`, label); return; }
    if (seen.has(id)) add("V6", `duplicate step id "${id}"`, id);
    seen.add(id);
    for (const k of Object.keys(raw)) if (!STEP_FIELDS.has(k)) add("FIELD", `step ${id} carries "${clip(k, 30)}": tools, sessions and models come from the roster, not from the plan`, id);
    if (typeof raw.role !== "string" || !roleOf.has(raw.role)) add("V1", `step ${id} has the role "${clip(raw.role, 40)}", which is not on the roster`, id);
    if (typeof raw.why !== "string" || !raw.why.trim()) add("WHY", `step ${id} has no reason: every agent has to pay for itself in words`, id);
    if (raw.after !== undefined && (!Array.isArray(raw.after) || !raw.after.every((x) => typeof x === "string"))) add("SHAPE", `step ${id}: "after" must be a list of step ids`, id);
    if (raw.checks !== undefined && typeof raw.checks !== "string") add("SHAPE", `step ${id}: "checks" must be a step id`, id);
    if (raw.item !== undefined && (typeof raw.item !== "string" || !raw.item.trim() || raw.item.length > 80)) add("SHAPE", `step ${id}: "item" must be short text`, id);
    if (raw.skippable !== undefined && typeof raw.skippable !== "boolean") add("SHAPE", `step ${id}: "skippable" must be true or false`, id);
    const origin = raw.origin ?? "composer";
    if (origin !== "composer" && origin !== "overseer") add("V10", `step ${id} says it was created by "${clip(origin, 30)}": only the composer and the Overseer's append create steps`, id);
    if (origin === "overseer" && !(typeof raw.appendedReason === "string" && raw.appendedReason.trim())) add("V10", `step ${id} was appended without a stored reason`, id);
    steps.push(raw as unknown as TeamStep);
  });

  const parsed: Parsed = { steps, deps: new Map() };
  for (const s of steps) parsed.deps.set(s.id, [...(Array.isArray(s.after) ? s.after.filter((x) => typeof x === "string") : []), ...(typeof s.checks === "string" ? [s.checks] : [])]);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const role = (s: TeamStep): RoleDef | undefined => roleOf.get(s.role);
  const kindOf = (s: TeamStep): RoleKind | undefined => role(s)?.kind;

  // V6: the graph.
  for (const s of steps) for (const d of parsed.deps.get(s.id) ?? []) {
    if (!byId.has(d)) add("V6", `step ${s.id} waits for "${clip(d, 30)}", an unknown step`, s.id);
    else if (d === s.id) add("V6", `step ${s.id} waits for itself (a cycle)`, s.id);
  }
  const roots = steps.filter((s) => (parsed.deps.get(s.id) ?? []).length === 0);
  if (roots.length !== 1) add("V6", `a plan has exactly one root step; this one has ${roots.length}${roots.length ? ` (${roots.map((r) => r.id).slice(0, 5).join(", ")})` : ""}`);
  const graphOk = !violations.some((x) => x.rule === "V6");
  const order = graphOk ? topoOrder(steps.map((s) => s.id), parsed.deps) : undefined;
  if (graphOk && !order) add("V6", "the plan has a cycle: some steps wait for each other");
  const executed = order ?? [];

  // V2 and V3: the floor.
  const builders = steps.filter((s) => s.role === "builder");
  const writes = ctx.writes || builders.length > 0;
  const gates = steps.filter((s) => s.role === "gatekeeper");
  if (writes) {
    if (!builders.length) add("V2", "the task writes or acts but the plan has no builder");
    if (gates.length !== 1) add("V2", gates.length ? `a plan has exactly one gatekeeper; this one has ${gates.length}` : "the task writes or acts but the plan has no gatekeeper");
  }
  if (gates.length === 1 && executed.length && executed[executed.length - 1] !== gates[0].id) {
    add("V2", `the gatekeeper must be last; ${executed.length - 1 - executed.indexOf(gates[0].id)} step(s) run after it`, gates[0].id);
  }
  if (writes) for (const b of builders) {
    if (!steps.some((v) => v.role === "verifier" && v.checks === b.id)) add("V2", `builder ${b.id}${b.item ? ` (${clip(b.item, 30)})` : ""} has no verifier checking it`, b.id);
  }
  for (const v of steps.filter((s) => s.role === "verifier")) {
    if (typeof v.checks !== "string" || !v.checks) { add("V3", `verifier ${v.id} does not name the step it checks`, v.id); continue; }
    const target = byId.get(v.checks);
    if (!target) add("V3", `verifier ${v.id} checks "${clip(v.checks, 30)}", an unknown step`, v.id);
    else if (target.id === v.id) add("V3", `verifier ${v.id} checks itself`, v.id);
    else if (kindOf(target) !== "build") add("V3", `verifier ${v.id} checks ${target.id}, a ${target.role} step: a verifier must check a build step`, v.id);
  }

  // V4: mandatory by signal.
  const present = new Set(steps.map((s) => s.role));
  for (const need of ctx.required ?? []) if (!present.has(need)) add("V4", `${need} is mandatory for this task (a signal made it so) and the plan does not have it`);

  // V5: caps, outside a foreach (V15 exempts the steps of an item).
  const flat = steps.filter((s) => s.item === undefined);
  if (flat.length > cap) {
    const need = flat.length - cap;
    const drop: string[] = [];
    for (const rid of DROP_ORDER) {
      if (drop.length >= need) break;
      const def = roleOf.get(rid);
      if (!def || def.skippable === "no" || (ctx.required ?? []).includes(rid)) continue;
      for (const s of flat) if (s.role === rid && drop.length < need) drop.push(s.id);
    }
    add("V5", drop.length >= need ? `${flat.length} agents is over the cap of ${cap}; dropping ${drop.join(", ")} would fit` : `${flat.length} agents is over the cap of ${cap} and cannot be made to fit by dropping optional roles: ask the user`);
    return finish(order, drop.length ? drop : undefined);
  }
  for (const def of ctx.roster) {
    const n = flat.filter((s) => s.role === def.id).length;
    if (n > def.max) add("V5", `${n} ${def.id} steps is over the cap of ${def.max} for that role`);
  }

  // V7: a read-only kind never writes (checked on the definitions the plan uses).
  for (const rid of new Set(steps.map((s) => s.role))) {
    const def = roleOf.get(rid);
    if (!def) continue;
    if (READ_ONLY_KINDS.includes(def.kind) && !isReadOnly(def)) add("V7", `${def.id} is a ${def.kind} role but has the write scope "${def.writeScope}": read-only roles get only read tools`);
    if (def.kind === "plan" && !(def.writeScope === "none" || def.writeScope === "tests")) add("V7", `${def.id} is a plan role with the write scope "${def.writeScope}"`);
  }

  // V8: slices.
  const builderSteps = flat.filter((s) => kindOf(s) === "build" && s.role === "builder");
  const owned: Array<{ step: string; name: string; prefix: string }> = [];
  for (const s of steps) {
    if (s.slice === undefined) continue;
    if (s.role !== "builder") { add("V8", `step ${s.id} (${s.role}) has a slice: only builders own one`, s.id); continue; }
    if (!isObj(s.slice) || typeof s.slice.name !== "string" || !Array.isArray(s.slice.paths) || !s.slice.paths.length) { add("V8", `step ${s.id}: a slice needs a name and a list of directory prefixes`, s.id); continue; }
    for (const raw of s.slice.paths) {
      const p = slicePrefix(raw);
      if ("error" in p) { add("V8", `step ${s.id}: ${p.error}`, s.id); continue; }
      const reserved = reservedReason(p.prefix);
      if (reserved) { add("V8", `step ${s.id}: slice "${clip(s.slice.name, 30)}" claims reserved path "${clip(reserved, 40)}": shared files and generated output belong to the integrator`, s.id); continue; }
      const real = realPrefix(p.prefix, ctx.workDir);
      if ("error" in real) { add("V8", `step ${s.id}: ${real.error}`, s.id); continue; }
      owned.push({ step: s.id, name: clip(s.slice.name, 30), prefix: real.prefix });
    }
  }
  for (let i = 0; i < owned.length; i++) for (let j = i + 1; j < owned.length; j++) {
    if (owned[i].step !== owned[j].step && overlaps(owned[i].prefix, owned[j].prefix)) add("V8", `slice "${owned[i].name}" (${owned[i].prefix}) overlaps slice "${owned[j].name}" (${owned[j].prefix}): two builders could edit the same file`, owned[j].step);
  }
  if (builderSteps.length >= 2) {
    for (const b of builderSteps) if (b.slice === undefined) add("V8", `builder ${b.id} has no slice: with more than one builder, each owns a directory`, b.id);
    if (!present.has("integrator")) add("V8", "two or more slices need an integrator to join them and own the shared files");
  }

  // V11 bookkeeping lives in appendSteps; V12 in skipStep. V15: items.
  const items = new Set(steps.filter((s) => s.item !== undefined).map((s) => s.item));
  if (items.size > itemCap) add("V15", `${items.size} items is over the item cap of ${itemCap} (set in your configuration; the plan cannot change it)`);

  return finish(order);
}

/** The sinks of a plan: steps nothing waits for (apart from the gatekeeper). The gatekeeper is re-pointed at them so it stays last; nothing is left waiting for the gatekeeper. */
export function withGateAfterSinks(plan: TeamPlan): TeamPlan {
  const gate = plan.steps.find((s) => s.role === "gatekeeper");
  if (!gate) return plan;
  const others = plan.steps.filter((s) => s.id !== gate.id).map((s) => {
    const after = (s.after ?? []).filter((d) => d !== gate.id);
    const c: TeamStep = { ...s };
    if (after.length) c.after = after; else delete c.after;
    return c;
  });
  const waited = new Set<string>();
  for (const s of others) for (const d of [...(s.after ?? []), ...(s.checks ? [s.checks] : [])]) waited.add(d);
  const sinks = others.filter((s) => !waited.has(s.id)).map((s) => s.id);
  return { ...plan, steps: [...others, { ...gate, after: sinks.length ? sinks : gate.after }] };
}

/** A plan without one step: whatever waited for it now waits for what it waited for, so the rest stays connected. */
export function removeStep(plan: TeamPlan, id: string): TeamPlan {
  const step = plan.steps.find((s) => s.id === id);
  if (!step) return plan;
  const inherited = [...(step.after ?? []), ...(step.checks ? [step.checks] : [])];
  const steps = plan.steps.filter((s) => s.id !== id).map((s) => {
    const after = (s.after ?? []).flatMap((d) => (d === id ? inherited : [d]));
    const out: TeamStep = { ...JSON.parse(JSON.stringify(s)) };
    if (after.length) out.after = [...new Set(after)]; else delete out.after;
    return out;
  });
  return { ...JSON.parse(JSON.stringify(plan)), steps };
}

/** V11: the Overseer appends steps (never an agent), at most four in all, each with a stored reason, each passing V1 to V10. They are inserted before the gatekeeper. */
export function appendSteps(plan: TeamPlan, steps: TeamStep[], reason: string, ctx: ValidationContext): { plan?: TeamPlan; validation: Validation } {
  const fail = (rule: string, message: string): { validation: Validation } => ({ validation: { ok: false, violations: [{ rule, message }], order: [] } });
  if (typeof reason !== "string" || !reason.trim()) return fail("V11", "an appended step needs a stored reason");
  if (!Array.isArray(steps) || !steps.length) return fail("V11", "nothing to append");
  const already = plan.steps.filter((s) => s.origin === "overseer").length;
  if (already + steps.length > MAX_APPENDED) return fail("V11", `at most ${MAX_APPENDED} steps may be appended to a plan (${already} already are)`);
  const gate = plan.steps.find((s) => s.role === "gatekeeper");
  if (gate && steps.some((s) => (s.after ?? []).includes(gate.id) || s.checks === gate.id)) return fail("V2", "the gatekeeper must stay last: a step cannot run after it");
  const marked = steps.map((s) => ({ ...JSON.parse(JSON.stringify(s)), origin: "overseer", appendedReason: reason.trim().slice(0, 300) }) as TeamStep);
  const candidate = withGateAfterSinks({ ...JSON.parse(JSON.stringify(plan)), steps: [...JSON.parse(JSON.stringify(plan.steps)), ...marked] });
  const validation = validatePlan(candidate, ctx);
  return validation.ok ? { plan: candidate, validation } : { validation };
}

/** V12: never-skippable roles cannot be skipped; others only when the plan marks them, the Overseer gives a reason, and no signal made them mandatory. */
export function skipStep(plan: TeamPlan, id: string, reason: string, ctx: ValidationContext): { plan?: TeamPlan; violations: Violation[]; skipped?: { id: string; role: string; reason: string } } {
  const no = (message: string): { violations: Violation[] } => ({ violations: [{ rule: "V12", step: clip(id, 40), message }] });
  const step = plan.steps.find((s) => s.id === id);
  if (!step) return no(`there is no step "${clip(id, 30)}" to skip`);
  if (typeof reason !== "string" || !reason.trim()) return no("a skip needs a stored reason");
  if (NEVER_SKIPPABLE.includes(step.role)) return no(`${step.role} can never be skipped`);
  if ((ctx.required ?? []).includes(step.role)) return no(`${step.role} is mandatory for this task and cannot be skipped`);
  const def = ctx.roster.find((r) => r.id === step.role);
  if (!def || def.skippable === "no") return no(`${step.role} is not a skippable role`);
  if (step.skippable !== true) return no(`the plan did not mark ${id} as skippable`);
  const candidate = removeStep(plan, id);
  const validation = validatePlan(candidate, ctx);
  if (!validation.ok) return { violations: validation.violations };
  return { plan: candidate, violations: [], skipped: { id, role: step.role, reason: reason.trim().slice(0, 300) } };
}

/**
 * The diff-scope audit that closes V8 after every builder step: Bash is not scoped by the path hook, so what a builder really changed is read from the
 * diff and every path has to be inside its slice. Case-folded, `..` and absolute paths are outside, and a sibling that merely shares a name prefix is outside.
 * The integrator may change the reserved shared files (and anything inside `allPrefixes`).
 */
export function auditDiffScope(
  changed: string[],
  slice: { name: string; paths: string[] },
  opts: { workDir?: string; integrator?: boolean; allPrefixes?: string[]; allowShared?: boolean } = {}
): { ok: boolean; outside: string[] } {
  const prefixes = slicePrefixes(slice, opts.workDir);
  const outside: string[] = [];
  for (const raw of changed) {
    const target = scopeTarget(raw, opts.workDir);
    let inside = false;
    if (target !== undefined) {
      const reserved = reservedReason(target) !== undefined;
      if (opts.integrator) inside = reserved || insidePrefixes(target, opts.allPrefixes ?? []);
      else inside = insidePrefixes(target, prefixes) && !reserved;
    }
    if (!inside) outside.push(String(raw));
  }
  return { ok: outside.length === 0, outside };
}
