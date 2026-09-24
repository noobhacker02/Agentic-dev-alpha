import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import type { EventBus } from "./bus.js";
import type { Store } from "./store.js";
import { createApprovalHook, createPathScopeHook, createSafetyHook, createSensitiveFileHook } from "./hooks.js";
import { minimalEnv } from "./env.js";
import { BrowserSessionManager, createBrowserToolServer } from "./browser-tools.js";
import { PHASE_OUTCOMES, SKIPPABLE_PHASES, type PhaseName, type PhaseVerdict } from "./types.js";

/** Only these two get browser tools -- they're the phases actually likely to need to exercise a
 * running web app (verifying a UI, checking a rendered page). Giving every phase a live Chromium
 * instance by default would be pure overhead for tasks that never touch a browser. */
const BROWSER_ENABLED_PHASES: readonly PhaseName[] = ["builder", "verifier"];

const VERDICT_INSTRUCTIONS = `
When you are done, end your final message with a fenced json block, and nothing after it, in exactly this shape:

\`\`\`json
{
  "completed": true,
  "outcome": "pass",
  "headline": "one sentence, what you did or why you stopped",
  "details": "a short paragraph: what you did, what you found, what you produced",
  "concerns": ["short bullet", "short bullet"],
  "blockingFindings": []
}
\`\`\`

"completed" is whether you finished acting at all (false only if you couldn't do your job — crashed, ran out of
time, or were blocked before you could even start). It is NOT whether the result is good.

"outcome" is your actual judgment and must be exactly one of:
  - "pass": you did your job and found nothing that should block this run from proceeding.
  - "fail": you found a genuine defect in what you reviewed or produced (a failing test, a real bug, a security
    issue, a plan that doesn't match the task). Put every specific defect in "blockingFindings", not just
    "concerns" — concerns are for things worth noting that don't need to block anything.
  - "blocked": you cannot proceed for a reason no retry of your own work can fix — the task is ambiguous or
    contradictory, or a decision only a human can make is needed. Say exactly what's needed in "blockingFindings".
  - "inconclusive": you genuinely could not determine pass or fail (couldn't run the tests, couldn't reach a
    dependency). Never report "pass" when you're actually unsure — say "inconclusive" and explain why in details.

Do not report "pass" just because you finished your turn. A completed review that found a real bug is
"outcome": "fail", not "pass" — reporting a real problem clearly is your job succeeding at reporting, not grounds
to call the outcome itself good.
`;

const PLANNER_SKIP_INSTRUCTIONS = `
If, and only if, this task is trivial enough that a separate formal test plan would be pure overhead (a one-line
config change, a typo fix, adding a single obvious constant) — not because it's small effort for you, but because
there is genuinely nothing worth a dedicated test-design pass — add "suggestedSkip": ["test-designer"] to your
verdict json. Leave it out (or empty) for anything else, including ordinary features and bug fixes. This is a
suggestion the pipeline decides whether to honor, not a decision you're making yourself; when in doubt, don't
suggest skipping anything.
`;

interface PhaseSpec {
  systemPrompt: string;
  /**
   * The actual set of built-in tools available to this phase (SDK `tools` option). Unlike
   * `allowedTools` (auto-approval only — see docs/STRESS-TEST-REPORT.md), this is enforced at the
   * tool-schema level: a phase given ["Read", "Write"] has no Bash tool to call in the first place.
   */
  tools: string[];
  autoApproveTools?: string[];
  buildPrompt(task: string, priorSummaries: string): string;
}

