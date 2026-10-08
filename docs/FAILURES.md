# Failures: every mistake, wrong belief and false start, in one place

A consolidated catalog, written so future sessions do not repeat them. No blame: each entry says what happened, why, how it was caught (and what would have
caught it sooner), and what now prevents it. Sources: `docs/SELF-HEALING.md` (A, B, C), `docs/IMPROVEMENTS.md`, `CHANGELOG.md`, `docs/adversary/`,
`docs/handoff/compactions/`, `docs/HANDOFF.md`, Dev-Skill `dev-workflow/references/verification-lessons.md` and `improvement-log.md`, and `git log` of both repos.
`SELF-HEALING.md` stays the short operational catalog; this file is the longer account. Add an entry the first time something fails, and bump its count the second.
Counts say how often the same cause bit; "1" means once so far. Commit hashes are agent-loop unless marked Dev-Skill.

## Top rules (read these if nothing else)

1. A claim about "the suite passes" is about one commit. Do not push until the full local suite has passed on that exact commit; read CI on all three systems after every push.
2. Linux green says nothing about macOS or Windows. Before pushing a test, list what it assumes about the OS (path roots, symlinks like `/var`, loopback order, CRLF, timers, who runs it) and build the odd case yourself in the test.
3. A new test must fail on the old code first (several times if it is a race), then pass, then be run twice. A scorer or mutation run needs its control first: 0 survivors or a perfect first score is a reason to look.
4. Wait on a signal from the thing waited for, never a fixed sleep; run timing-sensitive tests under four busy loops before calling them stable.
5. Before writing a guard or an assertion from a belief about a library or a hostile input, run the call in a ten-line script and read what it returns (`domainToASCII`, `serviceWorkers: "block"`, `slice(-0)`, `evaluate(string)`).
6. Judge what the tool will do, not what the text looks like (symlinks, `~`, `..`, `/` on Windows, nonexistent paths under links). Resolve the nearest existing ancestor.
7. When the thing being checked can lie (a page, a form), check it twice, the second time where it cannot reach (network, trusted process). Do not reason "equivalent mutant" without running the case on a platform that differs.
8. Never write by hand what the machine can state (timestamps, hashes, counts, "Covers commit:" lines); grep for the old number after any number changes.
9. Save before usage runs out; background agents and jobs write to disk as they go; no `pkill -f` with a pattern that appears in your own command line; no `--no-verify` (use `// devskill:allow (reason)`).
10. A fix for a class of failure that happened twice is a scan or a test (`test:windows-imports`, the scanner copy check), not another sentence in a catalog.

---

## 1. Testing and CI

**T1. Test run as another user could not read a root-only path (`test:profile` section 15), e9da57a / b126b6e.** Count 1.
- What: the suite runs a child as `nobody` when it runs as root; in a scratch worktree under a root-only directory `nobody` could not import `dist/profile.js`. Seen by the full local run (73 pass, 3 fail).
- Root cause: the child imported the module from the builder's own tree, whose permissions the test did not control.
- Caught by: the full suite on the pre-fix commit. Earlier: ask "who runs the child, and can that user read what it imports?" when a test drops privileges.
- Prevented by: `test/profile.mjs` now copies the module (it needs only Node built-ins) into a world-readable directory for the child. Rule: an event or spawn that depends on who runs it is run as both (HANDOFF Next step rules).

**T2. A fixed pause before an action that must land in a particular state.** Count 2 (`test:stop`, `test:ui-mascot`), then again in `test:ui-plain` and the popup-storm test (see T4).
- Root cause: `sleep(500)` / "still for 120 ms" encodes the author's machine speed.
- Caught by: CI flakes on slower runners. Earlier: a rule to wait for the state.
- Prevented by: waits on state; `docs/SELF-HEALING.md` part C; Dev-Skill lessons 25 and 30; `test/ui-plain.mjs` clamps timers to 1 Hz to show why.

