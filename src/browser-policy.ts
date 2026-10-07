// What the browser tools allow, as one object: TEST mode (this machine only, today's rule) or LIVE mode (the user's allowances list, docs/HYBRID-AGENT-SPEC.md S2). The browser tools ask this
// object at every point where they used to have the localhost rule written in: the network gate's policy, each request the context sees, a WebSocket, the agent's own `open`, and the page a
// frame lands on after the browser has followed a redirect. TEST mode answers exactly as before.
import { hostStatus, livePolicy, navigationVerdict, type Allowances } from "./allowances.js";
import { localOnlyPolicy, type NetGatePolicy } from "./net-gate.js";

export interface RequestInfo {
  /** A page or frame navigation (main frame or a subframe), as opposed to a subresource. */
  navigation: boolean;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

export interface BrowserPolicy {
  mode: "test" | "live";
  /** The network gate's policy: which hosts and which addresses a connection may go to. */
  gate: NetGatePolicy;
  /** Replaces the gate's name lookup (tests). */
  resolve?: (host: string) => Promise<string[]>;
  /** The context-level guard on every request the browser makes, judged on the first URL of it. */
  allowRequest(url: string, info: RequestInfo): Verdict;
  allowWebSocket(url: string): boolean;
  /** The agent's own `open`: ok, or the whole message to refuse with. */
  checkOpen(url: string): { ok: true } | { ok: false; message: string };
  /** A frame has committed to this URL, possibly through a redirect nothing could stop: may the agent be shown it? */
  landing(url: string): Verdict;
  openDescription: string;
  /** Names the rule in the notice that tells the agent something was blocked. */
  blockedLabel: string;
}

const OK: Verdict = { ok: true };
const LOCAL_URL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;
const LOCAL_WS_RE = /^wss?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

/**
 * The one gate for the "local-only" boundary -- shared by both `open()`'s own check AND the context-level request guard, so they can never drift apart. `open()` alone isn't enough: a
 * page loaded from an allowed local origin can still contain a link, a JS redirect, a form, or a background fetch/XHR pointed at an external host, and none of those go through `open()`
 * at all (confirmed empirically -- clicking a link navigated the browser to a second local server with zero re-validation before this fix). `about:blank` is Playwright's own
 * page-creation default before any real navigation and never represents an actual network request.
 */
const isAllowedLocalUrl = (url: string): boolean => url === "about:blank" || LOCAL_URL_RE.test(url);

/** TEST mode: only http://localhost and http://127.0.0.1, which is what every suite that is not about LIVE mode runs under. */
export const testPolicy: BrowserPolicy = {
  mode: "test",
  gate: localOnlyPolicy,
  allowRequest: (url) => (isAllowedLocalUrl(url) ? OK : { ok: false, reason: "only localhost and 127.0.0.1 are allowed" }),
  allowWebSocket: (url) => LOCAL_WS_RE.test(url),
  checkOpen: (url) => (isAllowedLocalUrl(url) ? { ok: true } : { ok: false, message: `Refused: only http://localhost or http://127.0.0.1 URLs are allowed in this stage, got: ${url}` }),
  landing: () => OK,
  openDescription: "Navigate the active tab to a URL. Only http://localhost or http://127.0.0.1 URLs are allowed.",
  blockedLabel: "the localhost-only rule",
};

export interface LiveBrowserPolicyOptions {
  /** Replaces the rule for "a public address" (tests point names at a local server). */
  isPublic?: (ip: string) => boolean;
  resolve?: (host: string) => Promise<string[]>;
  /** Ports a page may be opened on besides 80 and 443 (tests). */
  extraPorts?: number[];
}

/**
 * LIVE mode. A page or frame the browser is sent to must be on the allowances list (judged on the first URL; a redirect is judged where it lands, `landing`). Subresources are not on the
 * list: a page needs its CDN and fonts, so they pass here and the gate judges their host and address. A WebSocket is a channel a script can talk through, not something a page needs from a
 * third party to render, so it goes only to a host on the list (a chat widget's socket on another domain will not connect).
 */
export function liveBrowserPolicy(a: Allowances, opts: LiveBrowserPolicyOptions = {}): BrowserPolicy {
  const gate = livePolicy(a, { isPublic: opts.isPublic });
  const nav = (url: string) => navigationVerdict(a, url, { extraPorts: opts.extraPorts });
  return {
    mode: "live",
    gate,
    resolve: opts.resolve,
    allowRequest(url, info) {
      if (url === "about:blank") return OK;
      let protocol: string;
      try { protocol = new URL(url).protocol; } catch { return { ok: false, reason: "that is not a valid URL" }; }
      if (protocol === "data:" || protocol === "blob:") return info.navigation ? { ok: false, reason: "a page cannot be opened from a data: or blob: address" } : OK;
      if (protocol !== "http:" && protocol !== "https:") return { ok: false, reason: `${protocol.replace(/:$/, "")} requests are not allowed` };
      if (!info.navigation) return OK;
      const v = nav(url);
      return v.ok ? OK : { ok: false, reason: v.reason };
    },
    allowWebSocket(url) {
      try {
        const u = new URL(url);
        // the list covers names only (an address, localhost and a denied host are never "allowed"), so this one test is all there is to it
        return (u.protocol === "ws:" || u.protocol === "wss:") && hostStatus(a, u.hostname) === "allowed";
      } catch {
        return false;
      }
    },
    checkOpen(url) {
      const v = nav(url);
      return v.ok ? { ok: true } : { ok: false, message: `Refused: ${v.reason}` };
    },
    landing(url) {
      // pages the browser makes for itself (a blank page, an error page, an iframe's own srcdoc) and data/blob documents carry nothing from a host
      if (url === "" || /^(about:|chrome-error:|data:|blob:)/.test(url)) return OK;
      const v = nav(url);
      return v.ok ? OK : { ok: false, reason: v.reason };
    },
    openDescription: "Navigate the active tab to a URL. Only sites on the user's allowances list can be opened; anything else is refused.",
    blockedLabel: "the allowances list",
  };
}
