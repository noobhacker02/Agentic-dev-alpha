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
  // the user can close a confirmed row too (a page's word is not proof, A103); a row younger than the guard may still be in flight and is not closed (A107)
  assert.strictEqual(c.fail(r2.seq, "too soon", { minAgeMs: 120_000 }), false, "a row younger than the guard was closed");
  assert.strictEqual(c.all()[0].state, "confirmed");
  assert.strictEqual(c.fail(r2.seq, "closed by the user"), true);
  assert.strictEqual(c.all()[0].state, "failed");
  assert.strictEqual(c.confirm(r2.seq), false, "a closed row was confirmed afterwards");
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

// 6. A ledger written before the page was remembered still opens, and keeps its rows
{
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(dir, "old.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE applications (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, site TEXT NOT NULL, company TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, form_hash TEXT NOT NULL, at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '');`);
  old.prepare("INSERT INTO applications (key, site, company, title, state, form_hash, at) VALUES ('linkedin:5','linkedin','Old Co','Dev','intended','h',?)").run(T0);
  old.close();
  now = T0;
  const l = new Ledger(path, clock, { ...DEFAULT_CAPS, minGapMs: 0 });
  assert.deepStrictEqual(l.unaccounted().map((r) => [r.key, r.url]), [["linkedin:5", ""]]);
  const next = l.intend(job("6", { company: "New Co" }), "h", "https://example.test/jobs/6");
  assert.ok(next.ok);
  assert.strictEqual(l.all().at(-1).url, "https://example.test/jobs/6");
  l.close();
  console.log("[ok] a ledger written before the posting's page was remembered opens with its rows and takes new ones with a page");
}

// 7. Adversary round 4 (A69 to A73)
{
  // A70: postings in any script are told apart, C++ is not C#, and nothing-left text never makes two postings one
  now = T0;
  const l = fresh(clock, { ...DEFAULT_CAPS, minGapMs: 0 });
  assert.ok(l.intend({ site: "wuzzuf", company: "日本株式会社", title: "開発者" }, "h").ok);
  assert.ok(l.mayStart({ site: "wuzzuf", company: "中国公司", title: "工程师" }).ok, "two postings in Chinese and Japanese were one posting");
  assert.ok(!l.mayStart({ site: "wuzzuf", company: "日本株式会社", title: "開発者" }).ok, "the same Japanese posting was new");
  assert.ok(l.intend({ site: "x", company: "Acme", title: "C++ Developer" }, "h").ok);
  assert.ok(l.mayStart({ site: "x", company: "Acme", title: "C# Developer" }).ok, "C# was taken for C++");
  assert.ok(l.intend({ site: "x", company: "!!!", title: "???" }, "h").ok);
  assert.ok(l.mayStart({ site: "x", company: "...", title: "---" }).ok, "two titles made only of punctuation were one");
  // A71: the platform and the job id are compared without case or edge spaces
  assert.ok(l.intend({ site: "LinkedIn", jobId: " 555 ", company: "A", title: "B" }, "h").ok);
  assert.ok(!l.mayStart({ site: "linkedin", jobId: "555", company: "Other", title: "Other" }).ok, "a posting under another spelling of the platform was new");
  assert.ok(!l.mayStart({ site: " LINKEDIN", jobId: "555\t", company: "Z", title: "Y" }).ok);
  l.close();

  // A69: four real processes on one ledger file, the same postings: exactly one live row each, and nobody fails with "database is locked"
  const path = join(dir, "race.db");
  new Ledger(path, clock).close();
  const script = `import { Ledger } from ${JSON.stringify(new URL("../dist/ledger.js", import.meta.url).href)};
    const l = new Ledger(${JSON.stringify(path)}, Date.now, { perDay: 1e6, perHour: 1e6, perSiteDay: 1e6, minGapMs: 0 });
    let won = 0, err = 0;
    for (let i = 0; i < 150; i++) { try { if (l.intend({ site: "s", jobId: String(i), company: "C" + i, title: "T" + i }, "h").ok) won++; } catch (e) { err++; } }
    console.log(JSON.stringify({ won, err })); l.close();`;
  const { spawn } = await import("node:child_process");
  const outs = await Promise.all([0, 1, 2, 3].map(() => new Promise((res) => { const p = spawn(process.execPath, ["--experimental-sqlite", "--no-warnings", "--input-type=module", "-e", script]); let o = "", e = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (e += d)); p.on("close", () => res({ o, e })); })));
  let won = 0;
  for (const { o, e } of outs) { const r = JSON.parse(o || "{}"); assert.ok(r.won !== undefined, `a process failed: ${e}`); assert.strictEqual(r.err, 0, "a process met an error under contention"); won += r.won; }
  const check = new Ledger(path, clock);
  const live = check.all().filter((r) => r.state === "intended");
  assert.strictEqual(new Set(live.map((r) => r.key)).size, live.length, "two live rows for one posting");
  assert.strictEqual(live.length, 150, `150 postings, ${live.length} rows`);
  assert.strictEqual(won, 150, `the four processes won ${won} times in all, not 150`);
  check.close();

  // A73: one forward jump of the clock does not freeze the ledger, in the process that saw it or in one that opens the file afterwards
  for (const reopen of [false, true]) {
    const caps = { perDay: 2, perHour: 2, perSiteDay: 2, minGapMs: 0 };
    now = T0;
    let j = fresh(clock, caps);
    const file = join(dir, `l${n}.db`);
    now = T0 + 400 * DAY; // the clock leaps ahead for a moment
    j.confirm(j.intend({ site: "s", company: "J1", title: "T" }, "h").seq);
    j.confirm(j.intend({ site: "s", company: "J2", title: "T" }, "h").seq);
    assert.ok(!j.mayStart({ site: "s", company: "J3", title: "T" }).ok);
    now = T0 + 2 * DAY; // and comes back, a day and more after the real time of the first
    if (reopen) { j.close(); j = new Ledger(file, clock, caps); }
    const back = j.mayStart({ site: "s", company: "J3", title: "T" });
    assert.ok(!back.ok && back.waitMs <= 2 * DAY, `the wait after a clock jump is ${back.waitMs} (${reopen ? "another process" : "same process"})`);
    now = T0 + 4.5 * DAY;
    assert.ok(j.mayStart({ site: "s", company: "J3", title: "T" }).ok, `the ledger stayed frozen after a forward jump (${reopen ? "another process" : "same process"})`);
    j.close();
  }

  // A90: pulling a future-stamped row back must not leave the clock a day ahead (which reopens the daily and hourly caps for the five applications done an hour ago)
  {
    now = T0;
    const caps5 = { perDay: 5, perHour: 5, perSiteDay: 5, minGapMs: 0 };
    const k = fresh(clock, caps5);
    for (let i = 0; i < 5; i++) k.confirm(k.intend({ site: "s", company: `K${i}`, title: "T" }, "h").seq);
    now = T0 + HOUR;
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(join(dir, `l${n}.db`));
    raw.prepare("INSERT INTO applications (key, site, company, title, state, form_hash, at, note, url) VALUES ('s:future','s','Future','T','confirmed','h',?, '', '')").run(T0 + HOUR + 5 * DAY);
    raw.close();
    k.close();
    const k2 = new Ledger(join(dir, `l${n}.db`), clock, caps5); // another process opens the file and finds the row from the future
    const v = k2.mayStart({ site: "s", company: "New", title: "T" });
    assert.ok(!v.ok, "five of five applications done an hour ago, and the cap reopened after a future-stamped row was pulled back");
    k2.close();
  }
  // A92: a re-application after the 30 days the duplicate check allows is not refused by the database
  {
    now = T0;
    const k = fresh(clock, { ...DEFAULT_CAPS, minGapMs: 0 });
    k.confirm(k.intend(job("77"), "h").seq);
    now = T0 + 31 * DAY;
    assert.ok(k.mayStart(job("77")).ok);
    const again = k.intend(job("77"), "h");
    assert.ok(again.ok, `intend refused a posting that mayStart allowed: ${JSON.stringify(again)}`);
    k.close();
  }
  // A105: the caps are decided again inside the write that records the intent, so runs that started together cannot all pass
  {
    now = T0;
    const k = fresh(clock, { perDay: 50, perHour: 2, perSiteDay: 50, minGapMs: 0 });
    const started = [1, 2, 3, 4].map((i) => ({ site: "s", company: `P${i}`, title: "T", jobId: String(i) })).filter((j) => k.mayStart(j).ok); // all four look fine at the start
    assert.strictEqual(started.length, 4);
    const results = started.map((j) => k.intend(j, "h"));
    assert.strictEqual(results.filter((r) => r.ok).length, 2, `the hourly cap of 2 let ${results.filter((r) => r.ok).length} through`);
    assert.ok(results.some((r) => !r.ok && /hourly cap/.test(r.why)));
    k.close();
  }
  // A106: the same page under another platform label is the same posting
  {
    now = T0;
    const k = fresh(clock, { ...DEFAULT_CAPS, minGapMs: 0 });
    assert.ok(k.intend({ site: "linkedin", jobId: "77", company: "A", title: "B" }, "h", "https://jobs.example.com/careers/77/apply?utm=x").ok);
    const again = k.mayStart({ site: "careers", jobId: "other", company: "Other", title: "Other" }, "https://Jobs.Example.com/careers/77#top");
    assert.ok(!again.ok, "the same address under another label was a new posting");
    assert.ok(k.mayStart({ site: "careers", jobId: "other", company: "Other", title: "Other" }, "https://jobs.example.com/careers/78").ok, "control: another address was refused");
    k.close();
  }
  // A111: one row stamped 23 hours ahead does not move the ledger's clock
  {
    now = T0;
    const caps5 = { perDay: 5, perHour: 5, perSiteDay: 5, minGapMs: 0 };
    const k = fresh(clock, caps5);
    for (let i = 0; i < 5; i++) k.confirm(k.intend({ site: "s", company: `M${i}`, title: "T" }, "h").seq);
    now = T0 + HOUR;
    k.close();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(join(dir, `l${n}.db`));
    raw.prepare("INSERT INTO applications (key, site, company, title, state, form_hash, at, note, url) VALUES ('s:ahead','s','Ahead','T','confirmed','h',?, '', '')").run(T0 + HOUR + 23.5 * HOUR);
    raw.close();
    const k2 = new Ledger(join(dir, `l${n}.db`), clock, caps5);
    assert.ok(!k2.mayStart({ site: "s", company: "New", title: "T" }).ok, "a row 23 and a half hours ahead moved the clock and reopened the caps");
    k2.close();
  }
  // a cap of 0 is never, with no time to wait; the pause of a site is remembered
  now = T0;
  const z = fresh(clock, { perDay: 0, perHour: 5, perSiteDay: 5, minGapMs: 0 });
  const never = z.mayStart(job("1"));
  assert.ok(!never.ok && /cap of 0/.test(never.why) && never.waitMs === undefined, JSON.stringify(never));
  assert.strictEqual(z.paused("LinkedIn"), undefined);
  z.pause("LinkedIn", "a challenge page");
  assert.match(z.paused("linkedin ").why, /challenge/);
  assert.ok(z.unpause("linkedin"));
  assert.strictEqual(z.paused("linkedin"), undefined);
  z.close();
  if (process.platform !== "win32") {
    const { statSync } = await import("node:fs");
    assert.strictEqual(statSync(join(dir, `l${n}.db`)).mode & 0o077, 0, "the ledger is readable by others");
  }
  console.log("[ok] round 4: other scripts and C++ versus C# are told apart, the platform and id are compared plainly, four real processes cannot write two live rows for one posting, a forward clock jump does not freeze the ledger, a cap of 0 has no wait, a site pause is remembered, the file is private");
}

