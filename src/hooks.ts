import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { EventBus } from "./bus.js";
import type { PhaseName } from "./types.js";

/**
 * Patterns that are denied outright, before the request even reaches the
 * human approval UI. This is a narrow, defense-in-depth backstop (mirrors
 * dev-workflow's own destructive-command list) — the approval UI is the
 * actual control surface; this just stops the handful of operations no
 * human should have to be asked about twice.
 */
const HARD_DENY_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+\/(?:\s|$)/i,
  /rm\s+-rf\s+~(?:\s|$)/i,
  /git\s+push\s+.*--force(?!-with-lease)/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, // fork bomb
  /mkfs\./i,
  /dd\s+if=.*of=\/dev\/(sd|nvme|hd)/i,
];

function commandFromInput(toolName: string, toolInput: Record<string, unknown>): string | null {
  if (toolName === "Bash" && typeof toolInput.command === "string") return toolInput.command;
  return null;
}

/** Always-on safety net. Runs alongside the approval hook; a deny from either wins. */
export function createSafetyHook(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;
    const toolInput = (pre.tool_input ?? {}) as Record<string, unknown>;
    const command = commandFromInput(pre.tool_name, toolInput);
    if (command && HARD_DENY_PATTERNS.some((re) => re.test(command))) {
      return {
        hookSpecificOutput: {
          hookEventName: pre.hook_event_name,
          permissionDecision: "deny",
          permissionDecisionReason: `agent-loop safety net: '${command}' matches a hard-denied destructive pattern and is never allowed, even with human approval.`,
        },
      };
    }
    return {};
  };
}

export interface ApprovalHookOptions {
  bus: EventBus;
  runId: string;
  phase: PhaseName;
  /** When false, everything is auto-approved (used for phases that shouldn't interrupt a human, if ever). */
  requireApproval: boolean;
  /** Tools that never need a human's eyes (pure reads) — auto-approved without a round-trip. */
  autoApproveTools?: string[];
}

/**
 * The actual approval-UI mechanism: a PreToolUse hook that blocks on a real
 * human decision via the event bus / WebSocket UI. `canUseTool` alone is
 * insufficient here because many calls get auto-approved before reaching it
 * (see the SDK's 6-step permission evaluation order) — a PreToolUse hook is
 * the one place guaranteed to run for every tool call.
 */
export function createApprovalHook(opts: ApprovalHookOptions): HookCallback {
  const autoApprove = new Set(opts.autoApproveTools ?? []);
  return async (input, toolUseId, { signal }) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;

    if (!opts.requireApproval || autoApprove.has(pre.tool_name)) {
      return {
        hookSpecificOutput: {
          hookEventName: pre.hook_event_name,
          permissionDecision: "allow",
          permissionDecisionReason: opts.requireApproval ? "auto-approved read-only tool" : "approval UI disabled for this run",
        },
      };
    }

    const { requestId, wait } = opts.bus.requestApproval({
      runId: opts.runId,
      phase: opts.phase,
      toolUseId: toolUseId ?? requestIdFallback(),
      toolName: pre.tool_name,
      toolInput: pre.tool_input,
    });

    const decision = await raceWithAbort(wait, signal);

    opts.bus.emitEvent({
      type: "approval-resolved",
      runId: opts.runId,
      phase: opts.phase,
      requestId,
      decision: decision.decision,
      reason: decision.reason,
      auto: false,
      ts: new Date().toISOString(),
    });

    return {
      hookSpecificOutput: {
        hookEventName: pre.hook_event_name,
        permissionDecision: decision.decision,
        permissionDecisionReason: decision.reason ?? `human ${decision.decision} via approval UI`,
      },
    };
  };
}

function requestIdFallback(): string {
  return `no-tool-use-id-${Date.now()}`;
}

async function raceWithAbort<T extends { decision: "allow" | "deny"; reason?: string }>(
  wait: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    return { decision: "deny", reason: "query aborted before approval was given" } as T;
  }
  return new Promise<T>((resolve) => {
    const onAbort = () => resolve({ decision: "deny", reason: "query aborted while awaiting approval" } as T);
    signal.addEventListener("abort", onAbort, { once: true });
    wait.then((d) => {
      signal.removeEventListener("abort", onAbort);
      resolve(d);
    });
  });
}
