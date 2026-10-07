# Improvements: why we made each one and how

The changelog says *what* changed. This file says **why it was worth doing and how it was done**, with the evidence before and the
number after, so that months later the reasoning is still readable. Every improvement gets an entry, newest last. `test/improvements-log.mjs`
fails if an entry is missing a field, if its id repeats, if it names a benchmark suite that does not exist, or if "Measured" has
no number and no stated reason it cannot have one.

Entry template (copy it):

```
## IMP-NNN · YYYY-MM-DD (or "backfilled") · Short title
- **Problem:** what was wrong, with the evidence (a command, a probe, a number).
- **Why it matters:** the harm, in the user's terms.
- **Change (how):** what was done, at the level of "which mechanism and where".
- **Measured:** before -> after, from a benchmark suite or a test. Or "not measurable because ...".
- **Cost / trade-off:** what it costs: complexity, time, tokens, a new way to fail.
- **Suites:** benchmark suite ids it moves (comma separated), or `none`.
- **Skill impact:** what the dev-workflow skill learned from it (rule, lesson, template), or `none`.
- **Follow-ups:** what could still be improved, or `none`.
```

Skill-side changes are logged in `dev-workflow/references/improvement-log.md` in the Dev-Skill repo, in the same format. When one
improvement teaches the other project something, it is logged in both and each entry names the other.

Entries marked "backfilled" were written after the fact from the changelog, the stress reports and the test files; numbers in them
come from those documents, not from a re-run.

## IMP-001 · backfilled · Safety net: from 3 of 27 dangerous calls denied to all of them
- **Problem:** the first adversarial stress test (docs/STRESS-TEST-REPORT.md) sent 27 dangerous calls through the hook chain; the
  original deny list stopped 3. `rm -rf /*`, `rm -fr /`, `cd / && rm -rf *`, `$HOME` forms and encoded variants all went through.
  `--no-approval` makes that list the only guard.
- **Why it matters:** an unattended run with a model that goes wrong, or reads a hostile file, could delete the user's home directory.
- **Change (how):** widened and restructured the deny rules in `src/hooks.ts`, judged compound commands per subcommand
  (`src/bash-analysis.ts`), used the SDK `tools` option per phase instead of `allowedTools`, limited Read/Write/Edit to `--dir`, and
  gave phases a minimal allow-listed environment (`src/env.ts`) so `env` has nothing to leak.
- **Measured:** safety suite 3 of 27 denied -> 26 of 26 denied at 7138e1b; the 27th case (`env`) is mitigated by the minimal
  environment rather than denied, and the suite lists it separately.
- **Cost / trade-off:** more rules to maintain; a heuristic, not a parser, so new spellings can still slip; ordinary work must not be
  denied, which `test:safety` also asserts.
- **Suites:** safety
- **Skill impact:** the dev-workflow scanner had the same weakness and got the same treatment (see the skill-side log, SKILL-001).
- **Follow-ups:** the LIVE web mode needs the same adversarial treatment for URLs (S2, threat D2).

## IMP-002 · backfilled · Ctrl-C and the Stop button leave a run in a known state
- **Problem:** Ctrl-C left the run marked "running" forever; reproduced on the previous commit before fixing.
- **Why it matters:** a stuck "running" run blocks trust in every other status, and a runaway real-model session keeps spending.
- **Change (how):** `RunControl` aborts into the running phase and the Overseer call, a SIGINT/SIGTERM handler, a Stop button in the page,
  and `--max-cost`; the result is a `stopped` status with a reason.
- **Measured:** 1 of 1 Ctrl-C left the run "running" -> 0 of 1; `test/stop-e2e.mjs` sends the signal to a real process and asserts
  `stopped`.
- **Cost / trade-off:** every long call now needs an abort path; a stop is a request, so a tool already running finishes its step.
- **Suites:** none
- **Skill impact:** "ask how any long-running tool stops, then send the signal and look" (verification lesson).
- **Follow-ups:** orphaned child processes after a real-SDK stop were checked once, not in CI.

## IMP-003 · backfilled · The five-phase pipeline did not beat one plain session, and the README now says so
- **Problem:** on the same task a plain single session and the full pipeline scored 4,037 and 4,039 of 4,040 at $0.08 and $1.41
  (docs/IS-IT-USEFUL.md).
- **Why it matters:** about 17.6 times the cost for a 2-point difference on that task; the multi-agent design had been assumed, not shown, to help.
- **Change (how):** the README leads with the measurement; the hybrid design uses one Builder then one Verifier **per item** instead of
  five phases per item, and a serial queue with a fresh context per item (spec: "Serial queue").
- **Measured:** 4,039 vs 4,037 of 4,040, $1.41 vs $0.08 (one task, one run each, so an anecdote that raised the question).
- **Cost / trade-off:** the experiment is one task; it is re-run properly in S7 (suite `pipeline-vs-plain`).
- **Suites:** pipeline-vs-plain
- **Skill impact:** "answer 'is it useful?' against the simplest baseline, with the measured price of every delight feature".
- **Follow-ups:** repeat on several tasks with several runs each before drawing a conclusion.

