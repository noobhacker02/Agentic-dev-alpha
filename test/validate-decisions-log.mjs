// Verifies the newest dev-workflow behavior end to end, with real API calls, against a task with
// a genuine external ambiguity nothing in the repo can resolve on its own: which payment provider
// to integrate. Two runs:
//
//   Run A (fresh project, no DECISIONS.md): the task should NOT get silently built against a
//   guessed provider. It should either ask a real, specific question about the provider, or state
//   an explicit, named assumption -- either is fine per SKILL.md's own Step 1 rule ("ask, or state
//   your interpretation and move on"), but a payment integration built with no acknowledgment of
//   which provider was chosen and why is exactly the silent-guess failure mode this feature exists
//   to prevent.
//
//   Run B (fresh project, DECISIONS.md pre-seeded with "payment provider: Stripe, decided by
//   user"): the same task should NOT ask about the provider again -- it should use the logged
//   decision directly. This is the actual point of keeping the log: a validated question doesn't
//   get asked twice.
//
// Spends real API tokens on two sessions.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert";
import { resolveDevWorkflowSkillPath } from "./resolve-skill-source.mjs";

// Always fetches the current published dev-workflow skill from GitHub by default -- see
// resolve-skill-source.mjs. Resolved once and reused for both runs below.
const DEV_WORKFLOW_SRC = resolveDevWorkflowSkillPath();
const TASK = "Add payment processing so users can buy a subscription in this app.";

function seedRepo() {
  const repo = mkdtempSync(join(tmpdir(), "dev-workflow-decisions-"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "seed-app", version: "1.0.0", main: "server.js" }, null, 2) + "\n");
  writeFileSync(
    join(repo, "server.js"),
    `const http = require("node:http");
const server = http.createServer((req, res) => {
  if (req.url === "/ping") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ pong: true })); return; }
  res.writeHead(404); res.end();
});
server.listen(process.env.PORT || 3000);
`
  );
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test Seed"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "Initial seed app"], { cwd: repo });
  mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
  cpSync(DEV_WORKFLOW_SRC, join(repo, ".claude", "skills", "dev-workflow"), { recursive: true });
  return repo;
}

const autoAllowHook = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  return { hookSpecificOutput: { hookEventName: input.hook_event_name, permissionDecision: "allow", permissionDecisionReason: "unattended validation run" } };
};

async function runSession(repo, label) {
  let lastAssistantText = "";
  const writesToPaymentCode = [];
  console.log(`\n[${label}] starting real Agent SDK session...`);
  const stream = query({
    prompt: TASK,
    options: {
      cwd: repo,
      settingSources: ["user", "project"],
      skills: "all",
      hooks: { PreToolUse: [{ hooks: [autoAllowHook] }] },
      maxTurns: 80,
      env: { ...process.env },
    },
  });
  for await (const message of stream) {
    if (message.type === "assistant") {
      for (const block of message.message?.content ?? []) {
        if (block.type === "text") lastAssistantText = block.text;
        if (block.type === "tool_use" && (block.name === "Write" || block.name === "Edit")) {
          const path = block.input?.file_path ?? "";
          if (/server\.js|payment|stripe|paypal/i.test(path)) writesToPaymentCode.push(path);
        }
      }
    } else if (message.type === "result") {
      console.log(`[${label}] session ended, result subtype: ${message.subtype}`);
    }
  }
  return { lastAssistantText, writesToPaymentCode };
}

// --- Run A: fresh project, no prior decision on record ---
const repoA = seedRepo();
console.log(`[setup] Run A repo: ${repoA}`);
const runA = await runSession(repoA, "Run A");

const askedOrStatedAssumption = /\?/.test(runA.lastAssistantText) || /assum(e|ption)/i.test(runA.lastAssistantText);
const mentionsAProvider = /stripe|paypal|braintree|square|payment provider/i.test(runA.lastAssistantText);
console.log(`[check] Run A final message mentions a provider choice/question: ${mentionsAProvider}`);
console.log(`[check] Run A final message asks or states an explicit assumption: ${askedOrStatedAssumption}`);
console.log(`[info] Run A final message (last 600 chars):\n${runA.lastAssistantText.slice(-600)}`);

let decisionsA = null;
if (existsSync(join(repoA, "DECISIONS.md"))) {
  decisionsA = readFileSync(join(repoA, "DECISIONS.md"), "utf8");
  console.log(`[info] Run A created DECISIONS.md:\n${decisionsA}`);
}

// --- Run B: fresh project, DECISIONS.md pre-seeded with the provider choice already made ---
const repoB = seedRepo();
writeFileSync(
  join(repoB, "DECISIONS.md"),
  `# Decisions: seed-app

## Entries

### 2026-09-20 — Payment provider chosen (task: specs/initial-setup)
- **Fork:** Which payment provider to integrate for subscriptions (Stripe vs PayPal vs others)
- **Decision:** Stripe
- **Decided by:** user (asked directly)
- **Why:** The team already has a Stripe merchant account set up from a previous product.
`
);
execFileSync("git", ["add", "-A"], { cwd: repoB });
execFileSync("git", ["commit", "-q", "-m", "Pre-seed DECISIONS.md with payment provider choice"], { cwd: repoB });
console.log(`\n[setup] Run B repo: ${repoB} (DECISIONS.md pre-seeded: Stripe already decided)`);
const runB = await runSession(repoB, "Run B");

const reAskedProvider = /which (payment )?provider|stripe or paypal|paypal or stripe/i.test(runB.lastAssistantText);
const usedStripeDirectly = /stripe/i.test(runB.lastAssistantText) && !reAskedProvider;
console.log(`[check] Run B re-asked which provider to use: ${reAskedProvider}`);
console.log(`[check] Run B proceeded with Stripe directly (per the logged decision): ${usedStripeDirectly}`);
console.log(`[info] Run B final message (last 600 chars):\n${runB.lastAssistantText.slice(-600)}`);

const checks = [
  { name: "Run A: did not silently guess a provider with no acknowledgment", pass: askedOrStatedAssumption || mentionsAProvider },
  { name: "Run B: did not re-ask a question already answered in DECISIONS.md", pass: !reAskedProvider },
  { name: "Run B: used the already-decided provider (Stripe) directly", pass: usedStripeDirectly },
];
console.log("\n=== Summary ===");
for (const c of checks) console.log(`[${c.pass ? "PASS" : "FAIL"}] ${c.name}`);
const passed = checks.filter((c) => c.pass).length;
console.log(`\n${passed}/${checks.length} checks passed.`);
console.log(`Run A repo kept at: ${repoA}`);
console.log(`Run B repo kept at: ${repoB}`);
