import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { EventBus } from "./bus.js";
import type { AgentEvent } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "ui");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/**
 * Loopback only. Binding every interface let any machine on the network open the WebSocket and
 * approve tool calls; the approval UI is for the person at this machine.
 */
const HOST = "127.0.0.1";

/** Parses a request target; a malformed one yields null instead of throwing inside a handler. */
function parseTarget(target: string | undefined): URL | null {
  try {
    return new URL(target ?? "/", "http://x");
  } catch {
    return null;
  }
}

export interface ServerOptions {
  /** Per-run secret the UI must present to open the WebSocket. Generated when omitted. */
  token?: string;
}

/**
 * Serves the UI and the approval WebSocket. Every tool call a human approves flows through this
 * socket, so a connection is accepted only when all three hold:
 *  - the Host header names this loopback server (blocks DNS-rebinding pages),
 *  - the Origin, when a browser sends one, is this server's own page (blocks any other website
 *    you have open from connecting to localhost and clicking Approve for you),
 *  - the per-run token from the printed URL matches (blocks other local processes and pages).
 */
export function startServer(bus: EventBus, port: number, opts: ServerOptions = {}) {
  const token = opts.token ?? randomBytes(24).toString("hex");
  const allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

  const hostOk = (req: IncomingMessage) => allowedHosts.has(req.headers.host ?? "");
  const originOk = (req: IncomingMessage) => req.headers.origin === undefined || allowedOrigins.has(req.headers.origin);
  const tokenOk = (req: IncomingMessage) => {
    const given = Buffer.from(parseTarget(req.url)?.searchParams.get("token") ?? "");
    const want = Buffer.from(token);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  const server = createServer(async (req, res) => {
    if (!hostOk(req)) {
      res.writeHead(403).end("forbidden host");
      return;
    }
    const target = parseTarget(req.url);
    if (!target) {
      res.writeHead(400).end("bad path");
      return;
    }
    const pathname = target.pathname;
    const urlPath = normalize(pathname === "/" ? "/index.html" : pathname);
    if (urlPath.includes("..")) {
      res.writeHead(400).end("bad path");
      return;
    }
    try {
      const filePath = join(UI_DIR, urlPath);
      const body = await readFile(filePath);
      const ext = urlPath.slice(urlPath.lastIndexOf("."));
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: ({ req }, done) => {
      if (!hostOk(req)) return done(false, 403, "forbidden host");
      if (!originOk(req)) return done(false, 403, "forbidden origin");
      if (!tokenOk(req)) return done(false, 401, "missing or wrong token");
      done(true);
    },
  });
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "decision" && msg.requestId && (msg.decision === "allow" || msg.decision === "deny")) {
          bus.resolveApproval(msg.requestId, { decision: msg.decision, reason: msg.reason });
        } else if (
          msg.type === "record-decision" &&
          typeof msg.runId === "string" &&
          typeof msg.phase === "string" &&
          typeof msg.text === "string" &&
          msg.text.trim()
        ) {
          // The only path that can add a trusted decision -- this handler runs only for a
          // connection that already passed verifyClient's host/origin/token checks above, so it's
          // reachable only by the human at this machine's own approval UI, never by a worker phase.
          bus.recordDecision(msg.runId, msg.phase, msg.text.trim().slice(0, 2000));
        }
      } catch {
        // ignore malformed client messages
      }
    });
    // Events aren't replayed, so a tab opened or reloaded mid-run would never see an approval that
    // was requested before it connected, and the run would hang until the hook timed out.
    for (const event of bus.pendingRequests()) ws.send(JSON.stringify(event));
  });

  const broadcast = (event: AgentEvent) => {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  };
  bus.on("event", broadcast);

  return new Promise<{ url: string; token: string; close: () => Promise<void> }>((resolve, reject) => {
    server.on("error", reject);
    // `ws` re-emits the underlying http.Server's listen failure on the WebSocketServer instance
    // too; with no listener there, Node treats it as an unhandled 'error' event and crashes the
    // process instead of letting this promise reject cleanly.
    wss.on("error", reject);
    server.listen(port, HOST, () => {
      resolve({
        // The token rides in the fragment so the browser never sends it in a request line,
        // server log or Referer; the UI reads it from location.hash.
        url: `http://${HOST}:${port}/#token=${token}`,
        token,
        close: () =>
          new Promise<void>((res) => {
            bus.off("event", broadcast);
            // http.Server#close() only fires its callback once every open connection ends on
            // its own — a browser tab left connected via WebSocket never does that, so without
            // force-closing sockets here, a still-open UI tab hangs process exit indefinitely
            // even after the pipeline itself has finished. Terminate clients and force the
            // underlying sockets closed rather than waiting for a natural disconnect.
            for (const client of clients) client.terminate();
            wss.close(() => {
              server.closeAllConnections();
              server.close(() => res());
            });
          }),
      });
    });
  });
}
