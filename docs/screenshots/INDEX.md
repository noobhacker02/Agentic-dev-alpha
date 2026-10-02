# Screenshots index

Real screenshots of how things actually look, kept in the repo so they're reviewable by anyone
looking at the project — not just described in prose. Every image here comes from an actual run
against real code (the browser tools, the approval UI, etc.), never mocked up.

Convention: one subfolder per feature/component, files numbered in the order they were taken within
that folder, a one-line description added to this index whenever an image is added or replaced.

## browser-agent/

Screenshots from the Browser Agent tools (`src/browser-tools.ts`).

| File | What it shows |
| --- | --- |
| `02-built-todo-app-graded.png` | A todo app agent-loop built in a real `--browser` run, captured by the hidden grader (`add`, `delete`, reload persistence, XSS input rendered as text) after the run — 9/9 checks passed. |
| `01-open-fill-click-screenshot.png` | Stage 1 demo: `open` → `fill` → `click` → `screenshot` driven directly against a real local demo page, captured by the real `screenshot` tool handler (not a mockup). |

## approval-ui/

Screenshots of the run UI (`ui/index.html`). See [`docs/UI.md`](../UI.md) for the full before/after.

| File | What it shows |
| --- | --- |
| `01-full-dashboard-with-browser-panel.png` | The redesigned UI rendered by `npm run test:ui` from a synthetic event sequence: phase stepper, Claude Code-style transcript, side panel with the live browser. Regenerated with `SAVE_UI_SCREENSHOTS=1 npm run test:ui` (a plain test run leaves the committed files alone). |
| `02-permission-prompt.png` | The same test with a permission prompt pinned to the bottom (1 / 2 / 3). Regenerated with `SAVE_UI_SCREENSHOTS=1 npm run test:ui`. |
| `03-before-real-run.png` | The **old** UI mid-way through a real run (todo app, `--browser`): raw verdict JSON, one card per event, no progress, cost or pending indicator. |
| `04-after-real-run.png` | The **new** UI from a real run of the same task, showing the `browser.screenshot()` result after two leaks found by later adversarial review were fixed: the raw base64 image data (now `[image]`) and the tool's full local filesystem path (now just the filename) — see `docs/LEAK-REVIEW-ui-video.md`. Regenerated 2026-09-28; the original version of this file showed both bugs. |
| `05-saved-report-with-agent-video.png` | A real run's saved `report.html` opened from disk: all phases green with per-phase cost, and the agent's own recorded browser session. |
| `06-desktop-theme.png` | The same synthetic sequence as `01`/`02`, after clicking the header's theme toggle: the opt-in "Desktop" theme (light, rounded avatar-badge cards, sans-serif) instead of the default dark terminal look. The permission sheet is translucent and backdrop-blurred (macOS vibrancy style) rather than a flat opaque bar -- visible here in the blurred card edge behind it. Persisted per-browser in `localStorage`; the default theme and all other screenshots here are unaffected. |
| `07-multiple-pending-approvals.png` | Several real parallel tool calls in one phase, all waiting; the dock names how many and which phase. Regenerated with `SAVE_UI_SCREENSHOTS=1 npm run test:ui`. |
| `08-desktop-approval.png` | A desktop approval: the window (process, pid, title), the exact action (`Click at (105, 65)`), and **the window as it was captured** with a marker on the exact spot the click would land. No "don't ask again" option, and the prompt says why. Rendered by `npm run test:ui-desktop` with `SAVE_UI_SCREENSHOTS=1`, from a real capture of a real native window (`desktop/01-window-capture.png`). |
| `09-desktop-panel.png` | The same UI after the session: the Desktop panel (target, latest capture, gallery of captures, capture and input-action counts) and the transcript lines `desktop.click(105, 65 @ dshot-2)`, `desktop.type_text(…)`, `desktop.key(ctrl+shift+z)`, each with its approval state. |

| `07-multiple-pending-approvals.png` | Three tool calls from one assistant turn (real parallel tool use) all awaiting approval at once, all in `builder` -- checked against `pipeline.ts`'s own control flow first: phases run strictly sequentially, so two *different* phases can never both have something pending, but one phase legitimately can have several. The active phase gets a count badge on the stepper, each waiting call gets a soft accent-colored glow in the transcript (not a full outline), and the dock names the breakdown ("3 waiting — builder ×3"). Same clay/orange accent used for the brand mark and active phase, not a separate alarm color. |

## ../media/

Real runs recorded as video by `test/e2e/record-run.mjs`, sped up and re-encoded to stay small.

| File | What it shows |
| --- | --- |
| `before-old-ui-real-run-5x.mp4` | Old UI, todo-app task, 53 approval clicks, 5× speed. |
| `after-new-ui-real-run-5x.mp4` | New UI, same task, 13 approval prompts, 5× speed. Regenerated 2026-09-28 after the path-leak fix (`docs/LEAK-REVIEW-ui-video.md`); the original recording showed the pre-fix leaked path. |
| `agent-browser-session-2x.mp4` | The agent's own browser session testing the app it built, recorded automatically with `--browser`, 2× speed. |

## desktop/

