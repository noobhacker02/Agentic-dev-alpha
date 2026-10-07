// A run of a composed team (docs/TEAM-COMPOSITION.md): the plan's steps in their validated order, one at a time, each through runPhase with its role's own tools, words and write scope. This is the plan-driven
// counterpart of the loop in pipeline.ts, which stays as it was for the five built-in phases (`--team fixed5`). The rules are the same where they can be: only a pass is continued past, a repair goes back to the
// same step or an earlier one and is bounded by a per-step and a per-run budget, a stop (cost cap, Ctrl-C) ends the run as "stopped". What is new: steps have ids and roles, a read-only step's document comes back as
// the verdict's report and the pipeline saves it for the steps after it, and after every step the project tree is compared with how it was before, because the file tools are judged as they write and Bash is not (V8, G8).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventBus } from "../bus.js";
import type { Store } from "../store.js";
import type { BrowserSessionManager } from "../browser-tools.js";
import type { DesktopSession } from "../desktop-tools.js";
import { isInside } from "../path-canon.js";
import { runPhase } from "../phases.js";
import { overseerDecide, boundRepairTarget } from "../overseer.js";
import type { OverseerDecision, PhaseVerdict, PipelineConfig, RunRecord, TeamPlanStep } from "../types.js";
import { validatePlan, skipStep, slicePrefixes, type TeamPlan, type TeamStep, type ValidationContext } from "./plan.js";
import type { RoleDef } from "./roster.js";
import { changedBetween, snapshotTree, type TreeSnapshot } from "./changes.js";
import { decideWrite } from "./write-scope.js";

export interface TeamRunContext {
  run: RunRecord;
  config: PipelineConfig & { team: NonNullable<PipelineConfig["team"]> };
  bus: EventBus;
  store: Store;
  browser?: { sessions: BrowserSessionManager; artifactDir: string };
  desktop?: DesktopSession;
  /** DECISIONS.md as it is now (pipeline.ts reads it the same way for the five built-in phases). */
  readDecisionsLog: (workDir: string) => string | undefined;
}

const MAX_LISTED = 8;
const listed = (items: string[]): string[] => (items.length > MAX_LISTED ? [...items.slice(0, MAX_LISTED), `(+${items.length - MAX_LISTED} more)`] : items);

/**
 * What a step changed against what its role may change. A role with a write scope may change what its scope allows (the same rule the write-scope hook applies to the file tools, now applied to what Bash did too).
 * A read-only role may change nothing that existed: that is blocking; a new file is only a concern, because checkers run tests and tests leave files. A tree too large to compare is blocking too: an audit over part
 * of a tree proves nothing.
 */
export function auditStepChanges(opts: { before: TreeSnapshot; after: TreeSnapshot; role: RoleDef; step: TeamStep; workDir: string; allPrefixes: string[] }): { blocking: string[]; concerns: string[] } {
  const { before, after, role, step } = opts;
  let changed: string[];
  try {
    changed = changedBetween(before, after);
  } catch (err) {
    return { blocking: [`what step ${step.id} (${role.id}) changed could not be checked: ${err instanceof Error ? err.message : String(err)}`], concerns: [] };
  }
  const rule = { role: role.id, writeScope: role.writeScope, workDir: opts.workDir, slice: step.slice, allPrefixes: opts.allPrefixes };
  const blocking: string[] = [], concerns: string[] = [];
  for (const p of changed) {
    if (role.writeScope === "none") {
      if (before.files.has(p)) blocking.push(`${role.id} is read-only but changed ${p}${after.files.has(p) ? "" : " (deleted it)"}`);
      else concerns.push(`${role.id} created ${p} (a read-only step creates no project files)`);
    } else {
      const d = decideWrite(p, rule);
      if (!d.allow) blocking.push(`step ${step.id} (${role.id}) changed ${p}, outside its scope: ${d.reason}`);
    }
  }
  return { blocking: listed(blocking), concerns: listed(concerns) };
}

/** Saves a step's report where the steps after it can read it: `team-reports/<step id>.md` in the project, never through a link that leads out. */
function saveReport(workDir: string, step: TeamStep, role: RoleDef, attempt: number, verdict: PhaseVerdict): string | undefined {
  if (!verdict.report) return undefined;
  const rel = `team-reports/${step.id}.md`;
  try {
    if (!isInside(workDir, join(workDir, rel))) return undefined;
    mkdirSync(join(workDir, "team-reports"), { recursive: true });
    writeFileSync(join(workDir, rel), `# ${role.id} (step ${step.id}), attempt ${attempt}, outcome ${verdict.outcome}\n\n${verdict.report}\n`);
    return rel;
  } catch {
    return undefined;
  }
}

