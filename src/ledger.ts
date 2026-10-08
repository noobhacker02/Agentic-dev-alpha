// The application ledger (docs/HYBRID-AGENT-SPEC.md "Ledger: exactly once"). Before a submit click the program writes an `intended` row; after the page shows the confirmation it marks it `confirmed`. A crash between the two
// leaves `intended`, and on resume that row is verified, not retried. Caps (per site, global, per hour, per day, and a gap between two submissions) are counted from this table, in code, with an injectable clock; the model is
// told the caps and cannot change them. Times are kept as UTC milliseconds plus a monotonic sequence number, and a window is computed from the larger of the clock and the last time written, so a clock stepped back an hour
// cannot open a second batch.
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readUserJson } from "./allowances.js";

export interface LedgerCaps { perDay: number; perHour: number; perSiteDay: number; minGapMs: number }
export const DEFAULT_CAPS: LedgerCaps = { perDay: 30, perHour: 10, perSiteDay: 30, minGapMs: 60_000 };

export type RowState = "intended" | "confirmed" | "failed";
export interface Job { /** The site's own id for the posting, if it has one. */ jobId?: string; /** A platform name, never a company tenant. */ site: string; company: string; title: string }
export interface Row { seq: number; key: string; site: string; company: string; title: string; state: RowState; formHash: string; at: number; note: string; /** The posting's page, to look at when the attempt must be verified. */ url: string }

export type Verdict = { ok: true } | { ok: false; why: string; waitMs?: number; duplicateOf?: Row };

/** Letters and digits of any script (and the + and # that tell C++ from C#), in one case and one Unicode form; nothing else counts (adversary round 4 A70: the first version kept only a-z, so every non-Latin title was the same empty text). */
const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, " ").trim();
/** `norm`, or the text as it is when nothing but punctuation was in it (so "???" and "..." stay two different titles). */
const canon = (s: string): string => norm(s) || s.normalize("NFKC").trim().toLowerCase();
const siteOf = (s: string): string => s.normalize("NFKC").trim().toLowerCase();
/** The identity of a posting: the site's job id when it has one, else the company and title. The platform and the id are compared without case or edge spaces (A71). */
export const jobKey = (j: Job): string => (j.jobId?.trim() ? `${siteOf(j.site)}:${j.jobId.trim()}` : `${siteOf(j.site)}:${canon(j.company)}|${canon(j.title)}`);
const DAY = 24 * 3600_000, HOUR = 3600_000, THIRTY_DAYS = 30 * DAY;
/** How far ahead of the real clock the remembered time may be: a clock stepped back is not trusted, but one forward jump must not freeze the ledger for ever (A73). */
const MAX_LEAD_MS = DAY;

const withWait = (ms: number | undefined): { waitMs?: number } => (ms !== undefined && Number.isFinite(ms) ? { waitMs: ms } : {});

