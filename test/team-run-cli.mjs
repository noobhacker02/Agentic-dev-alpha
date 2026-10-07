// `agent-loop run "<task>" --team auto|fixed5|<plan file>`: how a team is chosen for a run (docs/TEAM-COMPOSITION.md). `fixed5` (and no flag) is the five phases as always; `auto` is the offline composer;
// a file is a plan somebody wrote, and it goes through the same floor and the same checks as any proposal (it is never silently replaced). A bad value is an error before anything starts: no run, no
// database, no model. Roles come from the built-in roster and the user's own directory; a roster inside the project counts only with --trust-project. First the function, then the real command line.
//   npm run build && npm run test:team-run-cli
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTeamOption } from "../dist/team/cli-run.js";
import { Store } from "../dist/store.js";

const scratch = mkdtempSync(join(tmpdir(), "team-run-cli-"));
const home = join(scratch, "home");
mkdirSync(home);
process.env.AGENT_LOOP_HOME = home;
const repo = join(scratch, "repo");
for (const f of ["README.md", "package.json", "src/api/users.ts", "src/ui/page.ts", "test/users.test.ts"]) {
  mkdirSync(join(repo, f.split("/").slice(0, -1).join("/") || "."), { recursive: true });
  writeFileSync(join(repo, f), "x\n");
}
const PLAN = { class: "multi-module", size: "medium", reason: "two slices", steps: [
  { id: "s1", role: "planner", why: "plan it" },
  { id: "s2", role: "builder", slice: { name: "api", paths: ["src/api"] }, after: ["s1"], why: "slice 1" },
  { id: "s3", role: "verifier", checks: "s2", why: "check slice 1" },
  { id: "s4", role: "gatekeeper", after: ["s3"], why: "last gate" },
] };
const planFile = join(scratch, "plan.json");
writeFileSync(planFile, JSON.stringify(PLAN));
const opt = (args, task = "add a docstring to the users module") => resolveTeamOption({ _: [], ...args }, { task, workDir: repo, cwd: scratch });

// 1. No flag, fixed5 and a flag with no value
{
  assert.deepStrictEqual([opt({}).team, opt({}).error], [undefined, undefined], "no flag changed the run");
  assert.deepStrictEqual([opt({ team: "fixed5" }).team, opt({ team: "fixed5" }).error], [undefined, undefined], "fixed5 changed the run");
  const bare = opt({ team: true });
  assert.ok(bare.error && bare.error.code === 1 && /--team needs a value/.test(bare.error.message) && /auto/.test(bare.error.message) && /fixed5/.test(bare.error.message), `a flag with no value: ${JSON.stringify(bare.error)}`);
  console.log("[ok] no flag and fixed5 leave the run as it was; a flag with no value is an error that says what it takes");
}

// 2. auto: the offline composer's team, from the task and the paths in the project
{
  const r = opt({ team: "auto" });
  assert.ok(r.team && !r.error, JSON.stringify(r.error));
  assert.strictEqual(r.team.source, "auto");
  const roles = r.team.plan.steps.map((s) => s.role);
  assert.ok(roles.includes("builder") && roles.includes("verifier") && roles.includes("gatekeeper"), `the floor is missing: ${roles}`);
  assert.ok(r.team.roster.length === 19 && r.team.roster.every((x) => x.id), "the roster of the built-in roles is not passed on");
  assert.ok(r.maxRepairs >= 20 && r.maxRepairs >= r.team.plan.steps.length * 3, `the repair budget for a team of ${r.team.plan.steps.length}: ${r.maxRepairs}`);
  assert.ok(Array.isArray(r.summary) && r.summary.some((l) => /Team \(auto\)/.test(l)), "no summary line");
  // modules the task names (and that exist in the project) become slices, and the repair budget follows the size of the team
  const two = opt({ team: "auto" }, "add pagination to src/api and a page in src/ui");
  assert.ok(two.team, JSON.stringify(two.error));
  const slices = two.team.plan.steps.filter((x) => x.slice).map((x) => x.slice.paths.join(","));
  assert.deepStrictEqual(slices, ["src/api", "src/ui"], `the modules the task names were not made slices: ${slices}`);
  assert.strictEqual(two.team.plan.steps.length, 9);
  assert.strictEqual(two.maxRepairs, 27, `the repair budget for nine steps: ${two.maxRepairs}`);
  assert.ok(two.summary[0].includes("9 steps") && two.summary[0].includes("builder (api)") && two.summary[0].includes("builder (ui)"), `the summary line: ${two.summary[0]}`);
  // the project's paths matter: a module the task names that is not in the project does not become a slice
  const ghost = opt({ team: "auto" }, "add pagination to src/nope and src/api");
  assert.ok(ghost.team && ghost.team.plan.steps.every((x) => !x.slice || !JSON.stringify(x.slice).includes("nope")) && ghost.team.plan.steps.length < 5, `a module that is not in the project was planned for: ${JSON.stringify(ghost.team?.plan.steps.map((x) => [x.role, x.slice]))}`);
  // a read-only task needs no builder
  const ro = opt({ team: "auto" }, "explain how the users module works");
  assert.ok(ro.team && !ro.team.plan.steps.some((s) => s.role === "builder"), "a read-only task got a builder");
  // the roles a signal made mandatory travel with the team: the engine refuses to skip them (V12) and insists on them (V4)
  assert.deepStrictEqual(ro.team.required, [], "a read-only task has no mandatory role");
  const sec = opt({ team: "auto" }, "add password login with auth tokens to src/api");
  assert.ok(sec.team && sec.team.required.includes("security-reviewer") && sec.team.plan.steps.some((s) => s.role === "security-reviewer"), `a security task's mandatory role was not passed on: ${JSON.stringify(sec.team?.required)}`);
  console.log("[ok] --team auto is the offline composer's team for the task and the project's paths, with the floor, a repair budget that grows with the team, and a summary line");
}

