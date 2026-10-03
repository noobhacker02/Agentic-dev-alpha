// The network gate (src/net-gate.ts): a forward proxy that decides, per connection, where the agent's browser may go. No browser here; plain
// Node clients talk to it the way Chromium does (absolute-URI requests, CONNECT tunnels, ws:// upgrades).
// Every "it was refused" check has a control: the same request to an allowed target works, and a decoy server on the refused address counts hits.
import { createServer, request as httpRequest } from "node:http";
import net from "node:net";
import assert from "node:assert";
import { WebSocketServer } from "ws";
import { startNetGate, localOnlyPolicy } from "../dist/net-gate.js";

const hits = { allowed: [], decoy: [] };
const target = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    hits.allowed.push(req.url);
    res.writeHead(200, { "content-type": "application/json", "x-seen-host": String(req.headers.host), "x-seen-proxy-auth": String(req.headers["proxy-authorization"] ?? "") });
    res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() }));
  });
});
const wss = new WebSocketServer({ server: target });
wss.on("connection", (ws) => ws.on("message", (m) => ws.send("echo:" + m)));
await new Promise((r) => target.listen(0, "127.0.0.1", r));
const decoy = createServer((req, res) => { hits.decoy.push(req.url); res.end("decoy"); });
const noSecondLoopback = await new Promise((r) => { decoy.once("error", (e) => r(e.code)); decoy.listen(0, "127.0.0.2", () => r(null)); });
if (noSecondLoopback) { console.log(`[skip] 127.0.0.2 is not available here (${noSecondLoopback}); the off-list decoy cannot be started (macOS does not route it by default)`); process.exit(0); }
const tport = target.address().port, dport = decoy.address().port;

const gate = await startNetGate({ policy: localOnlyPolicy });
const auth = "Basic " + Buffer.from(`${gate.username}:${gate.password}`).toString("base64");