export class Ledger {
  private db: DatabaseSync;
  private floor = 0;
  constructor(path: string, private clock: () => number = Date.now, private caps: LedgerCaps = DEFAULT_CAPS) {
    this.db = new DatabaseSync(path);
    // two processes on one ledger wait for each other's write instead of failing with "database is locked" (A69)
    this.db.exec("PRAGMA busy_timeout = 5000");
    try { chmodSync(path, 0o600); } catch { /* not a file system with modes */ }
    this.db.exec(`CREATE TABLE IF NOT EXISTS applications (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, site TEXT NOT NULL, company TEXT NOT NULL, title TEXT NOT NULL,
      state TEXT NOT NULL, form_hash TEXT NOT NULL, at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS applications_key ON applications(key);`);
    // a ledger written before the page was remembered
    const cols = this.db.prepare("PRAGMA table_info(applications)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "url")) this.db.exec("ALTER TABLE applications ADD COLUMN url TEXT NOT NULL DEFAULT ''");
    this.db.exec("CREATE TABLE IF NOT EXISTS site_pauses (site TEXT PRIMARY KEY, at INTEGER NOT NULL, why TEXT NOT NULL)");
    // (a unique index on the live key would refuse a re-application after the 30 days the duplicate check allows it: the write transaction in `intend` is what keeps two rows apart, A92)
    this.db.exec("DROP INDEX IF EXISTS applications_live_key"); // devskill:allow (removes this program's own stale index from its own ledger; no data is dropped)
    const last = this.db.prepare("SELECT MAX(at) AS m FROM applications").get() as { m: number | null };
    this.floor = last.m ?? 0; // a floor further ahead than the clock may be trusted is pulled back by the first `now()`
  }
  close(): void { this.db.close(); }

  /** Now, but never earlier than the last time written: a clock stepped back does not reopen a window. */
  private now(): number {
    const real = this.clock();
    if (this.floor > real + MAX_LEAD_MS) this.repair();
    this.floor = Math.max(this.floor, real);
    return this.floor;
  }

  /** Rows (and the remembered time) stamped further ahead than the clock may be trusted are pulled back to the limit, once, so they age out like any other row and a single forward jump does not freeze the ledger (A73). */
  private repair(): void {
    // rows from the future are treated as written now: the freeze is then at most one window, and the clock the caps run on is the real one (round 5, A90: pulling them back to the limit left the clock a day ahead)
    const real = this.clock();
    this.db.prepare("UPDATE applications SET at = ? WHERE at > ?").run(real, real + MAX_LEAD_MS);
    this.floor = real;
  }

  private rows(sql: string, ...args: Array<string | number>): Row[] {
    return (this.db.prepare(sql).all(...args) as Array<Record<string, string | number>>).map((r) => ({ seq: Number(r.seq), key: String(r.key), site: String(r.site), company: String(r.company), title: String(r.title), state: r.state as RowState, formHash: String(r.form_hash), at: Number(r.at), note: String(r.note), url: String(r.url ?? "") }));
  }

  /** Has this posting been applied to, or is an application to it unaccounted for? An `intended` row blocks a new attempt until it is verified. */
  duplicate(job: Job): Row | undefined {
    const since = this.now() - THIRTY_DAYS;
    const key = jobKey(job);
    const byKey = this.rows("SELECT * FROM applications WHERE key = ? AND state IN ('intended','confirmed') AND at >= ? ORDER BY seq DESC LIMIT 1", key, since)[0];
    if (byKey) return byKey;
    // the same company and title on the same platform under another id (a repost) within 30 days
    const c = canon(job.company), t = canon(job.title);
    if (!c || !t) return undefined; // nothing left to compare: two unlike postings must not be one
    return this.rows("SELECT * FROM applications WHERE site = ? AND state IN ('intended','confirmed') AND at >= ?", siteOf(job.site), since).find((r) => canon(r.company) === c && canon(r.title) === t);
  }

  /** May one more application start now? Counted from the ledger: confirmed and intended rows both count (an intended one may have gone through). */
  mayStart(job: Job): Verdict {
    const dup = this.duplicate(job);
    if (dup) return { ok: false, why: dup.state === "intended" ? `an earlier attempt at this posting (#${dup.seq}) has no confirmation: verify it before trying again` : `already applied to this posting (#${dup.seq})`, duplicateOf: dup };
    const now = this.now();
    const live = (since: number): Row[] => this.rows("SELECT * FROM applications WHERE state IN ('intended','confirmed') AND at >= ?", since);
    const day = live(now - DAY), hour = day.filter((r) => r.at >= now - HOUR);
    // a cap of 0 is "never": no time at which it opens
    const opens = (rows: Row[], span: number): number | undefined => (rows.length ? Math.max(0, Math.min(...rows.map((r) => r.at)) + span - now) : undefined);
    if (day.length >= this.caps.perDay) return { ok: false, why: `the daily cap of ${this.caps.perDay} is reached`, ...withWait(opens(day, DAY)) };
    if (hour.length >= this.caps.perHour) return { ok: false, why: `the hourly cap of ${this.caps.perHour} is reached`, ...withWait(opens(hour, HOUR)) };
    const site = day.filter((r) => r.site === siteOf(job.site));
    if (site.length >= this.caps.perSiteDay) return { ok: false, why: `the daily cap of ${this.caps.perSiteDay} for ${siteOf(job.site)} is reached`, ...withWait(opens(site, DAY)) };
    const last = day.reduce((m, r) => Math.max(m, r.at), 0);
    if (last && now - last < this.caps.minGapMs) return { ok: false, why: `the last application was ${Math.round((now - last) / 1000)} s ago; the gap is ${Math.round(this.caps.minGapMs / 1000)} s`, waitMs: last + this.caps.minGapMs - now };
    return { ok: true };
  }

  /** Written before the submit click. Returns the row number, or refuses if the posting is already accounted for (a second intent for the same posting is the double-apply this table exists to stop). */
  intend(job: Job, formHash: string, url = ""): { ok: true; seq: number } | { ok: false; why: string } {
    // the check and the insert are one write transaction: another process cannot slip an `intended` row in between (A69)
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const dup = this.duplicate(job);
      if (dup) { this.db.exec("ROLLBACK"); return { ok: false, why: `posting already has row #${dup.seq} (${dup.state})` }; }
      const r = this.db.prepare("INSERT INTO applications (key, site, company, title, state, form_hash, at, url) VALUES (?, ?, ?, ?, 'intended', ?, ?, ?)").run(jobKey(job), siteOf(job.site), job.company, job.title, formHash, this.now(), url.slice(0, 500));
      this.db.exec("COMMIT");
      return { ok: true, seq: Number(r.lastInsertRowid) };
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* no transaction left */ }
      if (/UNIQUE/i.test(String((err as Error).message))) return { ok: false, why: "posting already has a live row" };
      throw err;
    }
  }
  confirm(seq: number, note = ""): void { this.db.prepare("UPDATE applications SET state = 'confirmed', note = ? WHERE seq = ? AND state = 'intended'").run(note.slice(0, 200), seq); }
  /** The attempt provably did not go through (the site says it was not received): the row stops counting and the posting can be tried again. */
  fail(seq: number, note = ""): void { this.db.prepare("UPDATE applications SET state = 'failed', note = ? WHERE seq = ? AND (state = 'intended' OR (state = 'confirmed' AND note LIKE 'verified on the site%'))").run(note.slice(0, 200), seq); }
  /** What the user may close as not received: attempts with no confirmation, and rows the program confirmed only because a page said so (page text can be wrong, A80). */
  forgettable(): Row[] { return this.rows("SELECT * FROM applications WHERE state = 'intended' OR (state = 'confirmed' AND note LIKE 'verified on the site%') ORDER BY seq"); }
  /** A site that showed a challenge or a rate limit is paused until the user says otherwise; the pause survives the process (A72). */
  pause(site: string, why: string): void { this.db.prepare("INSERT OR REPLACE INTO site_pauses (site, at, why) VALUES (?, ?, ?)").run(siteOf(site), this.now(), why.slice(0, 200)); }
  paused(site: string): { at: number; why: string } | undefined {
    const r = this.db.prepare("SELECT at, why FROM site_pauses WHERE site = ?").get(siteOf(site)) as { at: number; why: string } | undefined;
    return r ? { at: Number(r.at), why: String(r.why) } : undefined;
  }
  unpause(site: string): boolean { return Number(this.db.prepare("DELETE FROM site_pauses WHERE site = ?").run(siteOf(site)).changes) > 0; }
  /** Rows written before a crash and never closed: each must be verified against the site before anything is retried. */
  unaccounted(): Row[] { return this.rows("SELECT * FROM applications WHERE state = 'intended' ORDER BY seq"); }
  all(): Row[] { return this.rows("SELECT * FROM applications ORDER BY seq"); }
}

