// Regression tests for the approval server's access control and approval replay. No API calls:
//   npm run build && npm run test:server
// Each case is an attack from docs/STRESS-TEST-REPORT.md that used to succeed.
import { EventBus } from "../dist/bus.js";
import { startServer } from "../dist/server.js";
import WebSocket from "ws";
import assert from "node:assert";
import { request } from "node:http";
import os from "node:os";

const PORT = 45232;
const bus = new EventBus();
const srv = await startServer(bus, PORT);
const OWN_ORIGIN = `http://127.0.0.1:${PORT}`;

/** Resolves "open" or the HTTP status the server rejected the upgrade with. */
function tryConnect({ host = "127.0.0.1", token = srv.token, headers = {} } = {}) {
  return new Promise((resolve) => {
    const qs = token === null ? "" : `?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(`ws://${host}:${PORT}/ws${qs}`, { headers });
    // Buffer from the start, like the UI's onmessage: the server replays pending approvals the
    // instant the socket opens.
    const received = [];
    ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve({ result: "open", ws, received }));
    ws.on("unexpected-response", (_req, res) => resolve({ result: res.statusCode }));
    ws.on("error", (e) => resolve({ result: e.code ?? e.message }));
  });
}

function httpGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port: PORT, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject).end();
  });
}

// --- who may connect
assert.strictEqual((await tryConnect({ token: null, headers: { Origin: OWN_ORIGIN } })).result, 401);
console.log("[ok] no token: rejected (401)");

assert.strictEqual((await tryConnect({ token: "0".repeat(48), headers: { Origin: OWN_ORIGIN } })).result, 401);
console.log("[ok] wrong token of the right length: rejected (401)");

assert.strictEqual((await tryConnect({ headers: { Origin: "https://evil.example" } })).result, 403);
console.log("[ok] another website's page, even holding the token: rejected (403)");

assert.strictEqual((await tryConnect({ headers: { Origin: OWN_ORIGIN, Host: `evil.example:${PORT}` } })).result, 403);
assert.strictEqual(await httpGet("/", { Host: `evil.example:${PORT}` }), 403);
console.log("[ok] DNS-rebinding Host header: WebSocket and page both rejected (403)");

const lanIp = Object.values(os.networkInterfaces()).flat().find((n) => n.family === "IPv4" && !n.internal)?.address;
if (lanIp) {
  const lan = await tryConnect({ host: lanIp, headers: { Origin: `http://${lanIp}:${PORT}` } });
  assert.notStrictEqual(lan.result, "open", "server must not be reachable on a LAN interface");
  console.log(`[ok] LAN interface ${lanIp}: not listening (${lan.result})`);
} else {
  console.log("[skip] no non-loopback IPv4 interface to test LAN exposure against");
}

for (const origin of [OWN_ORIGIN, `http://localhost:${PORT}`]) {
  const c = await tryConnect({ headers: { Origin: origin } });
  assert.strictEqual(c.result, "open", `own page at ${origin} should connect`);
  c.ws.close();
}
console.log("[ok] the UI's own page (127.0.0.1 or localhost) with the token: connects");

const cli = await tryConnect();
assert.strictEqual(cli.result, "open");
cli.ws.close();
console.log("[ok] non-browser client (no Origin) with the token: connects");

assert.strictEqual(await httpGet("/"), 200);
assert.ok(srv.url.startsWith(`http://127.0.0.1:${PORT}/#token=`) && srv.url.endsWith(srv.token));
console.log("[ok] UI page is served; printed URL carries the token in its #fragment");

// --- a tab that connects after the request still sees it, and can resolve it
const done = bus.requestApproval({ runId: "r", phase: "builder", toolUseId: "t0", toolName: "Bash", toolInput: { command: "echo already-decided" } });
bus.resolveApproval(done.requestId, { decision: "deny" });
const { requestId, wait } = bus.requestApproval({ runId: "r", phase: "builder", toolUseId: "t1", toolName: "Bash", toolInput: { command: "npm test" } });

const late = await tryConnect({ headers: { Origin: OWN_ORIGIN } });
assert.strictEqual(late.result, "open");
await new Promise((r) => setTimeout(r, 300));
const approvals = late.received.filter((e) => e.type === "approval-request");
assert.deepStrictEqual(approvals.map((e) => e.requestId), [requestId], "only the still-pending request is replayed");
console.log("[ok] tab opened after the request: pending approval replayed, already-decided one not");

late.ws.send(JSON.stringify({ type: "decision", requestId, decision: "allow" }));
assert.strictEqual((await wait).decision, "allow");
assert.deepStrictEqual(bus.pendingRequests(), []);
console.log("[ok] replayed approval resolves the waiting hook (full round trip)");
late.ws.close();

