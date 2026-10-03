// The roster (src/team/roster.ts): the built-in roles from docs/TEAM-COMPOSITION.md, user roles from the user's own config directory, and
// the rules a role definition has to meet before it can be on a team (V7: read-only roles get only read tools; V13/G10: a roster file inside the
// project directory is ignored until the user trusts it, and nothing can redefine a built-in role). Every refusal has an accepted twin.
// No model, no network:  npm run build && npm run test:team-roster
import assert from "node:assert";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_ROSTER, NEVER_SKIPPABLE, loadRoster, isReadOnly, toolClasses } from "../dist/team/roster.js";

const byId = (roster) => new Map(roster.map((r) => [r.id, r]));
const builtin = byId(BUILTIN_ROSTER);

// 1. The table in the design, role by role.
{
  const expected = ["composer", "researcher", "planner", "advisor", "test-designer", "builder", "verifier", "integrator", "security-reviewer", "migration-reviewer",
    "a11y-reviewer", "perf-reviewer", "ui-tester", "desktop-tester", "docs-writer", "gatekeeper", "adversary", "watchdog", "learner"];
  assert.deepStrictEqual([...builtin.keys()].sort(), [...expected].sort(), "the built-in roster is not the roster in docs/TEAM-COMPOSITION.md");
  const caps = { composer: 1, researcher: 2, planner: 1, advisor: 3, "test-designer": 2, builder: 6, verifier: 6, integrator: 1, "security-reviewer": 1, gatekeeper: 1, adversary: 1 };
  for (const [id, max] of Object.entries(caps)) assert.strictEqual(builtin.get(id).max, max, `${id} cap`);
  assert.deepStrictEqual([...NEVER_SKIPPABLE].sort(), ["builder", "composer", "gatekeeper", "verifier", "watchdog"], "never-skippable roles (V12)");
  for (const id of NEVER_SKIPPABLE) assert.strictEqual(builtin.get(id).skippable, "no", `${id} must not be marked skippable`);
  assert.strictEqual(builtin.get("security-reviewer").mandatoryOnSignal, "security");
  assert.strictEqual(builtin.get("migration-reviewer").mandatoryOnSignal, "migration");
  for (const r of BUILTIN_ROSTER) assert.ok(r.builtin === true && typeof r.when === "string" && r.when.length > 5, `${r.id} has no stated reason to exist`);
  console.log(`[ok] the built-in roster is the ${BUILTIN_ROSTER.length} roles of the design, with its caps, never-skippable roles and mandatory-by-signal reviewers`);
}

// 2. V7: tools come from the definition. Read-only roles can write nothing; the writers each have a scope.
{
  const writers = BUILTIN_ROSTER.filter((r) => !isReadOnly(r)).map((r) => `${r.id}:${r.writeScope}`).sort();
  assert.deepStrictEqual(writers, ["builder:slice", "docs-writer:docs", "integrator:shared", "test-designer:tests"], "exactly these roles may write, each with its own scope");
  for (const id of ["researcher", "advisor", "verifier", "security-reviewer", "migration-reviewer", "gatekeeper", "adversary", "composer", "ui-tester"]) {
    assert.ok(isReadOnly(builtin.get(id)), `${id} must be read-only`);
    assert.ok(!toolClasses(builtin.get(id)).some((t) => t.startsWith("write")), `${id} was handed a write tool`);
  }
  assert.ok(toolClasses(builtin.get("verifier")).includes("run"), "control: a verifier runs checks");
  assert.ok(toolClasses(builtin.get("builder")).includes("write:slice"), "control: a builder writes inside its slice");
  assert.ok(!toolClasses(builtin.get("researcher")).includes("web"), "web search is LIVE-only and is not in the base definition");
  console.log("[ok] V7: read-only roles have no write tool; the four writers each have a scope; a verifier runs checks and a researcher has no web");
}

