// LIVE mode, part one (docs/HYBRID-AGENT-SPEC.md, S2): where the agent may navigate (the allowances list), which addresses it may never connect to, and what the user's config file
// may say. The router can propose hosts; only this file, written by the user in their own directory, grants them, and its deny list beats any grant. Pure functions and one loader,
// so the network gate and the browser tools use one definition of "allowed" and the tests can drive it without a network.
import { lstatSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { domainToASCII } from "node:url";
import type { NetGatePolicy } from "./net-gate.js";

/** One line of the allowances file: a domain (and its subdomains) or, with a leading "=", exactly that host. */
export interface HostRule {
  host: string;
  exact: boolean;
}

export interface Allowances {
  allow: HostRule[];
  deny: HostRule[];
  /** A site is a platform: the caps count these, not hostnames, so a second Workday tenant is not a fresh quota. */
  platforms: Array<{ name: string; rules: HostRule[] }>;
}

export const NO_ALLOWANCES: Allowances = { allow: [], deny: [], platforms: [] };

const MAX_RULES = 500;
const MAX_PLATFORMS = 100;
const MAX_FILE_BYTES = 100_000;
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/** Domains where anyone can register a subdomain or a tenant: allowing one of them would allow every page anybody hosts there. A short list of the common ones, not the Public Suffix List. */
const SHARED_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "com.au", "net.au", "org.au", "co.nz", "co.in", "co.jp", "co.kr", "co.za", "com.br", "com.cn", "com.mx", "com.tr", "com.sg", "com.hk", "com.tw", "com.ar",
  "github.io", "gitlab.io", "herokuapp.com", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "blogspot.com", "appspot.com", "cloudfront.net", "amazonaws.com", "azurewebsites.net",
  "web.app", "firebaseapp.com", "onrender.com", "fly.dev", "glitch.me", "repl.co", "ngrok.io", "ngrok-free.app", "trycloudflare.com", "workers.cloudflare.com",
]);

/** A host name in the one form the rules compare: lower-case ASCII (punycode for other scripts), no trailing dot. Undefined for anything that is not a plain DNS name, an address included. */
export function normalizeHost(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw || raw.length > 400) return undefined;
  // domainToASCII reads its argument as the host part of a URL and stops at "/", "?" or "#", so "linkedin.com/jobs" would come back as "linkedin.com": only letters, digits, marks, dots and hyphens go in
  if (!/^[\p{L}\p{N}\p{M}.-]+$/u.test(raw)) return undefined;
  let host = domainToASCII(raw.toLowerCase());
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.length > 253 || !HOST_RE.test(host)) return undefined;
  // a last label made of digits is how a browser reads an address such as 1.2.3.4 or 2130706433 (domainToASCII has already turned 0x7f.1 into 127.0.0.1); no real top-level domain looks like that
  if (/^\d+$/.test(host.slice(host.lastIndexOf(".") + 1))) return undefined;
  return host;
}

/** Reads one rule: "example.com" (the domain and its subdomains) or "=host.example.com" (only that host). Undefined if it is not a plain domain the user can mean. */
export function hostRule(text: unknown): HostRule | undefined {
  if (typeof text !== "string") return undefined;
  const exact = text.startsWith("=");
  const host = normalizeHost(exact ? text.slice(1) : text);
  if (!host || !host.includes(".")) return undefined;
  if (SHARED_SUFFIXES.has(host)) return undefined;
  return { host, exact };
}

const matches = (rule: HostRule, host: string): boolean => host === rule.host || (!rule.exact && host.endsWith(`.${rule.host}`));

/**
 * A name the rules cannot parse ("x_y.ads.example.org": an underscore is not a host-name character, but resolvers and browsers take it) is never allowed, yet the net gate also asks about names that are
 * merely not listed, and for those "unparseable" must not mean "not denied" (adversary round 3, A57). So the raw name is compared with the deny rules by its dots, whatever its other characters are.
 */
function underDeniedDomain(a: Allowances, rawHost: unknown): boolean {
  if (typeof rawHost !== "string" || rawHost.length > 400) return false;
  let h = rawHost.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  return a.deny.some((r) => matches(r, h));
}

/** allowed: on the allow list and not denied. denied: the deny list covers it (it wins over any allow). unlisted: neither, or not a name at all. */
export function hostStatus(a: Allowances, rawHost: unknown): "allowed" | "denied" | "unlisted" {
  const host = normalizeHost(rawHost);
  if (!host) return underDeniedDomain(a, rawHost) ? "denied" : "unlisted";
  if (a.deny.some((r) => matches(r, host))) return "denied";
  return a.allow.some((r) => matches(r, host)) ? "allowed" : "unlisted";
}

