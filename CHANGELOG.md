# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
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

### Added
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
  political and not genuinely dark — this sits on the same screen as destructive-command approval
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
