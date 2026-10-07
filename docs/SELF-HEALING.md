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
| A form the reader cannot fully read (a frame still loading or failed, more than 20 frames, a closed shadow root, a frame nobody can see that holds fields) | Said in a "Not listed, and why" block; the agent inspects again or asks; never silent | **built** (S1b) |
| A text field a person cannot see (opacity 0, 1px, off the page): a bot trap | Not offered, named as not visible to a person, `fill` refuses it, the agent tells the user | **built** (S1b) |
| Model refusal or garbage | One stricter retry, then skip the item | planned |
| Overseer call throws or is rate-limited | Park the item with the reason; the queue moves on; start-up reconciles `running` items | planned (S4) |
| Crash or kill mid-item | Resume from the ledger; an `intended` item is verified before any retry; cannot verify: park and ask | planned (S4) |
| Laptop sleep, clock step, time-zone change | Monotonic item clock, a jump is *suspended* not slow; ledger time is UTC plus a sequence; verify before retry | planned (S4) |
| **Usage nearly out** | **Checkpoint first** (flush the ledger, finish or park the current item, write goal progress), then degrade (cheaper aliases, no Advisor), then pause with the reset time if known (else ask). No signal means unknown: slow down | planned (S4); the checkpoint script and rule exist now for us |
| Disk nearly full | Stop screenshots, keep the ledger, tell the user | planned |
| Stale lock after a crash or reboot | Lock holds PID and OS start time; Chromium's own `SingletonLock` removed only after the owner is proven dead | planned (S2) |
| A page hostile to the agent | Page text is data: fenced, never instructions; tools that could leave the allowances do not exist | built for browser text; flows planned |
| The browser drops a call ("Resulting promise was garbage collected": a busy machine, a page opening and closing windows) | A read (`inspect`, `text`, `notices`, `list_tabs`, `screenshot`) is asked once more; an action is **not** repeated and the agent is told it may or may not have happened and to look first | built (IMP-019) |

## C. Mistakes made more than once (do not make them again)

