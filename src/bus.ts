import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AgentEvent, ApprovalDecision, PhaseName } from "./types.js";
import type { Store } from "./store.js";

interface PendingApproval {
  resolve: (d: ApprovalDecision) => void;
}

/**
 * The event bus is the single spine connecting the orchestrator, the
 * approval hook, and the UI: every step (thinking / tool-call / tool-result)
 * flows out through `emit`, and human approve/deny decisions flow back in
 * through `resolveApproval`. The approval hook awaits `requestApproval`
 * directly — it is a real blocking round-trip, not fire-and-forget.
 *
 * `emitEvent` also persists every event to the Store (when one is given at construction), not just
 * the WebSocket broadcast — a run with nobody watching the live UI would otherwise leave zero
 * durable record of phase transitions, Overseer reasoning, or approvals, which defeats the point of
 * having an indexed history at all.
 */
export class EventBus extends EventEmitter {
  private pending = new Map<string, PendingApproval>();

  constructor(private store?: Store) {
    super();
  }

  emitEvent(event: AgentEvent) {
    const phase = "phase" in event ? event.phase : null;
    this.store?.logEvent(event.runId, phase, event.type, event);
    this.emit("event", event);
  }

  /** Called by a PreToolUse hook. Resolves once a human (or auto-policy) decides. */
  requestApproval(base: {
    runId: string;
    phase: PhaseName;
    toolUseId: string;
    toolName: string;
    toolInput: unknown;
  }): { requestId: string; wait: Promise<ApprovalDecision> } {
    const requestId = randomUUID();
    const wait = new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(requestId, { resolve });
    });
    this.emitEvent({
      type: "approval-request",
      runId: base.runId,
      phase: base.phase,
      requestId,
      toolUseId: base.toolUseId,
      toolName: base.toolName,
      toolInput: base.toolInput,
      ts: new Date().toISOString(),
    });
    return { requestId, wait };
  }

  resolveApproval(requestId: string, decision: ApprovalDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    pending.resolve(decision);
    return true;
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }
}
