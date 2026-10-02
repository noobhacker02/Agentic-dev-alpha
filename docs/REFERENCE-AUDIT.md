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
| (PokeHarness has no automated tests) | | agent-loop has 34 suites in `npm test` | |

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
| Risk-classify actions; observation is cheap, input is expensive | **built** | `click`, `type_text`, `key` always ask and can never become a "don't ask again" rule; `capture` may. All desktop tools are denied with approval off | `test/desktop-tools.mjs` (approval) |
| Off by default as enforced config, not a UI toggle | **built** | Desktop tools exist only with `--desktop-target`; refused with `--no-approval`; the driver is an optional dependency pinned to one version and refuses any other | `test/desktop-cli.mjs`, `test/desktop-adapter.mjs` |
| Every action re-presents the frame identity of the latest screenshot | **built** | `snapshotId` is single-use; a moved or resized window, an older or invented id, a stale ref are all refused with nothing sent | `test/desktop-tools.mjs` ("fences"), real window: `test/desktop-real.mjs` |
| Hierarchical subagent spawn/await with limits | **not built** | The pipeline is sequential on purpose (`pipeline.ts` awaits each phase), so there is never a second agent to coordinate | n/a |
| Swarm: bounded parallel fan-out, children isolated, one coordinator reads structured results | **not built; your decision** | See below | n/a |
| (OpenClaw has no shared notebook between peers, and says coordination by shared mutable state invites races) | **followed** | The lineage tree (`docs/LINEAGE.md`) is derived read-only from events the run already emits; agents write nothing shared | `test/lineage.mjs` |
| Prompt injection from a window or page is an unsolved problem in both references | **built, beyond them** | Browser: localhost-only enforced at the network layer (including WebSocket, WebRTC, service workers). Desktop: one window, a denylist of terminals/shells/IDEs/launchers/browsers/remote-desktop/password managers by real process identity, window text treated as data, action caps, a human approving each action with what it will do. Threat table T1-T8 in `docs/DESKTOP-AGENT.md` | `test/browser-tools.mjs`, `test/desktop-tools.mjs`, `test/desktop-real-adversarial.mjs` (real exploits) |

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
- Stopping with the real Claude SDK: `test/stop.mjs` uses a stand-in that honours an abort the way the real one is documented to.
  `npm run test:real-model-stop` (opt-in, cents) runs the real one; see CHANGELOG for whether it has been run.
