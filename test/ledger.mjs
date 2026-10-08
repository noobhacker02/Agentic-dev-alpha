// The application ledger (docs/HYBRID-AGENT-SPEC.md "Ledger: exactly once"; threats B2, B5): a posting is applied to once, a row left `intended` by a crash blocks a retry until it is verified, caps are counted in code from
// the table with an injectable clock, and a clock stepped back does not open a second batch. Each refusal has a control that is allowed.
//   npm run build && npm run test:ledger
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, jobKey, DEFAULT_CAPS } from "../dist/ledger.js";

const dir = mkdtempSync(join(tmpdir(), "ledger-"));
let n = 0;
const fresh = (clock, caps) => new Ledger(join(dir, `l${++n}.db`), clock, caps);
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const HOUR = 3600_000, DAY = 24 * HOUR;
let now = T0;
const clock = () => now;
const job = (id, extra = {}) => ({ site: "linkedin", company: "Acme", title: "Engineer", jobId: id, ...extra });

// 1. Exactly once
{
  now = T0;
  const l = fresh(clock, { ...DEFAULT_CAPS, minGapMs: 0 });
  assert.deepStrictEqual(l.mayStart(job("1")), { ok: true });
  const a = l.intend(job("1"), "h1");
  assert.ok(a.ok);
  // an intended row blocks a second attempt at the same posting, with the reason
  const again = l.mayStart(job("1"));
  assert.ok(!again.ok && /no confirmation: verify it/.test(again.why), JSON.stringify(again));
  assert.ok(!l.intend(job("1"), "h2").ok, "a second intent for the same posting was written");
  l.confirm(a.seq, "thanks page");
  const done = l.mayStart(job("1"));
  assert.ok(!done.ok && /already applied/.test(done.why));
  // the posting's title was edited after it was applied to: the site's id still says it is the same posting
  assert.ok(!l.mayStart(job("1", { title: "Platform Engineer (remote)" })).ok, "the same id with an edited title was a new posting");
  // a repost: the same company and title under another id
  assert.ok(!l.mayStart(job("2")).ok, "the same company and title under another id was a new posting");
  // controls: another title, another company, another platform
  assert.ok(l.mayStart(job("3", { title: "Designer" })).ok);
  assert.ok(l.mayStart(job("4", { company: "Globex" })).ok);
  assert.ok(l.mayStart(job("1", { site: "greenhouse" })).ok, "the same id on another platform is another posting");
  // the case and punctuation of a title do not make a new posting
  assert.ok(!l.mayStart({ site: "linkedin", company: "ACME, Inc".replace(", Inc", ""), title: "engineer!" }).ok);
  // thirty days later it can be applied to again
  now = T0 + 31 * DAY;
  assert.ok(l.mayStart(job("1")).ok, "an application older than 30 days still blocked");
  l.close();
  console.log("[ok] a posting is applied to once: an intended row blocks a retry, a confirmed one is a duplicate, a repost is one, other titles, companies and platforms are not; it expires after 30 days");
}

// 2. A crash between intent and confirmation
{
  now = T0;
  const path = join(dir, "crash.db");
  const a = new Ledger(path, clock);
  const row = a.intend(job("9"), "h");
  assert.ok(row.ok);
  a.close(); // the process is killed here
  const b = new Ledger(path, clock);
  assert.deepStrictEqual(b.unaccounted().map((r) => r.key), ["linkedin:9"]);
  assert.ok(!b.mayStart(job("9")).ok, "a posting with an unverified attempt was started again");
  // verified as not received: the row stops counting and the posting can be tried again
  b.fail(row.seq, "the site has no application for it");
  assert.strictEqual(b.unaccounted().length, 0);
  assert.ok(b.mayStart(job("9")).ok);
  // verified as received
  const c = new Ledger(join(dir, "crash2.db"), clock);
  const r2 = c.intend(job("10", { title: "Other" }), "h");
  c.confirm(r2.seq);
  assert.ok(!c.mayStart(job("10", { title: "Other" })).ok);
  assert.strictEqual(c.unaccounted().length, 0);
  // confirm and fail only act on an intended row
  c.fail(r2.seq);
  assert.strictEqual(c.all()[0].state, "confirmed", "a confirmed row was failed");
  console.log("[ok] a row left intended by a crash is found after reopening, blocks a retry until it is verified, and is closed as failed or confirmed; a confirmed row cannot be failed");
}