## IMP-004 · backfilled · `doctor` stops reading a timeout as "not installed"
- **Problem:** `doctor` found commands by running `which`/`where` with a 3 s limit; under load on Windows CI the limit expired and the
  command was reported missing.
- **Why it matters:** a diagnostic that cries wolf trains people to ignore it.
- **Change (how):** a PATH search with `accessSync`/`statSync` and `PATHEXT` on Windows (`src/doctor.ts`); the test now sets PATH to a
  directory holding only the target, so an old probe that respects PATH would not pass for the wrong reason (the first version of the
  test did not tell old from new).
- **Measured:** `test:doctor` red on Windows CI -> green at e0764be with all 37 suites passing on macOS and Windows.
- **Cost / trade-off:** reimplements a small part of `which`; shell aliases are not found (they never were).
- **Suites:** none
- **Skill impact:** "a timeout in a probe is an unknown, never absent" (verification-lessons.md).
- **Follow-ups:** none

## IMP-005 · backfilled · The cross-platform check blocks, with all 37 suites passing on macOS and Windows
- **Problem:** the macOS/Windows job was allowed to fail (`continue-on-error`), so its badge would read "passing" with suites red.
- **Why it matters:** a green badge that lies is worse than none.
- **Change (how):** fixed what the first runs found (`posix.normalize`, `--import` file URLs, `pathToFileURL` for printed links,
  `channel: "chromium"` for notification permission, a `serverTime` clock option for a skew test), then removed `continue-on-error`.
- **Measured:** first runs 36 of 37 (macOS) and 34 of 37 (Windows) -> 37 of 37 on both at 13f6b1a.
- **Cost / trade-off:** CI is slower and a flaky test now blocks the badge; one UI test flaked once on Linux and was made to wait up to 5 s.
- **Suites:** none
- **Skill impact:** "portability is testing: run it on the other systems and on a newer browser than yours".
- **Follow-ups:** desktop control on macOS and Windows and the real-model runs are not in any CI.

## IMP-006 · 2026-10-02 · A benchmark with recorded baselines, and a table that cannot drift from it
- **Problem:** numbers in the docs (37/37 suites, 3/27 -> all) were typed by hand, and one was repeated after a change that had not
  been re-run.
- **Why it matters:** the user asked to always keep a benchmark and to know logically why each change was made; without a baseline
  there is no "better".
- **Change (how):** `bench/` runner with deterministic suites, `bench/baseline.json` (first value ever recorded, never overwritten
  silently), `bench/latest.json`, a table in docs/BENCHMARK.md generated from them, and tests that fail if the table, the suites' checks
  or this log drift. Planned suites appear in the table as "not built" with their stage, so the table is also the measurement to-do list.
- **Measured:** 2 suites built and 9 planned at 7138e1b; first baselines observability 0 of 8, safety 26 of 26. The first scorer
  reported 2 of 8 because the word "blank" matched the probe's own URL path (fixed with opaque paths and a control test that every check fails on
  silence: 1 of 8), and adversary round 1 then showed the last point was the redirect probe matching the landing URL that `inspect` always prints
  (corrected: 0 of 8, measured by scoring the old commit in a scratch worktree). Both were found by reading the tool output behind the number.
- **Cost / trade-off:** one more thing to run; suites that drive a browser take about 5 s.
- **Suites:** observability, safety
- **Skill impact:** a benchmark's scorer needs its own control test (it must fail on silence), see the skill-side log SKILL-003.
- **Follow-ups:** add suites as stages land; real-model arms are gated and bounded by usage.

## IMP-007 · 2026-10-02 · A handoff document, a test that keeps it fresh, and hooks that save compaction summaries
- **Problem:** the conversation was auto-compacted once and the summary alone carried the requirements, decisions and the reading
  already done; nothing on disk said what was asked or where things were.
- **Why it matters:** the user asked that nothing be forgotten across compaction ("we don't forget any context about any work").
- **Change (how):** `docs/HANDOFF.md` (standing instructions, the user's requests in their words, decisions, locations, stage status,
  next step, verified vs not, improvement backlog, gotchas, how to resume); `test/handoff.mjs` fails if it names a commit more than 8
  behind HEAD or loses a section; a hook script in the skill repo saves the `PostCompact` summary to disk, re-injects the handoff
  through `SessionStart` (source `compact`) and warns at `PreCompact` if the handoff is stale. The hook inputs and outputs were read
  from the SDK's type definitions; `PreCompact` has no documented way to block or inject, so it can only warn.
- **Measured:** 3 hook event types handled (`PreCompact`, `PostCompact`, `SessionStart`), each tested with the payload shape from the SDK
  types; live firings observed so far: 1 (`SessionStart`, source `resume`, after a session-limit interruption, handoff injected) and 0 for
  `PreCompact`/`PostCompact`, which stay unproven until a compaction happens; the handoff says so.
