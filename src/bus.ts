import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AgentEvent, ApprovalDecision, PhaseName } from "./types.js";
import type { Store } from "./store.js";

type ApprovalRequestEvent = Extract<AgentEvent, { type: "approval-request" }>;

interface PendingApproval {
  resolve: (d: ApprovalDecision) => void;
  /** Kept so a UI tab that connects (or reloads) while this is pending can be shown it again. */
  event: ApprovalRequestEvent;
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
/** Enough for a long run's transcript; older events are still in the Store, just not replayed. */
const HISTORY_LIMIT = 5000;

/**
 * Events that give a replayed page its shape. When the history is too long, trimming drops bulk (tool calls, their
 * output, text, snapshots) oldest-first and keeps these, so a reload of a very long run, and its saved report, still
 * know the task, every phase, what it cost, what the Overseer decided and what the human answered. Trimming from the
 * front blindly lost `run-start` and `phase-start` after about 2,500 tool calls.
 */
export const STRUCTURAL_EVENTS: ReadonlySet<string> = new Set([
  "run-start", "run-end", "stop-requested", "phase-start", "phase-end", "overseer-decision", "usage",
  "approval-resolved", "trusted-decision-recorded", "decisions-log-updated", "report-saved",
  "browser-session-started", "browser-session-ended", "desktop-session-started", "desktop-session-ended", "lineage-updated",
]);

export class EventBus extends EventEmitter {
  private pending = new Map<string, PendingApproval>();
  /** Everything emitted this process, so a tab opened mid-run (or reloaded) sees the whole transcript. */
  private history: AgentEvent[] = [];
  /** "Don't ask again" rules a human created this run, e.g. `Bash(npm test:*)` or `Write`. */
  private allowRules = new Set<string>();
  /** Desktop input requests a human refused in a row; one they allowed resets it (see hooks.ts). */
  private inputDenialStreak = 0;

  /** How many events are kept for replay; a test can lower it. */
  private historyLimit: number;

  constructor(private store?: Store, opts: { historyLimit?: number } = {}) {
    super();
    this.historyLimit = opts.historyLimit ?? HISTORY_LIMIT;
  }

  emitEvent(event: AgentEvent) {
    const phase = "phase" in event ? (event.phase ?? null) : null;
    // A lineage snapshot is derived from the events already stored (agent-loop lineage rebuilds it), so it
    // isn't stored again; and only the newest per run is kept for a tab that connects later.
    if (event.type === "lineage-updated") this.history = this.history.filter((e) => !(e.type === "lineage-updated" && e.runId === event.runId));
    else this.store?.logEvent(event.runId, phase, event.type, event);
    this.history.push(event);
    this.trimHistory();
    this.emit("event", event);
  }

  /**
   * Keeps the history near its limit without losing its structure. It trims in chunks (a quarter of the limit past it),
   * so a long run is not re-scanned on every event, and drops the oldest non-structural events first.
   */
  private trimHistory() {
    const slack = Math.max(1, Math.floor(this.historyLimit / 4));
    if (this.history.length <= this.historyLimit + slack) return;
    let drop = this.history.length - this.historyLimit;
    const kept: AgentEvent[] = [];
    for (const e of this.history) {
      if (drop > 0 && !STRUCTURAL_EVENTS.has(e.type)) drop--;
      else kept.push(e);
    }
    // Only structural events left over the limit (absurd, but bounded): drop the oldest of those rather than grow forever.
    this.history = drop > 0 ? kept.slice(drop) : kept;
  }

  /**
   * What a newly connected UI should be sent: the run so far, minus approval requests that were
   * already decided (their outcome is carried by the approval-resolved event that follows them).
   */
  replay(): AgentEvent[] {
    return this.history.filter((e) => e.type !== "approval-request" || this.pending.has(e.requestId));
  }

  /** Every event this process emitted (up to the history limit), for writing a saved report. */
  allEvents(): AgentEvent[] {
    return [...this.history];
  }

  addAllowRule(rule: string) {
    this.allowRules.add(rule);
  }

  hasAllowRule(rule: string): boolean {
    return this.allowRules.has(rule);
  }

  /** How many desktop input requests in a row a human has refused. */
  get desktopInputDenials(): number {
    return this.inputDenialStreak;
  }

  noteDesktopInputDecision(decision: "allow" | "deny") {
    this.inputDenialStreak = decision === "deny" ? this.inputDenialStreak + 1 : 0;
  }

  /** Called by a PreToolUse hook. Resolves once a human (or auto-policy) decides. */
  requestApproval(base: {
    runId: string;
    phase: PhaseName;
    toolUseId: string;
    toolName: string;
    toolInput: unknown;
    rule?: string;
  }): { requestId: string; wait: Promise<ApprovalDecision> } {
    const requestId = randomUUID();
    const event: ApprovalRequestEvent = {
      type: "approval-request",
      runId: base.runId,
      phase: base.phase,
      requestId,
      toolUseId: base.toolUseId,
      toolName: base.toolName,
      toolInput: base.toolInput,
      rule: base.rule,
      ts: new Date().toISOString(),
    };
    const wait = new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(requestId, { resolve, event });
    });
    this.emitEvent(event);
    return { requestId, wait };
  }

  /** Refuses every approval still waiting (the run is being stopped), so no prompt is left open on a run that is over. */
  denyAllPending(reason: string): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.resolveApproval(id, { decision: "deny", reason });
    return ids.length;
  }

  resolveApproval(requestId: string, decision: ApprovalDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    pending.resolve(decision);
    return true;
  }

  /** Called only from the controller-mediated approval-UI path (server.ts) when a human actually
   * records a decision — never reachable from a worker phase. Persists to the Store's
   * trusted_decisions table (the only source overseerDecide treats as settled) and broadcasts it. */
  recordDecision(runId: string, phase: PhaseName, text: string) {
    const decision = this.store?.recordTrustedDecision(runId, text);
    if (!decision) return undefined;
    this.emitEvent({ type: "trusted-decision-recorded", runId, phase, text, ts: decision.recordedAt });
    return decision;
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** Approval requests still waiting on a human, oldest first. */
  pendingRequests(): ApprovalRequestEvent[] {
    return [...this.pending.values()].map((p) => p.event);
  }
}
