# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **The browser tools now tell the agent what the page did** (S1; `docs/BROWSER-AGENT.md` section 4b, `docs/IMPROVEMENTS.md` IMP-008). Every tool
  result ends with the problems that are new since the last one: an uncaught exception, a console error or warning, a response of 400 or above
  with its status, a request our own localhost-only rule blocked, a dialog (dismissed and reported), a download (refused and reported), a crash.
  Text is labelled as page data, control bytes are stripped, URLs are cut to host and path, at most 8 lines a result with repeats collapsed
  (`x100`), 200 kept, 300 `browser-notice` events a session. New tools `text` (a long page in sections, with the total), `notices` and
  `resize`; `inspect` takes a `query` and says when a page is blank. The benchmark's `observability` suite went from 0 of 8 to 8 of 8 (the baseline was first recorded as 1 of 8 and corrected after an adversary round showed its one point was scored by accident). The
  test found three real faults in its own first draft: an eviction policy that threw away the most informative entry, counts reported before a
  burst had finished, and a download cancelled too late for small files about 1 run in 6 (now refused by the browser).
- **`npm run checkpoint` saves everything before usage runs out, `CLAUDE.md` carries the rule, and `docs/SELF-HEALING.md` catalogs recoveries and repeated mistakes** (user
  request; IMP-012). One command stages, commits and pushes this repo and the Dev-Skill checkout above it, never with `--no-verify` and never forced, and says plainly what it
  could not do (`test/checkpoint.mjs`, 6 checks with controls). The usage governor in the spec now checkpoints before it pauses.
- **The browser can no longer be sent to an off-list host through a redirect, and file tools cannot walk out of `--dir` through a symlink** (adversary
  round 1, findings A2 critical and A1 high; `docs/IMPROVEMENTS.md` IMP-009 and IMP-010). The route handler Playwright gives us sees only the first URL
  of a request, so a server-side 301/302/303/307/308 from an allowed local page reached a decoy on `127.0.0.2` with its query string; the shipped docs
  called that boundary "already built and tested". The browser now goes through `src/net-gate.ts`, a loopback-only, credentialed forward proxy that
  refuses every hop not on the list, resolves names itself and connects to the address it checked, tunnels `CONNECT` and `ws://`, and tells the agent
  what it refused (`test/net-gate.mjs`, `test/browser-redirect-gate.mjs`: 0 of 16 attempts reach the decoy, 13 of 13 mutants killed). The path-scope
  hook follows symlinks, applies `..` through them, follows dangling links and refuses what it cannot resolve (`test/path-scope-symlink.mjs`: 14 of 14
  attacks denied, 6 of 7 mutants killed, the seventh equivalent because the kernel stops at 40 links). `Bash` remains unscoped.
- **The benchmark cannot be tampered with or fail open** (adversary A13, A14; IMP-011): baselines are checked against git history and need a logged reason
  to change, a corrupt baseline stops the runner, the change column compares rates, freshness fails closed in CI, and the observability baseline was
  corrected from 1 of 8 to 0 of 8 by scoring the old commit in a scratch worktree.
- **A benchmark, an improvement log, a handoff document, and two designs written before any code** (docs only plus `bench/`, tests and a hook):
  - `bench/` runs deterministic suites against the built code, records a baseline the first time a suite appears and never overwrites it
    silently, and regenerates the table in `docs/BENCHMARK.md`; four tests keep the table, the scorers, the log and the handoff honest, each with
    controls proving it can fail. First baselines: observability 1 of 8, safety 26 of 26.
  - `docs/IMPROVEMENTS.md` records why and how each improvement was made, with the number it moved; seven entries backfilled from the changelog.
  - `docs/HANDOFF.md` plus `scripts/handoff-check.mjs`: what was asked (in the user's words), decisions, locations, status, next step, what is
    not verified. A test fails if it is more than 8 commits behind or loses a section.
  - `docs/HYBRID-AGENT-SPEC.md`, `HYBRID-AGENT-THREATS.md`, `TEAM-COMPOSITION.md` (the number of agents depends on the task: roster, composer,
    validator rules), `REEL-FLOW.md` (send an Instagram reel, learn what it is about, implement it as a measured experiment if it is good).
  - Round 1 of an adversary loop (a fresh-context agent that must prove every finding): 20 findings, one critical, in `docs/adversary/round-01.md`.
- **A hook that saves compaction summaries and re-injects the handoff** lives in the Dev-Skill repo (`dev-workflow/scripts/handoff_hook.py`).
  `SessionStart` was observed firing live (it injected the handoff when this work resumed); `PreCompact` and `PostCompact` are only tested with the
  SDK's documented payloads.


### Changed
- **`docs/REFERENCE-AUDIT.md` now reviews OpenClaw's browser extension and computer-use actions control by control, and corrects one row.** The
  original research read only OpenClaw's computer-use extension; its browser extension was never reviewed. Checked by running our handlers: a page
  with an uncaught exception, a `console.error` and a 404'd script looks healthy through `inspect`; dialogs are dismissed and downloads discarded
  without the agent being told. The "risk-classify actions" row said *built*; it is *adapted* (OpenClaw has three tiers, ours two, stricter). No
  code changed; the gaps are listed in priority order for a decision.
- **The cross-platform check blocks now, and all 37 suites pass on macOS and Windows** (CI, 2026-10-02, commit 13f6b1a; Linux green on the
  same commit). It had been allowed to fail (`continue-on-error`) while the first failures were learned from, which meant its badge
  would have read "passing" with suites inside it red; the first macOS/Windows runs were 36 of 37 and 34 of 37. `STATUS.md` no longer
  says Windows was never tried. Still not covered by any CI: desktop control on macOS and Windows, and the real-model runs.
- **README rewritten, and every walkthrough video and screenshot remade on the current page.** The README now opens with what the
  project is for and the measured result that the five-agent pipeline did not beat one session (docs/IS-IT-USEFUL.md), lists what it
  gives you with the evidence behind each line, shows the CI results per system instead of asserting them, and keeps its gaps in one
  place. The long file and test tables moved to `docs/LAYOUT.md` and `docs/TESTING.md`, unchanged. New media: `stop-and-plain.mp4`
  (the stop button, "still running", "no result", plain mode), three terminal images rendered from the real output of `insights`,
  `doctor` and a `--max-cost` stop (`npm run record:terminal-images`; each says in its title bar what is a stand-in), and screenshots
  of the armed stop button, a stopped run and the dropped-events note. The lineage, persona, desktop, tour and dinosaur videos were
  re-recorded: the desktop video had a header reading "1309m 48s" because the recorder's server stamped one event with the real clock
  while everything else used the scripted one (the recorder now scripts that too, and the server takes a `clock` option for it).
- **A model that keeps asking after "no" stops getting prompts** (finding 21). Running a real model showed
  it asking for one refused click eight more times, each a fresh prompt. After three refused desktop input
  requests in a row the model is told to stop and no fourth prompt is shown; looking in between doesn't
  reset the count, one allowed action does (`src/hooks.ts`, `src/bus.ts`).
- **The run UI, rebuilt after watching real runs** (docs/UI.md). A recorded todo-app run needed 53
  approval clicks and put 356 cards on screen, and the page lost everything on reload or when the run
  ended. Now:
  - Claude Code-style transcript: one `⏺ Tool(args)` line per call with its output attached and
    collapsed. There's a phase stepper, live cost and elapsed time, and a side panel.
  - The permission prompt is pinned to the bottom and answered with 1/2/3, y/n or Esc. "No" takes a
    reason that goes back to the agent.
  - "Yes, and don't ask again" saves a narrow per-run rule (`Bash(npm test:*)`). Read-only shell
    commands inside `--dir` don't ask; `--strict-approval` restores asking. Compound commands are
    judged per subcommand (`src/bash-analysis.ts`). Destructive, remote, wrapped or run-time-expanded
    commands never become rules.
  - The server replays the whole run to every connection. The transcript survives the server
    stopping.
  - Real runs: 53 → 16 prompts (todo app), 24 → 11 (Roman numerals), same hidden-grader scores.

### Fixed
- **CI was red on all three systems since the S0/S1 commits; the causes were different on each** (user: "make the shit work"; IMP-013). The network gate connected only to the first
  address a name resolved to, so on a machine where `localhost` is `::1` first (the Linux runners, Windows) a local page could not be fetched at all in TEST mode; it now tries every
  allowed address (plain requests, CONNECT, ws://) and answers 502 when none accepts (`test/net-gate.mjs`, fails on the old gate and on a first-address-only mutant). On Windows a workdir
  written as `/tmp/...` was refused every read and write, because the bare root was not mapped to the current drive (`src/hooks.ts`). Windows checkouts have CRLF endings, which broke the
  generated benchmark table's comparison (`.gitattributes` with `eol=lf`; proven with CRLF docs). Two timing races in tests became waits for the state itself (`test:stop`, the cat's position
  in `test:ui-mascot`). The Windows path fix and the two timing fixes could not be reproduced on the machine that wrote them; the entry says so, and CI is what confirms them. A follow-up run found a real fault behind a macOS failure: a popup tab's first console error, uncaught exception or dialog was lost (3 runs in 5 under CPU load) because only page-level listeners existed; they are now on the browser context as well (stand-in test with 4 mutants killed). The burst-settle lull went from 60 to 120 ms as an unproven hardening, and the wall-clock burst test (which failed on macOS twice in different ways) became a mocked-timer test of the settling rule plus a real-browser check that nothing is lost.
- **On Windows the server answered 404 to the page's own scripts** (found the first time the suite ran on macOS and Windows; both
  had been listed as "untested"). `normalize("/persona.js")` is `\persona.js` there, so `/persona.js`, `/sprite-data.js`, `/plain.js`
  and `/artifacts/*` all failed and a Windows user lost the jokes, the art and the screenshots. It is `posix.normalize` now
  (`src/server.ts`). The same run showed several tests were not portable (`new URL().pathname` is `/D:/...`; an X11 socket and
  `kill("SIGINT")` are POSIX-only; `--import` needs a `file://` URL, a bare `D:\...` path is read as the scheme `d:`): fixed or
  guarded. macOS produced no results at all because the workflow used `timeout`, which macOS lacks; `scripts/run-suites.mjs` runs
  each suite on its own with a timeout and lists which passed, on any system (`.github/workflows/cross-platform.yml`).
