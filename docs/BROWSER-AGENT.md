# Browser agent

`agent-loop run --browser` gives the `builder` and `verifier` phases a real headless Chromium,
driven through 18 tools in `src/browser-tools.ts`. This page covers what the tools do, how a session
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
| `inspect` | optional `query` | URL, title, tab, visible text (3,000 chars), and up to 60 interactive elements, each with a ref. With `query`, only elements whose role, name or id contains it. Says so when the page has no visible text and no interactive elements. |
| `text` | optional `ref`/`selector`, `offset`, `length` | The page's (or one element's) text in sections of up to 8,000 characters, with the total and the `offset` to call again with |
| `notices` | optional `limit` | Everything the page did that the agent should know about, most recent last, with counts, and what was dropped |
| `resize` | `width`, `height` | Viewport 320-3840 by 240-2160; refs and snapshotIds from before are refused |
| `click` | `ref` or `selector` | Clicks that element |
| `fill` | `ref` or `selector`, `value` | Fills a field |
| `press` | `key`, optional `ref` or `selector` | Focuses the element if given, then presses the key |
| `hover` | `ref` or `selector` | Moves the mouse over it (menus, tooltips) |
| `select_option` | `ref` or `selector`, `values` | Picks options in a `<select>`, matched by value or visible label |
| `upload` | `ref` or `selector`, `file` (a **name**) | Attaches a file the user designated in `uploads.json` to a file field. `file` is never a path. Refused unless the field's form posts to the page's own site; see "Uploading a file" below. Not offered to a read-only (checker) browser; with no files designated it attaches nothing. |
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
[s4e12] spinbutton "Years of experience" id="years" value="" frame="grnhse_iframe"
[s4e14] textbox "Shadow field" id="shadowfield" value="" in-shadow-root
```

A line ends with `frame="<name>"` when the element is inside an iframe (the frame's name or id, or where it loaded from) and `in-shadow-root` when it is inside an open shadow root. See section 4c.

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

A click, key press or click-by-coordinates that closes its own page (a popup's "Close" button) is reported as a
note, `Tab t2 closed while this ran (most likely this click closed it)`, not as an error. Playwright may finish
the action against a page that is already gone and say so; that is the action working, and an error would send
the model off to retry or re-inspect. A failure that is *not* followed by the page closing is still an error.


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

Only `localhost` and `127.0.0.1` are reachable, from any page, tab or frame, **on any port**: a page served from one local port can make the browser send a request (a method, headers and a body of the page's
choosing) to every other service listening on this machine's loopback, and the gate lets it through (adversary round 2, A43: a raw listener on another port received a `POST` whose body was three lines of commands; whether a given
service acts on that depends on the service). Allowing only the port of the app under test is planned with the LIVE-mode allowances list (S2); until then "local-only" means "every local port". `open()`'s own check
isn't enough, because pages make requests without calling `open()`. So the boundary is enforced on
the browser context, in layers. Each layer was added because a real exploit got through without it:

| Channel | Layer that stops it | How we know |
|---|---|---|
| Links, forms, `fetch`/XHR, images, beacons, prefetch, `EventSource`, popups (the first URL of each request) | `context.route("**/*")` aborts every non-local request | Clicking a link reached a second server before this existed |
| **Every hop of a redirect**, the browser's own background requests, tunnels, the lookup of any name a page chooses | The network gate (`src/net-gate.ts`): all browser traffic goes through a proxy that refuses what is not on the list, resolves names itself and connects to the checked address | A 302 from an allowed page reached a decoy on `127.0.0.2` with the query string intact; `test/browser-redirect-gate.mjs` runs 16 ways of trying, and the mutation run kills 13 of 13 mutants |
| WebSocket | `context.routeWebSocket` closes non-local sockets with code 1008 before they connect; local sockets aren't matched and behave natively | A page's `new WebSocket()` reached a non-allowed host with the route gate in place: `route()` never sees WebSockets |
| WebRTC (STUN over UDP, TURN over TCP) | An init script removes `RTCPeerConnection` in every realm before page scripts run | STUN packets reached a non-allowed host (20 of them in one probe). Chromium's `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` did **not** stop them, even to a non-loopback address. The init script held in the main page, a fresh iframe read synchronously, `srcdoc`, `data:` and `blob:` iframes, and `window.open('')` popups |
| Service workers | `serviceWorkers: "block"` | Playwright's docs say `route()` can't see requests a service worker answers, and recommend blocking them whenever interception matters |
| Tabs and popups | All of the above, since every tab shares the one context | Tested per channel in a page-opened popup |
| Runaway popups | At most 10 tabs open at once and 60 in a session; the rest are closed as they arrive, counted, and `list_tabs` says how many | A page opening 25 popups gets 10; a storm of 150 leaves 60 ever held (A41) |

**The network gate (added after adversary round 1, finding A2).** The route handler is called once, for the first URL of a request. A server-side
redirect (301, 302, 303, 307, 308) is followed inside the browser and the handler never sees the next hop, so an allowed local page could send the
browser to any host, query string and cookies included. Reproduced: a decoy server on `127.0.0.2` received `/r301-exfil?data=secret` through one redirect
while a direct `open` of the same host was refused. The fix is a layer underneath: the browser is launched with a small forward proxy
(`src/net-gate.ts`) that **every** request has to go through, so each hop of a redirect is a new request that arrives there. It listens on `127.0.0.1`
only and requires a random credential, forwards only to hosts on the allowed list (TEST mode: `localhost` and `127.0.0.1`), does the name lookup itself
and connects to the address it checked and no other (so the browser's own resolver cannot be pointed elsewhere between the check and the connection),
tunnels `CONNECT` and `ws://` upgrades the same way, and tells the agent what it refused. It also sees the browser's own background requests, which no
page controls: this Chromium contacts `google.com` by itself at start-up, which the route handler never could have seen.

