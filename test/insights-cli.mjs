// Regression test: `agent-loop insights` must never print a raw terminal control/escape byte, even
// when it's embedded in a stored "don't ask again" rule string built from real Bash command text
// (bash-analysis.ts's tokenizer doesn't strip non-Bash-meaningful bytes from a command word, so a
// crafted or accidental command containing one reaches a rule string verbatim). No API calls, no
// fake-SDK import needed -- `insights` never touches the SDK, only the audit database.
//   npm run build && npm run test:insights
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/store.js";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "agent-loop-insights-cli-"));
const dbPath = join(dataDir, "agent-loop.db");

const store = new Store(dbPath);
const run = store.createRun("adversarial insights test", "/w");
const phase = store.startPhase(run.id, "builder", 1);
store.finishPhase(phase.id, { completed: true, outcome: "pass", headline: "ok", details: "", concerns: [], blockingFindings: [] });
store.finishRun(run.id, "done");

// A clear-screen + cursor-home sequence, exactly the shape bash-analysis.ts can produce verbatim
// inside a rule when the offending bytes don't happen to fall on a Bash separator character.
const nastyRule = "Bash(npm \u001b[2J\u001b[Htest:*)";
store.logEvent(run.id, "builder", "approval-resolved", { rememberedRule: nastyRule });
// Desktop computer use shows up in the report, and only when it was used.
store.logEvent(run.id, "builder", "desktop-session-started", { desktopSessionId: "s1" });
store.logEvent(run.id, "builder", "desktop-snapshot", { snapshotId: "dshot-1" });
store.logEvent(run.id, "builder", "desktop-action-completed", { toolName: "click", isError: false });
store.logEvent(run.id, "builder", "desktop-action-completed", { toolName: "key", isError: true });
store.logEvent(run.id, "builder", "approval-request", { requestId: "q1", toolName: "mcp__desktop__click" });
store.logEvent(run.id, "builder", "approval-resolved", { requestId: "q1", decision: "deny" });
store.close();

const out = execFileSync(process.execPath, ["--experimental-sqlite", "--no-warnings", "dist/cli.js", "insights", "--data-dir", dataDir], {
  encoding: "utf8",
  cwd: fileURLToPath(new URL("..", import.meta.url)),
});

assert.ok(!/\x1b/.test(out), `raw ESC byte reached real stdout: ${JSON.stringify(out)}`);
assert.ok(!/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.test(out), "some other raw control byte reached real stdout");
assert.ok(out.includes("npm ") && out.includes("test:*"), "the rest of the rule text still printed -- stripped only the dangerous bytes, not the whole line");
console.log('[ok] a "don\'t ask again" rule containing a raw terminal escape sequence prints as inert text, not live control codes');

assert.ok(/Desktop tools: 1 session\(s\), 1 capture\(s\)/.test(out), `desktop section missing:\n${out}`);
assert.ok(/input actions sent: 1 \(click 1\); stopped by the tools' own checks or the driver: 1/.test(out), out);
assert.ok(/human answers: 0 approved, 1 denied/.test(out), out);
// A data dir that never used desktop tools doesn't print the section at all.
const clean = mkdtempSync(join(tmpdir(), "agent-loop-insights-clean-"));
const s2 = new Store(join(clean, "agent-loop.db"));
const r2 = s2.createRun("no desktop", "/w");
s2.finishRun(r2.id, "done");
s2.close();
const out2 = execFileSync(process.execPath, ["--experimental-sqlite", "--no-warnings", "dist/cli.js", "insights", "--data-dir", clean], { encoding: "utf8", cwd: fileURLToPath(new URL("..", import.meta.url)) });
assert.ok(!/Desktop tools/.test(out2), "no desktop section when desktop tools were never used");
console.log("[ok] insights prints desktop sessions, captures, actions sent vs stopped and human answers -- and nothing when desktop was never used");
console.log("\nALL INSIGHTS CLI TESTS PASSED");