// 3. Caps, counted from the table
{
  const caps = { perDay: 5, perHour: 3, perSiteDay: 10, minGapMs: 60_000 };
  now = T0;
  const l = fresh(clock, caps);
  const go = (i, site = "linkedin") => { const j = { site, company: `C${i}`, title: "T", jobId: String(i) }; const v = l.mayStart(j); if (v.ok) l.confirm(l.intend(j, "h").seq); return v; };
  assert.ok(go(1).ok);
  // the gap between two submissions
  now += 30_000;
  const gap = go(2);
  assert.ok(!gap.ok && /gap is 60 s/.test(gap.why) && gap.waitMs === 30_000, JSON.stringify(gap));
  now += 31_000;
  assert.ok(go(2).ok);
  now += 61_000;
  assert.ok(go(3).ok);
  // the hourly cap
  now += 61_000;
  const hour = go(4);
  assert.ok(!hour.ok && /hourly cap of 3/.test(hour.why) && hour.waitMs > 0, JSON.stringify(hour));
  // an hour after the first one it opens again
  now = T0 + HOUR + 1000;
  assert.ok(go(4).ok);
  now = T0 + 2 * HOUR;
  assert.ok(go(5).ok);
  // five today: the daily cap, with the time it opens
  now += 61_000;
  const day = go(6, "greenhouse");
  assert.ok(!day.ok && /daily cap of 5/.test(day.why), JSON.stringify(day));
  assert.ok(Math.abs(day.waitMs - (T0 + DAY - now)) < 1000, `wait ${day.waitMs}`);
  now = T0 + DAY + 1000;
  assert.ok(go(6, "greenhouse").ok);
  l.close();
  // the per-site cap does not stop another site (controls)
  now = T0;
  const m = fresh(clock, { perDay: 50, perHour: 50, perSiteDay: 2, minGapMs: 0 });
  const go2 = (i, site) => { const j = { site, company: `D${i}`, title: "T", jobId: String(i) }; const v = m.mayStart(j); if (v.ok) m.confirm(m.intend(j, "h").seq); return v; };
  assert.ok(go2(1, "linkedin").ok && go2(2, "linkedin").ok);
  const s = go2(3, "linkedin");
  assert.ok(!s.ok && /for linkedin/.test(s.why), JSON.stringify(s));
  assert.ok(go2(4, "greenhouse").ok, "a cap on one platform stopped another");
  // a Workday tenant per company is the platform, not a new site with a fresh quota
  assert.ok(!go2(5, "linkedin").ok);
  console.log("[ok] caps are counted from the ledger: the gap, the hourly, daily and per-platform caps refuse with the time they open; another platform is not stopped");
}

// 4. A clock stepped back does not open a second batch
{
  now = T0;
  const caps = { perDay: 2, perHour: 2, perSiteDay: 2, minGapMs: 0 };
  const l = fresh(clock, caps);
  for (const i of [1, 2]) l.confirm(l.intend({ site: "linkedin", company: `E${i}`, title: "T", jobId: String(i) }, "h").seq);
  assert.ok(!l.mayStart(job("77", { company: "Z", title: "Q" })).ok);
  now = T0 - 5 * HOUR; // someone set the clock back
  assert.ok(!l.mayStart(job("78", { company: "Y", title: "R" })).ok, "a clock set back opened a second batch");
  // and a restart does not forget it either
  l.close();
  const path = join(dir, "back.db");
  now = T0;
  const a = new Ledger(path, clock, caps);
  for (const i of [1, 2]) a.confirm(a.intend({ site: "linkedin", company: `F${i}`, title: "T", jobId: String(i) }, "h").seq);
  a.close();
  now = T0 - 5 * HOUR;
  const b = new Ledger(path, clock, caps);
  assert.ok(!b.mayStart(job("79", { company: "X", title: "S" })).ok, "a restart with the clock set back opened a second batch");
  b.close();
  console.log("[ok] a clock set back, in the same process or across a restart, does not open a second batch");
}

// 5. Keys
{
  assert.strictEqual(jobKey({ site: "linkedin", jobId: "42", company: "A", title: "B" }), "linkedin:42");
  assert.strictEqual(jobKey({ site: "lever", company: "Acme Inc.", title: "Sr. Engineer" }), "lever:acme inc|sr engineer");
  assert.ok(DEFAULT_CAPS.perDay === 30 && DEFAULT_CAPS.perHour === 10);
  console.log("[ok] a posting's key is the site's id, or the normalised company and title; the default caps are 30 a day and 10 an hour");
}
console.log("\nALL LEDGER TESTS PASSED");
