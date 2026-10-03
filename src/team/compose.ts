// The composer: turns signals into a team (docs/TEAM-COMPOSITION.md, "How the size is chosen"). The offline heuristic implements the sizing guide and needs no model; it is
// also what a refused model proposal falls back to. `finalizePlan` is the floor code puts under ANY proposal: it adds what the signals make mandatory, the verifier every
// builder needs and the gatekeeper at the end, shrinks an over-cap plan by dropping optional roles cheapest first, and refuses what it cannot repair. Nothing a task or a
// repository says changes the floor, the caps or the item cap.
import { DEFAULT_CAP, DEFAULT_ITEM_CAP, removeStep, slicePrefix, validatePlan, withGateAfterSinks, type TeamPlan, type TeamStep, type Validation, type ValidationContext } from "./plan.js";
import type { RoleDef } from "./roster.js";
import { requiredRoles, type Signals } from "./signals.js";

export interface ComposeOpts {
  cap?: number;
  itemCap?: number;
  workDir?: string;
}
export interface ComposeResult {
  plan?: TeamPlan;
  validation: Validation;
  /** What code decided or changed, in words, for the event stream and the dry run. */
  changes: string[];
  source: "offline" | "proposal" | "offline-fallback";
}

const DROP_ORDER = ["docs-writer", "a11y-reviewer", "perf-reviewer", "ui-tester", "desktop-tester", "adversary", "researcher", "advisor", "test-designer"];
const MAX_SLICES = 4;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const clip = (s: unknown, n = 80): string => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, n);

const ctxFor = (signals: Signals, roster: RoleDef[], opts: ComposeOpts): ValidationContext => ({
  roster, writes: signals.writes, required: requiredRoles(signals), cap: opts.cap ?? DEFAULT_CAP, itemCap: opts.itemCap ?? DEFAULT_ITEM_CAP, workDir: opts.workDir,
});

const sizeName = (n: number): string => (n <= 3 ? "tiny" : n <= 5 ? "small" : n <= 8 ? "medium" : "large");
const areaWords = (s: Signals): string => [...new Set(s.sensitive.map((x) => x.area))].join(", ");

/** Module directories as slices: ancestors of other modules dropped (the more specific one wins), reserved paths skipped, at most MAX_SLICES slices with the rest folded into the last. */
function slicesFor(modules: string[], changes: string[]): Array<{ name: string; paths: string[] }> {
  const mods = modules.filter((m) => {
    const p = slicePrefix(m);
    return "prefix" in p;
  });
  const specific = mods.filter((m) => !mods.some((o) => o !== m && o.toLowerCase().startsWith(`${m.toLowerCase()}/`)));
  if (specific.length < mods.length) changes.push(`kept the more specific modules (${specific.join(", ")}) where one named directory contains another, so no two slices overlap`);
  const unique = specific.filter((m, i) => specific.findIndex((o) => o.toLowerCase() === m.toLowerCase()) === i);
  const slices = unique.slice(0, MAX_SLICES).map((m) => ({ name: m.split("/").pop()!.replace(/[^\w-]/g, "-").slice(0, 30) || "slice", paths: [m] }));
  if (unique.length > MAX_SLICES) {
    for (const extra of unique.slice(MAX_SLICES)) slices[MAX_SLICES - 1].paths.push(extra);
    changes.push(`${unique.length} modules are named; the plan has ${MAX_SLICES} slices (the cap keeps the team within its size limit) and the last slice shares ${unique.length - MAX_SLICES + 1} of them`);
  }
  return slices;
}

