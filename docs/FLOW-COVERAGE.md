# Flow coverage: what is tested, how, and what is not

Written 2026-09-30 from the tests in this repo, not from memory. "Real" means the thing itself (a real
Chromium, the real native desktop driver and a real window, the real Claude Agent SDK and a real model);
"fake" means a scripted stand-in.

## How the tests are grouped

| Where it runs | What | Cost |
|---|---|---|
| `npm test` (and CI) | 26 suites: stores, hooks, approval server, terminal, web UI in real Chromium, browser tools in real Chromium, desktop controls against a fake driver | none |
| `bash test/stress/pipeline_logic.sh` (and CI) | 11 pipeline edge cases with the scripted fake SDK | none |
| `npm run test:desktop-real` (and CI, `REQUIRE_DESKTOP_REAL=1`) | The real native driver, real X11 input, real window manager, real windows, under Xvfb | none |
| `npm run test:real-model-browser`, `npm run test:real-model-desktop` | The **real SDK and a real model** dispatching browser / desktop tool calls through the real hooks into a real Chromium / real window | a few cents each (Haiku) |
| `test/browser-approval.mjs`, `test/validate-*.mjs`, `test/e2e/record-run.mjs`, `test/stress/real_runs.sh` | Whole pipeline runs with a real model | about $1 a run; manual |

## Flow by flow