**T3. A time-driven UI test sampled a fixed number of times at a fixed pace.** Count 2 (ui-mascot; `ui-plain`'s turning glyph failed once on macOS at f10a830, not reproducible under 6 CPU hogs).
- Root cause on macOS: unproven (hypothesis: the runner throttled the page's timers). Do not claim it as established.
- Prevented by: a wait with a generous deadline plus a throttled-timer simulation in `test/ui-plain.mjs`.

**T4. A fixed 2 s sleep for a popup storm; the full suite failed `test:browser-popup-storm` and `test:bench-table` on 790771e.** Count 2 (with the A41 race).
- Root cause: alone the test passed; with other suites using CPU the storm was still running. Chromium also dropped a call ("Resulting promise was garbage collected") in 4 of 6 loaded runs, 0 of 8 idle.
- Caught by: the full suite (a failure that appears only in the full suite is the first sign of load). Earlier: run under four busy loops.
- Prevented by: the page reports its storm is over (IMP-019); the runtime retries reads once and reports actions plainly (`src/browser-tools.ts`); lesson 30 / SKILL-017.

**T5. A race test called "fails on the old code" after one run (A41: three popups killed the old build about 1 in 3).** Count 1.
- Root cause: a probabilistic failure judged from one sample, so a mutant could survive by luck.
- Prevented by: run the old build 5 to 6 times and harshen the scenario until it fails every time (ten popups x 8 requests: 5 in 6; thirty: 6 in 6); `test/browser-popup-storm.mjs`; lesson 29 / SKILL-014. The same lesson covers a child that outlived its limit and read "exited 0" (`spawnSync` status 0 with `ETIMEDOUT`): a timeout, signal or error is its own failure.

**T6. A listener left installed while the test asserted, so the test's own failure was swallowed and the run exited 0 (A39).** Count 1.
- Root cause: an `uncaughtException` detector caught the assertion error. The old build "passed" the new test.
- Prevented by: remove the listener before asserting; run the test against the old build (`test/net-gate.mjs` A39 block).

**T7. A new test file run from the main tree and called "the old build".** Count 1 (A41 re-measurement).
- Root cause: the test imports `../dist` from its own location.
- Prevented by: copy the test into the scratch worktree and print which `dist` was used.

**T8. Mutation results taken at face value.** Count 4 in different forms: all mutants died of one unrelated message because the unmutated test already failed (IMP-021; an earlier IMP-020 "kill" was vacuous the same way, and the first headless-favicon "15/15 killed" run was invalid); a copy of the tree missing `ui/` made a test fail in the copy only; harness targets that did not match compiled text were counted as survivors (2).
- Caught by: a suspicious "0 survivors" on the first pass.
- Prevented by: every mutation script runs the unmutated copy first and stops if it fails; the copy gets every directory the tests read; "target not found" is reported separately (Dev-Skill lesson 31, SKILL-018; `docs/SELF-HEALING.md` rows).

**T9. A wrong "equivalent mutant" verdict (IMP-028), classified as "`path.relative` resolves a relative path itself".** Count 1.
- Root cause: the verdict was argued from Linux, where `/tmp` is not a link. CI on macOS (`/var` is a link to `/private/var`) showed the case was real (see P1).
- Caught by: CI at e9da57a. Earlier: an equivalence claim about a filesystem or OS behaviour must be tested with the link built by the test itself.
- Prevented by: Dev-Skill lesson 33 / SKILL-020 (every survivor gets a verdict: missing test, equivalent with a reason, unreachable here with the platform named, or a defect). IMP-028 states the verdict "was wrong".

**T10. A mutation survivor count of 51 of 121 on the first pass of the profile module.** Count 1 (not a failure of code, a gap in tests).
- Root cause: tests missing for group-only and world-only readable directories, the process start-time field, the recovery mutex, strict umask, etc.; one survivor (`..x` treated as a way out of its parent) was a real bug that let a profile sit inside the repository.
- Prevented by: tests added, bug fixed test-first (`test/profile.mjs`), lesson 33.

**T11. A test relied on global state or on what ran before it.** Count 2 (a fixed `/tmp` path; a shared favicon assumption).
- Prevented by: unique paths, run twice in a row, control that the precondition happens (lesson 21).

**T12. A test contradicted the server it ran against and went red on all three systems (`test/ui-stop.mjs`, "page 7 minutes ahead").** Count 1.
- Root cause: the fixture stamped events with a skewed clock while the test server reported its own clock; "full suite passes" had not been re-run after the `serverTime` change.
- Prevented by: the test server now reports the clock it stamps with (`harness({ serverClock })`); rule 1.

**T13. A filter test covered one byte class and one channel (C0 in text passed; C1 in `--json` and file names leaked).** Count 1.
- Prevented by: a matrix of classes (C0, C1, bidi, NUL) by channels (text, JSON, file names, role files); strip at the source and at the edge (lesson 27 / SKILL-011).

**T14. A generated test case the code is right to refuse (plans over the cap).** Count 1. Fix: generators respect the caps; the control is the case that exceeds them.

**T15. A test for a "nothing bad is present" check passed on silence.** Count 3 (the word "blank" in the probe's own URL gave a baseline of 2 that was really 1; the landing URL; `browser-honesty` passed on a page merely absent from the answer). Fix: silence control with the URL and several ports, score the old code with the corrected scorer in a scratch worktree, pair every absence check with a control that the guarded thing is present (lesson 24, SKILL-003, `test/bench-suites.mjs`).

**T16. A UI test read `AL.mascot` and failed "undefined" on Windows at a035a87.** Count 1; cause NOT established (not seen again at b695f8c or 58aaba4). The harness now names every page, script or stylesheet that failed to load (`open()` throws). Do not claim a root cause.

**T17. Flaky or load-dependent tests found only by CI.** Count 4 (net-gate POST body JSON, 'WS-event wait' flake, the dinosaur canvas comparison 250 ms apart, `doctor`'s 3 s `which` probe read as "not installed" in 7 of 20 tries at 1 ms). Fixes: wait for the state; search `PATH` directly (no subprocess to time out); a timeout is "unknown", not "absent" (`CHANGELOG.md` Fixed; HANDOFF gotchas).

**T18. A CI job allowed to fail showed "success" while suites inside were red; macOS produced no results at all because the workflow used `timeout`, which macOS lacks.** Count 1 each. Fix: `scripts/run-suites.mjs` runs each suite with its own timeout and lists which passed; the cross-platform job now blocks.

**T19. A Linux CI job stalled at the browser-install step at e9da57a.** Count 1.
- Root cause: infrastructure (the job ran no tests); not a code fault.
- Caught by: reading the Actions API per job rather than the aggregate status. Lesson: a pending or stalled job is "not read", not green; say "Linux not confirmed at e9da57a" until a run completes. It was green at the next commit (4e5bccf).
- Prevented by: HANDOFF records CI per commit and per system; no new rule can prevent an outage, only mis-reading it.

**T20. A real-permission notification test ran in the wrong browser on CI (Playwright's headless shell has no notification permission), red on all three systems.** Count 1. First guess (grant had no origin) was wrong. Fix: `harness({ fullChromium: true })`, `channel: "chromium"`, fails loudly naming both readings.

**T21. The test-run helper's `undefined` triggered a default parameter (`creds: undefined`) and `slice(-0)` returned the whole array (A50).** Count 2 (`undefined` default: net-gate helper and team-roster `write()`; `slice(-0)`: 1). Fix: `null` means none; guard zero.

**T22. A test that counts leftovers in a shared directory (`agent-loop-login-*` in the system temp directory) fails when anything else runs at the same time.** Count 1 (`test:login` on `423d2e8`, two full runs overlapping; reproduced by running the test twice at once). Fix: the test gives its own process a private temp directory (`TMPDIR`, `TMP`, `TEMP`). Rule: a check of "nothing left behind" lists only what this process could have made; reproduce a suspected concurrency flake by running two at once before changing anything.

**T23. A new test passed against the mutant it was written for, because the test ran the attack too early.** Count 1 (IMP-031, the reload test: the bytes were sent from an inline script, which runs before `DOMContentLoaded`, and the old code only ended the hold at `DOMContentLoaded`, so the old code held it as well). Found only by running the test against the mutant after it passed. Fix: the sender waits for the event the rule keys on. Rule: a mutation check is run for every new rule, and "it passed on the new code" is not a result.

**T24. A mutant survived because a second code path produced the same answer in every case the tests used (the ledger's lookup by the site's id was covered by its lookup by company and title).** Count 1 (IMP-032). Fix: a case where only the first path can answer (the same id, an edited title). Rule: when a mutant survives, ask which other path covered it, then write the case that only the mutated path can answer.

**T25. A slice shipped with the full suite green, and a reviewer found 18 holes in it in 14 minutes: every test had been written by the code's own author, so they covered the cases the author imagined.** Count 1 (IMP-033: 5 high). Rule: an adversary round is part of the slice, not a later stage; it runs before the slice is called done, and its findings become a section of the same tests.

**T26. A regular expression with a backslash inside a template string that is sent to the page: the template turned `\s` into `s`, the clip check never fired, and nothing in the build or the first tests said so.** Count 1 (IMP-034, found by a test that asserted the reason each hidden field is hidden for). Rule: page-side source written inside a template string avoids backslashes (use `split`/`join`, or `\\s`), and each check in it has a test that fails when it is removed.

**T27. A test that asserted only the outcome ("nothing hidden was sent") passed against four mutants because a different check had stopped the same page for another reason.** Count 2 (T23 was the first). Rule: assert the cause, not just the effect, when more than one check can produce the same effect.

**T28. The fix for one finding was too narrow (A68's decoy fix compared button names; A94 got past it with a differently named real button).** Count 1. Rule: a fix is tested against the family of the attack (the same goal by another route), not only the instance reported.

**T29. The suites leave gigabytes of temporary directories behind (`team-pipeline-*` 2 GB each, `agent-loop-desktop-*`, `al-scale-*`), the disk filled during a review round, and unrelated suites then failed in one second each while the review stopped.** Count 1 (round 6, `2f4b705`). Fix this time: the leftovers were deleted by hand. Open: the suites that make them should remove them (a `finally` that removes the directory), and `run-suites` should check free space first and say "the disk is full" instead of letting nine suites fail for it. Rule: a run of the whole suite reports free disk space before and after.

**T30. A check written as `endsWith(",0)")` to find a transparent colour matched `rgb(0, 0, 0)`: every black text field was called hidden and the happy path stopped sending.** Count 1 (IMP-035; found by the first run of the test). Rule: a test of "the clean page is still submitted" runs in the same file as every new hiding check, and runs first.

**T31. A test of a changed message was written against the old behaviour twice.** Count 1 (IMP-037). Two existing assertions encoded `exit 0` for "an earlier attempt has no confirmation", which A124 showed to be wrong; the fix made them fail and they were changed with the reason beside them. Rule: when a fix changes an observable that older tests assert, change the test in the same commit and say why in a comment, so the old assertion is not mistaken for a requirement.

**S16. Flags read from the whole of a line that includes the page's own words (`disabled`, `required` found inside an `id`).** Count 1 (A75). Rule: a parser of mixed trusted and untrusted text reads token by token and skips every quoted value whole; test it with the flag word inside each untrusted field.

**S17. The intent row was written after the first side effect, and an identifier was only meaningful inside one document.** Count 1 (IMP-037; round 7, A120 and A114). A page that submits itself while the form is filled (a file input or select that submits on change) sent a real application before the ledger knew, and the program said "Nothing was sent"; a `form=0` in a frame matched `form=0` of the page. Rule: write the record **before** the first action that can have the effect, and take it back only when you can show nothing happened; and an identifier that is scoped (a form number, a ref) is compared together with its scope (the frame).

## 2. Platform differences (macOS, Windows, root vs normal user)

**P1. macOS CI: a forbidden directory that does not exist yet and sits under a symlink (`/var`) kept its unresolved prefix, so "the profile would contain this directory" was missed (`test:profile`, e9da57a).** Count 1.
- Root cause: `realOrResolved` resolved through links only if the path existed.
- Caught by: macOS CI. Earlier: a test that builds the link and the missing directory itself on Linux.
- Prevented by: `src/profile.ts` resolves the nearest existing ancestor and appends the rest; a test builds the link and fails on the old code (`test/profile.mjs`); fix 4e5bccf. Same class as the symlink hook findings (E1).

**P2. Windows CI: Ctrl-C arrived while the login window opened, but the abort listener was registered after `page.goto`, so the login hung (`test:login`, e9da57a).** Count 1 (in a family of 3: an event that can fire before its listener exists).
- Root cause: Windows' slower start exposed the window. Register listeners before anything slow; an already-aborted signal closes at once.
- Prevented by: `src/login.ts` registers first; `test/login.mjs` aborts inside the "Opening" message and starts with an aborted signal (both hang on old code); fix 4e5bccf. Rule: fire the signal first in the test.

**P3. Gate used the first resolved address (`localhost` is `::1` first on the Linux runners and Windows).** Count 1 (IMP-013, CI red on all three systems). Fix: try every allowed address in order (`src/net-gate.ts connectFirst`); test with a resolver returning `::1` first and a server on 127.0.0.1 only (`test/net-gate.mjs`). Also `agent:false` ignored `createConnection`.

**P4. `/` on Windows is the current drive, not a directory.** Count 1. Fix: `path.resolve` the root before walking (`src/hooks.ts`).

**P5. CRLF checkouts broke the generated benchmark table comparison.** Count 1. Fix: `.gitattributes` `eol=lf`, normalize reads in tests.

**P6. `--import` with an absolute path (Windows reads `D:\a\...` as URL scheme `d:`).** Count 4 before the scan (earlier tests, then `test:team-run-cli` at a035a87). Fix: `test/windows-imports.mjs` scans `test/`, `scripts/`, `bench/`, `src/` and fails on the old tree (17 mutants, 0 survivors); use `pathToFileURL` (IMP-025, SKILL-019, lesson 32).

**P7. Windows server answered 404 to the page's own scripts (`normalize("/persona.js")` gave `\persona.js`).** Count 1. Fix: `posix.normalize` in `src/server.ts`; also `file://`+Windows path is not a URL (use `pathToFileURL`), `PATHEXT` is case-insensitive, `new URL().pathname` is `/D:/...`.

**P8. Windows: link-dependent rows with no link (`test:bash-readonly`, ecc83f2); `file-hooks`/`browser-honesty` in `test:bench-table`; row counts differ where a symlink cannot be made.** Count 3. Fix: filter the rows on win32 and declare the platform count in the suite's `meta`; the honesty children import by file URL (2df56d3); `test:bench-table` checks the platform allowance.

**P9. macOS has no `timeout`; `127.0.0.2` may not be routable on macOS; headless Chromium never requests a favicon; Playwright's default headless shell lacks notifications.** Count 1 each. Fix: decoy tests skip, not fail; tests use stand-ins (`__testWatchPage`) where the real build cannot trigger the case.

**P10. Tests written and run on Linux only; CI on the other systems read late.** Count 5+ (aggregated in SELF-HEALING part C). The rule is "list the OS assumptions before pushing" (lesson 25, SKILL-009), and it is the top source of red CI in this project. Linux in this sandbox runs as root with Chromium at `/opt/pw-browsers/...`, which differs from CI in two more ways (uid, browser path).

## 3. Security reasoning

**S1. A hook judged the text of a path or command and the tool read it differently.** Count 4 (symlinks, round 1 A1; `~` and the relative-link base, round 2 A27/A28/A44; command names A51; Glob patterns and credential list A29). A51 was critical: 110 attack rows ran without a prompt before the allow-list. Found too: the file tools could write `.git/config` and a read-only `git status` then ran `core.fsmonitor`; `less '+!cmd'`, `printf -v PATH`, `ps eww`, `date -f`, `file -C` and `sort --compress-program` were "read-only" by name.
- Root cause: deny-list by name and text matching.
- Caught by: adversary rounds 1 and 2 (running the reproduction). Earlier: run every tool against every form of its input.
- Prevented by: `src/readonly-shell.ts` allow-list of safe forms, `toolPath`, `canonicalPath`; `test/bash-readonly.mjs` (216 rows), `test/path-text.mjs`, `test/path-scope-symlink.mjs`; lesson 28 / SKILL-013.

**S2. The "localhost only" boundary was a route handler that redirects went around (A2, critical), and a claim of "already tested" shipped.** Count 1; also WebSocket and WebRTC bypassed `context.route()` (earlier). Fix: loopback-only credentialed forward proxy; decoy gets 0 of 16; lesson 23 (test the whole chain with a decoy). Claim was a docs failure too (see D2).

**S3. Boundary tested only for the direct case.** Count 1, critical. Same as S2; rule: decoy plus the whole chain.

**S4. A reader that cannot see part of the page said nothing was wrong (A10: one field of four listed, the rest in an iframe and shadow root).** Count 1. Fix: "Not listed, and why" block, named hidden fields, `fill` refuses them (`test/browser-frames.mjs`; lesson 26). Residuals logged: A22/A25/A26 part 2 wait for S5; the reader is advisory against a cooperating page.

**S5. `domainToASCII` treats its input as a URL host and accepted `linkedin.com/jobs`.** Count 1 (IMP-026). Wrong belief about a library. Fix: a Unicode-letter/digit/dot/hyphen prefilter in `src/allowances.ts`; caught by the first test of the host rule. Rule: run the library on the hostile and odd inputs first.

**S6. Service-worker "block" assumed to reject `register()` (IMP-028 test).** Count 1.
- What: the test asserted `register()` fails. It resolves; Playwright's `serviceWorkers: "block"` only keeps the worker from running.
- Root cause: a belief about the library, not a run. Caught when the test failed on correct code. Earlier: a ten-line probe.
- Prevented by: the assertion is now about the effect (no worker is running and a worker that answers every request does not); `test/login.mjs`; SELF-HEALING row "A guard or a test written from what I believed a library function does".

**S7. Upload analysis missed `<input type=image formaction=...>` (IMP-029).** Count 1.
- What: the first destination check read `form.elements`, which omits image inputs, so an image button's own `formaction` could redirect an attached file.
- Root cause: relying on the form accessor's idea of its own controls. The page can also forge accessors (an input named `action`, replaced `URL`/`baseURI`).
- Caught by: a mutation survivor; the test was written from the threat list before the run and failed on the code. Earlier: enumerate every submit-capable element type from the HTML spec when writing the rule.
- Prevented by: `<input type=image>` looked for separately; addresses resolved in Node, not in the page; the network-level hold is the enforcement; `test/upload-form.mjs`, `test/uploads.mjs`; lesson 34 / SKILL-021.

**S8. Upload hold lifetime keyed on origin instead of a new document (IMP-029).** Count 1.
- What: the hold on non-read requests was cleared by comparing origins; a same-origin form submit and a script-only change of address were handled wrongly either way.
- Root cause: the wrong signal; the right one is "a new document has loaded in the tab".
- Caught by: a mutation survivor (one of the 6 first-pass survivors of 101 mutants). Prevented by: hold ends on a new document; `test/upload-form.mjs`.

**S9. A profile path rule treated `..x` (a directory whose own name starts with two dots) as a way out of its parent, so a profile could sit inside the repository (IMP-028).** Count 1. Fix and test: `..sneaky`; `src/profile.ts`; `test/profile.mjs`.

**S10. Earlier real findings found by running attacks, not by reading:** a package-install rule could auto-approve arbitrary packages; terminal escape-sequence injection in `insights` and the transcript; the screenshot tool leaked a local path; `--port 0` silently broke the approval UI's auth checks; process-exit deadlock; browser session `close()` could leak Chromium. Count 1 each. Fixed in the Fix commits listed in `git log` (3ce7d8a, ce957c8, 00c0ef7, 94163bc, 2639aec, a6dfe7a, d80aefb, a3ac6c9); the standing rule is lesson 1: construct the bypass and run it.

**S11. A page could hang a tool call, kill the process (a status outside 100 to 999, a rejected route callback, 150 popups), repeat a failure unseen, or get a typed password recorded.** Count 1 each (A21, A31, A39, A41, A42). Fixes in IMP-017/018; `test/fatal.mjs`, `test/browser-hang.mjs`, `test/browser-popup-storm.mjs`.

**S12. `checkpoint` could push secrets from a fresh clone (no scanner installed) and to any branch (A32, A33).** Count 1. Fix: runs the repository's own scanner and refuses when absent; designated branch and expected origin (`test/checkpoint.mjs`).

**S13. The compaction redactor missed ordinary secret spellings (A34: `GITHUB_TOKEN`, `DB_PASSWORD`, `client_secret`, `Cookie`, `Authorization`, Bearer, JWT).** Count 1. Fix: Dev-Skill `handoff_hook.py` (SKILL-015, `tests/handoff_hook_test.py`). Open decision: summaries are committed to a public repo (HANDOFF "Needs you").

**S14. A verdict of "equivalent mutant" that was a belief (the hold treats `OPTIONS` as a plain read: "nothing sends a body with OPTIONS") and was wrong (A53: an XHR with method `OPTIONS` and a body carried the whole file).** Count 2 (the first was the unresolved-path mutant, IMP-028). Rule: an "equivalent" verdict is a claim; build the counterexample before writing it down, or call it unproven.

**S15. A reviewer's suggested fix would have done nothing, and only a probe showed it (A52: "hold every request with no frame" -- a shared worker's `fetch` never reaches the context's `route()`).** Count 1. Rule: before building a fix for a channel, print what the interception point actually sees for that channel; a fix that is tested only through the attack that found the hole can pass for the wrong reason.

## 4. Tooling and process

**O1. HANDOFF "Updated:" timestamp typed by hand, in the future (e9da57a).** Count 1 (plus a related format break, O2).
- What: `test:handoff` and `test:bench-integrity` (which reads the real `HANDOFF.md`) failed.
- Root cause: a human-typed clock value; also the compaction summary lists "a future HANDOFF timestamp" among errors.
- Caught by: the full suite. Earlier: take the time from the clock, never type it.
- Prevented by: only the check, not a generator: `scripts/handoff-check.mjs` (run by `test/handoff.mjs`, and through the real HANDOFF.md by `test/bench-integrity.mjs`) fails on a stamp more than 5 minutes ahead. The stamp is still typed by whoever edits HANDOFF.md (use `date -u +%Y-%m-%dT%H:%M:%SZ`); a script that writes it would close this fully. (Corrected: an earlier line here said tooling writes it.)

**O2. Pushed b554218 before the full local suite finished; it carried a bug of mine (a broken `Covers agent-loop commit:` line a test parses), red on all three systems.** Count 1; the user asked "do you even check that or just push the code mindlessly". Fixed in 6a632d2. Rule: do not push until the full suite passed locally; edit machine-read lines in their format only (`docs/SELF-HEALING.md` part C).

**O3. `pkill -f` with a pattern also in my own command line killed the shell and the run.** Count 2 (the second: `pkill -f full-on-commit.sh` or `pkill -f HONESTY`, exit 144). Fix: save PIDs and kill those, or do not `pkill`; let a harness timeout end the child.

**O4. Bash classifier outages ("no verdict" transient error) during the S2 session.** Count 1 (noted in the 20261007T171139Z compaction). Root cause: the tool-permission classifier, an external dependency. Workaround: retry once, or use the GitHub MCP tools for repo reads/writes; do not loop. A hook or classifier outage is not a reason to bypass a gate.

**O5. Pre-commit scanner blocked commits on false positives.** Count 4 listed (`user:pw@linkedin.com` in `test/allowances.mjs`; `test/login.mjs:19` and `:71` for a made-up password; a regex in `signals.ts`; fake secrets and destructive quotes in `round-02.md`; a `git branch -D` row in `shell-readonly.mjs`). No harm: no commit happened. Fix: `// devskill:allow (reason)` on the line, defang fake values (`<fake, N chars>`), never `--no-verify`.

**O6. The scanner's allow marker was ignored past column 200 (finding text cut before the check).** Count 1 (SKILL-012; found committing IMP-015). The documented escape hatch did not work for long lines, which pushes people to the forbidden one. Fix: Dev-Skill scanner checks the whole line; Dev-Skill `tests/stress/scan_stress2.py`; `.githooks/check_staged.py` copy synced and checked by `scanner_copies_test.py` (SKILL-016, df00698).

**O7. Words with a slash read as paths (`async/await`, `client/server`).** Count 1 (S3a sizing). Fix: a path has an extension, exists, or starts like a project directory (`isPath` filter).

**O8. An unquoted heredoc (`<<EOF`) around text with backslashes or backticks.** Count 2 (the mutation harness; IMP-017's mutation paragraph: backticked names ran as commands and vanished, a `>` created a file named `clientHeight`; a stray literal `\n` in the lessons file). Fix: quote the delimiter or use the file tool; read the result back.

**O9. Building `dist/` while a suite ran, or a suite lost to a restart.** Count 2. Fix: scratch outDir or worktree; `setsid nohup` for anything long; a wait loop returned early when the launcher shell exited (use log polling).

**O10. Ran a suite without the flags its npm script adds (the fake SDK needs `--import`), so a load experiment measured the real SDK.** Count 1. Fix: `npm run test:<name>` or copy flags exactly.

**O11. A load command via `sh -c` triggered a safety-check denial (not a real removal).** Count 1. Used `timeout 240 yes > /dev/null &`.

**O12. Child-process env leaked between scenarios (`FAKE_*`), a backtick broke a usage template literal, a wrong insertion point for `resolveTeamOption`.** Count 1 each (S3a compaction). Fix: clean env per scenario; read-back after edit.

**O13. An error in doctor: a timeout read as "not found".** See T17.

**O14. Stop-hook feedback repeatedly said to commit/push uncommitted changes while a full suite had not passed.** Count 3+. Handled by explaining the guarded push job and pushing on green; WIP checkpoints say "not verified" in the message (7386ebb, 922e709, e469c62).

**O15. A guard written from belief about a Playwright call: a string passed to `evaluate` is an expression, so the function came back uncalled ("hidden is not iterable").** Count 1 (S1b). Fix: build a real function with `new Function` from the shared source; run the real browser once.

**O16. Counted a token in text and ref lines together (40 vs 20).** Count 1. Count the thing the claim is about.

## 5. Docs and claims

**D1. Generated benchmark table out of date when the suite ran.** Count 3. Fix: `node bench/run.mjs --write-doc` as the last step after any suite, log or planned-list change; `test/bench-table.mjs` fails on drift (it did its job).

**D2. A shipped claim ("already tested") for the localhost boundary was false (A2); more claims narrowed after round 2 (A22, A25, A26, A40, A43).** Count 1 critical plus 5 corrections. Fix: BROWSER-AGENT sections 4, 4c and 7 now say what was measured and what the reader cannot do; a claim says which signals and recipes it covers.

**D3. Docs said "1 of 8" in four places after the number changed; README/LAYOUT/TESTING said 37 suites when `npm test` ran 60.** Count 3 (including stale commit hashes in README/STATUS). Fix: grep for the old number before saying done; README names the commit CI was read on.

**D4. A baseline reported from a lenient scorer (observability 2 of 8, true value 1 of 8) and baselines "remembered".** Count 1. Fix: score old code in a scratch worktree, baseline changes need a logged reason checked against git history (`bench/baseline-check.mjs`, `test/bench-integrity.mjs`; A13, A35).

**D5. Cause of a CI failure stated as fact when unproven (ui-plain on macOS, `AL.mascot` on Windows, load-related flakes fixed as hardening).** Count 3. Rule: write "unproven" in the entry until CI confirms (IMP-013 did; keep doing so).

**D6. Adversary findings or CI results quoted for the wrong commit.** Count 2 (README/STATUS stale hash, 3f30f17; HANDOFF "CI green" stating only what was confirmed, 790771e). Rule: every CI claim names the commit and the system; "pending when read" is not green.

**D7. Silent truncation presented as full output (the README said "full transcript" while a reloaded page showed the newest 5,000 events; `inspect` hid a repeated failure; the `text` tool dropped the reader's notes).** Count 3. Fix: say what was left out and how to see it (`test/bus-history.mjs`, `test/browser-observability.mjs` sections 16 to 22).

## 6. Agents and usage

**A1. The adversary agent was cut off by the usage limit (round 2 after its findings table; round 1's first attempt before writing anything).** Count 2 (1 total loss, 1 partial).
- What: round 1's first retry died of a usage limit before writing; round 2 died at its limit after the table and last finding.
- Root cause: the brief did not say to write findings as confirmed (round 1); work depended on one long run.
- Caught by: a background-task completion with a usage-limit error. Earlier: the brief says "append each finding to the file as soon as it is confirmed".
- Prevented by: the brief in `bench/adversary.mjs` flow and `docs/SELF-HEALING.md` ("A sub-agent dies with no output"): relaunch with the same brief plus the append rule; do not guess what it would have found. Round 2's file survived because it was written as it went.

**A2. An adversary that is the builder's own session shares its blind spots.** Count 1 (lesson 22). Rule: a new fresh-context agent every round; given titles of earlier findings from round two; findings need a command or output (`test/adversary-round.mjs`, A49).

**A3. Rounds that only read documents found design gaps, not the exploit.** Count 1 observation (round 1 triage "what the round taught"). Rule: the reproduction requirement.

**A4. Usage nearly out: the rule to save first, asked of the project twice by the user.** Count 2 requests. Prevented by: `npm run checkpoint`, `CLAUDE.md`, skill Step 9; a checkpoint commit says what was not re-run (e.g. e9da57a, 4e5bccf messages).

**A5. Background jobs and agents do not survive a worker restart or compaction.** Count 2+. Relaunch with `setsid nohup`; HANDOFF must already be current; compaction summaries are compared with it (`scripts/handoff_hook.py`, `test/handoff.mjs`; the PostCompact hook is "unproven live").

**A6. A scripted fake that never exercises the decider (fake SDK emitted no tool call) hid what a real model does with the gates (one refused click asked for eight more times).** Count 1. Fix: run the real decider once on the cheapest tier behind the fake (Step 8).

**A7. The persona passed 24 safety checks but its gap rule swallowed every agent voice on a realistic run.** Count 1. Fix: replay realistic runs; assert the shape of what a person sees.

**A8. A view derived from data shown elsewhere disagreed (lineage credited a file only after a successful write; the old "Files changed" listed a refused `.env` write).** Count 1. Rule: put the views side by side; cross-check totals against raw data.

---

## Index of counts

Sections: Testing/CI 31, Platform 10, Security 17, Tooling/process 16, Docs/claims 7, Agents/usage 8. **Total 89 entries** (T1 to T31, P1 to P10, S1 to S17, O1 to O16, D1 to D7, A1 to A8). Entries with count 2 or more: T2, T4, T8, T11, T17, T21, T27, P6, P8, P10, S1, S14, O3, O5, O8, O9, O14, D1, D3, D5, D6, A1, A4, A5.

## Not established or unverified (do not turn these into claims)

- Root cause of `test:ui-plain` on the macOS runner (f10a830) and `AL.mascot` undefined on Windows (a035a87).
- Whether the Windows and macOS runs of `uploads` and `upload-form` passed (IMP-029 "not verified" at writing).
- The macOS and Windows case-folding rows of finding A6; A44 (argued, not run on Windows).
- The PostCompact hook live behavior; nothing has run against a real site.
