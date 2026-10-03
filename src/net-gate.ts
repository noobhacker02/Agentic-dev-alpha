// A small forward proxy that every request the agent's browser makes has to go through, and that decides, per connection, where it may go.
//
// Why a proxy and not just the browser's request interception: Playwright's route handler is called once, for the first URL of a request. A
// server-side redirect (301, 302, 303, 307, 308) is followed inside the browser's network stack and the handler never sees the next hop, so an
// allowed page could send the browser to any host (adversary round 1, finding A2: reproduced, query string included). Through a proxy every hop
// is a new request that arrives here. The same goes for the browser's own background requests, which no page script controls (this Chromium
// contacts google.com by itself at start-up), and for WebSocket tunnels.
//
// The gate also does the name lookup itself and connects to the address it checked and no other, so the browser's own resolution can never be
// pointed somewhere else between the check and the connection (DNS rebinding).
//
// It listens on 127.0.0.1 only and requires a random credential, so another process on the machine cannot use it as an open proxy.
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import net, { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { lookup } from "node:dns/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";

export interface NetGatePolicy {
  /** The host name or address literal the browser asked for, lower-cased. */
  allowHost(host: string): boolean;
  /** An address that name resolved to. The gate connects to this address and no other. */
  allowAddress(ip: string): boolean;
}

export interface NetGateOptions {
  policy: NetGatePolicy;
  /** Replaces the system resolver (tests use it to simulate DNS rebinding). Returns every address for the name. */
  resolve?: (host: string) => Promise<string[]>;
}

export interface DeniedEntry {
  host: string;
  port: number;
  reason: string;
  ts: number;
}

/** What the gate knows about a refused connection when it tells the owner. `pageInitiated` is true when the request carries what only a
 * page-made request carries (a Sec-Fetch-* header, an Origin or a Referer), false when it carries none of them (the browser's own background
 * traffic), and undefined for a CONNECT tunnel, whose headers say nothing about who asked. */
export interface DenyInfo {
  host: string;
  port: number;
  reason: string;
  /** Host and path only, for plain http requests. */
  path?: string;
  pageInitiated: boolean | undefined;
}

export interface NetGate {
  /** Called synchronously for every refusal. Set it after the gate starts. */
  onDeny?: (info: DenyInfo) => void;
  port: number;
  username: string;
  password: string;  // devskill:allow (a runtime-generated credential or a type, not a secret)
  /** The most recent refusals, newest last. Bounded. */
  denied: DeniedEntry[];
  /** How many connections were refused in all, including ones that fell out of `denied`. */
  deniedTotal: number;
  /** Every host a connection was actually made to. */
  connectedHosts: Set<string>;
  /** The reason the gate refused a connection to this URL's host and port, if it did. */
  deniedReason(url: string): string | undefined;
  /** Whether the gate refused anything in the last `ms` milliseconds. */
  deniedWithin(ms: number): boolean;
  close(): Promise<void>;
}

const MAX_DENIED_KEPT = 200;
const CONNECT_TIMEOUT_MS = 5000;

/**
 * Connect to the first of these addresses that accepts the connection. A name can resolve to several allowed addresses and a local server may
 * listen on only one of them: `localhost` is ::1 before 127.0.0.1 on some machines (the CI runners among them) while a test server binds
 * 127.0.0.1, so trying only the first address made every such request fail with an empty reply. Every address tried was already allowed.
 */
async function connectFirst(ips: string[], port: number): Promise<net.Socket> {
  let last: unknown = new Error("no address to connect to");
  for (const ip of ips) {
    try {
      return await new Promise<net.Socket>((ok, fail) => {
        const s = net.connect({ host: ip, port });
        s.setTimeout(CONNECT_TIMEOUT_MS, () => s.destroy(new Error("connect timed out")));
        s.once("error", fail);
        s.once("connect", () => {
          s.setTimeout(0);
          s.removeListener("error", fail);
          s.on("error", () => { /* the caller attaches its own handler; an error before that must not crash the process */ });
          ok(s);
        });
      });
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/** TEST mode: only this machine, only 127.0.0.1 and localhost. */
export const localOnlyPolicy: NetGatePolicy = {
  allowHost: (h) => h === "localhost" || h === "127.0.0.1",
  allowAddress: (ip) => ip === "127.0.0.1" || ip === "::1",
};

const asciiOneLine = (s: string): string => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);

export async function startNetGate(opts: NetGateOptions): Promise<NetGate> {
  const { policy } = opts;
  const resolve = opts.resolve ?? (async (host: string) => (await lookup(host, { all: true })).map((a) => a.address));
  const username = "gate";
  const password = randomBytes(18).toString("hex");  // devskill:allow (a runtime-generated credential or a type, not a secret)
  const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  const denied: DeniedEntry[] = [];
  const connectedHosts = new Set<string>();
  const sockets = new Set<Duplex>();
  let deniedTotal = 0;

  const authorized = (headers: IncomingHttpHeaders): boolean => {
    const got = Buffer.from(String(headers["proxy-authorization"] ?? ""));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  let gateRef: NetGate | undefined;
  const refuse = (host: string, port: number, reason: string, ctx: { path?: string; pageInitiated: boolean | undefined }): string => {
    deniedTotal += 1;
    denied.push({ host, port, reason, ts: Date.now() });
    if (denied.length > MAX_DENIED_KEPT) denied.shift();
    try { gateRef?.onDeny?.({ host, port, reason, path: ctx.path, pageInitiated: ctx.pageInitiated }); } catch { /* the owner's callback must never break the gate */ }
    return reason;
  };

  /** A request made by a page carries Sec-Fetch-* headers, an Origin or a Referer; the browser's own background requests carry none. */
  const pageInitiated = (h: IncomingHttpHeaders): boolean => Boolean(h["sec-fetch-dest"] || h["sec-fetch-mode"] || h["sec-fetch-site"] || h.origin || h.referer);

  /** Where may a connection to host:port go? Returns every allowed address the name resolved to (in resolver order), or why not. */
  const decide = async (host: string, port: number, ctx: { path?: string; pageInitiated: boolean | undefined }): Promise<{ ips: string[] } | { deny: string }> => {
    const h = host.toLowerCase().replace(/^\[|\]$/g, "");
    if (!policy.allowHost(h)) return { deny: refuse(host, port, `${asciiOneLine(h)} is not on the allowed list`, ctx) };
    let addresses: string[];
    try {
      addresses = isIP(h) ? [h] : await resolve(h);
    } catch {
      return { deny: refuse(host, port, `${asciiOneLine(h)} could not be resolved`, ctx) };
    }
    const ok = addresses.filter((a) => policy.allowAddress(a));
    if (!ok.length) return { deny: refuse(host, port, `${asciiOneLine(h)} resolves to an address that is not allowed (${asciiOneLine(addresses[0] ?? "none")})`, ctx) };
    return { ips: [...new Set(ok)] };
  };

  const hostPort = (target: string, fallbackPort: number): { host: string; port: number } | undefined => {
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(target);
    if (!m) return undefined;
    return { host: m[1], port: m[2] ? Number(m[2]) : fallbackPort };
  };

  const notAuthorized = (res: ServerResponse) => {
    res.writeHead(407, { "proxy-authenticate": 'Basic realm="agent-loop"', connection: "close" });
    res.end();
  };

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!authorized(req.headers)) return notAuthorized(res);
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400, { connection: "close" });
      return void res.end("This is a proxy: send absolute URLs.");
    }
    if (url.protocol !== "http:") {
      res.writeHead(400, { connection: "close" });
      return void res.end("Only http: is forwarded here; https goes through CONNECT.");
    }
    const port = url.port ? Number(url.port) : 80;
    const d = await decide(url.hostname, port, { path: url.pathname, pageInitiated: pageInitiated(req.headers) });
    if ("deny" in d) {
      res.writeHead(403, { "content-type": "text/plain", "x-agent-loop-gate": "blocked", "x-agent-loop-gate-reason": asciiOneLine(d.deny), connection: "close" });
      return void res.end(`Blocked by agent-loop's network rule: ${d.deny}`);
    }
    connectedHosts.add(url.hostname.toLowerCase());
    const headers: IncomingHttpHeaders = { ...req.headers, host: url.host };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    let sock: net.Socket;
    try {
      sock = await connectFirst(d.ips, port);
    } catch {
      res.writeHead(502, { connection: "close" });
      return void res.end();
    }
    if (res.destroyed) return void sock.destroy();
    track(sock);
    const up = httpRequest({ createConnection: () => sock, method: req.method, path: url.pathname + url.search, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { connection: "close" });
      res.end();
    });
    res.on("close", () => up.destroy());
    req.pipe(up);
  });

  const track = (s: Duplex) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  };
  server.on("connection", (s) => track(s));

  /** CONNECT host:port: a tunnel, used for https and for WebSockets. */
  server.on("connect", async (req: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on("error", () => client.destroy());
    if (!authorized(req.headers)) return void client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="agent-loop"\r\nConnection: close\r\n\r\n');
    const hp = hostPort(req.url ?? "", 443);
    if (!hp) return void client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    const d = await decide(hp.host, hp.port, { pageInitiated: undefined });
    if ("deny" in d) return void client.end(`HTTP/1.1 403 Forbidden\r\nx-agent-loop-gate: blocked\r\nx-agent-loop-gate-reason: ${asciiOneLine(d.deny)}\r\nConnection: close\r\n\r\n`);
    connectedHosts.add(hp.host.toLowerCase().replace(/^\[|\]$/g, ""));
    let up: net.Socket | undefined;
    let clientGone = false;
    client.on("close", () => {
      clientGone = true;
      up?.destroy();
    });
    try {
      up = await connectFirst(d.ips, hp.port);
    } catch {
      return void client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
    if (clientGone) return void up.destroy();
    track(up);
    const upstream = up;
    upstream.on("error", () => {
      client.destroy();
      upstream.destroy();
    });
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  });

  /** A plain ws:// handshake sent to the proxy as an absolute-URI request with an Upgrade header. */
  server.on("upgrade", async (req: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on("error", () => client.destroy());
    if (!authorized(req.headers)) return void client.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n');
    let url: URL;
    try {
      url = new URL((req.url ?? "").replace(/^ws/, "http"));
    } catch {
      return void client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
    const port = url.port ? Number(url.port) : 80;
    const d = await decide(url.hostname, port, { path: url.pathname, pageInitiated: pageInitiated(req.headers) });
    if ("deny" in d) return void client.end(`HTTP/1.1 403 Forbidden\r\nx-agent-loop-gate: blocked\r\nConnection: close\r\n\r\n`);
    connectedHosts.add(url.hostname.toLowerCase());
    let up: net.Socket | undefined;
    let clientGone = false;
    client.on("close", () => {
      clientGone = true;
      up?.destroy();
    });
    try {
      up = await connectFirst(d.ips, port);
    } catch {
      return void client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
    if (clientGone) return void up.destroy();
    track(up);
    const upstream = up;
    upstream.on("error", () => {
      client.destroy();
      upstream.destroy();
    });
    const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`, `host: ${url.host}`];
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === "host" || k === "proxy-authorization" || k === "proxy-connection") continue;
      for (const one of Array.isArray(v) ? v : [String(v)]) lines.push(`${k}: ${one}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;

  const gate: NetGate = {
    port,
    username,
    password,
    denied,
    get deniedTotal() {
      return deniedTotal;
    },
    connectedHosts,
    deniedReason(raw: string) {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        return undefined;
      }
      const p = u.port ? Number(u.port) : u.protocol === "https:" || u.protocol === "wss:" ? 443 : 80;
      const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      for (let i = denied.length - 1; i >= 0; i--) {
        const e = denied[i];
        if (e.host.replace(/^\[|\]$/g, "").toLowerCase() === h && e.port === p) return e.reason;
      }
      return undefined;
    },
    deniedWithin(ms: number) {
      const last = denied[denied.length - 1];
      return Boolean(last && Date.now() - last.ts <= ms);
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  gateRef = gate;
  return gate;
}
