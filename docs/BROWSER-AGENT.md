# Browser agent

`agent-loop run --browser` gives the `builder` and `verifier` phases a real headless Chromium,
driven through 15 tools in `src/browser-tools.ts`. This page covers what the tools do, how a session
lives across phases, where artifacts go, and the local-only boundary, with the evidence for each part.

Source comments cite this page by section number, so the numbering is kept stable.

## 1. What phases get

The tools come from one in-process MCP server built with the SDK's `createSdkMcpServer` and `tool()`.
They appear to the model as `mcp__browser__<tool>`, in the same `tool_name` field the PreToolUse hooks
already read. So every browser action goes through the same safety net, path scope, sensitive-file
check and human approval as `Bash` or `Write`. None of them is on the auto-approve list.

Only `builder` and `verifier` get them (`BROWSER_ENABLED_PHASES` in `src/phases.ts`). The phase
prompt explains the workflow described below.

| Tool | Input | What it does |
|---|---|---|
| `open` | `url` | Navigates the active tab. Only `http://localhost` / `http://127.0.0.1` URLs. |
| `inspect` | — | URL, title, tab, visible text (3,000 chars), and up to 60 interactive elements, each with a ref |
| `click` | `ref` or `selector` | Clicks that element |
| `fill` | `ref` or `selector`, `value` | Fills a field |
| `press` | `key`, optional `ref` or `selector` | Focuses the element if given, then presses the key |
| `hover` | `ref` or `selector` | Moves the mouse over it (menus, tooltips) |
| `select_option` | `ref` or `selector`, `values` | Picks options in a `<select>`, matched by value or visible label |
| `scroll` | `ref`/`selector`, or `dx`/`dy` | Scrolls an element into view, or scrolls the page |
| `wait` | optional `selector`, `timeoutMs` ≤ 30,000 | Waits for a selector, or for a fixed time |
| `screenshot` | — | The active tab's viewport as a PNG, plus a `snapshotId` |
| `click_at` | `x`, `y`, `snapshotId`, optional `button` | Clicks a point read off that screenshot |
| `scroll_at` | `x`, `y`, `snapshotId`, `dx`/`dy` | Mouse-wheel scroll at that point (scrollable panels) |
| `list_tabs` | — | Open tabs, including page-opened popups, and which one is active |
| `switch_tab` | `tabId` | Makes another tab active |
| `close_tab` | `tabId` | Closes a tab. The last open tab can't be closed. |

`selector` still works everywhere it used to, so existing callers are unaffected. Refs are the
preferred target.

## 2. Session model

`BrowserSessionManager` maps each run to one browser, one context and its tabs. Each phase is a
separate SDK `query()` call; the browser outlives all of them, so the verifier sees the app in exactly
the state the builder left it. The browser launches lazily, on the first `open`. A run that never
uses the tools never starts Chromium; `test/stress/pipeline_logic.sh` checks this.

`close()` runs in the pipeline's `finally` block and must never throw (see the comment in the source).
It saves every tab's video, closes the context, closes the browser, and always emits
`browser-session-ended`.

### Refs (`inspect`)

Each element line looks like this:

```
[s4e3] button "Save" id="save-btn"
[s4e7] combobox "Color" id="color" value="Red" options=["Red","Green","Blue"]
[s4e9] textbox "Password" id="pw" value="(hidden)"
```

A ref is `s<snapshot>e<n>`. The snapshot number never repeats within a session, so an old ref can't
collide with a new one on any tab.

- **Backed by live element handles held in agent-loop, not by anything in the page.** A `data-ref`
  attribute would let page JavaScript move the "Save" ref onto the "Delete" button. A handle can't be
  re-pointed.
- **Described one element at a time.** Each line is computed from exactly the element its ref
  resolves to. The test page overrides `document.querySelectorAll` to return elements in reverse
  order, and the ref labelled "Alpha" still clicks Alpha.
- **Fail closed, never re-resolved.** A ref is refused, with advice to re-inspect, when:
  - a newer `inspect` ran;
  - the page navigated (any main-frame navigation, including same-document ones);
  - you switched tabs;
  - the element was removed. A framework re-render that swaps in an identical clone counts as removal;
    the old ref does not quietly click the look-alike.