// --- a token is per run
const other = await startServer(new EventBus(), PORT + 1);
assert.notStrictEqual(other.token, srv.token);
assert.ok(srv.token.length >= 32);
await other.close();
console.log("[ok] each server run gets its own random token");

// --- `--port 0` (a valid non-negative --port value; Node/networking convention for "OS, pick a
// free port") used to leave hostOk/originOk permanently checking against literal port 0, and
// the printed URL named port 0 too -- something no client could ever connect to, breaking the
// approval UI outright. The real bound port (from server.address()) must be what's checked and
// what's printed.
{
  const auto = await startServer(new EventBus(), 0);
  assert.ok(!auto.url.includes(":0/"), `printed URL must use the real bound port, not 0: ${auto.url}`);
  const realPort = new URL(auto.url.split("#")[0]).port;
  const connected = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${realPort}/ws?token=${auto.token}`, {
      headers: { Origin: `http://127.0.0.1:${realPort}` },
    });
    ws.on("open", () => { ws.close(); resolve(true); });
    ws.on("error", () => resolve(false));
    ws.on("unexpected-response", () => resolve(false));
  });
  assert.ok(connected, "a client using the printed URL's real port and token must be able to connect");
  await auto.close();
  console.log("[ok] --port 0: the printed URL and host/origin checks use the real OS-assigned port, not literal 0");
}

// --- browser-tool artifacts (screenshots) are served read-only, gated by the same token
{
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const container = mkdtempSync(join(tmpdir(), "agent-loop-artifacts-container-"));
  const artifactRoot = join(container, "artifacts");
  const runDir = join(artifactRoot, "run-123");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(runDir, { recursive: true });
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  writeFileSync(join(runDir, "shot.png"), pngBytes);

  const artSrv = await startServer(new EventBus(), PORT + 2, { artifactRoot });

  function httpGetFull(path, headers = {}) {
    return new Promise((resolve, reject) => {
      request({ host: "127.0.0.1", port: PORT + 2, path, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, contentType: res.headers["content-type"], body: Buffer.concat(chunks) }));
      }).on("error", reject).end();
    });
  }

  const noToken = await httpGetFull("/artifacts/run-123/shot.png");
  assert.strictEqual(noToken.status, 401, "an artifact request with no token should be rejected");

  const wrongToken = await httpGetFull("/artifacts/run-123/shot.png?token=wrong");
  assert.strictEqual(wrongToken.status, 401, "an artifact request with the wrong token should be rejected");

  const ok = await httpGetFull(`/artifacts/run-123/shot.png?token=${artSrv.token}`);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.contentType, "image/png");
  assert.ok(ok.body.equals(pngBytes), "the served bytes should exactly match the file on disk");

  const missing = await httpGetFull(`/artifacts/run-123/nope.png?token=${artSrv.token}`);
  assert.strictEqual(missing.status, 404);

  // Path traversal: a secret file placed as a sibling of artifactRoot must never be reachable.
  // path.join (what server.ts uses, not path.resolve) never lets a later absolute-looking segment
  // escape the base it's joined onto, so a naive ".." request either gets caught by the existing
  // top-level check or, once normalized, no longer starts with "/artifacts/" at all and falls
  // through to the UI's own file route -- confirmed here against the real server, not just reasoned
  // about the library's documented behavior.
  writeFileSync(join(artifactRoot, "..", "secret.txt"), "should never be servable");
  for (const traversal of [
    "/artifacts/run-123/../../secret.txt",
    "/artifacts/run-123/%2e%2e/%2e%2e/secret.txt",
    "/artifacts/..%2Fsecret.txt",
  ]) {
    const res = await httpGetFull(`${traversal}?token=${artSrv.token}`);
    assert.notStrictEqual(res.status, 200, `traversal attempt should not succeed: ${traversal} -> ${res.status}`);
    assert.ok(!res.body.includes("should never be servable"), `traversal attempt must not leak the secret file's content: ${traversal}`);
  }
  console.log("[ok] path traversal attempts against /artifacts/ cannot escape artifactRoot");

  await artSrv.close();

  // A server started WITHOUT artifactRoot must not serve artifacts at all -- confirms the route is
  // opt-in, not silently always-on. srv (on PORT) was started with no artifactRoot.
  const noRouteStatus = await httpGet("/artifacts/run-123/shot.png");
  assert.strictEqual(noRouteStatus, 404, "a server with no artifactRoot configured should 404 on /artifacts/*");

  console.log("[ok] browser-tool artifacts: 401 with no/wrong token, 200 with the right one and matching bytes, 404 for a missing file or when artifactRoot isn't configured");
}

await srv.close();
console.log("\nALL APPROVAL SERVER TESTS PASSED");
