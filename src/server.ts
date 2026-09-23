import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
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

export function startServer(bus: EventBus, port: number) {
  const server = createServer(async (req, res) => {
    const urlPath = normalize(req.url === "/" ? "/index.html" : req.url ?? "/index.html");
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

  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "decision" && msg.requestId && (msg.decision === "allow" || msg.decision === "deny")) {
          bus.resolveApproval(msg.requestId, { decision: msg.decision, reason: msg.reason });
        }
      } catch {
        // ignore malformed client messages
      }
    });
  });

  const broadcast = (event: AgentEvent) => {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  };
  bus.on("event", broadcast);

  return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => {
      resolve({
        url: `http://localhost:${port}`,
        close: () =>
          new Promise<void>((res) => {
            bus.off("event", broadcast);
            wss.close(() => server.close(() => res()));
          }),
      });
    });
  });
}