| Flow | Proven by | Real or fake |
|---|---|---|
| `agent-loop run`: five phases, Overseer, bounded repairs, terminal states | `test/plumbing.mjs`; `pipeline_logic.sh` (11 scenarios); `real_runs.sh` (4 real runs graded by hidden tests, 2026-09-24) | fake SDK in CI; real model manual |
| Decision authority (worker-written `DECISIONS.md` is never authority) | `pipeline_logic.sh` (`injected-decisions`); `validate-decisions-log.mjs` | both |
| Approval hook: safety net, path scope, sensitive files, read-only auto-allow, "don't ask again" rules | `safety-net`, `bash-analysis`, `approval-rules`, `tool-and-path-scope`, `approval-server` | none needed (pure logic, real hook chain) |
| Approval in the real web UI (a real click on a real Approve button) | `test/browser-approval.mjs` (real pipeline, real model); `ui-render.mjs`, `ui-desktop.mjs` (real Chromium) | real |
| Terminal approval prompt, saved report, `insights` | `terminal.mjs`, `report.mjs`, `insights-cli.mjs` | real |
| Browser tools, handler level: refs, `click_at`, tabs, hover/select/scroll, every leak channel (link, redirect, fetch, WebSocket, WebRTC, service worker, popup flood) | `browser-tools.mjs`, `browser-computer-use.mjs`, with a counted non-allowed host and a no-defence control run | real Chromium |
| **Browser tools driven by a real model through the real SDK** | `browser-real-sdk.mjs`: the model opens a page, inspects, clicks real buttons (the app's own server counts them); the page's link and its injected "visit this host" order reach nothing (control: the listener does see a direct request) | real SDK, real model, real Chromium |
| Desktop tools, handler level: target resolution, denylist, key and text rules, single-use captures, identity checks, caps, timeouts | `desktop-tools.mjs`, `desktop-adapter.mjs`, `desktop-cli.mjs`, `desktop-pipeline.mjs` | fake driver, stand-in SDK |
| Desktop against a real window: input lands, refusals deliver nothing, moved/resized/impostor/decoy/overlap/minimised, no window manager, real accessibility tree | `desktop-real*.mjs` (5 files) with an app that logs everything it receives | real driver, real window |
| Desktop CLI end to end (flag, startup line, session start/end, insights) | `desktop-cli.mjs` (refusals), `desktop-real-cli.mjs` (success path, real window, fake model) | real driver, fake model |
| **Desktop tools driven by a real model through the real SDK** | `desktop-real-sdk.mjs`: tool names match the hook prefix; capture and click both ask; a "no" leaves the window untouched; one "yes" lands exactly one click; a window title telling the model to type produced no input; a model that keeps asking after "no" stops getting prompts after three | real SDK, real model, real driver, real window |
| The persona: levels, the ceiling, hostile text in every event field, never inside an approval, never reaching a model, terminal/report/CLI/insights | `persona.mjs`; `ui-persona.mjs` (real Chromium); 18 mutations, all caught | real (nothing to fake) |
| The lineage: tree of attempts, repairs as branches, file attribution, handoff notes, cost/approval totals, `lineage-updated`, store rebuild, `agent-loop lineage`, `lineage.md/json`, the tree view | `lineage.mjs` (totals cross-checked against the raw events); `ui-lineage.mjs` (real Chromium); 46 mutations, all caught | real (derived from events; nothing to fake) |
| Web UI rendering, panels, prompts, hostile strings inert | `ui-render.mjs`, `ui-desktop.mjs` | real Chromium |
| The cat: where it stands in each state (feet on the prompt's top edge, clear of every answer button), that it hops, goes home when you answer, naps and wakes, can be switched off and stays off, reduced motion, hostile agent names inert | `ui-mascot.mjs` (positions measured in px; 8 mutations in the matrix) | real Chromium |
| Cursors, icons, tab icon, the plain-words label on each prompt, help-window keys never answering a prompt | `ui-mascot.mjs` | real Chromium |
| The offline dialog and dinosaur: debounced, attempts counted, game playable, reconnect leaves by itself with exactly one socket, *Retry now* clicked six times at once, never for a finished run or a saved report, phone width | `ui-offline.mjs` against a server that really goes away and comes back | real Chromium, real server |
| Sound: off by default with no audio engine created, never autoplays after a reload, rate-limited, follows the run, stops after it, silent for replayed history, audible and not clipping on the real output | `ui-sound.mjs` (an instrumented `AudioContext` and an analyser on the real output) | real Chromium |
| The sprites: the shipped set validates, 11 kinds of wrong sprite are each reported, a `../` path is never read, an unreadable manifest yields an empty set, the server and a saved report carry the same art | `sprites.mjs` | none needed |
| The page without its extras (no sprites, no cat script, no helper, no sound script, none of them) | `ui-mascot.mjs`, `ui-sound.mjs`, `ui-offline.mjs` | real Chromium |
| A saved report is one self-contained file (no network request, no external script, event text with `$'` `$&` intact) | `report.mjs` | real Chromium |

## What the real-model tests found

The scripted fake SDK never emits a tool call, so these only appear with a model as the caller.

1. **A model kept asking after "no".** Told no to a click, it asked for the same click eight more times,
   each a fresh prompt for a person to read and refuse. Fixed: after three desktop input requests in a
   row that a human refused, the model is told to stop and no fourth prompt is shown (`src/hooks.ts`,
   `MAX_CONSECUTIVE_INPUT_DENIALS`); one "yes" resets the count. Verified with the real model (3 prompts,
   then it stopped) and by mutation (the limit raised to 3000 fails the new test).
2. **`capture` asks too.** Nothing in a desktop session runs unasked until a human says "yes, don't ask
   again" to `capture` or `window_info`. This matched the docs; a test assumed otherwise and was corrected.

## Not tested, and why

| Gap | Why it matters | What would close it |
|---|---|---|
| **A whole `agent-loop run --desktop-target` with a real model**: all five phases, the Overseer, a person (or scripted browser) answering in the real UI | The real-model tests run one builder phase, not the pipeline. The pieces are each tested; the assembled run is not | One manual run (about $1-5 at the default model; the CLI has no `--model` flag). Not run without your say-so |
| macOS and Windows desktop; Wayland | The tested driver paths are Linux/X11. macOS needs permission grants; Wayland has no per-window input targeting | A runner on each OS |
| `ps` (macOS) and PowerShell (Windows) process-identity readers | Identity drives the denylist. Only the `/proc` reader is tested | The same runners |
| Composited desktops | Windows covered by another come back black on non-composited X; composited behaviour is unverified | A compositor in the virtual display |
| Toolkits other than GTK and Tk (Qt, Electron) | Their accessibility trees may differ | A test app per toolkit |
| Browser: DNS lookups from a page; refs only for the main frame | Possible side channel; iframe content needs `click_at` | A DNS-counting resolver; a per-frame ref design |
| One unexplained flaky GTK accessibility-tree run | Not reproduced in 14+ reruns; a readiness gate and clearer failure message were added, not a root cause | Keep CI history; investigate if it recurs |
| The Dev-Skill repo has no CI on branch pushes | Its checks run locally via its hooks and scripts, not on GitHub | A workflow |
| The UI extras in any browser but Chromium; on a real touch device; with a screen reader | Everything was driven in headless Chromium only | Firefox/WebKit runs; a person using VoiceOver/NVDA |
| The tab title alternating with "needs you" while the tab is hidden | A headless Chromium cannot be put in a background tab, so only the visible-tab title (`(1) approval needed …`) is asserted | A headed run with a second tab |
| How the sound *sounds*, and a real speaker | The tests measure notes, rate and peak level on the real output, not taste or a real device | You listening |
| The cat's and cursors' licence status; the dinosaur's and icons' terms | The sheets carry no artist or licence; nobody here checked the others (docs/ASSETS.md) | The owner confirming, or swapping the sprites |
| A model with no desktop or browser tools at all | Covered only by the fake-SDK wiring tests (tools absent from non-builder/verifier phases) | n/a |
