# Adversarial review: what leaks through the UI and video/screenshot artifacts

Scope: `ui/index.html`, `src/terminal.ts`, `src/report.ts`, `src/server.ts`'s artifact route, the
browser tool's screenshot/video path handling in `src/browser-tools.ts`, and the demo media already
committed under `docs/screenshots/` and `docs/media/`. Question asked: what does a human looking at
the live UI, a saved report, a screenshot, or a session recording end up seeing that they shouldn't?

Everything below was checked against the real running code and the real committed files, not
inferred from reading source alone.

## Round 1 findings

### 1. Browser-tool screenshots leaked the local filesystem path into the transcript — confirmed, fixed

`browser-tools.ts`'s `screenshot` tool returned `text: "Screenshot saved to ${filePath}"`, where
`filePath` is the **full absolute path** the file was written to: `<dataDir>/browser-artifacts/
<runId>/screenshot-<ts>-<id>.png`. That text is exactly what `phases.ts`'s `summarizeToolResult`
puts into the `tool-result` event's `summary` — which goes into the live transcript, the SQLite
`log_index` (searchable), every WebSocket broadcast to every connected client, and (via
`report.ts`) every saved `report.html`.

This isn't hypothetical: **it already happened**. Extracting frames from the committed demo video
`docs/media/after-new-ui-real-run-5x.webm` and reading the committed screenshot
`docs/screenshots/approval-ui/04-after-real-run.png` (both real recordings, both currently public on
GitHub) shows the literal line:

```
Screenshot saved to /tmp/claude-0/e2e3/home/runs/workdir-20ef3c0286efea94/browser-artifacts/e0105d2e-8d98-4ec4-927f-31d8238fb148/screenshot-1790275106951-86bcccb1.png
```

That's the internal sandbox's own temp-directory naming convention, session/workdir UUIDs, and
directory layout, baked into a public demo asset. On a real user's own machine, the equivalent leak
would be their actual home directory / username (e.g. `/home/alice/projects/app/.agent-loop/...` or
`/Users/alice/...`), since nothing scoped this path down before this fix. Unlike file-tool paths
(`Read`/`Write`/`Edit`), which the UI already relativizes to `--dir` via `rel()`, the browser tool's
own artifact path was never relativized at all — it's a different directory tree by design (outside
`--dir`, see `docs/BROWSER-AGENT.md`), so `rel()` never touched it, and nothing else did either.

**Fix**: the tool's visible text now names only the filename (`Screenshot saved (screenshot-<ts>-
<id>.png)`), never the directory it lives under. The real path is still available where it's actually
needed — internally, via the `browser-snapshot`/`browser-artifact-created` events already emitted
right next to it, which the UI already uses to build artifact URLs and which never render the raw
path as visible text.

Separately confirmed **not** a problem: the video announcement in the UI (`browser-artifact-created`
with `kind: "video"`) never printed the raw path as text either — only used it internally to build
the `<video src>` URL — so no equivalent fix was needed there.

### 2. The already-committed demo screenshots/videos still show it — not yet remediated, needs a decision

The code fix (finding #1) stops this from happening in any *new* run, but the specific screenshot
and video that demonstrated it are still sitting in the repo, still public:

- `docs/screenshots/approval-ui/04-after-real-run.png`
- `docs/media/after-new-ui-real-run-5x.webm`

Worth noting: `docs/UI.md` (lines 89–91) already explains *why* that screenshot looks the way it does
— it's deliberately kept as the "here's the bug we found and fixed" illustration for a **different,
already-fixed** bug (the screenshot tool's base64 image data being dumped into the transcript; see
`summarizeToolResult` in `phases.ts`, which already redacts image blocks to `[image]`). That part is
intentional, narrated, and not a live issue — the base64 payload itself is just a picture of a todo
app, nothing sensitive in the decoded bytes.

The **path** visible in that same screenshot/video is the separate, real leak in finding #1, and
regenerating both assets against the now-fixed code would clear it. Doing that means a real run
against the real model (`node test/e2e/record-run.mjs --browser --smart -- "..."`, per `docs/UI.md`'s
own instructions) — real API cost, roughly $0.60–1.60 per the doc. Flagging this rather than just
spending it: **recommend regenerating both files**, holding off until asked to spend that.

### 3. XSS / HTML-injection surface in `ui/index.html` — checked, confirmed already safe

Every `innerHTML` write in the transcript renderer was traced to its source. Everything that isn't a
CSS class name or a `.textContent` assignment (which can't execute HTML regardless of content) goes
through `esc()` (or `md()`, which calls `esc()` first) before reaching `innerHTML` — task text,
verdict headlines/details/findings, Overseer reasoning, tool names/args, tool output, decisions,
browser panel status/title/url. The one place raw text is stored unescaped in JS state
(`state.decisions[].text`) is always re-escaped at render time in `renderHeader()`, never trusted
from a prior escape. `artifactUrl()`'s output goes into `href`/`src` attributes without a separate
`esc()` call, but every value passed through it is `encodeURIComponent`-ed first (which strips `"`,
`<`, `>`, `&` — the only characters that could break out of the surrounding double-quoted attribute)
and, in practice, only ever carries server-generated UUIDs and filenames, never user- or
model-controlled strings. No fix needed here.

