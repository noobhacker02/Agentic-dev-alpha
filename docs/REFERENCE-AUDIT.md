# The three reference projects, audited: idea, code, test

agent-loop borrowed *ideas* (never code) from three public projects: **PokeHarness** (`mavericksxx/pokemon-harness`),
**Hermes** (`NousResearch/hermes-agent`) and **OpenClaw** (`openclaw/openclaw`). What each one does is in
[`INSPIRATION-POKEHARNESS.md`](INSPIRATION-POKEHARNESS.md) and
[`RESEARCH-COMPUTER-USE-AND-MULTI-AGENT.md`](RESEARCH-COMPUTER-USE-AND-MULTI-AGENT.md). This page is the audit of what came of it:
for every idea, where it lives in the code, which test would fail if it broke, and, for the ones not built, why.
It was written by going back through the code and running things, not from memory, and it lists what that found.

Status words: **built** (code and a test that fails without it), **adapted** (the idea, in a different shape because
agent-loop's data differs), **not built** (and why), **n/a** (solves a problem agent-loop does not have).

## PokeHarness

| Idea | Status | Where | What would fail |
|---|---|---|---|
| Repaint only when something changed; a cheap always-on "alive" signal instead of redrawing per event | **adapted** | CSS animations (`.live-dot`, the active step's icon) run on the compositor; the cat skips a move under 1 px; the favicon and tab title only change when their key does; **a replayed run now draws its chrome once** (`replaying` / `flushChrome()` in `ui/index.html`) | `test/ui-replay.mjs` (3,000 tool calls under 10 s and no worse than 14x the cost of 500; every call still present) |
| Hooks are authoritative, text scraping is the fallback, with a latch so they don't fight | **n/a** | agent-loop gets typed events over a WebSocket and never has to guess from terminal text | none needed |
| A backstop timer for the async race (a tool reports "done" before it is) | **adapted** | A tool call quiet for 30 s says "still running · 31s" (clock starts when you approve, never while it waits on you or if refused); a run that ends on a call that never answered marks it "no result · the run ended" (`updateStuck`, `markUnfinishedTools`) | `test/ui-stop.mjs` (the 30 s edge, the approval clock, refused calls, a late tab counting from the call's own timestamp, a saved report) |
| A capped auto-rebuild after a WebGL context loss | **adapted** | The WebSocket reconnects every 1.5 s; after 0.9 s without it a dialog says so, counts attempts, offers Retry, and leaves by itself with exactly one socket. It is **not capped**: it retries for as long as the page is open | `test/ui-offline.mjs`, `test/ui-cartoon-stress.mjs` (four server restarts in a row) |
| Merge rapid hits into one visual beat (battle event coalescing) | **not adopted, on purpose** | A tool-call log is an audit trail; merging real calls would hide information. Replay batching coalesces *drawing*, not events | `test/ui-replay.mjs` counts every tool call |
| Evolution timing decoupled from wall clock | **n/a** | nothing in agent-loop evolves. (The cat's 90 s nap and nudges are wall-clock by design) | none |
| File-by-file attribution of what was ported | **built** | `docs/ASSETS.md` credits every sprite sheet. **Open item for you:** the cat's and cursors' licence status is unknown and the dinosaur and Craftpix icons are unchecked; read it before publishing | `npm run check:sprites` validates files, not licences |
| (PokeHarness has no automated tests) | | agent-loop has 37 suites in `npm test` | |

## Hermes

| Idea | Status | Where | What would fail |
|---|---|---|---|
| Re-check authorization both before **and after** dispatching an action | **built** | `DesktopSession.verifyTarget()` runs in `gate()` (before) and in `afterDispatch()` (after); a window swapped in between is reported as "sent but unconfirmed" and locks the session (`src/desktop-tools.ts`) | `test/desktop-tools.mjs` ("a window swapped during dispatch…"); against a real X11 window `test/desktop-real-adversarial.mjs` |
| Tell "session locked", "no display" and "driver unhealthy" apart | **built in this audit** (it was a gap: a missing display and a dead driver both surfaced as "could not load" / "did not answer") | `src/doctor.ts` (`diagnoseDesktop`); `agent-loop doctor`; a desktop target that fails to start now prints which of: no display, a display that does not answer, a locked session, a driver that is missing / silent / the wrong version | `test/doctor.mjs` (every branch through injected probes, the real X11 probe against a real socket, the CLI) |
| A lease the human can take back mid-action | **partly** | Every input action is approved one at a time, showing the capture it targets, and three refusals in a row end the asking. There is no detection of a human grabbing the mouse; that would be the driver's job | `test/desktop-tools.mjs` (approval, three refusals); the gap is stated in `docs/DESKTOP-AGENT.md` |

## OpenClaw

| Idea | Status | Where | What would fail |
|---|---|---|---|
| An authorization ceiling fixed outside the model's reach | **built** | The one window is resolved from `--desktop-target` before the run exists; no tool changes it; none reads the clipboard, captures the full screen or manages windows | `test/desktop-tools.mjs` ("tool list: … no tool to change the target…") |
| Risk-classify actions; observation is cheap, input is expensive | **adapted, and stricter** | OpenClaw has three tiers (observation; ordinary input; a short list of high-risk families such as kill app, browser navigate/download, file input, recording, scope escalation). Ours has two: `click`, `type_text`, `key` always ask and can never become a "don't ask again" rule; `capture` may. The high-risk families do not exist here because those actions do not. All desktop tools are denied with approval off | `test/desktop-tools.mjs` (approval) |
| Off by default as enforced config, not a UI toggle | **built** | Desktop tools exist only with `--desktop-target`; refused with `--no-approval`; the driver is an optional dependency pinned to one version and refuses any other | `test/desktop-cli.mjs`, `test/desktop-adapter.mjs` |
| Every action re-presents the frame identity of the latest screenshot | **built** | `snapshotId` is single-use; a moved or resized window, an older or invented id, a stale ref are all refused with nothing sent | `test/desktop-tools.mjs` ("fences"), real window: `test/desktop-real.mjs` |
| Hierarchical subagent spawn/await with limits | **not built** | The pipeline is sequential on purpose (`pipeline.ts` awaits each phase), so there is never a second agent to coordinate | n/a |
| Swarm: bounded parallel fan-out, children isolated, one coordinator reads structured results | **not built; your decision** | See below | n/a |
| (OpenClaw has no shared notebook between peers, and says coordination by shared mutable state invites races) | **followed** | The lineage tree (`docs/LINEAGE.md`) is derived read-only from events the run already emits; agents write nothing shared | `test/lineage.mjs` |
| Prompt injection from a window or page is an unsolved problem in both references | **built, beyond them** | Browser: localhost-only enforced at the network layer (including WebSocket, WebRTC, service workers). Desktop: one window, a denylist of terminals/shells/IDEs/launchers/browsers/remote-desktop/password managers by real process identity, window text treated as data, action caps, a human approving each action with what it will do. Threat table T1-T8 in `docs/DESKTOP-AGENT.md` | `test/browser-tools.mjs`, `test/desktop-tools.mjs`, `test/desktop-real-adversarial.mjs` (real exploits) |

## OpenClaw's browser and computer-use controls, control by control

**Scope, said plainly.** The original research (`RESEARCH-COMPUTER-USE-AND-MULTI-AGENT.md`) read OpenClaw's `extensions/cua-computer` only. Its
**browser** extension (`extensions/browser`, nine documentation pages and a much larger surface) was never reviewed: our browser tools were designed from
`specs/computer-use/SPEC.md`, Playwright's documentation and adversarial testing, and they converged with OpenClaw on some points by independent
design. This section is the review done afterwards, against a clone at commit `7e6dd897` (2026-10-02), with the claims about our side checked by running
our tool handlers, not from memory. Verdicts: **equivalent**, **adapted**, **not built**, **deliberately different**.

### Browser

| OpenClaw | Ours | Verdict |
|---|---|---|
| `snapshot`: stable refs, a ref whose control disappeared fails | `inspect`: refs `s<snapshot>e<n>`, the snapshot number never repeats, refused when the page moved on (`test/browser-computer-use.mjs`) | equivalent |
| `act`: click, hover, select, press, fill, scrollIntoView, wait, clickCoords | `click`, `hover`, `select_option`, `press`, `fill`, `scroll`, `wait`, `click_at` (tied to one screenshot's id), plus `scroll_at` | built |
| tabs: list, open, focus, close | `list_tabs`, `switch_tab`, `close_tab`, popups join as tabs (capped) | built |
| `screenshot` | `screenshot` (50 per session) | built |
| `navigate` | `open` (localhost only) | adapted |
| `text`: readable page text up to 40,000 characters, snapshot `query` filter | `inspect` returns 3,000 characters of visible text and 40 elements | partial |
| **`errors`, `console`, `requests`**: collected page errors, console output, network log | **nothing is collected**. A page with an uncaught exception, a `console.error` and a 404'd script looks healthy through `inspect` (run, 2026-10-02) | **not built; the most useful gap** (see below) |
| dialogs: `inspect` / accept / dismiss hooks | `alert` is dismissed, `confirm` returns `false`, `prompt` returns `null`, and the click result says only "Clicked" (run). The agent is never told a dialog appeared | gap: silent |
| downloads: saved under a managed folder, metadata returned | a download link clicks "successfully" and nothing is kept or reported (run) | gap: safe, but silent |
| `evaluate`: arbitrary JavaScript, with a kill switch (`evaluateEnabled`) | none | deliberately not built (page-JS execution is what prompt injection steers) |
| `set_input_files` (high risk) | none: `fill` on a file input errors ("Input of type file cannot be filled") | deliberately not built |
| `drag`, `insertText`, `resize`, `batch` | none | not built; `batch` on purpose (every action asks on its own) |
| `emulate`: device, colour scheme, timezone, locale | none | not built (useful for responsive checks) |
| cookies, storage, headers, credentials, geolocation, permissions, offline, PDF, trace | none | not built; credentials and cookies on purpose |
| profiles: an isolated managed profile, **attach to your signed-in Chrome**, remote CDP (Browserless, Browserbase) | one fresh isolated context per run, nothing persists, nothing signed in is reachable | deliberately different |
| SSRF policy: block private networks, allow the public internet | **localhost only**: every request, WebSocket, WebRTC connection and service worker | opposite by design. OpenClaw's own docs list redirect hops, a popup's first request and service-worker traffic as not covered by its routing; ours blocks each, with a test per channel and a no-defence control run |
| `doctor`: gateway, plugin, profile, browser and tab readiness | `agent-loop doctor` checks that Chromium is found; no per-run readiness check | partial |

### Computer use (`cua-computer`)

OpenClaw's contract has 40 actions; ours has **five tools** (`capture`, `window_info`, `click`, `type_text`, `key`) by design: one human-chosen window.

- **Present:** screenshot with an accessibility-tree element list (`capture`), clicks (left, right, middle; single, double, triple), typing, keys with modifiers, window info.
- **Not built, and wanted for testing a GUI app:** `scroll`, `drag`, `wait`, `set_value` (more reliable than typing), `invoke_menu`, `zoom` (an observation).
- **Not built, on purpose** (each widens past "one window"): `launch_app`, `kill_app`, `bring_to_front`, `list_apps`, `list_windows`, `escalate_scope`, recording and replay, and the `browser_*` family.
- **Mechanisms:** the authorization ceiling fixed outside the model's reach (built; stricter, since OpenClaw lets the model *request* `escalate_scope` behind an approval and ours has no such action); risk classification (adapted, above); off by default as enforced config (built); every action citing the latest observation (built, stricter: the snapshot id is single-use and the window's identity is checked before and after).

### What to close first, in order of value for what this tool is for

1. **Console errors, page errors and failed requests** for the Verifier: it is asked to verify a web app, and today a broken app that renders a shell looks fine. Low risk (read-only, localhost-only).
2. **Tell the agent when a dialog was dismissed or a download was refused**, instead of reporting a bare "Clicked". Low risk.
3. Longer readable text and a `query` filter on `inspect`.
4. `resize` and `emulate`, for responsive checks.
5. Desktop `scroll`, `wait` and `drag`.

None of this is built yet; it is a list for a decision, not a claim.

## What this audit found by running things

Each of these is in the code now with a test; the first four were reproduced before being fixed.

1. **Ctrl-C left a run "running" forever.** Reproduced against the previous commit with a fake model that takes a while: SIGINT kills
   the process (exit by signal), the audit database still says `running`, no report is written, browser and desktop sessions are not
   closed. Fixed with `RunControl` (`src/run-control.ts`): Ctrl-C, SIGTERM, the page's **Stop** button and the new `--max-cost` all
   end the run the same way: the model sessions are aborted, waiting approvals are refused, the run is saved as `stopped` with the
   reason and the report is still written. A second Ctrl-C quits at once. `test/stop.mjs`, `test/ui-stop.mjs`.
2. **Opening a long run froze the page** (6,000 events: 29.6 s). The page redrew its chrome after every replayed event. Now 2.2 s.
3. **A run longer than the bus history lost its beginning**: the oldest events were dropped, and they were `run-start` and the first
   `phase-start`s, so a reload showed a run with no task. Trimming now drops tool chatter first. `test/bus-history.mjs`.
4. **`agent-loop insights` died on one corrupt event row**, could print a negative total, and printed a phase name unfiltered.
5. A model call aborted while an approval was waiting left the approval in the bus (found by reading `raceWithAbort`; a late tab
   would have been shown a dead prompt). Stopping now refuses every waiting approval. Covered by `test/stop.mjs`; not reproduced
   against the old code.
6. **A browser whose clock differs from the server's** (a forwarded port, a phone) would have shown false "still running" labels
   and wrong elapsed times, because the page compared the server's timestamps with its own clock. The page now estimates the
   difference from live events. `test/ui-stop.mjs` (7 minutes ahead and 7 minutes behind). Only simulated, not tried across two machines.
7. In plain mode the turning glyph still turned (the dock drew it separately); found by a test written to kill a surviving mutant.
8. `doctor` first reported "No display" as a blocking error for someone not using desktop control; now it blocks only with
   `doctor --desktop`.

## Not built, and the one decision that is yours

**Swarm / parallel fan-out.** OpenClaw's strongest idea is bounded parallel children reporting structured results to one
coordinator. agent-loop's phases depend on each other (the builder needs the plan, the verifier needs the build), so the only
place it would help is **parallel read-only reviewers inside the Gatekeeper** (for example a security reviewer and a
test-quality reviewer, each returning structured findings the Gatekeeper reads). They would never write, so there is nothing to
race on. The cost is real: each reviewer is another model session, so a run costs more and takes more code (a bounded pool, a
schema for findings, partial failure handling). It is not built because it is a spending and complexity decision, not a bug fix.
Say the word and it can be added behind a flag (`--reviewers 2`), off by default.

## Still unverified

- macOS and Windows desktop control (Linux/X11 is the only platform tested against a real driver).
- Sound has never been heard by a person; it is measured (audible, not clipping) in a headless browser.
- The cat's and cursors' licences (above).
- Stopping with the real Claude SDK: `test/stop.mjs` uses a stand-in; `npm run test:real-model-stop` (opt-in, cents) was run once
  against the real one on 2026-10-02 and passed. A query aborted in flight ended with an abort error about 2 s later (SDK teardown),
  leaving no child process; the real pipeline stopped 6 s into the Planner was saved as `stopped` 8 s in, in order, with no Overseer
  model call. It also showed the stand-in was wrong in one detail (the real SDK throws a plain `Error`, not an `AbortError`), which
  the pipeline never depended on (it decides by the run's own stop flag) and which the stand-in now matches. Two more situations were
  added afterwards (`test/stop-real.mjs`, parts C and D): **a real approval waiting** (the model asked to write a file, Stop arrived
  0.7 s later: the approval was refused, the run saved as stopped) and **a real shell command running** (the Builder ran `sleep`; Stop
  arrived 2.5 s in: no process left running the command two seconds later). Honest record: the first run of the extended test exited 1
  for a reason I did not capture; three later runs passed. So the four situations are a query aborted while writing, the Planner
  mid-run, a waiting approval, and a running command; not covered: every other moment of a model's answer, and a stop during a
  browser or desktop tool call.