/** The offline composer: the sizing guide, as code. */
export function composeOffline(task: string, signals: Signals, roster: RoleDef[], opts: ComposeOpts = {}): ComposeResult {
  const changes: string[] = [];
  const steps: TeamStep[] = [];
  const add = (step: Omit<TeamStep, "id">, prefix = "s"): string => {
    const id = `${prefix}${steps.length + 1}`;
    steps.push({ id, ...step });
    return id;
  };
  const brief = clip(task, 300);
  let cls = "feature";

  if (!signals.writes) {
    cls = "question";
    const r = add({ role: "researcher", brief, why: "a read-only question: find out and report, change nothing" });
    if (signals.irreversible) add({ role: "advisor", after: [r], skippable: true, why: "the answer drives an irreversible choice" });
  } else {
    const slices = signals.modules.length >= 2 ? slicesFor(signals.modules, changes) : [];
    const multi = slices.length >= 2;
    const researcherWanted = signals.unclearCause || signals.unfamiliar;
    const tiny = !multi && signals.estimatedFiles <= 1 && signals.sensitive.length === 0 && signals.testsNearby && !signals.unfamiliar && !signals.unclearCause && signals.ambiguity < 2 && !signals.irreversible;
    let last: string | undefined;
    const chain = (step: Omit<TeamStep, "id">): string => { const id = add(step); last = id; return id; };
    const after = (): { after?: string[] } => (last ? { after: [last] } : {});

    if (researcherWanted) chain({ role: "researcher", brief, skippable: true, why: signals.unclearCause ? "the cause is unclear: find it before changing anything" : "an unfamiliar library or API: read how it works first" });
    const unclearOnly = signals.unclearCause && !signals.unfamiliar;
    if (multi) {
      cls = "multi-module";
      chain({ role: "planner", ...after(), why: `${slices.length} independent modules: plan the slices and their seams` });
    } else if (tiny) {
      cls = "fix";
    } else if (unclearOnly) {
      cls = "bug"; // the researcher's finding is the plan
    } else {
      cls = signals.unfamiliar ? "unfamiliar" : "feature";
      chain({ role: "planner", ...after(), why: signals.estimatedFiles > 1 || signals.sensitive.length ? "more than a one-file change" : "a change above one file" });
    }
    if (!tiny && !multi && !researcherWanted && signals.behaviourChange) chain({ role: "test-designer", ...after(), skippable: true, why: "behaviour changes: write the failing tests first" });
    if (signals.irreversible || signals.external) chain({ role: "advisor", ...after(), skippable: !signals.sensitive.some((s) => s.area === "migrations"), why: signals.irreversible ? "an irreversible action is coming: a second opinion before it" : "an action on the outside world is coming: a second opinion before it" });

    const beforeBuild = last;
    const tail: string[] = [];
    if (multi) {
      slices.forEach((sl, i) => {
        const b = add({ role: "builder", slice: sl, ...(beforeBuild ? { after: [beforeBuild] } : {}), brief, why: `slice ${i + 1} of ${slices.length}: ${sl.paths.join(", ")}` });
        const v = add({ role: "verifier", checks: b, why: `independent check of slice ${i + 1}` });
        tail.push(v);
      });
      last = add({ role: "integrator", after: tail, skippable: false, why: "join the slices, own the shared files, run the whole suite" });
    } else {
      const b = add({ role: "builder", ...after(), brief, why: tiny ? "the change" : "the change, in one slice" });
      last = add({ role: "verifier", checks: b, why: "independent check of the change" });
    }
    for (const role of requiredRoles(signals)) {
      chain({ role, ...after(), why: `mandatory by signal (${areaWords(signals)}): it cannot be dropped` });
    }
    if (signals.ui) {
      chain({ role: "ui-tester", ...after(), skippable: true, why: "UI files are involved: drive the page and read what it reports" });
      if (!tiny) chain({ role: "a11y-reviewer", ...after(), skippable: true, why: "UI files are involved: check accessibility" });
    }
    if (signals.performance) chain({ role: "perf-reviewer", ...after(), skippable: true, why: "a performance goal is stated" });
    if (signals.publicBehaviour && !tiny) chain({ role: "docs-writer", ...after(), skippable: true, why: "public behaviour changes: update the docs" });
    add({ role: "gatekeeper", ...after(), why: "final scope and safety gate" });
  }

  const plan: TeamPlan = { class: cls, size: sizeName(steps.length), reason: clip(`${cls}: ${steps.length} agent${steps.length === 1 ? "" : "s"} for "${brief}"`, 200), steps };
  const shrunk = shrinkToCap(plan, signals, roster, opts, changes);
  const validation = validatePlan(shrunk, ctxFor(signals, roster, opts));
  return { plan: validation.ok ? shrunk : undefined, validation, changes, source: "offline" };
}