export type LoadedCaps = { ok: true; value: LedgerCaps; source: "default" | "file" } | { ok: false; errors: string[] };

/** The user's own caps, from `<home>/caps.json` ({"perDay": 20, "perHour": 5, "perSiteDay": 15, "minGapSeconds": 120}); missing keys keep the defaults. The model never sees this file and cannot change a cap. */
export function loadCaps(home: string, opts: { uid?: number } = {}): LoadedCaps {
  const read = readUserJson(home, "caps.json", opts);
  if (!read.ok) return { ok: false, errors: read.errors };
  if (read.missing) return { ok: true, value: DEFAULT_CAPS, source: "default" };
  const raw = read.json;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["caps.json must be a JSON object like {\"perDay\": 20}"] };
  const errors: string[] = [];
  const out = { ...DEFAULT_CAPS };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!["perDay", "perHour", "perSiteDay", "minGapSeconds"].includes(k)) { errors.push(`unknown key "${k.replace(/[^\x20-\x7e]/g, "?").slice(0, 40)}"`); continue; }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000) { errors.push(`${k} must be a number from 0 to 100000`); continue; }
    if (k === "minGapSeconds") out.minGapMs = Math.round(v * 1000);
    else (out as unknown as Record<string, number>)[k] = Math.floor(v);
  }
  return errors.length ? { ok: false, errors: errors.map((e) => `${read.path}: ${e}`) } : { ok: true, value: out, source: "file" };
}
