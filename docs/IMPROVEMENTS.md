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

## IMP-017 · 2026-10-07 · A page cannot end the run, hang it, hide a repeated failure, forge the tool's own text or get a typed password recorded (adversary round 2, batches 3 and 4: A39, A41, A21, A24, A26, A31, A37, A38, A42, A47, A50)
- **Problem:** the same adversary ran the S1 and S1b browser tools and the network gate against real Chromium and found: an upstream that answers `HTTP/1.1 099` made the gate throw inside its response callback and end the process (A39); three popups that
  open and close themselves, with video on, made a request callback reject after its page had gone and Node 22 ended the whole process, leaving the browser running and the run "running" in the database (A41, high); a failure that happened again
  was never reported again, so the click that failed after a "fix" and the verifier's reload of a failing page heard nothing (A21, high); `notices` could not list what a result had left out (A50); a field further down a scrolling dialog was
  refused as a bot trap, 17 of 30 questions of a real-looking form (A24); a page of 100,100 elements answered "(none)" with no note and `inspect` with a query missed the 98th button (A26, A47); a page could print a copy of the tool's own blocks
  and terminal escapes into the result (A37); a 3 MB title and a 1.5 MB query string cost megabytes of context and carried a token (A38); a typed password went into the event stream and the audit database (A42); and a page stuck in a loop made
  every tool wait for ever (A31).
- **Why it matters:** the browser is the one part of the product that reads text written by strangers and runs unattended; each of these either ends or blinds the run, or puts a secret where it is kept for good. The job-application flow (S5) leans
  on exactly these properties: a diff of the filled form needs a reader that says what it could not read, and a long unattended run needs a process a page cannot kill.
- **Change (how):** `src/net-gate.ts`: an upstream status outside 100 to 999 is a 502, and writing the response cannot throw. `src/browser-tools.ts`: the route callback and the WebSocket close cannot reject; a session holds at most 10 tabs open and
  60 in all (the rest are closed on arrival, counted, and `list_tabs` says so); a repeat of a delivered notice is undelivered again and goes to the end of the order (`x2, 1 since you last looked`; the bus hears 2, 10 and 100) and `notices` lists the
  unseen first with a head that says how many are left; reachability is judged through scrollable ancestors; the element scan reports its 100,000 cap and the `text` tool its notes; a query filters up to 600 candidates inside the page before the
  60-ref budget; page text is stripped of control, bidi and zero-width characters, fenced between `<<<` and `>>>`, and lines that start like a block of the tool are prefixed `(page text)`; one `displayUrl` shows no query or fragment, titles are cut at 200;
  `fill` and `press` record a value only for a field that was checked and is not a secret (type, `autocomplete` hint or name); every tool races a 60 s deadline, opens a fresh tab when it fires and `list_tabs` bounds each title. `src/fatal.ts`
  (wired in `src/cli.ts`): an uncaught exception or unhandled rejection stops the run through the ordinary path (saved as stopped with the reason, report written) and quits only if that does not finish in 15 s or a second one arrives.
  `bench/suites/browser-honesty.mjs` is new: eleven checks through the real tool handlers, three of them (hung page, popup storm, bad status) in a child with a time limit where a timeout counts as a failure.
