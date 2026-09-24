// Pass-through wrapper around the real SDK that appends cost/turns/time per query() to $COST_LOG
// (agent-loop itself records no cost). Used by real_runs.sh.
import * as real from "../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import { appendFileSync } from "node:fs";
export * from "../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
export function query(args) {
  const it = real.query(args);
  const t = Date.now();
  const role = (args.options?.systemPrompt?.match(/You are the ([A-Za-z-]+)/) || [])[1] || "?";
  return (async function* () {
    for await (const m of it) {
      if (m.type === "result" && process.env.COST_LOG)
        appendFileSync(process.env.COST_LOG, JSON.stringify({ role, cost: m.total_cost_usd, turns: m.num_turns, secs: (Date.now() - t) / 1000, sub: m.subtype }) + "\n");
      yield m;
    }
  })();
}