const skippedVerdict = (reason: string): PhaseVerdict => ({ completed: true, outcome: "pass", headline: "Skipped", details: reason, concerns: [], blockingFindings: [] });

export interface SkipJudgement {
  /** The plan without the steps that were skipped (the plan it was given when none were). */
  plan: TeamPlan;
  skipped: Array<{ id: string; role: string; reason: string }>;
  /** One line for each role the planner named that could not be skipped, with the rule that said so. */
  refused: string[];
}

/**
 * What a planner's "skip these roles" is worth: each role it names is looked for among the steps that have not run, and every one found goes through the same V12 rule as any skip (a role that can never be skipped,
 * one a signal made mandatory, a step the plan did not mark as skippable). Pure: nothing changes until the run applies the result. A name that is no waiting step is refused, so a role that already ran, was already
 * skipped or is not on the team cannot be "skipped" into the record.
 */
export function judgeSkips(plan: TeamPlan, pending: string[], roles: string[], reason: string, ctx: ValidationContext): SkipJudgement {
  let cur = plan;
  const skipped: SkipJudgement["skipped"] = [], refused: string[] = [];
  for (const rid of [...new Set(roles)]) {
    const ids = pending.filter((id) => cur.steps.find((s) => s.id === id)?.role === rid);
    if (!ids.length) { refused.push(`${rid}: no step of that role is waiting`); continue; }
    for (const id of ids) {
      const r = skipStep(cur, id, reason, ctx);
      if (r.plan && r.skipped) { cur = r.plan; skipped.push(r.skipped); }
      else refused.push(`${rid}: ${r.violations[0]?.message ?? "refused"}`);
    }
  }
  return { plan: cur, skipped, refused };
}