/** Drops optional roles, cheapest first, until the plan fits the cap; mandatory roles and the floor are never in the list. */
function shrinkToCap(plan: TeamPlan, signals: Signals, roster: RoleDef[], opts: ComposeOpts, changes: string[]): TeamPlan {
  const cap = opts.cap ?? DEFAULT_CAP;
  const required = requiredRoles(signals);
  let cur = plan;
  for (const rid of DROP_ORDER) {
    const def = roster.find((r) => r.id === rid);
    if (!def || def.skippable === "no" || required.includes(rid)) continue;
    for (const s of cur.steps.filter((x) => x.role === rid && x.item === undefined)) {
      if (cur.steps.filter((x) => x.item === undefined).length <= cap) return cur;
      cur = removeStep(cur, s.id);
      changes.push(`dropped ${rid} (${s.id}): the plan was over the cap of ${cap}`);
    }
  }
  return cur;
}

const nextId = (steps: TeamStep[], prefix: string): string => {
  const taken = new Set(steps.map((s) => s.id));
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};

/** The floor, put under any proposal. Returns a plan only when, after repair, it passes validation. The proposal it is given is not changed. */
export function finalizePlan(proposed: unknown, signals: Signals, roster: RoleDef[], opts: ComposeOpts = {}): ComposeResult {
  const ctx = ctxFor(signals, roster, opts);
  const changes: string[] = [];
  const bare = validatePlan(proposed, ctx);
  const obj = proposed as { steps?: unknown } | null | undefined;
  if (typeof proposed !== "object" || proposed === null || !Array.isArray(obj?.steps) || !obj!.steps!.every((s) => typeof s === "object" && s !== null)) return { validation: bare, changes, source: "proposal" };
  let plan = clone(proposed as TeamPlan);
  const writes = signals.writes || plan.steps.some((s) => s.role === "builder");

  if (writes) {
    // every builder is checked by a verifier in another session
    for (const b of plan.steps.filter((s) => s.role === "builder")) {
      if (!plan.steps.some((s) => s.role === "verifier" && s.checks === b.id)) {
        plan.steps.push({ id: nextId(plan.steps, "c"), role: "verifier", checks: b.id, why: `added by code: builder ${b.id}${b.item ? ` (${clip(b.item, 30)})` : ""} needs an independent check` });
        changes.push(`added a verifier for builder ${b.id}`);
      }
    }
  }
  // roles the signals made mandatory
  const present = new Set(plan.steps.map((s) => s.role));
  for (const role of requiredRoles(signals)) {
    if (!present.has(role)) {
      plan.steps.push({ id: nextId(plan.steps, "c"), role, why: `added by code: mandatory by signal (${areaWords(signals)})` });
      changes.push(`added ${role}: it is mandatory for this task and the proposal did not have it`);
    }
  }
  if (writes) {
    if (!plan.steps.some((s) => s.role === "gatekeeper")) {
      plan.steps.push({ id: nextId(plan.steps, "c"), role: "gatekeeper", why: "added by code: a task that writes needs a final gate" });
      changes.push("added a gatekeeper at the end");
    }
    const sinksBefore = withGateAfterSinks(plan);
    // code-added steps hang off the sinks, then the gatekeeper goes last
    plan = attachLoose(sinksBefore);
    if (JSON.stringify(plan.steps.find((s) => s.role === "gatekeeper")?.after) !== JSON.stringify((proposed as TeamPlan).steps.find((s) => s.role === "gatekeeper")?.after) && (proposed as TeamPlan).steps.some((s) => s.role === "gatekeeper")) {
      changes.push("moved the gatekeeper to the end");
    }
  }
  let validation = validatePlan(plan, ctx);
  if (!validation.ok && validation.dropOrder?.length) {
    for (const id of validation.dropOrder) {
      const role = plan.steps.find((s) => s.id === id)?.role;
      plan = removeStep(plan, id);
      changes.push(`dropped ${role} (${id}): the plan was over the cap of ${ctx.cap}`);
    }
    validation = validatePlan(plan, ctx);
  }
  return { plan: validation.ok ? plan : undefined, validation, changes, source: "proposal" };
}

