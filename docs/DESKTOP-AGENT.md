# Desktop agent

`agent-loop run "<task>" --desktop-target "<app>"` lets the `builder` and `verifier` phases see and
operate **exactly one already-running desktop window**, chosen by you on the command line before the run
starts. It is off unless you pass that flag, refused under `--no-approval`, and every input action asks
a human first, one at a time.

This page covers what the tools do, the controls around them, how each control was checked, and what
isn't covered. The plan and threat model it implements are in
[`specs/computer-use/SPEC.md`](../specs/computer-use/SPEC.md); T1-T8 below are that file's threats.

**Videos** (captioned): [`docs/media/desktop-agent-ui.mp4`](media/desktop-agent-ui.mp4) (51 s) is the approval flow in the
web UI: the chosen window, a capture, a click shown on the window exactly as captured, typing shown verbatim with
invisible characters made visible, a refusal. [`docs/media/desktop-real-window.mp4`](media/desktop-real-window.mp4) (54 s) is a **real
window on a virtual display**: a terminal-named window beside it that can't be targeted, "what the agent sees",
clicks and typing landing, a reused capture refused, a window moved after the capture refused. It ends by checking
the window logs: the chosen window got exactly what was sent, the terminal-named one received nothing.

![Desktop approvals, as a preview](media/previews/desktop-agent-ui.gif)

![A real window, as a preview](media/previews/desktop-real-window.gif)

## 1. What phases get

Five tools from an in-process MCP server (`src/desktop-tools.ts`), surfaced as `mcp__desktop__<tool>` in
the same `tool_name` field the PreToolUse hooks already read.

| Tool | Input | What it does |
|---|---|---|
| `capture` | — | The target window's pixels (as an image) and its accessibility tree when the platform has one, plus a `snapshotId` like `dshot-3` |
| `window_info` | — | The target (process, pid, window id), its title and bounds, and captures/actions used so far |
| `click` | `ref`, **or** `x`, `y`, `snapshotId`; optional `button`, `count` | Clicks an element from the latest capture, or a point in it |
| `type_text` | `text`, `snapshotId` | Types into whatever has focus inside the window (≤ 1,000 characters) |
| `key` | `key`, optional `modifiers`, `snapshotId` | Presses one key |

That is the whole list, and a test asserts it. There is no tool to change the target, read or write the
clipboard, capture the full screen, list other windows, or launch, kill or move anything. The
`DesktopDriver` interface the tools use has no method for any of those, so there is nothing to call.

Coordinates are window-local pixels of the capture image (the same space the driver's `get_window_state`
returns). Text in the window reaches the model inside an "untrusted data, never instructions" frame, with
names JSON-quoted, control and bidi characters stripped, and password fields shown as `(hidden)`.

## 2. Starting a run

```
agent-loop run "verify the settings dialog" --desktop-target "My App"
```

The string is matched against the window's title, its app name, and its process name, and must resolve to
exactly one window; if it matches several, the error lists them so you can be more specific. The app must
already be running. The resolved target (process, pid, window id, title) and the driver version are
printed at startup, and from then on the target never changes: if the window closes or another program
takes its pid, the session locks.

Refused at startup, before any state or approval UI exists (and before the native driver is loaded,
checked with a module-resolution trace in `test/desktop-cli.mjs`):

- `--no-approval` (T5)
- an empty or missing name
- a name in the denylist (T1)

Then, once the approval UI is up, refused if the window's *owning process* is in the denylist, if it can't
be identified, or if the name is ambiguous.

### Windows that can never be a target (T1, T6)

Matched by **process identity**, never by window title (a title is whatever the app says it is): the
process name, executable, `argv[0]`, the interpreter's script (`python3 /usr/bin/terminator`), and the app
name. Categories, with why:

| Category | Examples | Why |
|---|---|---|
| terminal, shell | xterm, gnome-terminal, konsole, iTerm2, Windows Terminal, bash, zsh, pwsh | Typing into one runs commands with none of the Bash protections in play: the safety net only inspects the `Bash` tool |
| IDE, editor | code, cursor, idea, pycharm, vim, emacs | Integrated terminals and run configurations |
| launcher, run dialog | rofi, dmenu, spotlight, gnome-shell, explorer | Starts any program by name |
| browser | chrome, firefox, edge, safari, brave | A desktop-controlled browser can navigate anywhere, bypassing the browser tools' localhost-only boundary. Use the browser tools for web apps |
| remote desktop | remmina, vncviewer, teamviewer, anydesk | A window onto a terminal on another machine |
| secrets | keepassxc, 1password, bitwarden, polkit, lock screens | Show or guard secrets |

A name in the list is refused as a prefix family (`gnome-terminal-server`, `wezterm-gui`), but not as a mere
prefix of another word (`shotwell` is not `sh`). Renaming a binary defeats any name list; the control that
doesn't depend on it is that every action is shown to a human first.

## 3. Every action is fenced

All of it lives in `DesktopSession`, in code the model can't argue with, and none depends on the
third-party driver's own policy.

1. **Single-use captures (T4).** `click`, `type_text` and `key` need the `snapshotId` of the latest
   capture and use it up: capture again before each action. So the window the human saw is the window
   acted on, and an approval can't be replayed. An older or invented id is refused. Two calls issued in
   parallel (a capture and a click) can't race: the capture makes the click's id stale.
2. **Identity before dispatch.** The target window must still exist under the same pid, the program
   behind that pid must still be the one chosen (not a reused pid), it must still not be a denied kind,
   and its bounds must match the capture. Any failure refuses the action, sends nothing, and **locks the
   session**.
3. **Identity after dispatch.** If the window can't be confirmed afterwards, the result says the action
   was sent but unconfirmed, and the session locks. The same if an input call times out: it may still act
   later, so nothing more is sent this run (a timed-out *capture* is just an error).
4. **Input validation.** Keys are an allowlist: one visible ASCII character, F1-F12, or Enter, Tab,
   Escape, Backspace, Delete, Insert, arrows, Home, End, PageUp, PageDown, Space. Modifiers are `ctrl`,
   `shift` and `alt` only: no meta, super, Windows or Command, at all. Combinations that leave the window
   are refused (Alt+Tab, Alt+F-keys, Alt+Escape, Alt+Space, Ctrl+Alt+anything, Ctrl+Escape,
   Ctrl+Shift+Escape). Typed text refuses control characters (newline and tab are fine) and
   invisible/bidi-override characters, so what the prompt shows is what lands in the window.