export async function runTeamPlan(ctx: TeamRunContext): Promise<RunRecord["status"]> {
  const { run, config, bus, store } = ctx;
  const { roster } = config.team;
  let plan = config.team.plan;
  const control = config.control;
  const now = () => new Date().toISOString();
  const rosterById = new Map(roster.map((r) => [r.id, r]));
  const stop = (reasoning: string, role = plan.steps[0]?.role ?? "planner", ref: { stepId?: string } = {}) =>
    bus.emitEvent({ type: "overseer-decision", runId: run.id, phase: role, decision: { action: "stop", reasoning }, ts: now(), ...(ref.stepId ? { stepId: ref.stepId, role } : {}) });

  const vctx: ValidationContext = { roster, writes: plan.steps.some((s) => (rosterById.get(s.role)?.writeScope ?? "none") !== "none"), workDir: config.workDir, ...(config.team.required ? { required: config.team.required } : {}) };
  const validation = validatePlan(plan, vctx);
  if (!validation.ok) {
    stop(`The team plan was refused before any step ran: ${validation.violations.slice(0, 5).map((v) => `${v.rule}: ${v.message}`).join(" | ")}`);
    return "failed";
  }
  let order = [...validation.order];
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const allPrefixes = plan.steps.flatMap((s) => (s.slice ? slicePrefixes(s.slice, config.workDir) : []));
  const teamSteps = (): TeamPlanStep[] =>
    order.map((id) => {
      const s = byId.get(id)!;
      return { stepId: s.id, role: s.role, kind: rosterById.get(s.role)!.kind, after: s.after ?? [], ...(s.slice ? { slice: s.slice.name } : {}), ...(s.checks ? { verifies: s.checks } : {}), why: s.why };
    });
  bus.emitEvent({ type: "team-plan", runId: run.id, source: config.team.source, steps: teamSteps(), ts: now() });

  const haltForStop = (step: TeamStep) => {
    stop(`Stopped: ${control?.reason ?? "the run was stopped"}.`, step.role, { stepId: step.id });
    return "stopped" as const;
  };

  let finalStatus: RunRecord["status"] = "done";
  let idx = 0;
  let retryFeedback: string | undefined;
  let totalRepairs = 0;
  let lastSeenDecisionsLog: string | undefined;
  const attempts = new Map<string, number>();
  const reports = new Map<string, string>();

  while (idx < order.length) {
    const step = byId.get(order[idx])!;
    const role = rosterById.get(step.role)!;
    if (control?.stopped) { finalStatus = haltForStop(step); break; }
    const attempt = (attempts.get(step.id) ?? 0) + 1;
    attempts.set(step.id, attempt);
    const ref = { stepId: step.id, role: role.id, ...(step.item ? { item: step.item } : {}) };

    bus.emitEvent({ type: "phase-start", runId: run.id, phase: role.id, attempt, ts: now(), ...ref });
    const record = store.startPhase(run.id, role.id, attempt, ref);

    // The composer, the watchdog and the learner are not steps of the work: a plan that lists one gets no model session for it.
    if (role.kind === "meta" || role.kind === "monitor") {
      const verdict = skippedVerdict(`${role.id} is not a step of the work and is not run as one`);
      store.finishPhase(record.id, verdict);
      bus.emitEvent({ type: "phase-end", runId: run.id, phase: role.id, attempt, verdict, ts: now(), ...ref });
      idx += 1;
      continue;
    }

    const priorSummaries = store
      .getPhaseSummaries(run.id)
      .map((s) => `- ${s.stepId ? `${s.stepId} ` : ""}${s.name} (attempt ${s.attempt}, ${s.status}): ${s.summary ?? "(no summary)"}${s.stepId && reports.has(s.stepId) ? ` [report: ${reports.get(s.stepId)}]` : ""}`)
      .join("\n");

    const before = snapshotTree(config.workDir, { maxFiles: config.team.maxTreeFiles });
    let verdict: PhaseVerdict;
    try {
      verdict = await runPhase({
        runId: run.id,
        phase: role.id,
        attempt,
        task: config.task,
        workDir: config.workDir,
        priorSummaries,
        retryFeedback,
        bus,
        store,
        requireApproval: config.requireApproval,
        strictApproval: config.strictApproval,
        browser: ctx.browser,
        desktop: ctx.desktop,
        abortController: control?.controller,
        team: { role, step, allPrefixes },
      });
    } catch (err) {
      verdict = control?.stopped
        ? { completed: false, outcome: "inconclusive", headline: `${role.id} (step ${step.id}) was stopped before it finished`, details: control.reason ?? "", concerns: [], blockingFindings: [] }
        : {
            completed: false,
            outcome: "inconclusive",
            headline: `${role.id} (step ${step.id}) threw an unhandled error`,
            details: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
            concerns: [],
            blockingFindings: ["Step execution raised an exception rather than reporting a verdict."],
          };
    }

    // What the step really changed, whatever tool did it: the file tools were judged as they wrote, a shell was not.
    const audit = auditStepChanges({ before, after: snapshotTree(config.workDir, { maxFiles: config.team.maxTreeFiles }), role, step, workDir: config.workDir, allPrefixes });
    if (audit.blocking.length) {
      verdict = { ...verdict, outcome: "fail", headline: `${verdict.headline} (it changed files outside what its role may change)`, blockingFindings: [...verdict.blockingFindings, ...audit.blocking] };
    }
    if (audit.concerns.length) verdict = { ...verdict, concerns: [...verdict.concerns, ...audit.concerns] };

    const saved = saveReport(config.workDir, step, role, attempt, verdict);
    if (saved) reports.set(step.id, saved);
    store.finishPhase(record.id, verdict);
    bus.emitEvent({ type: "phase-end", runId: run.id, phase: role.id, attempt, verdict, ts: now(), ...ref });

    if (control?.stopped) { finalStatus = haltForStop(step); break; }

    const decisionsLog = ctx.readDecisionsLog(config.workDir);
    if (decisionsLog && decisionsLog !== lastSeenDecisionsLog) {
      lastSeenDecisionsLog = decisionsLog;
      store.indexLog(run.id, "decisions-log", decisionsLog);
      bus.emitEvent({ type: "decisions-log-updated", runId: run.id, content: decisionsLog, ts: now() });
    }

    let decision: OverseerDecision;
    try {
      decision = await overseerDecide({
        task: config.task,
        phase: step.id,
        attempt,
        maxRetries: config.maxRetriesPerPhase,
        verdict,
        priorSummaries: store.getPhaseSummaries(run.id),
        decisionsLog,
        trustedDecisions: store.getTrustedDecisions(run.id),
        onUsage: (u) => bus.emitEvent({ type: "usage", runId: run.id, phase: role.id, role: "overseer", ...u, ts: now() }),
        abortController: control?.controller,
        team: { steps: order.map((id) => { const s = byId.get(id)!; return { id, role: s.role, kind: rosterById.get(s.role)!.kind, ...(s.slice ? { slice: s.slice.name } : {}), ...(s.checks ? { checks: s.checks } : {}) }; }) },
      });
    } catch (err) {
      if (control?.stopped) { finalStatus = haltForStop(step); break; }
      finalStatus = "failed";
      stop(`Overseer call raised an exception: ${err instanceof Error ? err.message : String(err)}`, role.id, ref);
      break;
    }

    // As in the five-phase loop: the pipeline, not the Overseer's text, decides that only a pass is continued past.
    if (decision.action === "continue" && verdict.outcome !== "pass") {
      decision = { action: "repair", repairTarget: step.id, reasoning: `${decision.reasoning} (overridden: the pipeline requires outcome "pass" to continue past a step; got "${verdict.outcome}")` };
    }
    // The planner may ask to skip steps that have not run. Judged here, applied only when the run goes on past the planner: a failing planner's suggestion is never acted on.
    let judged: SkipJudgement | undefined;
    if (decision.action === "continue" && role.id === "planner" && verdict.suggestedSkip?.length) {
      judged = judgeSkips(plan, order.slice(idx + 1), verdict.suggestedSkip, `the planner suggested it for this task: ${verdict.headline}`, vctx);
      const notes = [
        ...(judged.skipped.length ? [`skipping ${judged.skipped.map((s) => `${s.id} (${s.role})`).join(", ")} on the planner's suggestion`] : []),
        ...(judged.refused.length ? [`skip refused: ${judged.refused.join(" | ")}`.slice(0, 600)] : []),
      ];
      if (notes.length) decision = { ...decision, reasoning: `${decision.reasoning} (${notes.join("; ")})` };
    }
    bus.emitEvent({ type: "overseer-decision", runId: run.id, phase: role.id, decision, ts: now(), ...ref });

    if (decision.action === "continue") {
      if (judged) {
        // Recorded like any step (start and end, its id and role), with no model session; whatever waited for it waits for what it waited for (the plan's own rewiring).
        for (const sk of judged.skipped) {
          const skRef = { stepId: sk.id, role: sk.role, ...(byId.get(sk.id)?.item ? { item: byId.get(sk.id)!.item } : {}) };
          const rec = store.startPhase(run.id, sk.role, 1, skRef);
          const sv = skippedVerdict(`Skipped on the planner's suggestion (step ${step.id}): ${sk.reason}`);
          bus.emitEvent({ type: "phase-start", runId: run.id, phase: sk.role, attempt: 1, ts: now(), ...skRef });
          store.finishPhase(rec.id, sv);
          bus.emitEvent({ type: "phase-end", runId: run.id, phase: sk.role, attempt: 1, verdict: sv, ts: now(), ...skRef });
        }
        const gone = new Set(judged.skipped.map((s) => s.id));
        plan = judged.plan;
        order = order.filter((id) => !gone.has(id));
      }
      idx += 1;
      retryFeedback = undefined;
      continue;
    }
    if (decision.action === "stop") {
      finalStatus = verdict.outcome === "pass" ? "stopped" : "failed";
      break;
    }

    totalRepairs += 1;
    if (totalRepairs > config.maxTotalRepairs) {
      finalStatus = "failed";
      stop(`Total repair budget (${config.maxTotalRepairs}) exhausted for this run.`, role.id, ref);
      break;
    }
    // A repair goes back to a step at or before this one (the Overseer's own bound is applied again here: this is the authority). With no target named, a checker sends the work back to the step it checks.
    const target = boundRepairTarget(decision.repairTarget, step.id, order, step.checks);
    if (target === step.id && attempt > config.maxRetriesPerPhase) {
      finalStatus = "failed";
      stop(`Per-step retry budget (${config.maxRetriesPerPhase}) exhausted for ${step.id} (${role.id}).`, role.id, ref);
      break;
    }
    retryFeedback = decision.feedbackForRepair ?? decision.reasoning;
    idx = order.indexOf(target);
  }
  return finalStatus;
}