Real captures from the desktop tools (`src/desktop-tools.ts`), taken by running `test/desktop-real.mjs` with
`SAVE_DESKTOP_DEMO=1` against the real native driver, a real window manager and a real native window under
Xvfb. Each is exactly what the `capture` tool returns: the target window's pixels and nothing else. The
test app shows only its own widgets and title, so there is nothing else in frame to leak.

| File | What it shows |
| --- | --- |
| `01-window-capture.png` | The tiny native test window (`test/desktop-app/app.py`) as the `capture` tool returns it: 420x260, the window only, not the 1280x800 screen it sits on. |
| `02-window-after-typing.png` | The same window after the real `click` and `type_text` tools pressed its button and typed "hello" into its entry. |

## `persona/`

Captured by `SAVE_UI_SCREENSHOTS=1 node --experimental-sqlite --no-warnings test/ui-persona.mjs`, from a realistic
simulated run (`test/persona-sim.mjs`) played through the real director, server and page in a real Chromium
(`docs/PERSONA.md`).

| File | What it shows |
| --- | --- |
| `01-voice-in-the-transcript.png` | A run part-way through at `jokes: dark`: the Overseer's veto and the agent's reply, and an approval prompt at the bottom with none of it in. |
| `02-end-of-run-and-awards.png` | The end of the same run: the ending line, then the awards the run's numbers earned. |
| `03-dry-level.png` | The same page after turning it down to `jokes: dry`: the dark lines are hidden, the dry ones stay. |

## `lineage/`

Captured by `SAVE_UI_SCREENSHOTS=1 node --experimental-sqlite --no-warnings test/ui-lineage.mjs`, from a clean
simulated run played through the real tracker, server and page in a real Chromium (`docs/LINEAGE.md`).

| File | What it shows |
| --- | --- |
| `01-tree.png` | The tree view: attempts in order, the repair as a branch with its fork and merge, what each attempt handed on, the Overseer's calls, files written (a refused write is counted, not listed) and the side panel's matching list. |
| `02-made-by-and-files.png` | The foot of the same view: the per-agent table and which attempts touched each file. |


## ui-v3/

The redesigned run UI (welcome card, pixel icons, the cat, the offline dinosaur, help, both looks, a phone, the stop button and its aftermath, a trimmed history). Regenerated by
`npm run shots:ui` from scripted events through the real server into the real page; nothing calls a model. See
[`docs/UI.md`](../UI.md) and [`docs/ASSETS.md`](../ASSETS.md).

| File | What it shows |
| --- | --- |
| `01-welcome.png` | The welcome card before any run: the five agents with their icons, four tips, the cat standing on the card. |
| `02-needs-you.png` | An approval waiting: the cat on the prompt's top edge (caught mid-hop, with its shadow) saying "builder needs you", the *runs a shell command* chip, the builder's stepper chip badged. |
| `03-done.png` | The run finished: stars and a "done!" bubble by the closing card, the tab icon a heart. |
| `04-offline-dino.png` | The server went away mid-run: "Can't reach agent-loop", attempt count, Retry now, Chrome's dinosaur mid-game with the page's sprites. |
| `05-help.png` | `?`: shortcuts, options (the cat, pixel cursors, sound), what the cat does, credits. |
| `06-light.png` | The light look, with the bold text that used to be invisible there now readable. |
| `07-phone.png` | A 390 px phone: no sideways scroll, the cat by the input box. |
| `08-stop-armed-still-running.png` | A command that has gone quiet is labelled "still running · 1m 15s" (the page's clock is faked and moved on, so the label is the real one), and the header's **stop run** button is armed: "really stop?" after the first of its two clicks. |
| `09-stopped-no-result.png` | The same run after the second click: the "Stop requested · you pressed Stop on the page" note, the closing card "Run stopped · 1m 17s", and the call that never answered marked "no result · the run ended". |
| `10-history-trimmed.png` | A run longer than the page's history, reloaded: it says "Showing the most recent activity: 112 earlier tool events were dropped from this view" and where every one of them is kept (the audit database). |
| `plain-mode.png` | Plain mode: no cat, pixel icons, cursors or sound; the same page, prompts and facts. |

## terminal/

Real output of the real command-line tool, rendered to images by `node --experimental-sqlite --no-warnings test/e2e/render-terminal.mjs`
(`dist/cli.js` is the thing that ran). Each says in its own title bar what is a stand-in: `insights` reads a **made-up history** (30 runs of
a made-up person), and the `--max-cost` run uses the test suite's **stand-in model** ($0.01 a call, so the cap is reached in two calls and
nothing is spent). `doctor` is run on the machine that made the picture. Home and temp folders are shown as `~` and `<data>`, and the run's
`#token=` secret as a placeholder.

| File | What it shows |
| --- | --- |
| `terminal-insights.png` | `agent-loop insights`: outcomes, cost by phase, the "don't ask again" rules reused and never reused, then what it says about the made-up person's habits, two tips and a grade that says it is made up for fun. |
| `terminal-doctor.png` | `agent-loop doctor`: Node, `node:sqlite`, the audit folder, credentials, Chromium, ffmpeg, display, desktop driver; two warnings (no credential in this sandbox, no display), nothing blocking. |
| `terminal-max-cost.png` | `agent-loop run --max-cost 0.02`: the planner runs, the cap is passed, the Overseer is not paid to judge it, the run is saved as stopped with the reason, and the report and lineage are still written. |