- **Page text can't forge lines.** Names are stripped of control and bidi characters, whitespace is
  folded (so a name can't start a new line), and names are JSON-quoted. Roles are cut to identifier
  characters.
- **Password values never reach the transcript.** They show as `value="(hidden)"`.

### Screenshot-bound coordinates (`click_at`, `scroll_at`)

`screenshot` captures at `scale: "css"`, so one image pixel equals one CSS pixel whatever the
device scale factor. It returns a `snapshotId` such as `shot-3`. Coordinates are honoured only
against the latest screenshot, and only while the page it captured hasn't moved:

- same tab
- no navigation
- same viewport size
- same scroll position
- point inside the image

Anything else is refused and nothing is clicked. A layout change in place (content inserted above,
say) is not detected: the page controls its own layout, and nothing cheap and tamper-proof can watch
for that. That's why the prompt steers toward refs first.

### Tabs

Popups (`window.open`, `target=_blank`) join the session as tabs `t2`, `t3`, and so on. The active
tab doesn't change on its own; `switch_tab` changes it and expires refs and snapshotIds from the
previous tab. A tab the page closes itself leaves the list; if it was the active tab, the most recently
opened remaining tab becomes active. If every tab closes, the next `open` starts a new one.

## 3. Artifacts

Screenshots and videos go under `<data dir>/browser-artifacts/<runId>/`. That's always outside
`--dir`, where the agents have write access, and never in SQLite. The UI serves them read-only at
`/artifacts/<runId>/<file>`, gated by the run's token.

- **Screenshot** results name only the file. The full local path stays in internal events, because
  it leaked machine layout into shared transcripts before (`docs/LEAK-REVIEW-ui-video.md`).
- **Video:** every tab records its own. The first tab keeps the `session-<id>.webm` name; others are
  `session-<id>-t2.webm` and so on. Each gets a `browser-artifact-created` event. A failure saving
  one video never loses the others.

## 4. The local-only boundary

Only `localhost` and `127.0.0.1` are reachable, from any page, tab or frame. `open()`'s own check
isn't enough, because pages make requests without calling `open()`. So the boundary is enforced on
the browser context, in layers. Each layer was added because a real exploit got through without it:

| Channel | Layer that stops it | How we know |
|---|---|---|
| Links, redirects, forms, `fetch`/XHR, images, beacons, prefetch, `EventSource`, popups | `context.route("**/*")` aborts every non-local request | Clicking a link reached a second server before this existed |
| WebSocket | `context.routeWebSocket` closes non-local sockets with code 1008 before they connect; local sockets aren't matched and behave natively | A page's `new WebSocket()` reached a non-allowed host with the route gate in place: `route()` never sees WebSockets |
| WebRTC (STUN over UDP, TURN over TCP) | An init script removes `RTCPeerConnection` in every realm before page scripts run | STUN packets reached a non-allowed host (20 of them in one probe). Chromium's `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` did **not** stop them, even to a non-loopback address. The init script held in the main page, a fresh iframe read synchronously, `srcdoc`, `data:` and `blob:` iframes, and `window.open('')` popups |
| Service workers | `serviceWorkers: "block"` | Playwright's docs say `route()` can't see requests a service worker answers, and recommend blocking them whenever interception matters |
| Tabs and popups | All of the above, since every tab shares the one context | Tested per channel in a page-opened popup |
| Runaway popups | At most 10 tabs; extra popups are closed as they arrive | A page opening 25 popups gets 10 |

Tried and dropped: routing everything through a dead proxy as a backstop. Chromium sent loopback
targets around the proxy anyway, so it couldn't be verified here, and an unverifiable defence
doesn't ship.

The test (`test/browser-computer-use.mjs`) points everything at a listener on `127.0.0.2`: loopback,
so nothing leaves the machine, but not an allowed host. It counts every HTTP request, WebSocket
upgrade and UDP packet that arrives. A control run in an undefended browser must register leaks
first, or a zero would prove nothing. On macOS, where `127.0.0.2` isn't routed by default, the
check says it's skipped instead of passing.

## 5. Limits

| Limit | Value | Why |
|---|---|---|
| Screenshots per session | 50 | Disk-fill DoS from a looping phase |
| Tabs per session | 10 | A renderer and a video per popup otherwise |
| Refs per `inspect` | 60, plus a count of the rest | A page with thousands of links shouldn't flood the transcript |
| `wait` | 30 s | |
| `scroll` / `scroll_at` delta | ±20,000 px per call | |

## 6. Events

Every tool emits `browser-action-started` and `browser-action-completed`, with a shared `actionId`,
timing and the result text. `screenshot` also emits `browser-snapshot`; screenshots and videos emit
`browser-artifact-created`. The session emits `browser-session-started` and `-ended`. The terminal
and the web UI label each call by what it acted on: `browser.click(s2e5)`,
`browser.click_at(120, 44 @ shot-3)`, `browser.switch_tab(t2)`.

## 7. Known limitations

- **Pages that use WebRTC break by design.** Apps agent-loop verifies locally haven't needed it.
- **A dropped WebSocket `close` event (Playwright quirk).** Say a page opens two popups in the same
  script while a blocked WebSocket is pending. The socket still ends `CLOSED` and never connects,
  but the page's `close` event doesn't fire. Found while writing the Stage 1 test. Security is
  unaffected; an app waiting on that event would wait forever.
- **DNS isn't covered, and hasn't been tested either way.** Nothing here stops a page from making
  Chromium resolve an arbitrary hostname (for example via `<link rel="dns-prefetch">`), which could
  leak a few bytes through DNS. The request that would follow the lookup is blocked.
- **Only the main frame is inspected.** Elements inside iframes don't get refs yet; use a selector.
