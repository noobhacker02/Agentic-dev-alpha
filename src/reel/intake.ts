// Step 1 of the reel flow (docs/REEL-FLOW.md): what the user sent, reduced to a key. A link keeps only its host and shortcode: every query parameter goes, `igsh` above all (it ties the link to the account that shared it, threat R12).
// Nothing but an Instagram reel/post link is accepted; any other site is not this flow's.
import { createHash } from "node:crypto";

const HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com", "instagr.am", "www.instagr.am"]);
const KINDS = new Set(["reel", "reels", "p", "tv"]);
const RESERVED = new Set(["audio", "explore", "tags", "popular", "accounts", "stories", "direct", "reels", "reel", "p", "tv", "locations", "web"]);
const SHORTCODE = /^[A-Za-z0-9_-]{5,24}$/;

export type Intake = { ok: true; kind: "url"; key: string; canonical: string; shortcode: string } | { ok: false; reason: string };

export function canonicalReelUrl(raw: string): Intake {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, reason: "that is not a link" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "only http and https links are read" };
  if (u.username || u.password) return { ok: false, reason: "a link with a name and password in it is not read" };
  if (u.port && u.port !== "443" && u.port !== "80") return { ok: false, reason: "a link on another port is not an Instagram link" };
  if (!HOSTS.has(u.hostname.toLowerCase().replace(/\.$/, ""))) return { ok: false, reason: "this flow reads Instagram reel links; for another site, give it a file or the text" };
  const parts = u.pathname.split("/").filter(Boolean);
  // exactly /<reel|reels|p|tv>/<code>/ or /<account>/<reel|p|tv>/<code>/, anchored at the start (A147): /reels/audio/<n>/, /explore/tags/p/<x>/ and /stories/x/reel/<y> are not reels
  const k = (i: number) => KINDS.has((parts[i] ?? "").toLowerCase());
  let code: string | undefined;
  if (parts.length === 2 && k(0)) code = parts[1];
  else if (parts.length === 3 && k(1) && !RESERVED.has((parts[0] ?? "").toLowerCase())) code = parts[2];
  if (!code || !SHORTCODE.test(code) || RESERVED.has(code.toLowerCase())) return { ok: false, reason: "no reel or post code in that link" };
  return { ok: true, kind: "url", key: `ig:${code}`, canonical: `https://www.instagram.com/reel/${code}/`, shortcode: code };
}

/** The key of a file or of pasted text: its content, so the same reel sent twice by different routes is one record. */
export const contentKey = (kind: "file" | "text", bytes: Buffer | string): string => `${kind}:${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}`;