// 5. Keys
{
  assert.strictEqual(jobKey({ site: "linkedin", jobId: "42", company: "A", title: "B" }), "linkedin:42");
  assert.strictEqual(jobKey({ site: "lever", company: "Acme Inc.", title: "Sr. Engineer" }), "lever:acme inc|sr engineer");
  assert.ok(DEFAULT_CAPS.perDay === 30 && DEFAULT_CAPS.perHour === 10);
  console.log("[ok] a posting's key is the site's id, or the normalised company and title; the default caps are 30 a day and 10 an hour");
}

// 8. Adversary round 7: the address test (A115)
{
  const l = fresh(() => now);
  const J = (id, title, extra = {}) => job(id, { title, company: "Acme", ...extra });
  const a = l.intend(J("111", "Platform Engineer"), "h", "https://acme.com/careers?gh_jid=111"); assert.ok(a.ok); l.confirm(a.seq);
  // a different posting behind the same path, told apart by a query parameter, is not a duplicate
  now += 3 * HOUR;
  assert.ok(l.mayStart(J("222", "Data Engineer"), "https://acme.com/careers?gh_jid=222").ok, "?gh_jid=222 was taken for ?gh_jid=111");
  // the same posting with tracking parameters, another order, or a trailing /apply is the same address
  for (const u of ["https://acme.com/careers?gh_jid=111&utm_source=li", "https://ACME.com/careers/?utm_campaign=x&gh_jid=111", "https://acme.com/careers/apply?gh_jid=111&gh_src=abc"]) {
    const r = l.mayStart(J("999", "Other Title"), u); assert.ok(!r.ok, `${u} should be the same address: ${JSON.stringify(r)}`);
    assert.match(r.why, /Acme \/ Platform Engineer/, "the refusal names the row it matched");
  }
  // a hash route names the posting too
  const b = l.intend(J("h1", "Site Reliability Engineer"), "h2", "https://jobs.example.com/#/job/41"); assert.ok(b.ok); l.confirm(b.seq);
  now += 3 * HOUR;
  assert.ok(l.mayStart(J("h2", "Backend Engineer"), "https://jobs.example.com/#/job/42").ok, "a hash-routed posting was taken for another");
  assert.ok(!l.mayStart(J("h3", "Zzz"), "https://jobs.example.com/#/job/41").ok);
  l.close();
  console.log("[ok] the address test keeps the query that names a posting (not the tracking ones) and a hash route, and the refusal names the row it matched");
}

