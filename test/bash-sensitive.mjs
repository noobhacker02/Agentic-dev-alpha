// A credential inside --dir is still a credential (threat D5; found when the file-tool scope for the agent-loop home was checked): the file tools refuse `.env`, `.agent-loop/...`, key files and `.git`, and a shell command that names one
// of them used to run without a prompt because "inside the working directory" was the whole test. Now it asks, like the file tool refuses. Controls: ordinary reads inside --dir stay quiet, and so do the files meant to be committed
// (`.env.example`) and names that only look alike (`environment.md`, `.gitignore`, `.github`).
//   npm run build && npm run test:bash-sensitive
import assert from "node:assert";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalPlan } from "../dist/hooks.js";

const posix = process.platform !== "win32";
const root = realpathSync(mkdtempSync(join(tmpdir(), "bash-sensitive-")));
const work = join(root, "work");
mkdirSync(join(work, "src"), { recursive: true });
mkdirSync(join(work, ".agent-loop", "profiles", "linkedin", "Default"), { recursive: true });
mkdirSync(join(work, ".git"), { recursive: true });
mkdirSync(join(work, ".github"), { recursive: true });
mkdirSync(join(work, "docs"), { recursive: true });
for (const f of ["notes.txt", ".env", ".env.local", ".env.example", ".gitignore", "key.pem", "id_rsa", "secrets.json", "src/a.ts", "docs/environment.md", ".git/config", ".agent-loop/profiles/linkedin/Default/Cookies"]) writeFileSync(join(work, f), "x\n");
if (posix) { symlinkSync(join(work, ".env"), join(work, "innocent.txt")); symlinkSync(join(work, "notes.txt"), join(work, ".env.shadow")); } // a harmless file under a credential's name, and a credential under a harmless name

const quiet = (cmd) => { const p = approvalPlan("Bash", { command: cmd }, work); return p?.readOnly === true; };

const ordinary = ["cat notes.txt", "ls", "ls src", "cat src/a.ts", "head -n 3 notes.txt", "grep -n x notes.txt", "cat docs/environment.md", "cat .env.example", "cat .gitignore", "ls .github", "git status", "git diff", "cd src && ls", "cat notes.txt | sort", "wc -l notes.txt", "find src -name '*.ts'"];
for (const c of ordinary) assert.ok(quiet(c), `control: ${c} asked but is ordinary reading inside --dir`);

const asks = [
  "cat .env", "cat ./.env", "cat src/../.env", "head -n 1 .env.local", "grep TOKEN .env", "sed -n p .env", "tail -n 2 .env.local", "wc -c .env",
  "cat .agent-loop/profiles/linkedin/Default/Cookies", "ls .agent-loop/profiles", "ls .agent-loop", "head -c 100 .agent-loop/profiles/linkedin/Default/Cookies", "grep -r li_at .agent-loop", "find .agent-loop -type f",
  "cat key.pem", "cat id_rsa", "cat secrets.json", "cat .git/config", "ls .git",
  "cd .agent-loop && ls", "cd .agent-loop/profiles && cat linkedin/Default/Cookies", "grep x < .env", "cat notes.txt .env", "cat notes.txt | grep x; cat .env",
  ...(posix ? ["cat innocent.txt", "cat .env.shadow"] : []), // the file tools judge the name as written too, so the shell does not guess it is harmless
];
for (const c of asks) assert.ok(!quiet(c), `${c} ran without a prompt but names a credential file`);

// the same words in the file tool's hook are refused: the two agree
import { createSensitiveFileHook } from "../dist/hooks.js";
const sensitive = createSensitiveFileHook(work);
const signal = new AbortController().signal;
for (const p of [".env", ".agent-loop/profiles/linkedin/Default/Cookies", "key.pem", ".git/config"]) {
  const r = await sensitive({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(work, p) } }, "t", { signal });
  assert.strictEqual(r?.hookSpecificOutput?.permissionDecision, "deny", `the file tool allowed ${p}`);
}
console.log(`[ok] ${ordinary.length} ordinary reads inside --dir stay quiet; ${asks.length} shell commands that name a credential file (.env, the agent-loop home, key files, .git, through a link, a cd, a redirect) ask, as the file tool refuses`);
console.log("\nALL BASH SENSITIVE TESTS PASSED");
process.exit(0);