// 3. User roles, from a config directory: accepted with a definition and instructions, refused when they break a rule.
const home = mkdtempSync(join(tmpdir(), "team-roster-"));
const write = (dir, id, def, md = "Review it and say what you found.") => {
  mkdirSync(dir, { recursive: true });
  if (def !== null) writeFileSync(join(dir, `${id}.json`), typeof def === "string" ? def : JSON.stringify(def));
  if (md !== null) writeFileSync(join(dir, `${id}.md`), md); // (null, not undefined: undefined would pick the default text)
};
const userDir = join(home, "user-roster");
const good = { kind: "check", model: "sonnet", tools: ["read", "run"], writeScope: "none", skippable: true, max: 1, when: ["ui"], description: "Checks the copy of every changed page." };
{
  write(userDir, "copy-reviewer", good);
  const r = loadRoster({ userDir });
  assert.ok(byId(r.roles).has("copy-reviewer"), `a valid user role was not loaded: ${JSON.stringify(r.rejected)}`);
  assert.strictEqual(byId(r.roles).get("copy-reviewer").builtin, false);
  assert.strictEqual(byId(r.roles).get("copy-reviewer").instructions, "Review it and say what you found.");
  assert.strictEqual(r.roles.length, BUILTIN_ROSTER.length + 1);
  assert.deepStrictEqual(r.rejected, []);
  console.log("[ok] a user role with a definition and instructions joins the roster");
}
{
  const cases = [
    ["a check role that writes (V7)", "bad-writer", { ...good, writeScope: "slice" }, /read-only|write/i],
    ["a write role with no scope", "no-scope", { kind: "build", model: "haiku", tools: ["read", "write"], skippable: true, max: 1 }, /scope/i],
    ["a write scope that is not a known one", "any-scope", { kind: "build", model: "haiku", tools: ["read"], writeScope: "any", skippable: true, max: 1 }, /scope/i],
    ["redefining a built-in role (G10)", "gatekeeper", { ...good, kind: "gate" }, /built-in|redefin/i],
    ["a gate or monitor or meta kind", "my-gate", { ...good, kind: "gate" }, /kind/i],
    ["an unknown model alias", "odd-model", { ...good, model: "gpt-9" }, /model/i],
    ["an unknown tool", "odd-tool", { ...good, tools: ["read", "root-shell"] }, /tool/i],
    ["a cap above the limit", "big-cap", { ...good, max: 50 }, /max/i],
    ["an unknown field", "extra", { ...good, mandatoryOnSignal: "security", skipChecks: true }, /field/i],
    ["a bad id", "Bad_ID", { ...good }, /id/i],
    ["malformed JSON", "broken", "{ not json", /json/i],
  ];
  for (const [what, id, def, why] of cases) {
    const dir = join(home, `case-${id.replace(/\W/g, "_")}`);
    write(dir, id, def);
    const r = loadRoster({ userDir: dir });
    assert.ok(!byId(r.roles).has(id) || builtin.has(id), `${what}: the role was accepted`);
    assert.strictEqual(r.roles.length, BUILTIN_ROSTER.length, `${what}: the roster changed`);
    assert.ok(r.rejected.some((x) => why.test(x.reason)), `${what}: rejected for the wrong reason: ${JSON.stringify(r.rejected)}`);
  }
  // instructions are required, and bounded
  const dir = join(home, "no-instructions");
  write(dir, "silent-role", good, null);
  assert.ok(loadRoster({ userDir: dir }).rejected.some((x) => /instructions/i.test(x.reason)), "a role with no instructions file was accepted");
  const dir2 = join(home, "huge-instructions");
  write(dir2, "wordy-role", good, "x".repeat(60_000));
  assert.ok(loadRoster({ userDir: dir2 }).rejected.some((x) => /instructions|large|size/i.test(x.reason)), "a 60 KB instructions file was accepted");
  console.log(`[ok] ${cases.length + 2} ways to write a bad role are each refused, for the stated reason, and leave the roster as it was`);
}

// 4. V13 / G10: a roster file inside the project is ignored until the user trusts it, and even then cannot redefine a built-in.
{
  const projectDir = join(home, "project", ".agent-loop", "roster");
  write(projectDir, "copy-reviewer", good);
  write(projectDir, "gatekeeper", { ...good, kind: "gate", tools: ["read"] });
  const untrusted = loadRoster({ projectDir, trustProject: false });
  assert.strictEqual(untrusted.roles.length, BUILTIN_ROSTER.length, "an untrusted project roster changed the roster");
  assert.ok(untrusted.ignored.length === 2 && untrusted.ignored.every((x) => /trust/i.test(x.reason)), `the ignored files are not reported: ${JSON.stringify(untrusted.ignored)}`);
  const trusted = loadRoster({ projectDir, trustProject: true });
  assert.ok(byId(trusted.roles).has("copy-reviewer"), "control: a trusted project role must load");
  assert.ok(trusted.roles.filter((r) => r.id === "gatekeeper").length === 1 && byId(trusted.roles).get("gatekeeper").builtin, "a trusted project roster redefined the gatekeeper");
  assert.ok(trusted.rejected.some((x) => /built-in|redefin/i.test(x.reason)), "the attempt to redefine the gatekeeper was not reported");
  // the same file in the user's own directory needs no trust (control)
  assert.ok(byId(loadRoster({ userDir: projectDir }).roles).has("copy-reviewer"), "control: the same file in the user's directory loads without trust");
  console.log("[ok] V13/G10: a project roster is ignored (and reported) until trusted; a trusted one still cannot redefine a built-in; the user's own directory needs no trust");
}

// 5. The loader reads only plain files directly in the directory, and survives what is lying around.
{
  const dir = join(home, "messy");
  mkdirSync(join(dir, "nested"), { recursive: true });
  write(join(dir, "nested"), "deep-role", good);
  write(dir, "ok-role", good);
  writeFileSync(join(dir, "notes.txt"), "not a role");
  mkdirSync(join(dir, "folder-role.json")); // a directory named like a definition
  if (process.platform !== "win32") {
    write(join(home, "elsewhere"), "linked-role", good);
    symlinkSync(join(home, "elsewhere", "linked-role.json"), join(dir, "linked-role.json"));
    symlinkSync(join(home, "elsewhere", "linked-role.md"), join(dir, "linked-role.md"));
  }
  writeFileSync(join(dir, "..hidden.json"), "{}");
  const r = loadRoster({ userDir: dir });
  assert.ok(byId(r.roles).has("ok-role"), "control: the ordinary file loads");
  assert.ok(!byId(r.roles).has("deep-role"), "a file in a subdirectory was loaded");
  assert.ok(!byId(r.roles).has("folder-role") && !r.rejected.some((x) => /folder-role/.test(x.file)), "a directory named like a definition was read or reported as a bad file");
  assert.ok(!byId(r.roles).has("linked-role"), "a symbolic link to a definition was followed");
  assert.ok(!loadRoster({ userDir: join(home, "does-not-exist") }).rejected.length, "a missing directory is not an error");
  console.log("[ok] only plain definition files directly in the directory are read; a missing directory is fine");
}
console.log("\nALL TEAM ROSTER TESTS PASSED");