### 4. `report.html`'s embedded run data — checked, confirmed already safe

`report.ts` JSON-stringifies the full event log and escapes `<` to `<` before embedding it as
`window.__REPLAY__`, specifically to stop event text from closing the `<script>` tag early (already
covered by an existing regression test: `event text containing </script> and onerror= stays inert
text`). The report's `dir`/output path is built from `run.id`, a server-generated `randomUUID()`,
never from anything attacker- or user-suppliable, so there's no path-traversal angle on where a
report gets written either. No fix needed here.

## Verification

- New regression test (`test/browser-tools.mjs`): asserts the screenshot tool's result text never
  contains a path separator, and that the real on-disk path (confirmed via the internal
  `browser-snapshot` event, magic-byte-checked as a real PNG) matches the filename shown in the
  transcript.
- Full suite: 11/11 test files pass, no API cost.
- `test/stress/pipeline_logic.sh`: 10/10 scenarios still pass.
- Manually re-extracted the reasoning against the fixed code: a screenshot taken after this fix
  produces `Screenshot saved (screenshot-<ts>-<id>.png)` with no directory component, verified via
  the updated test.

## Finding #2: resolved

Regenerated both files with a fresh real run (`test/e2e/record-run.mjs --browser --smart`, same task
as the original recording). `docs/screenshots/approval-ui/04-after-real-run.png` and the re-recorded
video (re-encoded to `docs/media/after-new-ui-real-run-5x.mp4`, see below) now show the fixed code's
actual output -- `Screenshot saved (screenshot-<ts>-<id>.png)` and `[image]`, no path, no base64.
Confirmed by loading the fresh run's own saved `report.html` in a real headless Chromium and by
re-extracting frames from the new video with `ffmpeg`. `docs/UI.md`, `docs/screenshots/INDEX.md`, and
`README.md` were updated to match (stats, descriptions, and direct links to the recordings).

All three `docs/media/*.webm` files (Playwright's native recording format -- what `--browser` itself
still produces on every real run; that part hasn't changed) were also re-encoded to `.mp4` (H.264, via
a full `ffmpeg` install -- the sandboxed one bundled with Playwright only has a VP8/WebM encoder) so
they're viewable with ordinary media players and preview more reliably, not just to address this leak.

## Round 2: independent re-check against the fixed code

Re-ran the exploit scenario fresh (a real Chromium session via `BrowserSessionManager`, a real local
HTTP server, a real `screenshot` tool call), independently of the automated test added above:

```
Tool-visible text: "Screenshot saved (screenshot-1790580138412-c24785fe.png)"
Contains a path separator: false
Contains the real artifactDir string: false
```

Confirms finding #1 is closed: the tool's visible output no longer contains the artifact directory,
a path separator, or any other trace of the local filesystem layout — only a bare filename. Findings
#3 and #4 were re-read against the current source and remain unchanged (no code touched either
file). No new leaks surfaced in this round. The only outstanding item is still the two public demo
files under the "Open item" above, which remain unregenerated.