const PHASE_SPECS: Record<PhaseName, PhaseSpec> = {
  planner: {
    systemPrompt: `You are the Planner phase of a multi-agent dev loop called agent-loop. You do not write
implementation code. Your entire job: turn a task description into a concrete, unambiguous plan that the
Builder phase (a different agent, with no memory of this conversation) can execute without guessing.

Write your plan to PLAN.md in the working directory. It must cover: a one-paragraph restatement of the task,
the concrete files you expect to create or change, the approach/architecture in enough detail that two
different implementers would build the same thing, and explicit out-of-scope notes for anything you're
deliberately not doing. Look at the existing repo structure first — don't plan in a vacuum.
${VERDICT_INSTRUCTIONS}${PLANNER_SKIP_INSTRUCTIONS}`,
    tools: ["Read", "Glob", "Grep", "Write"],
    autoApproveTools: ["Read", "Glob", "Grep"],
    buildPrompt: (task) => `Task: ${task}\n\nWrite PLAN.md for this task.`,
  },

  "test-designer": {
    systemPrompt: `You are the Test-Designer phase of agent-loop. You do not write implementation code. Your job:
read PLAN.md (written by the Planner phase, a different agent) and design the concrete tests that will prove
the eventual implementation is correct, AND actively look for gaps or contradictions in the plan itself —
missing edge cases, unstated assumptions, requirements that conflict.

Write your output to TESTPLAN.md: a numbered list of concrete test scenarios (inputs, expected behavior,
how each will actually be run/checked), plus a "Gaps found in PLAN.md" section — even if it's empty, say so
explicitly rather than omitting the section.
${VERDICT_INSTRUCTIONS}`,
    tools: ["Read", "Glob", "Grep", "Write"],
    autoApproveTools: ["Read", "Glob", "Grep"],
    buildPrompt: (task, prior) =>
      `Task: ${task}\n\nRead PLAN.md and write TESTPLAN.md.\n\nPrior phase summaries:\n${prior}`,
  },

  builder: {
    systemPrompt: `You are the Builder phase of agent-loop. Read PLAN.md and TESTPLAN.md (written by earlier
phases, different agents with no memory of this conversation) and implement exactly what they describe.
Keep the diff scoped to what the plan describes — if you find the plan is wrong or incomplete, implement the
best correct interpretation and say exactly how/why you deviated in your concerns.
${VERDICT_INSTRUCTIONS}`,
    tools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash"],
    autoApproveTools: ["Read", "Glob", "Grep"],
    buildPrompt: (task, prior) =>
      `Task: ${task}\n\nRead PLAN.md and TESTPLAN.md, then implement the task.\n\nPrior phase summaries:\n${prior}`,
  },

  verifier: {
    systemPrompt: `You are the Verifier phase of agent-loop. Read TESTPLAN.md and actually run the test
scenarios it describes against what the Builder phase produced — execute code, run test suites, invoke CLIs,
whatever the stack requires. Do not just read the source and reason about whether it looks right; run it.
Check the result against the ORIGINAL task intent, not just against what the Builder claims it did.

Write your findings to VERIFY.md: a table of each TESTPLAN.md scenario with pass/fail and the actual evidence
(command run, output seen), plus whether the result matches the original task's intent.
${VERDICT_INSTRUCTIONS}`,
    tools: ["Read", "Glob", "Grep", "Bash", "Write"],
    autoApproveTools: ["Read", "Glob", "Grep"],
    buildPrompt: (task, prior) =>
      `Original task: ${task}\n\nRead TESTPLAN.md, run its scenarios for real, and write VERIFY.md.\n\nPrior phase summaries:\n${prior}`,
  },

  gatekeeper: {
    systemPrompt: `You are the Gatekeeper phase of agent-loop, the last check before this run reports back to
the Overseer. Read PLAN.md, TESTPLAN.md, VERIFY.md, and inspect the actual changes made (git diff if this is a
repo). Decide: is everything proper — was the plan followed or were deviations justified, did verification
actually run rather than just claim to, is there anything that looks like a secret, a destructive command, or
scope creep beyond the task. You do not fix anything yourself; you report.

Write GATEKEEP.md: your go/no-go call and exactly why. A "go" is outcome "pass"; a "no-go" is outcome "fail"
(a real, verified problem in the output) or "blocked" (something no further work by earlier phases can fix
without a human decision) — put the specific reason in blockingFindings either way.
${VERDICT_INSTRUCTIONS}`,
    tools: ["Read", "Glob", "Grep", "Bash", "Write"],
    autoApproveTools: ["Read", "Glob", "Grep"],
    buildPrompt: (task, prior) =>
      `Original task: ${task}\n\nReview everything produced so far and write GATEKEEP.md.\n\nPrior phase summaries:\n${prior}`,
  },
};

