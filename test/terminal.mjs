// The Claude Code-style terminal view (src/terminal.ts), driven with real keypresses through a
// stream -- no TTY, no API calls:   npm run build && npm run test:terminal
import assert from "node:assert";
import { PassThrough, Writable } from "node:stream";
import { EventBus } from "../dist/bus.js";
import { attachTerminal } from "../dist/terminal.js";

let text = "";
const output = new Writable({ write(chunk, _enc, cb) { text += chunk.toString(); cb(); } });
const input = new PassThrough();
const bus = new EventBus();
const term = attachTerminal(bus, { input, output, interactive: true, workDir: "/w", uiUrl: "http://127.0.0.1:1/#token=x", color: false });
const ts = () => new Date().toISOString();
const tick = () => new Promise((r) => setTimeout(r, 20));
const runId = "r";

bus.emitEvent({ type: "run-start", runId, task: "Add /health", workDir: "/w", ts: ts() });
bus.emitEvent({ type: "phase-start", runId, phase: "builder", attempt: 1, ts: ts() });
bus.emitEvent({ type: "tool-call", runId, phase: "builder", toolUseId: "t1", toolName: "Read", toolInput: { file_path: "/w/server.js" }, ts: ts() });
bus.emitEvent({ type: "tool-result", runId, phase: "builder", toolUseId: "t1", toolName: "", isError: false, summary: "a\nb\nc", ts: ts() });
assert.ok(text.includes("⏺ Read(server.js)"), "tool calls print as ⏺ Tool(args) with a workDir-relative path");
assert.ok(text.includes("⎿  a … +2 lines"), "results print as one ⎿ line with a count of the rest");
console.log("[ok] transcript lines: ⏺ Read(server.js) / ⎿  a … +2 lines");

// 2 = yes, and don't ask again
bus.emitEvent({ type: "tool-call", runId, phase: "builder", toolUseId: "t2", toolName: "Bash", toolInput: { command: "npm test" }, ts: ts() });
const r1 = bus.requestApproval({ runId, phase: "builder", toolUseId: "t2", toolName: "Bash", toolInput: { command: "npm test" }, rule: "Bash(npm test:*)" });
assert.ok(text.includes("Do you want to proceed?") && text.includes("2. Yes, and don't ask again for Bash(npm test:*) this run"));
input.write("2"); await tick();
assert.deepStrictEqual(await r1.wait, { decision: "allow", reason: undefined, remember: true });
console.log("[ok] key 2 answers yes + don't ask again");

// n -> type feedback -> Enter = reject with that reason; a second request queues behind it
const r2 = bus.requestApproval({ runId, phase: "builder", toolUseId: "t3", toolName: "Bash", toolInput: { command: "rm -r build && make" } });
const r3 = bus.requestApproval({ runId, phase: "builder", toolUseId: "t4", toolName: "Write", toolInput: { file_path: "/w/a.txt", content: "hi" } });
assert.ok(text.includes("(1 more approval waiting after this one)"), "a queued second request is announced");
assert.ok(!text.split("rm -r build && make")[1].split("╰─")[0].includes("don't ask again"), "a chained command offers no 'don't ask again'");
input.write("n"); input.write("just run make"); input.write("\r"); await tick();
assert.deepStrictEqual(await r2.wait, { decision: "deny", reason: "just run make", remember: undefined });
assert.ok(text.includes("Create file a.txt") && text.includes("+ hi"), "the next prompt shows up right away, with a + preview for Write");
console.log("[ok] n → typed reason → Enter rejects with feedback; the queued prompt appears next");

// answered in the web UI instead: the terminal prompt moves on
bus.resolveApproval(r3.requestId, { decision: "allow" });
bus.emitEvent({ type: "approval-resolved", runId, phase: "builder", requestId: r3.requestId, toolUseId: "t4", decision: "allow", auto: false, ts: ts() });
input.write("1"); await tick(); // no prompt is active any more; must not throw or double-answer
assert.strictEqual(bus.pendingRequests().length, 0);
console.log("[ok] an approval answered in the web UI clears the terminal prompt");

bus.emitEvent({ type: "usage", runId, phase: "builder", role: "phase", costUsd: 0.42, turns: 3, durationMs: 1, ts: ts() });
bus.emitEvent({ type: "phase-end", runId, phase: "builder", attempt: 1, verdict: { completed: true, outcome: "fail", headline: "Tests fail", details: "", concerns: [], blockingFindings: ["test_health fails"] }, ts: ts() });
bus.emitEvent({ type: "overseer-decision", runId, phase: "builder", decision: { action: "repair", repairTarget: "builder", reasoning: "fix it" }, ts: ts() });
bus.emitEvent({ type: "run-end", runId, status: "failed", ts: ts() });
assert.ok(text.includes("✗ builder: Tests fail (fail)") && text.includes("• test_health fails"));
assert.ok(text.includes("◆ Overseer → REPAIR builder"));
assert.ok(/Run failed · \d+s · \$0\.42/.test(text), "the run summary carries total cost");
console.log("[ok] verdicts, Overseer decisions and a cost summary print");

// --- terminal escape/control bytes in untrusted content (tool output, file content, the model's
// own text) must never reach the real terminal raw: a planted OSC 52 can silently write to the
// system clipboard, and a CSI screen-clear/cursor-move could rewrite what a human sees in the
// approval prompt they're about to say yes to.
const OSC52 = "\x1b]52;c;ZGF0YQ==\x07";
const CLEAR = "\x1b[2J\x1b[H";
text = "";
bus.emitEvent({ type: "tool-call", runId, phase: "builder", toolUseId: "t5", toolName: "Bash", toolInput: { command: "curl http://localhost:8080/data" }, ts: ts() });
bus.emitEvent({ type: "tool-result", runId, phase: "builder", toolUseId: "t5", toolName: "", isError: false, summary: `ok ${OSC52} done`, ts: ts() });
bus.emitEvent({ type: "assistant-text", runId, phase: "builder", text: `Found: ${OSC52}`, ts: ts() });
bus.requestApproval({ runId, phase: "builder", toolUseId: "t6", toolName: "Write", toolInput: { file_path: "/w/a.txt", content: `${CLEAR}looks safe` } });
await tick();
assert.ok(!text.includes("\x1b]52"), "OSC 52 (clipboard write) never reaches the real terminal, from tool output or model text");
assert.ok(!text.includes("\x1b[2J"), "a CSI screen-clear in file content shown in the approval prompt is stripped, not executed");
assert.ok(text.includes("looks safe"), "the harmless remainder of the content still renders");
console.log("[ok] escape/control bytes in tool output, model text, and the approval prompt body are stripped");

term.detach();
console.log("\n--- sample ---\n" + text.split("\n").slice(0, 14).join("\n"));
console.log("\nALL TERMINAL TESTS PASSED");
