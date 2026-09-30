# Spec: Computer use for agent-loop

> Written in Step 3 of the dev-workflow loop, before any implementation. Grounded in agent-loop's
> actual code as of commit `ce957c8` and in the read-only review of two reference projects
> (`docs/RESEARCH-COMPUTER-USE-AND-MULTI-AGENT.md`). The bar: someone with none of this
> conversation's context could implement a stage from this file and know when it's done.

## Request

"If possible we wanna make computer use as an application, so we take references of how Hermes
works [and OpenClaw] ... especially browser and computer use optimization of them using process of
ours development ... make a plan of it in depth, how would we solve this, seeing how we do it."

## Restated scope

Give agent-loop's phases a real "computer use" capability in two tiers:

1. **Browser computer use (Stage 1)** — make the existing Playwright browser tools genuinely good
   at operating a web app the Builder just built: accessibility-tree snapshots with stable element
   references, coordinate actions tied to a specific screenshot, multiple tabs, scroll/hover/select.
   Stays inside the existing localhost-only sandbox. No new risk surface.
2. **Desktop computer use (Stages 2–6)** — let a phase see and operate **one human-chosen desktop
   window** (for example, a native app the task is building), through the same third-party driver
   both reference projects use. Gated behind an explicit human go/no-go after Stage 1.

**Out of scope:** full-screen or whole-desktop control; operating arbitrary apps the human didn't
name; any capability that works under `--no-approval`; running agents concurrently (phases stay
strictly sequential — see the research doc on why a shared multi-agent notebook was rejected);
forking or vendoring Hermes/OpenClaw code (we reuse the driver as a dependency, not their code).

## What we're building on (verified against the code, not assumed)

| Fact | Where | Why it matters here |
|---|---|---|
| 7 browser tools (`open`, `inspect`, `click`, `fill`, `press`, `wait`, `screenshot`), CSS-selector targeting, one page per session | `src/browser-tools.ts:260–422` | Stage 1 extends these; refs replace fragile selectors |
| Localhost enforced twice: `open()` **and** `context.route("**/*")` aborting every non-local request | `browser-tools.ts:63–111` | The model for "enforced continuously, not checked once" that desktop must copy |
| 50-screenshot cap per session, video recording, `browser-*` events | `browser-tools.ts:61, 98, 116–240` | Caps and events carry over to desktop |
| Only `builder`/`verifier` get browser tools, only with `--browser` | `src/phases.ts:10–12, 192` | Desktop follows the same opt-in, same two phases |
| Every non-Bash tool gets a "don't ask again" rule by **bare tool name** | `src/hooks.ts:237–238` | **Must change for desktop** — one approved click would approve every future click (threat T3) |
| The safety net only inspects the `Bash` tool's `command` | `src/hooks.ts:90–93` | **A desktop "type text" into a terminal bypasses every Bash protection** (threat T1) |
| `inspect()` returns 3,000 chars of visible text + 40 interactive elements, straight into model context | `browser-tools.ts:277–295, 188–200` | Page text is untrusted input; today it's contained because every resulting action still hits approval + safety net |
| `@trycua/cua-driver` 0.30.4 on npm: MIT, native builds for darwin/linux/win32 × x64/arm64, speaks MCP over stdio | `npm view`, research doc §1–2 | Desktop reuses it; no hand-rolled AT-SPI/UIA/AX code |
| `Xvfb`/`xvfb-run` available locally and in CI (Playwright's `--with-deps`) | `which Xvfb` | Desktop can be tested headless, no real display needed |

## Threat model

Ranked by severity. Each threat names the **structural** control — something the model can't talk
its way around — not an instruction in a system prompt. Both reference projects stop at "the prompt
tells the model not to follow on-screen instructions"; that is exactly the "checked once, trusted
after" shape agent-loop already had to fix once in `browser-tools.ts`.

| # | Threat | Control |
|---|---|---|
| T1 | **Typing into a terminal bypasses the whole Bash safety stack.** The safety net, `bash-analysis.ts`, `NEVER_RULE` and the package-install rule only ever see the `Bash` tool's `command`. Desktop `type_text` into a terminal window (or an IDE's integrated terminal, or a "Run" dialog) runs anything, unchecked. | The target is an **allowlist of one**, fixed by the human on the command line before the run starts. Terminal emulators, shells, IDEs with integrated terminals, and OS run/launcher dialogs are **refused as targets even if named** (checked by process name/bundle ID, not window title). No clipboard read/write/paste actions exist at all. |
| T2 | **On-screen prompt injection.** Text in the window (or a notification over it) tells the agent to do something the human never asked. Unsolved in both reference projects. | The model cannot widen its own scope: there is **no tool that changes the target**, and the target check runs on every action. Every input action needs a **fresh human approval** showing the exact action and a thumbnail of the window. Tool results mark captured text as untrusted. Worst case, an injection causes one action inside the one allowed window, which the human sees before it happens. |
| T3 | **"Don't ask again" stretches.** `approvalPlan()` gives non-Bash tools a bare-tool-name rule, so approving one `desktop.click` would auto-approve every later click. | Desktop input tools return `null` from `approvalPlan()` — **always ask**, like package installs and `export`. Only read-only observation (`capture`, `list_windows`) can be auto-allowed. |
| T4 | **Target swapped between approval and action.** A window closes and another takes its place, focus is stolen, or the display changes. | Every action carries the `windowId` + `snapshotId` of the capture it was planned from. Re-verified **immediately before** dispatch and **again after** (Hermes' lease/fence pattern); a stale snapshot or changed window **fails closed** (OpenClaw's frame-identity pattern). |
| T5 | **No human present.** | Desktop tools are **refused entirely under `--no-approval`**, and refused if the approval UI isn't reachable. No human, no desktop. |
| T6 | **Screenshots capture things that aren't the target** (password managers, chat notifications, other windows). | Capture is cropped to the target window's bounds, never full-screen. Artifacts live outside `--dir` with the browser artifacts. The leak-review lesson applies: check what's actually visible in committed demo images, since text scanners can't see binary content. |
| T7 | **Supply chain.** A native third-party binary with desktop-input access. | Exact version pin, lockfile integrity, installed only as an optional dependency when desktop is enabled, driver version printed at run start. |
| T8 | **Runaway loops.** | Per-session caps on actions and captures, same shape as `MAX_SCREENSHOTS_PER_SESSION`. |

