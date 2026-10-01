import { query } from "@anthropic-ai/claude-agent-sdk";
import { minimalEnv } from "./env.js";
import type { Generate } from "./roast.js";

/** Small and quick: a few lines of text from numbers does not need a large model. Override with $AGENT_LOOP_ROAST_MODEL. */
export const DEFAULT_ROAST_MODEL = "claude-haiku-4-5-20251001";

/**
 * The model call behind `agent-loop insights --roast api`: one tool-less turn, the same shape as the Overseer's
 * (`tools: []` really removes every tool, see src/env.ts), with only the allowlisted environment. Whatever comes
 * back is untrusted text: src/roast.ts validates every line before anything is printed.
 */
export function claudeGenerate(model = process.env.AGENT_LOOP_ROAST_MODEL || DEFAULT_ROAST_MODEL): Generate {
  return async ({ system, prompt }) => {
    let text = "";
    let costUsd = 0;
    const stream = query({
      prompt,
      options: { systemPrompt: system, tools: [], model, maxTurns: 1, env: minimalEnv() },
    });
    for await (const message of stream as AsyncIterable<Record<string, any>>) {
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) if (block.type === "text") text = block.text;
      } else if (message.type === "result") {
        costUsd = Number(message.total_cost_usd ?? 0);
      }
    }
    return { text, costUsd };
  };
}