// 3. a plan file: finalized (the floor is put under it), never silently replaced
{
  const r = opt({ team: planFile });
  assert.ok(r.team && !r.error, JSON.stringify(r.error));
  assert.strictEqual(r.team.source, "file");
  assert.deepStrictEqual(r.team.plan.steps.map((s) => s.id), ["s1", "s2", "s3", "s4"], "a valid plan was changed");
  assert.deepStrictEqual(r.notes, [], "a valid plan has notes");
  const noGate = join(scratch, "no-gate.json");
  writeFileSync(noGate, JSON.stringify({ ...PLAN, steps: PLAN.steps.filter((s) => s.role !== "gatekeeper") }));
  const fixed = opt({ team: noGate });
  assert.ok(fixed.team && fixed.team.plan.steps.some((s) => s.role === "gatekeeper") && fixed.notes.some((n) => /gatekeeper/.test(n)), `the floor was not put under the file: ${JSON.stringify(fixed.notes)}`);
  // relative to the directory the command was run from
  assert.ok(opt({ team: "plan.json" }).team, "a relative plan path did not resolve against the working directory");
  console.log("[ok] a plan file is finalized (a missing gatekeeper is added and the change is reported), a valid one is kept as written, a relative path resolves from where the command ran");
}

// 4. A plan that cannot be used is an error naming why, with the right code; nothing is replaced behind the user's back
{
  const bad = (name, content) => { const f = join(scratch, name); writeFileSync(f, content); return opt({ team: f }); };
  const e = (r) => r.error ?? {};
  assert.strictEqual(opt({ team: join(scratch, "missing.json") }).error?.code, 1);
  assert.ok(/cannot read|not found|no such/i.test(e(opt({ team: join(scratch, "missing.json") })).message ?? ""));
  assert.ok(opt({ team: scratch }).error?.code === 1 && /is not a file/.test(opt({ team: scratch }).error.message), `a directory: ${JSON.stringify(opt({ team: scratch }).error)}`);
  const brokenJson = bad("broken.json", "{ nope");
  assert.ok(brokenJson.error?.code === 1 && /not valid JSON/.test(brokenJson.error.message), `broken JSON: ${JSON.stringify(brokenJson.error)}`);
  assert.ok(/must be an object/.test(e(bad("array.json", "[1,2]")).message ?? ""), "a JSON array was accepted as a plan");
  const big = bad("big.json", JSON.stringify({ ...PLAN, reason: "x".repeat(300_000) }));
  assert.ok(big.error && /too large/.test(big.error.message), `a huge file: ${JSON.stringify(big.error)}`);
  const unknown = bad("unknown-role.json", JSON.stringify({ ...PLAN, steps: [...PLAN.steps, { id: "s9", role: "wizard", after: ["s4"], why: "x" }] }));
  assert.ok(unknown.error?.code === 2 && /V1/.test(unknown.error.message) && /wizard/.test(unknown.error.message), `an unknown role: ${JSON.stringify(unknown.error)}`);
  const over = resolveTeamOption({ _: [], team: planFile, cap: "3" }, { task: "add a docstring", workDir: repo, cwd: scratch });
  assert.ok(over.error?.code === 2 && /cap/i.test(over.error.message), `a team over the cap: ${JSON.stringify(over.error)}`);
  for (const cap of ["0", "51", "-1", "2.5", "0x10", "1e1", " 5", "", "banana"]) {
    const r = resolveTeamOption({ _: [], team: "auto", cap }, { task: "t", workDir: repo, cwd: scratch });
    assert.ok(r.error?.code === 1 && /--cap needs a whole number from 1 to 50/.test(r.error.message), `--cap ${JSON.stringify(cap)} was accepted or misreported: ${JSON.stringify(r.error ?? "no error")}`);
  }
  assert.ok(resolveTeamOption({ _: [], team: "auto", cap: "50" }, { task: "add a docstring", workDir: repo, cwd: scratch }).team, "a cap of 50 was refused");
  assert.ok(resolveTeamOption({ _: [], team: "auto", cap: "12" }, { task: "add a docstring", workDir: repo, cwd: scratch }).team);
  const badCap = resolveTeamOption({ _: [], team: "auto", cap: "banana" }, { task: "t", workDir: repo, cwd: scratch });
  assert.ok(badCap.error?.code === 1 && /--cap needs a whole number/.test(badCap.error.message), `a bad cap: ${JSON.stringify(badCap.error)}`);
  const ctl = opt({ team: join(scratch, "evil\u001b[2J\u0007name.json") });
  assert.ok(ctl.error && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(ctl.error.message), "a control byte from the file name reached the message");
  console.log("[ok] an unreadable, broken, oversized, unknown-role or over-cap plan is an error that says why (code 1 for usage, 2 for a plan that is refused), and file names are cleaned");
}

