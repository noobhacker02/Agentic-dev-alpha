// Adversary round 1, finding A1: the path-scope hook compared path strings, so a symlink inside --dir (a cloned repo can ship one) walked straight out of it, and
// `link/../x` was judged by its text while the operating system resolves it through the link. This test builds those cases on a real disk and sends them through the
// real hooks. Controls: ordinary files inside --dir, and a symlink that stays inside --dir, must still be allowed.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { createPathScopeHook, createSensitiveFileHook } from "../dist/hooks.js";

if (process.platform === "win32") {
  console.log("[skip] symlink creation needs privileges on Windows; the hook's logic is covered by the POSIX run");
  process.exit(0);
}
const signal = new AbortController().signal;
const pre = (tool, input) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });
const root = realpathSync(mkdtempSync(join(tmpdir(), "scope-")));
const work = join(root, "work"), outside = join(root, "outside"), profile = join(root, "agent-profile");
mkdirSync(join(work, "src"), { recursive: true });
mkdirSync(join(work, "docs"), { recursive: true });
mkdirSync(outside); mkdirSync(join(profile, "Default"), { recursive: true });
writeFileSync(join(work, "src", "app.js"), "ok");
writeFileSync(join(work, ".env"), "TOKEN=x");
writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET");
writeFileSync(join(profile, "Default", "Cookies"), "li_at=SECRET_SESSION_COOKIE");
symlinkSync(profile, join(work, "docs-link"));            // directory link out of --dir (the cloned-repo trick)
symlinkSync(join(outside, "secret.txt"), join(work, "file-link"));  // file link out of --dir
symlinkSync(join(work, "src"), join(work, "inside-link")); // link that stays inside --dir (must keep working)
symlinkSync(join(work, "chain-b"), join(work, "chain-a"));
symlinkSync(outside, join(work, "chain-b"));               // chain: a -> b -> outside
symlinkSync(join(work, "loop-b"), join(work, "loop-a"));
symlinkSync(join(work, "loop-a"), join(work, "loop-b"));   // a loop: must not crash, must not be allowed
symlinkSync(join(outside, "does-not-exist-yet"), join(work, "dangling"));

// A short chain of dangling links that ends inside --dir is fine; one so long it is a bound-check hazard is refused (fail closed).
for (let i = 0; i < 5; i++) symlinkSync(i === 4 ? join(work, "short-final") : join(work, `short-${i + 1}`), join(work, `short-${i}`));
for (let i = 0; i < 45; i++) symlinkSync(i === 44 ? join(work, "long-final") : join(work, `long-${i + 1}`), join(work, `long-${i}`));

const scope = createPathScopeHook(work);
const sensitive = createSensitiveFileHook();
const denies = async (tool, input) => {
  for (const h of [scope, sensitive]) { const r = await h(pre(tool, input), "t", { signal }); if (r?.hookSpecificOutput?.permissionDecision === "deny") return true; }
  return false;
};

// Controls: what must be allowed still is.
for (const [tool, p] of [["Read", join(work, "src/app.js")], ["Read", "src/app.js"], ["Write", join(work, "src/new-file.js")], ["Edit", join(work, "src/app.js")],
  ["Read", join(work, "inside-link/app.js")], ["Write", join(work, "inside-link/created-through-link.js")], ["Glob", join(work, "src")], ["Read", join(work, "src/../src/app.js")]]) {
  assert.ok(!(await denies(tool, { file_path: p, path: p })), `control: ${tool} ${p} was denied but is inside --dir`);
}
assert.ok(!(await denies("Write", { file_path: join(work, "short-0") })), "control: a 5-link dangling chain that ends inside --dir was refused");
console.log("[ok] controls: ordinary files, a new file, a relative path, a symlink that stays inside --dir and a `..` that stays inside are all allowed");

// The attacks.
const attacks = [
  ["read through a directory symlink to the agent profile (the cookie file)", "Read", join(work, "docs-link/Default/Cookies")],
  ["write through a directory symlink", "Write", join(work, "docs-link/Default/planted.txt")],
  ["edit through a directory symlink", "Edit", join(work, "docs-link/Default/Cookies")],
  ["read through a file symlink", "Read", join(work, "file-link")],
  ["write to a file symlink", "Write", join(work, "file-link")],
  ["a new file inside a symlinked directory that leaves --dir", "Write", join(work, "chain-a/new.txt")],
  ["a chain of two symlinks", "Read", join(work, "chain-a/secret.txt")],
  ["`link/../x`: the OS resolves .. through the link, the text does not", "Read", work + "/docs-link/../outside/secret.txt" /* not join(): join would collapse the .. as text, which is the very mistake */],
  ["`link/..` as a directory", "Glob", work + "/docs-link/.."],
  ["relative path through the link", "Read", "docs-link/Default/Cookies"],
  ["a symlink loop (must be refused, not crash)", "Read", join(work, "loop-a/x")],
  ["a dangling symlink to somewhere outside", "Write", join(work, "dangling")],
  ["Grep rooted through a symlink", "Grep", join(work, "docs-link")],
  ["a 45-link chain of dangling links, even though it ends inside --dir (too long to trust)", "Write", join(work, "long-0")],
];
for (const [name, tool, p] of attacks) {
  const input = tool === "Glob" || tool === "Grep" ? { path: p, pattern: "x" } : { file_path: p };
  assert.ok(await denies(tool, input), `${name}: ${tool} ${p} was allowed`);
}
console.log(`[ok] ${attacks.length} ways of leaving --dir through a symlink or a '..' behind one: all denied`);

// A symlink inside --dir that points at a credential file inside --dir is judged by what it points at, not its innocent name.
symlinkSync(join(work, ".env"), join(work, "notes.txt"));
assert.ok(await denies("Read", { file_path: join(work, "notes.txt") }), "an innocently named symlink to .env was readable");
assert.ok(!(await denies("Read", { file_path: join(work, "src/app.js") })), "control: a normal file next to it must still be readable");
console.log("[ok] a symlink named notes.txt that points at .env is refused as the credential file it is");
