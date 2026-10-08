// The model behind `agent-loop reel`: one tool-less turn (`tools: []` removes every tool, src/env.ts), only the allowlisted environment, frames sent as image blocks. Whatever comes back is untrusted text that
// src/reel/read.ts and src/reel/judge.ts validate. NOT exercised against the real model in the test suite (no API spend in tests); the command is tested with an injected reader.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { minimalEnv } from "../env.js";
import type { Reader } from "./reel-command.js";

export const DEFAULT_REEL_MODEL = "claude-haiku-4-5-20251001";

export function claudeReader(model = process.env.AGENT_LOOP_REEL_MODEL || DEFAULT_REEL_MODEL): Reader {
  return async (_kind, system, prompt, images) => {
    const content: Array<Record<string, unknown>> = images.slice(0, 12).map((f) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: readFileSync(f).toString("base64") } }));
    content.push({ type: "text", text: prompt });
    async function* input() { yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" }; }
    let text = "";
    const stream = query({ prompt: input() as never, options: { systemPrompt: system, tools: [], model, maxTurns: 1, env: minimalEnv() } });
    for await (const message of stream as AsyncIterable<Record<string, any>>) {
      if (message.type === "assistant") for (const block of message.message?.content ?? []) if (block.type === "text") text = block.text;
    }
    return text;
  };
}
