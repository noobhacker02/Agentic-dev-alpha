// The application ledger (docs/HYBRID-AGENT-SPEC.md "Ledger: exactly once"). Before a submit click the program writes an `intended` row; after the page shows the confirmation it marks it `confirmed`. A crash between the two
// leaves `intended`, and on resume that row is verified, not retried. Caps (per site, global, per hour, per day, and a gap between two submissions) are counted from this table, in code, with an injectable clock; the model is
// told the caps and cannot change them. Times are kept as UTC milliseconds plus a monotonic sequence number, and a window is computed from the larger of the clock and the last time written, so a clock stepped back an hour
// cannot open a second batch.
import { DatabaseSync } from "node:sqlite";
import { readUserJson } from "./allowances.js";

export interface LedgerCaps { perDay: number; perHour: number; perSiteDay: number; minGapMs: number }
export const DEFAULT_CAPS: LedgerCaps = { perDay: 30, perHour: 10, perSiteDay: 30, minGapMs: 60_000 };

export type RowState = "intended" | "confirmed" | "failed";
export interface Job { /** The site's own id for the posting, if it has one. */ jobId?: string; /** A platform name, never a company tenant. */ site: string; company: string; title: string }
export interface Row { seq: number; key: string; site: string; company: string; title: string; state: RowState; formHash: string; at: number; note: string }

export type Verdict = { ok: true } | { ok: false; why: string; waitMs?: number; duplicateOf?: Row };

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** The identity of a posting: the site's job id when it has one, else the company and title. */
export const jobKey = (j: Job): string => (j.jobId ? `${j.site}:${j.jobId}` : `${j.site}:${norm(j.company)}|${norm(j.title)}`);
const DAY = 24 * 3600_000, HOUR = 3600_000, THIRTY_DAYS = 30 * DAY;

export class Ledger {
  private db: DatabaseSync;
  private floor = 0;
  constructor(path: string, private clock: () => number = Date.now, private caps: LedgerCaps = DEFAULT_CAPS) {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS applications (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, site TEXT NOT NULL, company TEXT NOT NULL, title TEXT NOT NULL,
      state TEXT NOT NULL, form_hash TEXT NOT NULL, at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS applications_key ON applications(key);`);
    const last = this.db.prepare("SELECT MAX(at) AS m FROM applications").get() as { m: number | null };
    this.floor = last.m ?? 0;
  }
  close(): void { this.db.close(); }

  /** Now, but never earlier than the last time written: a clock stepped back does not reopen a window. */
  private now(): number { this.floor = Math.max(this.floor, this.clock()); return this.floor; }

  private rows(sql: string, ...args: Array<string | number>): Row[] {
    return (this.db.prepare(sql).all(...args) as Array<Record<string, string | number>>).map((r) => ({ seq: Number(r.seq), key: String(r.key), site: String(r.site), company: String(r.company), title: String(r.title), state: r.state as RowState, formHash: String(r.form_hash), at: Number(r.at), note: String(r.note) }));
  }

  /** Has this posting been applied to, or is an application to it unaccounted for? An `intended` row blocks a new attempt until it is verified. */
  duplicate(job: Job): Row | undefined {
    const since = this.now() - THIRTY_DAYS;
    const key = jobKey(job);
    const byKey = this.rows("SELECT * FROM applications WHERE key = ? AND state IN ('intended','confirmed') AND at >= ? ORDER BY seq DESC LIMIT 1", key, since)[0];
    if (byKey) return byKey;
    // the same company and title on the same platform under another id (a repost) within 30 days
    const same = this.rows("SELECT * FROM applications WHERE site = ? AND state IN ('intended','confirmed') AND at >= ?", job.site, since)
      .find((r) => norm(r.company) === norm(job.company) && norm(r.title) === norm(job.title));
    return same;
  }

  /** May one more application start now? Counted from the ledger: confirmed and intended rows both count (an intended one may have gone through). */
  mayStart(job: Job): Verdict {
    const dup = this.duplicate(job);
    if (dup) return { ok: false, why: dup.state === "intended" ? `an earlier attempt at this posting (#${dup.seq}) has no confirmation: verify it before trying again` : `already applied to this posting (#${dup.seq})`, duplicateOf: dup };
    const now = this.now();
    const live = (since: number): Row[] => this.rows("SELECT * FROM applications WHERE state IN ('intended','confirmed') AND at >= ?", since);
    const day = live(now - DAY), hour = day.filter((r) => r.at >= now - HOUR);
    if (day.length >= this.caps.perDay) return { ok: false, why: `the daily cap of ${this.caps.perDay} is reached`, waitMs: Math.max(...[0, Math.min(...day.map((r) => r.at)) + DAY - now]) };
    if (hour.length >= this.caps.perHour) return { ok: false, why: `the hourly cap of ${this.caps.perHour} is reached`, waitMs: Math.min(...hour.map((r) => r.at)) + HOUR - now };
    const site = day.filter((r) => r.site === job.site);
    if (site.length >= this.caps.perSiteDay) return { ok: false, why: `the daily cap of ${this.caps.perSiteDay} for ${job.site} is reached`, waitMs: Math.min(...site.map((r) => r.at)) + DAY - now };
    const last = day.reduce((m, r) => Math.max(m, r.at), 0);
    if (last && now - last < this.caps.minGapMs) return { ok: false, why: `the last application was ${Math.round((now - last) / 1000)} s ago; the gap is ${Math.round(this.caps.minGapMs / 1000)} s`, waitMs: last + this.caps.minGapMs - now };
    return { ok: true };
  }

  /** Written before the submit click. Returns the row number, or refuses if the posting is already accounted for (a second intent for the same posting is the double-apply this table exists to stop). */
  intend(job: Job, formHash: string): { ok: true; seq: number } | { ok: false; why: string } {
    const dup = this.duplicate(job);
    if (dup) return { ok: false, why: `posting already has row #${dup.seq} (${dup.state})` };
    const r = this.db.prepare("INSERT INTO applications (key, site, company, title, state, form_hash, at) VALUES (?, ?, ?, ?, 'intended', ?, ?)").run(jobKey(job), job.site, job.company, job.title, formHash, this.now());
    return { ok: true, seq: Number(r.lastInsertRowid) };
  }
  confirm(seq: number, note = ""): void { this.db.prepare("UPDATE applications SET state = 'confirmed', note = ? WHERE seq = ? AND state = 'intended'").run(note.slice(0, 200), seq); }
  /** The attempt provably did not go through (the site says it was not received): the row stops counting and the posting can be tried again. */
  fail(seq: number, note = ""): void { this.db.prepare("UPDATE applications SET state = 'failed', note = ? WHERE seq = ? AND state = 'intended'").run(note.slice(0, 200), seq); }
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
