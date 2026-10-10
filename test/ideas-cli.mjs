// `agent-loop ideas` (list, decide, purge) against a temp home, with ideas inserted through the Ideas class and an injected clock. Nothing is built,
// nothing is opened from the network. The ideas table is docs/REEL-FLOW.md step 9; this file is the user-facing side of it.
//   npm run build && node test/ideas-cli.mjs
import assert from "node:assert";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ideas } from "../dist/reel/ideas.js";
import { ideasCommand } from "../dist/reel/ideas-command.js";

const DAY = 86_400_000;
const home = mkdtempSync(join(tmpdir(), "ideas-cli-"));
const T0 = Date.parse("2026-10-10T12:00:00Z");
let now = T0;
const clock = () => now;

const withStore = (fn) => { const s = new Ideas(join(home, "ideas.db"), clock); try { return fn(s); } finally { s.close(); } };
const add = (source, about, verdict = "implement") => withStore((s) => s.add({ source, about, idea: "an idea", scores: "{}", verdict, reason: "reason" }));
const idOf = (source) => withStore((s) => s.get(source).id);
const run = (positional, opts = {}) => ideasCommand({ _: positional, ...opts }, { home, clock });
const ONE_LINE = (out) => { const lines = out.split("\n"); assert.equal(lines[lines.length - 1], "", "output ends with a newline"); return lines.slice(0, -1); };

const DECIDED_YES = "Recorded. Nothing has been built; the dev-flow hand-off is a later stage.\n";

// 1. an empty table, and a home directory that does not exist yet (made 0700)
{
  const nested = join(home, "fresh", "nested");
  const r = ideasCommand({ _: [] }, { home: nested, clock });
  assert.deepEqual([r.out, r.err, r.code], ["No ideas yet.\n", "", 0]);
  assert.equal(statSync(nested).mode & 0o777, 0o700, "the agent-loop directory is 0700");
  assert.equal(run(["list"]).out, "No ideas yet.\n");
}

// 2. list: one line per idea, about cut to 100 characters
const longAbout = "x".repeat(60) + " " + "y".repeat(100);
now = T0 - 1 * DAY;
add("link:a", "A demo of a git log summariser.", "implement");
add("link:b", longAbout, "ask");
{
  const r = run(["list"]);
  assert.equal(r.code, 0);
  assert.equal(r.err, "");
  assert.deepEqual(ONE_LINE(r.out), [
    "#1 [pending] implement - A demo of a git log summariser.",
    `#2 [pending] ask - ${longAbout.slice(0, 100)}`,
  ]);
}

