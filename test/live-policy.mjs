// LIVE mode's policy through the real network gate (src/net-gate.ts + src/allowances.ts): the browser may reach any public host a page needs (a CDN, a font), except the hosts the user denied, and may
// never reach a private, loopback, link-local or metadata address, whatever name led there. Plain Node clients talk to the gate the way Chromium does. Resolvers are stand-ins so a name can point
// anywhere, including "rebinding" (a different answer the second time). Every refusal has a control (the same kind of request that is allowed works) and a decoy that counts hits.
//   npm run build && npm run test:live-policy
import { createServer, request as httpRequest } from "node:http";
import net from "node:net";
import assert from "node:assert";
import { startNetGate } from "../dist/net-gate.js";
import { livePolicy, parseAllowances, isPublicAddress } from "../dist/allowances.js";

const hits = { target: [], decoy: [] };
const target = createServer((req, res) => { hits.target.push(`${req.headers.host}${req.url}`); res.end("target"); });
await new Promise((r) => target.listen(0, "127.0.0.1", r));
const decoy = createServer((req, res) => { hits.decoy.push(req.url); res.end("decoy"); });
const noSecond = await new Promise((r) => { decoy.once("error", (e) => r(e.code)); decoy.listen(0, "127.0.0.2", () => r(null)); });
if (noSecond) { console.log(`[skip] 127.0.0.2 is not available here (${noSecond}); the rebinding decoy cannot be started`); process.exit(0); }
const tport = target.address().port;

const allowances = parseAllowances({ allow: ["linkedin.com"], deny: ["ads.tracker.example"] }).value;
// A stand-in for "public": 127.0.0.1 counts as public and 127.0.0.2 does not, so a name can be made to point at the real target (allowed) or at the decoy (refused) without a network.
const standInPublic = (ip) => ip === "127.0.0.1";
let lookups = [];
const table = {
  "cdn.unlisted.example": ["127.0.0.1"],
  "www.linkedin.com": ["127.0.0.1"],
  "ads.tracker.example": ["127.0.0.1"],
  "to-decoy.example": ["127.0.0.2"],
  "mixed.example": ["127.0.0.2", "127.0.0.1"],
  "metadata.example": ["169.254.169.254"],
  "lan.example": ["192.168.1.10"],
  "mapped.example": ["::ffff:127.0.0.1"],
  "loop.example": ["127.0.0.1"],
  "nat64.example": ["64:ff9b::7f00:1"],
  "unresolvable.example": null,
};
let rebindCalls = 0;
const resolver = async (host) => {
  lookups.push(host);
  if (host === "rebind.example") return rebindCalls++ === 0 ? ["127.0.0.1"] : ["127.0.0.2"];
  const a = table[host];
  if (a === null) throw new Error("ENOTFOUND");
  if (!a) throw new Error(`no stand-in for ${host}`);
  return a;
};

const standInGate = await startNetGate({ policy: livePolicy(allowances, { isPublic: standInPublic }), resolve: resolver });
const realGate = await startNetGate({ policy: livePolicy(allowances), resolve: resolver });
const basic = (g) => "Basic " + Buffer.from(`${g.username}:${g.password}`).toString("base64");

