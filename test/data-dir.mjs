// Regression test for fix-plan item 4 (docs/STRESS-TEST-REPORT.md): the audit database must live
// outside --dir, the directory the agents themselves have Write/Edit/Bash access to. No API calls:
//   npm run build && npm run test:data-dir
import assert from "node:assert";
import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import { resolveDataDir } from "../dist/data-dir.js";

const workDirA = "/tmp/agent-loop-datadir-test/project-a";
const workDirB = "/tmp/agent-loop-datadir-test/project-b";

function isInside(dir, candidate) {
  const root = resolve(dir);
  const c = resolve(candidate);
  return c === root || c.startsWith(root + sep);
}

// --- default location (no override): never inside the agents' own --dir
const a1 = resolveDataDir(workDirA);
assert.ok(!isInside(workDirA, a1), `data dir ${a1} must not be inside ${workDirA}`);
console.log(`[ok] default data dir (${a1}) is outside --dir`);

// --- stable per project: the same --dir resolves to the same data dir across calls, so history
// from repeated `agent-loop run` invocations against one project accumulates in one file
const a2 = resolveDataDir(workDirA);
assert.strictEqual(a1, a2, "the same workDir must resolve to the same data dir every time");
console.log("[ok] repeated calls with the same --dir agree on the same data dir");

// --- different projects don't collide
const b1 = resolveDataDir(workDirB);
assert.notStrictEqual(a1, b1, "different workDirs must not share a data dir");
console.log("[ok] different --dir values get different data dirs");

// --- default lives under the user's home (or $AGENT_LOOP_HOME), not somewhere surprising
const prevHome = process.env.AGENT_LOOP_HOME;
delete process.env.AGENT_LOOP_HOME;
assert.ok(isInside(homedir(), resolveDataDir(workDirA)), "default data dir should live under the home directory");
console.log("[ok] with no override, the data dir lives under the home directory");

process.env.AGENT_LOOP_HOME = "/tmp/agent-loop-datadir-test/custom-home";
assert.ok(isInside(process.env.AGENT_LOOP_HOME, resolveDataDir(workDirA)), "AGENT_LOOP_HOME must be honored");
console.log("[ok] AGENT_LOOP_HOME overrides the default home-based location");
if (prevHome === undefined) delete process.env.AGENT_LOOP_HOME;
else process.env.AGENT_LOOP_HOME = prevHome;

// --- an explicit --data-dir always wins, even if it happens to be relative to --dir (the CLI is
// still responsible for not pointing it inside --dir; this only checks the override is honored)
const explicit = resolveDataDir(workDirA, "/tmp/agent-loop-datadir-test/explicit");
assert.strictEqual(explicit, resolve("/tmp/agent-loop-datadir-test/explicit"));
console.log("[ok] an explicit override is used as given");

console.log("\nALL DATA DIR TESTS PASSED");