- **Cost / trade-off:** a document to keep current (the test enforces it); a committed hook config runs a script on every checkout
  that trusts it.
- **Suites:** none
- **Skill impact:** new dev-workflow rule and `references/handoff-template.md` (SKILL-004).
- **Follow-ups:** after the first compaction, confirm a file landed in `docs/handoff/compactions/`; if not, fix the hook config.

## IMP-008 · 2026-10-02 · The browser tools tell the agent what the page did (S1)
- **Problem:** a page with an uncaught exception, a `console.error` and a 404'd script looked healthy through `inspect`; dialogs were dismissed
  and downloads discarded without a word; a long job description was cut at 3,000 characters with no way to read the rest (found by running the
  tools, [REFERENCE-AUDIT.md](REFERENCE-AUDIT.md)). Benchmark baseline: 0 of 8 page problems reported (1 of 8 under the first scorer, whose one point was a redirect reported only
  because `inspect` prints the current URL; adversary round 1, A14).
- **Why it matters:** an agent that says "the page works" about a broken page; the watchdog and the job flow both need these signals; a long
  posting is the thing being applied to.
- **Change (how):** each tab is watched for page errors, console errors and warnings, responses of 400 and above, requests the localhost-only
  rule blocked, other failed requests, dialogs, downloads and crashes. Every tool result ends with the notices that are new since the last result
  (at most 8, repeats collapsed with a count, ranked by kind and repeats), labelled as page data, with URLs cut to host and path. New tools `text`
  (paged, with the total), `notices` and `resize`; `inspect` takes a `query` and calls out a blank page. Dialogs are dismissed and reported;
  downloads are refused by the browser (`acceptDownloads: false`) and reported. Each notice is also a capped `browser-notice` event.
- **Measured:** `observability` 0 of 8 -> 8 of 8. The new test (16 checks) passes 6 of 6 consecutive runs on the built code and kills 15 of 15
  mutants (dialog listener, query-string stripping, favicon filter, repeat collapsing, eviction policy, burst settling, text cleaning, download
  refusal, console.log noise, the data label, resize bounds, ref invalidation, query filter, blank note, event cap), each for the right reason.
  Three things the test found in the first draft: oldest-first eviction threw away a message repeated 100 times to keep 200 one-offs; the
  results of a burst carried half-finished counts until a short settle was added; and cancelling a download after it started lost the race to a
  small file about 1 run in 6, so the browser now refuses downloads outright.
- **Cost / trade-off:** up to 300 ms of extra latency on a call that has notices to report; at most 8 short lines of tokens per result; three
  more tools (18 total); dialogs can be seen but not answered.
- **Suites:** observability
- **Skill impact:** Step 8 rule 16 (a bounded buffer must decide what to drop by how informative it is, not how old it is), rule 21 (a flaky
  check is a real mechanism: the download race), SKILL-007.
- **Follow-ups:** `inspect` still cannot see inside iframes or shadow DOM (adversary A10); the redirect hop is not yet reported as a notice
  (A14); the gate does not see server-side redirects (A2).

## IMP-009 · 2026-10-02 · Every hop of a redirect, and the browser's own traffic, goes through a network gate (adversary A2, critical)
- **Problem:** the localhost-only boundary was a Playwright route handler, which is called once, for the first URL of a request. A server-side
  redirect is followed inside the browser, so an allowed local page could send it to any host. Reproduced by a fresh-context adversary and again by
  the new test: a decoy on `127.0.0.2` received `/r301-exfil?data=secret` through one 301, while a direct `open` of that host was refused. The shipped
  docs called this boundary "already built and tested".
- **Why it matters:** the whole safety story for a browser that will later be logged in to a real account rests on "it can only go where we allow".
  An aggregator, or a hostile posting on one, redirects as a matter of course.
- **Change (how):** `src/net-gate.ts`, a forward proxy the browser is launched through (loopback only, random credential, `CONNECT` and `ws://`
  upgrades tunnelled, the name resolved by the gate and the connection made to the address it checked), enforcing the allowed list at every hop; the
  gate tells the agent what it refused, using headers to tell a page-made request from the browser's own background traffic. `route`, `routeWebSocket`,
  the WebRTC removal and blocked service workers stay as further layers. Redirects of the page itself are now reported (`redirect` notice, and `open`
  says where it landed).
- **Measured:** the decoy received 1 request through a single 301 before and 0 of 16 attempts after (301, 302, 303, 307, 308, a three-hop chain, meta
  refresh, `Refresh` header, redirected image, script, POST with a 307, iframe, form post, popup, link, WebSocket); the browser's own background requests
  to google.com are now refused too. The notice for a refused redirected fetch appeared in 4 of 8 runs under the first approach (events on the
  request chain) and in 8 of 8 once the gate reported its own refusals. 13 of 13 mutants killed across `test/net-gate.mjs` (9 checks) and
  `test/browser-redirect-gate.mjs`; the gate test was the first to say that the host rule and the address rule each have to hold alone.