**DNS, measured (adversary round 2, A40).** In a private network namespace with a UDP sink on port 53, a page carrying `dns-prefetch`, `preconnect`, `prefetch`, an image, `WebTransport`, `fetch`, a WebSocket, a beacon, an
`EventSource` and a worker, each to its own `*.invalid` name, produced no question for any of those names: the gate resolves page-chosen names itself, so the page cannot use DNS to carry anything out. The browser's *own* resolver
traffic is not behind the gate, though: the sink saw Chromium's DNS-over-HTTPS probe asking for `dns.google` (type 1 and type 65, four times each). The names are fixed, not the page's, so this is not an exfiltration path, but a
TEST-mode run on a machine whose resolver is reachable is not silent on the network. Launching with the DoH and async-DNS features off and a host-resolver rule that maps everything but loopback to nothing would close it; that is not done.

An earlier note here said a dead proxy "couldn't be verified" because Chromium sent loopback targets around it. Playwright adds `<-loopback>` to the
bypass list when a proxy is set (unless `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK` is set), and this was checked: the gate saw requests to
`127.0.0.1`. The redirect test (`test/browser-redirect-gate.mjs`) is the canary on every platform: if loopback ever bypasses the proxy, the decoy
receives a request and the test fails. `route`, `routeWebSocket`, the WebRTC removal and blocked service workers all stay, as further layers.

The test (`test/browser-computer-use.mjs`) points everything at a listener on `127.0.0.2`: loopback,
so nothing leaves the machine, but not an allowed host. It counts every HTTP request, WebSocket
upgrade and UDP packet that arrives. A control run in an undefended browser must register leaks
first, or a zero would prove nothing. On macOS, where `127.0.0.2` isn't routed by default, the
check says it's skipped instead of passing.

## 4b. What the page did: notices

Before this, a page with an uncaught exception, a `console.error` and a 404'd script looked healthy through `inspect`, dialogs were
dismissed without a word and downloads discarded unseen (found by running the tools: [`REFERENCE-AUDIT.md`](REFERENCE-AUDIT.md)). Now each tab is
watched, and **every tool result ends with a "Page notices" block listing what is new since the last result**:

| Kind | From | Shown as |
|---|---|---|
| `pageerror` | an uncaught exception | its message |
| `console.error`, `console.warn` | the page's console | the message. `console.log` and `info` are only counted. |
| `http` | any response with status 400 or above, subresource or document | `404 GET host/path (script)` |
| `blocked` | a request our own localhost-only rule stopped | `blocked by the localhost-only rule: host/path` |
| `netfail` | a request that failed for another reason | the browser's error and `host/path` |
| `dialog` | `alert`, `confirm`, `prompt`, `beforeunload` | kind and message; **dismissed** (a `confirm` reads `false` to the page), as Playwright already did silently |
| `download` | a file the page tried to save | name and source; **cancelled, never saved** |
| `crash` | the tab crashed | |

