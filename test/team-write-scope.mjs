// V7 and V8, at the moment of the write (docs/TEAM-COMPOSITION.md): a role's definition says where it may write, and the hook chain enforces it from the definition, never from the role's own text.
// A reviewer has no write scope at all, a builder writes inside its slice, a test designer in the tests, a docs writer in the docs, an integrator in the shared files and the slices. Bash is not judged here
// (the diff audit after the step closes that, V8); the file tools are, for every spelling of a path that reaches outside the scope: `..`, an absolute path, a link, a name that only shares a prefix, a reserved file.
// Real disk (a project with a symlink), the real hook, no API.
//   npm run build && npm run test:team-write-scope
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { createWriteScopeHook, decideWrite } from "../dist/team/write-scope.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "write-scope-")));
const work = join(root, "work"), outside = join(root, "outside");
for (const d of ["src/api", "src/api2", "src/ui", "test", "tests/unit", "docs/guide", "src/api/__tests__", "node_modules/x"]) mkdirSync(join(work, d), { recursive: true });
mkdirSync(outside);
writeFileSync(join(work, "package.json"), "{}");
writeFileSync(join(work, "src/api/a.ts"), "x");
const posix = process.platform !== "win32";
if (posix) {
  symlinkSync(join(work, "src/ui"), join(work, "src/api/to-ui"));   // a link inside the slice that leads to another slice
  symlinkSync(outside, join(work, "src/api/to-outside"));           // and one that leads out of the project
}

const signal = new AbortController().signal;
const pre = (tool, input) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });
const slice = { name: "api", paths: ["src/api"] };
const rules = {
  none: { role: "security-reviewer", writeScope: "none", workDir: work },
  slice: { role: "builder", writeScope: "slice", slice, workDir: work },
  tests: { role: "test-designer", writeScope: "tests", workDir: work },
  docs: { role: "docs-writer", writeScope: "docs", workDir: work },
  shared: { role: "integrator", writeScope: "shared", allPrefixes: ["src/api", "src/ui"], workDir: work },
};
const allowed = (rule, path) => decideWrite(path, rule).allow === true;
const check = (rule, yes, no, label) => {
  for (const p of yes) assert.ok(allowed(rule, p), `${label}: ${JSON.stringify(p)} should be allowed: ${JSON.stringify(decideWrite(p, rule))}`);
  for (const p of no) assert.ok(!allowed(rule, p), `${label}: ${JSON.stringify(p)} should be refused`);
};
const abs = (p) => join(work, p);

// 1. no write scope: nothing, whatever the path
check(rules.none, [], ["src/api/a.ts", abs("src/api/a.ts"), "docs/guide/x.md", "README.md", "REPORT.md", "../x", ""], "none");

// 2. slice: inside the slice's directory and nowhere else
check(rules.slice, ["src/api/a.ts", abs("src/api/a.ts"), "src/api/new/deep/file.ts", "./src/api/b.ts", "src/API/case.ts"],
  ["src/api2/x.ts", "src/ui/x.ts", "src/apix.ts", "src/api/../ui/x.ts", "../outside/x", abs("../outside/x"), "/etc/hosts", "C:\\Windows\\x", "package.json", abs("package.json"),
    "src/api/node_modules/y/index.js", "src/api/package.json", ".git/config", "src/api/.git/hooks/pre-commit", "", "src"], "slice");
if (posix) check(rules.slice, [], ["src/api/to-ui/x.ts", "src/api/to-outside/x.ts", abs("src/api/to-ui/x.ts")], "slice, through links");
// a backslash is a separator on Windows and an ordinary character in a file name everywhere else: the hook reads a path the way the operating system will
if (posix) check(rules.slice, [], ["src\\api\\win.ts"], "slice, backslashes on POSIX (a file named src\\api\\win.ts in the project root)");
else check(rules.slice, ["src\\api\\win.ts"], [], "slice, backslashes on Windows");

// 3. tests: the tests directories and test-named files
check(rules.tests, ["test/a.test.mjs", "tests/unit/b.py", "src/api/__tests__/c.ts", "src/foo.test.ts", "src/foo.spec.js", "src/foo_test.go", "test_thing.py", "test/new/dir/x.js"],
  ["src/foo.ts", "test/../src/foo.ts", "package.json", "src/testing.ts", "src/contest/x.ts", "docs/x.md", "../test/x", "test", "src/test", "test/node_modules/x.js", "src/foo.test", "test/package.json", "tests/dist/x.js"], "tests");

// 4. docs: README, CHANGELOG and the docs directory
check(rules.docs, ["README.md", "readme.md", "CHANGELOG.md", "docs/guide/x.md", "docs/new/y.md", "CONTRIBUTING.md", "src/api/README.md"],
  ["src/x.ts", "docs/../src/x.ts", "notes.md", "package.json", "LICENSE", "docs-extra/x.md", "../README.md", "docs", "README.sh", "CHANGELOG.js", "docs/node_modules/x.md", "docs/package.json", "docs/dist/x.md", "myreadme.md", "src/not-a-readme.md"], "docs");

