# Self-healing: what to do when something goes wrong, so it is not made twice

A living catalog. Three parts: how **we** recover while building (process), how the **product** recovers while running (runtime), and the mistakes that
were made more than once. Add a row the moment a failure happens a second time. The rule that matters most is first.

## The rule: save before you run out

**When usage is nearly out (a rate-limit warning, "about to be out of usage", a long task winding down), save everything BEFORE doing anything else:**

1. `npm run checkpoint` (this repo's `scripts/checkpoint.mjs`): updates nothing by magic, but stages, commits and pushes both repos in one command and says plainly what it
   could not do. Run it by hand if the script is unavailable: `git add -A && git commit` then `git push -u origin <branch>` in agent-loop (`main`) and in the
   Dev-Skill checkout (`claude/dev-workflow-process-v4kafr`).
2. Make `docs/HANDOFF.md` say what is true: "Next step", what is verified and what is not, the open adversary findings. A commit message says "not re-run" when
   it was not re-run; a checkpoint is not a claim of green.
3. Anything running in the background (a suite, a sub-agent) is written to disk as it goes. A sub-agent that dies of a usage limit must leave its findings in its
   file; its brief says "append each finding as soon as it is confirmed". Round 1 of the adversary lost its first attempt because it did not.
4. Only then continue. Never start a big edit, a rebuild or a long run in the last stretch of usage.

The same rule is in `CLAUDE.md` (loaded every session), in the dev-workflow skill (Step 9), and in the product: the usage governor **checkpoints before it
pauses** (flush the ledger, finish or park the current item, write the goal's progress, then show the reset time).

## A. Process: recovering while we build

| Situation | What to do | Lives in | Status |
|---|---|---|---|
| Usage nearly out | Checkpoint (above), then stop starting new work | `CLAUDE.md`, this file, skill Step 9, `scripts/checkpoint.mjs` | built |
| Worker or session restarted | Read `docs/HANDOFF.md` (the SessionStart hook injects it), `git status` in both repos, then check what background jobs survived. They did not: relaunch with `setsid nohup` | HANDOFF, `.claude/settings.json` hook | SessionStart seen live |
| Conversation compacted | The handoff must already be current; compare the saved summary in `docs/handoff/compactions/` with it | `scripts/handoff_hook.py`, `test/handoff.mjs` | PostCompact unproven live |
| A background test run died | Relaunch it detached; do not read its partial log as a result | scratchpad `run-full.sh` | process |
| About to rebuild `dist/` while a suite runs | Don't. Build to a scratch `--outDir`, or a scratch worktree of an old commit | process | learned the hard way |
| Pre-commit scanner blocks a commit | Read what it found. A real secret: remove it. A false positive (a `password` field in a type, a runtime-generated credential, a fake value on purpose): add `// devskill:allow (reason)` on that line. **Never `--no-verify`** | `.githooks`, `check_staged.py` | worked twice |
| A sub-agent dies (usage, error) with no output | Relaunch with the same brief plus "write findings to the file as you confirm them"; do not guess what it would have found | adversary brief | built |
| A test passes, then fails on the next run | A flake is a mechanism: run it six times, find the race (a download cancel lost to a small file about 1 run in 6; a test that assumed an event beat `open`'s return) | skill Step 8 rule 21 | rule |
| A new test passes the first time | It proves nothing until it **failed on the old code** and its mutants are killed, each for the right reason. A mutation run where everything dies with the same unrelated message means the test fails on the real build too: check that first | skill Step 8 rules 7, 8, 21 | rule |
| A scorer or baseline is recorded | Score the **old code** with the corrected scorer in a scratch worktree; give the scorer a silence control; a changed baseline needs a logged reason | skill rule 24, `bench/baseline-check.mjs` | built |
| Generated docs drift (the benchmark table) | After changing a suite, an improvement entry or the planned list: `node bench/run.mjs --write-doc`, then the tests. The test fails on drift, which is its job | `test/bench-table.mjs` | built |
| A number changed | Search every doc for the old number (`1 of 8`, `15 tools`, line counts) before saying it is done | process | rule |
| The full suite is red at the end | Read which suite and why; do not rerun hoping | process | rule |
| Shell quoting or heredoc trouble | Write the script to a file and run the file | process | learned |
| The sandbox differs from CI | Chromium lives at `/opt/pw-browsers/chromium-*/chrome-linux/chrome` (our launcher falls back to it); `127.0.0.2` may not be routable (macOS), so decoy tests skip, not fail; headless Chromium never asks for a favicon | `src/browser-tools.ts`, tests | built |
| A helper's default parameter swallows `undefined` | Use `null` to mean "none"; `f(x = default)` fires on `undefined` | tests | learned |
| `path.join` / `path.resolve` collapse `..` as text | Build attack inputs as raw strings when `..` through a symlink is the point | skill rule 23 | rule |

## B. Runtime: how the product recovers (runtime only, never edits its own code)

| Failure | Response | Status |
|---|---|---|
| Element not found, stale ref | Re-snapshot once, re-plan the step, then park the item | planned (S4/S5) |
| Page timeout, 5xx | Back off 30 s, 2 min, 8 min, then skip; three in a row open the site's circuit | planned (S4) |
| 429, 403, 999, challenge or checkpoint page | Circuit opens at once, site **paused**, user told, **never** auto-resumed; text read only where the site speaks | planned (S4) |
| Session expired vs sign-in verification | Plain login form: ask for `login`. Checkpoint or verification page: an account signal, pause, do not re-login | planned (S4) |
| A redirect hop or request off the list | Refused at the gate, the navigation fails with a named refusal, the item parks and asks once | **built** (TEST mode) |
| Page error, 404, dialog, download, crash | Told to the agent as notices; dialogs dismissed, downloads refused | **built** |
| Model refusal or garbage | One stricter retry, then skip the item | planned |
| Overseer call throws or is rate-limited | Park the item with the reason; the queue moves on; start-up reconciles `running` items | planned (S4) |
| Crash or kill mid-item | Resume from the ledger; an `intended` item is verified before any retry; cannot verify: park and ask | planned (S4) |
| Laptop sleep, clock step, time-zone change | Monotonic item clock, a jump is *suspended* not slow; ledger time is UTC plus a sequence; verify before retry | planned (S4) |
| **Usage nearly out** | **Checkpoint first** (flush the ledger, finish or park the current item, write goal progress), then degrade (cheaper aliases, no Advisor), then pause with the reset time if known (else ask). No signal means unknown: slow down | planned (S4); the checkpoint script and rule exist now for us |
| Disk nearly full | Stop screenshots, keep the ledger, tell the user | planned |
| Stale lock after a crash or reboot | Lock holds PID and OS start time; Chromium's own `SingletonLock` removed only after the owner is proven dead | planned (S2) |
| A page hostile to the agent | Page text is data: fenced, never instructions; tools that could leave the allowances do not exist | built for browser text; flows planned |

## C. Mistakes made more than once (do not make them again)

| Mistake | How many times | The fix, stated as a habit |
|---|---|---|
| The generated benchmark table was out of date when the suite ran | 3 | Regenerate it as the last step after any suite, log or planned-list change |
| A test relied on global state or on what ran before it | 2 (a fixed `/tmp` path; a shared favicon assumption) | Unique paths, run twice in a row, control that the precondition happens |
| A scorer accepted silence | 2 (the word in the URL; the landing URL) | Silence control with the URL and several ports, and score the old code |
| Building while a suite ran, or a suite lost to a restart | 2 | Scratch outDir; `setsid nohup` for anything long |
| Claimed a boundary was tested when it was tested only for the direct case | 1, critical | Decoy plus the whole chain (rule 23) |
| Mutation results taken at face value when every mutant died of the same message | 1 | Run the unmutated test first, several times |
| Docs said "1 of 8" in four places after the number changed | 2 | Grep for the old number |
| A sub-agent's work lost to a usage limit | 1 | Write to disk as you go |
| Committed without reading the scanner's message | 1 (blocked, no harm) | Read it; allow false positives inline with a reason |
| Code picked the first resolved address (`localhost` is `::1` first on the CI runners and on Windows) | 1 (Linux and Windows CI) | Try every allowed address in order; test with a resolver that returns `::1` first and a server on 127.0.0.1 only |
| Treated a path root as text (`/` on Windows is the current drive, not a directory) | 1 (Windows CI) | Place the root with `path.resolve` before walking; a test that checks the root of the result |
| Compared generated text with committed text on a checkout that has CRLF endings | 1 (Windows CI) | `.gitattributes` with `eol=lf`, and normalize reads in tests that compare text |
| A fixed pause before an action that has to land in a particular state (`sleep(500)`, "still for 120 ms") | 2 (`test:stop`, `test:ui-mascot`) | Wait for the state itself (the call is in flight; the cat is where the mascot says), then measure from the action |
| Ran a suite without the flags its npm script adds (the fake SDK needs `--import`), so a load experiment measured the real SDK | 1 | Run `npm run test:<name>`, or copy the script's flags exactly |
| `pkill -f` with a pattern that is also in my own command line killed the shell and the run | 1 | Save PIDs and kill those, or match on something the command line does not contain |
| New tests were written and run on Linux only, and CI on the other two systems was read late | 2 | Before pushing a test, list what it assumes about the OS (paths, loopback order, line endings, timers); read CI on all three systems after every push |
| Listened for events on the page only, so what a popup said while loading was lost | 1 (found under CPU load) | Listen at the context level too, adopt the unknown page, dedupe by event object; test with a stand-in that speaks first |
| Pushed a fix while the full local suite was still running, and it carried a bug of mine (a doc line a test parses) | 1 (cost a red CI run; the user noticed) | Do not push until the full suite has passed locally; edit machine-read lines (`Covers ... commit:`) only in their format |
