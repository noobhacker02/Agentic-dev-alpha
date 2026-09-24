import { query } from "@anthropic-ai/claude-agent-sdk";
import type { OverseerDecision, PhaseName, PhaseVerdict } from "./types.js";

const OVERSEER_SYSTEM_PROMPT = `You are the Overseer of agent-loop, a multi-agent dev pipeline with five
worker phases run in order: planner, test-designer, builder, verifier, gatekeeper. You do not see their full
transcripts, tool calls, or reasoning — only the short structured verdict each phase reports when it finishes.
This is deliberate: your job is to make a judgment call from a human-readable summary, the way a lead would
read a status update from a report, not to re-derive everything the worker already did.

After each phase, decide one of:
- "continue": move on to the next phase in the pipeline.
- "retry": send the same phase back with specific feedback on what to fix (only for a phase whose own verdict
  reports success:false, or whose concerns describe something a retry could plausibly fix).
- "stop": end the run now. Use this when a phase's concerns describe something no retry of that phase can fix
  (an ambiguous or contradictory original task, a fundamental architecture problem the plan itself should be
  redone for, or the gatekeeper reporting a no-go with a real, verified problem in the final output).

You may also be given a project's DECISIONS.md — a running log of real forks in the project's direction and
which way each one went, written by whichever phase encountered them. Treat every entry there as settled: if a
phase's concerns second-guess or reopen something already decided there, that is not itself a reason to retry
— the decision was deliberate, not a mistake to fix. Use it the way a lead uses a decision log: context for
judging whether a phase's choices made sense, not something to relitigate.

Respond with nothing but a fenced json block:
\`\`\`json
{ "action": "continue" | "retry" | "stop", "reasoning": "one or two sentences", "feedbackForRetry": "only present if action is retry" }
\`\`\`
`;

export async function overseerDecide(opts: {
  task: string;
  phase: PhaseName;
  attempt: number;
  maxRetries: number;
  verdict: PhaseVerdict;
  priorSummaries: Array<{ name: PhaseName; attempt: number; status: string; summary: string | null }>;
  /** Current content of the project's DECISIONS.md, if one exists in the working directory. */
  decisionsLog?: string;
  model?: string;
}): Promise<OverseerDecision> {
  if (opts.attempt > opts.maxRetries) {
    return {
      action: opts.verdict.success ? "continue" : "stop",
      reasoning: opts.verdict.success
        ? "Phase eventually succeeded within the retry budget."
        : `Retry budget (${opts.maxRetries}) exhausted for ${opts.phase} without success.`,
    };
  }

  const summaryText = opts.priorSummaries
    .map((s) => `- ${s.name} (attempt ${s.attempt}, ${s.status}): ${s.summary ?? "(no summary)"}`)
    .join("\n");

  const decisionsSection = opts.decisionsLog
    ? `\nProject decision log (DECISIONS.md — treat every entry as settled, not up for debate):\n${opts.decisionsLog}\n`
    : "";

  const prompt = `Original task: ${opts.task}

Phase history so far (short summaries only):
${summaryText || "(this is the first phase)"}
${decisionsSection}
The phase that just finished: ${opts.phase} (attempt ${opts.attempt} of max ${opts.maxRetries + 1})
Its verdict:
  success: ${opts.verdict.success}
  headline: ${opts.verdict.headline}
  details: ${opts.verdict.details}
  concerns: ${opts.verdict.concerns.join("; ") || "(none)"}

Decide: continue, retry, or stop.`;

  let lastText = "";
  const stream = query({
    prompt,
    options: {
      systemPrompt: OVERSEER_SYSTEM_PROMPT,
      allowedTools: [],
      model: opts.model,
      effort: "high",
      env: { ...process.env },
    },
  });

  for await (const message of stream as AsyncIterable<Record<string, any>>) {
    if (message.type === "assistant") {
      for (const block of message.message?.content ?? []) {
        if (block.type === "text") lastText = block.text;
      }
    }
  }

  const match = lastText.match(/```json\s*([\s\S]*?)```/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.action === "continue" || parsed.action === "retry" || parsed.action === "stop") {
        return {
          action: parsed.action,
          reasoning: String(parsed.reasoning ?? ""),
          feedbackForRetry: parsed.feedbackForRetry ? String(parsed.feedbackForRetry) : undefined,
        };
      }
    } catch {
      // fall through
    }
  }

  // Fail safe: if the Overseer itself didn't return a parseable decision, don't silently
  // loop forever — stop and surface it as a real problem rather than guessing.
  return {
    action: opts.verdict.success ? "continue" : "stop",
    reasoning: "Overseer did not return a parseable decision; falling back to the phase's own verdict.",
  };
}