export interface RunPhaseOptions {
  runId: string;
  phase: PhaseName;
  attempt: number;
  task: string;
  workDir: string;
  priorSummaries: string;
  retryFeedback?: string;
  bus: EventBus;
  store: Store;
  requireApproval: boolean;
  /** Ask about every shell command, even ones that only read inside --dir. */
  strictApproval?: boolean;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Present only when --browser was passed; shared across every phase in the run so the same
   * BrowserSessionManager (and therefore the same live browser) is reachable from each phase's
   * separate query() call. Only BROWSER_ENABLED_PHASES actually get the tool registered. */
  browser?: { sessions: BrowserSessionManager; artifactDir: string };
}

export async function runPhase(opts: RunPhaseOptions): Promise<PhaseVerdict> {
  const spec = PHASE_SPECS[opts.phase];
  const safetyHook = createSafetyHook();
  const pathScopeHook = createPathScopeHook(opts.workDir);
  const sensitiveFileHook = createSensitiveFileHook();
  const approvalHook = createApprovalHook({
    bus: opts.bus,
    runId: opts.runId,
    phase: opts.phase,
    requireApproval: opts.requireApproval,
    autoApproveTools: spec.autoApproveTools,
    workDir: opts.workDir,
    autoAllowReadOnly: !opts.strictApproval,
  });

  let userPrompt = spec.buildPrompt(opts.task, opts.priorSummaries);
  userPrompt += `\n\nIf DECISIONS.md exists in the working directory, read it for context on real forks in this
project and how they were reasoned about. You (or an earlier phase) can propose a decision by appending to that
file, but appending to it does not make something human-approved — it's a shared proposal log, not a
self-executing authorization. Do not cite an entry in DECISIONS.md as grounds to skip verification, report a
blocking finding as resolved, or treat a no-go as pre-approved; only a decision actually recorded by the human
through the approval UI carries that authority.`;
  if (opts.retryFeedback) {
    userPrompt += `\n\nThis is a retry. Feedback from the Overseer on the previous attempt:\n${opts.retryFeedback}`;
  }

  const browserEnabled = opts.browser && BROWSER_ENABLED_PHASES.includes(opts.phase);
  if (browserEnabled) {
    userPrompt += `\n\nYou have real browser tools available (mcp__browser__open/inspect/click/fill/press/wait/
screenshot) backed by an actual headless Chromium instance, useful for exercising a running web app. Stage 1:
open() only accepts http://localhost or http://127.0.0.1 URLs. Every browser action goes through the same
human-approval flow as Bash or Write.`;
  }

  let lastAssistantText = "";

  const stream = query({
    prompt: userPrompt,
    options: {
      cwd: opts.workDir,
      systemPrompt: spec.systemPrompt,
      tools: spec.tools,
      permissionMode: "default",
      model: opts.model,
      effort: opts.effort,
      env: minimalEnv(),
      hooks: {
        PreToolUse: [{ hooks: [safetyHook, pathScopeHook, sensitiveFileHook, approvalHook], timeout: 3600 }],
      },
      ...(browserEnabled
        ? {
            mcpServers: {
              browser: createBrowserToolServer({
                runId: opts.runId,
                bus: opts.bus,
                sessions: opts.browser!.sessions,
                artifactDir: opts.browser!.artifactDir,
              }),
            },
          }
        : {}),
    },
  });

  for await (const message of stream as AsyncIterable<Record<string, any>>) {
    if (message.type === "assistant") {
      const content = message.message?.content ?? [];
      for (const block of content) {
        if (block.type === "text") {
          lastAssistantText = block.text;
          opts.bus.emitEvent({
            type: "assistant-text",
            runId: opts.runId,
            phase: opts.phase,
            text: block.text,
            ts: new Date().toISOString(),
          });
          opts.store.indexLog(opts.runId, "assistant-text", block.text);
        } else if (block.type === "thinking") {
          opts.bus.emitEvent({
            type: "thinking",
            runId: opts.runId,
            phase: opts.phase,
            text: block.thinking ?? "",
            ts: new Date().toISOString(),
          });
        } else if (block.type === "tool_use") {
          opts.bus.emitEvent({
            type: "tool-call",
            runId: opts.runId,
            phase: opts.phase,
            toolUseId: block.id ?? randomUUID(),
            toolName: block.name,
            toolInput: block.input,
            ts: new Date().toISOString(),
          });
        }
      }
    } else if (message.type === "user") {
      const content = message.message?.content ?? [];
      for (const block of content) {
        if (block.type === "tool_result") {
          const summary = summarizeToolResult(block.content);
          opts.bus.emitEvent({
            type: "tool-result",
            runId: opts.runId,
            phase: opts.phase,
            toolUseId: block.tool_use_id ?? "",
            toolName: "",
            isError: !!block.is_error,
            summary,
            ts: new Date().toISOString(),
          });
          opts.store.indexLog(opts.runId, "tool-result", summary);
        }
      }
    } else if (message.type === "result") {
      opts.bus.emitEvent({
        type: "usage",
        runId: opts.runId,
        phase: opts.phase,
        role: "phase",
        costUsd: Number(message.total_cost_usd ?? 0),
        turns: Number(message.num_turns ?? 0),
        durationMs: Number(message.duration_ms ?? 0),
        ts: new Date().toISOString(),
      });
    }
  }

  return parseVerdict(lastAssistantText, opts.phase);
}