- **Elapsed time was wrong after a reload when the browser's clock differed from the server's** (a forwarded port, a phone): it read
  423 s against a server clock 7 minutes off, measured with two real processes. The server now sends its time with the end of every
  replay (`serverTime`), and the page keeps the smallest clock difference it has seen. `ServerOptions.clock` lets a test or a
  recording script its own timeline.
- **On Windows the report and lineage links the command line printed were not valid URLs** (found by the Windows run of
  `test/lineage.mjs`): it printed `file://` followed by the path, which on Windows is `file://C:\Users\...\report.html`
  (backslashes, no third slash), so a terminal would not make it a link. It prints `pathToFileURL(...)` now, `file:///C:/Users/...`;
  on Linux and macOS the line is unchanged for ordinary paths. The four tests that read the line parse it as a URL.
- **The dinosaur test could fail on a loaded machine** (one Linux CI run): it compared two canvas frames 250 ms apart. It now waits
  up to five seconds for the picture to change and compares where the grey pixels are, not how many there are. I could not reproduce
  the failure locally, so the cause (load on the runner) is likely, not confirmed.
- **`agent-loop doctor` could say a tool was not installed when the machine was merely slow** (found by the cross-platform check the moment it
  was made blocking: `test:doctor` failed once on Windows, "which finds node", after passing on the same code minutes earlier). The
  probe ran `which`/`where` as a subprocess with a 3-second limit and read a timeout as "not found"; with a 1 ms limit that gives a false
  "not found" for node in 7 of 20 tries here. It searches `PATH` directly now (`PATHEXT` on Windows), with no subprocess and no limit to
  hit. The test puts only a fake command's directory on `PATH`, where the old probe cannot even launch `which`: it fails against the old
  probe and passes against the new one. The failure itself was seen once on CI and not reproduced there; the mechanism is shown, not the
  occurrence.
- **The real-permission notification test ran in the wrong browser on CI** (red on Linux, macOS and Windows; it had never run green there
  because earlier runs stopped before reaching it). Playwright's default for a headless launch is Chromium's *headless shell*, which has
  no notification permission of its own: the Permissions API said "granted" while `Notification.permission` said "denied". This
  sandbox always passed the full Chromium, so it passed here; pointing the test at the shell reproduced CI's exact output. The section
  now asks for a full Chromium (`harness({ fullChromium: true })`, `channel: "chromium"` when no path is given) and fails loudly, naming
  both readings, if it is ever run in the shell. My first guess (the grant had no origin) was wrong; granting for the page's origin is
  kept, being the documented form. Verified: it passes on Linux, macOS and Windows CI (2026-10-02).
