// A hook that judges the TEXT of a path is only as good as its agreement with the tool that opens it (adversary round 2: A27, A28, A29, A44). The SDK's file tools expand a leading ~
// to the home directory; the old hook read "~/x" as a directory called "~" inside --dir and let it through. A relative link was judged from the wrong directory, Glob's pattern was
// never looked at, and the credential list knew only exact names. Every row below is a deny beside the ordinary path it must not disturb.
//   npm run build && npm run test:path-text
import assert from "node:assert";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "path-text-"));
const home = join(scratch, "home");
const work = join(scratch, "work");
mkdirSync(home);
mkdirSync(join(work, "src"), { recursive: true });
// The hook asks the operating system for the home directory when it is called, so the test gives it a home of its own.
process.env.HOME = home;
process.env.USERPROFILE = home;
const { createPathScopeHook, createSensitiveFileHook } = await import("../dist/hooks.js");

const sig = new AbortController().signal;
const pre = (tool, input) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });
const decide = async (hook, tool, input) => (await hook(pre(tool, input), "t", { signal: sig }))?.hookSpecificOutput?.permissionDecision ?? "pass";
const scope = createPathScopeHook(work);
const sensitive = createSensitiveFileHook(work);
const denied = async (tool, input) => (await decide(scope, tool, input)) === "deny" || (await decide(sensitive, tool, input)) === "deny";

// 1. A27: ~ means the home directory, to the tools, so it means that to the hook
{
  const inputs = (p) => [["Read", { file_path: p }], ["Write", { file_path: p, content: "x" }], ["Edit", { file_path: p }], ["Glob", { pattern: "*", path: p }], ["Grep", { pattern: "x", path: p }], ["NotebookEdit", { notebook_path: p }]];
  for (const p of ["~/x", "~", "~/.bashrc", "~/.profile", "~/.agent-loop/profile/Default/Cookies", "~/.bash_history", "~/work/../x", "~\\x"]) {
    for (const [tool, input] of inputs(p)) assert.ok(await denied(tool, input), `${tool} ${JSON.stringify(input)}: a path through ~ was allowed`);
  }
  for (const p of ["~root/x", "~nobody", "~someone/.ssh/config"]) {
    for (const [tool, input] of inputs(p)) assert.ok(await denied(tool, input), `${tool} ${JSON.stringify(input)}: another user's home was allowed`);
  }
  // controls: a working directory that really is under the home directory, and names that only look like a tilde
  const inHome = createPathScopeHook(join(home, "proj"));
  mkdirSync(join(home, "proj"), { recursive: true });
  assert.strictEqual(await decide(inHome, "Read", { file_path: "~/proj/notes.txt" }), "pass", "control: ~/proj/notes.txt is inside a working directory that sits in the home directory");
  assert.strictEqual(await decide(inHome, "Read", { file_path: "~/other/notes.txt" }), "deny", "~/other is outside that working directory");
  for (const [tool, input] of [["Read", { file_path: "./~x/notes.txt" }], ["Write", { file_path: "src/~backup.txt", content: "x" }], ["Read", { file_path: "$HOME/x" }], ["Read", { file_path: join(work, "src", "a.ts") }]]) {
    assert.ok(!(await denied(tool, input)), `control: ${tool} ${JSON.stringify(input)} is an ordinary path inside the working directory`);
  }
  console.log("[ok] ~ and ~/x are the home directory to the hook (as to the tools): Read, Write, Edit, Glob, Grep and NotebookEdit are denied, ~user is refused, and a working directory under the home directory still works");
}

// 2. A44: forms Windows reads differently from the way the text looks (argued from the code and run here as strings; the Windows job runs the same strings)
{
  for (const p of ["\\\\attacker\\share\\x", "\\\\?\\C:\\Windows\\x", "C:foo", "d:foo\\bar", "%USERPROFILE%\\x", "%APPDATA%/x", "src/a\u0000.ts"]) {
    assert.ok(await denied("Read", { file_path: p }), `Read ${JSON.stringify(p)}: a path with a form the check cannot place was allowed`);
    assert.ok(await denied("Write", { file_path: p, content: "x" }), `Write ${JSON.stringify(p)} was allowed`);
  }
  // the sensitive-file hook alone (the scope hook may not be in front of it) also refuses what it cannot place
  for (const p of ["~root/x", "\\\\attacker\\share\\x", "C:foo", "%USERPROFILE%\\x"]) assert.strictEqual(await decide(sensitive, "Read", { file_path: p }), "deny", `the sensitive-file hook alone passed ${JSON.stringify(p)}`);
  for (const p of ["src/a.ts", "ab:not-a-drive/x.txt", "100%/x.txt", "src/%20x.txt"]) assert.ok(!(await denied("Read", { file_path: p })), `control: ${JSON.stringify(p)} is an ordinary relative path`);
  console.log("[ok] UNC paths, drive-relative paths, %VARIABLE% paths and NUL are refused before the file system is touched; ordinary names with a colon or a percent sign are not");
}