/** Steps the code added have no `after`: give each the previous sink as its dependency so the plan keeps one root and one chain. */
function attachLoose(plan: TeamPlan): TeamPlan {
  const gate = plan.steps.find((s) => s.role === "gatekeeper");
  const out = clone(plan);
  const depOf = (s: TeamStep): string[] => [...(s.after ?? []), ...(s.checks ? [s.checks] : [])];
  const added = out.steps.filter((s) => s.why.startsWith("added by code") && s.role !== "gatekeeper" && depOf(s).length === 0 && s.id !== out.steps[0]?.id);
  for (const s of added) {
    const waited = new Set(out.steps.filter((x) => x.id !== s.id && x.id !== gate?.id).flatMap(depOf));
    const sink = [...out.steps].reverse().find((x) => x.id !== s.id && x.id !== gate?.id && !waited.has(x.id) && !added.includes(x));
    if (sink) s.after = [sink.id];
  }
  return withGateAfterSinks(out);
}

/** A model's proposal when it is good, the offline plan (with the reason) when it is not, the offline plan when there is no proposal. */
export function chooseFinal(proposed: unknown, task: string, signals: Signals, roster: RoleDef[], opts: ComposeOpts = {}): ComposeResult {
  if (proposed === undefined) return composeOffline(task, signals, roster, opts);
  const r = finalizePlan(proposed, signals, roster, opts);
  if (r.plan) return r;
  const reasons = r.validation.violations.slice(0, 3).map((v) => `${v.rule}: ${v.message}`).join("; ");
  const fallback = composeOffline(task, signals, roster, opts);
  return { ...fallback, source: "offline-fallback", changes: [`the proposed plan was refused (${reasons}); using the offline plan`, ...fallback.changes] };
}

/** The job flow's shape: a planner once, a builder and a verifier per item, a gatekeeper last. The item cap is the user's configuration; the plan cannot set it. */
export function composeForEach(items: string[], opts: ComposeOpts & { roster: RoleDef[] }): ComposeResult {
  const clean = [...new Set(items.map((i) => clip(i, 80).trim()).filter(Boolean))];
  const ctx: ValidationContext = { roster: opts.roster, writes: true, cap: opts.cap ?? DEFAULT_CAP, itemCap: opts.itemCap ?? DEFAULT_ITEM_CAP, workDir: opts.workDir };
  if (!clean.length) return { validation: { ok: false, violations: [{ rule: "SHAPE", message: "there are no items to work through" }], order: [] }, changes: [], source: "offline" };
  const steps: TeamStep[] = [{ id: "p", role: "planner", why: "plan once for every item" }];
  clean.forEach((item, i) => {
    steps.push({ id: `b${i + 1}`, role: "builder", item, after: ["p"], why: `work on ${item}` });
    steps.push({ id: `v${i + 1}`, role: "verifier", item, checks: `b${i + 1}`, why: `independent check of ${item}` });
  });
  steps.push({ id: "g", role: "gatekeeper", after: [`v${clean.length}`], why: "final gate" });
  const plan: TeamPlan = { class: "foreach", size: "large", reason: `${clean.length} items, one builder and one verifier each`, steps };
  const validation = validatePlan(plan, ctx);
  return { plan: validation.ok ? plan : undefined, validation, changes: [], source: "offline" };
}

const MAX_JSON_CHARS = 50_000;
/** The first JSON object in a model's answer, bare or fenced or with chatter around it. Never evaluates anything; bounded; anything else is undefined. */
export function parseComposerJson(text: string): unknown {
  if (typeof text !== "string" || !text.trim() || text.length > MAX_JSON_CHARS) return undefined;
  const candidates: string[] = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (typeof v === "object" && v !== null && !Array.isArray(v)) return v;
    } catch { /* try the next reading */ }
  }
  return undefined;
}