- **Measured:** the new suite `browser-honesty`, baseline taken on the unmodified build `ecc83f2` in a scratch worktree: **0 of 11 to 11 of 11** (old build 0 of 11 in five runs, new 11 of 11 in five). Tests that failed on the old build: `test/fatal.mjs` section 5 (the run
  stayed "running"), `test/browser-popup-storm.mjs` (the process died in 3 of 3 runs; the first version of the scenario, three popups with one request each, killed it about one run in three and the first benchmark score said the check passed, so the
  scenario was made harsher: ten popups with eight requests each, five runs of six; thirty, six of six), `test/browser-hang.mjs` (the old build never returns), the A39 block of `test/net-gate.mjs`, and sections 15 to 22 of `test/browser-observability.mjs`. Mutation
  checks on the built files, one change per mutant: **66 mutants, 16 in the first pass, all accounted for, 0 now survivors**: 8 were test gaps, closed by new assertions and killed on rerun (the order of a repeat and the bus counts at 10 and 100, the head's count of unseen entries, the 200-character URL cap, a panel of no size, autocomplete hints, and the stripping of bidi and zero-width characters, the last because the forging page was served without a charset, so its bidi characters reached the browser as ordinary text and the old test had never exercised the stripping); 1 was a redundant line, deleted (`run.catch`: Promise.race keeps a handler on the call, so a call given up on that fails later is not an unhandled rejection); 5 are redundant layers in the gate (each of the four checks on the upstream status, and the try/catch around `writeHead`, alone is enough, so removing one never changes the answer; a mutant that removes both is killed); 1 is an equivalent mutant, argued and not testable (the scroll-ancestor test `scrollHeight > clientHeight`: treating a container that cannot scroll as a scroller reaches the same answer through the recursion); 1 is a guard no scenario I could build exercises (the `.catch` on the blocked-WebSocket close; kept).
- **Cost / trade-off:** a page's query string and fragment are no longer visible in `inspect` (a page that keeps state there is harder to debug); a tool call that takes longer than 60 s is cut off (the longest legitimate one, `wait`, is 30 s); popups beyond 60 in
  a session are closed; a line of page text that starts with `Title:` or `URL:` gets a `(page text)` prefix; a value typed into a field whose name looks secret is not in the audit trail (that is the point, and `fill` into a field that could not be
  checked is not recorded either); a `uncaughtException` handler means a bug in agent-loop itself now ends a run as "stopped" rather than a crash with a stack trace (the trace is printed first).
- **Suites:** browser-honesty, observability
- **Skill impact:** SKILL-014 (lesson 29: measure a failure that kills or hangs a process on the old code many times, run it in a child, count a timeout as a failure) and SKILL-013 for the class of the previous batch.
- **Follow-ups:** A26 part 2 (closed roots on ordinary elements) and A25 (the wider honeypot recipes) with S5, A22 (run the reader where the page cannot reach it) before S5, A42's refusal of a password field in LIVE mode with S2, a byte cap per string field in
  `emitEvent` for every event type (A38 covers the browser's own events only), A23/A45 with S4. Left deliberately: the WebSocket-close guard is not exercised by any scenario I could build (it never rejected in twelve runs of up to 40 popups with 30 blocked sockets each).

## IMP-018 · 2026-10-07 · The save command checks what it saves, the baseline log binds a reason to its change, the benchmark is measured again by its own test, and its scorers stop accepting the page's own source (adversary round 2, batch 5: A32, A33, A35, A36, A48; A34 is Dev-Skill SKILL-015)
- **Problem:** `checkpoint` staged everything and pushed with no check that a secret scanner was installed: in a fresh clone (the recovery CLAUDE.md prescribes) a `.env.local` and a browser cookie file reached the remote (A32); it pushed whatever branch
  was checked out and treated any repository above `agent-loop/` as "Dev-Skill" (A33). Any row of the benchmark's "Definition changes" table that mentioned a suite and the word "baseline" excused every later change to that suite's baseline, to any value
  (A35). Three of the eight observability tokens, and the closed-shadow check of form-coverage, were in the page's own source, so a tool set that only echoed the HTML scored 4 of 8 and 1 of 8; `adversary-yield` read a rising count of findings as "worse" and
  an empty round as best (A36). Nothing re-measured the benchmark: a change that lowered a score left the table, its test and CI green for up to 25 commits (A48).
- **Why it matters:** `checkpoint` exists for the moment nobody is watching, the baseline log is the evidence behind every "from X to Y" in these documents, and the benchmark is the stated proof of IMP-006 to IMP-017.
- **Change (how):** `scripts/checkpoint.mjs` runs the repository's own `.githooks/check_staged.py --mode=commit` after staging (no scanner: `scanner-missing`, nothing committed; blocked: unstaged and `commit-blocked`), pushes only the designated branch
  (agent-loop `main`, Dev-Skill `claude/dev-workflow-process-v4kafr`, `--allow-branch <repo>=<branch>` to override) and only to the expected origin, and lists what it staged; `.gitignore` covers `.env.*` (not `.env.example`), keys, certificates, `Cookies`,
  `Login Data`, `*.sqlite` and `.agent-loop/`. `bench/baseline-check.mjs` walks the whole committed history of `baseline.json`: every change needs an unused row naming the suite, "baseline", and the old and the new value. `test/bench-table.mjs` runs
  every suite and compares with `latest.json` (full marks stay full marks; shell-readonly's row count differs on Windows, declared as `maxVariesOn`). The observability tokens are built at run time in the pages, the closed-shadow check is anchored to the
  tool's sentence, the full source of every probe page is an echo control in `test/bench-suites.mjs`, and `adversary-yield` is tracked, not scored (`higherIsBetter: null`), with each round's triage numbers in its detail.
- **Measured:** `test/checkpoint.mjs` six cases to eleven; the first new case fails on the old script (it saved a repository with no scanner). Mutation checks: **29 mutants on the script and `.gitignore`, 0 survivors** (one survivor, an origin pattern that
  accepted any repository of the same owner, closed by a row); **14 on the baseline check, 0 survivors** (four first survivors closed by rows: use-once, the right numbers in a row for another suite, in a row that never says baseline, a change and its reverse);
  the new integrity test fails on the old check at A35's reproduction. A48's own reproduction (the reader set to read no frames) now fails `test:bench-table` with "form-coverage: latest.json says 8/8 and this checkout measures 5/8" and the three checks it lost. Scorers: the old ones passed 4 of 8 (observability) and 1 of 8 (form-coverage) on the echoed source of the probe pages; the new ones pass 1 of 8 (long-text, which really reads the text)
  and 0 of 8. The baselines did not move: scored on the commits where they were taken with the new scorers, observability is still 0 of 8 at `7138e1b` and form-coverage 1 of 8 at `646cdcb`.
- **Found by CI, not by the local suite:** the first push (`fe92cb0`) was green on Linux and macOS and failed `test:bench-table` on Windows only: the three child scripts of `browser-honesty` imported the build by an absolute Windows path (not an import specifier) and `file-hooks` has one row fewer where a symlink cannot be made. Fixed in `2df56d3` (file URLs, `maxVariesOn: "win32"`, a source-level control); CI green on all three systems after it.
- **Cost / trade-off:** `checkpoint` refuses in a repository without `.githooks/check_staged.py` and in a checkout on any other branch (the way out is named in its message); `npm run test:bench-table` takes about a minute and a half instead of a second, because it runs
  every suite including the three that need Chromium; a legitimate baseline change now needs a row that names both numbers.
- **Suites:** observability, form-coverage, adversary-yield, browser-honesty
- **Skill impact:** SKILL-015 (the compaction redactor) and SKILL-016 (the scanner's copies are compared); SELF-HEALING gained six rows.
- **Follow-ups:** whether to keep committing compaction summaries to a public repository (the user's decision; the redactor is fixed and the newest summary is kept out of commits until then); `test:bench-table` now measures every suite on all three systems (CI-confirmed at `2df56d3`); the PR gate workflow of the Dev-Skill repository does not run the scanner-copies test.

## IMP-019 · 2026-10-07 · A browser call the browser drops is asked again (reads) or reported plainly (actions), and the storm test waits for the page, not the clock (found by the full suite on 790771e)
- **Problem:** the full local suite on `790771e` failed twice with one cause: `test:browser-popup-storm` (run 1 of 30 popups: the tools "no longer answer afterwards") and, through the benchmark, `test:bench-table` (`browser-honesty` measured 10 of 11, `popup-storm-survives`).
  Reproduced under CPU load (four busy loops): `inspect` right after a 30-popup storm returned `Error: frame.evaluateHandle: Resulting promise was garbage collected.` in 4 of 6 runs (and 4 of 8 in an earlier probe; 0 of 8 on an idle machine). Chromium drops a call it is running when the page is busy
  or changing; the next call works. Two things were wrong: the test waited a fixed 2 s for a storm that a busy machine stretches to much longer, so `inspect` ran in the middle of it; and the product passed the browser's wording to the agent, which cannot act on it (and `text` turned a
  dropped read into "the page has 0 characters", a false statement).
- **Why it matters:** the agent that reads this error cannot tell "the page is broken" from "ask again"; a run meant to go unattended would give up or act on nothing. The benchmark stated 11 of 11 and the full suite could not reproduce it on a loaded machine.
- **Change (how):** `src/browser-tools.ts`: `instrumented()` asks a read-only tool (`inspect`, `text`, `notices`, `list_tabs`, `screenshot`) once more when the call was dropped; an action (click, fill, press, scroll...) is never repeated, because the dropped call may have happened.
  A drop that still fails says so: for a read "dropped twice because the page was busy or changing ... Nothing was changed. Wait a moment and call inspect again"; for an action "may or may not have happened. Call inspect to see the page before deciding whether to do it again".
  `text` no longer swallows a drop into an empty page. `test/browser-popup-storm.mjs` and the `popups` child of `bench/suites/browser-honesty.mjs` wait until the page's own script reports that the storm is over (a request to `/done`), then half a second.
- **Measured:** `test/browser-dropped-call.mjs` (new, six sections; the real page's call is made to fail the way the browser does, once or always): fails on the old build at its first assertion (the raw error reaches the agent), passes on the new one, run twice; **11 mutants on the retry, the read-only set, the matching and both messages, 0 survivors**
  (a retry of every tool is caught by the click that was tried twice; a second retry by the call count). Same load probe on the new build: the first `inspect` answered in 5 of 6 runs (the retry), and in the sixth said plainly that it was dropped twice (the next call answered); before: 4 of 6 raw errors. `test:browser-popup-storm` passed 3 of 3 runs under the same load (about 90 s each). The
  benchmark's `browser-honesty` scored on the old build (`ecc83f2`) is still 0 of 11 and on this tree 11 of 11, so the baseline did not move; the check's wait changed, not its scenario.
- **Cost / trade-off:** a read that fails because of a drop takes one more call (seconds, when the machine is that busy); `test:browser-popup-storm` now takes as long as the storm takes (about a minute on an idle machine, 85 to 93 s on a loaded one) instead of a fixed 2 s per run; a read dropped twice still reaches the agent as an error, with advice.
- **Suites:** browser-honesty
- **Skill impact:** SKILL-017 (a wait in a test is on a signal from the thing waited for, not on a clock; a test that passes on an idle machine is measured under load before it is called stable); SELF-HEALING rows (part B: the browser dropped a call; part C: a fixed sleep for work whose length depends on load).
- **Follow-ups:** `list_tabs` still turns a tab that does not answer its title into "(not responding)" by design (A31); the promise-collected error was seen on `evaluateHandle` and `evaluate` only, not on actions, so the action message is written from the browser's contract, not from an observed case.

## IMP-020 · 2026-10-07 · A unit of work is (item, step, attempt): two builders, a security reviewer and a job's step are separate nodes, and an old database opens unchanged (S3a part two, increment 2.1; adversary A3)
- **Problem:** the lineage keyed a node by `phase#attempt` and dropped every phase that was not one of the five built-in names, so two builders collapsed into one node and an integrator or a security reviewer vanished from the tree: a failing mandatory review was not shown
  (reproduced in round 1, A3). The store had no column for a step, so the insights counted a role's attempts across steps as one unit, and the item flows planned for the job-application stage (the same step run for many jobs) had nowhere to put a job id.
- **Why it matters:** the team composer and the plan validator (IMP-015) can already produce plans with several steps of one role and roles that are not built in; the moment the pipeline runs such a plan, every consumer (the tree, the "made by" table, the files list, the insights, the roast) would have misreported it. The identity decision has to exist before the pipeline is wired to it, not after.
- **Change (how):** `src/types.ts`: `PhaseName` widens to a role id string (`BuiltinPhase` keeps the five names); a `StepRef` (`stepId`, `role`, `item`, all optional) rides on `phase-start`, `phase-end` and `overseer-decision`; a `team-plan` event type exists (nothing emits it yet).
  `src/lineage.ts`: a node is keyed by `item|stepId` (or the role when the event names no step, so every old event reads as before); ids are `s3#1`, `job-17:s3#1`, or `builder#1` for old runs; a role is any lowercase role id, but a role that is not built in is a step only when its event names one;
  a step id is `[a-z0-9._-]{1,31}`, an item is cleaned and cut at 80 characters, anything else is ignored; an event that names no step goes to the step in progress when it is of that role, else to the latest step of the role; a repair may name a step id or a role; the "made by" rows, the order and the lanes follow
  the plan's own order (the order steps were first reached), not the five-name list. `src/store.ts`: columns `step_id`, `role`, `item` added to `phases` on open (`ALTER TABLE` only when missing; old rows untouched and read as role = name), `startPhase` takes a `StepRef`, `getPhaseSummaries` returns it, and both insight queries count a unit as
  `(run, item, step, name)`. `src/overseer.ts`: the bound on where a repair may go is a pure function, `boundRepairTarget(target, current, order)`, over the plan's step ids or the five built-in names; `overseerDecide` takes the order as an option (nothing passes one until 2.2b).
- **Measured:** `test/team-identity.mjs` (new, six sections, real builder and real store, no API): on the build before this change it fails at its first assertion (the nodes of the team plan are `planner#1, builder#1, builder#2`, not six distinct steps), on this one it passes, run twice. Sections: two builders + an integrator + a failing security reviewer; old events (no step id) build the same tree
  and a late event stays with its role; events that name a step go to that step; an item flow (the same step for two items is two nodes and two rows); hostile ids (control and bidi bytes, 300 characters, a role like `Builder; DROP`, a bare non-built-in role); the store (an old database opens unchanged, a step and an item are stored and read back, insights and habits count units, a second open is quiet); the repair bound.
  **41 mutants, 3 survivors:** two are equivalent (a repair target equal to the current step falls back to the same value either way; the `typeof` guard in front of `indexOf`, which returns -1 for a non-string anyway) and one is the unexercised call-site line `opts.order ?? PHASES` (increment 2.2b passes a real plan's order and tests it through a team run). Eleven first survivors in the lineage and the store were closed with assertions (hostile role with a valid step id, a 300-character step id, retry versus hand-off for two steps of one role,
  a late event in a team run, an event naming a step while another of the role runs, the item on the "made by" rows, an item stored, the habits' count). `lineage`, `ui-lineage`, `persona`, `insights`, `roast`, `plumbing`, `stop`, `stop-e2e`, `ui-stop`, `bus-history`, `team-plan`, `team-compose` and `team-roster` pass unchanged.
- **Cost / trade-off:** three more columns on `phases` and an `ALTER TABLE` on first open of an old database (idempotent, tested); a node lookup by key map instead of by role; an event with a role that is not built in and no step id is still not a node (as before: no run emitted one).
- **Suites:** none
- **Skill impact:** none new: the old-database test and the old-events case are the existing rule that a change must not break what was written before it, applied.
- **Follow-ups:** 2.2a role specs and the write-scope hook, 2.2b the plan-driven pipeline loop (`--team`, the `team-plan` event, repair by step id, V14 re-check, the planner skipping a step), 2.2c the variable-length stepper and the terminal and persona for unknown roles, 2.2d the benchmark rows, the mutation check on the whole stage and the adversary round.

## IMP-021 · 2026-10-07 · A team step gets its tools, words, browser and write scope from its role's definition, and the file tools are judged against that scope at the moment of the write (S3a part two, increment 2.2a; V7, V8, adversary A16)
- **Problem:** the roster (IMP-015) says what each of the 19 roles may use and where it may write, but nothing enforced it: `runPhase` only knew the five hand-written phase specs, so a step of any other role (a security reviewer, an integrator, a role from the user's own roster) could not run at all, and V7 ("read-only roles receive only read tools") and V8 ("a slice owns its directory") were data, not behaviour.
  A checker's browser was the full browser, so a "verifier" could click, fill and submit the thing it was verifying (A16, the checker is not its builder's context).
- **Why it matters:** the team composer can already produce plans the pipeline cannot run safely; the rules that make a team more than five agents with different names are the ones that hold when a step does something its role was not meant to do. They have to be code, below the model, before the pipeline loop (2.2b) is wired to them.
- **Change (how):** `src/team/role-spec.ts`: `roleSpec(role, step)` derives the SDK tools from the role's classes (`read` gives Read, Glob, Grep; `run` gives Bash; a write scope gives Write and Edit; the `web` class grants **nothing** until LIVE mode has a gate for it), what is auto-approved (the read tools it has), browser access (`none`, `read`, `full`), the desktop window,
  and the words: why the role is on the team, the kind's duty (a reader changes nothing, a checker is not the builder and fixes nothing), the real tool list, the slice, what is checked, the verdict instructions. A step's brief and a role file's instructions are data: control bytes removed, `<<<` and `>>>` runs broken, cut (600 and 4000 characters), fenced, and labelled as not being instructions about tools. Meta and monitor roles get nothing.
  `src/team/write-scope.ts`: `createWriteScopeHook` judges Write, Edit, MultiEdit and NotebookEdit by where the path really is (links followed, `..` applied to the real directory, case and Unicode folded, a name that only shares a prefix is outside, `.git` and `node_modules` never): none refuses everything, `slice` the step's directories (not the shared files), `tests` test directories and test-named files, `docs` README, CHANGELOG and `docs/`, `shared` the manifests, lockfiles and generated output plus every slice; a backslash in a path is refused off Windows because the path resolver and the file system read it differently.
  `src/team/plan.ts` exports the one definition of "inside a slice" that the diff audit and the hook now share (`scopeTarget`, `insidePrefixes`, `slicePrefixes`, `reservedReason`); `auditDiffScope` is behaviourally unchanged (the team suites and both benchmarks pass as before). `src/browser-tools.ts`: a `readOnly` option registers the browser without `click`, `fill`, `press`, `select_option` and `click_at`. `src/phases.ts`: `runPhase` takes `team: { role, step, allPrefixes }`;
  with it the spec, tools, browser and desktop access come from `roleSpec` and the write-scope hook joins the chain; without it the five built-in phases run exactly as before. The verdict text moved to `src/team/verdict-text.ts` (diffed: identical). The fake SDK can now run scripted tool calls through the hooks a caller registered (`FAKE_TOOL_CALLS`), off unless set.
- **Measured:** four new suites, each run twice and failing on the build before the change where there is a before (`test:team-run-phase` fails at its first assertion on `bfbccdc`; the others test modules that did not exist): `team-write-scope` (every scope, every spelling of a path outside it, links, reserved files, control bytes, the hook's four tools and its refusal wording), `team-role-spec` (16 built-in roles, hostile roles and briefs, meta and monitor), `team-browser-readonly` (13 of 18 tools registered; every tool classified as acting or looking), `team-run-phase` (the real `runPhase` and hook chain: a builder's slice, a reader with no write tool, the integrator, the browser and desktop by role, auto-approval, and the five built-in phases untouched with four hooks).
  **Mutation checks, each with an unmutated control that must pass first:** write scope 33 mutants, 0 survivors; role spec 31, 0; the `runPhase` wiring 19, 0; the read-only browser 10, 0. Survivors on the way were closed with assertions (a read-only role told it may write, the project root as a target, a `tests` scope reaching `test/package.json`, an unanchored README pattern, the wording of each refusal) or deleted as redundant (a `Set` over a list that cannot repeat, a step argument passed twice).
- **A mistake worth recording:** the first mutation run of the role spec reported 0 survivors while the test was failing on the unmutated build, so every mutant "died" of the same failure. Every mutation script now runs the unmutated copy first and stops if it fails; that also showed an older "kill" in IMP-020 (a mutant killed by `lineage`) had been vacuous because the copy lacked `ui/`: re-run with the fix, it survived, and a case was added that kills it.
- **Cost / trade-off:** one more hook in the chain for a team step (a path resolution per file-writing call); a read-only role writes no files, so what it found goes in its verdict and the pipeline writes the report (2.2b); the `web` class grants no tool, so a role that needs the web waits for S2; Bash is not judged by this hook (a shell redirect is outside it): the diff audit after the step is what closes that, and is part of 2.2b; the Windows reading of backslashes is tested only by CI.
- **Suites:** none
- **Skill impact:** SELF-HEALING gained a row (a mutation run whose base test already fails); the dev-workflow mutation guidance should carry the same control (SKILL-018 in the Dev-Skill log).
- **Follow-ups:** 2.2b the plan-driven pipeline loop (`--team auto|fixed5|<file>`, the `team-plan` event, reports written from verdicts, repair by step id, the diff audit and V14 after each builder, the planner skipping a step), 2.2c the variable-length stepper and the terminal and persona for unknown roles, 2.2d benchmark rows, a mutation check of the whole stage and an adversary round (a new agent). The real-SDK tests (`browser-real-sdk`, `stop-real`) are opt-in and were not run: that the real SDK honours a smaller `tools` list and a hook chain with five hooks is read from the same mechanism the five built-in phases already use.

## IMP-022 · 2026-10-07 · A composed team runs: steps in plan order with their own roles, repair by step id, reports for the steps after, and a diff audit that closes Bash (S3a part two, increment 2.2b part 1; V7, V8, G8)
- **Problem:** IMP-020 gave a team step an identity and IMP-021 gave it tools, a scope and a hook, but nothing ran a plan: `runPipeline` only knew the five phases in a fixed order, so the composer's plans, the validator and the write-scope hook had no loop to live in. Two things the five-phase loop never needed were missing as well: a read-only role writes no file, so
  a planner's plan or a reviewer's findings had nowhere to go for the steps after it; and the file-tool hook cannot see what a shell command does, so a builder could write outside its slice with `cp` or a redirect and nothing would notice (V8's diff audit, G8).
- **Why it matters:** a team that cannot run is a design; a team that runs without the audit is five agents with different names and the same ability to wander. This is the piece that makes the rules hold in a run.
- **Change (how):** `src/team/run-plan.ts`, `runTeamPlan`: the plan is validated again (the authority is the engine, not the caller) and a plan that fails runs no step and calls no model; the steps run in the validated order (a step after the ones it needs), each through `runPhase` with its role's spec; events and store rows carry the step id, role and item, and `team-plan` comes first.
  The Overseer has a team prompt that lists the plan and takes a step id for a repair (`boundRepairTarget` bounds it; a target not named at all goes to the step a checker checks, an invalid one to the same step); only a pass is continued past; repairs are bounded per step and per run; a stop or the cost cap ends the run as "stopped" before the next step and the next Overseer call. A step's `report` (its verdict's new, cleaned, 20,000-character field)
  is saved to `team-reports/<step id>.md` (never through a link that leads out) and named in the history the next steps see. `src/team/changes.ts`: before and after every step the project tree is snapshotted (content hashes, links read as links, derived directories left out, a limit of 20,000 files that is configurable), and `auditStepChanges` fails a step that changed what its role may not: a scoped role is held to the same rule as the write-scope hook,
  a read-only role may change nothing that existed (a new file is only a concern, because checkers run tests), and a tree too large to compare fails every step. `PipelineConfig.team` selects the engine; without it the five-phase loop is untouched (the whitespace-insensitive diff of `pipeline.ts` is six added lines). `parseVerdict` is exported and team-aware; the role spec tells a team step to put its document in `report`.
- **Measured:** three new suites. `test:team-pipeline` (16 scenarios: a clean seven-step run, repair by step id, bad targets, a shell write outside a slice, a read-only step that tampers, budgets and stops, a refused plan, a plan written out of order, a watchdog step, DECISIONS.md, an Overseer or step failure, a stop between steps, a report through a link, a tree over the limit, and the five-phase path unchanged) fails on `56746ad`'s build at its first assertion and passes on this one, run twice;
  `test:team-changes` (8 sections, including a same-size same-time edit, links, mode bits, a snapshot cut short, an unreadable directory) and `test:team-verdict` (4 sections). **Mutation checks, each with an unmutated control that must pass first:** the engine 43 mutants (including 3 that remove two layers at once), 40 killed and 3 survivors, all three redundant layers proven so by the combined mutants (the post-step stop check and the Overseer's abort path, the engine's and the Overseer's repair bound, the engine's and the Overseer's "no target named" default);
  the tree snapshot 26, 0 survivors (run as an unprivileged user, so the permission case is real); the verdict parser 14, 0 survivors. Closed on the way: a snapshot limit that could not be set (so "too large to audit" was untested), the Overseer's own "no target named" default (the engine's was unreachable until it moved there), a repair-budget off-by-one and the order of a plan written out of sequence.
- **Cost / trade-off:** two walks of the project tree per step (hashing files up to 1 MB), so a big repository pays for it (the limit of 20,000 files fails closed instead); a checker that writes a new results file gets a concern in its verdict, a checker that changes an existing file fails; derived directories (`dist`, `build`, `node_modules`, `.git`, caches) are not audited, so a shell write into `dist/` is not seen; a repair re-runs every step after its target, including independent ones (the five-phase loop does the same); reports are files in the project (`team-reports/`), like `PLAN.md` before them.
- **Suites:** none
- **Skill impact:** none new (the mutation control of SKILL-018 was used throughout).
- **Follow-ups:** 2.2b part 2: the `--team auto|fixed5|<file>` command line and the composer call that makes the plan, the planner skipping a step (`suggestedSkip` is parsed; the engine does not act on it yet), the Overseer's append and split (bounded), V14's re-check of the real diff, repair by the owner of the files named in a finding; 2.2c the variable-length stepper and the terminal and persona for unknown roles; 2.2d the benchmark rows, a mutation check of the whole stage and an adversary round. The real-SDK tests were not run; the engine was run only against the fake SDK.

## IMP-023 · 2026-10-07 · `agent-loop run --team auto|fixed5|<plan file>` chooses who does the work, and a bad choice ends the command before anything starts (S3a part two, increment 2.2b part 2a)
- **Problem:** IMP-022 built an engine that runs a composed team, but nothing a person could type reached it: `runPipeline` took a `team` in code only, the composer's plans were something `agent-loop team --dry-run` printed and the run never used, and a plan somebody wrote by hand had no way in. `agent-loop team "<task>"` without `--dry-run` told the user that running a team "comes later".
- **Why it matters:** until the command line reaches the engine, none of the rules of IMP-020 to IMP-022 (a step's own tools, the write scope at the moment of the write, the diff audit that closes Bash) apply to a real run. The option also has to fail the right way: a typo in a flag or a plan that cannot be repaired must stop before a data directory, a database or a model call exists, not half-way into a run that costs money.
- **Change (how):** `src/team/cli-run.ts`, `resolveTeamOption(args, {task, workDir})`, returns data and never exits (the tests call it; `cli.ts` prints and exits). No flag and `fixed5` change nothing at all. `auto` runs the offline composer on the task and on the **paths** in `--dir` (never the text of the files), with the roster of built-in roles, the user's own and (only with `--trust-project`) the project's;
  a file is a plan somebody wrote: it goes through `finalizePlan`, the same floor and the same validator as any proposal (a missing verifier or gatekeeper is added and the change is printed, a plan that cannot be repaired is refused with the rule that failed), and it is never silently replaced by another. A flag with no value, a `--cap` that is not a whole number from 1 to 50, a path that is not a file, over 200,000 bytes, unreadable, not JSON or not an object is exit code 1 with a message that names the flag and the cleaned file name;
  a plan the validator refuses (or no team that fits `--cap`) is exit code 2. The summary line (`Team (auto): 7 steps: s1 planner, s2 builder (api), ...`), the changes the code made and the repair budget are printed before the run. The budget grows with the team (`max(20, 3 per step)`; the five-phase default of 20 is kept as a floor) unless `--max-repairs` says otherwise. `cli.ts` calls it right after the work directory exists and before the data directory is resolved; `loadTeamRoster` is the one roster loader for `roster`, `team` and `run`.
  `agent-loop team "<task>"` without `--dry-run` now says how to run one (`agent-loop run "<task>" --team auto`). The default stays `fixed5`: flipping it to `auto` waits for the team-versus-fixed measurement in S7.
- **Measured:** `test:team-run-cli` (6 sections, 185 lines, run twice) passes on this build and cannot load on `a1da2ae`'s build (the module does not exist there). Its last section drives the real command line with the fake SDK: `--team auto` leaves a stored run whose phases carry step ids, `--team fixed5` runs the five phases as before, and a bad plan file leaves no database behind.
  **Mutation check, with an unmutated control that passes first:** 28 mutants, 28 killed, 0 survivors, after a first pass that left 7 survivors, each closed by an assertion and killed on the rerun (the cap's upper and lower bound and a cap that is not whole, repository paths not given to the composer, a directory accepted as a plan, a usage error reported as a refusal, and the repair budget ignored).
- **Cost / trade-off:** `auto` is opt-in, so a run that does not ask for it is byte-for-byte the five-phase run; with it a repository's file paths are scanned once before the run (bounded, paths only). A composed team's repair budget is higher than the five-phase default, so a team that keeps failing spends more before it stops (the cost cap still ends it). A hand-written plan is held to the same rules as the composer's, so a plan the validator cannot repair is refused instead of being run in a weaker form. Nothing here has run against the real SDK: the whole path is tested with the fake one.
- **Suites:** none
- **Skill impact:** none new.
- **Follow-ups:** 2.2b part 2b: the planner skipping a step (`suggestedSkip` is parsed; the engine does not act on it yet), the Overseer's bounded append and split, V14's re-check of the real diff after the builders, repair by the owner of the files a finding names; 2.2c the variable-length stepper and the terminal and persona for unknown roles; 2.2d the benchmark rows, a mutation check of the whole stage and an adversary round with a new agent; S7 decides when `auto` becomes the default.

## IMP-024 · 2026-10-07 · The planner of a team can skip steps that have not run, through the same V12 rule as any skip, and every refusal is said (S3a part two, increment 2.2b part 2b-1; V12)
- **Problem:** the team engine (IMP-022) parsed the planner's `suggestedSkip` and then did nothing with it: a plan that marks a step skippable ("an advisor, in case the task is irreversible") always ran it, so a planner that judged the step pointless for this task could only be ignored, and the five-phase loop's "trivial task, skip the test designer" had no counterpart in a team. The pure rule (`skipStep`, V12) existed and was tested, but nothing called it from a run.
- **Why it matters:** the point of composing a team is that its size follows the task. The composer guesses from the task's words and the repository's paths; the planner has read the code. Letting the planner trim what the composer over-planned saves model calls, but only if the trim cannot reach what must stay: a builder, a verifier, the gatekeeper, a reviewer a signal made mandatory.
- **Change (how):** `src/team/run-plan.ts`, `judgeSkips(plan, pending, roles, reason, ctx)`: pure. Each role the planner names is looked for among the steps that have not run (after the planner in the plan's order); each one found goes through `skipStep`, so the rules are V12's and not a second copy: a role that can never be skipped, a role a signal made mandatory, a step the plan did not mark as skippable, a candidate plan that no longer validates are all refused. A name with no waiting step (a role that already ran, was already skipped, or is not on the team) is refused with that sentence. It returns the plan without the skipped steps (whatever waited for one now waits for what it waited for) and one line per refusal.
  The engine asks only when the step that just finished is the planner **and** the run goes on past it (a failing planner's suggestion is never acted on, a step that is not the planner has no say). The judgement is added to the Overseer's recorded decision (`skipping s2 (advisor) on the planner's suggestion`, `skip refused: gatekeeper: gatekeeper can never be skipped | ...`, bounded to 600 characters). A skipped step is recorded like any step (store row and `phase-start`/`phase-end` with its step id and role, attempt 1, headline "Skipped", the asker in its details) and costs no model call; it is taken out of the order the run follows and out of what the Overseer is told about the plan.
  The engine also now validates its plan with the roles a signal made mandatory (`PipelineConfig.team.required`, set by `--team` from the task's signals), so a plan missing one is refused before any step runs (V4), and a skip of one is refused (V12). The fake SDK gained `FAKE_SUGGESTED_SKIP` (a map from role to the roles it suggests skipping) so the engine can be driven without a model.
- **Measured:** `test:team-pipeline` grows from 8 to 15 sections (planner skip, every refusal, who may ask and when, several steps of one role, a step that ran before the planner, a bounded refusal note, V4 at the start and the pure judgement); the new sections fail on `a035a87`'s build at their first assertion and pass on this one, run twice. `test:team-run-cli` checks that a security task's mandatory role travels with the team and that a read-only task has none (fails on `a035a87`'s build, passes now).
  **Mutation check, with an unmutated control that passes first:** 31 mutants of the engine's skip handling, 30 killed, 1 survivor: the engine's own copy of the plan (`plan = judged.plan`) is not read by anything yet, because every validator rule is monotone under removal and the pending steps are taken from the run's order; it is kept for the next increment (the Overseer's append and split validate against the current plan) and the test that kills it comes with that increment. Closed on the way, each by a new assertion: a decision that announced a skip on a repair, a step that had already run being "skipped" into the record, an unbounded refusal note, a role named twice, the asker missing from the record, the `required` roles missing from the first validation. Two lines were deleted as redundant: a 300-character cut that `skipStep` already makes, and a rebuild of the step lookup that nothing read.
- **Cost / trade-off:** the planner now has a say, within what the plan marked skippable and what no signal made mandatory; a planner that is wrong about a skip costs the team an opinion it should have had (the verifier and the gatekeeper are never skippable, so the check on the work stays). A suggestion that cannot be applied is noted in the decision and ignored, never an error. The skipped step stays visible in the record as skipped. A plan file that marks a step skippable that the composer would not have is honoured (the plan is the user's).
- **Suites:** none
- **Skill impact:** none new.
- **Follow-ups:** 2.2b part 2b-2: the Overseer's bounded append (V11, at most 4 steps in all) and split (once), V14's re-check of the real diff after the builders, repair by the owner of the files a finding names; 2.2c the variable-length stepper and the terminal and persona for unknown roles; 2.2d the benchmark rows, a mutation check of the whole stage and an adversary round with a new agent. Not run against the real SDK.

## IMP-025 · 2026-10-07 · An `--import` with an absolute path is a failing test on Linux, and the UI harness names a page script that did not load (found by CI on Windows at `a035a87`)
- **Problem:** CI at `a035a87` was green on Linux and macOS and red on Windows with two failures. `test:team-run-cli` (new in IMP-023) started the CLI with `--import D:\a\...\register.mjs`, which Node on Windows reads as a URL with the scheme `d:` (`ERR_UNSUPPORTED_ESM_URL_SCHEME`); the full local suite on Linux had passed on that exact commit, so nothing could have told me. It is the fourth time an absolute `--import` path or a path turned into a file name has been found this way (the gate tests, the bench children, the lineage test, now this one).
  `test:ui-plain` failed with `Cannot read properties of undefined (reading 'setEnabled')`: `AL.mascot` did not exist, which means `mascot.js` never ran. The page is built to survive a script that did not load, so the test learned nothing but "undefined"; the harness filtered "Failed to load resource" as expected noise. The cause of the missing script is **not established**: the server turns any failed read of a page file into a silent 404, and a transient read error on Windows would look exactly like this, but no log of the request exists.
- **Why it matters:** a repeated mistake that a person can only avoid by remembering is going to happen again; a failure that says "undefined" costs a CI cycle to diagnose each time it happens.
- **Change (how):** `test/windows-imports.mjs` (`npm run test:windows-imports`, part of `npm test`) reads every `.mjs`, `.js` and `.ts` file under `test/`, `scripts/`, `bench/` and `src/` that starts node with `--import` and refuses an argument that is not a relative path (`./x.mjs`, run from the repository root), a URL (`.href`, `pathToFileURL`, `file:`) or a bare package name; a name is followed to its declaration in the same file, and a name it cannot trace is refused. `test:team-run-cli` now starts the CLI from the repository root with a relative path, and `test/e2e/record-run.mjs` (the opt-in recorder) builds its `--import` URL with `pathToFileURL`.
  `test/ui-extras-helpers.mjs`: the harness remembers every page, script or stylesheet that answers 4xx or 5xx or fails (except what a test aborts on purpose) and `open()` throws a message naming each ("`/mascot.js` answered 404"); `test:ui-plain` has a section that makes `mascot.js` answer 404 and requires that message.
- **Measured:** `test:windows-imports` run on the `ca937d5` tree reports `test/team-run-cli.mjs: --import reg: declared as fileURLToPath(...)` and the recorder's absolute `join(root, ...)` (it fails on the old code), and passes on this tree (16 uses of `--import` in 170 files), run twice. **Mutation check** of the scanner, with an unmutated control: 17 mutants, 0 survivors after a first pass with 2 (quote tracking that nothing needed, deleted; the report of problems found, which the repository never exercised because it has none, now has a test on a temporary directory).
  `test:ui-plain`'s new section passes twice; every suite that uses the harness (`ui-cartoon-stress`, `ui-idle-cost`, `ui-mascot`, `ui-offline`, `ui-plain`, `ui-replay`, `ui-sound`, `ui-stop`, and `stop`, `stop-e2e`, `fatal`, `doctor`, `concurrent-runs`) passed on this tree. What is **not** measured: whether the Windows `ui-plain` failure was a failed load of `mascot.js` at all. If it recurs the harness will say which file failed; if the message is some other file or no file, this entry's hypothesis is wrong and the cause is still open.
- **Cost / trade-off:** one more suite (a file scan, under a second); a `--import` written in a way the scanner cannot read (built in a loop, passed through an environment variable) is invisible to it; the harness now fails a test at `open()` for a failed script load that earlier tests would have survived, which is the point, and a test that wants a failed load aborts it on purpose (`abort`) or reads `badLoads`.
- **Suites:** none
- **Skill impact:** the SELF-HEALING row for tests written and run on Linux only gained a fourth occurrence and now names the guard; the dev-workflow skill's verification lessons should say that a path handed to a child process is a Windows-only failure and is checked by a scan, not by memory (SKILL-019 in the Dev-Skill log).
- **Follow-ups:** read CI on all three systems for the commit that carries this; if `test:ui-plain` fails on Windows again, read the named file and either fix the cause or, if it is a transient read error, make the server retry a failed read of a page file once (not done: unproven).

## IMP-026 · 2026-10-07 · LIVE mode, part one: the allowances list, a public-address rule for the gate, and a navigation check (S2 increment 1; threats C4, D1, D2, C3)
- **Problem:** the network gate (IMP-009) could only be told "localhost, nothing else", so the agent could not reach any real site, and the job-apply flow needs LinkedIn, Greenhouse and the rest. Opening the gate is the dangerous part of the whole goal: a policy that says "any public host" must still never reach a private, loopback, link-local or cloud-metadata address, however a name or a literal spells it, and the agent must navigate only where the user said it may.
  Nothing in the code defined "where the user said it may": no config file, no host-matching rule, no notion of a site (a platform) for the daily caps.
- **Why it matters:** this is the boundary the rest of the job agent stands on. If "linkedin.com" matches "linkedin.com.evil.com", or `::ffff:127.0.0.1` reaches the loopback, or a project directory can write the user's allowances, every later safeguard is built on sand. It had to exist, and be tested to the point of dull certainty, before any real page is opened.
- **Change (how):** `src/allowances.ts`.
  **Rules.** An allowances entry is a domain (`linkedin.com`, covering itself and its subdomains on a dot boundary) or an exact host (`=boards.greenhouse.io`). Names are folded to lower-case ASCII (punycode for other scripts, so a homograph does not match); addresses in any spelling, ports, paths, schemes, wildcards, one-label names and shared hosting domains (`github.io`, `co.uk`, ... a short list, not the Public Suffix List) are refused when the file is read. The deny list beats the allow list. A host maps to a platform (the caps count platforms, not hostnames, so a second Workday tenant is not a fresh quota); an allowed host with no mapping is its own site.
  **Addresses.** `isPublicAddress` accepts global unicast addresses only: it refuses 0/8, 10/8, 100.64/10 (carrier-grade NAT, Alibaba's metadata address), 127/8, 169.254/16 (every cloud's metadata address), 172.16/12, 192.0.0/24 (Oracle's), 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24 and everything from 224 up; for IPv6 only 2000::/3 minus Teredo and the protocol range 2001::/23, the two documentation ranges, and it judges IPv4-mapped, NAT64 and 6to4 addresses by the IPv4 address they carry. A zone id, a non-string and anything `net.isIP` refuses is not an address.
  **Policy.** `livePolicy` is the gate's `NetGatePolicy` for LIVE mode: any public host passes (a page needs its CDN and fonts) except the user's deny list and `localhost`; every address that is not public is refused, by address, after the gate's own lookup (so DNS rebinding is still covered: one lookup, and the connection goes to the address that was checked). **Navigation.** `navigationVerdict` judges the first hop of a page the agent opens: http or https only, no credentials, port 80 or 443, a name (never an address, even as `2130706433` or `0x7f.1`) that the list covers and the deny list does not; its reasons are short and cleaned.
  **The file.** `loadAllowances(home)` reads `<home>/allowances.json` from the user's own agent-loop directory (never from `--dir`, so a project cannot grant itself anything): strict shape, unknown keys refused, at most 500 rules, 100 KB, every problem listed at once; a missing file means nothing is allowed; on POSIX a link, a file anyone else can write, or one owned by someone else is refused.
  Nothing calls this yet: the browser tools and the CLI are wired to it in the next increment. TEST mode and the existing suites are untouched.
- **Measured:** two new suites, `test:allowances` (7 sections) and `test:live-policy` (6 sections), each run twice. The address table has 30 public and 50 non-public addresses and 17 non-addresses (boundaries included: 172.15/172.32, 100.63/100.128, 169.253/169.255, 2001:1ff/2001:200, 3fff:0fff/3fff:1000). `test:live-policy` drives the real gate with a resolver stand-in and a decoy server: a denied host and its subdomains are refused before any lookup; names that resolve to cloud metadata, a LAN address, an IPv4-mapped or NAT64 loopback, every address literal and `localhost` are refused and the servers behind them record 0 requests; a name that answers "public" then "private" is looked up once and the connection goes to the address checked; a mixed answer dials only the allowed address.
  **Mutation check**, with an unmutated control that passes first: 83 mutants of `dist/allowances.js`, 83 killed, 0 survivors, after a first pass of 82 with 3 survivors (the order of two platform rules in the fallback, a file only the world can write, an owner check that cannot be exercised as root: the last now takes a `uid` option so the test can say who "you" is). Two redundant layers were deleted on the way (a repeated IP check in `normalizeHost`, an `isIP` branch in the policy that the address rule already covers) and the parsers were cut to what `net.isIP` leaves them.
  Fails on `b695f8c`: the modules do not exist there (`ERR_MODULE_NOT_FOUND`).
- **Cost / trade-off:** a rule covers subdomains, so a host that hands out subdomains to strangers must be kept off the list (the short shared-domain list is not the Public Suffix List); ports other than 80 and 443 cannot be opened in LIVE mode; the policy cannot tell a page from a subresource on an HTTPS tunnel (it sees only the host), so the allowances list judges the navigation where the browser can (next increment) and the gate guarantees only that nothing private is reachable and that denied hosts are not; `localhost` is refused by name in LIVE mode, so a local test server needs TEST mode.
- **Suites:** none
- **Skill impact:** none new.
- **Follow-ups:** S2 increment 2 (the browser tools take a mode and the allowances: the `open` check, frames, an off-list redirect landing detected and the agent shown nothing from it, WebSockets), increment 3 (the agent-only profile, its lock, `agent-loop login <site>`), increment 4 (gated upload with a destination check), increment 5 (the red-team rows, a benchmark row and an adversary round with a new agent). Real sites were not touched.

## IMP-027 · 2026-10-07 · LIVE mode in the browser tools: the agent navigates only where the allowances list says, and a redirect that lands off the list shows it nothing (S2 increment 2; threats C4, D1, D3)
- **Problem:** IMP-026 defined what LIVE mode allows, but the browser tools still knew one rule, "this machine only", written into four places (the gate's policy, the context-level request guard, the WebSocket guard, `open`). Two things a LIVE policy needs could not be said in that shape. First, a server-side redirect is followed inside the browser and the request guard sees only the first URL (finding A2): an allowed page can send the browser to any host, and in LIVE mode the host is a real site. The request cannot be taken back, but the page it lands on must not reach the agent. Second, a page load the gate refuses over plain http carries no `Sec-Fetch-*` header (the browser sends them only to origins it calls trustworthy), so the gate could not tell the agent a page had asked and the refusal was silent.
- **Why it matters:** this is where "only the sites you listed" becomes true in a real browser. An instruction hidden in a job posting that says "open this other site" or a redirect on a listed site must end with the agent still on the list and knowing it.
- **Change (how):** `src/browser-policy.ts`: one `BrowserPolicy` object answers every question the tools used to answer with the localhost rule: the gate's policy and name resolver, whether a request may go (judged on its first URL), whether a WebSocket may connect, whether the agent's `open` is allowed (and the message to refuse with), and whether the page a frame **landed on** may be shown. `testPolicy` is the old rule moved here unchanged; `liveBrowserPolicy(allowances)` is the new one. In LIVE mode a navigation or a frame must be on the list (an address in any spelling, another port, a data/blob page, other schemes and credentials are refused), a subresource passes (a page needs its CDN and fonts; the gate judges its host and address), and a WebSocket goes only to a listed name.
  `BrowserSessionManager` takes the policy (default TEST, so every existing suite runs the old rule). When a frame commits somewhere the policy would not have let it go, the page is replaced by a blank one, the agent gets a notice that names where it landed and why, `open` returns "Refused: the page redirected to ..." instead of a title, and every tool refuses to read a tab still on such a page. A frame inside the page is blanked the same way. A refused plain-http page load is now reported from the gate's own response (once, and not when the gate already told the agent).
  The fake-internet test needs hosts and ports a real one does not: `liveBrowserPolicy` takes a replaceable "is this address public" (the real function is used everywhere else) and extra ports.
- **Measured:** `test:live-browser` (9 sections, real Chromium through the real gate to one local server that answers for several host names and counts what each receives): a listed page opens with its CDN script and image; a second listed host, a link and an iframe to it work; a WebSocket to a listed host works. A refused `open` (unlisted, address spellings, localhost, another port, three other schemes, credentials) reaches the far side 0 times; a link, a script navigation, a meta refresh, an iframe and a popup to an unlisted host reach it 0 times and the agent is told which host and why; a WebSocket to an unlisted host never upgrades; a denied host's image is never fetched; a listed name that resolves to a private address is not reached and its text never arrives.
  **Redirects, stated plainly:** a 302, a chain of three and a page that stalls while loading each **reach the off-list host once** (the test asserts that, because it is true and pretending otherwise would hide it), and the agent is shown none of its text or title: not in `open`, `inspect`, `list_tabs` or any later result. An iframe redirected off the list is blanked and its text never shown.
  Fails on `58aaba4`: the module does not exist. The suites that exercise TEST mode (`browser-tools`, `browser-cu`, `browser-observability`, `browser-frames`, `browser-popup-storm`, `browser-hang`, `browser-dropped-call`, `browser-redirect-gate`, `team-browser-readonly`, `team-run-phase`) pass unchanged except one new case in `browser-observability` and one count in `browser-redirect-gate` (a refusal is told once).
  **Mutation check**, control first: 45 mutants of `dist/browser-policy.js` and `dist/browser-tools.js`, run against `live-browser`, `browser-observability` and (for the TEST rule) `browser-redirect-gate` and `browser-tools`. A first pass left 6 survivors: 2 closed with assertions (the refusal itself must name where the page landed, not only a notice after it; a refusal is told once), 1 a **redundant layer proven by a combined mutant** (TEST mode's route-level guard and the gate both enforce "local only"; removing both lets the decoy be reached and is killed), and **3 unexercised guards that stay**: the translation of a navigation that Playwright reports as interrupted by the blanking (Playwright resolves it here, and it may not on other systems or versions), and the two tab guards for the instant between a landing and its blanking (a race no test can pin).
  A bug found by the test on the way: a refused plain-http page load was silent (see Problem).
- **Cost / trade-off:** the redirect request is made and cannot be recalled; what is withheld is the content. A WebSocket to a third-party host the page uses (a chat widget) will not connect. A page that embeds an off-list iframe (ads, a video, a captcha) shows a blank frame and a notice; that is also what the watchdog will use to see a challenge (S4). A script running on a listed site can still reach any public host with `fetch`; the agent's own secrets are not in the page, and this is listed in the threat model as a residual risk.
- **Suites:** none
- **Skill impact:** none new.
- **Follow-ups:** S2 increment 3 (the agent-only profile, its lock, `agent-loop login <site>`), 4 (gated upload with a destination check), 5 (red-team rows, a benchmark row `live-gate` with a baseline on the unmodified build, an adversary round with a new agent). The CLI does not select LIVE mode yet: flows will (S3).
