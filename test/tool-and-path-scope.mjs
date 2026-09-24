// Regression tests for fix-plan item 3 (docs/STRESS-TEST-REPORT.md): tool restriction, path
// scoping, and the minimal env passed to each phase. No API calls:
//   npm run build && npm run test:scope
import assert from "node:assert";
import { createPathScopeHook } from "../dist/hooks.js";
import { minimalEnv } from "../dist/env.js";

const sig = new AbortController().signal;
const pre = (tool, input) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });
const WORKDIR = "/tmp/agent-loop-scope-test/workdir";

// --- path scoping: file tools can't read/write outside --dir
const hook = createPathScopeHook(WORKDIR);
const denyCases = [
  ["Write", { file_path: "/root/.bashrc", content: "x" }],
  ["Edit", { file_path: "/etc/hosts" }],
  ["Write", { file_path: "../../outside.txt", content: "x" }],
  ["Write", { file_path: `${WORKDIR}/../../elsewhere/x.txt`, content: "x" }],
  ["Read", { file_path: "/root/.ssh/id_rsa" }],
  ["Glob", { pattern: "*", path: "/etc" }],
  ["NotebookEdit", { notebook_path: "/root/notebook.ipynb" }],
];
for (const [tool, input] of denyCases) {
  const r = await hook(pre(tool, input), "t", { signal: sig });
  assert.strictEqual(r?.hookSpecificOutput?.permissionDecision, "deny", `${tool} ${JSON.stringify(input)} should be denied`);
}
console.log(`[ok] path scope hook denies ${denyCases.length} out-of-workdir file operations`);

const allowCases = [
  ["Write", { file_path: `${WORKDIR}/PLAN.md`, content: "x" }],
  ["Write", { file_path: "PLAN.md", content: "x" }],
  ["Write", { file_path: "sub/dir/PLAN.md", content: "x" }],
  ["Read", { file_path: `${WORKDIR}/roman.py` }],
  ["Glob", { pattern: "*.py" }],
  ["Bash", { command: "echo hi" }], // Bash has no path argument this hook understands; out of scope by design
];
for (const [tool, input] of allowCases) {
  const r = await hook(pre(tool, input), "t", { signal: sig });
  assert.deepStrictEqual(r, {}, `${tool} ${JSON.stringify(input)} inside the workdir should not be touched`);
}
console.log(`[ok] path scope hook leaves ${allowCases.length} in-workdir / non-file operations alone`);

// A workdir given without a trailing separator must not accidentally allow a sibling directory
// that merely shares its name as a prefix (e.g. "/tmp/x" vs "/tmp/x-evil").
const siblingHook = createPathScopeHook("/tmp/agent-loop-scope-test/x");
const sibling = await siblingHook(pre("Write", { file_path: "/tmp/agent-loop-scope-test/x-evil/f.txt", content: "x" }), "t", { signal: sig });
assert.strictEqual(sibling?.hookSpecificOutput?.permissionDecision, "deny", "a sibling dir sharing a name prefix must not be treated as inside the workdir");
console.log("[ok] path scope hook is not fooled by a sibling directory sharing a name prefix");

// --- minimal env: no arbitrary app secrets, but auth/session plumbing survives
const fakeSource = {
  PATH: "/usr/bin",
  HOME: "/root",
  STRIPE_SECRET_KEY: "sk_live_should_not_leak",
  DATABASE_URL: "postgres-should-not-leak-either://example",
  ANTHROPIC_API_KEY: "sk-ant-should-survive",
  CLAUDE_CODE_SESSION_ID: "should-survive-too",
  RANDOM_APP_VAR: "should_not_leak",
};
const env = minimalEnv(fakeSource);
assert.strictEqual(env.PATH, "/usr/bin");
assert.strictEqual(env.HOME, "/root");
assert.strictEqual(env.ANTHROPIC_API_KEY, "sk-ant-should-survive");
assert.strictEqual(env.CLAUDE_CODE_SESSION_ID, "should-survive-too");
assert.strictEqual(env.STRIPE_SECRET_KEY, undefined);
assert.strictEqual(env.DATABASE_URL, undefined);
assert.strictEqual(env.RANDOM_APP_VAR, undefined);
console.log("[ok] minimalEnv keeps PATH/HOME/CLAUDE_*/ANTHROPIC_* and drops unrelated app secrets");

console.log("\nALL TOOL/PATH/ENV SCOPE TESTS PASSED");