// 5. shared: the shared files and the slices, not the rest
check(rules.shared, ["package.json", "package-lock.json", "src/api/a.ts", "src/ui/b.ts", abs("package.json"), "dist/out.js"],
  ["src/other/x.ts", "README.md", "../package.json", ".git/config", "node_modules/x/y.js", "src/api/.git/config"], "shared");

// 6. the hook: the four file-writing tools are judged, the other tools pass, a refusal says who and why in words, a bad input is a refusal
{
  const hook = createWriteScopeHook(rules.slice);
  const run = (tool, input) => hook(pre(tool, input), undefined, { signal });
  const denied = (r) => r?.hookSpecificOutput?.permissionDecision === "deny";
  for (const [tool, arg] of [["Write", "file_path"], ["Edit", "file_path"], ["MultiEdit", "file_path"], ["NotebookEdit", "notebook_path"]]) {
    assert.deepStrictEqual(await run(tool, { [arg]: "src/api/ok.ts" }), {}, `${tool} inside the slice should pass`);
    const r = await run(tool, { [arg]: "src/ui/no.ts" });
    assert.ok(denied(r), `${tool} outside the slice should be denied`);
    assert.ok(/builder/.test(r.hookSpecificOutput.permissionDecisionReason) && /slice/.test(r.hookSpecificOutput.permissionDecisionReason) && /src\/ui\/no\.ts/.test(r.hookSpecificOutput.permissionDecisionReason), `the refusal does not say who, which scope and which path: ${r.hookSpecificOutput.permissionDecisionReason}`);
  }
  for (const tool of ["Read", "Glob", "Grep", "Bash", "mcp__browser__open"]) assert.deepStrictEqual(await run(tool, { file_path: "src/ui/x.ts", command: "echo hi > src/ui/x" }), {}, `${tool} is not a file write and is not judged here`);
  assert.ok(denied(await run("Write", {})), "a write with no path should be denied");
  assert.ok(denied(await run("Write", { file_path: 42 })), "a write with a path that is not text should be denied");
  assert.ok(denied(await run("Write", { file_path: "src/api/x\u0000.ts" })), "a path with a NUL byte should be denied");
  assert.ok(denied(await run("Write", { file_path: "src/api/x\u001b[2J.ts" })), "a path with a control byte should be denied");
  // the reasons say what is wrong, so an agent (and the person reading the log) can tell a missing path from a path outside the scope
  assert.ok(/names no path/.test(decideWrite("", rules.slice).reason) && /names no path/.test(decideWrite(undefined, rules.slice).reason), "an empty or missing path is not called what it is");
  assert.ok(/no slice/.test(decideWrite("src/api/a.ts", { role: "builder", writeScope: "slice", workDir: work }).reason), "a slice step with no slice is not called what it is");
  assert.ok(/write scope: slice/.test(decideWrite("src/ui/x.ts", rules.slice).reason), "the refusal does not name the scope");
  for (const root of [".", work, work + "/"]) assert.ok(/cannot be placed inside it/.test(decideWrite(root, rules.slice).reason), `the project directory itself (${root}) is not called what it is: ${decideWrite(root, rules.slice).reason}`);
  const noneHook = createWriteScopeHook(rules.none);
  const r = await noneHook(pre("Write", { file_path: "REPORT.md" }), undefined, { signal });
  assert.ok(denied(r) && /security-reviewer/.test(r.hookSpecificOutput.permissionDecisionReason) && /read-only|no write/i.test(r.hookSpecificOutput.permissionDecisionReason), `a read-only role's refusal: ${r.hookSpecificOutput?.permissionDecisionReason}`);
  assert.deepStrictEqual(await hook({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "src/ui/x.ts" } }, undefined, { signal }), {}, "only PreToolUse is judged");
}

// 7. a hostile role id or slice in the rule cannot widen anything: an unknown scope is a refusal, a slice scope with no slice is a refusal, a slice that owns the whole project is not honoured
{
  assert.ok(!allowed({ role: "x", writeScope: "everything", workDir: work }, "src/api/a.ts"), "an unknown scope was treated as allowed");
  assert.ok(!allowed({ role: "x", writeScope: "slice", workDir: work }, "src/api/a.ts"), "a slice scope with no slice was treated as allowed");
  assert.ok(!allowed({ role: "x", writeScope: "slice", slice: { name: "all", paths: ["."] }, workDir: work }, "src/api/a.ts"), "a slice that is the whole project was honoured");
  assert.ok(!allowed({ role: "x", writeScope: "slice", slice: { name: "out", paths: ["../outside"] }, workDir: work }, "../outside/x"), "a slice outside the project was honoured");
  assert.ok(!allowed({ role: "x", writeScope: "shared", workDir: work }, "src/api/a.ts"), "a shared scope with no prefixes allowed a slice file");
  assert.ok(allowed({ role: "x", writeScope: "shared", workDir: work }, "package.json"), "a shared scope with no prefixes should still own the shared files");
}
console.log("[ok] write scope from the role's definition: none, slice, tests, docs and shared, every spelling of a path outside them refused (.., absolute, links, a shared name prefix, reserved files, control bytes)");
console.log("\nALL TEAM WRITE-SCOPE TESTS PASSED");
