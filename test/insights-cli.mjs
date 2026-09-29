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
store.close();

const out = execFileSync(process.execPath, ["--experimental-sqlite", "--no-warnings", "dist/cli.js", "insights", "--data-dir", dataDir], {
  encoding: "utf8",
  cwd: new URL("..", import.meta.url).pathname,
});

assert.ok(!/\x1b/.test(out), `raw ESC byte reached real stdout: ${JSON.stringify(out)}`);
assert.ok(!/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.test(out), "some other raw control byte reached real stdout");
assert.ok(out.includes("npm ") && out.includes("test:*"), "the rest of the rule text still printed -- stripped only the dangerous bytes, not the whole line");
console.log('[ok] a "don\'t ask again" rule containing a raw terminal escape sequence prints as inert text, not live control codes');
console.log("\nALL INSIGHTS CLI TESTS PASSED");