| Mistake | How many times | The fix, stated as a habit |
|---|---|---|
| The generated benchmark table was out of date when the suite ran | 3 | Regenerate it as the last step after any suite, log or planned-list change |
| A test relied on global state or on what ran before it | 2 (a fixed `/tmp` path; a shared favicon assumption) | Unique paths, run twice in a row, control that the precondition happens |
| A scorer accepted silence | 3 (the word in the URL; the landing URL; in `browser-honesty` a page that was merely absent from the answer passed "no forged block", and an empty answer passed "bounded") | Silence control with the URL and several ports, and score the old code; pair every "nothing bad is present" check with a control that the thing it guards is present (the ordinary field's value is recorded, the page's heading is shown) |
| Building while a suite ran, or a suite lost to a restart | 2 | Scratch outDir; `setsid nohup` for anything long |
| Claimed a boundary was tested when it was tested only for the direct case | 1, critical | Decoy plus the whole chain (rule 23) |
| Mutation results taken at face value when every mutant died of the same message | 1 | Run the unmutated test first, several times |
| Docs said "1 of 8" in four places after the number changed | 2 | Grep for the old number |
| A sub-agent's work lost to a usage limit | 1 (round 2 died at its limit after its findings table; the file written as it went survived) | Write to disk as you go |
| A filter test that covered one byte class and one channel | 1 (C0 in text passed; C1 in `--json` and a file name in the signals did not) | Name the classes (C0, C1, bidi) and the channels (text, JSON, file names, role files) a filter test covers, and strip at the source and at the edge |
| A generated test case that the code under test is right to refuse | 1 (plans over the cap) | A generator respects the caps; the control is the case that exceeds them |
| A hook judged the TEXT of a path or command and the tool read it differently | 3 (symlinks, round 1 A1; `~` and the relative-link base, round 2) and a fourth in the command names (A51) | Judge what the tool will open or run: expand and resolve exactly as it does (links, `~`, `..`), allow-list safe forms instead of listing names, and run every tool against every form of its input |
| A time-driven UI element sampled a fixed number of times at a fixed pace | 2 (ui-mascot, then ui-plain's turning glyph, which failed once on macOS at f10a830 and could not be reproduced under 6 CPU hogs) | Wait for the state with a generous deadline and size any "holds still" window from how long the control took; simulate the slow case (timers clamped to 1 Hz) so the test shows why. Cause on the macOS runner stays unproven until CI is green again |
| A mutation harness whose targets did not match the compiled text, counted as survivors | 2 | Report "target not found" separately, match with a pattern when the compiled text has line breaks, and fix the target before reading the survivors |
| The scanner's allow marker ignored past column 200 (the finding text was cut before the check) | 1 | Check the marker against the whole line; cut only for display (Dev-Skill SKILL-012); never answer a scanner block with `--no-verify` |
| Words with a slash read as paths (`async/await`) | 1 | A path has an extension, exists in the repository, or starts like a project directory |
| Committed without reading the scanner's message | 1 (blocked, no harm) | Read it; allow false positives inline with a reason |
| Code picked the first resolved address (`localhost` is `::1` first on the CI runners and on Windows) | 1 (Linux and Windows CI) | Try every allowed address in order; test with a resolver that returns `::1` first and a server on 127.0.0.1 only |
| Treated a path root as text (`/` on Windows is the current drive, not a directory) | 1 (Windows CI) | Place the root with `path.resolve` before walking; a test that checks the root of the result |
| Compared generated text with committed text on a checkout that has CRLF endings | 1 (Windows CI) | `.gitattributes` with `eol=lf`, and normalize reads in tests that compare text |
| A fixed pause before an action that has to land in a particular state (`sleep(500)`, "still for 120 ms") | 2 (`test:stop`, `test:ui-mascot`) | Wait for the state itself (the call is in flight; the cat is where the mascot says), then measure from the action |
| Ran a suite without the flags its npm script adds (the fake SDK needs `--import`), so a load experiment measured the real SDK | 1 | Run `npm run test:<name>`, or copy the script's flags exactly |
| `pkill -f` with a pattern that is also in my own command line killed the shell and the run | 2 (the second time was `pkill -f HONESTY` in a command that contained the word, exit 144) | Save PIDs and kill those, or match on something the command line does not contain; better, do not `pkill` at all: let a timeout in the harness end the child |
| New tests were written and run on Linux only, and CI on the other two systems was read late | 2 | Before pushing a test, list what it assumes about the OS (paths, loopback order, line endings, timers); read CI on all three systems after every push |
| Listened for events on the page only, so what a popup said while loading was lost | 1 (found under CPU load) | Listen at the context level too, adopt the unknown page, dedupe by event object; test with a stand-in that speaks first |
| Pushed a fix while the full local suite was still running, and it carried a bug of mine (a doc line a test parses) | 1 (cost a red CI run; the user noticed) | Do not push until the full suite has passed locally; edit machine-read lines (`Covers ... commit:`) only in their format |
| Passed a string of page-side source to Playwright's `evaluate` and expected it to be called (a string is an expression: the function came back, never called, and the code read `undefined`) | 1 (S1b) | Build a real function in Node with `new Function` from the shared source text; run the real browser once before trusting it |
| Counted a token in the visible text and in the ref lines together, so a count of fields came out doubled | 1 (S1b) | Count the thing the claim is about (ref lines), not every occurrence of the word |
| A detector listener left installed while the test asserted, so the test's own failure was caught by it and the run exited 0 | 1 (A39: the old build "passed" the new test) | Remove the listener before the assertion, and run the test against the old build to see it fail |
| `slice(-0)` as "the last zero items" (it is the whole array) | 1 (A50: a list limit that listed everything) | Guard the zero case; a test with a limit equal to the number of items already shown |
| A test for a race that fails on the old build only sometimes, called "fails on the old code" after one run | 1 (A41: three popups killed the old build about one run in three; the first old-build score said the check passed) | Run the old build five or six times and keep making the scenario harsher until it fails every time (ten popups with eight requests each: five in six; thirty: six in six); a mutant can survive a one-in-three test by luck |
| A child process that outlived its time limit read as "exited 0" (`spawnSync` reported status 0 with `error: ETIMEDOUT` on this machine) | 1 | A timeout, a signal or an error is its own result and counts as a failure; never score `status` alone |
| Ran a new test file from the main tree and called it "the old build" (the test imports `../dist` from its own location) | 1 (A41 re-measurement) | Copy the test into the scratch worktree and run it there; print which `dist` the run used |
| An unquoted heredoc (`<<EOF`) around text that holds backslashes or backticks: `\\n` in a script became a real newline, and backticked names in a documentation entry were run as commands and vanished from the text, and a `>` in the text created an empty file named `clientHeight` | 2 (the mutation harness, then IMP-017's mutation paragraph) | Quote the delimiter (`<<'EOF'`) or write the file with the file tool, and read the result back for holes before moving on |
| A new suite or test written and run on Linux only, and read on Windows late (a child script imported the build by an absolute path, which Windows reads as a URL with the scheme `d:`; a suite had one row fewer where a symlink cannot be made; a path under a link and a slower start) | 5 (the gate and the path root earlier; `browser-honesty` and `file-hooks` in `test:bench-table`, found by CI at `fe92cb0` after the full local suite passed; `test:team-run-cli` with an absolute `--import` path at `a035a87`, after which `test:windows-imports` scans for it; at `e9da57a` a path under a link that macOS has and Linux's `/tmp` does not, and an abort that fired before its listener existed, which Windows' slower start exposed) | Before pushing a test, list what it assumes about the OS, and use `pathToFileURL` for any import by path; build the link, the missing directory or the slow start yourself in the test instead of relying on where the test happens to run (a signal or event that can fire before its listener exists is tested by firing it first); a count that differs by platform is declared in the suite's `meta`; the full local suite on Linux says nothing about Windows (SELF-HEALING row "New tests were written and run on Linux only") |
| A fixed sleep in a test for work whose length depends on the machine (a 2 s wait for a popup storm), so the test passed idle and failed in the full suite, where other suites share the CPU | 2 (A41's three-popup race measured once; then this wait: the full suite on 790771e failed `test:browser-popup-storm` and `test:bench-table`) | Wait for a signal from the thing waited for (the page reports its storm is over); run a test that touches timing under CPU load (four busy loops) and count failures before calling it stable; a failure that only appears in the full suite is the first sign of load |
| A mutation run reported 0 survivors while the test it ran already failed on the unmutated code (every mutant "died" of the same failure), and a copy of the tree missing a directory the test reads (`ui/`) made a test fail in the copy only | 1 (IMP-021, found because the survivor count was suspiciously 0 on the first pass; an earlier "kill" in IMP-020 was vacuous the same way) | Every mutation script runs the unmutated copy first and stops when it fails; the copy gets every directory the tests read; a count of 0 survivors is read together with the control line |
| A UI test read a script's global (`AL.mascot`) and failed with "undefined" because the script had not loaded; the page survives that on purpose and the harness filtered failed loads as noise | 1 (`test:ui-plain` on Windows at `a035a87`; cause not established) | The harness names every page, script or stylesheet that answered an error or failed (`open()` throws); read the named file before guessing at the page |
| A guard or a test written from what I believed a library function does, not from running it (`domainToASCII` treats its input as a URL host and accepted `linkedin.com/jobs`; `serviceWorkers: "block"` leaves `register()` resolving and only keeps the worker from running) | 2 (IMP-026: caught by the first test of the host rule; IMP-028: caught when the new service-worker test failed on correct code) | Before writing the assertion or the guard, run the library call on the hostile and the odd inputs in a ten-line script and read what it returns; assert on the effect that matters (no worker is running, a request reaches the server), not on the shape of the call; when a test fails on correct code, suspect the belief first |