// 3. A28: a relative link is judged from the working directory, not from wherever the process happens to be
{
  writeFileSync(join(work, ".env"), "SECRET=1\n");
  writeFileSync(join(work, "plain.txt"), "hello\n");
  if (process.platform !== "win32") symlinkSync(".env", join(work, "notes.txt"));
  if (process.platform !== "win32") {
    assert.notStrictEqual(process.cwd(), work, "the test must run from somewhere other than the working directory");
    assert.strictEqual(await decide(sensitive, "Read", { file_path: "notes.txt" }), "deny", "a relative link to .env was read");
    assert.strictEqual(await decide(sensitive, "Read", { file_path: join(work, "notes.txt") }), "deny", "control: the absolute form is denied");
    assert.strictEqual(await decide(createSensitiveFileHook(), "Read", { file_path: "notes.txt" }), "pass", "control: without a working directory the old behaviour (judged from the process directory) is unchanged");
  }
  assert.strictEqual(await decide(sensitive, "Read", { file_path: "plain.txt" }), "pass", "control: an ordinary relative file is left alone");
  assert.strictEqual(await decide(sensitive, "Read", { file_path: ".env" }), "deny", "control: .env itself");
  console.log("[ok] a relative symlink to .env is judged from --dir and denied; the absolute form, an ordinary file and the old no-directory call behave as before");
}

// 4. A29: Glob's pattern is a path too
{
  for (const pattern of ["/etc/host*", "../*", "src/../../*", "{/etc,src}/*", "~/*", "~/.ssh/*", "../../**/*.ts", "/**/*.pem", "\\\\host\\share\\*", "C:foo\\*"]) {
    assert.ok(await denied("Glob", { pattern }), `Glob ${JSON.stringify(pattern)} was allowed`);
    assert.ok(await denied("Glob", { pattern, path: join(work, "src") }), `Glob ${JSON.stringify(pattern)} with a path inside was allowed`);
  }
  for (const pattern of ["**/*.ts", "src/**/*.test.ts", "*.md", `${work}/*.ts`, "{src,test}/**", "src/*/index.ts", "**/.github/**"]) {
    assert.ok(!(await denied("Glob", { pattern })), `control: Glob ${JSON.stringify(pattern)} is an ordinary pattern inside the working directory`);
  }
  assert.ok(!(await denied("Glob", { pattern: "**/*.ts", path: join(work, "src") })), "control: an ordinary pattern with a path inside");
  console.log("[ok] a Glob pattern that is absolute, climbs out, starts with ~, or names an outside directory in a brace is denied; ordinary patterns are not");
}

// 5. A29 and the follow-on: the credential list is names and shapes, not only exact files, and .git holds what makes an auto-approved git command run code
{
  const SECRET = [
    ".env.local", ".env.production", "config/.env.staging", "secrets.yml", "secrets.json", "config/secret.toml", ".docker/config.json", ".kube/config", "id_rsa", "keys/id_ed25519", "server.pem", "certs/private.key", "store.p12", "store.pfx",
    ".pgpass", ".boto", ".s3cfg", ".gnupg/secring.gpg", ".agent-loop/profile/Default/Cookies", ".agent-loop/runs/x/agent-loop.db", ".agent-loop/roster/gatekeeper.md",
    ".git/config", ".git/hooks/pre-commit", ".git/info/attributes", ".git/HEAD", "sub/dir/.git/config", ".env",
  ];
  for (const p of SECRET) {
    for (const tool of ["Read", "Write", "Edit"]) {
      const input = { file_path: join(work, p), ...(tool === "Write" ? { content: "x" } : {}) };
      assert.ok(await denied(tool, input), `${tool} ${p}: a credential or git-internal file was allowed`);
    }
    assert.ok(await denied("Read", { file_path: p }), `Read ${p} (relative) was allowed`);
  }
  const FINE = [".env.example", ".env.sample", ".env.template", ".env.dist", "environment.ts", "src/keys.ts", "docs/secrets.md", ".gitignore", ".gitattributes", ".github/workflows/ci.yml", "legacy.git/x", "src/git.ts", "notes.pem.txt", "README.md", "package.json", "src/a.ts", "keystore-docs.md"];
  for (const p of FINE) {
    for (const tool of ["Read", "Write"]) {
      const input = { file_path: join(work, p), ...(tool === "Write" ? { content: "x" } : {}) };
      assert.ok(!(await denied(tool, input)), `control: ${tool} ${p} is an ordinary file`);
    }
  }
  console.log(`[ok] ${SECRET.length} credential, profile, roster and .git paths are denied for Read, Write and Edit; ${FINE.length} ordinary look-alikes (.env.example, .gitignore, legacy.git, secrets.md) are not`);
}
console.log("\nALL PATH TEXT TESTS PASSED");
