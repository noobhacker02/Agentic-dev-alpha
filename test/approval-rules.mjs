// "Yes, and don't ask again" (src/hooks.ts approvalRuleFor + createApprovalHook): a rule must stay
// as narrow as what the human actually saw. No API calls:   npm run build && npm run test:rules
import assert from "node:assert";
import { EventBus } from "../dist/bus.js";
import { createApprovalHook } from "../dist/hooks.js";

// Which commands map to which rule is covered call-by-call in test/bash-analysis.mjs; this file
// checks the hook's behavior around those rules.
const bus = new EventBus();
const hook = createApprovalHook({ bus, runId: "r", phase: "builder", requireApproval: true, autoApproveTools: ["Read"], workDir: "/w" });
const signal = new AbortController().signal;
const call = (command, id) => hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, id, { signal });
const events = [];
bus.on("event", (e) => events.push(e));
const answerNext = (decision) => new Promise((res) => {
  const on = (e) => { if (e.type === "approval-request") { bus.off("event", on); bus.resolveApproval(e.requestId, decision); res(e); } };
  bus.on("event", on);
});

let asked = answerNext({ decision: "allow", remember: true });
let out = await call("npm test", "t1");
assert.strictEqual((await asked).rule, "Bash(npm test:*)");
assert.strictEqual(out.hookSpecificOutput.permissionDecision, "allow");
assert.strictEqual(events.find((e) => e.type === "approval-resolved").rememberedRule, "Bash(npm test:*)");
console.log("[ok] 'don't ask again' on `npm test` saves Bash(npm test:*)");

out = await call("npm test -- --coverage", "t2");
assert.strictEqual(out.hookSpecificOutput.permissionDecision, "allow");
assert.ok(events.some((e) => e.type === "approval-auto-allowed" && e.toolUseId === "t2"), "the auto-allow is announced, not silent");
assert.strictEqual(events.filter((e) => e.type === "approval-request").length, 1, "no second prompt");
console.log("[ok] a later `npm test -- --coverage` runs without asking, and says which rule allowed it");

asked = answerNext({ decision: "deny", reason: "no publishing" });
out = await call("npm publish", "t3");
assert.strictEqual(out.hookSpecificOutput.permissionDecision, "deny");
asked = answerNext({ decision: "deny" });
out = await call("npm test && npm publish", "t4");
assert.strictEqual((await asked).rule, "Bash(npm test:*), Bash(npm publish:*)", "a chained command still asks (npm publish has no rule) and names every rule 'don't ask again' would save");
assert.strictEqual(out.hookSpecificOutput.permissionDecision, "deny");
console.log("[ok] `npm publish` and `npm test && npm publish` still ask; the rule doesn't stretch");

out = await call("cd /w && ls -la && git status", "t5");
assert.strictEqual(out.hookSpecificOutput.permissionDecision, "allow");
assert.ok(events.some((e) => e.type === "approval-auto-allowed" && e.toolUseId === "t5" && /read-only/.test(e.rule)));
assert.strictEqual(events.filter((e) => e.type === "approval-request").length, 3, "a read-only command never prompts");
console.log("[ok] a read-only command inside --dir runs without a prompt, and says why");

const strictBus = new EventBus();
const strict = createApprovalHook({ bus: strictBus, runId: "s", phase: "builder", requireApproval: true, workDir: "/w", autoAllowReadOnly: false });
const sp = strict({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls -la" } }, "s1", { signal });
await new Promise((r) => setTimeout(r, 20));
assert.strictEqual(strictBus.pendingRequests().length, 1, "--strict-approval asks even for read-only commands");
strictBus.resolveApproval(strictBus.pendingRequests()[0].requestId, { decision: "allow" });
await sp;
console.log("[ok] --strict-approval still asks about read-only commands");

const other = new EventBus();
const hook2 = createApprovalHook({ bus: other, runId: "r2", phase: "builder", requireApproval: true });
const p = hook2({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }, "x", { signal });
await new Promise((r) => setTimeout(r, 20));
assert.strictEqual(other.pendingRequests().length, 1, "rules live on one run's bus; a new run starts with none");
other.resolveApproval(other.pendingRequests()[0].requestId, { decision: "deny" });
await p;
console.log("[ok] rules don't carry over into another run");
console.log("\nALL APPROVAL RULE TESTS PASSED");
