# Flow coverage: what is tested, how, and what is not

Written 2026-09-30 from the tests in this repo, not from memory. "Real" means the thing itself (a real
Chromium, the real native desktop driver and a real window, the real Claude Agent SDK and a real model);
"fake" means a scripted stand-in.

## How the tests are grouped

| Where it runs | What | Cost |
|---|---|---|
| `npm test` (and CI) | 18 suites: stores, hooks, approval server, terminal, web UI in real Chromium, browser tools in real Chromium, desktop controls against a fake driver | none |
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
| Web UI rendering, panels, prompts, hostile strings inert | `ui-render.mjs`, `ui-desktop.mjs` | real Chromium |

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
| A model with no desktop or browser tools at all | Covered only by the fake-SDK wiring tests (tools absent from non-builder/verifier phases) | n/a |