// 3. decide yes: recorded, and the message says nothing was built
{
  const r = run(["decide", "1", "yes"]);
  assert.deepEqual([r.out, r.err, r.code], [DECIDED_YES, "", 0]);
  assert.match(ONE_LINE(run([]).out)[0], /^#1 \[yes\] implement - /);
}

// 4. decide no
{
  const r = run(["decide", "2", "no"]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "Recorded. Nothing will be built.\n");
  assert.match(ONE_LINE(run(["list"]).out)[1], /^#2 \[no\] ask - /);
}

// 5. deciding twice fails and changes nothing
{
  const r = run(["decide", "1", "no"]);
  assert.equal(r.code, 1);
  assert.equal(r.out, "");
  assert.match(r.err, /already/i);
  assert.match(ONE_LINE(run(["list"]).out)[0], /^#1 \[yes\] /);
}

// 6. bad ids and a bad word: exit 1, and a pending row stays pending
add("link:c", "A third idea.", "pass");
const cId = idOf("link:c");
// each case must fail for its own cause (the message), not only with exit 1
for (const [bad, cause] of [
  [["decide"], /whole number/],
  [["decide", "abc", "yes"], /whole number/],
  [["decide", "0", "yes"], /whole number/],
  [["decide", "-1", "yes"], /whole number/],
  [["decide", "1.5", "yes"], /whole number/],
  [["decide", `${cId}e0`, "yes"], /whole number/],
  [["decide", "9007199254740993", "yes"], /whole number/],
  [["decide", String(cId), "maybe"], /say yes or no/],
  [["decide", String(cId)], /say yes or no/],
  [["decide", String(cId), "YES"], /say yes or no/],
]) {
  const r = run(bad);
  assert.equal(r.code, 1, `exit 1 for ${JSON.stringify(bad)}`);
  assert.equal(r.out, "", `no stdout for ${JSON.stringify(bad)}`);
  assert.match(r.err, /^Error: .+\n$/, `one error line for ${JSON.stringify(bad)}`);
  assert.match(r.err, cause, `the right cause for ${JSON.stringify(bad)}`);
}
assert.match(ONE_LINE(run(["list"]).out)[2], new RegExp(`^#${cId} \\[pending\\] pass - `), "bad words leave the idea pending");

// 7. unknown id
{
  const r = run(["decide", "999", "yes"]);
  assert.equal(r.code, 1);
  assert.equal(r.err, "Error: there is no idea #999.\n", "the exact unknown-id message, not 'already decided'");
  assert.equal(r.out, "");
}

// 8. purge: strictly older than N days goes; exactly N days old and newer stay
now = T0 - 40 * DAY; add("link:old", "Forty days old.");
now = T0 - 30 * DAY; add("link:edge", "Exactly thirty days old.");
now = T0 - 1 * DAY; add("link:new", "A day old.");
now = T0;
{
  const oldId = idOf("link:old");
  const edgeId = idOf("link:edge");
  const newId = idOf("link:new");
  const r = run(["purge"], { days: "30" });
  assert.deepEqual([r.out, r.err, r.code], ["Purged 1 idea.\n", "", 0]);
  const ids = ONE_LINE(run(["list"]).out).map((l) => Number(l.match(/^#(\d+)/)[1]));
  assert.ok(!ids.includes(oldId), "the old idea is gone");
  assert.ok(ids.includes(edgeId), "exactly 30 days old is kept");
  assert.ok(ids.includes(newId), "the new idea is kept");
  // default is 30 days: nothing else is older than that
  assert.deepEqual([run(["purge"]).out, run(["purge"]).code], ["Purged 0 ideas.\n", 0]);
  // a shorter window takes the edge row too
  assert.equal(run(["purge"], { days: "29" }).out, "Purged 1 idea.\n");
  // exactly one day old is not older than one day: the rows from the list above stay
  assert.equal(run(["purge"], { days: "1" }).out, "Purged 0 ideas.\n");
  assert.ok(!ONE_LINE(run(["list"]).out).some((l) => l.includes("Exactly thirty days old.")));
}

// 9. purge with a bad --days: exit 1, nothing deleted
for (const bad of ["abc", "0", "-5", "1.5", "1e3", ""]) {
  const r = run(["purge"], { days: bad });
  assert.equal(r.code, 1, `exit 1 for --days ${JSON.stringify(bad)}`);
  assert.equal(r.out, "");
  assert.match(r.err, /positive whole number/);
}
{
  const r = run(["purge"], { days: true }); // `--days` with no value
  assert.equal(r.code, 1);
  assert.equal(ONE_LINE(run(["list"]).out).length, 4, "nothing was deleted by the bad purges (ids 1, 2, 3, 6 remain)");
}

// 9b. extra words and flags are refused, never guessed at (`ideas purge 7` must not purge 30 days)
{
  const before = ONE_LINE(run(["list"]).out);
  const cases = [
    [["list", "x"], {}, /list takes no words/],
    [["list"], { days: "abc" }, /list takes no flags/],
    [["purge", "7"], {}, /not a bare number/],
    [["purge"], { dir: "x" }, /purge takes only --days/],
    [["decide", String(cId), "yes", "extra"], {}, /exactly an id and yes or no/],
    [["decide", String(cId), "yes"], { days: "3" }, /decide takes no flags/],
  ];
  for (const [pos, opts, cause] of cases) {
    const r = run(pos, opts);
    assert.equal(r.code, 1, `exit 1 for ${JSON.stringify(pos)} ${JSON.stringify(opts)}`);
    assert.equal(r.out, "");
    assert.match(r.err, cause);
    assert.equal(ONE_LINE(r.err).length, 1);
  }
  assert.deepEqual(ONE_LINE(run(["list"]).out), before, "nothing was deleted or decided by the refused commands");
}

// 10. control bytes and newlines in stored text never make a second line, nor a control byte, on stdout
add("link:evil", "first\nsecond\r\x1b]0;owned\x07\tthird   café  end\u0085‮", "ask\nFAKE LINE");
add("link:nl", "trailing\n", "pass");
{
  const r = run(["list"]);
  const lines = ONE_LINE(r.out);
  assert.equal(lines.length, 6, "one line per idea (ids 1, 2, 3, 6, 7, 8), even with a hostile about and verdict");
  const evil = lines[4];
  // ESC, BEL and CR are dropped; the newline, tab, U+2028 and NBSP fold to spaces; non-ASCII becomes ?
  assert.equal(evil, "#7 [pending] ask FAKE LINE - first second]0;owned third caf? end?");
  // a trailing newline folds to a space and is trimmed: no trailing space on the line
  assert.equal(lines[5], "#8 [pending] pass - trailing");
  assert.doesNotMatch(r.out, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/, "no control bytes");
  assert.doesNotMatch(r.out, /[^\x20-\x7e\n]/, "printable ASCII only");
}
{
  const r = run(["decide", "1\nFAKE", "yes"]);
  assert.equal(r.code, 1);
  assert.equal(ONE_LINE(r.err).length, 1, "the error is one line");
  assert.doesNotMatch(r.err, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
}

// 11. unknown subcommand: usage on stderr, exit 1
{
  const r = run(["frobnicate"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Usage: agent-loop ideas/);
  assert.equal(r.out, "");
}

// 12. a foreign or damaged ideas.db (a table with another schema) is one printed line and exit 1, never a stack trace
{
  const home3 = mkdtempSync(join(tmpdir(), "ideas-foreign-"));
  const db = new DatabaseSync(join(home3, "ideas.db"));
  db.exec("CREATE TABLE ideas (id INTEGER PRIMARY KEY, foo TEXT)");
  db.exec("INSERT INTO ideas (foo) VALUES ('x')");
  db.close();
  for (const [pos, opts] of [[[], {}], [["list"], {}], [["decide", "1", "yes"], {}], [["purge"], {}]]) {
    const r = ideasCommand({ _: pos, ...opts }, { home: home3, clock });
    assert.equal(r.code, 1, `exit 1 for ${JSON.stringify(pos)}`);
    assert.equal(r.out, "", `no stdout for ${JSON.stringify(pos)}`);
    assert.equal(ONE_LINE(r.err).length, 1, `one line for ${JSON.stringify(pos)}`);
    assert.match(r.err, /^Error: the ideas file cannot be used: /);
    assert.doesNotMatch(r.err, /\n\s+at /);
  }
}

// 13. default purge is exactly 30 days: a row at 30 days 12 hours goes, a row at exactly 30 days stays
{
  const home4 = mkdtempSync(join(tmpdir(), "ideas-default-"));
  let t = T0 - (30 * DAY + 12 * 3_600_000);
  const c4 = () => t;
  const s4 = new Ideas(join(home4, "ideas.db"), c4);
  s4.add({ source: "link:older", about: "Thirty days and twelve hours old.", idea: "i", scores: "{}", verdict: "pass", reason: "r" });
  t = T0 - 30 * DAY;
  s4.add({ source: "link:exact", about: "Exactly thirty days old.", idea: "i", scores: "{}", verdict: "pass", reason: "r" });
  s4.close();
  const r = ideasCommand({ _: ["purge"] }, { home: home4, clock: () => T0 });
  assert.equal(r.out, "Purged 1 idea.\n", "the default window is 30 days");
  assert.equal(r.code, 0);
  const left = ideasCommand({ _: ["list"] }, { home: home4, clock: () => T0 }).out;
  assert.match(left, /Exactly thirty days old\./);
  assert.doesNotMatch(left, /Thirty days and twelve hours/);
}


// 14. Survivors from the second verifier (conductor): a decision is final in both directions, an unknown id between existing ids is "no idea", an empty subcommand is not "list", a huge or array-valued number is refused
{
  const h = mkdtempSync(join(tmpdir(), "ideas-cli-14-"));
  const st = new Ideas(join(h, "ideas.db"), clock);
  for (const n of ["k1", "k2", "k3"]) st.add({ source: n, about: "about " + n, idea: "i", scores: "{}", verdict: "ask", reason: "r" });
  const ids = st.list().map((r) => r.id);
  st.close();
  const cmd = (positional, opts = {}) => ideasCommand({ _: positional, ...opts }, { home: h, clock });
  assert.equal(cmd(["decide", String(ids[0]), "no"]).code, 0);
  const flip = cmd(["decide", String(ids[0]), "yes"]);
  assert.ok(flip.code === 1 && /already decided \(no\)/.test(flip.err), `a no was overwritten with a yes: ${JSON.stringify(flip)}`);
  assert.match(cmd(["list"]).out, new RegExp(`#${ids[0]} \\[no\\]`));
  // a gap between ids: remove the middle one's row by purging nothing, then ask for an id that is not there but is smaller than a later one
  const gone = ids[1] + 1000;
  assert.ok(cmd(["decide", String(ids[0] - 1 || 999), "yes"]).err.match(/no idea #/), "an unknown id was not reported as unknown");
  const between = new DatabaseSync(join(h, "ideas.db")); between.prepare("DELETE FROM ideas WHERE id = ?").run(ids[1]); between.close();
  const miss = cmd(["decide", String(ids[1]), "yes"]);
  assert.ok(miss.code === 1 && new RegExp(`no idea #${ids[1]}`).test(miss.err), `an id between two others: ${JSON.stringify(miss)}`);
  void gone;
  // the empty subcommand is not "list"; numbers must be numbers
  assert.equal(cmd([""]).code, 1);
  for (const bad of ["9007199254740993", ["7"], "1e3", "0x10"]) { const r = cmd(["purge"], { days: bad }); assert.ok(r.code === 1 && /whole number/.test(r.err), `--days ${JSON.stringify(bad)}: ${JSON.stringify(r)}`); }
  for (const bad of [["3"], "9007199254740993"]) { const r = cmd(["decide", bad, "yes"]); assert.equal(r.code, 1, `id ${JSON.stringify(bad)}: ${JSON.stringify(r)}`); }
}

console.log("ideas-cli: all checks passed");