/** The site a host counts as: the most specific platform rule that covers it, else the allow rule that let it in (so an unmapped company career domain is its own site). Undefined unless allowed. */
export function platformOf(a: Allowances, rawHost: unknown): string | undefined {
  const host = normalizeHost(rawHost);
  if (!host || hostStatus(a, host) !== "allowed") return undefined;
  const best = (rules: HostRule[]): HostRule | undefined => rules.filter((r) => matches(r, host)).sort((x, y) => y.host.length - x.host.length)[0];
  let found: { name: string; rule: HostRule } | undefined;
  for (const p of a.platforms) {
    const r = best(p.rules);
    if (r && (!found || r.host.length > found.rule.host.length)) found = { name: p.name, rule: r };
  }
  return found ? found.name : best(a.allow)?.host;
}

const clean = (s: string, n = 80): string => s.replace(/[^\x20-\x7e]/g, "?").slice(0, n);

export type NavigationVerdict = { ok: true; host: string; platform: string; url: string } | { ok: false; reason: string };

/** Whether the agent may open this URL in LIVE mode. The first hop only: a server-side redirect is judged where it lands (the browser tools). `extraPorts` is for tests, whose servers cannot listen on 80 or 443. */
export function navigationVerdict(a: Allowances, rawUrl: unknown, opts: { extraPorts?: number[] } = {}): NavigationVerdict {
  let url: URL;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { ok: false, reason: "that is not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `only http and https pages can be opened (got ${clean(url.protocol.replace(/:$/, ""), 20)})` };
  const bare = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(bare)) return { ok: false, reason: "an address is not a name: open the site by its name so the allowances list can judge it" };
  const shown = clean(url.hostname);
  const status = hostStatus(a, url.hostname);
  if (status === "denied") return { ok: false, reason: `${shown} is denied by your deny list` };
  if (status !== "allowed") return { ok: false, reason: `${shown} is not on the allowances list` };
  if (url.username || url.password) return { ok: false, reason: "the URL carries credentials" };
  if (url.port !== "" && url.port !== "80" && url.port !== "443" && !opts.extraPorts?.includes(Number(url.port))) return { ok: false, reason: `port ${clean(url.port, 6)} is not allowed (only 80 and 443)` };
  const host = normalizeHost(url.hostname)!;
  return { ok: true, host, platform: platformOf(a, host)!, url: url.href };
}

