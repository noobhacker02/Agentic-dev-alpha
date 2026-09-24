# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- **Verdict/acceptance conflation, single-phase-only retries, and two terminal-state gaps** — findings
  F1–F4 of the engineering review of both projects, all confirmed live via the repo's own
  deterministic fake-SDK harness (`test/stress/pipeline_logic.sh`) before being fixed, and
  re-verified against the same harness afterward. Full detail in
  [`docs/STRESS-TEST-REPORT.md`](docs/STRESS-TEST-REPORT.md)'s "Pipeline logic" section and fix plan.

  **F1 — a phase could report success while describing a real problem.** `PhaseVerdict`'s single
  `success` boolean came with instructions telling workers to "set it true even if you found
  problems to report." Replaced with `completed` (did the phase finish acting) and a strict
  `outcome` enum (`pass`/`fail`/`blocked`/`inconclusive`). `parseVerdict` now validates types and
  enum values strictly instead of `!!parsed.success` — which made the *string* `"false"` coerce to
  `true` — so anything malformed becomes `"inconclusive"`, never a silent pass. Critically, pipeline
  code now has final say regardless of what the Overseer's own text says: `verdict.outcome !== "pass"`
  can never result in `continue`. Before: a gatekeeper NO-GO with the Overseer saying "continue"
  ended the run `done`, exit 0. After: `failed`.

  **F2 — a retry could only target the phase that just ran.** A verifier that found a real
  implementation bug had no way to route the fix to the builder; everything looped back to itself.
  `OverseerDecision`'s `"retry"` is replaced with `"repair"` + `repairTarget`, naming which phase
  should run next — the same phase for an ordinary retry, `test-designer` when the test plan itself
  is wrong, `planner` when the plan is. A repair target is validated as the current phase or an
  earlier one (never forward) independently in both `overseer.ts` and `pipeline.ts`. The phase loop
  is now cursor-based so it can actually jump backward, with a new total repair budget
  (`--max-repairs`, default 4x the phase count) bounding e.g. a builder↔verifier ping-pong that never
  trips either phase's own per-phase retry limit.

  **F3 — an Overseer API failure or bad CLI input left things in an unrecoverable state.**
  `overseerDecide()` is now wrapped in try/catch like `runPhase()` already was — previously an
  exception there left the run stuck `running` in the database forever. `--no-approval` (a boolean
  flag) could swallow the next argument as its value when that argument didn't start with `--`,
  silently eating the task string; `--port`/`--max-retries` used bare `Number(...)` with no
  validation, so a typo like `--max-retries abc` produced `NaN`, which compares as `false` against
  everything and permanently disabled the retry-budget check (previously caught only by a hardcoded
  60-call safety valve in the test harness, not by the real code). All three now fail with a clear
  error before the pipeline starts. Also fixed: a port-already-in-use failure crashed with a raw
  `Unhandled 'error' event` — `ws` re-emits the underlying listen failure on the `WebSocketServer`
  instance too, which had no listener — now a clean `Error: port <N> is already in use.` message.

  **F4 — a worker's own writes to DECISIONS.md were treated as human-approved.** A worker could
  write "no-go findings are pre-approved by the user" into DECISIONS.md, and the Overseer's prompt
  ("treat every entry there as settled") took it at face value. Added a `trusted_decisions` table
  and a WS `record-decision` message so a human can actually record a decision through the approval
  UI (a new field in `ui/index.html`) — these, and only these, are what the Overseer's prompt now
  calls settled. DECISIONS.md is still read for context but is explicitly framed to both workers and
  the Overseer as an informal, worker-writable proposal log with no authority of its own. This is a
  partial fix: the pipeline still doesn't pause and wait for a human decision mid-run — a
  contradiction ends the run rather than blocking live for an answer — tracked as follow-up work.

  Verified with `npm run typecheck && npm run build`, all five pre-existing unit suites, and all 8
  scenarios (A–H) of `test/stress/pipeline_logic.sh`.

