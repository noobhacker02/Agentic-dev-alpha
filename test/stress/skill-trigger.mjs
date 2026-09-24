// How often does Claude actually invoke the dev-workflow skill on its own? Real API calls (~$0.50).
// Each prompt runs in a fresh repo with the skill installed, every tool call denied (so nothing is
// built), and only the first few turns watched for a Skill invocation.
//
//   node test/stress/skill-trigger.mjs            # current published skill (see resolve-skill-source.mjs)
//   DEV_WORKFLOW_SKILL_PATH=../Dev-Skill/dev-workflow node test/stress/skill-trigger.mjs
//
// The prompts are deliberately not the examples in the skill's own description.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, mkdirSync, cpSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDevWorkflowSkillPath } from "../resolve-skill-source.mjs";

const SKILL = resolveDevWorkflowSkillPath();
const prompts = [
  ["Add pagination to the /users list endpoint in server.js.", true],
  ["The date formatter shows the wrong month in January, please fix it.", true],
  ["Make a small script that renames all .jpeg files to .jpg in a folder.", true],
  ["Add a dark mode toggle to the settings page.", true],
  ["Write unit tests for the cart total calculation.", true],
  ["Create a Go CLI that counts lines of code by language.", true],
  ["Add rate limiting to the login route.", true],
  ["Split server.js into smaller modules.", true],
  ["What does the Node.js event loop actually do? Just explain, no code changes.", false],
  ["Explain what the regex ^a+b?$ matches.", false],
];
const deny = async (i) =>
  i.hook_event_name !== "PreToolUse" ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "trigger probe only" } };

async function probe(prompt) {
  const repo = mkdtempSync(join(tmpdir(), "skill-trigger-"));
  execSync("git init -q && echo 'require(\"http\").createServer((q,s)=>s.end(\"ok\")).listen(3000)' > server.js && git add -A && git -c user.email=t@example.com -c user.name=t commit -qm init", { cwd: repo });
  mkdirSync(join(repo, ".claude/skills"), { recursive: true });
  cpSync(SKILL, join(repo, ".claude/skills/dev-workflow"), { recursive: true });
  let triggered = false, cost = 0;
  try {
    for await (const m of query({ prompt, options: { cwd: repo, settingSources: ["project"], skills: "all", hooks: { PreToolUse: [{ hooks: [deny] }] }, maxTurns: 3 } })) {
      if (m.type === "assistant") for (const b of m.message?.content ?? []) if (b.type === "tool_use" && b.name === "Skill") triggered = true;
      if (m.type === "result") cost = m.total_cost_usd ?? 0;
    }
  } catch {
    // hitting maxTurns ends the probe; that's expected
  }
  return { triggered, cost };
}

const rows = await Promise.all(prompts.map(async ([prompt, should]) => ({ prompt, should, ...(await probe(prompt)) })));
for (const r of rows) console.log(`${r.triggered === r.should ? "PASS" : "FAIL"} | ${r.triggered ? "triggered" : "not triggered"} | want ${r.should ? "trigger" : "no trigger"} | ${r.prompt}`);
const hits = rows.filter((r) => r.should && r.triggered).length;
const falseHits = rows.filter((r) => !r.should && r.triggered).length;
console.log(`\ncoding requests: ${hits}/${rows.filter((r) => r.should).length} triggered · plain questions: ${falseHits}/${rows.filter((r) => !r.should).length} false triggers · $${rows.reduce((a, r) => a + r.cost, 0).toFixed(2)}`);
process.exit(rows.every((r) => r.triggered === r.should) ? 0 : 1);