// 5. Roles from a roster inside the project count only when it is trusted
{
  const rosterDir = join(repo, ".agent-loop", "roster");
  mkdirSync(rosterDir, { recursive: true });
  writeFileSync(join(rosterDir, "copy-reviewer.json"), JSON.stringify({ kind: "check", model: "sonnet", tools: ["read"], writeScope: "none", skippable: true, max: 1, when: ["ui"], description: "Checks copy." }));
  writeFileSync(join(rosterDir, "copy-reviewer.md"), "Check the copy.");
  const withRole = join(scratch, "with-role.json");
  writeFileSync(withRole, JSON.stringify({ ...PLAN, steps: [...PLAN.steps.slice(0, 3), { id: "s3b", role: "copy-reviewer", after: ["s3"], why: "copy" }, { ...PLAN.steps[3], after: ["s3b"] }] }));
  const untrusted = opt({ team: withRole });
  assert.ok(untrusted.error?.code === 2 && /copy-reviewer/.test(untrusted.error.message), `a project roster was used without --trust-project: ${JSON.stringify(untrusted.error)}`);
  const trusted = opt({ team: withRole, "trust-project": true });
  assert.ok(trusted.team && trusted.team.plan.steps.some((s) => s.role === "copy-reviewer") && trusted.team.roster.some((r) => r.id === "copy-reviewer"), `a trusted project roster was not used: ${JSON.stringify(trusted.error)}`);
  console.log("[ok] a role defined only in the project's own roster is refused until --trust-project, then used");
}