- **Cost / trade-off:** every request now takes a hop through a local Node process (not measured for latency); the gate is TEST mode's policy only until
  S2 gives it an allowances list; the gate sees hosts, not paths, for https (a tunnel).
- **Suites:** none
- **Skill impact:** SKILL-007: a boundary enforced by a hook on the first request is not a boundary on a chain; test with the chain, with a decoy that
  records what reaches it.
- **Follow-ups:** the decoy tests skip where `127.0.0.2` is not routable (macOS default), so the macOS CI result will say skipped, not passed.

## IMP-010 · 2026-10-02 · File tools can no longer walk out of --dir through a symlink (adversary A1, high)
- **Problem:** the path-scope hook judged paths as text. A symlink inside `--dir` pointing at the agent profile read the cookie file straight through
  it, `link/../x` was judged by its text while the operating system resolves it through the link, and a write through a dangling link created a file at
  its target. A cloned repository can ship such a link.
- **Why it matters:** the planned protections for the login profile, uploads and parallel write slices all lean on this hook.
- **Change (how):** `canonicalPath` in `src/hooks.ts` follows every link, applies `..` to the real directory, follows a dangling link by hand, treats
  anything it cannot resolve (a loop, a permission error) as outside, and caps a chain at 40; the sensitive-file hook judges what a link points at, so
  a file called `notes.txt` linked to `.env` is the credential file it is.
- **Measured:** 0 of 14 symlink and `..` attacks denied before, 14 of 14 after, with 8 controls (ordinary files, a new file, a relative path, a link that
  stays inside `--dir`) still allowed; 6 of 7 mutants killed, the 7th (no cap on a chain) being equivalent here because the kernel stops at 40 links.
  `Bash` is still not scoped by this hook: it was never, and containing it needs a sandbox, not a hook (adversary A1, A6).
- **Cost / trade-off:** a few `realpath` calls per file-tool call; a path through an unreadable directory is now refused instead of allowed.
- **Suites:** none
- **Skill impact:** SKILL-007 (test containment with real links on a real disk, and never build a "`..` through a link" input with `path.join`, which
  collapses it as text and tests nothing).
- **Follow-ups:** a diff-scope audit after each builder (`git diff --name-only` inside the slice) is the only check that covers Bash; planned in S3a.

## IMP-011 · 2026-10-02 · The benchmark can no longer be tampered with or fail open (adversary A13, A14)
- **Problem:** a hand-lowered baseline made the table show a gain that never happened and the table test still passed; one corrupt `baseline.json`
  made the runner silently erase and re-record every baseline; the freshness checks passed when the commit they name is missing from the clone (a
  made-up hash, or a document 51 commits stale); the change column compared raw counts across different numbers of checks; and the only point in the
  observability baseline was earned by accident (the redirect probe matched the landing URL that `inspect` always prints).
- **Why it matters:** a benchmark is only worth anything if "better" cannot be manufactured.
- **Change (how):** `bench/baseline-check.mjs` compares each suite's current baseline with the first committed one and requires a "Definition changes"
  row that names the suite and says "baseline"; the runner stops (exit 2) on a baseline file that exists but does not parse; the change column compares
  pass rates when the number of checks changed; freshness checks fail closed in CI when the commit is unknown (a note elsewhere); the redirect and
  failed-request probes demand an explicit report and the silence control now covers the landing URL and four ports.
- **Measured:** `test/bench-integrity.mjs`, 4 groups of checks with controls: a lowered baseline is caught 4 ways and a logged correction passes; a corrupt
  file leaves the runner at exit 2 with the file untouched; "6 of 8 to 7 of 10" reads -5 points, not +1; an unknown commit fails under CI=1. The corrected
  observability baseline is 0 of 8, measured by scoring commit `7138e1b` in a scratch worktree (it had been recorded as 1 of 8).
- **Cost / trade-off:** a legitimate baseline change now needs a table row; the history check needs enough git history and says so when it has none.
- **Suites:** observability
- **Skill impact:** SKILL-007 (a baseline taken from an accidental pass is worse than none: measure the old code with the corrected scorer).
- **Follow-ups:** the same checks for the skill-side benchmark (`tests/bench_skill_test.py`).

