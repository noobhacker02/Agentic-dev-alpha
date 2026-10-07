// A step of a composed team through the real runPhase, with the SDK replaced by the fake that runs scripted tool calls through the hook chain the caller registered (test/stress/fake-sdk/sdk.mjs, FAKE_TOOL_CALLS).
// What is checked is what the model would meet: which tools exist for the step, what each hook decides, which browser tools are registered, what it is told. The built-in phases (no `team`) are checked unchanged.
//   npm run build && npm run test:team-run-phase
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPhase } from "../dist/phases.js";
import { Store } from "../dist/store.js";
import { EventBus } from "../dist/bus.js";
import { BrowserSessionManager } from "../dist/browser-tools.js";
import { BUILTIN_ROSTER } from "../dist/team/roster.js";

const root = mkdtempSync(join(tmpdir(), "team-run-phase-"));
const work = join(root, "work");
for (const d of ["src/api", "src/ui", "src/other"]) mkdirSync(join(work, d), { recursive: true });
writeFileSync(join(work, "package.json"), "{}");
const store = new Store(join(root, "t.db"));
const bus = new EventBus(store);
const run = store.createRun("team step", work);
const role = (id) => BUILTIN_ROSTER.find((r) => r.id === id);
const sessions = new BrowserSessionManager();
let n = 0;

const asked = [];
async function go({ phase, team, calls = [], withBrowser = false, desktop, requireApproval = false }) {
  const log = join(root, `hooks-${++n}.log`);
  process.env.FAKE_HOOKS_LOG = log;
  process.env.FAKE_TOOL_CALLS = JSON.stringify(calls);
  writeFileSync(log, "");
  await runPhase({ runId: run.id, phase, attempt: 1, task: "build the thing", workDir: work, priorSummaries: "", bus, store, requireApproval, team, ...(desktop ? { desktop } : {}), ...(withBrowser ? { browser: { sessions, artifactDir: join(root, "art") } } : {}) });
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { head: lines[0], decisions: lines.slice(1).map((l) => [l.call.tool, l.decision]), reasons: lines.slice(1).map((l) => l.reason) };
}
// with approval on, every request is answered "deny" at once and recorded: what was asked is what was not auto-approved
bus.on("event", (e) => { if (e.type === "approval-request") { asked.push(e.toolName); bus.resolveApproval(e.requestId, { decision: "deny", reason: "test" }); } });
const slice = (name, ...paths) => ({ name, paths });

// 1. A builder with a slice: its slice is writable, everything else is refused by the write-scope hook, and the hook is in the chain
{
  const r = await go({
    phase: "builder",
    team: { role: role("builder"), step: { id: "s3", role: "builder", why: "slice 1", slice: slice("api", "src/api") }, allPrefixes: ["src/api", "src/ui"] },
    calls: [{ tool: "Write", input: { file_path: "src/api/a.ts" } }, { tool: "Write", input: { file_path: "src/ui/b.ts" } }, { tool: "Edit", input: { file_path: "package.json" } }, { tool: "Read", input: { file_path: "src/ui/b.ts" } }, { tool: "Bash", input: { command: "ls" } }, { tool: "WebFetch", input: { url: "http://x" } }],
  });
  assert.deepStrictEqual(r.head.tools, ["Read", "Glob", "Grep", "Bash", "Write", "Edit"]);
  assert.strictEqual(r.head.hookCount, 5, "a team step has the four built-in hooks and the write-scope hook");
  assert.deepStrictEqual(r.decisions, [["Write", "allow"], ["Write", "deny"], ["Edit", "deny"], ["Read", "allow"], ["Bash", "allow"], ["WebFetch", "no-such-tool"]]);
  assert.ok(/write scope/.test(r.reasons[1]) && /builder/.test(r.reasons[1]) && /slice/.test(r.reasons[1]), `the refusal: ${r.reasons[1]}`);
  assert.ok(/Your slice, "api"/.test(r.head.system) && /src\/api/.test(r.head.system), "the builder is not told its slice");
  console.log("[ok] a builder step: its slice is writable, other slices and the shared files are refused by the write-scope hook, the network tool does not exist for it");
}