How it stays safe and small:

- **The text is the page's, so it is data.** Control bytes and invisible characters are stripped, each notice is cut to 200 characters, and
  the block says the text is data, not instructions. A URL in a notice is `host/path`: never a query string or a fragment (they can hold tokens).
- **Bounded, and it says when it dropped something.** At most 8 lines per result (the rest summarised as "+N more"), 200 notices kept, identical
  messages collapse into one with a count (`x100`). When the buffer is full the least informative entry goes first (a one-off console line
  before a repeated one, a warning before an exception), not simply the oldest. An oldest-first buffer threw away a message repeated 100 times
  to keep 200 one-offs, which the test found.
- **A failure that happens again is reported again** (adversary round 2, A21). A repeat of a notice that was already shown becomes undelivered again and goes to the end of the order, so the next result carries it as `(x2, 1 since you last looked)`, and the bus hears when the count passes 2, 10 and 100. Before, the click that failed after a "fix" and a verifier's reload of the page the builder saw failing both heard nothing.
- **`notices` lists what the results left out** (A50): entries the agent has not seen come first, the head says how many are not listed and how to see them, and only entries that were listed count as delivered.
- **A burst is let to finish** (up to 480 ms, stopping at the first 120 ms lull, only when there is something to show) so the counts are the final ones. The lull was 60 ms until a very slow macOS CI machine reported a burst half finished.
- **A popup is heard from its first message.** Console output, uncaught exceptions and dialogs are listened to on the whole browser context as well as on each page, because a popup's page object only reaches us after it has started loading: under CPU load its first error was lost 3 runs in 5 when only page listeners existed. An unknown page that speaks is adopted as a tab on the spot, and each event is handled once whichever level hears it first.
- The browser's own `favicon.ico` request is not news.
- Each notice is also a `browser-notice` event (capped at 300 per session) for the page and, later, the watchdog.

Measured by the benchmark: `observability` went from 0 of 8 to 8 of 8 ([`BENCHMARK.md`](BENCHMARK.md), [`IMPROVEMENTS.md`](IMPROVEMENTS.md) IMP-008).

## 4c. Reading the whole page: frames, shadow roots and fields nobody can see

Adversary round 1 (finding A10) showed `inspect` listed one field of four on a page with an iframe and a shadow root, while `fill` by selector wrote into the shadow-root field it had not
listed. Any check built on that reader (a form diff, a job-id check, a hidden-text check) would have passed because nothing was inspected. Since S1b (IMP-014):

