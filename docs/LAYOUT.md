# Layout: what every file is for

Moved out of the README so the README can be read in one sitting. The rows after the first block were added with the S0 to S3a work and adversary rounds 1 and 2.

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
| `src/browser-tools.ts` | The 18 browser tools, the per-run session manager, and the local-only network boundary — see [`docs/BROWSER-AGENT.md`](docs/BROWSER-AGENT.md) |
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
| `src/net-gate.ts` | The forward proxy every browser request goes through (the local-only boundary): checks each hop, resolves names itself, tunnels CONNECT and WebSocket upgrades |
| `src/bash-analysis.ts`, `src/readonly-shell.ts` | Which shell commands run without asking: the tokenizer and the allow-list of safe forms (a command that can write, run code or read outside `--dir` asks) |
| `src/path-canon.ts` | Real locations: links followed, `~` expanded as the file tools do, forms the check cannot place refused; shared by the path and credential hooks |
| `src/fatal.ts` | Last-resort handlers: an error nothing caught stops the run through the ordinary path instead of killing the process |
| `src/report.ts` | The self-contained `report.html` a run writes |
| `src/team/roster.ts`, `plan.ts`, `signals.ts`, `compose.ts`, `scan.ts`, `cli-commands.ts` | S3a part one: the 19 roles as data, the plan validator, signals from words and paths, the offline composer, the paths-only repository scan, and `agent-loop roster` / `team --dry-run` (design: [TEAM-COMPOSITION.md](TEAM-COMPOSITION.md)) |
| `src/team/role-spec.ts`, `write-scope.ts`, `verdict-text.ts` | S3a part two, increment 2.2a (IMP-021): a role's SDK tools, browser and desktop access and prompt from its definition; the write-scope hook (V7, V8 at the moment of a write); the verdict instructions every step ends with |
| `src/browser-policy.ts` | S2 (IMP-027): `BrowserPolicy`, the one object the browser tools ask what may be opened, requested, connected to and shown: TEST mode (this machine only, the default) and LIVE mode (the allowances list) |
| `src/allowances.ts` | S2 (IMP-026): the allowances list, the public-address rule, the LIVE policy for the network gate and the navigation check; used by `src/browser-policy.ts` |
| `src/profile.ts` | S2 (IMP-028): the agent-only browser profile: `<home>/profiles/<site>` (0700, not a link, not inside the working directory or `--dir`), its crash- and reboot-safe lock (pid plus process start time), and removal of Chromium's leftovers once their owner is gone |
| `src/login.ts` | S2 (IMP-028): `agent-loop login <site>`: the person signs in once in a window that keeps its profile in the agent-only directory, behind the LIVE gate; nothing they type or the cookies are read |
| `src/uploads.ts` | S2 (IMP-029): the files the user designated for upload (`uploads.json`: a name, an absolute path, a document or image type, an optional size and SHA-256 pin) and `resolveUpload`, which turns the name the model gave into a regular file at the moment of use or says why not; used by the `upload` browser tool |
| `src/team/cli-run.ts` | S3a part two, increment 2.2b part 2a (IMP-023): `--team auto|fixed5|<plan file>` for `agent-loop run`: validates the value, composes or loads and finalizes the plan, and returns the team, its repair budget and what to print, or an error with its exit code, before anything starts |
| `src/team/run-plan.ts`, `changes.ts` | S3a part two, increment 2.2b (IMP-022): the plan-driven run (steps in validated order, repair by step id, reports saved from verdicts, budgets, stop) and the before/after tree snapshot the diff audit uses to close Bash |
| `scripts/checkpoint.mjs` | `npm run checkpoint`: stage, scan, commit and push both repositories (designated branches, expected origins, never `--no-verify`) |
| `scripts/handoff-check.mjs`, `scripts/run-suites.mjs` | The handoff freshness check; every suite on its own with a timeout (what the macOS and Windows jobs run) |
| `bench/` | The benchmark: `run.mjs`, the suites under `bench/suites/` (`observability`, `form-coverage`, `browser-honesty`, `safety`, `shell-readonly`, `file-hooks`, `team-invariants`, `team-sizing`, `adversary-yield`), `baseline.json`, `latest.json`, `results/`, and the integrity checks (`baseline-check.mjs`, `doc.mjs`, `adversary.mjs`, `improvements.mjs`); see [BENCHMARK.md](BENCHMARK.md) |
| `.githooks/` | The pre-commit and pre-push secret and destructive-command scanner (a copy of the dev-workflow skill's; the Dev-Skill repository checks the copies match) |
| [`docs/IMPROVEMENTS.md`](IMPROVEMENTS.md), [`docs/BENCHMARK.md`](BENCHMARK.md), [`docs/SELF-HEALING.md`](SELF-HEALING.md), [`docs/HANDOFF.md`](HANDOFF.md), `docs/adversary/` | Why and how each improvement was made and what it moved; the generated benchmark table; how work and the product recover and the mistakes made twice; the state of the work for the next session; the adversary rounds and their triage |
| [`docs/HYBRID-AGENT-SPEC.md`](HYBRID-AGENT-SPEC.md), [`docs/HYBRID-AGENT-THREATS.md`](HYBRID-AGENT-THREATS.md), [`docs/TEAM-COMPOSITION.md`](TEAM-COMPOSITION.md), [`docs/REEL-FLOW.md`](REEL-FLOW.md) | The goal, its threat model with one test per row, the dynamic team design, the reel flow design |
| `test/` (the rest) | One file per suite in [TESTING.md](TESTING.md); shared helpers are `ui-extras-helpers.mjs`, `desktop-real-helpers.mjs` and `fake-desktop-driver.mjs`; the scripted fake SDK is `test/stress/fake-sdk/` |
