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

/** What a phase itself reports about its own work — short, structured, never a full transcript. */
export interface PhaseVerdict {
  success: boolean;
  headline: string;
  details: string;
  concerns: string[];
}

/** What the Overseer decides after reading a phase's verdict + prior summaries (never raw transcripts). */
export interface OverseerDecision {
  action: "continue" | "retry" | "stop";
  reasoning: string;
  feedbackForRetry?: string;
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
    };

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
  /** Port for the event-bus / approval UI HTTP+WS server. */
  uiPort: number;
}
