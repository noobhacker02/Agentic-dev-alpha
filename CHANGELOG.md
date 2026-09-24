# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