// 6. The real command line, with the fake SDK: a team run, the five-phase run, and a bad value that starts nothing
{
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const reg = fileURLToPath(new URL("./stress/fake-sdk/register.mjs", import.meta.url));
  const run = (args, env = {}) => {
    const r = spawnSync(process.execPath, ["--experimental-sqlite", "--no-warnings", "--import", reg, cli, ...args], { encoding: "utf8", timeout: 120_000, env: { ...process.env, AGENT_LOOP_HOME: home, FAKE_STEP_OUTCOMES: "{}", FAKE_MAX_CALLS: "1000", ...env } });
    return { status: r.status, all: `${r.stdout}${r.stderr}` };
  };
  const work = join(scratch, "work-team");
  const data = join(scratch, "data-team");
  const r = run(["run", "add a docstring to the users module", "--dir", repo, "--data-dir", data, "--port", "0", "--no-approval", "--team", "auto"]);
  assert.strictEqual(r.status, 0, r.all.slice(-1200));
  assert.ok(/Team \(auto\)/.test(r.all) && /status: done/.test(r.all), `the team line or the status is missing:\n${r.all.slice(-800)}`);
  const store = new Store(join(data, "agent-loop.db"));
  const rows = store.getPhaseSummaries(store.listRuns()[0].id);
  assert.ok(rows.length >= 3 && rows.every((x) => x.stepId), `the stored steps carry no step ids: ${JSON.stringify(rows.slice(0, 3))}`);
  store.close();
  const data5 = join(scratch, "data-fixed5");
  const f = run(["run", "add a docstring to the users module", "--dir", repo, "--data-dir", data5, "--port", "0", "--no-approval", "--team", "fixed5"], { FAKE_SCENARIO: "trivial-skip", FAKE_STEP_OUTCOMES: "" });
  assert.strictEqual(f.status, 0, f.all.slice(-800));
  const s5 = new Store(join(data5, "agent-loop.db"));
  const rows5 = s5.getPhaseSummaries(s5.listRuns()[0].id);
  assert.ok(rows5.every((x) => !x.stepId) && rows5.some((x) => x.name === "test-designer"), "fixed5 grew step ids or lost a phase");
  s5.close();
  const dataBad = join(scratch, "data-bad");
  const b = run(["run", "add a docstring", "--dir", repo, "--data-dir", dataBad, "--port", "0", "--no-approval", "--team", join(scratch, "nope.json")]);
  assert.strictEqual(b.status, 1, b.all.slice(-500));
  assert.ok(!existsSync(join(dataBad, "agent-loop.db")), "a bad --team value created a database");
  assert.ok(/--team/.test(b.all) && /nope\.json/.test(b.all), `the error does not name the flag and the file:\n${b.all.slice(-400)}`);
  assert.ok(/repair budget: 20\b/.test(r.all), `the repair budget of a small team is not printed:\n${r.all.slice(-600)}`);
  const big = join(scratch, "big-team.json");
  writeFileSync(big, JSON.stringify({ class: "feature", size: "large", reason: "two modules", steps: [
    { id: "s1", role: "researcher", brief: "look around", why: "unfamiliar" },
    { id: "s2", role: "planner", after: ["s1"], why: "plan" },
    { id: "s3", role: "builder", slice: { name: "api", paths: ["src/api"] }, after: ["s2"], why: "slice 1" },
    { id: "s4", role: "verifier", checks: "s3", why: "check 1" },
    { id: "s5", role: "builder", slice: { name: "ui", paths: ["src/ui"] }, after: ["s2"], why: "slice 2" },
    { id: "s6", role: "verifier", checks: "s5", why: "check 2" },
    { id: "s7", role: "integrator", after: ["s4", "s6"], why: "join" },
    { id: "s8", role: "security-reviewer", after: ["s7"], why: "review" },
    { id: "s9", role: "gatekeeper", after: ["s8"], why: "gate" },
  ] }));
  const rb = run(["run", "add pagination to src/api and a page in src/ui", "--dir", repo, "--data-dir", join(scratch, "data-big"), "--port", "0", "--no-approval", "--team", big]);
  assert.strictEqual(rb.status, 0, rb.all.slice(-800));
  assert.ok(/Team \(file\): 9 steps/.test(rb.all) && /repair budget: 27\b/.test(rb.all), `a nine-step team's summary and budget:\n${rb.all.slice(0, 900)}`);
  const ro = run(["run", "add a docstring", "--dir", repo, "--data-dir", join(scratch, "data-override"), "--port", "0", "--no-approval", "--team", planFile, "--max-repairs", "5"]);
  assert.ok(/repair budget: 5\b/.test(ro.all), `--max-repairs does not override the team's budget:\n${ro.all.slice(0, 600)}`);
  const refusedPlan = join(scratch, "refused.json");
  writeFileSync(refusedPlan, JSON.stringify({ ...PLAN, steps: [...PLAN.steps, { id: "s9", role: "wizard", after: ["s4"], why: "x" }] }));
  const dataRefused = join(scratch, "data-refused");
  const rf = run(["run", "add a docstring", "--dir", repo, "--data-dir", dataRefused, "--port", "0", "--no-approval", "--team", refusedPlan]);
  assert.strictEqual(rf.status, 2, `a plan that is refused exits 2 (usage errors exit 1): ${rf.status}\n${rf.all.slice(-400)}`);
  assert.ok(/wizard/.test(rf.all) && !existsSync(join(dataRefused, "agent-loop.db")), "a refused plan started something, or did not say why");
  console.log("[ok] through the real command line: --team auto runs a team (step ids in the stored run), --team fixed5 runs the five phases as before, and a bad plan file starts nothing (no database)");
}
console.log("\nALL TEAM RUN-CLI TESTS PASSED");
process.exit(0);