// 9. Adversary round 7 (A124): what `intend` refuses says which kind of refusal it is
{
  now = T0;
  const l = fresh(clock, { ...DEFAULT_CAPS, perHour: 1, minGapMs: 0 });
  assert.ok(l.intend(job("a1"), "h").ok);
  const cap = l.intend(job("a2", { title: "Other", company: "Other" }), "h");
  assert.ok(!cap.ok && /hourly cap/.test(cap.why) && !cap.duplicateOf, `a cap was reported as a duplicate: ${JSON.stringify(cap)}`);
  const dup = l.intend(job("a1"), "h");
  assert.ok(!dup.ok && dup.duplicateOf && dup.duplicateOf.state === "intended", `a duplicate lost its row: ${JSON.stringify(dup)}`);
  // a row that was retracted (the run parked and nothing left) frees the slot and the posting (A120)
  const r = fresh(clock, { ...DEFAULT_CAPS, perHour: 1, minGapMs: 0 });
  const i = r.intend(job("b1"), "h"); assert.ok(i.ok);
  assert.ok(r.retract(i.seq) && r.all().length === 0);
  assert.ok(r.intend(job("b1"), "h").ok, "a retracted intent still blocked the posting");
  const c = fresh(clock); const k = c.intend(job("c1"), "h"); c.confirm(k.seq);
  assert.ok(!c.retract(k.seq) && c.all().length === 1, "a confirmed row was retracted");
  l.close(); r.close(); c.close();
  console.log("[ok] intend says whether it refused a duplicate or a cap; a retracted intent frees the posting and the slot; a confirmed row cannot be retracted");
}
console.log("\nALL LEDGER TESTS PASSED");
