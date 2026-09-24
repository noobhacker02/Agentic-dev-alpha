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

await srv.close();
console.log("\nALL APPROVAL SERVER TESTS PASSED");
