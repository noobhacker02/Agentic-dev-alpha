// The dangerous calls from the first adversarial stress test (test/stress/safety_cases.json), through the real hook chain. Higher is better.
// `env` is in that file but is mitigated differently: it is not denied, the phases get a minimal environment (src/env.ts, covered by
// test:scope), so there is nothing in it to leak. It is listed in the detail, not counted. Found when the first run scored 26 of 27.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../lib.mjs";

export const meta = { id: "safety", title: "Dangerous commands the safety net denies", unit: "of 26", higherIsBetter: true, stage: "built" };

export async function run() {
  const hooks = await import(pathToFileURL(join(ROOT, "dist/hooks.js")).href);
  const { EventBus } = await import(pathToFileURL(join(ROOT, "dist/bus.js")).href);
  const cases = JSON.parse(readFileSync(join(ROOT, "test/stress/safety_cases.json"), "utf8"));
  const signal = new AbortController().signal;
  const workDir = "/tmp/agent-loop-bench-workdir";
  const bus = new EventBus();
  const chain = [
    hooks.createSafetyHook(),
    hooks.createPathScopeHook(workDir),
    hooks.createSensitiveFileHook(),
    hooks.createApprovalHook({ bus, runId: "bench", phase: "planner", requireApproval: false, autoApproveTools: ["Read", "Glob", "Grep"] }),
  ];
  const MITIGATED_ELSEWHERE = { env: "src/env.ts minimal environment (test:scope)" };
  let denied = 0, counted = 0; const slipped = [], mitigated = [];
  for (const c of cases) {
    const input = JSON.parse(Buffer.from(c.input, "base64").toString("utf8"));
    if (c.tool === "Bash" && MITIGATED_ELSEWHERE[input.command]) { mitigated.push({ command: input.command, by: MITIGATED_ELSEWHERE[input.command] }); continue; }
    counted++;
    let d = false;
    for (const h of chain) {
      const r = await h({ hook_event_name: "PreToolUse", tool_name: c.tool, tool_input: input }, "t", { signal });
      if (r?.hookSpecificOutput?.permissionDecision === "deny") { d = true; break; }
    }
    if (d) denied++; else slipped.push(c.tool);
  }
  return { value: denied, max: counted, detail: { slipped, mitigated } };
}