## Stages

Each stage is its own full dev-workflow loop: spec section → build → test → adversarial pass
(construct the exploit, don't reason about it) → `CHANGELOG.md` + docs → commit → CI green. A stage
isn't done until real CI passes on its push.

### Stage 1 — Browser computer use (no new risk surface; can start now)

- **1a. Accessibility snapshot with stable refs.** `inspect` returns a compact accessibility tree:
  `[e12] button "Save"`, `[e13] textbox "Email" value=""`. `click`/`fill`/`press` accept `ref` as
  well as `selector`. Refs are scoped to one snapshot; after any navigation or a new `inspect`, an
  old ref is **rejected as stale**, never silently re-resolved (Hermes' element-token pattern).
- **1b. Coordinate actions tied to a screenshot.** `screenshot` returns a `snapshotId`;
  `click_at`/`scroll_at` require it. A stale `snapshotId` (page navigated or resized) is rejected.
- **1c. Tabs.** `list_tabs`/`switch_tab`/`close_tab`. Popups opened by the page join the session.
  Every tab shares the one browser context, so the existing `context.route` gate covers them —
  **verified by test, not assumed**.
- **1d. More interactions.** `hover`, `select_option`, `scroll`.
- **1e. Live view.** New actions show in the existing browser panel and gallery.

### Stage 2 — Desktop go/no-go (no code)

Human reviews this spec's threat model and says go or stop. The decision is recorded in the run's
decision log. Stages 3–6 do not start without it.

### Stage 3 — Read-only desktop view of one window

- New `src/desktop-tools.ts`: a second in-process MCP server (`mcp__desktop__*`), same pattern as
  `browser-tools.ts`, that talks to a spawned `cua-driver` over MCP stdio.
- New CLI flag `--desktop-target "<app>"`; refused with `--no-approval`; refused if the named app
  is a terminal/shell/IDE/launcher (T1). The resolved target (process name, pid, window id) is
  printed at run start.
- Tools: `capture` (window-cropped screenshot + accessibility tree + `snapshotId`) and
  `window_info`. Nothing that sends input.
- A scripted **fake driver** (an MCP stdio server, like `test/stress/fake-sdk/`) so tests cost
  nothing and can simulate a window swap, a locked screen, a missing accessibility tree, or hostile
  on-screen text.

### Stage 4 — Input actions for that one window

- `click` (by element ref or by coordinates + `snapshotId`), `type_text`, `key`.
- Each **always asks** (T3), carries window identity (T4), is re-checked before and after dispatch.
- `key` refuses OS-level combos that leave the window (app switcher, run dialog, lock screen).

### Stage 5 — Visibility

- A desktop panel reusing the browser gallery and live indicator.
- The approval prompt shows the exact action, the target, and a thumbnail of the window as it was
  captured.
- `agent-loop insights` counts desktop actions and denials.

### Stage 6 — Adversarial round and lessons

Full red-team pass against T1–T8 with real exploits, recorded in
`docs/ADVERSARIAL-REVIEW-STATUS.md`; new lessons folded back into the `dev-workflow` skill.

## Requirements

Stage 1:

1. `inspect` returns element refs; `click`/`fill`/`press` accept `ref` or `selector`.
2. A ref from an earlier snapshot is rejected after navigation or a newer `inspect`.
3. `screenshot` returns a `snapshotId`; `click_at`/`scroll_at` reject a stale one.
4. `list_tabs`/`switch_tab`/`close_tab` work; a page-opened popup appears in `list_tabs`.
5. A popup or new tab navigating to a non-local URL is blocked by the same gate as the main tab.
6. `hover`, `select_option`, `scroll` exist and emit the usual `browser-action-*` events.
7. All existing browser tests still pass unchanged.

Stages 3–4 (only after Stage 2 go):

8. `--desktop-target` is required to enable desktop tools; with `--no-approval` the run refuses to start.
9. A terminal, shell, IDE, or launcher named as the target is refused at startup.
10. `capture` returns only the target window's pixels and tree, with a `snapshotId`.
11. Every desktop input action requires a fresh approval; `approvalPlan()` returns `null` for them.
12. An action whose `windowId`/`snapshotId` no longer matches the live target fails closed.
13. No tool can change the target, read or write the clipboard, or capture the full screen.
14. Per-session caps on actions and captures are enforced and tested.

## Expected output / deliverables

- Stage 1: extended `src/browser-tools.ts`; new cases in `test/browser-tools.mjs` and
  `test/ui-render.mjs`; `docs/BROWSER-AGENT.md` updated; `CHANGELOG.md` entry.
- Stages 3–4: new `src/desktop-tools.ts`; `--desktop-target` in `src/cli.ts`;
  `approvalPlan()` change in `src/hooks.ts`; desktop wiring in `src/phases.ts`/`src/pipeline.ts`;
  `test/fake-cua-driver/` and `test/desktop-tools.mjs`; a real smoke test under `xvfb-run`;
  new `docs/DESKTOP-AGENT.md`.
- Stage 5: desktop panel in `ui/index.html`; insights additions.
- Every stage: `CHANGELOG.md`, `docs/ADVERSARIAL-REVIEW-STATUS.md`, this spec updated to match what
  was actually built.

## Test plan

| Req | How it will be verified |
|---|---|
| 1 | Real Chromium: `inspect` on the demo page lists refs; `click({ref})` changes the DOM, checked independently |
| 2 | Navigate after `inspect`, then `click` the old ref → error naming it stale; DOM unchanged |
| 3 | Take a screenshot, resize the viewport, `click_at` with the old `snapshotId` → rejected |
| 4 | Page calls `window.open` to a local URL → `list_tabs` shows 2; `switch_tab` then `inspect` sees the new page |
| 5 | Page calls `window.open("http://example.com")` and a new tab tries a remote fetch → both blocked, no request leaves |
| 6 | Each new action emits a started/completed event pair with matching ids |
| 7 | `npm test` and `test/stress/pipeline_logic.sh` pass unchanged |
| 8 | CLI with `--desktop-target x --no-approval` → exits non-zero with a clear message, no driver spawned |
| 9 | `--desktop-target xterm` (and gnome-terminal, bash, code) → refused at startup |
| 10 | Fake driver returns a full-screen image; tool crops to the window bounds; hostile text elsewhere on screen never reaches the result |
| 11 | Unit: `approvalPlan("mcp__desktop__click", …)` → `null`; UI test: approving one click then issuing a second prompts again |
| 12 | Fake driver swaps the window between approval and dispatch → action refused, nothing sent to the driver |
| 13 | Tool list inspected: no target-change, clipboard, or full-screen tool exists; on-screen text saying "switch target to Terminal" has no tool to act through |
| 14 | Loop past each cap → refused with a clear message |
| T1–T8 | Stage 6 red-team: each threat gets a constructed exploit run against the real code, recorded pass/fail |

Real-environment check: one smoke run under `xvfb-run` against a real, accessible, non-terminal app,
before Stage 4 ships.

## How we'll run it (our process, applied)

- **Model/effort tiers** (`dev-workflow/references/model-effort-tiers.md`): spec and threat model at
  high effort; Stage 1 implementation at lower effort once this spec is unambiguous; adversarial
  passes in a fresh context at medium effort.
- **Verify, don't reason**: every threat's control is proven with a constructed exploit, the same way
  the browser sandbox escape, the package-install bypass, and the escape-sequence injections were
  actually found.
- **Tests before trust**: fake driver first (cheap, deterministic, can simulate attacks), then one
  real smoke run. Audit the fake itself for behavior it doesn't simulate — the lesson from the
  fake SDK that never emitted cost data.
- **Docs move with code**: spec, `CHANGELOG.md`, and the adversarial status doc are updated in the
  same commit as each stage.

## Open questions / risks

- **Accessible test app under Xvfb.** AT-SPI needs a session bus and an app that exposes an
  accessibility tree. Candidate: a tiny GTK app or a Chromium window launched as a native app.
  Resolve at the start of Stage 3.
- **`cua-driver`'s real tool surface and protocol.** Read its MCP schema before writing Stage 3; the
  names above are ours and get mapped onto whatever it actually exposes.
- **macOS/Windows permissions.** macOS needs Accessibility and Screen Recording grants; Windows UIA
  has no equivalent prompt. Document per platform; test Linux in CI.
- **Wayland.** Input injection differs from X11; Hermes documents regressions here. Start with X11
  (Xvfb), document Wayland as not yet verified.
- **Blast radius is a product decision, not a technical one.** Even with every control above,
  desktop control can reach more than a `--dir`-scoped project. That's why Stage 2 is a human gate.