- **One walk, one budget.** `inspect` walks the main document, every open shadow root (nested ones too, in document order) and every readable frame, same-origin or cross-origin (the browser
  can read both; a page's own scripts cannot, and the [network gate](#4-the-local-only-boundary) already decided what a frame may load). The 60-ref budget is shared; the surplus is counted.
  Refs into a frame or a shadow root work with `click`, `fill`, `select_option`, `hover`, `press` and `scroll` like any other.
- **Page text is data and is marked as data** (A37). The visible text of `inspect` is stripped of control, bidi and zero-width characters, fenced between `<<<` and `>>>`, and a line that starts like one of the tool's own blocks (`Interactive elements`, `[s9e1]`, `Not listed, and why`, `[Page notices`, `URL:`) is prefixed `(page text)`, so a page cannot print a convincing copy of a block. URLs show protocol, host and path only (`(query and fragment withheld)`), and titles are cut at 200 characters (A38).
- **A query searches the whole page first** (A47). `inspect` with `query` filters inside the page (up to 600 candidates) before the 60-ref budget applies to the matches, and the answer says how many it looked at and when the list stops. A page past 100,000 elements per frame says the search stopped there (A26).
- **Frame text is read too.** `inspect`'s visible text and the `text` tool include the text of each readable frame under `[frame "name"]`, bounded (1,000 characters a frame, 3,000 in all in `inspect`).
- **What could not be read is said**, in a "Not listed, and why" block after the elements: a frame still loading (inspect waits up to 1.5 s for frames, then says so and asks you to inspect again), a
  frame that did not load, a frame whose read failed (named, with the reason; the rest of the page is still listed), more than 20 frames (the rest counted), a frame nobody can see that holds form fields,
  and custom elements that may hold a **closed** shadow root (a script cannot look inside one). That is a heuristic that finds one kind: a defined custom element with no children and no open root. A closed root on an ordinary element, or on a custom element that has children (a slot), is **not** reported (adversary round 2, A26; an `attachShadow` init script to catch the rest is planned with S5).
- **Fields a person cannot see are named, not offered.** A text field or text area with opacity 0 (itself or an ancestor), a box of 1px or less, or a position outside the page *and outside any panel that scrolls to it* is listed under "Not visible to a person"
  with its id, name and reason, and is **not given a ref**. `fill` refuses such a field (and `display:none` and `type=hidden` ones) with "not visible to a person": form builders use fields like these to catch
  bots, and a refusal costs the agent one message. A field further down a scrolling panel (a 30-question dialog) is offered, because a person scrolls it (A24). **This covers those three signals and nothing wider** (adversary round 2, A25): opacity 0.01, a 2px box, transparent text, `font-size:0`, a `clip` rectangle, `z-index:-1`, and every `contenteditable` pass. Checkboxes, radios, selects and buttons are not judged (custom-styled controls hide the real input behind a label as a matter of course), and `display:none` fields are
  not reported (a multi-step form has many). This is a safety rule, not an evasion: it makes the agent *less* like a bot, never more.
- **A selector cannot reach into a frame**, and now says so at once: "`#years` is inside an iframe (frame "grnhse_iframe"), which selectors cannot reach. Call inspect and use the ref of that element." (Selectors
  still reach open shadow roots; Playwright pierces them.)

**The reader is advisory against a page that cooperates with it** (A22). The walk and the fill guard run in the page's own JavaScript world, so a page that overrides `checkVisibility` and `getBoundingClientRect` gets its honeypot offered and filled, and one that wraps `matches` can make a real field vanish from `inspect` without a note. Running them where the page cannot reach (an isolated world) is scheduled before S5, which depends on it.

**Typed values** (A42): the value typed into a password, one-time-code or card field (by type, `autocomplete` hint or name), into a field that could not be checked, and a single typed character are not recorded in the event stream or the audit database; their length is. An ordinary field's value and named keys (`Enter`, `Tab`) still are.

**Deadlines and popups** (A31, A41): every tool gives up on a page that does not answer after 60 s ("the page is not responding"), opens a fresh tab so the run can carry on and leaves the stuck one closable; `list_tabs` bounds each tab's title. A session holds at most 10 tabs open and 60 in all.

Measured by the benchmark: `form-coverage` went from 1 of 8 to 8 of 8 ([`BENCHMARK.md`](BENCHMARK.md), [`IMPROVEMENTS.md`](IMPROVEMENTS.md) IMP-014).

## 4d. Uploading a file (S2 increment 4)

The agent never names a path. The user lists the files it may attach in `<agent-loop home>/uploads.json` (their own directory, never the project), by name:

```json
{"files": {"resume": "/home/you/documents/resume.pdf", "cover-letter": {"path": "/home/you/documents/cover.docx", "sha256": "<64 hex characters>", "maxBytes": 2000000}}}
```

Only document and image types (pdf, doc, docx, rtf, txt, odt, png, jpg, jpeg); the path is absolute and names a file; nothing inside the agent-loop directory (it holds the saved sign-ins). The file is read like the allowances file (a link, a file others can write, or someone else's is refused). At the moment of use the file must still be a regular file, not a link, within its size limit, at the real path it had when the session started, and (if pinned) with the content that was pinned.

`upload {ref|selector, file: "resume"}` then checks the field before anything is attached: it is a file field, enabled, **inside a form that posts**, whose action and each submit or image button's own `formaction` go to the page's own site (LIVE: the same platform on the allowances list, so the employer's own subdomains are fine and another listed platform is not; TEST: the page's own server), in a frame that belongs to that site, with no `target` that opens the answer somewhere the check cannot follow. A field outside any form (a script would send the file) is refused with a message that says the page needs the file attached by hand. It looks again after attaching and takes the file back if the page changed its form meanwhile.

While a file is attached on a page, the network holds that tab's requests that are not plain reads (a form post, a `fetch` with a body) to the page's own site, and so are the requests of a window that page opened. This is what stops a page that rewrites its form after the check, or sends the file with a script, and the agent is told ("blocked by the upload rule"). The hold ends when a new page has loaded in the tab (a form submitted, a link followed); a script that only changes the address does not end it.

What it does not stop: the page's own scripts can read the file once it is attached, and a listed page can still send a small GET (an image beacon) to any public host (threat D1). The user's list is the trust boundary.

## 5. Limits

| Limit | Value | Why |
|---|---|---|
| Screenshots per session | 50 | Disk-fill DoS from a looping phase |
| Tabs per session | 10 open at once, 60 in all | A renderer and a video per popup otherwise; a storm of popups that close themselves |
| Browser tool deadline | 60 s (`wait` is 30 s) | A page whose main thread is busy answers nothing, and no Playwright timeout covers every call that waits on it |
| Elements scanned per frame | 100,000, and the answer says so | A page of data cannot stall the walk |
| Query candidates | 600 before the 60-ref budget | A query finds the 98th button without listing 98 |
| Refs per `inspect` | 60 across the page and its frames, plus a count of the rest | A page with thousands of links shouldn't flood the transcript |
| Frames read per `inspect` | 20 (60 looked at), plus a count of the rest; 1.5 s to wait for frames still loading | A page of ad frames cannot stall the reader |
| Frame text in `inspect` | 1,000 characters a frame, 3,000 in all | The same reason as the page text |
| `wait` | 30 s | |
| Notices per result / kept / bus events | 8 / 200 / 300 | A noisy page cannot flood the transcript, the buffer or the event store |
| Notice text | 200 characters | Page-controlled text stays short |
| `text` section | 8,000 characters | Long pages are read in steps |
| Viewport | 320-3840 by 240-2160 | |
| `scroll` / `scroll_at` delta | ±20,000 px per call | |

## 6. Events

Every tool emits `browser-action-started` and `browser-action-completed`, with a shared `actionId`,
timing and the result text. `screenshot` also emits `browser-snapshot`; screenshots and videos emit
`browser-artifact-created`. A page's problems emit `browser-notice` (section 4b). The session emits `browser-session-started` and `-ended`. The terminal
and the web UI label each call by what it acted on: `browser.click(s2e5)`,
`browser.click_at(120, 44 @ shot-3)`, `browser.switch_tab(t2)`.

## 7. Known limitations

- **Pages that use WebRTC break by design.** Apps agent-loop verifies locally haven't needed it.
- **A dropped WebSocket `close` event (Playwright quirk).** Say a page opens two popups in the same
  script while a blocked WebSocket is pending. The socket still ends `CLOSED` and never connects,
  but the page's `close` event doesn't fire. Found while writing the Stage 1 test. Security is
  unaffected; an app waiting on that event would wait forever.
- **DNS: page-chosen names stay out of it, the browser's own probe does not.** Measured (section 4): the names a page asks for never reach a resolver, but Chromium's own DNS-over-HTTPS probe asks for `dns.google` outside the gate.
- **"Local" means every local port.** A page can reach any service on this machine's loopback (section 4, A43) until the allowances list has ports.
- **Dialogs are dismissed, not answered.** The agent is told what a dialog said, but cannot choose to accept it (a "Discard changes?" confirm always reads `false`). Letting it decide needs the page held open until it answers.
- **Closed shadow roots cannot be read.** A script cannot look inside one, so their fields are not listed; `inspect` says a custom element *may* hold one only when it is a defined custom element with no children and no open root, so a closed root on a `div`, or on an element with children, is silent.
- **Frames are read once per `inspect`.** A frame that navigates afterwards makes its refs stale (the usual stale-ref message); inspect again. A frame injected by a script after `inspect` is not listed until the next one.
- **The "person could not see it" test is geometry and style only, and only three signals** (opacity 0, a box of 1px or less, outside the page and any scrolling panel). A field covered by another element, clipped by a scroll container or hidden by `clip-path`, and the recipes opacity 0.01, a 2px box, transparent text, `font-size:0`, a `clip` rectangle, `z-index:-1` and `contenteditable` count as visible. `elementFromPoint` at the field's centre is the cheapest next check.
- **The reader runs in the page's own JavaScript world** (section 4c): a page that cooperates with the reader's geometry questions can lie to it.
- **Text-field traps only.** A visually hidden checkbox or select is listed like any other; if a form uses those as bot traps, this reader does not know.