// 2. A reader has no write tool at all, so a write is not a refusal, it is a tool that does not exist; a checker that can run things still cannot write through the file tools
{
  const r = await go({
    phase: "security-reviewer",
    team: { role: role("security-reviewer"), step: { id: "s6", role: "security-reviewer", why: "mandatory review", checks: "s3" } },
    calls: [{ tool: "Read", input: { file_path: "src/api/a.ts" } }, { tool: "Write", input: { file_path: "REVIEW.md" } }, { tool: "Edit", input: { file_path: "src/api/a.ts" } }, { tool: "Bash", input: { command: "echo x > src/api/a.ts" } }],
  });
  assert.deepStrictEqual(r.head.tools, ["Read", "Glob", "Grep"]);
  assert.deepStrictEqual(r.decisions, [["Read", "allow"], ["Write", "no-such-tool"], ["Edit", "no-such-tool"], ["Bash", "no-such-tool"]]);
  assert.ok(/checking the work of step s3/.test(r.head.prompt), "a checker is not told which step it checks");
  const v = await go({
    phase: "verifier",
    team: { role: role("verifier"), step: { id: "s4", role: "verifier", why: "check slice 1", checks: "s3" } },
    calls: [{ tool: "Bash", input: { command: "npm test" } }, { tool: "Write", input: { file_path: "src/api/a.ts" } }],
  });
  assert.deepStrictEqual(v.decisions, [["Bash", "allow"], ["Write", "no-such-tool"]]);
  console.log("[ok] a read-only step has no write tool (the call is to a tool that does not exist), and a checker that runs commands still has none either");
}

// 3. The integrator owns the shared files and the slices
{
  const r = await go({
    phase: "integrator",
    team: { role: role("integrator"), step: { id: "s7", role: "integrator", why: "join" }, allPrefixes: ["src/api", "src/ui"] },
    calls: [{ tool: "Edit", input: { file_path: "package.json" } }, { tool: "Write", input: { file_path: "src/ui/x.ts" } }, { tool: "Write", input: { file_path: "src/other/y.ts" } }],
  });
  assert.deepStrictEqual(r.decisions, [["Edit", "allow"], ["Write", "allow"], ["Write", "deny"]]);
  console.log("[ok] the integrator may change the shared files and any slice, and nothing outside them");
}

// 4. Browser access follows the role: none, read-only, full
{
  const calls = [];
  const names = async (id, step) => (await go({ phase: id, team: { role: role(id), step }, calls, withBrowser: true }));
  const builder = await names("builder", { id: "s3", role: "builder", why: "w", slice: slice("api", "src/api") });
  assert.deepStrictEqual(builder.head.mcp, [], "a builder has no browser here: its role does not have the class");
  const verifier = await names("verifier", { id: "s4", role: "verifier", why: "w", checks: "s3" });
  assert.deepStrictEqual(verifier.head.mcp, ["browser"]);
  const vt = verifier.head.mcpTools.browser;
  assert.ok(vt.includes("inspect") && vt.includes("open") && !vt.includes("click") && !vt.includes("fill") && !vt.includes("press") && !vt.includes("select_option") && !vt.includes("click_at"), `the checker's browser has acting tools: ${vt}`);
  assert.ok(/page-reading tools only/.test(verifier.head.prompt), "the checker is not told its browser only reads");
  const tester = await names("ui-tester", { id: "s8", role: "ui-tester", why: "w" });
  const tt = tester.head.mcpTools.browser;
  assert.ok(tt.includes("click") && tt.includes("fill") && tt.includes("inspect"), `the UI tester's browser lacks its tools: ${tt}`);
  assert.ok(!/page-reading tools only/.test(tester.head.prompt));
  console.log("[ok] browser access follows the role: none for a builder, the page-reading tools for a checker, all of them for a UI tester");
}

