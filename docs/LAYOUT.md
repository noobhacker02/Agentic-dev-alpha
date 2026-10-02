# Layout: what every file is for

Moved out of the README so the README can be read in one sitting. Nothing here changed.

| Path | What |
|---|---|
| `src/types.ts` | Shared types: phases, events, verdicts, decisions |
| `src/store.ts` | SQLite + FTS5 store (`node:sqlite`, no native build step) |
| `src/bus.ts` | Event bus: agent events out (persisted *and* broadcast), human approve/deny decisions in |
| `src/hooks.ts` | The `PreToolUse` hooks — the safety net and the approval-UI round-trip |
| `src/phases.ts` | The five phase system prompts + `runPhase()`, the actual `query()` wrapper |
| `src/overseer.ts` | Overseer decision logic (continue / retry / stop), decision-log-aware |
| `src/pipeline.ts` | Sequences the five phases, watches `DECISIONS.md`, applies Overseer decisions |
| `src/env.ts` | The minimal, allowlisted env passed to every phase and the Overseer instead of the full shell env |
| `src/data-dir.ts` | Resolves where the audit database lives — always outside `--dir` |
| `src/server.ts` | HTTP + WebSocket server: broadcasts events, receives decisions |
| `ui/index.html` | The live timeline + Approve/Reject UI (vanilla JS, no build step) |
| `ui/sprites.js`, `ui/mascot.js`, `ui/offline.js`, `ui/sound.js` | The page's extras, each optional (the page works without any): the pixel set as CSS, the cat that runs to whatever needs you and hops until you answer, the offline dinosaur, and sound generated in the browser — see [`docs/UI.md`](docs/UI.md), [`docs/ASSETS.md`](docs/ASSETS.md) |
| `ui/assets/`, `src/sprites.ts`, `scripts/build-sprites.py`, `scripts/check-sprites.mjs` | The sprites (74 small PNGs, under 60 KB) and their manifest, the validator, how they reach the live page and saved reports as inline data, and the script that cut them from the supplied sheets |
| `src/cli.ts` | `agent-loop run "<task>"` and `agent-loop insights` entry points |
| `src/text-safety.ts` | Strips terminal control/escape bytes before untrusted text reaches a real terminal — shared by `terminal.ts` and `cli.ts`'s `insights` report |
| `test/approval-server.mjs` | No-LLM test of the approval server's access control (token, Origin, Host) and pending-approval replay |
| `test/tool-and-path-scope.mjs` | No-LLM test of per-phase tool restriction, `--dir` path scoping, and `minimalEnv()` |
| `test/data-dir.mjs` | No-LLM test that the audit database always resolves outside `--dir` |
| `test/plumbing.mjs` | No-LLM test of the store/bus/server/WebSocket round-trip |
| `test/browser-approval.mjs` | Real end-to-end test: a live pipeline run with a real headless-Chromium browser clicking Approve |
| `test/resolve-skill-source.mjs` | Fetches the current `dev-workflow` skill (GitHub by default, local path as opt-in override) |
| `test/validate-dev-workflow.mjs` | The project's actual meta-goal: does `dev-workflow` trigger and get followed on an ordinary request? |
| `test/validate-decisions-log.mjs` | Does a genuinely ambiguous task get asked about once, and never re-asked once logged? |
| `test/insights-cli.mjs` | No-LLM test that `agent-loop insights` strips terminal control bytes from a stored rule before printing it |
| `src/run-control.ts` | The one switch that ends a run early (cost cap, Ctrl-C, SIGTERM, the page's Stop button): aborts the model sessions, refuses waiting approvals, saves the run as `stopped` |
| `src/doctor.ts` | `agent-loop doctor`: environment checks with injectable probes; tells apart no display / a dead display / a locked session / a missing, wrong or silent desktop driver |
| `ui/plain.js` | Plain mode: the one switch every cartoon (cat, pixel icons and cursors, dinosaur game, sound) obeys |
| `src/roast.ts`, `src/habits.ts`, `src/roast-api.ts` | What `insights` says about you: the numbers-only `Habits`, the catalogue and grade, and the optional model call |
| `test/roast.mjs` | The roast, offline and with a fake model: lint, determinism, canaries, validation, CLI |
| `src/browser-tools.ts` | The 15 browser tools, the per-run session manager, and the local-only network boundary — see [`docs/BROWSER-AGENT.md`](docs/BROWSER-AGENT.md) |
| `test/browser-tools.mjs` | Real-Chromium tests of the original browser tools: containment, the screenshot cap, `close()` never throwing |
| `test/browser-computer-use.mjs` | Real-Chromium tests of refs, screenshot-bound `click_at`/`scroll_at`, tabs, hover/select/scroll, and every leak channel (WebSocket, WebRTC, service worker, popups) against a counted non-allowed host, with a no-defence control run |
| `src/desktop-tools.ts`, `src/desktop-policy.ts`, `src/desktop-driver-cua.ts` | Desktop tools for exactly one human-chosen window: the five tools, the session that fences every action, the denylist and key/text rules, and the narrow adapter over the native driver — see [`docs/DESKTOP-AGENT.md`](docs/DESKTOP-AGENT.md) |
| `test/desktop-tools.mjs`, `test/desktop-adapter.mjs`, `test/desktop-cli.mjs`, `test/desktop-pipeline.mjs` | No-LLM, no-display tests of the desktop controls against a scripted fake driver and a stand-in SDK with traps on every method the adapter must never touch |
| `test/desktop-real.mjs` | The real native driver, real X11 input and a real native window under Xvfb + a window manager, verified through the app's own state file (`npm run test:desktop-real`) |
| `test/desktop-real-adversarial.mjs`, `test/desktop-real-nowm.mjs` | The desktop threat model attacked with real windows (an `xterm`-named process, a same-titled impostor, a moved window, a focus-stealing decoy, an overlapping window, a hostile title, no window manager); a decoy app logs everything it receives and must get nothing |
| `test/browser-real-sdk.mjs`, `test/desktop-real-sdk.mjs` | The **real SDK and a real model** dispatching browser / desktop tool calls through the real hooks into a real Chromium / real window; opt-in, a few cents (`npm run test:real-model-browser`, `npm run test:real-model-desktop`). What is tested and what isn't: [`docs/FLOW-COVERAGE.md`](docs/FLOW-COVERAGE.md) |
| `src/persona.ts` | The voice: six agents with temperaments who reply to each other, 209 lines across 56 moments, end-of-run awards from the run's own numbers, `--humor off\|dry\|dark`. Display only; it never reaches a model — see [`docs/PERSONA.md`](docs/PERSONA.md) |
| `src/lineage.ts` | The run's lineage: a git-log-like tree of every phase attempt, repairs as branches, who wrote which files, what each handed on, cost and prompts per attempt; the live tracker; text and markdown renderers — see [`docs/LINEAGE.md`](docs/LINEAGE.md) |
| `test/lineage.mjs`, `test/ui-lineage.mjs` | The lineage builder, tracker, store rebuild and command (totals cross-checked against the raw events, hostile and malformed input), and the tree view in a real Chromium |
| `test/persona-sim.mjs` | Deterministic event streams with the shape of real runs (a 6-minute typical run, a 36-minute run with three vetoes, a speed-approver, a failure, a 2:40 a.m. start), for judging the voice on something real |
| `test/persona.mjs`, `test/ui-persona.mjs` | The catalog lint (and a control that it can fail), levels, determinism, hostile text in every event field, the import graph, the terminal, `/persona.js`, saved reports, the CLI, and in a real Chromium: the toggle, the ceiling, an approval prompt with no jokes in it, inert hostile notes |
| `test/ui-desktop.mjs` | The real web UI: the desktop panel and every approval prompt (the click marker, typed text with visible control bytes), hostile titles inert |
| `test/sprites.mjs` | The shipped sprite set is sound; 11 kinds of wrong sprite are each reported; a `../` path in the manifest is never read; one bad entry drops only itself; an unreadable manifest yields an empty set; the server serves the same script a report inlines |
| `test/ui-mascot.mjs`, `test/ui-offline.mjs`, `test/ui-sound.mjs` | In a real Chromium, measured: where the cat stands in each state (feet on the prompt's edge, clear of every button), that it hops, naps and can be switched off; cursors and icons really applied; prompt labels; help-window keys never answer a prompt; the offline dialog against a real server that goes away and comes back (one socket, the game, Retry now); sound silent by default with no audio engine, never autoplaying, rate-limited, audible and not clipping on the real output; and every extra missing without breaking the page |

