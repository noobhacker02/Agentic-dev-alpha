import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PHASES, SKIPPABLE_PHASES } from "./types.js";
import type { OverseerDecision, PhaseName, PhaseVerdict, PipelineConfig, RunRecord } from "./types.js";
import type { EventBus } from "./bus.js";
import { Store } from "./store.js";
import { runPhase } from "./phases.js";
import { overseerDecide } from "./overseer.js";

/**
 * A project's DECISIONS.md (any phase may write one, following dev-workflow's convention) is
 * exactly the kind of short, indexed record the Overseer is meant to read instead of holding
 * things in a phase's own disposable session memory. Read the latest content every phase boundary
 * and only emit/index when it actually changed, so it's real structured input to overseerDecide()
 * rather than something that only ever existed inside whichever phase happened to write it.
 */
function readDecisionsLog(workDir: string): string | undefined {
  const path = join(workDir, "DECISIONS.md");
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * A repair can only target the phase that just ran or an earlier one -- never forward -- and never
 * a phase this specific run already skipped. This is the hard boundary overseerDecide's own
 * validation already enforces on the LLM's output; pipeline code enforces it again here
 * independent of that, since this is the actual authority, not a suggestion.
 */
function isValidRepairTarget(from: PhaseName, target: PhaseName, runPhases: readonly PhaseName[]): boolean {
  return PHASES.indexOf(target) >= 0 && PHASES.indexOf(target) <= PHASES.indexOf(from) && runPhases.includes(target);
}

/** A phase entry that never actually ran -- recorded so the history/UI stay honest about why it's
 * absent, instead of a silent gap. */
function skippedVerdict(reason: string): PhaseVerdict {
  return { completed: true, outcome: "pass", headline: "Skipped", details: reason, concerns: [], blockingFindings: [] };
}

export async function runPipeline(config: PipelineConfig, bus: EventBus, store: Store): Promise<RunRecord> {
  const run = store.createRun(config.task, config.workDir);
  bus.emitEvent({ type: "run-start", runId: run.id, task: config.task, ts: new Date().toISOString() });

  let finalStatus: RunRecord["status"] = "done";
  let lastSeenDecisionsLog: string | undefined;
  let totalRepairs = 0;
  const attemptCounts: Partial<Record<PhaseName, number>> = {};

  try {
    let phaseIdx = 0;
    let retryFeedback: string | undefined;
    // The actual sequence for this run -- starts as every phase, shrinks by at most
    // SKIPPABLE_PHASES when the Planner suggests it and pipeline code allows it (see below).
    let runPhases: PhaseName[] = [...PHASES];

    while (phaseIdx < runPhases.length) {
      const phase = runPhases[phaseIdx];
      const attempt = (attemptCounts[phase] ?? 0) + 1;
      attemptCounts[phase] = attempt;

      bus.emitEvent({ type: "phase-start", runId: run.id, phase, attempt, ts: new Date().toISOString() });
      const record = store.startPhase(run.id, phase, attempt);

      const priorSummaries = store
        .getPhaseSummaries(run.id)
        .map((s) => `- ${s.name} (attempt ${s.attempt}, ${s.status}): ${s.summary ?? "(no summary)"}`)
        .join("\n");

      let verdict: PhaseVerdict;
      try {
        verdict = await runPhase({
          runId: run.id,
          phase,
          attempt,
          task: config.task,
          workDir: config.workDir,
          priorSummaries,
          retryFeedback,
          bus,
          store,
          requireApproval: config.requireApproval,
        });
      } catch (err) {
        verdict = {
          completed: false,
          outcome: "inconclusive",
          headline: `${phase} threw an unhandled error`,
          details: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
          concerns: [],
          blockingFindings: ["Phase execution raised an exception rather than reporting a verdict."],
        };
      }

      store.finishPhase(record.id, verdict);
      bus.emitEvent({ type: "phase-end", runId: run.id, phase, attempt, verdict, ts: new Date().toISOString() });

      const decisionsLog = readDecisionsLog(config.workDir);
      if (decisionsLog && decisionsLog !== lastSeenDecisionsLog) {
        lastSeenDecisionsLog = decisionsLog;
        store.indexLog(run.id, "decisions-log", decisionsLog);
        bus.emitEvent({ type: "decisions-log-updated", runId: run.id, content: decisionsLog, ts: new Date().toISOString() });
      }

      let decision: OverseerDecision;
      try {
        decision = await overseerDecide({
          task: config.task,
          phase,
          attempt,
          maxRetries: config.maxRetriesPerPhase,
          verdict,
          priorSummaries: store.getPhaseSummaries(run.id),
          decisionsLog,
          trustedDecisions: store.getTrustedDecisions(run.id),
        });
      } catch (err) {
        // An Overseer API failure must not leave the run stuck "running" forever in the DB (found
        // by test/stress/pipeline_logic.sh case C) -- treat it as a terminal failure of this run,
        // not an exception that skips store.finishRun entirely.
        finalStatus = "failed";
        bus.emitEvent({
          type: "overseer-decision",
          runId: run.id,
          phase,
          decision: {
            action: "stop",
            reasoning: `Overseer call raised an exception: ${err instanceof Error ? err.message : String(err)}`,
          },
          ts: new Date().toISOString(),
        });
        break;
      }

      // Pipeline code has final say, not the Overseer's own text: a non-"pass" outcome can never be
      // continued past, regardless of what action the Overseer returned (found by pipeline_logic.sh
      // case A, where a gatekeeper no-go was waved through because the Overseer said "continue").
      if (decision.action === "continue" && verdict.outcome !== "pass") {
        decision = {
          action: "repair",
          repairTarget: phase,
          reasoning: `${decision.reasoning} (overridden: pipeline requires outcome "pass" to continue past a phase; got "${verdict.outcome}")`,
        };
      }

      bus.emitEvent({ type: "overseer-decision", runId: run.id, phase, decision, ts: new Date().toISOString() });

      if (decision.action === "continue") {
        // Only right as the Planner passes, and only once: apply any skip it suggested. Validated
        // again here against the hard SKIPPABLE_PHASES allowlist -- parseVerdict already filtered
        // it, but this is the actual authority, not a suggestion the pipeline merely trusts.
        if (phase === "planner" && verdict.suggestedSkip?.length) {
          for (const skip of verdict.suggestedSkip) {
            if (!(SKIPPABLE_PHASES as readonly string[]).includes(skip) || !runPhases.includes(skip)) continue;
            const skipRecord = store.startPhase(run.id, skip, 1);
            const skip_verdict = skippedVerdict(`Planner suggested skipping this phase as unnecessary for a trivial task: ${verdict.headline}`);
            store.finishPhase(skipRecord.id, skip_verdict);
            bus.emitEvent({ type: "phase-start", runId: run.id, phase: skip, attempt: 1, ts: new Date().toISOString() });
            bus.emitEvent({ type: "phase-end", runId: run.id, phase: skip, attempt: 1, verdict: skip_verdict, ts: new Date().toISOString() });
            runPhases = runPhases.filter((p) => p !== skip);
          }
        }
        phaseIdx = runPhases.indexOf(phase) + 1;
        retryFeedback = undefined;
        continue;
      }
      if (decision.action === "stop") {
        // "stopped" is a clean halt (e.g. the Overseer judged the task itself ambiguous while the
        // phase still passed); anything ending on a non-pass outcome is a "failed" run, not a
        // neutral stop, even when the Overseer's own reasoning used the word "stop".
        finalStatus = verdict.outcome === "pass" ? "stopped" : "failed";
        break;
      }

      // repair: route to the named phase (same phase or an earlier one), bounded by a total budget
      // across the whole run so e.g. a builder<->verifier ping-pong can't run forever even though
      // neither phase alone ever exceeds its own per-phase retry limit.
      totalRepairs += 1;
      if (totalRepairs > config.maxTotalRepairs) {
        finalStatus = "failed";
        bus.emitEvent({
          type: "overseer-decision",
          runId: run.id,
          phase,
          decision: { action: "stop", reasoning: `Total repair budget (${config.maxTotalRepairs}) exhausted for this run.` },
          ts: new Date().toISOString(),
        });
        break;
      }

      const target =
        decision.repairTarget && isValidRepairTarget(phase, decision.repairTarget, runPhases) ? decision.repairTarget : phase;
      if (target === phase && attempt > config.maxRetriesPerPhase) {
        finalStatus = "failed";
        bus.emitEvent({
          type: "overseer-decision",
          runId: run.id,
          phase,
          decision: { action: "stop", reasoning: `Per-phase retry budget (${config.maxRetriesPerPhase}) exhausted for ${phase}.` },
          ts: new Date().toISOString(),
        });
        break;
      }

      retryFeedback = decision.feedbackForRepair ?? decision.reasoning;
      phaseIdx = runPhases.indexOf(target);
    }
  } catch (err) {
    // Anything else unexpected (a bug in the loop itself, a Store I/O error) still leaves a
    // terminal record rather than an unhandled rejection with the run stuck "running".
    finalStatus = "failed";
    bus.emitEvent({
      type: "overseer-decision",
      runId: run.id,
      phase: PHASES[0],
      decision: { action: "stop", reasoning: `Pipeline raised an unexpected error: ${err instanceof Error ? err.message : String(err)}` },
      ts: new Date().toISOString(),
    });
  } finally {
    store.finishRun(run.id, finalStatus);
    bus.emitEvent({ type: "run-end", runId: run.id, status: finalStatus, ts: new Date().toISOString() });
  }

  return { ...run, status: finalStatus };
}