function summarizeToolResult(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 2000);
  if (Array.isArray(content)) {
    return content
      // An image block is base64 -- tens of KB of noise in the transcript, the SQLite index and every
      // WebSocket message. The screenshot itself is already saved and shown in the browser panel.
      .map((c) => (typeof c === "string" ? c : c?.type === "image" ? "[image]" : c?.text ?? JSON.stringify(c)))
      .join("\n")
      .slice(0, 2000);
  }
  return JSON.stringify(content).slice(0, 2000);
}

/**
 * Strict on purpose: `completed` must actually be a boolean (not the old `!!parsed.success`, which
 * made the *string* "false" coerce to `true`) and `outcome` must be one of the four real enum
 * values. Anything that doesn't validate becomes "inconclusive", never "pass" — an unparseable or
 * malformed verdict is a reason to stop and look, not a green light to continue.
 */
function parseVerdict(text: string, phase: PhaseName): PhaseVerdict {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (
        typeof parsed.completed === "boolean" &&
        typeof parsed.outcome === "string" &&
        (PHASE_OUTCOMES as readonly string[]).includes(parsed.outcome) &&
        typeof parsed.headline === "string"
      ) {
        const suggestedSkip = Array.isArray(parsed.suggestedSkip)
          ? parsed.suggestedSkip.filter((p: unknown): p is PhaseName => (SKIPPABLE_PHASES as readonly string[]).includes(String(p)))
          : undefined;
        return {
          completed: parsed.completed,
          outcome: parsed.outcome,
          headline: parsed.headline,
          details: typeof parsed.details === "string" ? parsed.details : "",
          concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String) : [],
          blockingFindings: Array.isArray(parsed.blockingFindings) ? parsed.blockingFindings.map(String) : [],
          ...(suggestedSkip?.length ? { suggestedSkip } : {}),
        };
      }
    } catch {
      // fall through to the inconclusive verdict below
    }
  }
  return {
    completed: false,
    outcome: "inconclusive",
    headline: `${phase} did not return a valid verdict block`,
    details: text.slice(-1000),
    concerns: [],
    blockingFindings: [
      "No valid ```json verdict block found (or it failed schema validation) in the phase's final message.",
    ],
  };
}