- **A test I pushed contradicted the server it ran against, and went red on all three systems** (`test/ui-stop.mjs`, the "page 7
  minutes ahead" case): it stamped events with a clock 7 minutes off while the test server truthfully reported its own, unskewed clock
  in `replay-complete`. A real server stamps events and reports its time from one clock; the test server now does too
  (`harness({ serverClock })`). Reproduced locally first, then re-checked with the page's skew handling deliberately broken: the test
  fails. My earlier "full suite passes" had not been re-run after the `serverTime` change; the CI run was what found it.
- **The `insights` grade punished the wrong things.** Stopped runs counted against you (stopping is the thing to reward), six clean
  runs with some unused rules scored a B-, and the same point could be made twice ("125 yeses in a blink" and "150 yeses, no nos").
  Outcomes now outweigh trivia, stopping is free, killed runs cost a little, and a point already made is not made again. Still a
  formula made up for fun, and it says so where it prints.

- **Several runs against one audit folder crashed with "database is locked"** (found by a stress test of five simultaneous runs; all five
  failed, three of three repeats). The crash hit in the middle of finishing a run, so it stayed "running" with no report. SQLite had no
  busy timeout; it has one now (15 s, set before switching to WAL). 12 simultaneous runs pass. And a database that fails mid-run (disk
  full, a lock that does not clear) no longer kills the run: the page and the report work from memory, it says once that events are not
  being recorded, and says at the end that the run will still read "running" there (`test/concurrent-runs.mjs`).
- **A waiting prompt made the page repaint every frame** (found by measuring CPU, not by a test): the "needs you" glow animated
  `box-shadow`, which cannot run on the compositor, and burned 4.2% of a core for as long as a prompt waited (hours, if you are away). It
  animates opacity now: 0.3%. `test/ui-idle-cost.mjs` guards the cause (no repaint-bound infinite animation while the page is busy,
  with a control that proves the detector fires); the spinner also stopped rewriting identical text 4.5 times a second in plain mode.
- **A long run's reloaded page and saved report silently showed only the newest 5,000 events while the README said "full transcript".**
  They now start with "Showing the most recent activity: N earlier tool events were dropped" (the count is exact, and the audit database
  has every one). Trimming also no longer cuts between a tool call and its result (a headerless card at the top) and never drops a request
  somebody is still being asked to answer. `test/bus-history.mjs`, `test/ui-replay.mjs`.
- **Runs killed or crashed stay "running" forever, and `insights` presented them as maybe-alive.** It now says what "running" may mean, counts
  runs still "running" 12+ hours later as abandoned (with a Ctrl-C tip), and no longer prints every unused rule (thousands of lines on a big
  history; it stops at ten). The roast's grade now says, where it prints, that it is a made-up score.
- **Docs that no longer matched the code**: suite counts, a size claim that was true but incomplete (50 KB of PNGs travel as 71 KB of base64
  in every saved report), and a prompt-count that said 16 in one paragraph and 13 in the table beside it (13 is the later, fresh run).
- **Ctrl-C left a run "running" in the audit database forever, and wrote no report** (found by the reference-project audit,
  `docs/REFERENCE-AUDIT.md`, and reproduced against the previous commit: SIGINT killed the process, the run stayed `running`, no
  `report.html`, browser and desktop sessions unclosed). Ctrl-C, SIGTERM, the page's Stop button and `--max-cost` now end a run through one
  switch (`src/run-control.ts`): the model sessions are aborted at once (`abortController` into `runPhase` and the Overseer call),
  every approval still waiting is refused (before, an approval waiting when a query was aborted stayed in the bus, and a tab
  opened later would have been shown a dead prompt), the run is saved as `stopped` with the reason, and the report is still written. A
  second Ctrl-C quits immediately. Exit codes 130 / 143.
- **A browser whose clock differs from the server's showed wrong elapsed times** (a forwarded port, a phone): the page compared the
  server's event timestamps with its own clock. It now estimates the difference from live events and uses it for the elapsed time, the
  status line and the new "still running" label (`test/ui-stop.mjs`, 7 minutes ahead and behind; simulated, not tried across two machines).
- **In plain mode the turning glyph still turned**: the dock drew it separately from the interval that stopped it. Found by a test
  written to kill a surviving mutant, along with three guards that nothing exercised (below).
- **Opening a long run froze the page for tens of seconds** (found by auditing the replay path, then measured: 6,000 events took
  29.6 s to replay, and the cost grew faster than the event count). The page re-rendered the stepper, header, dock and extras
  after every replayed event. Replay now draws the transcript once and the chrome once at `replay-complete`: the same 6,000 events
  take 2.2 s (`test/ui-replay.mjs`: under 10 s and no worse than 14x going from 500 to 3,000 tool calls).
- **A run longer than the history limit lost its beginning** (`src/bus.ts`). The bus kept the newest N events and dropped the
  oldest, which in a long run are `run-start` and the first `phase-start`s: a reload then showed a run with no task and a stepper
  with no phases, and so did the saved report. Trimming now drops the oldest *tool* chatter first and keeps the structural events
  (run and phase boundaries, Overseer decisions, usage, approvals' outcomes, session boundaries, lineage). `test/bus-history.mjs`.
- **`agent-loop insights` died on one corrupt event row** (found by the new habits test planting a row that is not JSON). All
  its reads now skip a row that is not an object. A negative or non-number cost no longer makes the total negative, and a phase
  name from the database is stripped of control bytes before it is printed.
- **A saved report corrupted any run whose events contained `$'`, `$&`, ``$` `` or `$$`** (found while reading the code for
  the sprite work, then reproduced: `echo $'x' && echo $&` turned into a broken script and an empty page). `report.ts` embedded
  the run with `String.replace` and a replacement *string*, which expands those patterns; shell commands are full of them.
  Now a function replacer; `test/report.mjs` has a command containing all four.
- **The light look's bold text was white on white** (the "Task:" label and every `**bold**`), so it was invisible. Fixed.
- Found by the new tests while building the above, all in the new code: the cat stood 12 px low on a prompt because it measured
  the prompt mid-slide; the dinosaur's first jump was cancelled on the takeoff frame (height still exactly 0 read as "landed");
  the 12 px icons had been paired with the wrong 17 px icons because the PSD's layer names do not match (a map's small twin was
  a telescope) — they are now paired by position and checked by colour.

### Added
- **`docs/IS-IT-USEFUL.md`: what here earns its place and what is only delight, with measurements** (and an honest note that on the one
  task measured the five-agent pipeline scored 4,039 vs plain Claude's 4,037 of 4,040 checks at 17x the cost). It also lists the experiment that
  would settle it (about $8 to $20, not run). The Stop button is now tested end to end with a real run, a real browser and two real
  clicks (189 ms), and 200 stop messages from three tabs plus a Ctrl-C make exactly one stop (`test/stop-e2e.mjs`). Measured at scale:
  `insights` on 3,000 runs / 636,000 events takes 2.5 s; a page reloaded onto a 40,000-event run loads in 1.6 s.
- **Ending a run early, properly** (`src/run-control.ts`). `--max-cost <usd>` stops the run once that much is spent (checked after each
  phase attempt and Overseer call, so one long step can pass it; the Overseer is not paid to judge a run that is over). Ctrl-C, SIGTERM
  and a **stop run** button on the page (two clicks, the first arms it for 4 s; the page asks over the same token-checked socket as
  approvals) do the same. The run says "Stop requested, and why" in the transcript, is saved as `stopped`, and its report is written.
  `test/stop.mjs` (mid-phase, before it began, as a phase ends, no stop, the socket message and who may send it, the cost cap at three
  points and bad values, SIGINT and SIGTERM end to end, a second Ctrl-C when a call will not stop), `test/ui-stop.mjs` (real Chromium).
  `npm run test:real-model-stop` (opt-in, a few cents) runs it against the real SDK: run once, passed (an abort takes about 2 s to wind down; no child process left; and it showed the stand-in's `AbortError` was really a plain `Error`, now matched).
- **`agent-loop doctor`** (`src/doctor.ts`): Node and `node:sqlite`, the audit folder, credentials (the value is never printed), Chromium,
  ffmpeg, and for desktop control the four failures that used to look the same ("could not load" / "did not answer"): **no display**,
  a display variable that **points at nothing** (a real X11 socket is probed), a **locked** session, and a driver that is **missing,
  the wrong version or silent**. Desktop problems block only with `doctor --desktop`. A desktop target that fails to start now prints
  the same diagnosis. `test/doctor.mjs`.
- **Plain mode: one switch that turns every cartoon off** (`ui/plain.js`; docs/UI.md). The cat, every pixel icon, the pixel cursors, the
  dinosaur game, sound and the turning glyph, from the header's **cartoons** button, the `?` window, `?plain=1`, or `agent-loop run --plain`
  (`$AGENT_LOOP_PLAIN=1`); remembered per browser; a saved report follows `--plain`. Everything else is unchanged (prompts, the offline
  dialog's words and Retry), and your own cat, cursor and sound settings come back when it ends. `test/ui-plain.mjs` and
  `test/ui-cartoon-stress.mjs` (80 flapping approvals, 60 clicks on the cat, 320x480 / 1920x300 viewports, resizes while it hops, markup
  in run text, sound churn, four server restarts: nothing found). A canvas that cannot draw (`getContext` returning null) no longer takes
  the offline dialog down. 29 deliberate breaks of the plain-mode code: 24 caught at first; the five that survived (the scripts'
  own guards, and a spinner check that never had a spinner to look at) led to stronger tests, one of which found the glyph bug above.
- **"still running · 31s" on a quiet tool call, and "no result · the run ended"** on a call that never answered (PokeHarness's
  backstop-timer idea, adapted; the clock starts when you approve and never runs while a prompt waits on you). **Opt-in browser
  notifications** when a prompt waits and the tab is in the background (the text is only "<agent> needs you", never the command).
- **docs/REFERENCE-AUDIT.md: PokeHarness, Hermes and OpenClaw, idea by idea**: where each one lives in the code, which test would
  fail without it, what was not built and why, what the audit found by running things, and the one decision that is yours (parallel
  fan-out).
- **`agent-loop insights` now talks to you about how you actually use the tool** (docs/PERSONA.md, `src/roast.ts`).
  After the numbers: up to three lines in the voice of a friend who has watched you do it, up to two tips, and a report-card
  grade. It reads what is in the audit database: approvals answered in under 1.5 s ("that is not a code review, that is a
  reflex"), the same call denied and later allowed, money that went into runs that failed or were stopped, the phase that gets
  sent back most, runs started after midnight, the same task run again and again, "don't ask again" rules never used, runs
  stopped halfway, a clean record ("suspiciously clean"). 17 findings, 40 lines, current slang and memes, dry and dark
  variants, deterministic for the same numbers. Same rules as the persona: the target is a habit, never the person; a tip
  sits next to the joke.
  - **Safe by construction.** `Store.getHabits()` returns numbers and fixed labels only (`src/habits.ts`); a task, command,
    rule, path or reason is never in it, only compared with others to count repeats. `test/roast.mjs` plants a canary in each of those
    fields and checks none reaches the lines, the tips, the grade or a model's prompt.
  - **`--roast off|offline|api`** (also `$AGENT_LOOP_ROAST`; `--humor off` beats everything). `offline` is built in and free,
    the default. `api` has a Claude model (Haiku by default, `$AGENT_LOOP_ROAST_MODEL`) write fresh lines from the numbers alone,
    because slang ages: one tool-less turn, the allowlisted environment, no tools. Every line it returns is validated (length,
    markup, links, code, control and bidi characters, the persona's banned terms, and **no number that is not in your data**) and
    anything that fails, or fewer than two good lines, falls back to the built-in set with a note saying why. A real Haiku call
    measured $0.033 for three lines; `npm run test:real-model-roast` (opt-in) runs it.
  - Like the rest of the voice, it prints on a terminal or when asked for outright, so logs and CI stay plain.
  - Tests: `test/roast.mjs` (catalogue lint, every finding fires and fills with only data numbers, dry never dark, determinism,
    a crafted database counted exactly, canaries, a fake generator against 12 kinds of bad line, the CLI end to end including
    the fake SDK for `--roast api`); 18 deliberate breaks of the new code, all caught (two survived at first and led to a
    stricter grade test and a tip assertion). The persona's import-graph test now also pins who may import the roast.
- **The run UI, friendlier and closer to Claude Code, with a cat that runs to whatever needs you** (docs/UI.md,
  docs/ASSETS.md). Additive: no existing id or class changed meaning, and the earlier UI suites pass unchanged.
  - **A welcome card**, Claude Code's turning `✻` with a verb for the agent that is working ("Hammering…"), an orange `>`
    input with a shortcut hint, a pixel icon per agent on the stepper and per tool in the transcript, and a plain-words
    chip on every permission prompt (*runs a shell command*, *changes files*, *controls the browser*, *controls a
    desktop window*; taken from the tool's name, never its arguments; an unknown tool gets none). `?` opens help
    (shortcuts, options, credits); `t` flips to the tree, `m` cycles sound. While help is open no key can answer a prompt.
    The tab icon shows a lock when you are needed, a bolt while it works, a heart when done.
  - **The cat** lives by the input box, sways, dances while an agent works, and **when a permission prompt is waiting it
    runs to the prompt, stands on its top edge, hops until you answer, and says who needs you**, nudging after 20 s, 1
    minute and 3 minutes. Stars on success, slumps on failure, naps after 90 s. It covers at most 10 px of a prompt and
    never a button, honours reduced motion, and can be switched off (and stays off).
  - **The offline dinosaur**: when the page loses its server mid-run it shows "Can't reach agent-loop", counts attempts,
    offers *Retry now* and Chrome's dinosaur game (Space/↑ jump, ↓ duck, tap), and leaves by itself on reconnect with exactly
    one socket. Never for a finished run or a saved report.
  - **Sound, off by default** with no audio engine created while off: blips, or blips plus a quiet chiptune loop that follows
    the run (busier while an agent works, thinned out while something waits on you, stops 9 s after the run ends). All
    synthesised in the browser; a remembered setting waits for your first click; replayed history is silent.
  - **Pixel mouse cursors** (switchable), 18 of them with hotspots.
  - The art: 74 small PNGs and a manifest (under 60 KB) cut from the sprite sheets supplied for the project by
    `scripts/build-sprites.py`, served as one inline data script (`src/sprites.ts`, `/sprite-data.js`) so a saved report
    carries it and needs no network. `npm run check:sprites` validates a swapped sprite. **The cat's and cursors' licence
    status is unknown and the others have not been checked; see docs/ASSETS.md before publishing.**
  - Tests: `test/sprites.mjs`, `test/ui-mascot.mjs`, `test/ui-offline.mjs`, `test/ui-sound.mjs` (26 suites now). They
    measure rather than eyeball: the cat's feet are within 2 px of the prompt's edge, the hop is real motion, the dinosaur
    jumps and dies and reconnects, sound is audible and does not clip on the real output. The page also works, and prompts
    can still be answered, with sprites, the cat, the helper or every extra missing.
- **Captioned walkthrough videos of each feature, on GitHub** (README "Feature walkthroughs", `docs/media/`).
  Four recordings, each with a short looping GIF preview that GitHub shows inline and the full `.mp4` one click away:
  the lineage tree (59 s), the persona (79 s), desktop control in the web UI (51 s), and desktop control on a
  **real window under a virtual display** (54 s, filmed with ffmpeg off the screen: the chosen window, a
  terminal-named window beside it, what the agent sees, clicks and typing landing, a reused capture refused, a moved
  window refused). They cost nothing to remake: nothing calls a model. `test/e2e/record-features.mjs` drives the real
  page in a real Chromium on a controlled page clock (so a 36-minute run's header timer and timestamps agree), with a
  visible cursor and captions; `test/e2e/record-desktop-real.mjs` ends by checking from the windows' own logs that the
  chosen window got exactly what was sent and the terminal-named one received nothing, and fails (no video kept)
  otherwise. `npm run record:videos`, `npm run record:desktop-video`, `npm run record:previews`.
- **Lineage: the run as a tree of who did what** (docs/LINEAGE.md). The "git tree" idea from the start of the
  project: how the agents' work connects, and which agent made what. Built read-only from events the run already
  emits, deliberately not as a shared log agents write to (the research on OpenClaw found that is where multi-agent
  systems get races).
  - A node per phase attempt, in order, with its parent; repairs are branches on a second lane that rejoin;
    retries and further-back repairs are told apart.
  - What each attempt handed on (headline, details, concerns, blocking findings), the Overseer's call and reasoning,
    your decisions, cost, prompts, tool calls, browser and desktop actions, and the files it wrote. Only writes that
    succeeded are attributed; a refused write and a Bash redirect never are.
  - "Made by" per agent, and per file who touched it, in order.
  - The page's **tree** button; `agent-loop lineage [--run id|prefix|latest] [--json|--markdown]` for any recorded
    run; `lineage.md` and `lineage.json` written next to every run's report; the saved report opens to the same
    tree. The tree is published as a `lineage-updated` event (only the latest kept for late tabs and reports, not
    stored; rebuilding from the database gives the same tree).
  - Hostile and malformed input is cleaned and capped inside the builder; nothing it produces carries a control
    byte. `test/lineage.mjs` cross-checks every total against independent counts of the raw events on realistic runs;
    `test/ui-lineage.mjs` runs it in a real Chromium. 46 mutations, all caught; three survived at first and each
    showed a missing case.
- **The persona, evaluated on realistic runs and made much better** (docs/PERSONA.md). The first version was
  tested for safety, not for what a person would actually see. A deterministic simulator
  (`test/persona-sim.mjs`, shaped from numbers in real runs) showed:
  - none of the agents' own opening lines and none of the Overseer's vetoes were ever heard (a flat minimum gap
    between notes swallowed them, while the generic "X passed" filler took the slots);
  - the same template twice in one run, and a line that was wrong for the run ("Everyone before me said yes"
    after three vetoes);
  - nothing noticed the hour, the length of the run or how much it had done.

  Now: key moments always speak and seasoning is spaced, capped and often skipped; agents introduce
  themselves in their own voice and react to the one before; a veto is answered by the agent sent back, and the
  Overseer counts from the third; retries know the attempt number; lines can be for clean runs or repaired ones;
  the hour (night, early, Friday afternoon, weekend), half an hour and an hour in, the 100th and 250th tool call,
  prompts 25 and 50 are noticed; and the ending is followed by up to two awards from the run's own numbers (your
  average answer time, who was sent back most, who cost the most, who called the most tools, a run with no
  prompts). 209 lines across 56 moments, all still display-only and built from enumerated fields.
  18 mutations of the new logic: 13 caught; five survived and were resolved (two redundant guards deleted, one
  redundant type guard kept, two weak tests strengthened).
- **A persona, properly** (docs/PERSONA.md). The request was for jokes that give the run life: dark but
  not too dark, memes and git and politics, jokes about how the tool is used, with some bite that isn't
  toxic. What had shipped was ten dry idle lines, and a changelog line saying it was deliberately kept
  "not genuinely dark" — the opposite of the ask, decided without telling anyone. Now:
  - Six agents with temperaments (Planner: optimist with a spreadsheet; Test Designer: pessimist, usually
    right; Builder: ships first, explains later; Verifier: trust issues, professionally; Gatekeeper: a bouncer
    with a checklist; Overseer: holds the veto and uses it, and talks like a legislature: vetoes,
    amendments, points of order). Politics means the process, never a side.
  - 146 lines across 35 moments: the run, each phase, each Overseer decision, how the tool is used (a refusal
    and the third in a row, five approvals in a blink, a long wait, saved rules, every $1/$5/$20), tools
    starting and fences holding, an `insights` closing line that follows the numbers, and 20 idle lines.
  - `--humor off|dry|dark` (or `$AGENT_LOOP_HUMOR`), default dark. The run's level is a ceiling; the web page
    has a `jokes:` button that can turn it down, never up. The terminal shows it on a TTY or when asked for.
  - Safe by construction, and tested by trying to break it: it never reaches a model (import graph checked), it
    carries no untrusted text (hostile text in every field of every event type; every note is still exactly
    a catalog line), it's never inside an approval prompt (a real prompt at `dark` with notes on screen
    contains none of the lines), a bad line can't get in (a lint with its own control lines), and it can't
    break a run (closed store mid-run). 10 mutations on the code and 8 on the page were each caught; three
    survived at first and the tests were strengthened until they failed.
  - `test/persona.mjs` (14 checks, in `npm test`) and `test/ui-persona.mjs` (real Chromium, in `npm test`).
- **The real SDK and a real model, for the first time, dispatching tool calls through the real hooks.**
  The scripted fake SDK never emits a tool call, so nothing had shown what happens when a model is the
  caller. `test/desktop-real-sdk.mjs` (real driver, real window) and `test/browser-real-sdk.mjs` (real
  Chromium, an outside host counted on 127.0.0.2, with a control request proving the counter sees
  traffic) are opt-in (`npm run test:real-model-desktop`, `npm run test:real-model-browser`; a few cents
  on Haiku). They assert only what the gates guarantee (a refusal leaves the window untouched, one
  approval lands one click, an injected order on the page or the window title produces nothing) and print
  what the model chose. `docs/FLOW-COVERAGE.md` maps every flow to the test that proves it, and lists
  what isn't tested.
- **Desktop: the two paths that were only tested against a fake are now tested against the real thing.**
  - `test/desktop-real-tree.mjs`: `click` by ref against a **real accessibility tree** (a GTK window over
    AT-SPI with the real driver's element tokens). A click by ref presses the real button, a filled field
    shows `value="alice"`, what's typed into the password entry never reaches the model, a stale ref is
    refused. A mutation of the ref table fails it.
  - `test/desktop-real-cli.mjs`: the whole command line on the success path against a real window: the driver
    loads, the target resolves, the startup line names this app's real pid and title, the run finishes,
    `agent-loop insights` counts the session, and a name matching nothing fails before any run. A mutation of
    the CLI glue (forgetting to pass the resolved target to the pipeline) fails it.
  - **The real-desktop tests now wait for the window manager to actually be managing the display**, not just
    to have been started (`test/desktop-real-session.sh`: checks `_NET_SUPPORTING_WM_CHECK` with `xprop`,
    retries the window manager, fails with "no window manager came up" in under two seconds if it never
    does). One full run had the accessibility-tree test fail with the driver's "the window manager has not set
    `_NET_ACTIVE_WINDOW`" for twenty seconds, then passed on 14 reruns, including under load and with the
    window manager deliberately started late; the cause wasn't pinned down, so the harness now makes that state
    visible instead of leaving it to look like a driver fault. (If it happens again in CI the failure message
    says whether openbox was running.)
  - Found on the way: a GTK window at user-time 0 is never activated by the window manager, so every input is
    refused ("`foreground_unavailable`, no input was sent"). Safe, but it looks like "it doesn't work"; noted in
    the docs, and the test app calls `present()`.
- **Computer use, Stage 6: every desktop threat attacked with a real exploit**
  (`docs/ADVERSARIAL-REVIEW-STATUS.md`, findings 17-20). Real windows and processes under Xvfb + a window
  manager, through the real driver, checked by two apps that log everything they receive:
  - a window owned by a process named `xterm` and one run from a script named `gnome-terminal` are refused
    by real `/proc` identity, whatever the title says;
  - extra `windowId`/`pid`/`target` fields steer nothing (the decoy gets zero events);
  - a killed target replaced by a same-titled impostor, a window moved or resized after the capture, and a
    decoy that steals keyboard focus between the click and the typing each end with the adversary's log empty;
  - an overlapping red window contributes 0 red pixels to a capture;
  - with no window manager every input is refused by the driver and nothing arrives (capture still works);
  - a whole run without `--desktop-target` never loads the native driver (traced).
  Mutation checks against the real scenarios found a test that didn't test what it claimed (typing that named
  no window still passed because the target kept focus); fixed by stealing focus mid-sequence.
  `npm run test:desktop-real` runs all three real-driver files; CI does, with `REQUIRE_DESKTOP_REAL=1`.
- **Computer use, Stage 5: desktop visibility.**
  - **The approval prompt shows what is being approved.** The window, the exact action, and in the web
    UI **the window as it was captured**, with a marker on the exact spot a click would land (checked to
    sit at x/width, y/height of the image). Typed text is shown verbatim with newlines and tabs made
    visible and control bytes shown as `⟨0x1b⟩` rather than silently dropped. A click by element says what
    the element is. No "don't ask again", and the prompt says why.
  - **A Desktop panel**: target, latest capture, a gallery with pin and jump-to-live, capture and action
    counts. The saved report includes it.
  - **`agent-loop insights`** counts desktop sessions, captures, input actions sent versus stopped, and
    human approvals versus denials (joined through the approval request, so a Bash answer isn't mixed in).
  - **The terminal prompt** names the window, the action and the capture, and makes control bytes visible.
  - Tool labels for browser and desktop calls are one line with control bytes dropped.
  - `test/ui-desktop.mjs` drives the real UI in a real Chromium; 5 mutations of the UI (x/y marker swap,
    unescaped typed text, unescaped title, capture counted as an action, missing element description)
    each fail it. Real captures of a real native window are committed under `docs/screenshots/desktop/`.
  - Found while testing: the dock's `.body` is a flex row, so a prompt made of several blocks rendered
    them side by side; fixed with a single wrapper. The real-driver test raced the window manager's startup
    (the driver fails closed until it has set `_NET_ACTIVE_WINDOW`); it now waits for it.
- **Computer use, Stages 3-4: desktop tools for exactly one human-chosen window**
  (`docs/DESKTOP-AGENT.md`, `specs/computer-use/SPEC.md`). `--desktop-target "<app>"` lets builder and
  verifier see and operate one already-running native window through five tools (`capture`,
  `window_info`, `click`, `type_text`, `key`). The go/no-go for Stages 3-6 was recorded in the spec.
  - **Refused, before anything starts:** under `--no-approval`; for a blank name; for a name in the
    denylist (terminals, shells, IDEs, launchers, browsers, remote-desktop and password-manager
    windows). The native driver isn't even loaded; a module-resolution trace in the test proves it,
    with a positive control proving the trace can see it.
  - **Refused once the window is resolved:** anything whose owning process is in the denylist (by
    process name, executable, argv[0] and the interpreter's script, never the window title), an
    unidentifiable owner, or an ambiguous name.
  - **Every action is fenced.** Captures are single-use; identity (window, pid, owning program, bounds)
    is verified before dispatch and again after, and a failure locks the session; keys are an
    allowlist with no meta/super/cmd and no window-leaving chords; typed text refuses control and
    bidi characters; 60 actions and 120 captures per session.
  - **Input always asks.** `approvalPlan()` returns `null` for desktop input, so "don't ask again" never
    applies; the approval hook never auto-approves a desktop tool and denies all of them when approval
    is off.
  - **The driver adapter is deliberately narrow.** `@trycua/cua-driver` is an in-process native SDK with
    ~60 tools (clipboard, full-desktop capture, launch/kill app, hotkeys, config...). The adapter calls
    six things, every input names the window explicitly with foreground delivery, and a stand-in SDK
    with a trap on every other method proves the rest is unreachable. Pinned exactly as an optional
    dependency, integrity-locked, version-checked at load.
  - **Tested against the real thing.** `test/desktop-real.mjs` drives the real native driver, real X11
    input, a real window manager and a native Tk window under Xvfb, checking every effect through the
    app's own state file. CI runs it with `REQUIRE_DESKTOP_REAL=1` so a missing prerequisite fails.
  - 17 mutations of the built code (one per defence) each fail a test.
  - Two corrections to the spec found by running the driver: it is an in-process SDK, not an MCP
    server to spawn; and Linux `listApps` returns every process. Also the driver rejects `ArrowLeft`
    (it wants `Left`), which the adapter maps.
- **Computer use, Stage 1: browser tools that act on refs, screenshot points and tabs**
  (`specs/computer-use/SPEC.md`, reference in the new `docs/BROWSER-AGENT.md`). Eight tools join the
  original seven:
  - **Refs.** `inspect` now lists interactive elements as `[s4e3] button "Save" id="save-btn"`, with
    value, checked state and select options. `click`, `fill`, `press`, `hover`, `select_option` and
    `scroll` take a `ref` or a `selector`.
    - Each ref maps to a live element handle held in agent-loop, so page JavaScript can't forge one or
      re-point it.
    - Each line is described from exactly the element its ref resolves to. A test page that reverses
      `querySelectorAll` can't pair Alpha's ref with Gamma's name.
    - A ref is refused, never re-resolved, after a newer `inspect`, any navigation (pushState included),
      a tab switch, or the element being replaced, even by an identical clone.
    - Hostile names can't forge extra ref lines. Password values show as `(hidden)`.
  - **Screenshot-bound coordinates.** `screenshot` returns a `snapshotId` and captures in CSS pixels.
    `click_at` and `scroll_at` need that id, and they refuse:
    - an older screenshot's id;
    - a page that has since navigated, resized or scrolled;
    - a point outside the image.
  - **Tabs.** Popups join the session as `t2`, `t3`, and so on, handled by `list_tabs`, `switch_tab`
    and `close_tab`. A tab that closes itself falls back cleanly, and the last tab can't be closed.
    Each tab's video is saved; the first keeps its old `session-<id>.webm` name.
  - Terminal and web UI labels name what was acted on, e.g. `browser.click_at(120, 44 @ shot-3)`.
  - The phase prompt teaches the inspect → ref → act loop.
  - `test/browser-computer-use.mjs` covers Requirements 1–6 against real Chromium. Five mutations of
    the built code (drop the WebRTC script, drop the WebSocket gate, ignore navigation, ignore
    scroll, drop the tab cap) each make it fail. All 15 original browser tests pass unchanged.
- **`docs/BROWSER-AGENT.md`.** The source had cited it ("section 2", "section 3") since the first
  browser stage, but the file never existed in this repo's history. It now covers the tools, the
  session model, artifacts, the network boundary with evidence per layer, limits, events and known
  limitations. The section numbers match what the code cites.
- **`specs/computer-use/SPEC.md`**: a staged plan for computer use. Stage 1 is built (above).
  Stage 1 upgrades the existing localhost-only browser tools (accessibility snapshots with stable,
  staleness-checked element refs; coordinate actions tied to a specific screenshot; tabs). Stages
  3–6 add a single human-chosen desktop window through the same `cua-driver` both reference
  projects use, behind a human go/no-go. The threat model is grounded in two facts found in the
  current code while planning: the safety net only inspects the `Bash` tool's command, so desktop
  typing into a terminal would bypass every Bash protection (hence: terminals can never be a target);
  and non-Bash tools get "don't ask again" rules by bare tool name, so one approved desktop click
  would approve every later one (hence: desktop input always asks).
- **`agent-loop insights`**: a self-analysis CLI report over every run ever recorded against a
  `--dir`'s audit database — which phases get repaired most (and how often), total and per-phase
  cost, and which "don't ask again" rules actually get reused versus created once and never touched
  again. Built entirely from `Store.getInsights()` querying data already recorded for other reasons
  (phase attempts, verdicts, `usage`/`approval-auto-allowed`/`approval-resolved` events) — no new
  instrumentation, so it covers every run's history, not just ones made after some new tracking was
  added. Verified against a real fake-SDK scenario's actual audit database, not just synthetic test
  data, before considering it done. Regression test in `test/plumbing.mjs` asserting repair-count,
  cost, and rule-reuse aggregation are each exactly right, not just "some number came out."
- **`docs/RESEARCH-COMPUTER-USE-AND-MULTI-AGENT.md`**: read-only review of two real projects
  (`NousResearch/hermes-agent`, `openclaw/openclaw`) for computer-use and multi-agent-coordination
  ideas. Finding worth having in writing: both projects wrap the same third-party driver for
  desktop/OS-level control rather than implementing it themselves, and neither has moved past
  system-prompt-only defense against prompt injection from on-screen content — not something to
  borrow, a real open problem agent-loop would have to solve structurally before adding any desktop
  capability, the same way `browser-tools.ts`'s localhost check had to move from "checked once" to
  "enforced continuously." Also settles an open design question about multi-agent coordination: a
  real, shipping multi-agent system (OpenClaw's "swarm") solves "don't do duplicate work" through
  bounded, coordinator-mediated fan-out with structured outputs, explicitly *not* a shared mutable
  notebook between peer agents — its own docs warn that a shared log without lane contracts just
  coordinates chaos. No code changes from this round; agent-loop's phases still run strictly
  sequentially, so there's no concurrent-agents scenario for either idea to apply to yet.
- **Terminal transcript and approvals** (`src/terminal.ts`): the same transcript and prompt in the
  terminal, so a run can be driven without the browser. Whichever side answers first wins.
- **Saved run report**: every run writes a self-contained `report.html` next to its artifacts. It
  opens from disk with no server, and event text is escaped so it can't break out of the page.
- **Browser session video**: with `--browser`, the agent's session is recorded as `.webm`, shown in the
  UI and the report.
- **Cost tracking**: `usage` events per phase and Overseer call. The CLI prints the total, the UI shows
  it per phase.
- **`npm test`** and **CI** (`.github/workflows/test.yml`) run all 11 no-API suites, including real
  Chromium.
- **`test/e2e/record-run.mjs`**: records a real run as video plus per-phase screenshots and a summary.
- **A second "Desktop" theme for the run UI**, toggled from the header (persisted per-browser in
  `localStorage`): the same DOM, the same events, the same behavior as the default dark
  Claude-Code-terminal-style dashboard, just restyled -- light background, rounded avatar-badge
  transcript cards, sans-serif type -- via `:root[data-theme="desktop"]` CSS in `ui/index.html`, not
  a second implementation. Screenshot: `docs/screenshots/approval-ui/06-desktop-theme.png`.
- **Smoother motion throughout the UI**: new transcript blocks and the permission sheet ease in
  instead of popping in instantly; interactive elements (steps, options, buttons) transition instead
  of snapping; switching themes cross-fades colors. All of it collapses under
  `prefers-reduced-motion: reduce`. The permission dock/sheet is also translucent and
  backdrop-blurred in both themes (a macOS vibrancy look) instead of a flat opaque bar, so it reads
  as floating over the transcript rather than abruptly cutting it off when a prompt appears.
- **Which phase has an approval waiting is now visible without scrolling to the bottom dock.**
  Checked against `pipeline.ts`'s own control flow first (phases run strictly sequentially -- each
  one is `await`ed before the next starts -- so two *different* phases can never both have a pending
  approval; only real parallel tool calls within the *same* phase can leave several waiting at once).
  The active phase gets a count badge on the stepper, the exact tool-call line(s) get a soft
  accent-colored glow in the transcript, and the dock names the breakdown ("3 waiting — builder
  ×3") instead of a bare "1 of 3". Initially built with a harsh bright-yellow outline; redone in the
  same clay/orange accent already used for the brand mark and active-phase state, as a soft ambient
  glow rather than a hard ring, after review. Screenshot:
  `docs/screenshots/approval-ui/07-multiple-pending-approvals.png`.
- **The browser panel is now a live view with a full snapshot history, not a single frame that
  silently gets replaced.** Every `browser-snapshot` this run is kept (capped at 24) and shown as a
  gallery strip below the main image; clicking an older thumbnail pins the view to it and a
  "jump to live" control appears, so looking back at an earlier state doesn't fight the run for
  control of the display. A small pulsing dot next to "Browser · active" (and a slow breathe on the
  active phase's stepper icon) signals "still working" continuously between discrete WebSocket
  events, instead of the panel looking frozen until the next one arrives — the DOM-native
  equivalent of the persistent, dirty-flag-gated render loop a reviewed reference project
  (see `docs/INSPIRATION-POKEHARNESS.md`) uses a Pixi ticker for; here it's just CSS animation,
  which the browser's own compositor already runs independently of JS/events. New regression test:
  a hostile page `title`/`url` reaching the gallery's new `title` attribute sink stays inert text
  (`test/ui-render.mjs`).
- **A few rotating one-liners in the idle status line** instead of a single static "Waiting for a run
  to start." — picked by wall-clock time so they change every 8s rather than flicker per-tick.
  Deliberately dry/self-deprecating dev humor (commit messages, force-pushes, stale TODOs), not
  political and not genuinely dark (superseded: that was less than the request; see "A persona, properly" above) — this sits on the same screen as destructive-command approval
  prompts, so the tone stays professional rather than undermining what's actually being reviewed
  there.
- **`docs/INSPIRATION-POKEHARNESS.md`**: a friend's repo (a local desktop app visualizing coding-agent
  CLI sessions as animated walkers) was reviewed for ideas ahead of the live browser-panel work above.
  Documents what it does well, what's weak, and — honestly — separates what actually transferred (the
  render-loop idea, reimplemented as CSS animation, not ported code) from what didn't (its PTY-output
  scraping, which agent-loop has no use for since it already gets structured events; its battle-hit
  coalescing, which would hide information a dev tool's transcript needs to keep). No Pokémon theming
  anywhere in agent-loop — the visual language stays the existing dark-terminal/light-desktop look.

### Fixed
- **The "Files changed" panel listed writes that were refused** (`ui/index.html`). It recorded the attempt, so a
  write the human said no to (even one to a `.env`) showed up as a changed file. Found by putting it next to the
  lineage, which counts only writes that succeeded. It now waits for the result.
- **A finished run showed `0s` in the header until the first one-second tick** (`ui/index.html`), including in a
  saved report opened from disk. It now shows how long the run took, or had been going, straight away.
- **Test simulator numbered a second attempt twice** (`test/persona-sim.mjs`), which showed "builder, attempt 2"
  twice in the persona screenshots. Found by the lineage's cross-check of node counts against raw events.
- **A click that closes its own page was sometimes reported as an error** (`src/browser-tools.ts`). Found as a CI
  failure (run #38, `browser-computer-use.mjs`: a popup's "Close me" came back as "Stale ref ... no longer on
  the page"), after passing in every earlier CI run and locally. It is a race: Playwright can finish the click
  against a page that is already gone. A probe showed about one click in twelve failing even on a fast machine.
  `click`, `press` and `click_at` now report "Tab tN closed while this ran (most likely this click closed it)"
  instead, and only when the page really did close. Tested three ways: the exact error simulated, a control that
  the same error with the page still open is still an error, and 25 real self-closing clicks; each direction of
  the fix was broken on purpose and failed a test.
- **`npm test` no longer dirties the working tree.** `test/ui-render.mjs` rewrote four committed demo
  screenshots on every run, leaving binary diffs after each test run. It now only does so with
  `SAVE_UI_SCREENSHOTS=1`, like the new desktop UI test.
- The screenshot tool's base64 image data was dumped into the transcript, the log index and every
  WebSocket message.
- agent-loop's own git hooks ran an outdated copy of the scanner (3 of 19 secret formats). They're
  synced to Dev-Skill's hardened version.
- **`.githooks/pre-commit` and `.githooks/pre-push` only ever looked for a `python3` command.** Many
  Windows Python installs only add `python`, not `python3`, to `PATH`. Confirmed empirically: removing
  `python3` from `PATH` and leaving only `python` made the old hook fail outright (`python3 not
  found`, exit 1); the fixed hook tries `python3` then `python`, verifying whichever it finds is
  actually Python 3 (not a stray Python 2) before trusting it, and succeeds in the same scenario.
  Synced into dev-workflow's canonical hook scripts (`Dev-Skill/dev-workflow/scripts/hooks/`) and both
  installed copies (this repo's and Dev-Skill's own `.githooks/`).

### Security
- **Desktop: a timed-out input could still act later.** A driver call that didn't answer in time was reported
  as an error, but may complete afterwards -- past the single-use capture, the identity checks and the
  approval. A timed-out click, type_text or key now locks the session (a timed-out capture stays an error).
- **Desktop: nothing bounded what the driver handed back.** One huge window meant megabytes of base64 into
  the model's context per capture, and 120 of them ~1 GB on disk. Captures are now validated (a PNG, sane
  dimensions and bounds) and bounded (8 MB each, 192 MB per session) before anything is saved or shown.
- **The browser's local-only boundary leaked through WebSockets and WebRTC.** `context.route()`
  sees neither channel. Found by probing the channels Playwright documents it doesn't cover, against
  a listener on `127.0.0.2` (loopback, but not an allowed host):
  - A local page's `new WebSocket()` completed an upgrade to that host.
  - `RTCPeerConnection` sent it STUN packets over UDP (20 in one probe) and opened TURN connections
    over TCP.
  - Chromium's own `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` did not stop those,
    even to a non-loopback address.

  Fixes:
  - `context.routeWebSocket` closes non-local sockets with 1008 before they connect; local ones pass
    through natively.
  - An init script removes `RTCPeerConnection` in every realm before page scripts run. Verified in the
    main page, a fresh iframe read synchronously, `srcdoc`, `data:`, `blob:` and popups.
  - Service workers are blocked, per Playwright's own advice for request interception.
  - Popups are capped at 10 per session: a page opening 25 got 26 tabs before.

  The regression test runs a no-defence control first, which must register leaks, so a zero means
  blocked. With the gate in place it asserts zero packets across popup, child-tab fetch and WebSocket,
  WebSocket, WebRTC, service worker and beacon, while a local WebSocket still echoes.

  Tried and dropped: a dead-proxy backstop. Chromium sent loopback targets around it, so it couldn't
  be verified here.

  Known Playwright quirk, recorded in the doc: when a page opens two popups while a blocked socket is
  pending, the socket still ends `CLOSED` but the page's `close` event is dropped.
- **`export`/`set`/`declare`/`unset`/`alias`/`unalias`/`readonly` were missing from
  `bash-analysis.ts`'s `NEVER_RULE`.** These mutate shell state that outlives the one command they
  ran in — the exact same risk class the code already blocked for the *inline* `VAR=value cmd`
  prefix form, just in the broader, more persistent standalone form. Concretely: a human could
  approve a bland-looking `export NODE_OPTIONS=--require=/tmp/evil.js` (or `LD_PRELOAD=…`) once,
  either directly or by clicking "don't ask again," and — because the SDK's Bash tool keeps one
  persistent shell across calls in a session (confirmed via its own `CwdChangedHookInput`, which
  exists for the identical reason `cd` persists across calls) — every *already-approved* rule like
  `Bash(npm test:*)` would then silently run under that changed environment the next time it
  auto-approved, without the human ever reviewing the new behavior. Fixed by adding these to
  `NEVER_RULE`, so they always ask like `env`/`eval`/`exec`/`cd` already do. Regression test added
  (`test/bash-analysis.mjs`); all 11 suites (now 81 assertions) and 11 stress scenarios pass.
- **`agent-loop insights` could echo a raw terminal escape sequence to a real terminal.** The same
  vulnerability class as an earlier fix in `src/terminal.ts` (untrusted text reaching a real terminal
  unsanitized), in a code path that didn't exist yet when that fix landed. A "don't ask again" rule
  is built from real Bash command text (`bash-analysis.ts`), which doesn't strip non-Bash-meaningful
  bytes from a command word — confirmed empirically that a command containing a clear-screen/
  cursor-home sequence (`\x1b[2J\x1b[H`) that doesn't happen to fall on a Bash separator character
  survives into the stored rule string verbatim. `insights` then printed that rule with a plain
  `console.log`, with no sanitization at all — unlike the live approval terminal, which already
  strips control bytes before printing anything untrusted. Fixed by extracting `terminal.ts`'s
  private escape-stripping helper into a shared `src/text-safety.ts` (`stripTerminalControlBytes`)
  so the one regex that matters can't quietly drift out of sync between the two call sites, and
  applying it to every rule `insights` prints. Regression test (`test/insights-cli.mjs`) spawns the
  real CLI against a database seeded with a rule containing a real escape sequence and asserts no
  raw control byte reaches actual stdout, while the rest of the rule text still prints.

### Cross-platform audit
Reviewed the codebase for Linux/macOS/Windows portability, beyond the git-hooks fix above.
- Confirmed already fine: all path handling goes through `node:path` (`join`/`resolve`/`dirname`),
  `src/data-dir.ts`'s home-directory resolution uses `node:os`'s `homedir()`, the store uses Node's
  built-in `node:sqlite` (no native build step, no platform-specific binary), and
  `dev-workflow/scripts/check_staged.py`'s line handling (`splitlines()`) already normalizes
  `\r\n`/`\n`/`\r` uniformly.
- Documented rather than "fixed" (it isn't a bug in this codebase): the `Bash` tool itself requires a
  POSIX-ish shell, a Claude Agent SDK/CLI constraint — Git Bash or WSL on Windows, native on
  Linux/macOS. `src/bash-analysis.ts` is shell-syntax-aware, not OS-aware, so it behaves identically
  once a command reaches it. See the new "Platform support" section in `README.md`.

### Testing
Continued the same adversarial-review effort onto previously-unexercised paths; full findings and
what's still unreviewed are tracked in `docs/ADVERSARIAL-REVIEW-STATUS.md`, not duplicated here.
- **`store.ts`'s `searchLogs()`** — checked whether a phase's own free-text content could reach it
  and be interpreted as FTS5 query syntax rather than plain SQL (already safe via the parameterized
  placeholder). Moot: `searchLogs()` has exactly one caller in the whole codebase, a smoke test with
  the hardcoded literal `"fox"` — never the CLI, server, WebSocket handlers, or Overseer.
- **`overseer.ts`/`pipeline.ts`'s repair-target validation against a hallucinated *forward* target**
  (a failing `planner` but the decision claims `gatekeeper` needs the redo) had no test coverage at
  all before this. Added a fake-SDK scenario that hallucinates exactly this every turn
  (`test/stress/pipeline_logic.sh` case K) and asserted `gatekeeper` is never actually invoked. Held:
  both `overseer.ts`'s own bounds check and `pipeline.ts`'s `isValidRepairTarget` correctly reject it
  and fall back to a same-phase repair every time. All 11 suites and now 11 stress scenarios pass.
- **Cost-tracking accuracy across repair/retry loops** had zero coverage in the stress suite: the
  fake SDK (`test/stress/fake-sdk/sdk.mjs`) never yielded a `result` message at all, so
  `phases.ts`'s/`overseer.ts`'s usage-EMISSION code (as opposed to the UI's already-tested summing
  of hand-fed events) was never actually exercised under a real multi-attempt run. Fixed the fake SDK
  to emit a fixed $0.01 `result` per completed call, then made the check permanent and automatic —
  wired into `pipeline_logic.sh`'s shared `runit()` so every scenario's printed cost is checked
  against `0.01 × completed calls`, not spot-checked by hand. That check immediately caught two real
  bugs in itself before it was trustworthy: comparing against *attempted* calls instead of
  *completed* ones (falsely flagged `overseer-throws`, where the Overseer's call throws before its
  generator ever runs and correctly reports $0), and a `grep -c ... || echo 0` idiom that
  double-prints `"0\n0"` on a genuine zero-match file because `grep -c` already writes `0` to stdout
  before its exit status makes `||` fire. Both fixed and re-verified with a standalone repro before
  trusting the check; see `docs/ADVERSARIAL-REVIEW-STATUS.md` for the full trace. All 11 stress
  scenarios and the 80-assertion unit suite pass with the check in place.
- **This session's own new UI code** (the `phaseCounts` breakdown, the stepper's `wait-badge`) —
  traced both new `innerHTML` sinks rather than assuming they inherited the prior "every innerHTML
  write is escaped" finding automatically. The breakdown line passes through `esc()`; the stepper's
  per-phase label doesn't, but its only source is the hardcoded `PHASES` literal, never server or
  LLM-authored text — confirmed by reading the assignment, not inferred from the name.
- **`data-dir.ts`'s hash-based run-directory naming** — ran the real function against same-basename
  different-path inputs (got different hashes, so no accidental merge) and against four different
  spellings of the *same* path — trailing slash, `.`/`..` segments (got the identical hash each
  time, so `path.resolve()`'s normalization correctly prevents a real project's audit trail from
  silently splitting in two). A full collision between different projects needs both the sanitized
  basename and 64 bits of hash to match, which is infeasible by chance or by choice of `--dir`.
- **CI actually failed once for real** (run #16, the Desktop-theme commit) — found by checking
  GitHub Actions history after being asked whether the build had failed, not assumed green because
  later pushes passed. `npm test` failed at `test/plumbing.mjs:95` (a `record-decision` WS broadcast
  assertion); confirmed the failing commit touched only `ui/index.html`/docs/screenshots, so it
  could not have caused it. Root cause: a fixed `setTimeout(r, 200)` sleep followed by a single
  check of an asynchronously-populated events buffer — a structural race across a real WS→server→
  bus→SQLite-write→broadcast round-trip that will occasionally lose under a loaded runner, however
  rarely. Tried 35 times (15 idle, 20 under 4-core CPU saturation) without reproducing it locally —
  consistent with a rare CI-specific hiccup, not proof the pattern is safe. Replaced both occurrences
  in `test/plumbing.mjs`, and the equivalent one in `test/approval-server.mjs` (fixed to poll for the
  server's own `replay-complete` sentinel instead of guessing a duration), with a
  `waitFor(predicate, {timeoutMs})` poller. Left the short sleeps in `test/approval-rules.mjs` and
  `test/terminal.mjs` alone — checked that their target state is set synchronously in-process before
  any `await`, not across a real network/DB round-trip, so there's no equivalent race there. All 11
  suites (81 assertions) and 11 stress scenarios pass; re-ran the two fixed files 10 times each clean.
- **Two of the four documentation screenshots, and the demo-video `.mp4` conversion, weren't actually
  automated.** `06-desktop-theme.png` and `07-multiple-pending-approvals.png` were made with
  throwaway one-off Playwright scripts, run once and deleted — nothing would catch them going stale.
  The `.webm`→`.mp4` conversion was manual, unrecorded `ffmpeg` commands. Fixed by folding both
  screenshots into `test/ui-render.mjs`'s existing event sequence (already part of `npm test`/CI):
  the multi-approval shot drives three real parallel tool calls in one phase via
  `bus.requestApproval` and asserts the dock's "3 waiting" text first; the theme shot clicks the real
  `#theme-toggle` button and asserts `data-theme` actually changed. Added `test/e2e/convert-to-mp4.sh`
  for the video conversion, verified against a synthetic `ffmpeg testsrc`/`sine` `.webm` (no API
  cost) with `ffprobe` confirming real H.264/yuv420p+AAC output at the correct duration. All 11
  suites (83 assertions) and 11 stress scenarios pass.

### Security
- **A page opened by the browser tools could escape the Stage 1 local-only boundary.** A fresh
  adversarial pass on the Browser Agent (new code from this session, previously only checked by my
  own feature-correctness tests, never an independent attempt to break it) found one real gap and
  fixed it.
  - `open()`'s `http://localhost`/`127.0.0.1`-only restriction was checked exactly once, on `open()`'s
    own argument. Nothing stopped a page loaded from an allowed local origin from then navigating
    itself elsewhere via a link click, a JS redirect, a form submit, or a background fetch/XHR --
    none of those ever call `open()` at all. Confirmed empirically before fixing: a demo page with a
    link to a second server, clicked via `click()`, navigated the browser there with zero
    re-validation; pointed at a real external host, a background `fetch()` succeeded and a link click
    actually left the local origin.
  - Fixed by registering `context.route("**/*", ...)` on every browser session, aborting any
    navigation or sub-resource request -- from any page, at any point -- that isn't local. `open()`'s
    own check and the new route guard now share one function (`isAllowedBrowserUrl`) so they can't
    drift apart. Re-verified: the same scenario now shows the fetch failing and the click landing on
    Chromium's own blocked-navigation error page.
  - Checked and confirmed already safe, no code change needed: the `open()` URL regex against
    realistic bypass attempts (userinfo tricks, subdomain tricks, alternate loopback encodings,
    protocol confusion -- verified empirically against the real regex, not just reasoned about), and
    path traversal against `/artifacts/<runId>/<file>` (`server.ts` uses `path.join`, not
    `path.resolve`, which never lets a later absolute-looking segment escape the base directory --
    confirmed with a real request against a real server and a real secret file placed outside
    `artifactRoot`).
  - Added a screenshot cap (50 per session) as cheap hardening against a runaway or adversarial phase
    filling disk -- there was no size or rate limit at all before this.
  - New permanent regression tests (no LLM calls): the containment case, the traversal case (three
    different encodings against a real secret file), and the screenshot cap (50 real screenshots
    succeed, the 51st is refused). All existing suites and `pipeline_logic.sh` scenarios still pass.

- **A "don't ask again" rule for one package install silently covered every future one, including a
  malicious package.** Continuing the same adversarial pass onto the newly-merged approval "remember"
  rule engine (`src/bash-analysis.ts`, previously untested against anything beyond its own author's
  cases). Approving `npm install lodash` once saved the rule `Bash(npm install:*)` — a 2-word prefix
  that drops the package name entirely, because `install`/`add`-style subcommands weren't in the set
  that keeps a trailing argument (the way `npm run <script>` keeps the script name). Confirmed
  empirically: `analyzeBash("npm install lodash", …)` and `analyzeBash("npm install
  some-evil-package-that-postinstalls-malware", …)` computed the *identical* rule, and appending a
  second package to an already-approved install (`npm install lodash evil-pkg`) didn't change the
  rule either — the same collision holds for `pip install`, `yarn add`, `pnpm add`, `gem install`,
  `cargo install`, `go get`, and their `apt`/`brew`/`dnf`/`yum`/`conda` equivalents. Since a package
  manager's install/add/remove/update subcommand runs arbitrary third-party code named by its
  argument (postinstall scripts, `setup.py`, `build.rs`, `extconf.rb`…), and a rule can't be scoped
  safely here the way it can for a fixed, already-reviewed `package.json` script name, these now never
  produce a rule at all — always ask, the same treatment already given to `curl`'s remote URLs. New
  regression tests assert `plan()` is `null` for install/add/remove/update across all of the above
  package managers, including the two-package collision case, while confirming `npm run build` is
  untouched. All 11 suites and `pipeline_logic.sh` still pass.

- **The terminal transcript printed attacker-reachable content straight to the real terminal, raw
  control bytes and all.** Continuing the same adversarial pass onto `src/terminal.ts` (new,
  previously untested beyond its own feature tests). Bash stdout/stderr, file content, a curl
  response body, and the model's own turn text (which can echo any of those back) all flow into
  this transcript unsanitized -- and, worst of all, into the approval prompt body itself, the exact
  text a human reads before clicking "approve". Confirmed empirically: a `tool-result` summary
  and `assistant-text` carrying a raw OSC 52 escape sequence (which many terminal emulators honor
  as "write this to the system clipboard") reached the real output byte-for-byte; a `Write` tool's
  `content` carrying a CSI screen-clear sequence reached the approval prompt itself, meaning
  attacker-controlled file content could rewrite what the terminal displays while a human is
  deciding whether to approve it.
  - Fixed with a `strip()` that removes every C0 control byte except tab/newline and every C1
    control byte (0x00-0x08, 0x0B-0x1F, 0x7F-0x9F) -- removing every byte that can ever *start* an
    escape sequence, rather than pattern-matching specific known sequence shapes, which can always
    be incomplete. Applied at the source (`short()`, `rel()`, the approval prompt's `body`,
    assistant text, the run's task string, and a phase's verdict headline) so it always runs before
    our own intentionally-added color codes are wrapped around it, never after -- stripping the
    finished, colored string would have eaten our own escapes too.
  - Re-verified: the same OSC 52 / screen-clear payloads now render as inert visible text (no ESC
    byte, so no sequence for the terminal to interpret) in both the transcript and the approval
    prompt. New regression test (`test/terminal.mjs`) covers tool output, model text, and the
    approval-prompt body. All 11 suites and `pipeline_logic.sh` still pass.

- **A failed browser-session video save could leak a Chromium process and leave the run stuck
  "running" forever in the audit database.** Continuing the same adversarial pass onto
  `BrowserSessionManager.close()`'s video-recording lifecycle (new, from the newly-merged PR,
  previously only exercised by its own happy-path tests). `close()`'s `finally` block emitted
  `browser-session-ended` on any failure, but a `try/finally` doesn't swallow the original
  exception -- it still re-throws after the `finally` runs, skipping `session.browser.close()`
  entirely when the failure happened before that line. `pipeline.ts` calls `close()` as the
  *first* statement in its own `finally` block, with no try/catch of its own, ahead of
  `store.finishRun` and the `run-end` event -- so that escaped exception skipped those too,
  propagating all the way to `cli.ts`'s top-level handler. Confirmed empirically: forcing
  `video.path()` to throw (which it does by contract whenever a video wasn't actually saved -- a
  crash, a disk issue, a race, all realistic) left the real Chromium process connected
  (`browser.isConnected() === true`) after `close()` returned, and reproducing pipeline.ts's exact
  `finally`-block shape showed `store.finishRun`/`run-end` never running once the exception escaped.
  - Fixed by making `close()` structurally unable to throw: the video-artifact step is wrapped in
    its own try/catch (best-effort -- losing the recording is never worth losing the run's terminal
    state or leaking the browser below), and `browser.close()` itself is now also guarded so a
    failure there can't escape either. Both log to `console.error` instead of failing silently.
  - Re-verified: the same `video.path()` failure and a separate forced `browser.close()` failure
    both now leave `close()` resolving normally, the real browser actually closed
    (`isConnected() === false`), and `browser-session-ended` still emitted. New regression test
    (`test/browser-tools.mjs`) exercises both failure points against a real session's real browser.
    All 11 suites and `pipeline_logic.sh` still pass, with no leaked Chromium processes.

- **`--port 0` silently broke the approval UI.** Finished the adversarial pass on `src/server.ts`'s
  WebSocket/HTTP access control (`startServer`). The core threat model here was already soundly
  built and tested by the prior session -- DNS-rebinding Host headers, another site's Origin even
  while holding the valid token, no/wrong token, and path traversal against `/artifacts/` are all
  real, passing regression tests already, and re-running them found nothing wrong. But `port: 0`
  (a valid, non-negative `--port` value -- the standard Node/networking convention for "OS, pick a
  free port") broke it: `allowedHosts`/`allowedOrigins` and the printed URL were all built once from
  the *requested* port, never updated to the port the OS actually bound. Confirmed empirically:
  `startServer(bus, 0, {})` printed `http://127.0.0.1:0/#token=...` -- connecting to literal port 0
  fails (`ECONNREFUSED`) -- while the server was really listening on a different, never-surfaced
  port, so every legitimate connection attempt using the printed URL would also fail `hostOk`
  forever (it only ever allowed `"127.0.0.1:0"`/`"localhost:0"`).
  - Fixed by reading the real bound port from `server.address()` once `listen()`'s callback fires,
    and checking/printing that instead of the requested value. `allowedHosts`/`allowedOrigins` are
    now computed from a live variable rather than frozen into a `Set` before the real port is known.
  - Re-verified: `startServer(bus, 0, {})` now prints a real, reachable URL, and a client connecting
    with that exact URL's port and token succeeds. New regression test (`test/approval-server.mjs`)
    covers `--port 0` end-to-end. All 11 suites and `pipeline_logic.sh` still pass.

- **A dedicated adversarial pass on the UI and video/screenshot artifacts** (full report:
  `docs/LEAK-REVIEW-ui-video.md`) found one real leak and confirmed three other suspects already
  safe.
  - **Real, and already visible in this project's own public demo media**: the browser tool's
    `screenshot` result named the file's full absolute path (`Screenshot saved to <dataDir>/
    browser-artifacts/<runId>/screenshot-....png`), which flows straight into the transcript, the
    SQLite index, every WebSocket message, and any saved report. Unlike file-tool paths, this was
    never relativized. Confirmed by extracting frames from `docs/media/after-new-ui-real-run-5x.webm`
    and reading `docs/screenshots/approval-ui/04-after-real-run.png` -- both real, both already
    public -- which show the literal sandbox path this ran in. On a real user's machine the
    equivalent would be their own home directory/username.
  - Fixed: the tool now reports only the filename; the real path stays available internally via the
    `browser-snapshot`/`browser-artifact-created` events already emitted alongside it, which the UI
    already uses to build artifact URLs without ever rendering the raw path as text.
  - Checked and confirmed already safe: every other `innerHTML` write in `ui/index.html` is escaped
    (traced source-to-sink); `artifactUrl()`'s unescaped use in `href`/`src` is safe because its
    inputs are `encodeURIComponent`-ed and never user-controlled; `report.html`'s embedded event JSON
    is `<`-escaped against script injection (existing test); its output path is built from a
    server-generated UUID, not attacker-influenced.
  - New regression test (`test/browser-tools.mjs`): the screenshot tool's visible text must never
    contain a path separator; the real path (for verifying a real file was written) now comes from
    the internal `browser-snapshot` event instead. All 11 suites and `pipeline_logic.sh` still pass.
  - **Regenerated**: ran a fresh real `agent-loop run` (`test/e2e/record-run.mjs --browser --smart`,
    same task) and replaced both `docs/screenshots/approval-ui/04-after-real-run.png` and the "after"
    demo video with clean recordings from the fixed code -- confirmed by re-extracting frames that
    neither the base64 dump nor the path shows up any more. Updated `docs/UI.md`'s prose and stats
    table, `docs/screenshots/INDEX.md`'s descriptions, and added direct links to the demo recordings
    in `README.md` (previously only linked via the screenshots index).
  - **Re-encoded all three `docs/media/*.webm` demo clips to `.mp4`** (H.264, via a full `ffmpeg`
    install -- the sandboxed build bundled with Playwright only has a VP8/WebM encoder, no H.264 or
    MP4 muxer at all) for far more universal playback support than WebM. This is a one-time
    documentation change, not a product one: a real `agent-loop --browser` run still saves its own
    session recording as `.webm` -- that's Playwright/Chromium's native recording format, with no
    built-in transcoding step, and adding one for every real run wasn't asked for and isn't worth the
    per-run overhead. Verified duration-for-duration parity (`ffprobe`) and re-extracted frames from
    each new `.mp4` to confirm the content matches.

### Added (earlier)
- **Browser Agent Stage 2: real pipeline wiring + a live dashboard panel.** Stage 1's tools were
  registerable but unused; this actually plugs them in.
  - New `--browser` CLI flag gives `builder`/`verifier` a real browser MCP server for the run (off
    by default). `src/pipeline.ts` creates one `BrowserSessionManager` per run, scopes each run's
    screenshots under `<data dir>/browser-artifacts/<runId>/`, and always closes the session in its
    existing `finally` block — even after an unhandled pipeline error — so Stage 1's
    never-leak-a-Chromium-process contract holds at the pipeline level, not just inside
    `browser-tools.ts` itself.
  - `src/server.ts` gained `GET /artifacts/<runId>/<file>`, serving screenshots read-only, gated by
    the *same* per-run token as the WebSocket (screenshots can contain real page content, so they
    don't get the UI's own token-free static-file treatment).
  - `ui/index.html` gained a live **Browser** panel: latest screenshot (height-capped after actually
    looking at a real render and finding one that dominated the whole page), current URL/title, and
    session status, plus timeline cards for browser actions and artifacts.
  - **Caught a real regression before this shipped**: `browser-tools.ts`'s SDK imports broke *every*
    `pipeline_logic.sh` scenario, not just browser-related ones — the fake-SDK test harness
    blanket-redirects all `@anthropic-ai/claude-agent-sdk` imports to its own mock, which didn't
    stub `createSdkMcpServer`/`tool`. Fixed with shape-compatible passthrough stubs.
  - New `test/ui-render.mjs` (`npm run test:ui`, no API calls) drives the real dashboard with a
    synthetic event sequence covering every event type, including a real DOM click on Approve, and
    asserts zero console errors. Caught two more real bugs while writing it: `page.waitForFunction
    (fn, {timeout})` silently passes the options object as the wrong parameter (needs an explicit
    `undefined` arg first), so it was using Playwright's 30s default instead of the 5s intended; and
    driving the bus directly to avoid a real API call skips the real approval hook's own
    `approval-resolved` broadcast, which the test now emits itself. Also added a data-URI favicon to
    stop Chromium's automatic `/favicon.ico` probe from producing a spurious console 404 on every
    load.
  - Verified: all 7 unit suites and all 10 `pipeline_logic.sh` scenarios pass; `test:ui` run 4 times
    with zero flakiness. Real screenshots of both the tools and the full dashboard are in
    [`docs/screenshots/`](docs/screenshots/INDEX.md).

- **Browser Agent Stage 1: real Playwright tools a phase can call.** First step of the Cloud
  Browser Agent proposal, scoped to what's actually buildable without cloud infrastructure (no VM,
  domain, or auth here — that's Stage 3 and needs real infrastructure decisions).
  - `src/browser-tools.ts`: seven tools (`open`/`inspect`/`click`/`fill`/`press`/`wait`/`screenshot`)
    registered as a real in-process MCP server via the SDK's own `createSdkMcpServer`/`tool()` —
    confirmed against the installed SDK's own type definitions rather than assumed. Custom tools
    surface as `mcp__browser__*` in `tool_name`, the same field the existing safety/path-scope/
    sensitive-file/approval hooks already read, so a browser action gets the same treatment as
    `Bash` or `Write` with zero new hook plumbing.
  - `BrowserSessionManager` maps `runId` to a live Playwright browser/context/page so a session
    survives across agent-loop's separate per-phase SDK calls (each phase is its own session; the
    browser isn't). `close()`/`closeAll()` always emit `browser-session-ended` even after a worker
    error, so a leaked Chromium process or temp profile past the run can't happen from an exception.
  - Six new `AgentEvent` variants (`browser-session-started/ended`, `browser-action-started/
    completed`, `browser-snapshot`, `browser-artifact-created`) flow through the existing bus/store
    unchanged.
  - `open` is restricted to `http://localhost`/`127.0.0.1` only — one safe local demo page for this
    stage, not a domain allowlist.
  - Screenshots are written to disk (never SQLite) and returned to the model as both a file path and
    inline base64 image content.
  - Tested by calling the tool handlers directly against a real local demo page
    (`test/browser-tools.mjs`, `npm run test:browser-tools`) — deliberately not through the
    fake-SDK harness used elsewhere, which fakes only the top-level message generator and never
    actually dispatches a tool call to a registered MCP server, so it can't exercise real Playwright
    side effects. 12 checks against a real launched Chromium: DOM changes verified by an independent
    second `inspect()` call rather than trusting the tool's own success text, `wait` actually times
    out on a selector that never appears, `screenshot` writes a real PNG (checked by magic bytes),
    every action gets a matching started/completed event pair. Run 4 times with zero flakiness and
    zero leaked Chromium processes afterward.
- **The Planner can suggest skipping `test-designer` for a genuinely trivial task** — a narrow,
  bounded answer to "why is the pipeline always exactly 5 phases," deliberately not open-ended
  agent spawning. `SKIPPABLE_PHASES = ["test-designer"]` is a hard pipeline-code allowlist:
  `builder`/`verifier`/`gatekeeper` are never skippable, and `planner` can't skip itself. A new
  optional `suggestedSkip` field on the Planner's verdict is validated twice — once when parsed,
  once again by `pipeline.ts` before acting on it — the same double-check pattern already used for
  repair targets, so a suggestion is never trusted as-is. A skipped phase still gets a real,
  explicit "Skipped" phase record in run history, not a silent gap. Verified with a new
  `test/stress/pipeline_logic.sh` scenario: a trivial-task run drops from 10 LLM calls to 8, reaches
  `done`, and `test-designer`'s own prompt is confirmed never invoked (searched for in the call
  log). All 5 pre-existing unit suites and the other 8 pipeline scenarios pass unchanged.

### Fixed
- **`validate-dev-workflow.mjs` evaluator had 5 of its own weaknesses (F5-F9)** — the meta-question
  this script exists to answer (does `dev-workflow` actually trigger and get followed) is only
  trustworthy if the checker itself is airtight; the review found it wasn't. Not yet re-run
  end-to-end here (a full run spends real API tokens on one non-trivial session) — verified by
  syntax check and code review against each finding's exact claim instead.
  - **F5**: `settingSources: ["user", "project"]` loaded whoever's real personal skills into the
    experiment, and the Skill-tool check counted *any* invocation, not specifically dev-workflow's.
    Now `settingSources: ["project"]` only, and the check reads the actual invoked skill's identity
    from the tool input.
  - **F6**: the `/health` check accepted any 200 whose body loosely contained "status", "ok", or
    "up" as a substring. Now requires valid JSON, an actual status-indicating field, a numeric
    uptime-like field that increases across two calls a beat apart (proves live uptime, not a
    hardcoded value), and that the pre-existing `/ping` route still works. Replaced a fixed port and
    fixed 800ms sleep with a free-port probe and readiness polling.
  - **F7**: `git ls-files --error-unmatch` only proved a file was in the index, not that HEAD's
    content matched — a staged-but-uncommitted report passed. New `fileCommittedClean()` requires
    the file to exist at HEAD *and* have zero staged/unstaged diff.
  - **F8**: the script printed a pass count but never set a failing exit code. Now exits 2 on a
    harness failure (SDK result subtype wasn't "success"), 1 on any failed check, 0 only if all pass.
  - **F9**: push detection was a regex over the session's own Bash commands for "git push" —
    evidence of one specific attempt path, not enforcement. Added a real disposable bare git remote
    and checks its refs stay empty after the run; kept the Bash regex too, relabeled as an
    observational-only signal alongside the real enforcement.

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