const viaProxy = (gate, absUrl) =>
  new Promise((resolve, reject) => {
    const u = new URL(absUrl);
    const req = httpRequest({ host: "127.0.0.1", port: gate.port, method: "GET", path: absUrl, headers: { host: u.host, "proxy-authorization": basic(gate) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });
const connectVia = (gate, hostPort) =>
  new Promise((resolve, reject) => {
    const s = net.connect(gate.port, "127.0.0.1");
    let buf = "";
    s.on("error", reject);
    s.on("data", function onData(c) {
      buf += c.toString("latin1");
      if (!buf.includes("\r\n\r\n")) return;
      s.off("data", onData);
      resolve({ status: Number(buf.split(" ")[1]), head: buf, socket: s });
    });
    s.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\nProxy-Authorization: ${basic(gate)}\r\n\r\n`);
  });

try {
  // 1. Control: a page may load a subresource from a host that is not on the allowances list (a CDN, a font); the list governs where the agent navigates, not what a page needs to render
  {
    hits.target.length = 0;
    for (const name of ["cdn.unlisted.example", "www.linkedin.com"]) {
      const r = await viaProxy(standInGate, `http://${name}:${tport}/asset.js`);
      assert.strictEqual(r.status, 200, `${name} was refused: ${r.body}`);
      assert.strictEqual(r.body, "target");
    }
    assert.deepStrictEqual(hits.target, [`cdn.unlisted.example:${tport}/asset.js`, `www.linkedin.com:${tport}/asset.js`]);
    const policy = livePolicy(allowances);
    assert.strictEqual(policy.allowHost("cdn.unlisted.example"), true);
    assert.strictEqual(policy.allowAddress("93.184.216.34"), true, "the real policy refuses a public address");
    console.log("[ok] a host that is not on the allowances list is still reachable for a page's own subresources; the real policy accepts a public address");
  }

  // 2. The deny list is enforced on the gate too, before any lookup
  {
    lookups = [];
    hits.target.length = 0;
    const r = await viaProxy(standInGate, `http://ads.tracker.example:${tport}/x`);
    assert.strictEqual(r.status, 403);
    assert.ok(/not on the allowed list/.test(r.body), r.body);
    const t = await connectVia(standInGate, `sub.ads.tracker.example:${tport}`);
    assert.strictEqual(t.status, 403, "a subdomain of a denied host was tunnelled");
    t.socket.destroy();
    assert.deepStrictEqual(lookups, [], "a denied name was looked up before it was refused");
    assert.deepStrictEqual(hits.target, []);
    console.log("[ok] a denied host and its subdomains are refused before any lookup, over plain HTTP and over a CONNECT tunnel");
  }

  // 3. A name that leads to an address that is not allowed is refused, and the decoy behind it sees nothing (stand-in "public")
  {
    hits.decoy.length = 0;
    for (const name of ["to-decoy.example", "mixed.example"]) {
      const r = await viaProxy(standInGate, `http://${name}:${decoy.address().port}/secret`);
      if (name === "mixed.example") {
        // one allowed address among the answers: the gate connects to that one only, never to the one it refused
        assert.strictEqual(r.status, 502, `${name}: ${r.status} ${r.body}`);
      } else {
        assert.strictEqual(r.status, 403, `${name} was not refused: ${r.status}`);
        assert.ok(/resolves to an address that is not allowed/.test(r.body), r.body);
      }
    }
    assert.deepStrictEqual(hits.decoy, [], "the decoy received a request");
    console.log("[ok] a name that resolves to an address that is not allowed is refused; with a mix of answers only the allowed address is ever dialled");
  }

  // 4. DNS rebinding: the name answers "public" the first time and "private" the second. The gate looks up once, checks, and connects to what it checked.
  {
    hits.target.length = 0; hits.decoy.length = 0; rebindCalls = 0; lookups = [];
    const r = await viaProxy(standInGate, `http://rebind.example:${tport}/probe`);
    assert.strictEqual(r.status, 200, `the first, allowed answer was not used: ${r.status} ${r.body}`);
    assert.strictEqual(r.body, "target");
    assert.deepStrictEqual(lookups.filter((h) => h === "rebind.example").length, 1, "the gate looked the name up more than once for one request");
    assert.deepStrictEqual(hits.decoy, [], "a second, private answer was used");
    console.log("[ok] DNS rebinding: one lookup per connection, and the connection goes to the address that was checked");
  }

  // 5. The real policy: every spelling of a private destination is refused, by address, whatever the name; the decoy and the target see nothing
  {
    hits.target.length = 0; hits.decoy.length = 0;
    const names = ["metadata.example", "lan.example", "mapped.example", "loop.example", "nat64.example", "to-decoy.example", "mixed.example"];
    for (const name of names) {
      const r = await viaProxy(realGate, `http://${name}:${tport}/`);
      assert.strictEqual(r.status, 403, `${name} reached ${r.status}`);
      assert.ok(/resolves to an address that is not allowed/.test(r.body), `${name}: ${r.body}`);
      const t = await connectVia(realGate, `${name}:${tport}`);
      assert.strictEqual(t.status, 403, `${name} was tunnelled`);
      t.socket.destroy();
    }
    for (const literal of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "[::1]", "[::ffff:7f00:1]", "[fd00:ec2::254]"]) {
      const r = await viaProxy(realGate, `http://${literal}:${tport}/`);
      assert.strictEqual(r.status, 403, `${literal} reached ${r.status}`);
      const t = await connectVia(realGate, `${literal}:${tport}`);
      assert.strictEqual(t.status, 403, `${literal} was tunnelled`);
      t.socket.destroy();
    }
    lookups = [];
    for (const local of ["localhost", "app.localhost"]) {
      const r = await viaProxy(realGate, `http://${local}:${tport}/`);
      assert.strictEqual(r.status, 403, `${local} reached ${r.status}`);
      assert.ok(/not on the allowed list/.test(r.body), `${local} was refused for another reason: ${r.body}`);
    }
    assert.deepStrictEqual(lookups, [], "localhost was looked up instead of being refused by name");
    const gone = await viaProxy(realGate, `http://unresolvable.example:${tport}/`);
    assert.strictEqual(gone.status, 403);
    assert.ok(/could not be resolved/.test(gone.body), gone.body);
    assert.deepStrictEqual(hits.target, [], "the local server received a request through the real policy");
    assert.deepStrictEqual(hits.decoy, []);
    console.log("[ok] through the real policy, names that resolve to cloud metadata, a LAN address, an IPv4-mapped or NAT64 loopback, and every address literal and localhost are refused; the servers behind them see nothing");
  }

  // 6. The gate still wants its credential (the policy changed nothing about who may use the proxy)
  {
    const r = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: realGate.port, method: "GET", path: `http://cdn.unlisted.example:${tport}/`, headers: { host: "cdn.unlisted.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      req.end();
    });
    assert.strictEqual(r, 407);
    assert.strictEqual(isPublicAddress("127.0.0.1"), false);
    console.log("[ok] the proxy still refuses a caller without its credential");
  }
  console.log("\nALL LIVE POLICY TESTS PASSED");
} finally {
  await standInGate.close(); await realGate.close();
  target.close(); decoy.close();
}
process.exit(0);