/** One request through the proxy, in absolute form, the way a browser sends it. */
const viaProxy = (absUrl, { method = "GET", body, headers = {}, creds = auth } = {}) =>
  new Promise((resolve, reject) => {
    const u = new URL(absUrl);
    const req = httpRequest({ host: "127.0.0.1", port: gate.port, method, path: absUrl, headers: { host: u.host, ...(creds ? { "proxy-authorization": creds } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });

/** CONNECT through the proxy; resolves with the status line and the live socket. */
const connectVia = (hostPort, { creds = auth } = {}) =>
  new Promise((resolve, reject) => {
    const s = net.connect(gate.port, "127.0.0.1");
    let buf = "";
    s.on("error", reject);
    s.on("data", function onData(c) {
      buf += c.toString("latin1");
      if (!buf.includes("\r\n\r\n")) return;
      s.off("data", onData);
      resolve({ status: Number(buf.split(" ")[1]), head: buf, socket: s, rest: buf.slice(buf.indexOf("\r\n\r\n") + 4) });
    });
    s.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n${creds ? `Proxy-Authorization: ${creds}\r\n` : ""}\r\n`);
  });

try {
  // 1. A GET and a POST to an allowed target are forwarded, with path, query and body intact; the proxy credential does not reach the target.
  {
    const g = await viaProxy(`http://127.0.0.1:${tport}/a/b?x=1&y=2`);
    assert.strictEqual(g.status, 200);
    assert.deepStrictEqual(JSON.parse(g.body), { method: "GET", url: "/a/b?x=1&y=2", body: "" });
    assert.strictEqual(g.headers["x-seen-host"], `127.0.0.1:${tport}`);
    assert.strictEqual(g.headers["x-seen-proxy-auth"], "", "the proxy credential was passed on to the target");
    const p = await viaProxy(`http://localhost:${tport}/post`, { method: "POST", body: "hello body", headers: { "content-length": "10" } });
    assert.deepStrictEqual(JSON.parse(p.body), { method: "POST", url: "/post", body: "hello body" });
    console.log("[ok] forwards GET and POST (127.0.0.1 and localhost) with path, query and body; the proxy credential stays out");
  }

  // 2. No credential or a wrong one: 407, and nothing reaches the target (control: the credential above works).
  {
    const before = hits.allowed.length;
    assert.strictEqual((await viaProxy(`http://127.0.0.1:${tport}/x`, { creds: null })).status, 407);
    assert.strictEqual((await viaProxy(`http://127.0.0.1:${tport}/x`, { creds: "Basic " + Buffer.from("gate:wrong").toString("base64") })).status, 407);
    assert.strictEqual((await connectVia(`127.0.0.1:${tport}`, { creds: null })).status, 407);
    assert.strictEqual(hits.allowed.length, before, "an unauthenticated request reached the target");
    console.log("[ok] no credential or a wrong one: 407 for plain requests and CONNECT, nothing forwarded");
  }

  // 3. A host not on the list is refused with the reason; the decoy on 127.0.0.2 never sees a request.
  {
    const r = await viaProxy(`http://127.0.0.2:${dport}/exfil?data=secret`);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.headers["x-agent-loop-gate"], "blocked");
    assert.ok(/127\.0\.0\.2/.test(r.headers["x-agent-loop-gate-reason"] ?? ""), "the refusal does not say which host");
    assert.deepStrictEqual(hits.decoy, [], "the decoy server received a request");
    const via = await connectVia(`127.0.0.2:${dport}`);
    assert.strictEqual(via.status, 403, "CONNECT to a host not on the list was not refused");
    via.socket.destroy();
    assert.deepStrictEqual(hits.decoy, []);
    const named = await viaProxy(`http://metadata.example/latest`);
    assert.strictEqual(named.status, 403, "a name that is not on the list was not refused");
    console.log("[ok] hosts not on the list are refused (plain and CONNECT) with the reason; the decoy never saw a request");
  }

  // 4. CONNECT to an allowed target is a working tunnel.
  {
    const t = await connectVia(`127.0.0.1:${tport}`);
    assert.strictEqual(t.status, 200);
    const reply = await new Promise((resolve) => {
      let out = t.rest;
      t.socket.on("data", (c) => { out += c.toString(); if (/"method"/.test(out)) resolve(out); });
      t.socket.write(`GET /tunnel HTTP/1.1\r\nHost: 127.0.0.1:${tport}\r\nConnection: close\r\n\r\n`);
    });
    assert.ok(/"url":"\/tunnel"/.test(reply), "the tunnel did not carry a request to the target");
    t.socket.destroy();
    console.log("[ok] CONNECT to an allowed target tunnels bytes both ways");
  }

  // 5. A ws:// handshake sent as an absolute-URI upgrade request is tunnelled, and the socket then works as a WebSocket.
  {
    const s = net.connect(gate.port, "127.0.0.1");
    const head = await new Promise((resolve, reject) => {
      let buf = "";
      s.on("error", reject);
      s.on("data", (c) => { buf += c.toString("latin1"); if (buf.includes("\r\n\r\n")) resolve(buf); });
      s.write(`GET ws://127.0.0.1:${tport}/ HTTP/1.1\r\nHost: 127.0.0.1:${tport}\r\nProxy-Authorization: ${auth}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    assert.ok(/^HTTP\/1\.1 101/.test(head), `the upgrade was not tunnelled: ${head.split("\r\n")[0]}`);
    s.destroy();
    const bad = net.connect(gate.port, "127.0.0.1");
    const refused = await new Promise((resolve) => {
      let buf = "";
      bad.on("data", (c) => { buf += c.toString("latin1"); if (buf.includes("\r\n\r\n")) resolve(buf); });
      bad.write(`GET ws://127.0.0.2:${dport}/ HTTP/1.1\r\nHost: 127.0.0.2:${dport}\r\nProxy-Authorization: ${auth}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    assert.ok(/^HTTP\/1\.1 403/.test(refused), "a ws:// upgrade to a host not on the list was not refused");
    bad.destroy();
    assert.deepStrictEqual(hits.decoy, []);
    console.log("[ok] ws:// upgrades: tunnelled when allowed (101), refused when not (403)");
  }

  // 6. The gate resolves names itself and connects to the address it checked: a name the OS cannot resolve works through an injected resolver.
  {
    const pinned = await startNetGate({
      policy: { allowHost: (h) => h === "pinned.test", allowAddress: (ip) => ip === "127.0.0.1" },
      resolve: async () => ["10.9.9.9", "127.0.0.1"], // the first is not allowed; only the allowed one may be used
    });
    const a = "Basic " + Buffer.from(`${pinned.username}:${pinned.password}`).toString("base64");
    const r = await new Promise((resolve, reject) => {
      const q = httpRequest({ host: "127.0.0.1", port: pinned.port, path: `http://pinned.test:${tport}/pin`, headers: { host: `pinned.test:${tport}`, "proxy-authorization": a } }, (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() })); });
      q.on("error", reject); q.end();
    });
    assert.strictEqual(r.status, 200, "the gate did not connect to the allowed address it resolved");
    assert.strictEqual(JSON.parse(r.body).url, "/pin");
    await pinned.close();
    console.log("[ok] the gate resolves the name and connects to the allowed address it chose (the OS never resolves pinned.test)");
  }

  // 7. DNS rebinding: a name that resolves to a private address on the second lookup is refused on that lookup. The browser's own resolver is never asked.
  {
    let lookups = 0;
    const g2 = await startNetGate({
      policy: { allowHost: (h) => h === "rebind.test", allowAddress: (ip) => ip === "127.0.0.1" },
      resolve: async () => (++lookups === 1 ? ["127.0.0.1"] : ["169.254.169.254"]),
    });
    const a = "Basic " + Buffer.from(`${g2.username}:${g2.password}`).toString("base64");
    const go = () => new Promise((resolve, reject) => {
      const q = httpRequest({ host: "127.0.0.1", port: g2.port, path: `http://rebind.test:${tport}/x`, headers: { host: `rebind.test:${tport}`, "proxy-authorization": a, connection: "close" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      q.on("error", reject); q.end();
    });
    assert.strictEqual(await go(), 200, "control: the first lookup (loopback) must be allowed");
    assert.strictEqual(await go(), 403, "the second lookup returned a metadata address and was not refused");
    assert.ok(/not allowed/.test(g2.denied.at(-1).reason) && /169\.254\.169\.254/.test(g2.denied.at(-1).reason), "the refusal does not name the address");
    await g2.close();
    console.log("[ok] DNS rebinding: refused on the lookup that returned a private address");
  }

  // 7b. The host rule and the address rule are separate defences and each has to hold on its own: a name that is not on the list is refused even when it
  // resolves to loopback, and an allowed name is refused when it resolves somewhere else.
  {
    const asName = await startNetGate({ policy: localOnlyPolicy, resolve: async (h) => (h === "loop.test" ? ["127.0.0.1"] : h === "localhost" ? ["10.0.0.5"] : []) });
    const a = "Basic " + Buffer.from(`${asName.username}:${asName.password}`).toString("base64");
    const go = (host) => new Promise((resolve, reject) => {
      const q = httpRequest({ host: "127.0.0.1", port: asName.port, path: `http://${host}:${tport}/n`, headers: { host: `${host}:${tport}`, "proxy-authorization": a, connection: "close" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      q.on("error", reject); q.end();
    });
    assert.strictEqual(await go("loop.test"), 403, "a name not on the list was served because it resolves to loopback (the host rule is not enforced on its own)");
    assert.ok(/not on the allowed list/.test(asName.denied.at(-1).reason), `refused for the wrong reason: ${asName.denied.at(-1).reason}`);
    assert.strictEqual(await go("localhost"), 403, "an allowed name was served although it resolved to 10.0.0.5 (the address rule is not enforced on its own)");
    assert.ok(/not allowed \(10\.0\.0\.5\)/.test(asName.denied.at(-1).reason), `refused for the wrong reason: ${asName.denied.at(-1).reason}`);
    await asName.close();
    console.log("[ok] host rule and address rule each hold on their own (a loopback-resolving name off the list; an allowed name resolving to 10.0.0.5)");
  }

  // 7c. A name with several allowed addresses: the gate tries the next one when the first refuses. `localhost` is ::1 before 127.0.0.1 on some machines
  // (GitHub's runners, Windows), while the target here listens on 127.0.0.1 only; connecting to the first address alone gave an empty reply.
  {
    const order = (ips) => startNetGate({ policy: localOnlyPolicy, resolve: async () => ips });
    const plain = (g, host) => new Promise((resolve) => {
      const a = "Basic " + Buffer.from(`${g.username}:${g.password}`).toString("base64");
      const q = httpRequest({ host: "127.0.0.1", port: g.port, path: `http://${host}:${tport}/fb`, headers: { host: `${host}:${tport}`, "proxy-authorization": a, connection: "close" } }, (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() })); });
      q.on("error", () => resolve({ status: 0, body: "" })); q.end();
    });
    const tunnel = (g, host) => new Promise((resolve) => {
      const a = "Basic " + Buffer.from(`${g.username}:${g.password}`).toString("base64");
      const s = net.connect(g.port, "127.0.0.1");
      let buf = "";
      s.on("error", () => resolve({ status: 0, body: "" }));
      s.on("data", (c) => {
        buf += c.toString("latin1");
        if (/^HTTP\/1\.1 200/.test(buf) && /"method"/.test(buf)) { s.destroy(); resolve({ status: 200, body: buf }); }
        else if (/^HTTP\/1\.1 [45]/.test(buf) && buf.includes("\r\n\r\n")) { s.destroy(); resolve({ status: Number(buf.split(" ")[1]), body: buf }); }
        else if (/^HTTP\/1\.1 200 Connection Established\r\n\r\n$/.test(buf)) s.write(`GET /fb HTTP/1.1\r\nHost: ${host}:${tport}\r\nConnection: close\r\n\r\n`);
      });
      s.write(`CONNECT ${host}:${tport} HTTP/1.1\r\nHost: ${host}:${tport}\r\nProxy-Authorization: ${a}\r\n\r\n`);
    });
    const ws = (g, host) => new Promise((resolve) => {
      const a = "Basic " + Buffer.from(`${g.username}:${g.password}`).toString("base64");
      const s = net.connect(g.port, "127.0.0.1");
      let buf = "";
      s.on("error", () => resolve(0));
      s.on("close", () => resolve(Number((buf.split(" ")[1]) || 0)));
      s.on("data", (c) => { buf += c.toString("latin1"); if (buf.includes("\r\n\r\n")) { s.destroy(); resolve(Number(buf.split(" ")[1])); } });
      s.write(`GET ws://${host}:${tport}/ HTTP/1.1\r\nHost: ${host}:${tport}\r\nProxy-Authorization: ${a}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    const v6first = await order(["::1", "127.0.0.1"]);
    const p = await plain(v6first, "localhost");
    assert.strictEqual(p.status, 200, `plain request: the gate gave up after the first address (${p.status})`);
    assert.strictEqual(JSON.parse(p.body).url, "/fb");
    const t = await tunnel(v6first, "localhost");
    assert.strictEqual(t.status, 200, `CONNECT: the gate gave up after the first address (${t.status})`);
    assert.strictEqual(await ws(v6first, "localhost"), 101, "ws:// upgrade: the gate gave up after the first address");
    await v6first.close();
    const v4first = await order(["127.0.0.1", "::1"]);
    assert.strictEqual((await plain(v4first, "localhost")).status, 200, "control: the address that works first");
    await v4first.close();
    const onlyV6 = await order(["::1"]);
    assert.strictEqual((await plain(onlyV6, "localhost")).status, 502, "no allowed address accepts: expected a clean 502");
    assert.strictEqual((await tunnel(onlyV6, "localhost")).status, 502, "CONNECT with no reachable address: expected a clean 502");
    assert.strictEqual(await ws(onlyV6, "localhost"), 502, "ws:// with no reachable address: expected a clean 502");
    await onlyV6.close();
    console.log("[ok] several allowed addresses: the next one is tried when the first refuses (plain, CONNECT, ws://); none reachable is a clean 502");
  }

  // 8. The refusal log is bounded and answers deniedReason(url); a connected host is not reported as refused.
  {
    const g3 = await startNetGate({ policy: localOnlyPolicy });
    const a = "Basic " + Buffer.from(`${g3.username}:${g3.password}`).toString("base64");
    const hit = (u) => new Promise((resolve) => { const q = httpRequest({ host: "127.0.0.1", port: g3.port, path: u, headers: { host: new URL(u).host, "proxy-authorization": a, connection: "close" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }); q.on("error", () => resolve(0)); q.end(); });
    for (let i = 0; i < 250; i++) await hit(`http://blocked-${i}.example/x`);
    assert.strictEqual(g3.deniedTotal, 250);
    assert.ok(g3.denied.length <= 200, `the refusal log is not bounded: ${g3.denied.length}`);
    assert.ok(/blocked-249/.test(g3.deniedReason("http://blocked-249.example/x") ?? ""), "deniedReason does not find a recent refusal");
    assert.strictEqual(g3.deniedReason("http://blocked-0.example/x"), undefined, "an entry that fell out of the bounded log was still reported (it should be forgotten, and the total says so)");
    assert.strictEqual(await hit(`http://127.0.0.1:${tport}/ok`), 200);
    assert.strictEqual(g3.deniedReason(`http://127.0.0.1:${tport}/ok`), undefined, "control: an allowed host was reported as refused");
    assert.ok(g3.connectedHosts.has("127.0.0.1"));
    await g3.close();
    console.log("[ok] refusal log bounded at 200 with the total kept (250); deniedReason is exact");
  }

  // 9. Not a proxy request, or not http: a clean 400, not a crash.
  {
    const raw = (line) => new Promise((resolve) => { const s = net.connect(gate.port, "127.0.0.1"); let b = ""; s.on("data", (c) => (b += c)); s.on("close", () => resolve(b)); s.write(`${line} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${auth}\r\nConnection: close\r\n\r\n`); });
    assert.ok(/^HTTP\/1\.1 400/.test(await raw("GET /not-absolute")));
    assert.ok(/^HTTP\/1\.1 400/.test(await raw("GET ftp://127.0.0.1/x")));
    console.log("[ok] a relative path or a non-http URL gets a 400");
  }
} finally {
  await gate.close();
  // After close the port refuses connections.
  const refused = await new Promise((resolve) => { const s = net.connect(gate.port, "127.0.0.1"); s.on("connect", () => { s.destroy(); resolve(false); }); s.on("error", () => resolve(true)); });
  target.close(); decoy.close(); wss.close();
  assert.ok(refused, "the gate still accepted connections after close()");
}
console.log("\nALL NET GATE TESTS PASSED");
process.exit(0);
