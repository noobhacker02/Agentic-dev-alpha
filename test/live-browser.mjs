// LIVE mode in the real browser tools (docs/HYBRID-AGENT-SPEC.md, S2 increment 2): the agent may navigate only where the allowances list says, a page it is sent to by a server-side redirect that lands
// off the list is shown nothing, and the network gate keeps private addresses and denied hosts out. A real Chromium goes through the real gate to a local "internet": one server that answers for several
// host names (jobs.example, ats.example, evil.example, ...) and counts, per name, what reached it. A resolver stand-in points every .example name at 127.0.0.1 (and internal.example at 10.0.0.5), and a
// stand-in for "public" treats only 127.0.0.1 as public, so no real network is used and the real address rule is exercised separately (test/live-policy.mjs).
// Each refusal has a control (the same kind of thing works on the list) and a counter on the far side.
//   npm run build && npm run test:live-browser
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { WebSocketServer } from "ws";
import { BrowserSessionManager, __testHandlers } from "../dist/browser-tools.js";
import { liveBrowserPolicy } from "../dist/browser-policy.js";
import { parseAllowances } from "../dist/allowances.js";
import { EventBus } from "../dist/bus.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const hits = {};
const seen = (host) => hits[host] ?? [];
let P = 0;
const E = () => `http://evil.example:${P}`;
const html = (res, title, body, headers = {}) => { res.writeHead(200, { "content-type": "text/html", ...headers }); res.end(`<!doctype html><title>${title}</title>${body}`); };
const server = createServer((req, res) => {
  const host = String(req.headers.host).split(":")[0];
  (hits[host] ??= []).push(req.url);
  const u = new URL(req.url, "http://x");
  if (host === "cdn.example") {
    if (u.pathname === "/pixel.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
    if (u.pathname === "/s.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end("document.body.insertAdjacentHTML('beforeend','<p>CDN-SCRIPT-RAN</p>')"); }
  }
  if (host === "ads.example") { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
  if (host === "evil.example" && u.pathname === "/stall") {
    // headers and the first of the page arrive (the browser commits and the title is known), then nothing for a while: the load a redirect landing interrupts
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<!doctype html><title>EVIL-TITLE</title><h1>EVIL-PAGE-TEXT</h1>");
    setTimeout(() => res.end("<p>done</p>"), 4000).unref();
    return;
  }
  if (host === "evil.example") return html(res, "EVIL-TITLE", "<h1>EVIL-PAGE-TEXT</h1>");
  if (host === "ats.example") return html(res, u.pathname === "/popup-page" ? "ATS-POPUP-TITLE" : "ATS", "<h1>ATS-FORM-TEXT</h1>");
  if (host === "internal.example") return html(res, "INTERNAL", "<h1>INTERNAL-TEXT</h1>");
  // jobs.example
  switch (u.pathname) {
    case "/r": res.writeHead(302, { location: u.searchParams.get("to") }); return res.end();
    case "/chain": res.writeHead(301, { location: `/r?to=${encodeURIComponent(`/r?to=${encodeURIComponent(E() + "/landed")}`)}` }); return res.end();
    case "/meta": return html(res, "meta", `<meta http-equiv="refresh" content="0;url=${E()}/meta">meta`);
    case "/jsnav": return html(res, "jsnav", `<script>location.href = "${E()}/jsnav"</script>jsnav`);
    case "/frame-evil": return html(res, "frame", `<h1>FRAME-HOST</h1><iframe src="${E()}/inframe"></iframe>`);
    case "/frame-ats": return html(res, "frame", `<h1>FRAME-HOST</h1><iframe src="http://ats.example:${P}/apply"></iframe>`);
    case "/frame-redirect": return html(res, "frame", `<h1>FRAME-HOST</h1><iframe src="/r?to=${encodeURIComponent(E() + "/inframe-redirect")}"></iframe>`);
    case "/popup-ok": return html(res, "popup", `<button id="p" onclick="window.open('http://ats.example:${P}/popup-page')">open listed popup</button>`);
    case "/popup-redirect": return html(res, "popup", `<button id="p" onclick="window.open('/r?to=${encodeURIComponent(E() + "/stall")}')">open redirecting popup</button>`);
    case "/popup": return html(res, "popup", `<button id="p" onclick="window.open('${E()}/popup')">open popup</button>`);
    case "/ws-evil": return html(res, "ws", `<script>try { new WebSocket("ws://evil.example:${P}/sock") } catch (e) {}</script>ws-evil`);
    case "/ws-ok": return html(res, "ws", `<p id="out">waiting</p><script>const s = new WebSocket("ws://jobs.example:${P}/echo"); s.onopen = () => s.send("hi"); s.onmessage = (m) => { document.getElementById("out").textContent = "WS-" + m.data; };</script>`);
    case "/ads": return html(res, "ads", `<img src="http://ads.example:${P}/a.png">ads`);
    case "/rebind": return html(res, "x", "x");
    default:
      return html(res, "Jobs", `<h1>Jobs home</h1><img src="http://cdn.example:${P}/pixel.png"><script src="http://cdn.example:${P}/s.js"></script>` +
        `<a href="${E()}/x">evil link</a> <a href="http://ats.example:${P}/apply">ats link</a>`);
  }
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, sock, head) => {
  const host = String(req.headers.host).split(":")[0];
  (hits[host] ??= []).push("UPGRADE " + req.url);
  wss.handleUpgrade(req, sock, head, (ws) => ws.on("message", (m) => ws.send(String(m))));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
P = server.address().port;

const allowances = parseAllowances({ allow: ["jobs.example", "ats.example", "internal.example"], deny: ["ads.example"], platforms: { jobs: ["jobs.example"] } }).value;
const resolve = async (host) => (host === "internal.example" ? ["10.0.0.5"] : host.endsWith(".example") ? ["127.0.0.1"] : (() => { throw new Error("ENOTFOUND"); })());
const J0 = (path = "/") => `http://jobs.example:${P}${path}`;
const policy = liveBrowserPolicy(allowances, { isPublic: (ip) => ip === "127.0.0.1", resolve, extraPorts: [P] });

// 0. The policy's own decisions, with no browser: what a request, a WebSocket, `open` and a landing page may be
{
  const nav = { navigation: true }, sub = { navigation: false };
  const ok = (v) => v.ok === true;
  assert.ok(ok(policy.allowRequest("about:blank", nav)));
  assert.ok(ok(policy.allowRequest(J0("/"), nav)) && ok(policy.allowRequest(`http://ats.example:${P}/x`, nav)));
  assert.ok(!ok(policy.allowRequest(`http://evil.example:${P}/`, nav)) && ok(policy.allowRequest(`http://evil.example:${P}/x.js`, sub)), "a navigation is judged, a subresource is the gate's");
  assert.ok(!ok(policy.allowRequest("data:text/html,hi", nav)) && ok(policy.allowRequest("data:image/png;base64,AA", sub)), "a data: page is refused, a data: image is not");
  assert.ok(!ok(policy.allowRequest("blob:http://jobs.example/x", nav)) && ok(policy.allowRequest("blob:http://jobs.example/x", sub)));
  for (const u of ["file:///etc/passwd", "ftp://jobs.example/", "chrome://settings", "javascript:1"]) assert.ok(!ok(policy.allowRequest(u, sub)) && !ok(policy.allowRequest(u, nav)), u);
  assert.ok(!ok(policy.allowRequest("not a url", sub)));
  assert.ok(policy.allowWebSocket(`ws://jobs.example:${P}/x`) && policy.allowWebSocket("wss://www.jobs.example/x"));
  for (const u of [`ws://evil.example:${P}/`, `ws://ads.example:${P}/`, `ws://127.0.0.1:${P}/`, `ws://[::1]:${P}/`, `http://jobs.example:${P}/`, "ws://localhost/", "not a url"]) assert.ok(!policy.allowWebSocket(u), u);
  for (const u of ["about:blank", "", "about:srcdoc", "chrome-error://chromewebdata/", "data:text/html,x", "blob:http://jobs.example/x", J0("/")]) assert.ok(ok(policy.landing(u)), `landing ${u}`);
  for (const u of [`http://evil.example:${P}/`, `http://127.0.0.1:${P}/`, "file:///x", `http://ads.example:${P}/`]) assert.ok(!ok(policy.landing(u)), `landing ${u}`);
  assert.ok(policy.checkOpen(J0("/")).ok);
  const m = policy.checkOpen(`http://evil.example:${P}/`);
  assert.ok(!m.ok && /^Refused: .*evil\.example.*not on the allowances list/.test(m.message), JSON.stringify(m));
  assert.ok(/allowances list/.test(policy.openDescription) && policy.blockedLabel === "the allowances list" && policy.mode === "live");
  console.log("[ok] the policy's own decisions: navigations are judged and subresources are the gate's, data: and blob: pages are refused, other schemes are refused, WebSockets go only to listed names, a landing page is judged, open says why");
}

const bus = new EventBus();
const events = [];
bus.on("event", (e) => events.push(e));
const sessions = new BrowserSessionManager({ policy });
const h = __testHandlers({ runId: "lb", bus, sessions, artifactDir: mkdtempSync(join(tmpdir(), "lb-art-")) });
const shown = [];
const call = async (name, args = {}) => {
  try { const r = await h[name].handler(args, {}); const text = r.content.map((c) => c.text ?? "").join("\n"); shown.push(text); return { text, isError: !!r.isError }; }
  catch (e) { const text = "THREW " + e.message; shown.push(text); return { text, isError: true }; }
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const fresh = async () => { await sessions.close("lb", bus, "completed").catch(() => {}); for (const k of Object.keys(hits)) delete hits[k]; shown.length = 0; events.length = 0; };
const J = (path = "/") => `http://jobs.example:${P}${path}`;
const noEvilShown = (why) => assert.ok(!shown.some((t) => /EVIL-PAGE-TEXT|EVIL-TITLE/.test(t)), `${why}: text from an off-list page reached the agent:\n${shown.join("\n---\n").slice(0, 900)}`);
const refOf = async (label) => { const i = await call("inspect"); const m = new RegExp(`(s\\d+e\\d+)[^\\n]*${label}`).exec(i.text); assert.ok(m, `no element "${label}" in:\n${i.text.slice(0, 600)}`); return m[1]; };

try {
  // 0. Controls: the far side counts, and a page on the list opens with its subresources (a CDN that is not on the list) and its own WebSocket
  {
    await fresh();
    const o = await call("open", { url: J("/") });
    assert.ok(!o.isError && /Opened/.test(o.text) && /Title: Jobs/.test(o.text), `control: opening a listed page failed: ${o.text}`);
    await settle(400);
    const i = await call("inspect");
    assert.ok(/Jobs home/.test(i.text) && /CDN-SCRIPT-RAN/.test(i.text), `control: a script from a host that is not on the list did not run:\n${i.text.slice(0, 500)}`);
    assert.ok(seen("cdn.example").includes("/pixel.png") && seen("cdn.example").includes("/s.js"), "control: the CDN received no request");
    const a = await call("open", { url: `http://ats.example:${P}/apply` });
    assert.ok(!a.isError && /Title: ATS/.test(a.text), `control: a second listed host failed: ${a.text}`);
    await call("open", { url: J("/ws-ok") });
    await settle(500);
    assert.ok(/WS-hi/.test((await call("inspect")).text), "control: a WebSocket to a listed host did not work");
    console.log("[ok] controls: a listed page opens, a script and image from an unlisted CDN load, a second listed host opens, a WebSocket to a listed host works, and the far side counts");
  }

  // 1. open: everything but a listed name over http(s) on a normal port is refused before any request
  {
    await fresh();
    const refused = [
      [`http://evil.example:${P}/`, /evil\.example.*not on the allowances list/],
      [`http://127.0.0.1:${P}/`, /address/i],
      [`http://localhost:${P}/`, /allowances list|localhost/i],
      [`http://jobs.example:${P + 1}/`, /port/i],
      ["file:///etc/passwd", /only http and https/i],
      ["ftp://jobs.example/", /only http and https/i],
      ["javascript:alert(1)", /only http and https/i],
      [`http://ads.example:${P}/`, /denied/i],
      [`http://user:pw@jobs.example:${P}/`, /credentials/i], // devskill:allow (a made-up credential, to prove it is refused)
    ];
    for (const [url, why] of refused) {
      const r = await call("open", { url });
      assert.ok(r.isError && /Refused/.test(r.text) && why.test(r.text), `${url} -> ${r.text}`);
    }
    assert.deepStrictEqual(Object.keys(hits), [], "something reached the far side although every open was refused");
    console.log("[ok] open refuses an unlisted or denied name, every address spelling, localhost, another port, other schemes and credentials, and nothing reaches the far side");
  }

  // 2. A link, a script navigation, a meta refresh, an iframe and a popup to an unlisted host are aborted at the first hop
  {
    for (const [name, run] of [
      ["link", async () => { await call("open", { url: J("/") }); await settle(300); const ref = await refOf("evil link"); return call("click", { ref }); }],
      ["script navigation", async () => call("open", { url: J("/jsnav") })],
      ["meta refresh", async () => call("open", { url: J("/meta") })],
      ["iframe", async () => call("open", { url: J("/frame-evil") })],
      ["popup", async () => { await call("open", { url: J("/popup") }); await settle(200); const ref = await refOf("open popup"); return call("click", { ref }); }],
    ]) {
      await fresh();
      await run();
      await settle(500);
      const after = await call("inspect");
      assert.deepStrictEqual(seen("evil.example"), [], `${name}: the off-list host received ${JSON.stringify(seen("evil.example"))}`);
      noEvilShown(name);
      assert.ok(events.some((e) => e.type === "browser-notice" && e.kind === "blocked" && /not on the allowances list/.test(e.text) && /evil\.example/.test(e.text)), `${name}: no notice names the refusal: ${JSON.stringify(events.filter((e) => e.type === "browser-notice").map((e) => e.text))}`);
      void after;
    }
    console.log("[ok] a link, a script navigation, a meta refresh, an iframe and a popup to an unlisted host are aborted before any request; the agent is told which host and why");
  }

  // 3. Control: a link and an iframe to another listed host work
  {
    await fresh();
    await call("open", { url: J("/") });
    await settle(300);
    const ref = await refOf("ats link");
    await call("click", { ref });
    await settle(500);
    assert.ok(/ATS-FORM-TEXT/.test((await call("inspect")).text), "control: a link to another listed host did not work");
    await fresh();
    await call("open", { url: J("/frame-ats") });
    await settle(600);
    assert.ok(/ATS-FORM-TEXT/.test((await call("inspect")).text), "control: an iframe from a listed host did not show its text");
    console.log("[ok] controls: a link and an iframe to another listed host work");
  }

  // 4. A server-side redirect cannot be stopped before the browser follows it (the browser's interception sees only the first URL): the request is made, and the agent is shown nothing of the page it lands on
  {
    for (const [name, path] of [["302", `/r?to=${encodeURIComponent(E() + "/landed")}`], ["a chain of three", "/chain"], ["a page that stalls while it loads", `/r?to=${encodeURIComponent(E() + "/stall")}`]]) {
      await fresh();
      const o = await call("open", { url: J(path) });
      await settle(400);
      assert.ok(o.isError && /redirect/i.test(o.text) && /evil\.example/.test(o.text) && /allowances list/.test(o.text), `${name}: the agent was not told the page redirected off the list:\n${o.text}`);
      assert.ok(/Error: Refused: the page redirected to evil\.example:\d+\//.test(o.text), `${name}: the refusal itself (not only a notice after it) does not say where the page landed:\n${o.text}`);
      assert.ok(seen("evil.example").length >= 1, `${name}: control: the redirect was expected to reach the host (the request is made; the content is what is withheld)`);
      noEvilShown(`${name} redirect`);
      const i = await call("inspect");
      assert.ok(!/EVIL/.test(i.text), `${name}: inspect after the redirect showed the page`);
      const tabs = await call("list_tabs");
      assert.ok(!/EVIL/.test(tabs.text), `${name}: list_tabs showed the page`);
    }
    // control: a redirect to another listed host is followed and reported
    await fresh();
    const ok = await call("open", { url: J(`/r?to=${encodeURIComponent(`http://ats.example:${P}/apply`)}`) });
    assert.ok(!ok.isError && /redirected/i.test(ok.text), `control: a redirect between listed hosts failed: ${ok.text}`);
    console.log("[ok] a redirect off the list (one hop or three) is reported as such, the page it landed on is blanked and none of its text or title ever reaches the agent; a redirect between listed hosts works");
  }

  // 5. The same inside an iframe: the frame is blanked, its text is not shown
  {
    await fresh();
    await call("open", { url: J("/frame-redirect") });
    await settle(700);
    const i = await call("inspect");
    assert.ok(/FRAME-HOST/.test(i.text), "control: the outer page was lost");
    noEvilShown("iframe redirect");
    assert.ok(events.some((e) => e.type === "browser-notice" && e.kind === "blocked" && /evil\.example/.test(e.text)), "no notice says the frame landed off the list");
    console.log("[ok] an iframe redirected off the list is blanked and its text never reaches the agent");
  }

  // 5b. A popup that a redirect carries off the list has committed before the page is reported: it is still blanked, noticed, and its title and address are not listed (adversary round 3, A58)
  {
    await fresh();
    await call("open", { url: J("/popup-redirect") });
    await settle(200);
    await call("click", { ref: await refOf("open redirecting popup") });
    for (const wait of [150, 600, 1500]) {
      await settle(wait);
      const tabs = await call("list_tabs");
      const lines = tabs.text.split("\n[Page notices")[0]; // the notice that follows names the host on purpose; the listing must not
      assert.ok(!/EVIL|evil\.example/.test(lines), `list_tabs showed the redirected popup's title or address:\n${tabs.text}`);
    }
    const t2 = await call("switch_tab", { tabId: "t2" });
    assert.ok(!/evil\.example/.test(t2.text.split("\n[Page notices")[0]), `switch_tab showed the redirected popup's address:\n${t2.text}`);
    noEvilShown("popup redirect");
    assert.ok(events.some((e) => e.type === "browser-notice" && e.kind === "blocked" && /evil\.example/.test(e.text)), "no notice says the popup landed off the list");
    // control: a popup to a listed host is listed with its title
    await fresh();
    await call("open", { url: J("/popup-ok") });
    await settle(200);
    await call("click", { ref: await refOf("open listed popup") });
    await settle(600);
    assert.ok(/ATS-POPUP-TITLE/.test((await call("list_tabs")).text), "control: a popup to a listed host was hidden");
    console.log("[ok] a popup carried off the list by a redirect is blanked and noticed, and list_tabs and switch_tab do not print its title or address; a popup to a listed host is listed");
  }

  // 6. WebSockets: to an unlisted host never connects; the denied host and a private address are the gate's
  {
    await fresh();
    await call("open", { url: J("/ws-evil") });
    await settle(600);
    assert.deepStrictEqual(seen("evil.example"), [], `a WebSocket reached the unlisted host: ${JSON.stringify(seen("evil.example"))}`);
    console.log("[ok] a WebSocket to an unlisted host never connects");
  }

  // 7. The gate: a denied host's subresource and an allowed name that resolves to a private address
  {
    await fresh();
    await call("open", { url: J("/ads") });
    await settle(500);
    assert.deepStrictEqual(seen("ads.example"), [], "a denied host's image was fetched");
    await fresh();
    const r = await call("open", { url: `http://internal.example:${P}/` });
    await settle(300);
    assert.deepStrictEqual(seen("internal.example"), [], "a listed name that resolves to a private address was reached");
    assert.ok(!/INTERNAL-TEXT/.test(shown.join("\n")), "text from a private address reached the agent");
    assert.ok(r.isError || events.some((e) => e.type === "browser-notice" && /not allowed|resolves/.test(e.text)), `nothing told the agent: ${r.text} | events: ${JSON.stringify(events.filter((e) => e.type === "browser-notice").map((e) => [e.kind, e.text]))} | gate: ${JSON.stringify(sessions.get("lb")?.gate?.denied)}`);
    console.log("[ok] a denied host's subresource is not fetched; a listed name that resolves to a private address is not reached and its text never arrives");
  }
  console.log("\nALL LIVE BROWSER TESTS PASSED");
} finally {
  await sessions.close("lb", bus, "completed").catch(() => {});
  server.close();
}
process.exit(0);