## IMP-012 · 2026-10-02 · Saving before usage runs out is a command and a rule, and recoveries are a catalog (user request)
- **Problem:** the session was close to its usage limit more than once. A sub-agent died of the limit before it wrote anything (round 1's first attempt), a background
  suite was lost to a worker restart, and saving two repos by hand costs several steps at exactly the wrong moment. The same kinds of mistake (a stale generated table, a
  test on global state, a lenient scorer, building while a suite ran) were also made more than once.
- **Why it matters:** work that is not on the remote is work that has to be redone, and a rule nobody can find is not a rule.
- **Change (how):** `scripts/checkpoint.mjs` (`npm run checkpoint -- "why"`): for this repo and the Dev-Skill checkout one level up, stage, commit and push the current
  branch, with a message that says it is not a claim of green, never `--no-verify`, never a force push, retry on network errors only, and a plain report of what it could not do.
  `CLAUDE.md` in both repos (loaded every session) carries the rule and the standing rules; `docs/SELF-HEALING.md` is the catalog (process recoveries, runtime recoveries,
  mistakes made more than once, each with the habit that prevents it); the dev-workflow skill's Step 9 and improvement-loop reference carry the rule; the spec's usage governor
  and threat E1 now require a checkpoint **before** any pause.
- **Measured:** `test/checkpoint.mjs`, 6 checks with controls: a dirty repo is committed and pushed, a clean one makes no commit, an unpushed commit is pushed, a blocking hook is
  respected and its message shown, a rejected push is reported and not forced, and the parent repo is found only when it is a different one. The first real use saved two repos
  that a pre-commit scanner had blocked on four false positives; the catalog now says how to allow them inline. Not measurable: whether the rule is followed under pressure.
- **Cost / trade-off:** one more file to keep current (the catalog); a checkpoint commit can contain unfinished work, which its message says.
- **Suites:** none
- **Skill impact:** SKILL-008 (Step 9, improvement-loop section 6, a self-healing reference).
- **Follow-ups:** make the governor's checkpoint real in S4; a `Stop`-hook nudge when the transcript shows a limit warning would be the next step but cannot be verified here.


## IMP-013 · 2026-10-03 · Red CI on all three systems: the gate tries every address, Windows paths, line endings, timing races, a popup's first error (user: "make the shit work")
- **Problem:** every run of the `Tests` and `Cross-platform` workflows on 784f2be, 818775c and d3aefdc was red. Linux: `test:net-gate` got an empty reply for `http://localhost:PORT/post`
  (the CI runner resolves `localhost` to `::1` first and the gate connected only to the first allowed address, while the target listens on 127.0.0.1). Windows: the same, plus
  `test:scope` and `test:safety` (every ordinary read and write inside a workdir written as `/tmp/...` was refused: the bare root `/` was not mapped to the current drive, so no
  path could be resolved) and `test:bench-table` (the checkout has CRLF endings; the generated table has LF). macOS: `test:ui-mascot` measured the cat at its start position
  (727 against 564.86 px). Windows had also failed `test:stop` once at 7138e1b ("cut short" took 5249 ms).
- **Why it matters:** a red build hides real regressions, and the gate bug was real: any machine whose `localhost` is IPv6 first could not use the browser tools at all in TEST mode.
- **Change (how):** `src/net-gate.ts`: `decide` returns every allowed address and a new `connectFirst` tries them in order (5 s each) for plain requests, CONNECT tunnels and
  ws:// upgrades; none reachable is a clean 502. `src/hooks.ts` `canonicalPath`: the walk starts from `resolve(root)`. `.gitattributes` (`* text=auto eol=lf`) plus a
  CRLF-tolerant read in `test/bench-table.mjs`. `test/ui-extras-helpers.mjs` `catBox` now waits until the cat is at the position the mascot reports, not merely still. `test/stop.mjs`
  waits for the model call to be in flight and measures from the stop instead of pausing a fixed 500 ms.
- **Measured:** gate: the new check in `test/net-gate.mjs` (resolver returning `::1` then `127.0.0.1`, target on 127.0.0.1 only; plain, CONNECT, ws://; plus "none reachable is 502") fails on
  the old gate ("plain request: the gate gave up after the first address (502)"), fails on a mutant that tries only the first address, and passes twice on the fix. Line endings:
  with the two docs converted to CRLF the old `bench-table` test fails and the new one passes. **Not reproduced here, so not claimed:** the Windows path-root fix (no Windows
  machine; the new placement check passes on Linux with or without it) and the macOS and Windows timing races (the mascot test could not be made to fail under 12x CPU
  throttling; the old and new stop tests both passed under 8 CPU hogs). Those three are confirmed or refuted only by the CI run on the commit that carries them.
- **Second round (the first push of these fixes, `b554218`, was read on all three systems):** Windows passed everything except a handoff-format line I had broken, so the path-root fix and the
  gate fix are confirmed there; macOS passed `ui-mascot`, and failed `browser-observability` (a burst reported as x50 where x100 was coming). Chasing it under CPU load found a different, real
  fault: a popup's first console error was lost 3 runs in 5 on the committed code, because console, exception and dialog listeners were attached to a page only after it had started loading.
  They are now also attached to the browser context, which hears a popup before the page object exists; an unknown page is adopted as a tab when it first speaks and each event is handled once
  (`test/browser-observability.mjs` section 3d, a stand-in context: 4 mutants killed: no dedupe, no adoption, no exception handler, no dialog handler; a real-browser run under 4 CPU hogs: committed
  code 3 failures in 5, fixed code 0 in 5, and 0 in 8 under 8 hogs). The burst lull went from 60 ms to 120 ms (cap 480 ms); **that one is a guess**: the macOS failure did not reproduce locally
  (0 in 8 under 8 hogs, before and after), so the change is recorded as a hardening, not a measured fix.
- **Third round:** the second push (`4258f4c`) failed the same macOS assertion again, this time with an empty result (the first message had not reached the session 40 ms after the click).
  Two different symptoms of one cause: the real-browser test depended on wall-clock arrival times, which a slow runner breaks in more than one way, so no lull length could make it reliable. It is now two
  tests: the settling rule on mocked timers (waits while messages arrive less than 120 ms apart, at most four rounds, not at all when nothing is waiting; 3 mutants killed: the old 60 ms lull, no cap,
  always waiting), and a real-browser check that a burst of 200 messages is counted in full (x100 each) once the page says it is done. What this gives up: nothing now checks, in a real browser, that a
  result built mid-burst shows final counts; the rule test covers the rule, not the browser's delivery times.
- **Cost / trade-off:** a refused address costs up to 5 s before the next is tried (a refusal is instant; only a black-holed address waits); `catBox` can wait longer on a cat that never arrives (and now
  says where it is and where it should be); LF everywhere means a Windows editor that wants CRLF has to be told not to rewrite files.
- **Suites:** none
- **Skill impact:** SKILL-009 (a new test lists what it assumes about the OS: loopback order, path roots, line endings, timers; fixed pauses become waits for the state).
- **Follow-ups:** read CI for all three systems after every push, and record the result in HANDOFF "what is verified"; a `test:scope` case on a real Windows drive path once a Windows machine is at hand.

## IMP-014 · 2026-10-03 · `inspect` sees iframes and shadow roots, says what it could not read, and does not offer fields a person cannot see (S1b, adversary A10)
- **Problem:** adversary round 1 (A10) ran `inspect` on a page with a main-frame field, a same-origin iframe form and an open-shadow-root field: it listed one field of four, `fill` by selector wrote into the
  shadow-root field it had not listed, and a selector into the iframe waited out the 5 s action timeout. Measuring the fix first (the new `form-coverage` suite, baseline taken on the unmodified build `646cdcb`)
  showed a second fault: a text field with `opacity:0`, the classic bot trap, was listed as an ordinary field with a ref, and `fill` answered "Filled #trap-9". Baseline **1 of 8** (only the main-frame field).
- **Why it matters:** every check that will be built on this reader (the pre-submit form diff, the job-id check, the hidden-text check) would report "no mismatch" for questions it never saw, a green check
  because nothing was inspected; Greenhouse's standard embed is exactly an iframe. And a script that fills a field no person can see is what form builders use to ban bots.
- **Change (how):** `src/browser-tools.ts`. One field walk per page: the main document, every open shadow root (nested), and every readable frame (cross-origin too: the browser reads what a page's scripts cannot),
  sharing the 60-ref budget; lines end `frame="name"` and `in-shadow-root`. Frame text is added to `inspect` and `text`. A "Not listed, and why" block reports a frame still loading (up to 1.5 s of waiting; "has
  not navigated to its src yet" is detected separately from the lifecycle, because a child frame's empty first document counts as loaded), a frame that did not load or could not be read (named, the rest of the page
  still listed), frames over the 20-frame limit, a frame nobody can see that holds fields, and custom elements that may hold a closed shadow root. Text fields with opacity 0, a box of 1px or less or a position off
  the page are named and given no ref, and `fill` refuses them (and `display:none` and `type=hidden` ones); checkboxes, selects and buttons are not judged. A selector that matches nothing in the main document but
  matches inside a frame fails at once with a pointer to the ref. Page-side code is shared as text between the walk, the frame check and the fill guard and turned into real functions in Node.
- **Measured:** `form-coverage` **1 of 8 to 8 of 8**. `test/browser-frames.mjs`, 14 checks in a real browser plus stand-in frames, failed on the old build at the first new assertion; **17 mutants** (no shadow walk, no
  frames, each hiding rule, fill guard off, selector hint off, closed roots not counted, budget per frame, unquoted frame label, hidden frames read, labelledby from the document, no frame cap, no loaded-frame check,
  frame text off, unreadable frame throws, traps still offered) all killed; the first run left one alive (the not-navigated branch, which the real browser only shows for an instant), which became check 14 with stand-in
  frames; run five times, three of them under 4 CPU hogs. Scorer controls in `test/bench-suites.mjs` (miss on silence and on echoed page text; lenient, text-matching and source-echo scorers caught).
- **Cost / trade-off:** `inspect` can take up to 1.5 s longer when a frame is still loading, and costs a round trip per frame (at most 60 looked at, 20 read) and a scan of every element (capped at 100,000 a frame);
  a form that really needs an opacity-0 or 1px text field (an OTP input drawn over styled boxes) now needs the user; the prompt gained five lines; refusals are by geometry and style only.
- **Suites:** form-coverage
- **Skill impact:** SKILL-010 (lesson 26: a reader that cannot see part of the thing says what it could not see).
- **Follow-ups:** the form diff itself (S5); a closed shadow root stays unreadable by design (reported, not solved); a covered or clipped field still counts as visible; a hidden checkbox or select used as a trap is not judged;
  `press` can still focus a hidden field by ref (one key at a time; no guard yet); a frame a script injects after `inspect` is not listed until the next one.

## IMP-015 · 2026-10-03 · The team a task gets is decided by code and can be shown without running it: roster, plan validator, signals, offline composer, `roster` and `team --dry-run` (S3a part one; user: "we won't have constant numbers of 5 agents")
- **Problem:** the pipeline always runs the same five phases, and the run can only shrink (`SKIPPABLE_PHASES`); nothing can add a security reviewer for a change to authentication, and nothing can say in advance why a
  task gets five agents or twelve. Letting a model propose the team without a floor under it would let a task's own words (or a README) inflate the team, or talk the verifier and the gate away.
- **Why it matters:** the user's rule is that the number depends on the task; the threat model (G1 inflate, G2 shrink the floor, G3 injection through repository text, G7 cycles, G8 overlapping writers, G10 a project role file
  that redefines the gatekeeper) is only closed if the limits live in code that does not read the task as instructions.
- **Change (how):** `src/team/`. `roster.ts`: 19 built-in roles as data (kind, model alias, tools, write scope, skippable, per-role cap); your own roles from `~/.agent-loop/roster` (or `$AGENT_LOOP_HOME`), a project
  roster ignored until `--trust-project`, nothing can redefine a built-in role (V13). `plan.ts`: `validatePlan` (V1 to V8, V10 to V12, V15; V9 waits for the governor), `appendSteps`, `skipStep`, `auditDiffScope`; unknown
  fields refused, refusal text cut and stripped of control bytes. `signals.ts`: from the task's words and the PATHS in the repository, never the text of its files (G3); `transitiveImporters` for the post-build re-check
  (V14). `compose.ts`: the sizing guide as code (`composeOffline`), `finalizePlan` (the floor under any proposal: verifier per builder, mandatory reviewers, gatekeeper last, shrink to the cap cheapest first),
  `chooseFinal` (a refused proposal falls back to the offline plan), `composeForEach` (item cap is the user's), `parseComposerJson` (bounded, never evaluates). `scan.ts`: relative paths only, no links, bounded in
  depth and files, breadth first. `cli-commands.ts` and `src/cli.ts`: `agent-loop roster [--json]` and `agent-loop team "<task>" --dry-run [--cap n] [--json]` (exit 2 when no team fits the cap). Running a composed
  team is S3a part two; `team` without `--dry-run` says so and does nothing.
- **Measured:** two new suites, baselines recorded on `1845dc7`: `team-invariants` **500 of 500** (100 valid plans accepted, 400 mutants each refused for the rule they break) and `team-sizing` **28 of 28** (labelled
  tasks land in their size band with the mandatory roles; 0 oversized plans). Both baselines are full marks because the suites and the code were written together; what shows the suites can fail is the controls in
  `test/bench-suites.mjs` (a lenient validator scores 100 of 500, a strict one 28 of 28 sizing but 128 wrong-rule, a crashing one 100; a fixed-five composer misses 4 of 28, a smallest-possible one 4, a fourteen-builder
  one 0 but with 28 oversized plans counted). Tests: `team-roster`, `team-plan`, `team-signals`, `team-compose`, `team-cli`; **68 mutants on the data layer, 0 survivors; 40 on the CLI, scan and control-byte filters,
  39 killed and one equivalent** (a guard that only stops the directory walk early; the output cannot differ). Building it found: a default-parameter trap in a test helper (`undefined` takes the default, so "no roster"
  needed `null`); words with a slash (`async/await`, `client/server`) read as paths until a path had to look like one; a generator that produced plans over the cap and blamed the validator; and that the first control-byte
  test covered one byte class (C0) and one channel (text), which let C1 bytes (U+0080 to U+009F) into the plan's `brief` and a file NAME reach `--json` through the signals' paths.
- **Cost / trade-off:** a repository scan on every `team` call (at most 20,000 paths, eight levels); the offline composer is a heuristic, so some tasks get a team a person would size differently (`--cap` bounds it, a
  proposal from a model goes through the same checks, and the signals can only add a mandatory role, never remove one); user roles cannot write outside `tests`, `docs` or their own slice and cannot be gate or monitor
  roles, which rules out some legitimate custom roles.
- **Suites:** team-invariants, team-sizing
- **Skill impact:** SKILL-011 (lesson 27: a filter test names the byte classes and channels it covers).
- **Follow-ups:** S3a part two (the pipeline runs the plan: `--team auto|fixed5`, events with `stepId`, store columns, lineage identity, the variable-length stepper, Overseer append/split/skip/repair, diff-scope audit after
  each builder, V14 wiring, V7 enforced by the hook chain); an adversary round aimed at the validator; V9 with the S4 governor; the sizing labels are mine, so a second labeller would be a better test.

## IMP-016 · 2026-10-03 · Approval and path hooks judge what the tool will do, not what the text looks like (adversary round 2: A51, A27, A28, A29, A30, A44)
- **Problem:** a fresh-context adversary ran the real hook chain and found it let through, with no human asked: `sed '1e CMD'` and `sed w` (run a program, write any file), `rg --pre ./script`, `git remote set-url`, `git branch -d`,
  `sort -o`, a symlink inside `--dir` read through `cat outside/x`, and `cat {/etc/hostname,notes.txt}` (A51, critical: three proof files were created outside the directory by commands the hook approved). It also found that `~/x`
  was read as a directory called `~` inside `--dir` while the file tools expand it to the home directory (A27), a relative link to `.env` was judged from the wrong directory (A28), Glob's pattern was never looked at and the credential
  list knew only exact names (A29), and `git -C repo push --force` or `rm -rf /etc` passed under `--no-approval` (A30). Working on it showed the same class in `less '+!id'`, `printf -v PATH`, `ps eww` and `.git/config`
  (an auto-approved `git status` runs `core.fsmonitor` from it).
- **Why it matters:** the approval step is what the design leans on for `Bash` and the path hooks are what keep the file tools inside `--dir`; each was a check on the text of a command or path, and the tool that acts on it reads the
  text differently. For unattended runs (and the job-application flow) a steered model needs only one such line.
- **Change (how):** `src/readonly-shell.ts`: read-only is an allow-list of safe FORMS, not names (sed: a plain `p`, `d`, `q` or one `s///` whose flags are g p i I m M and digits; git: `status diff log show rev-parse ls-files`, `branch` and
  `remote` only to list, never `--output`, `--no-index`, `--ext-diff`, `--textconv`; no `--pre`, `-o`, `--output`, `--compress-program`, `-L`/`-R` link-following; every non-flag word, the pattern included, judged by its real location;
  `less` and `more` ask). `src/bash-analysis.ts`: the tokenizer marks unquoted glob, brace and tilde words unsafe (they ask), redirect targets the shell rewrites make the whole command ask, and paths are judged through
  `canonicalPath` (links followed). `src/path-canon.ts` (moved out of `hooks.ts`): `toolPath` expands `~` as the tools do and refuses `~user`, UNC, drive-relative, `%VAR%` and NUL; Glob patterns are checked (absolute, `..`, braces).
  `src/hooks.ts`: the sensitive-file hook takes `--dir`; the credential list is shapes (`.env.*` except `.env.example`, `*.pem`, `*.key`, `id_*`, `.docker`, `.kube`, `.gnupg`, `.agent-loop`, `.git`); git's global options are dropped before
  the safety patterns match and `rm` of any top-level directory is denied. Wired in `src/phases.ts`.
- **Measured:** two new suites, baselines taken on the unmodified build `f10a830`: `shell-readonly` **106 of 216 to 216 of 216** (110 attack rows ran without a prompt; 71 ordinary commands still run quietly, 0 newly asked) and
  `file-hooks` **65 of 242 to 242 of 242** (177 rows wrong). `test/bash-readonly.mjs`, `test/path-text.mjs`, `test/safety-rewrites.mjs` each failed on the old build at the first row. Mutation checks: **61 mutants on the read-only analysis,
  2 equivalent survivors** (`git --no-index` and `stat -L`: the real-location check already refuses everything they would add); **31 on the path and safety hooks, 1 equivalent** (a NUL byte: an unresolvable path is already denied).
  The harness's first run left eight "survivors" that were dead mutants (compiled text did not match) and five real test gaps (no row where sed names an outside file, git diff an outside path, a flag carries an attached path, a link is
  reached only by recursion, a brace sits in a flag), all closed by rows; two pieces of code the survivors showed to be redundant were deleted rather than kept.
- **Cost / trade-off:** commands with a glob, brace, variable or tilde now ask (`ls *.ts`, `cat $F`), as does any `sed` beyond the simple forms, `git diff --ext-diff`, and `less`; `git log main..feature` still runs quietly. Under `--no-approval`,
  `rm -rf /tmp/*` or `rm -rf /app` (a top-level directory, or all of one) is now denied outright. The file tools can no longer read or write `.git/**`, `.agent-loop/**`, `*.pem`, `*.key`, `.env.local` and similar, so a project that
  keeps a real key file in the tree must be worked on through the shell, with approval. A name like `a:b` is read as a drive form and refused. The safety net's `git branch -d` pattern is still case-insensitive and denies the safe lowercase form too (left alone, noted).
- **Suites:** shell-readonly, file-hooks
- **Skill impact:** SKILL-013 (lesson 28: judge what the tool will open or run, and run every tool against every form of its input).
- **Follow-ups:** the rest of round 2 (see `docs/adversary/round-02-triage.md`); Bash is still not scoped (a command that does ask can still write anywhere the person approves); expansion is judged, not performed (a glob asks instead of being expanded
  and checked); on Windows only the string forms are tested here.
