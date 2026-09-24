export const PHASES = [
  "planner",
  "test-designer",
  "builder",
  "verifier",
  "gatekeeper",
] as const;

export type PhaseName = (typeof PHASES)[number];

export interface RunRecord {
  id: string;
  task: string;
  workDir: string;
  createdAt: string;
  status: "running" | "done" | "failed" | "stopped";
}

export interface PhaseRecord {
  id: string;
  runId: string;
  name: PhaseName;
  attempt: number;
  status: "running" | "ok" | "failed";
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
  verdict: PhaseVerdict | null;
}

/**
 * "pass": did its job, found nothing blocking. "fail": found a genuine defect in what it reviewed
 * or produced. "blocked": can't proceed for a reason no retry of this phase can fix (ambiguous
 * task, contradictory requirements, a decision only a human can make). "inconclusive": couldn't
 * actually determine pass/fail (e.g. couldn't run the tests) — must never be silently treated as
 * a pass. Kept separate from `completed` (did the phase finish acting at all) so "I finished my
 * turn" and "everything is fine" can't be conflated into one boolean the way `success` was.
 */
export const PHASE_OUTCOMES = ["pass", "fail", "blocked", "inconclusive"] as const;
export type PhaseOutcome = (typeof PHASE_OUTCOMES)[number];

/** What a phase itself reports about its own work — short, structured, never a full transcript. */
export interface PhaseVerdict {
  /** Did the phase actually finish acting (not: is everything OK — that's `outcome`). */
  completed: boolean;
  outcome: PhaseOutcome;
  headline: string;
  details: string;
  /** Non-blocking notes, observations, things worth knowing but not showstoppers. */
  concerns: string[];
  /** Findings that must prevent the run from being accepted until addressed. Empty for outcome "pass". */
  blockingFindings: string[];
}

/**
 * What the Overseer decides after reading a phase's verdict + prior summaries (never raw
 * transcripts). "repair" replaces the old phase-only "retry": it names which phase should run
 * next to address the finding (that phase itself for an ordinary retry, or an earlier phase when
 * the defect belongs there — see pipeline.ts's REPAIR_TRANSITIONS). Pipeline code, not this
 * decision alone, has the final say on whether a run can be accepted — see runPipeline's
 * enforcement of `verdict.outcome`.
 */
export interface OverseerDecision {
  action: "continue" | "repair" | "stop";
  reasoning: string;
  /** Required when action is "repair": which phase should run next. */
  repairTarget?: PhaseName;
  feedbackForRepair?: string;
}

/** A human-approved decision, recorded by the controller (never by a worker's own file write) —
 * see docs/STRESS-TEST-REPORT.md's finding on DECISIONS.md being treated as self-executing. */
export interface TrustedDecision {
  id: string;
  runId: string;
  text: string;
  recordedAt: string;
}

export type AgentEvent =
  | { type: "run-start"; runId: string; task: string; ts: string }
  | { type: "run-end"; runId: string; status: RunRecord["status"]; ts: string }
  | { type: "phase-start"; runId: string; phase: PhaseName; attempt: number; ts: string }
  | { type: "phase-end"; runId: string; phase: PhaseName; attempt: number; verdict: PhaseVerdict; ts: string }
  | { type: "overseer-decision"; runId: string; phase: PhaseName; decision: OverseerDecision; ts: string }
  | { type: "assistant-text"; runId: string; phase: PhaseName; text: string; ts: string }
  | { type: "thinking"; runId: string; phase: PhaseName; text: string; ts: string }
  | {
      type: "tool-call";
      runId: string;
      phase: PhaseName;
      toolUseId: string;
      toolName: string;
      toolInput: unknown;
      ts: string;
    }
  | {
      type: "tool-result";
      runId: string;
      phase: PhaseName;
      toolUseId: string;
      toolName: string;
      isError: boolean;
      summary: string;
      ts: string;
    }
  | {
      type: "approval-request";
      runId: string;
      phase: PhaseName;
      requestId: string;
      toolUseId: string;
      toolName: string;
      toolInput: unknown;
      ts: string;
    }
  | {
      type: "approval-resolved";
      runId: string;
      phase: PhaseName;
      requestId: string;
      decision: "allow" | "deny";
      reason?: string;
      auto: boolean;
      ts: string;
    }
  | { type: "decisions-log-updated"; runId: string; content: string; ts: string }
  | { type: "trusted-decision-recorded"; runId: string; phase: PhaseName; text: string; ts: string };

export interface ApprovalDecision {
  decision: "allow" | "deny";
  reason?: string;
}

export interface PipelineConfig {
  task: string;
  workDir: string;
  /** If true, every tool call is routed through the human-approval UI. If false, only the safety hook applies. */
  requireApproval: boolean;
  /** Max retries per phase before the Overseer is forced to stop instead of retry again. */
  maxRetriesPerPhase: number;
  /** Max total repairs across the whole run (including ones routed to an earlier phase) — bounds
   * e.g. a builder<->verifier ping-pong that never hits any single phase's own retry limit. */
  maxTotalRepairs: number;
  /** Port for the event-bus / approval UI HTTP+WS server. */
  uiPort: number;
}