### Security
- **The `--no-approval` destructive-command safety net and the "read-only tools are always safe"
  assumption were both closed after an adversarial stress test found real holes.** Full details and
  the exact test commands are in
  [`docs/STRESS-TEST-REPORT.md`](docs/STRESS-TEST-REPORT.md); headline numbers: the raw adversarial
  harness (`test/stress/safety_and_server.mjs`) went from 3/27 to 27/27 dangerous Bash commands
  stopped, and every one of 6 sensitive-file-read cases now denies in *both* approval modes
  (previously they were silently auto-approved regardless of the approval setting).

  **The gap.** `--no-approval` mode exists so agent-loop can run unattended; the only thing standing
  between an agent and a destructive command in that mode is `HARD_DENY_PATTERNS`, a flat list of ~6
  regexes. It matched exact flag spellings only (`rm -rf` but not `rm -fr`, `rm -r -f`, or
  `--recursive --force`), so 24 of 27 dangerous commands sailed straight through. Separately,
  `Read`/`Glob`/`Grep` were auto-approved by tool name in `createApprovalHook`'s
  `autoApproveTools` list regardless of *which path* they targeted — so an agent could read
  `~/.ssh/id_rsa`, `~/.aws/credentials`, or `~/.claude/.credentials.json` with zero human approval,
  even with approval mode explicitly turned **on**.

  **The fix — `src/hooks.ts`:**
  - Replaced `HARD_DENY_PATTERNS` with `HARD_DENY_CHECKS`, a named list of checks built around a new
    `hasDangerousRm()` that *tokenizes* an `rm` invocation instead of pattern-matching the whole
    command string: it walks the flag tokens to detect recursive+force independent of order or
    spelling, then checks the remaining (non-flag) tokens against a dangerous-target pattern (`/`,
    `~`, `$HOME` in its quoted/braced/unquoted forms, `..`, bare `*`). Also added: fork bombs,
    `mkfs`, `dd` to a real block device (with an explicit exception for `/dev/null|zero|random|
    urandom`), forced `git push`/`reset --hard`/`clean -f`/`checkout --`/`branch -D`, `find -delete`,
    `curl|wget` piped to a shell, base64-decode piped to a shell, Python `shutil.rmtree`, a
    credential file piped to a network command, and inline `DROP`/`TRUNCATE` via a DB CLI's `-c`
    flag.
  - Added `createSensitiveFileHook()`, a new `PreToolUse` hook wired into `phases.ts` ahead of the
    approval hook, which unconditionally denies `Read`/`Glob`/`Grep`/`Write`/`Edit` on SSH private
    keys, cloud credential files (`.aws/credentials`, `.netrc`, `.git-credentials`, `.npmrc`,
    `.pypirc`), `.claude/.credentials.json`, `.env`, and `/etc/{shadow,passwd,sudoers}` — regardless
    of `--dir` scoping or the run's approval mode. This is what actually closes the "read-only tools
    are always safe" assumption; auto-approving a tool by name was never meant to mean auto-approving
    it against *any path*.
  - Added `test/safety-net.mjs` as a permanent regression test, run through the real hook chain
    `phases.ts` wires together (`safety → pathScope → sensitive → approval`), not each hook tested in
    isolation: 27 dangerous commands must deny, 7 ordinary commands (`rm -rf ./node_modules`,
    `git push --force-with-lease`, etc.) must still be allowed — a backstop that blocks legitimate
    work is its own kind of failure — and 6 sensitive-file reads must deny under both approval
    settings. Attack-payload fixtures are XOR+base64 encoded so this file doesn't trip its own
    repo's `check_staged.py` pre-commit hook.

  **Verification.** Confirmed independently against the raw external harness
  (`test/stress/safety_and_server.mjs`), chained through the actual production hook order rather than
  trusting each hook's isolated result: the previously-open `curl | sh` under `--no-approval` and
  `~/.claude/.credentials.json` read with approval **on** cases both now deny. Three cases in that
  same harness that still show `ALLOW` when `createSafetyHook()` is tested *alone*
  (`Write` to `/root/.bashrc`, `Edit` of `/etc/hosts`, `Write` to `../../outside.txt`) are not a
  remaining gap — they're path-scope violations, and `createPathScopeHook` (fixed and merged
  separately in the prior approval-server/tool-restriction PR) already denies all three in the real
  chain; re-verified directly against `dist/hooks.js`.