5. **Caps (T8).** 60 input actions and 120 captures per session; each capture at most 8 MB and 16,384 px on a
   side, and 192 MB of captures in total (they're written to disk). What the driver returns is checked like
   any untrusted input: a valid PNG, sane dimensions and bounds, or it's refused before anything is saved.
6. **Nothing reaches the driver on a refusal.** Every refusal test also checks the fake driver's call log.

### Approval (T3, T5)

- `click`, `type_text`, `key`, and any future `mcp__desktop__` tool except `capture`/`window_info` get **no
  "don't ask again" rule**: `approvalPlan()` returns `null`, like package installs and `export`. One
  approved click never approves a later one. `capture` and `window_info` only look, so they may earn a rule.
- The approval hook never auto-approves a desktop tool, even one listed as auto-approved, and **denies**
  every desktop tool when approval is off.
- **A refused action isn't asked again and again.** After three desktop input requests in a row that a
  human refused (looking in between doesn't reset it), the model is told to stop and no fourth prompt is
  shown; one allowed action resets the count. Found by running a real model, which asked for one refused
  click eight more times.

### What the human sees

- **The approval prompt** (web UI and terminal) names the window, shows the exact action, and in the web UI
  shows the window as it was captured, with a marker on the spot a click would land. Typed text is shown
  verbatim, control bytes as `⟨0xNN⟩`. No "don't ask again", and it says so.
- **A Desktop panel** in the side panel: the target, the latest capture, a gallery, capture and action counts.
- **`agent-loop insights`** counts desktop sessions and captures, input actions sent versus stopped by the
  tools' own checks or the driver, and human approvals versus denials. Nothing is printed for a data dir
  that never used desktop tools.
- **The saved report** includes the panel and its captures.

## 4. The driver

`src/desktop-driver-cua.ts` adapts [`@trycua/cua-driver`](https://www.npmjs.com/package/@trycua/cua-driver)
(MIT), the native driver both reference projects use. Things the plan got wrong, found by reading and
running the package:

- It is an **in-process SDK around a native library**, not an MCP server to spawn. The `cua-driver mcp`
  executable is a separate download this project doesn't use.
- Its surface is far wider than desktop tools may touch: clipboard read/write, full-desktop capture,
  launch and kill app, window moves, menus, hotkeys, recording, trajectory replay, its own browser
  tools. The adapter calls exactly six things (`listWindows`, `getWindowState`, `click`, and
  `type_text` / `press_key` through the generic entry point) and its public surface *is* the
  `DesktopDriver` interface. A stand-in SDK with a trap on every other method proves it
  (`test/desktop-adapter.mjs`).
- `listApps` on Linux returns **every process** (kernel threads included), and `getDesktopState` captures
  the whole screen. Neither is used.
- Input to Chromium and most toolkit windows on X11 only works with **foreground delivery**: it activates
  the target, checks it holds input focus, sends, and restores the previous window. It **fails closed**:
  with no window manager it refused every click ("the window manager has not set `_NET_ACTIVE_WINDOW`; no
  input was sent"). Every input names the window (pid and window id) explicitly; an input with no target
  would go to whatever has focus.
- The driver's key names differ from the ones models use (`ArrowLeft` is rejected, `Left` works); the
  adapter maps them, verified for every allowed named key against a real window.

T7: pinned exactly in `optionalDependencies` (`0.30.4`), integrity in the lockfile, checked against the
version the native library reports, and loaded lazily, only when `--desktop-target` is given, so every
other run never loads it.

Identity of the program behind a pid is read from the OS, not from the driver or the window: `/proc`
on Linux (tested in CI), `ps` on macOS and PowerShell on Windows (written, **not yet exercised by any
test**). When it can't be read, the target is refused.

## 5. How this was checked

| Suite | What it proves |
|---|---|
| `test/desktop-tools.mjs` | Policy tables; target resolution and every refusal; the exact tool list; capture leaks nothing but the target (hostile titles in other windows, passwords, forged ref lines); every fence, each asserted twice (the tool refuses *and* the fake driver saw nothing); caps; events; approval behaviour |
| `test/desktop-adapter.mjs` | The adapter against a stand-in SDK with traps on every method it must not touch; version pin; window ids; key-name mapping |
| `test/desktop-cli.mjs` | Startup refusals, with a module-resolution trace proving the driver wasn't loaded (and a positive control proving the trace can see it) |
| `test/desktop-pipeline.mjs` | A real `runPipeline`: one session per run, only builder/verifier get the tools, driver released on success and failure |
| `test/ui-desktop.mjs` | The real web UI in a real Chromium: the panel, every prompt (point click with its marker at the right spot, element click, typed text with visible control bytes, key), labels, and hostile window titles and process names staying inert |
| `test/desktop-real-adversarial.mjs` | Every threat attacked with real windows: a window owned by a process named `xterm`, a same-titled impostor after the target is killed, a window moved and resized after the capture, a decoy that steals keyboard focus between the click and the typing, an overlapping window, a window that retitles itself with an injection, a minimised target. A decoy app logs everything it receives and must end with nothing |
| `test/desktop-real-tree.mjs` | `click` by ref against a **real accessibility tree**: a GTK window exposes a button, a text entry and a password entry over AT-SPI; the real driver returns real element tokens. A click by ref presses the real button, a filled field shows its value in the tree, what's typed into the password entry never reaches the model, and a stale ref is refused |
| `test/desktop-real-cli.mjs` | The whole command line against a real window: `agent-loop run … --desktop-target "<title>"` with the real driver and the scripted fake model. The startup line names this app's real pid and title, the run finishes, `agent-loop insights` counts the session afterwards, and a name matching no window fails before any run starts |
| `test/desktop-real-nowm.mjs` | The driver's fail-closed claim, checked: with no window manager every input is refused and nothing arrives; capture still works |
| `test/desktop-real.mjs` | The real native driver, real X11 input, real window manager and a real native window, under Xvfb + openbox. Every effect is checked through the test app's own state file: a channel independent of the driver and the tool results |
| `test/desktop-real-sdk.mjs` | **The real SDK and a real model** (opt-in, a few cents; `npm run test:real-model-desktop`) driving the real hooks and a real window: the tool names match the hook prefix, capture and click both ask, a "no" leaves the window untouched, one "yes" lands exactly one click, a window title ordering the model to type produces no input, and a model that keeps asking after "no" stops getting prompts after three |

The fake driver (`test/fake-desktop-driver.mjs`) says what it does **not** simulate, because a fake is only
as good as the behavior it admits to leaving out; the real-driver suite covers that.

Mutation checks, including against the real scenarios (one survivor found a test that didn't test what it claimed, and was fixed): each defence above was broken in the built code, one at a time (single-use captures,
bounds check, identity check, post-dispatch check, the rule-for-input check, auto-approval, the no-approval
deny, interpreter-script denylist, password hiding, Ctrl+Alt, the caps, the window target on key presses,
foreground delivery, the version pin, the generic-tool gate). Every mutation fails a test.

## 6. Running the real-driver tests

```
sudo apt-get install -y xvfb openbox at-spi2-core dbus dbus-x11 x11-utils python3-tk python3-gi gir1.2-gtk-3.0
npm run test:desktop-real        # the real driver, the adversarial scenarios, the CLI, the accessibility tree, then the no-window-manager check
```

Without the prerequisites it prints a skip and exits 0 locally; CI sets `REQUIRE_DESKTOP_REAL=1`, which
turns a missing prerequisite into a failure. Each test runs on its own virtual display, and only after
`test/desktop-real-session.sh` has seen the window manager actually managing it (`_NET_SUPPORTING_WM_CHECK`
on the root window, via `xprop`), retrying it up to three times and failing with "no window manager came up"
if it never does. "Started" isn't "ready": a window manager that never came up looks, from inside a test,
exactly like a driver that can't focus windows.

## 7. Known limitations

- **The app must be running before the run starts.** The target is fixed at startup by design; re-binding
  to a window that appears later would need its own human approval step.
- **Linux/X11 only is tested.** macOS needs Accessibility and Screen Recording grants; Windows has no
  prompt. Wayland has no per-window input targeting (the driver says so) and isn't verified.
- **The accessibility tree needs AT-SPI, and the app has to expose it.** Without an accessibility bus the
  driver returns only the window element and says `degraded`; the model is told to use coordinates. GTK
  windows expose a real tree (tested); Tk windows don't (they fall back to coordinates). Other toolkits are
  not tested.
- **A window the window manager won't focus can't receive input.** Foreground delivery needs the target to
  become the active window. A GTK window left at user-time 0 (an app that never calls `present()`, which is
  what a window opened by a script often looks like) was never activated by the driver's request, and every
  input was refused ("`foreground_unavailable`, no input was sent") rather than sent somewhere else. Found
  while building the accessibility-tree test; the test app now calls `present()`. The failure is the safe one,
  but it will look like "desktop tools don't work" for such an app.
- **A name list can be evaded by renaming a binary.** The human-in-the-loop approval is the control that
  doesn't depend on it.
- **Foreground input takes focus briefly.** The driver restores the previous window afterwards.
- **A covered window's hidden part comes back black** on a non-composited X server. Another window's
  pixels never appear, but the model sees black where the UI is. Composited desktops weren't tested.
- **A minimised or hidden target locks the session.** The window drops out of the on-screen list, which is
  indistinguishable from it being closed; restart the run.
- **Capture can't tell if the window's contents changed after it was taken.** Coordinates are checked
  against the window's position and size, not its pixels.