// 4b. The desktop window comes from the desktop class only
{
  const desktop = { describeTarget: () => "a test window" };
  const tester = await go({ phase: "desktop-tester", team: { role: role("desktop-tester"), step: { id: "s9", role: "desktop-tester", why: "w" } }, desktop });
  assert.deepStrictEqual(tester.head.mcp, ["desktop"], "the desktop tester did not get the window");
  const builder = await go({ phase: "builder", team: { role: role("builder"), step: { id: "s3", role: "builder", why: "w", slice: slice("api", "src/api") } }, desktop });
  assert.deepStrictEqual(builder.head.mcp, [], "a team builder was given the desktop window");
  const legacy = await go({ phase: "builder", desktop });
  assert.deepStrictEqual(legacy.head.mcp, ["desktop"], "the built-in builder lost the desktop window");
  console.log("[ok] the desktop window goes to a role with the desktop class, not to every team step, and the built-in builder keeps it");
}

// 4c. What is auto-approved: the read tools of the step, nothing else; the rest is asked
{
  asked.length = 0;
  const r = await go({ phase: "builder", requireApproval: true, team: { role: role("builder"), step: { id: "s3", role: "builder", why: "w", slice: slice("api", "src/api") } },
    calls: [{ tool: "Read", input: { file_path: "src/api/a.ts" } }, { tool: "Write", input: { file_path: "src/api/a.ts" } }, { tool: "Bash", input: { command: "npm test" } }] });
  assert.deepStrictEqual(r.decisions, [["Read", "allow"], ["Write", "deny"], ["Bash", "deny"]], "Read is auto-approved; Write and Bash are asked (and were refused here)");
  assert.deepStrictEqual(asked, ["Write", "Bash"], `what was asked: ${asked}`);
  console.log("[ok] a team step's auto-approval is its read tools only: a write and a command are put to the person");
}

// 4d. A built-in phase that does not use a browser does not get one
{
  const planner = await go({ phase: "planner", withBrowser: true });
  assert.deepStrictEqual(planner.head.mcp, [], "the built-in planner was given the browser");
  console.log("[ok] the built-in planner has no browser even when the run has one");
}

// 5. The built-in phases are untouched: their own tools, four hooks, no write scope, their own words
{
  const r = await go({ phase: "builder", calls: [{ tool: "Write", input: { file_path: "src/ui/b.ts" } }, { tool: "Write", input: { file_path: "package.json" } }] });
  assert.deepStrictEqual(r.head.tools, ["Read", "Glob", "Grep", "Write", "Edit", "Bash"]);
  assert.strictEqual(r.head.hookCount, 4, "the built-in path gained a hook");
  assert.deepStrictEqual(r.decisions, [["Write", "allow"], ["Write", "allow"]]);
  assert.ok(/You are the Builder phase of agent-loop/.test(r.head.system), "the built-in builder's words changed");
  const bw = await go({ phase: "builder", calls: [], withBrowser: true });
  assert.deepStrictEqual(bw.head.mcp, ["browser"]);
  assert.ok(bw.head.mcpTools.browser.includes("click"), "the built-in builder's browser lost its tools");
  await assert.rejects(runPhase({ runId: run.id, phase: "researcher", attempt: 1, task: "t", workDir: work, priorSummaries: "", bus, store, requireApproval: false }), /not one of the built-in phases/, "a non-built-in role without a team step was run with no spec");
  console.log("[ok] the five built-in phases run as before (their tools, four hooks, no write scope, their words and browser), and a role that is not built in cannot run without a team step");
}
sessions.closeAll?.().catch?.(() => {});
console.log("\nALL TEAM RUN-PHASE TESTS PASSED");
process.exit(0);
