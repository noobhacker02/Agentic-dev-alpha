import { PHASES } from "./types.js";
import type { PipelineConfig, RunRecord } from "./types.js";
import type { EventBus } from "./bus.js";
import { Store } from "./store.js";
import { runPhase } from "./phases.js";
import { overseerDecide } from "./overseer.js";

export async function runPipeline(config: PipelineConfig, bus: EventBus, store: Store): Promise<RunRecord> {
  const run = store.createRun(config.task, config.workDir);
  bus.emitEvent({ type: "run-start", runId: run.id, task: config.task, ts: new Date().toISOString() });

  let finalStatus: RunRecord["status"] = "done";

  outer: for (const phase of PHASES) {
    let attempt = 1;
    let retryFeedback: string | undefined;

    while (true) {
      bus.emitEvent({ type: "phase-start", runId: run.id, phase, attempt, ts: new Date().toISOString() });
      const record = store.startPhase(run.id, phase, attempt);

      const priorSummaries = store
        .getPhaseSummaries(run.id)
        .map((s) => `- ${s.name} (attempt ${s.attempt}, ${s.status}): ${s.summary ?? "(no summary)"}`)
        .join("\n");

      let verdict;
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
          success: false,
          headline: `${phase} threw an unhandled error`,
          details: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
          concerns: ["Phase execution raised an exception rather than reporting a verdict."],
        };
      }

      store.finishPhase(record.id, verdict);
      bus.emitEvent({ type: "phase-end", runId: run.id, phase, attempt, verdict, ts: new Date().toISOString() });

      const decision = await overseerDecide({
        task: config.task,
        phase,
        attempt,
        maxRetries: config.maxRetriesPerPhase,
        verdict,
        priorSummaries: store.getPhaseSummaries(run.id),
      });
      bus.emitEvent({ type: "overseer-decision", runId: run.id, phase, decision, ts: new Date().toISOString() });

      if (decision.action === "continue") {
        continue outer;
      }
      if (decision.action === "stop") {
        finalStatus = "stopped";
        break outer;
      }

      // retry: same phase again, one attempt higher, carrying the Overseer's feedback
      attempt += 1;
      retryFeedback = decision.feedbackForRetry;
      if (attempt > config.maxRetriesPerPhase + 1) {
        finalStatus = "failed";
        break outer;
      }
    }
  }

  store.finishRun(run.id, finalStatus);
  bus.emitEvent({ type: "run-end", runId: run.id, status: finalStatus, ts: new Date().toISOString() });
  return { ...run, status: finalStatus };
}
