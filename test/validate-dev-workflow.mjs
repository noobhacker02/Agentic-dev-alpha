// Uses agent-loop's own tooling to answer the project's actual meta-question: does the
// dev-workflow skill (in the sibling Dev-Skill repo) really trigger and really get followed
// on an ordinary feature request, with nobody saying "spec" or "workflow" out loud?
//
// This is NOT one of agent-loop's five pipeline phases -- it's a standalone audit script that
// reuses the same query()-streaming pattern. Forcing it into PipelineConfig/PhaseName would be
// over-engineering for a one-off validation tool.
//
// What it does:
//   1. Seeds a small, real existing repo (git init, one committed file with one existing route).
//   2. Installs dev-workflow as a real project skill (.claude/skills/dev-workflow/), exactly the
//      way a real user would, by copying the actual committed skill directory -- not a stub.
//   3. Runs ONE real Agent SDK session with an ordinary, non-trigger-word feature request.
//   4. Checks, independently of anything the session claims: did the Skill tool actually fire,
//      did the artifacts dev-workflow's own steps require actually appear (SPEC.md, a CHANGELOG
//      entry, installed hooks, a local commit, a committed STATUS.md, no push attempted), and
//      does the resulting feature actually work when run for real.
//
// Spends real API tokens on one non-trivial session (bounded by maxTurns, not a fixed task list).
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import assert from "node:assert";
import { resolveDevWorkflowSkillPath } from "./resolve-skill-source.mjs";

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, deadlineMs) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < deadlineMs) {
    try {
      return await fetch(url);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server never responded at ${url} within ${deadlineMs}ms: ${lastErr?.message}`);
}

/** First numeric, non-negative top-level field -- a plausible "uptime in seconds" value regardless
 * of what the model happened to name it, so this doesn't hardcode one exact field name. */
function findUptimeField(obj) {
  if (!obj || typeof obj !== "object") return null;
  const named = Object.entries(obj).find(([k, v]) => /uptime|seconds|elapsed/i.test(k) && typeof v === "number");
  if (named) return { key: named[0], value: named[1] };
  const anyNumeric = Object.entries(obj).find(([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0);
  return anyNumeric ? { key: anyNumeric[0], value: anyNumeric[1] } : null;
}

/** A file is only really "committed" if it exists at HEAD *and* has no staged or unstaged changes
 * relative to HEAD -- `git ls-files --error-unmatch` alone (the original check) only proves the
 * file is in the index, which a freshly-staged-but-never-committed file also satisfies. */
function fileCommittedClean(repoDir, relPath) {
  try {
    execFileSync("git", ["cat-file", "-e", `HEAD:${relPath}`], { cwd: repoDir });
  } catch {
    return false;
  }
  const status = execFileSync("git", ["status", "--porcelain", "--", relPath], { cwd: repoDir, encoding: "utf8" }).trim();
  return status === "";
}

// Always fetches the current published dev-workflow skill from GitHub by default (see
// resolve-skill-source.mjs) -- not a relative path into a sibling directory, which would only
// work by accident of one development session's layout and breaks for anyone else.
const DEV_WORKFLOW_SRC = resolveDevWorkflowSkillPath();
assert.ok(existsSync(join(DEV_WORKFLOW_SRC, "SKILL.md")), `dev-workflow skill not found at ${DEV_WORKFLOW_SRC}`);

const repo = mkdtempSync(join(tmpdir(), "dev-workflow-validate-"));
console.log(`[setup] seeded repo: ${repo}`);

function git(args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

// 1. Seed a small, real existing repo -- an ordinary Node app with one existing route, so this
// exercises "existing repo, add a feature" rather than the already-covered "brand new project" path.
writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "seed-app", version: "1.0.0", main: "server.js" }, null, 2) + "\n");
writeFileSync(
  join(repo, "server.js"),
  `const http = require("node:http");

const server = http.createServer((req, res) => {
  if (req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pong: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(\`listening on \${PORT}\`));
`
);
git(["init", "-q"]);
git(["config", "user.email", "test@example.com"]);
git(["config", "user.name", "Test Seed"]);
git(["add", "-A"]);
git(["commit", "-q", "-m", "Initial seed app with /ping route"]);
console.log("[ok] seeded a real existing repo with one committed route");

// F9: a real (disposable, local-only) bare remote to check against, instead of only grepping Bash
// commands for "git push" -- a text match is evidence of an attempt, not enforcement, and misses
// anything that doesn't literally run that string. This gives an actual ground truth: did anything
// ever reach the remote's refs.
const remoteDir = mkdtempSync(join(tmpdir(), "dev-workflow-validate-remote-"));
execFileSync("git", ["init", "-q", "--bare", remoteDir]);
git(["remote", "add", "origin", remoteDir]);
console.log(`[ok] added a disposable bare remote to check against: ${remoteDir}`);

// 2. Install dev-workflow as a real project skill -- copy the actual committed skill directory.
const skillDest = join(repo, ".claude", "skills", "dev-workflow");
mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
cpSync(DEV_WORKFLOW_SRC, skillDest, { recursive: true });
console.log(`[ok] installed dev-workflow as a project skill at ${skillDest}`);

// 3. Run one real session with an ordinary feature request -- no "spec"/"workflow" trigger words.
const TASK = "This app currently only has a /ping route. Add a /health route that returns JSON with the server's status and how many seconds the process has been running.";

let sawInitSkills = null;
let sawSkillInvocation = false;
let sawGitPush = false;
const toolCalls = [];
let lastAssistantText = "";
let resultSubtype = null;

console.log("[run] starting real Agent SDK session (this spends real API tokens)...");
// NOTE: permissionMode "bypassPermissions" / --dangerously-skip-permissions is refused by
// Claude Code outright when running as root (a real, deliberate safety restriction hit while
// building this script -- this sandbox runs as root). A PreToolUse hook that unconditionally
// allows is the correct root-safe substitute: hooks run before permission-mode evaluation, so
// this isn't a workaround, it's the documented mechanism (same one agent-loop's own approval
// hook in src/hooks.ts uses when requireApproval is false).
const autoAllowHook = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  return {
    hookSpecificOutput: {
      hookEventName: input.hook_event_name,
      permissionDecision: "allow",
      permissionDecisionReason: "unattended dev-workflow validation run",
    },
  };
};

// F5: `settingSources: ["user", "project"]` loaded the real user's personal settings/skills into
// this experiment -- a personal skill of the same or similar name could satisfy the trigger check
// by coincidence, and this test's result would depend on whoever's machine it ran on. Project-only
// isolates it to exactly the one skill this seeded repo installed.
const stream = query({
  prompt: TASK,
  options: {
    cwd: repo,
    settingSources: ["project"],
    skills: "all",
    hooks: { PreToolUse: [{ hooks: [autoAllowHook] }] },
    maxTurns: 80,
    env: { ...process.env },
  },
});

for await (const message of stream) {
  if (message.type === "system" && message.subtype === "init") {
    sawInitSkills = message.skills ?? [];
    console.log(`[info] init message skills array: ${JSON.stringify(sawInitSkills)}`);
  } else if (message.type === "assistant") {
    for (const block of message.message?.content ?? []) {
      if (block.type === "text") {
        lastAssistantText = block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push(block.name);
        if (block.name === "Skill") {
          // F5: don't count *any* Skill invocation -- check the actual requested skill identity so
          // a differently-named skill (or a scoped variant like "somedir:dev-workflow") can't
          // silently satisfy this check instead of the one this test actually installed.
          const invoked = String(block.input?.skill ?? "");
          if (invoked === "dev-workflow" || invoked.endsWith(":dev-workflow")) {
            sawSkillInvocation = true;
            console.log(`[click] dev-workflow Skill invoked with input: ${JSON.stringify(block.input)}`);
          } else {
            console.log(`[info] Skill tool invoked for a different skill (not counted): ${invoked}`);
          }
        }
        if (block.name === "Bash" && typeof block.input?.command === "string" && /git\s+push/.test(block.input.command)) {
          sawGitPush = true;
          console.log(`[!!] session attempted a git push: ${block.input.command}`);
        }
      }
    }
  } else if (message.type === "result") {
    resultSubtype = message.subtype;
    console.log(`[done] session ended, result subtype: ${resultSubtype}`);
  }
}

// 4. Independently check the real filesystem/git state -- not trusting the session's own claims.
const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}${detail ? " -- " + detail : ""}`);
}

check("init message listed dev-workflow as a discovered skill", Array.isArray(sawInitSkills) && sawInitSkills.some((s) => String(s).includes("dev-workflow")), JSON.stringify(sawInitSkills));
check("the dev-workflow Skill tool was actually invoked (real trigger, not just discovery, and not a different skill)", sawSkillInvocation);
check("session's own Bash calls never contained a literal git push (observational signal only)", !sawGitPush);

// F9: the actual enforcement -- did anything ever reach the disposable remote's refs, regardless of
// how it got there (Bash, an MCP git tool, anything else the text-match above wouldn't catch).
let remoteUnchanged = true;
let remoteDetail = "";
try {
  const remoteRefs = execFileSync("git", ["ls-remote", remoteDir], { encoding: "utf8" }).trim();
  remoteUnchanged = remoteRefs === "";
  remoteDetail = remoteUnchanged ? "remote has no refs" : `remote gained refs: ${remoteRefs}`;
} catch (err) {
  remoteDetail = `ls-remote failed (treated as unchanged): ${err.message}`;
}
check("nothing actually reached the real disposable remote", remoteUnchanged, remoteDetail);

let specFiles = [];
try {
  specFiles = execFileSync("bash", ["-c", "find specs -name SPEC.md 2>/dev/null || true"], { cwd: repo, encoding: "utf8" }).trim().split("\n").filter(Boolean);
} catch { /* no specs dir */ }
check("a SPEC.md was written under specs/", specFiles.length > 0, specFiles.join(", "));

const changelogPath = join(repo, "CHANGELOG.md");
const changelogExists = existsSync(changelogPath);
check("CHANGELOG.md exists with an Unreleased entry", changelogExists && /unreleased/i.test(readFileSync(changelogPath, "utf8")));

const hooksInstalled = existsSync(join(repo, ".githooks", "pre-commit"));
let hooksPathConfigured = false;
try {
  hooksPathConfigured = git(["config", "core.hooksPath"]).trim() === ".githooks";
} catch { /* not set */ }
check("git hooks were installed (Step 0)", hooksInstalled && hooksPathConfigured, `dir=${hooksInstalled} config=${hooksPathConfigured}`);

let commitCount = 0;
try {
  commitCount = parseInt(git(["rev-list", "--count", "HEAD"]).trim(), 10);
} catch { /* no commits */ }
check("at least one local commit was made beyond the seed", commitCount > 1, `commit count=${commitCount}`);

let statusFiles = [];
try {
  statusFiles = execFileSync("bash", ["-c", "find specs -name STATUS.md 2>/dev/null || true"], { cwd: repo, encoding: "utf8" }).trim().split("\n").filter(Boolean);
} catch { /* no specs dir */ }
// F7: `git ls-files --error-unmatch` only proves the file is in the index -- a report that's
// staged but never committed, or committed and then modified again uncommitted, both pass that
// check. fileCommittedClean requires the file to exist at HEAD *and* have zero staged/unstaged diff.
const statusTracked = statusFiles.length > 0 && statusFiles.every((f) => fileCommittedClean(repo, f));
check("STATUS.md was actually committed at HEAD with no uncommitted changes on top", statusTracked, statusFiles.join(", "));

// F6: actually run the resulting server and hit the new endpoint for real -- don't trust the
// transcript, don't accept any 200 with a loose "status|ok|up" substring match (a wrong or
// half-implemented response could pass that), and don't let a fixed port or fixed sleep make this
// flaky in CI. Requires: valid JSON, a real status indicator, a numeric uptime-like field that
// actually increases between two calls (proves it's live process uptime, not a hardcoded value),
// and that the pre-existing /ping route still works (no regression).
let featureWorks = false;
let featureDetail = "";
let child;
try {
  const port = await getFreePort();
  child = spawn(process.execPath, ["server.js"], { cwd: repo, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  const base = `http://localhost:${port}`;
  await waitForServer(`${base}/ping`, 5000);

  const first = await fetch(`${base}/health`);
  const firstBody = await first.text();
  let firstJson = null;
  try {
    firstJson = JSON.parse(firstBody);
  } catch { /* not valid JSON -- firstJson stays null, fails below */ }
  const hasStatusIndicator =
    !!firstJson &&
    Object.entries(firstJson).some(([k, v]) => /status|ok|healthy|up/i.test(k) && (v === true || /ok|up|healthy|running/i.test(String(v))));
  const firstUptime = findUptimeField(firstJson);

  await new Promise((r) => setTimeout(r, 1200));
  const second = await fetch(`${base}/health`);
  const secondJson = JSON.parse(await second.text());
  const secondUptime = findUptimeField(secondJson);

  const pingRes = await fetch(`${base}/ping`);
  const pingJson = await pingRes.json().catch(() => null);
  const pingStillWorks = pingRes.status === 200 && pingJson?.pong === true;

  featureWorks =
    first.status === 200 &&
    !!firstJson &&
    hasStatusIndicator &&
    !!firstUptime &&
    !!secondUptime &&
    secondUptime.value >= firstUptime.value &&
    pingStillWorks;
  featureDetail = `GET /health -> ${first.status} ${firstBody}; uptime ${firstUptime?.value} -> ${secondUptime?.value}; /ping still works: ${pingStillWorks}`;
} catch (err) {
  featureDetail = `error verifying the server: ${err.message}`;
} finally {
  child?.kill("SIGTERM");
}
check("the actual /health feature works (valid JSON, real status, increasing uptime, /ping unaffected)", featureWorks, featureDetail);

const passed = checks.filter((c) => c.pass).length;
console.log(`\n${passed}/${checks.length} checks passed. Repo kept at: ${repo}`);
console.log(`Tool calls made during the session: ${JSON.stringify(toolCalls)}`);
console.log(`\nLast assistant message:\n${lastAssistantText.slice(0, 2000)}`);

// F8: the script printed a pass count but never failed the process on a failed check, and never
// distinguished "the skill/feature failed" from "the harness itself broke" (e.g. the SDK session
// never produced a result). Both are now real, non-zero exits.
if (resultSubtype && resultSubtype !== "success") {
  console.error(`\nHARNESS ERROR: SDK session ended with result subtype "${resultSubtype}", not "success".`);
  process.exitCode = 2;
} else if (passed !== checks.length) {
  console.error(`\n${checks.length - passed} check(s) failed.`);
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