const isV4Public = (o: number[]): boolean => {
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;           // carrier-grade NAT, which includes Alibaba's metadata address
  if (a === 169 && b === 254) return false;                     // link-local, which includes every cloud's metadata address
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments (Oracle's metadata address) and documentation
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;        // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
};

// `net.isIP` has already refused anything malformed (leading zeros, a part over 255, a bad group count), so these two only turn a valid address into bytes.
const parseV4 = (s: string): number[] => s.split(".").map(Number);

/** 16 bytes of a valid IPv6 address, an embedded dotted IPv4 tail included. */
const parseV6 = (text: string): number[] => {
  let s = text;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const v4 = parseV4(tail[1]);
    s = `${s.slice(0, tail.index)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = [...head, ...Array<string>(halves.length === 2 ? 8 - head.length - rest.length : 0).fill("0"), ...rest];
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
};

const isV6Public = (b: number[]): boolean => {
  const zeros = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isV4Public(b.slice(12));                                     // IPv4-mapped: judged as the IPv4 address it is
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return isV4Public(b.slice(12));        // NAT64: the IPv4 address it carries
  if (b[0] === 0x20 && b[1] === 0x02) return isV4Public(b.slice(2, 6));                                                     // 6to4: the IPv4 address it carries
  if ((b[0] & 0xe0) !== 0x20) return false;                                                                                 // only global unicast, 2000::/3
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] < 0x02) return false;                                                          // 2001::/23: Teredo, protocol assignments, benchmarking
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false;                                      // documentation
  if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0) return false;                                                  // documentation
  return true;
};

/** Whether a connection to this address is allowed in LIVE mode: global unicast addresses only. Private, loopback, link-local (every cloud's metadata address), carrier-grade NAT, multicast, reserved and documentation ranges are not, nor are IPv6 forms that carry one of them. */
export function isPublicAddress(ip: unknown): boolean {
  if (typeof ip !== "string" || ip.includes("%")) return false;
  const kind = isIP(ip);
  if (kind === 4) return isV4Public(parseV4(ip));
  if (kind === 6) return isV6Public(parseV6(ip));
  return false;
}

/**
 * The network gate's policy in LIVE mode. Subresources (CDNs, fonts, analytics) must load for a page to work, so the gate lets any public host through except the ones the user denied, and refuses every address
 * that is not global unicast, whatever name led to it. Which pages the agent may navigate to is a separate rule (`navigationVerdict`), applied where the browser can tell a page from a subresource.
 * `isPublic` is replaceable so tests can point "public" names at a local server; the real function is used everywhere else.
 */
export function livePolicy(a: Allowances, opts: { isPublic?: (ip: string) => boolean } = {}): NetGatePolicy {
  const isPublic = opts.isPublic ?? isPublicAddress;
  return {
    allowHost: (h) => {
      const host = h.toLowerCase();
      if (host === "localhost" || host.endsWith(".localhost")) return false;
      return hostStatus(a, host) !== "denied";
    },
    allowAddress: (ip) => isPublic(ip),
  };
}

export type LoadedAllowances = { ok: true; value: Allowances; source: "none" | "file"; path: string } | { ok: false; errors: string[] };

/** Checks a parsed JSON value and turns it into rules. Every problem is listed, so the user fixes the file once. */
export function parseAllowances(raw: unknown): { ok: true; value: Allowances } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, errors: ["the allowances file must be a JSON object with allow, deny and platforms"] };
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (!["allow", "deny", "platforms"].includes(k)) errors.push(`unknown key "${clean(k, 30)}"`);
  const list = (key: string, v: unknown): HostRule[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) { errors.push(`${key} must be a list of domains`); return []; }
    if (v.length > MAX_RULES) { errors.push(`${key} has ${v.length} entries (at most ${MAX_RULES})`); return []; }
    const out: HostRule[] = [];
    v.forEach((item, i) => {
      const r = hostRule(item);
      if (r) out.push(r);
      else errors.push(`${key}[${i}]: ${JSON.stringify(clean(String(item), 60))} is not a plain domain such as example.com (no scheme, port, path, wildcard or address, and not a shared hosting domain)`);
    });
    return out;
  };
  const allow = list("allow", obj.allow);
  const deny = list("deny", obj.deny);
  const platforms: Allowances["platforms"] = [];
  if (obj.platforms !== undefined) {
    if (typeof obj.platforms !== "object" || obj.platforms === null || Array.isArray(obj.platforms)) errors.push("platforms must be an object that maps a platform name to a list of domains");
    else if (Object.keys(obj.platforms).length > MAX_PLATFORMS) errors.push(`platforms has more than ${MAX_PLATFORMS} entries`);
    else {
      for (const [name, v] of Object.entries(obj.platforms as Record<string, unknown>)) {
        if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) { errors.push(`platform name ${JSON.stringify(clean(name, 30))} must be lower-case letters, digits and hyphens`); continue; }
        const rules = list(`platforms.${name}`, v);
        for (const r of rules) {
          if (!allow.some((x) => matches(x, r.host))) errors.push(`platform ${name}: ${r.host} is not on the allow list, so the platform could not be reached`);
        }
        platforms.push({ name, rules });
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { allow, deny, platforms } };
}

export type UserJson = { ok: true; missing: false; json: unknown; path: string } | { ok: true; missing: true; path: string } | { ok: false; errors: string[] };

/** Reads a JSON file the user keeps in their own agent-loop directory (`<home>/<fileName>`; `allowances.json`, `uploads.json`). No file is `missing`, not an error. The file is the user's: a link, a directory or (on POSIX) a
 * file someone else can write or that is not theirs is refused, so a project (or an agent) cannot grant itself anything by placing or editing it. */
export function readUserJson(home: string, fileName: string, opts: { uid?: number } = {}): UserJson {
  const path = join(home, fileName);
  const shown = clean(path, 200);
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, missing: true, path };
    return { ok: false, errors: [`cannot read ${shown} (${clean(String((err as NodeJS.ErrnoException).code ?? "error"), 20)})`] };
  }
  if (st.isSymbolicLink()) return { ok: false, errors: [`${shown} is a link; put the real file there, so nothing can be swapped in behind it`] };
  if (!st.isFile()) return { ok: false, errors: [`${shown} is not a file`] };
  if (st.size > MAX_FILE_BYTES) return { ok: false, errors: [`${shown} is too large (${st.size} bytes; the limit is ${MAX_FILE_BYTES})`] };
  if (process.platform !== "win32") {
    if (st.mode & 0o022) return { ok: false, errors: [`${shown} is writable by others (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 "${shown}"`] };
    const uid = opts.uid ?? process.getuid?.();
    if (uid !== undefined && st.uid !== uid) return { ok: false, errors: [`${shown} is not owned by you`] };
  }
  try {
    return { ok: true, missing: false, json: JSON.parse(readFileSync(path, "utf8")), path };
  } catch {
    return { ok: false, errors: [`${shown} is not valid JSON`] };
  }
}

/** Reads `<home>/allowances.json`. No file means nothing is allowed. */
export function loadAllowances(home: string, opts: { uid?: number } = {}): LoadedAllowances {
  const read = readUserJson(home, "allowances.json", opts);
  if (!read.ok) return { ok: false, errors: read.errors };
  if (read.missing) return { ok: true, value: NO_ALLOWANCES, source: "none", path: read.path };
  const shown = clean(read.path, 200);
  const r = parseAllowances(read.json);
  return r.ok ? { ok: true, value: r.value, source: "file", path: read.path } : { ok: false, errors: r.errors.map((e) => `${shown}: ${e}`) };
}
