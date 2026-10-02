// `agent-loop insights` talking about the person: src/roast.ts (the lines), Store.getHabits() (the numbers), the CLI
// wiring, and the optional model mode with a fake SDK. No network, no API cost.
//   npm run build && npm run test:roast
import { fileURLToPath } from "node:url";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../dist/store.js";
import {
  FINDINGS, PLACEHOLDERS, acceptModelLines, allowedNumbersFor, buildRoastPrompt, emptyHabits, fillRoast, gradeFor, lintLine, lintRoastCatalogue, roast, roastWithModel, varsFor,
} from "../dist/roast.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const H = (over = {}) => ({ ...emptyHabits(), runs: 4, done: 3, failed: 1, ...over });
const ok = (m) => console.log(`[ok] ${m}`);

// ---------------------------------------------------------------------------------------------- the catalogue itself
assert.deepStrictEqual(lintRoastCatalogue(), [], "the built-in catalogue has lint problems");
assert.ok(FINDINGS.length >= 15, "the catalogue should say something about many different habits");
assert.ok(PLACEHOLDERS.length >= 15);
ok(`the built-in catalogue (${FINDINGS.length} findings, ${FINDINGS.reduce((n, f) => n + f.lines.length, 0)} lines) passes the same lint as the persona: no banned term, no stray brace, numbers only from data`);

// One set of habits that makes each finding fire.
const FIRES = {
  "quick-yes": H({ approvals: { asked: 10, approved: 10, denied: 0, auto: 0 }, quickYes: 8 }),
  flip: H({ deniedThenAllowed: 2 }),
  wasted: H({ wastedUsd: 3.5 }),
  failing: H({ runs: 4, done: 1, failed: 3 }),
  "worst-phase": H({ repairedRunsByPhase: { builder: 2 } }),
  "never-denies": H({ approvals: { asked: 20, approved: 20, denied: 0, auto: 0 } }),
  "repeat-task": H({ repeatedTaskMax: 3 }),
  "unused-rules": H({ rulesNeverReused: 3 }),
  desktop: H({ desktop: { sent: 6, stopped: 2, approved: 6, denied: 1 } }),
  night: H({ nightRuns: 2 }),
  "many-denials": H({ approvals: { asked: 9, approved: 2, denied: 7, auto: 0 } }),
  stopped: H({ stopped: 2 }),
  abandoned: H({ abandoned: 3 }),
  repairs: H({ repairedRunsByPhase: { builder: 3, verifier: 2 } }),
  "long-run": H({ longestRunMin: 125 }),
  clean: H({ runs: 3, done: 3, failed: 0 }),
  slow: H({ slowestAnswerMin: 12 }),
  "small-sample": H({ runs: 2, done: 2, failed: 0 }),
};
assert.deepStrictEqual(Object.keys(FIRES).sort(), FINDINGS.map((f) => f.id).sort(), "every finding needs a habit that fires it in this test");
const extraNumbers = ["0", "1.5", "5", "500"];
for (const f of FINDINGS) {
  const h = FIRES[f.id];
  assert.ok(f.when(h), `${f.id} does not fire on its own habits`);
  for (const level of ["dry", "dark"]) {
    const r = roast(h, level, 99);
    assert.ok(r.findings.includes(f.id), `${f.id} was not said at level ${level}: ${r.findings}`);
    const allowed = new Set([...allowedNumbersFor(h), ...extraNumbers]);
    for (const text of [...r.lines, ...r.tips, r.gradeComment]) {
      assert.deepStrictEqual(lintLine(text, allowed), [], `${f.id}/${level}: "${text}"`);
      assert.ok(!/\{|\}/.test(text), `an unfilled placeholder: ${text}`);
    }
  }
}
ok("each of the findings fires on its own habits, at dry and dark, and every filled line passes the lint with only numbers from the data");

// ---------------------------------------------------------------------------------------------- behaviour
assert.deepStrictEqual(roast(FIRES.flip, "off").lines, [], "humor off says nothing");
assert.deepStrictEqual(roast(H({ runs: 0 }), "dark").lines, [], "nothing to say about no runs");
const darkTemplates = FINDINGS.flatMap((f) => f.lines.filter((l) => l.dark).map((l) => l.text));
for (const [id, h] of Object.entries(FIRES)) {
  const r = roast(h, "dry", 99);
  const said = r.lines[r.findings.indexOf(id)];
  const filledDark = darkTemplates.map((t) => fillRoast(t, varsFor(h)));
  assert.ok(said && !filledDark.includes(said), `a dark line reached dry for ${id}: ${said}`);
  assert.ok(FINDINGS.find((x) => x.id === id).lines.some((l) => !l.dark && fillRoast(l.text, varsFor(h)) === said), `${id}: the dry line is not one of its dry templates`);
}
ok("dry never says a dark line, off says nothing, no runs says nothing");

// Same numbers, same roast; different numbers can change the wording; the most pointed finding comes first.
const a = roast(FIRES["quick-yes"], "dark"), b = roast(FIRES["quick-yes"], "dark");
assert.deepStrictEqual(a, b, "same numbers must give the same roast");
const variety = new Set();
for (let n = 8; n < 60; n++) variety.add(roast(H({ approvals: { asked: n + 5, approved: n + 5, denied: 0, auto: 0 }, quickYes: n }), "dark", 1).lines[0].replace(/\d+/g, "#"));
assert.ok(variety.size >= 2, `the wording never varies: ${[...variety]}`);
const many = roast(H({ ...FIRES["quick-yes"], deniedThenAllowed: 3, wastedUsd: 4, failed: 5, done: 1, runs: 6 }), "dark", 99);
assert.deepStrictEqual(many.findings.slice(0, 3), ["quick-yes", "flip", "wasted"], "findings are said in weight order");
assert.strictEqual(roast(H({ ...FIRES["quick-yes"], deniedThenAllowed: 3, wastedUsd: 4, failed: 5, done: 1, runs: 6 }), "dark").lines.length, 3, "at most three lines by default");
assert.ok(many.tips.length <= 2);
ok("same numbers give the same roast; the wording varies with the numbers; the sharpest finding is said first; at most three lines and two tips");

// Grades: they follow the habits, never decorate them.
assert.strictEqual(gradeFor(H({ runs: 0 })), "n/a");
assert.strictEqual(gradeFor(H({ runs: 10, done: 10, failed: 0 })), "A");
const bad = gradeFor(H({ runs: 10, done: 2, failed: 8, approvals: { asked: 20, approved: 20, denied: 0, auto: 0 }, quickYes: 20, deniedThenAllowed: 5, stopped: 6, rulesNeverReused: 6, repairedRunsByPhase: { builder: 9, verifier: 9 } }));
assert.ok(["D", "F"].includes(bad), `the worst habits only got ${bad}`);
const order = ["F", "D", "C-", "C", "C+", "B-", "B", "B+", "A-", "A"];
let last = -1;
for (const failed of [10, 8, 6, 4, 2, 1, 0]) {
  const g = order.indexOf(gradeFor(H({ runs: 10, done: 10 - failed, failed })));
  assert.ok(g >= last, `more failures must not raise the grade (failed=${failed} gave ${order[g]})`);
  last = g;
}
assert.ok(order.indexOf(gradeFor(H({ runs: 10, done: 0, failed: 10 }))) < order.indexOf(gradeFor(H({ runs: 10, done: 10, failed: 0 }))), "ten failures out of ten must grade strictly worse than none");
// outcomes decide the grade: a clean record with trivia against it stays in the A range; stopping runs is not punished; killing them is, a little
const clean6 = H({ runs: 6, done: 6, failed: 0, deniedThenAllowed: 1, rulesNeverReused: 11, repairedRunsByPhase: { builder: 1 } });
assert.ok(["A", "A-"].includes(gradeFor(clean6)), `six successes, one flip, eleven unused rules and one repair should still be an A-range grade, got ${gradeFor(clean6)}`);
assert.strictEqual(gradeFor(H({ runs: 10, done: 5, failed: 0, stopped: 5 })), gradeFor(H({ runs: 10, done: 10, failed: 0, stopped: 0 })), "stopping runs does not lower the grade");
assert.ok(order.indexOf(gradeFor(H({ runs: 10, done: 6, failed: 0, abandoned: 4 }))) < order.indexOf(gradeFor(H({ runs: 10, done: 10, failed: 0 }))), "runs killed without saying goodbye lower it a little");
assert.ok(order.indexOf(gradeFor(H({ runs: 10, done: 2, failed: 8 }))) < order.indexOf(gradeFor(clean6)), "and failures lower it far more than any of that trivia");
// the same point is not made twice
const both = roast(H({ approvals: { asked: 30, approved: 30, denied: 0, auto: 0 }, quickYes: 25 }), "dark", 99);
assert.ok(both.findings.includes("quick-yes") && !both.findings.includes("never-denies"), `quick yeses and "never says no" are one point: ${both.findings}`);
assert.ok(roast(FIRES["never-denies"], "dark", 99).findings.includes("never-denies"), "…and 'never says no' still speaks when it is the only point");
ok(`the grade follows the habits and never rises with more failures (best A, worst of the worst ${bad})`);

// ---------------------------------------------------------------------------------------------- getHabits on a crafted database
const dataDir = mkdtempSync(join(tmpdir(), "agent-loop-roast-"));
const dbPath = join(dataDir, "agent-loop.db");
const store = new Store(dbPath);
const raw = new DatabaseSync(dbPath);
const T0 = Date.parse("2026-03-10T12:00:00Z");
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const ev = (runId, phase, type, payload, ts) => raw.prepare("INSERT INTO events (run_id, phase, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)").run(runId, phase, ts, type, typeof payload === "string" ? payload : JSON.stringify(payload));
const setRun = (id, over) => { for (const [k, v] of Object.entries(over)) raw.prepare(`UPDATE runs SET ${k} = ? WHERE id = ?`).run(v, id); };
const CAN = "ZZCANARY";

const rA = store.createRun(`  Fix the ${CAN}-login   page `, "/w");
const rB = store.createRun(`fix the ${CAN}-LOGIN page`, "/w");
const rC = store.createRun(`fix the ${CAN}-login page\n`, "/w");
const rD = store.createRun("something else entirely", "/w");
setRun(rA.id, { status: "done", created_at: new Date(2026, 2, 3, 2, 30).toISOString() });   // 02:30 local: a night run
setRun(rB.id, { status: "failed", created_at: new Date(2026, 2, 3, 12, 0).toISOString() });
setRun(rC.id, { status: "stopped", created_at: new Date(2026, 2, 4, 13, 0).toISOString() });
setRun(rD.id, { status: "done", created_at: new Date(2026, 2, 5, 4, 59).toISOString() });  // 04:59: still night
// the 5:00 boundary
const rE = store.createRun("boundary", "/w");
setRun(rE.id, { status: "done", created_at: new Date(2026, 2, 5, 5, 0).toISOString() });

ev(rA.id, "builder", "usage", { costUsd: 0.5 }, at(1));
ev(rB.id, "builder", "usage", { costUsd: 2.0 }, at(2));
ev(rB.id, "verifier", "usage", { costUsd: 1.5 }, at(3));
ev(rC.id, "builder", "usage", { costUsd: 0.25 }, at(4));
ev(rD.id, "builder", "usage", { costUsd: "not a number" }, at(4));
ev(rD.id, "builder", "usage", { costUsd: -5 }, at(4));
const p1 = store.startPhase(rB.id, "builder", 1); store.startPhase(rB.id, "builder", 2); store.startPhase(rB.id, "verifier", 1);
raw.prepare("INSERT INTO phases (id, run_id, name, attempt, status, started_at) VALUES (?, ?, ?, ?, 'ok', ?)").run("hostile-1", rB.id, `${CAN}-phase`, 5, at(0));
void p1;

ev(rB.id, null, "run-start", { type: "run-start" }, at(0));
ev(rB.id, null, "run-end", { type: "run-end" }, at(90 * 60));
// approvals in run B
const req = (id, input, sec, tool = "Bash") => ev(rB.id, "builder", "approval-request", { requestId: id, toolName: tool, toolInput: input }, at(sec));
const res = (id, decision, sec, extra = {}) => ev(rB.id, "builder", "approval-resolved", { requestId: id, decision, auto: false, reason: `${CAN}-reason`, ...extra }, at(sec));
req("q1", { command: `echo ${CAN}` }, 100); res("q1", "deny", 103);
req("q2", { command: `echo ${CAN}` }, 110); res("q2", "allow", 110.5);                        // the same call, denied then allowed; quick
req("q3", { command: "ls" }, 200); res("q3", "allow", 500);                                  // five minutes
req("q4", { command: "npm test" }, 600); res("q4", "allow", 600.1, { rememberedRule: `Bash(${CAN}:*)` });   // quick; rule never reused
req("q5", { command: "npm run build" }, 700); res("q5", "allow", 702, { rememberedRule: "Bash(npm run build:*)" });
ev(rB.id, "builder", "approval-auto-allowed", { toolName: "Bash", rule: "Bash(npm run build:*)" }, at(800));
ev(rB.id, "builder", "approval-request", { requestId: "q6", toolName: "Bash", toolInput: { command: `echo ${CAN}` } }, at(900));
ev(rB.id, "builder", "approval-resolved", { requestId: "q6", decision: "allow", auto: false }, at(930));   // a second allow of the same call: still one flip
// desktop
ev(rB.id, "builder", "desktop-action-completed", { toolName: "click", isError: false }, at(1000));
ev(rB.id, "builder", "desktop-action-completed", { toolName: "click", isError: false }, at(1001));
ev(rB.id, "builder", "desktop-action-completed", { toolName: "key", isError: true }, at(1002));
ev(rB.id, "builder", "approval-request", { requestId: "d1", toolName: "mcp__desktop__click", toolInput: {} }, at(1003));
ev(rB.id, "builder", "approval-resolved", { requestId: "d1", decision: "allow", auto: false }, at(1010));
// a row that is not JSON and one that is JSON but the wrong shape: must be skipped, not fatal
ev(rB.id, "builder", "approval-request", "this is {not json", at(1100));
ev(rB.id, "builder", "approval-resolved", "[1,2,3]", at(1101));
ev(rB.id, "builder", "usage", "null", at(1102));

const h = store.getHabits();
assert.strictEqual(h.runs, 5);
assert.deepStrictEqual([h.done, h.failed, h.stopped], [3, 1, 1]);
assert.strictEqual(h.nightRuns, 2, "02:30 and 04:59 are night, 05:00 is not");
assert.strictEqual(h.repeatedTaskMax, 3, "the same task up to case and whitespace");
assert.ok(Math.abs(h.totalCostUsd - 4.25) < 1e-9, `total ${h.totalCostUsd}: a non-number and a negative cost count as zero`);
assert.ok(Math.abs(h.wastedUsd - 3.75) < 1e-9, `wasted ${h.wastedUsd}: the failed and the stopped run, not the done ones`);
assert.ok(Math.abs(h.priciestRunUsd - 3.5) < 1e-9);
assert.strictEqual(h.approvals.asked, 7, "q1-q6 and the desktop one; the row that is not JSON is not a request");
assert.strictEqual(h.approvals.approved, 6);
assert.strictEqual(h.approvals.denied, 1);
assert.strictEqual(h.approvals.auto, 1);
assert.strictEqual(h.quickYes, 2 + 0, "the two answers under 1.5 s (q2 and q4); q5 took 2 s");
assert.strictEqual(h.deniedThenAllowed, 1, "one distinct call that was denied and then allowed, however often it was allowed afterwards");
assert.ok(Math.abs(h.slowestAnswerMin - 5) < 0.01, `slowest ${h.slowestAnswerMin}`);
assert.strictEqual(h.rulesCreated, 2);
assert.strictEqual(h.rulesNeverReused, 1);
assert.deepStrictEqual(h.repairedRunsByPhase, { builder: 1 }, "only real phase names, only phases that needed a second attempt");
assert.ok(Math.abs(h.longestRunMin - 90) < 0.01);
assert.deepStrictEqual(h.desktop, { sent: 2, stopped: 1, approved: 1, denied: 0 });
ok("getHabits counts statuses, night runs (5:00 is not night), repeated tasks, money in failed runs, quick yeses, the same call denied then allowed once, rules never reused, repairs, run length and desktop use; bad rows are skipped");

// ---------------------------------------------------------------------------------------------- runs that never finished, and a long list of rules
{
  const d = mkdtempSync(join(tmpdir(), "agent-loop-roast-ghost-"));
  const st = new Store(join(d, "agent-loop.db"));
  const rawDb = new DatabaseSync(join(d, "agent-loop.db"));
  const HOUR = 3_600_000;
  const mk = (task, status, hoursAgo) => { const r = st.createRun(task, "/w"); rawDb.prepare("UPDATE runs SET status = ?, created_at = ? WHERE id = ?").run(status, new Date(Date.now() - hoursAgo * HOUR).toISOString(), r.id); return r; };
  mk("a", "running", 48); mk("b", "running", 13); mk("c", "running", 11.9); mk("d", "running", 0.01); mk("e", "done", 100); mk("f", "failed", 100);
  const g = st.getHabits();
  assert.strictEqual(g.runs, 6);
  assert.strictEqual(g.abandoned, 2, "still 'running' after more than 12 h counts (48 h, 13 h); 11.9 h and a run that began a moment ago may still be alive and do not; a finished run never does");
  const rr = roast(g, "dark", 99);
  assert.ok(rr.findings.includes("abandoned") && /Ctrl-C/.test(rr.tips.join(" ")), "…with a tip that names the way to stop a run properly");
  for (let i = 0; i < 15; i++) rawDb.prepare("INSERT INTO events (run_id, phase, ts, type, payload_json) VALUES ('x', 'builder', ?, 'approval-resolved', ?)").run(new Date().toISOString(), JSON.stringify({ requestId: "r" + i, decision: "allow", rememberedRule: `Bash(rule${i}:*)` }));
  st.close(); rawDb.close();
  const out = spawnSync(process.execPath, ["--experimental-sqlite", "--no-warnings", "dist/cli.js", "insights", "--data-dir", d], { encoding: "utf8", cwd: ROOT }).stdout;
  assert.ok(/running=4\b/.test(out) && /running=4: still going, or the process was closed or force-quit/.test(out), `the numbers say what 'running' may mean:\n${out}`);
  const listed = (out.match(/^  Bash\(rule\d+:\*\)$/gm) || []).length;
  assert.strictEqual(listed, 10, `a long list of rules is cut at 10 (${listed})`);
  assert.ok(/…and 5 more/.test(out), out);
  ok("runs still 'running' after 12 h are counted as abandoned (11.9 h and brand-new ones are not), the roast names Ctrl-C, `insights` explains what 'running' may mean, and a 15-rule list is cut at 10 with a count");
}

// ---------------------------------------------------------------------------------------------- nothing a person typed gets out
const blob = JSON.stringify(h);
assert.ok(!blob.includes(CAN), `a typed string reached the habits: ${blob}`);
const rr = roast(h, "dark", 99);
const prompt = buildRoastPrompt(h, "dark", rr);
for (const text of [JSON.stringify(rr), prompt.system, prompt.prompt]) assert.ok(!text.includes(CAN), "a typed string reached the roast or the model's prompt");
assert.ok(prompt.prompt.includes(blob), "the prompt carries the habits as numbers");
assert.ok(!/[a-z]{4,}/i.test(blob.replace(/"[A-Za-z]+":/g, "").replace(/builder|verifier|planner|gatekeeper|test-designer/g, "")), `the habits contain words that are not field names: ${blob}`);
// A hostile phase row is ignored entirely (and so cannot ride into the prompt as a key).
assert.ok(!Object.keys(h.repairedRunsByPhase).some((k) => k.includes(CAN)));
ok("a canary in a task, a command, a rule, a reason and a phase name never reaches the habits, the lines, the tips or the model prompt");

// ---------------------------------------------------------------------------------------------- the model mode, with a fake generator
const sample = H({ ...FIRES["quick-yes"], deniedThenAllowed: 2, wastedUsd: 3.5 });
const base = roast(sample, "dark");
const good = [
  "Eight approvals under a blink. It has a little lock, bestie, read it.",
  "Denied it twice, then said yes. The 'are you sure?' energy won, apparently.",
  "$3.50 on runs that did not finish. Tuition, but billed per token.",
  "Four runs and a grade. We move.",
];
const call = (text, over = {}) => { const seen = []; const gen = async (req) => { seen.push(req); if (over.throws) throw new Error("boom\nwith newline"); if (over.hang) return new Promise(() => {}); return { text, costUsd: over.cost ?? 0.0012 }; }; return { gen, seen }; };

{
  const { gen, seen } = call(JSON.stringify(good));
  const r = await roastWithModel(sample, "dark", gen);
  assert.deepStrictEqual(r.lines, good, "good lines are accepted as they are");
  assert.strictEqual(r.costUsd, 0.0012);
  assert.strictEqual(seen.length, 1);
  assert.ok(/ONLY a JSON array/.test(seen[0].system) && /never the person/i.test(seen[0].system));
}
{
  // prose around the JSON, a code fence, extra whitespace: still fine
  const { gen } = call("Sure! Here you go:\n```json\n" + JSON.stringify(good.slice(0, 2)) + "\n```\nHope that helps");
  assert.strictEqual((await roastWithModel(sample, "dark", gen)).lines.length, 2);
}
const rejects = {
  "a number that is not in the data": "That is 999 approvals under a blink, which is a lot of reflex.",
  "a link": "Read this, bestie: https://example.com/approve before you click.",
  "a markdown link": "You approved [everything](https://x.y) in a blink, wow.",
  "code": "You approved `rm -rf` in a blink, wow, truly.",
  "html": "You approved <b>everything</b> in a blink, wow, truly.",
  "a banned word": "Only a stupid person approves eight things in a blink.",
  "a banned word, other case": "Eight approvals in a blink is peak IDIOT behaviour, truly.",
  "a control character": "Eight approvals in a blink.\u001b[2J It has a lock, bestie.",
  "a right-to-left override": "Eight approvals in a blink.‮ It has a lock, bestie.",
  "a zero-width character": "Eight approvals in a b​link. It has a lock, bestie.",
  "too long": "Eight approvals in a blink. ".repeat(10),
  "too short": "lol ok",
};
const ALLOWED = allowedNumbersFor(sample);
for (const [why, text] of Object.entries(rejects)) {
  assert.deepStrictEqual(acceptModelLines(JSON.stringify([text, good[0], good[1]]), sample), [good[0], good[1]], `a line with ${why} should be dropped and the others kept`);
  assert.notDeepStrictEqual(lintLine(text, ALLOWED), [], `${why} should fail the lint`);
}
// the same numbers formatted the ways a line might write them are fine
for (const text of ["$3.50 went on runs that did not finish, which is a lot.", "Eight yeses and 2 flips.", "That is 3.5 dollars of vibes, bestie."]) assert.deepStrictEqual(lintLine(text, ALLOWED), [], text);
assert.deepStrictEqual(acceptModelLines(JSON.stringify([good[0], good[0], base.lines[0], 7, null, { a: 1 }]), sample, base.lines), [good[0]], "duplicates, the offline lines and non-strings are dropped");
for (const junk of ["", "no json here", "[", "[not json]", "{\"a\":1}", "[[\"nested\"]]", "null", "[".repeat(5000)]) assert.deepStrictEqual(acceptModelLines(junk, sample), [], `junk: ${junk.slice(0, 20)}`);
ok("a model's lines are accepted only if well-formed and safe: a made-up number, link, markdown, code, banned word, control/bidi/zero-width character, wrong length, duplicate or non-string is dropped");

for (const [name, text] of [["only one valid line", JSON.stringify([good[0], rejects["a link"]])], ["no valid lines", JSON.stringify(Object.values(rejects))], ["not JSON", "I cannot help with that."]]) {
  const r = await roastWithModel(sample, "dark", call(text).gen);
  assert.deepStrictEqual(r.lines, [], name);
  assert.ok(/built-in set/.test(r.note), `${name}: ${r.note}`);
}
{
  const r = await roastWithModel(sample, "dark", call("", { throws: true }).gen);
  assert.deepStrictEqual(r.lines, []);
  assert.ok(/could not reach the model \(boom with newline\)/.test(r.note), r.note);
  const t0 = Date.now();
  const slow = await roastWithModel(sample, "dark", call("", { hang: true }).gen, 80);
  assert.ok(Date.now() - t0 < 2000 && /no answer within/.test(slow.note), slow.note);
  const { gen, seen } = call(JSON.stringify(good));
  assert.deepStrictEqual((await roastWithModel(sample, "off", gen)).lines, []);
  assert.deepStrictEqual((await roastWithModel(H({ runs: 0 }), "dark", gen)).lines, []);
  assert.strictEqual(seen.length, 0, "no model call when there is nothing to say or humor is off");
}
ok("a model that fails, hangs, returns prose or returns too few safe lines falls back with a plain note, and nothing is called when there is nothing to say");

// ---------------------------------------------------------------------------------------------- the CLI
const run = (args, env = {}, extraNode = []) => spawnSync(process.execPath, ["--experimental-sqlite", "--no-warnings", ...extraNode, "dist/cli.js", "insights", "--data-dir", dataDir, ...args], {
  encoding: "utf8", cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
});
const FAKE = ["--import", "./test/stress/fake-sdk/register.mjs"];
const noControl = (s) => assert.ok(!/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.test(s), `a control byte in the output: ${JSON.stringify(s)}`);

const plain = run([]);
assert.strictEqual(plain.status, 0, plain.stderr);
assert.ok(/Runs recorded: 5/.test(plain.stdout) && !/How it has actually been going|Report card/.test(plain.stdout), "off a TTY and not asked for, the numbers stay plain");
const off = run(["--humor", "dark", "--roast", "off"]);
assert.ok(!/How it has actually been going|Report card/.test(off.stdout));
const humorOff = run(["--humor", "off", "--roast", "api"], { FAKE_LOG: join(dataDir, "calls-humor-off.log") }, FAKE);
assert.ok(!/How it has actually been going|Report card|written fresh/.test(humorOff.stdout) && !existsSync(join(dataDir, "calls-humor-off.log")), "--humor off beats --roast api and calls nothing");
const offline = run(["--roast", "offline"]);
assert.strictEqual(offline.status, 0, offline.stderr);
assert.ok(/How it has actually been going/.test(offline.stdout) && /Report card: [A-F][+-]?/.test(offline.stdout), offline.stdout);
assert.ok(/ ◦ /.test(offline.stdout) || /    ◦ /.test(offline.stdout));
assert.strictEqual(run(["--roast", "offline"]).stdout, offline.stdout, "same database, same output");
assert.ok(/^    → /m.test(offline.stdout), "a tip is printed next to the lines that have one");
noControl(offline.stdout);
// the report above lists the stored rules by design (it is your own data); the voice below it must not
assert.ok(!offline.stdout.split("How it has actually been going")[1].includes(CAN), "a typed string reached `insights`' roast");
const humorEnv = run([], { AGENT_LOOP_ROAST: "offline" });
assert.ok(/Report card/.test(humorEnv.stdout), "$AGENT_LOOP_ROAST works like the flag");
const bogus = run(["--roast", "bogus"]);
assert.strictEqual(bogus.status, 1);
assert.ok(/--roast must be off, offline or api, got "bogus"/.test(bogus.stderr), bogus.stderr);
assert.strictEqual(run(["--roast"]).status, 1, "--roast with no value is an error, not a silent default");
const dry = run(["--humor", "dry", "--roast", "offline"]);
assert.ok(/How it has actually been going/.test(dry.stdout));
for (const t of darkTemplates) assert.ok(!dry.stdout.includes(fillRoast(t, varsFor(h))), `--humor dry printed a dark line: ${t}`);
ok("insights stays plain off a TTY, speaks when asked (--roast, $AGENT_LOOP_ROAST), is deterministic, is off with --humor off even for --roast api, rejects a bad value, and leaks nothing typed");

// api mode through the fake SDK
const goodForDb = [
  "Two quick yeses under a blink and a rule nobody used again. Bestie, read the prompt.",
  "That is 3.75 dollars of failed runs. Tuition, billed per token.",
  "Four tasks, three about the same thing. Groundhog Day with a receipt.",
];
const logPath = join(dataDir, "calls.log");
{
  const r = run(["--roast", "api"], { FAKE_LOG: logPath, FAKE_ROAST_TEXT: JSON.stringify(goodForDb), SECRET_TEST_TOKEN: `${CAN}-env`, ANTHROPIC_API_KEY: "sk-test" }, FAKE);
  assert.strictEqual(r.status, 0, r.stderr);
  for (const l of goodForDb) assert.ok(r.stdout.includes(l), `a fresh line is missing: ${l}\n${r.stdout}`);
  assert.ok(/written fresh by claude-haiku-4-5-20251001 from the numbers above and nothing else, \$0\.0012/.test(r.stdout), r.stdout);
  assert.ok(/Report card: [A-F]/.test(r.stdout), "the grade is still there");
  const calls = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.roast);
  assert.strictEqual(calls.length, 1, "exactly one model call");
  const c = calls[0];
  assert.deepStrictEqual(c.tools, [], "the model is given no tools at all");
  assert.strictEqual(c.maxTurns, 1);
  assert.strictEqual(c.model, "claude-haiku-4-5-20251001");
  assert.ok(!c.envKeys.includes("SECRET_TEST_TOKEN") && c.envKeys.includes("ANTHROPIC_API_KEY"), `the model's environment must be the allowlist: ${c.envKeys}`);
  assert.ok(!c.prompt.includes(CAN) && !c.system.includes(CAN), "nothing typed reached the model");
  assert.ok(c.prompt.includes('"quickYes":2') && c.prompt.includes('"nightRuns":2'), "the prompt carries the numbers");
  noControl(r.stdout);
}
{
  const r = run(["--roast", "api"], { FAKE_LOG: logPath, FAKE_ROAST_TEXT: JSON.stringify(goodForDb), AGENT_LOOP_ROAST_MODEL: "claude-sonnet-5-5" }, FAKE);
  assert.ok(/written fresh by claude-sonnet-5-5/.test(r.stdout), "$AGENT_LOOP_ROAST_MODEL picks the model");
}
for (const [name, env, expect] of [
  ["the model call fails", { FAKE_ROAST_THROWS: "1" }, /could not reach the model/],
  ["the model returns prose", { FAKE_ROAST_TEXT: "I'd rather not." }, /did not pass the checks/],
  ["the model makes up a number", { FAKE_ROAST_TEXT: JSON.stringify(["You approved 4000 things in a blink, wow.", "That cost 9999 dollars, bestie, truly."]) }, /did not pass the checks/],
]) {
  const r = run(["--roast", "api"], env, FAKE);
  assert.strictEqual(r.status, 0, `${name}: ${r.stderr}`);
  assert.ok(expect.test(r.stdout), `${name}: ${r.stdout}`);
  assert.ok(/How it has actually been going/.test(r.stdout) && /Report card/.test(r.stdout), `${name}: the built-in lines still print`);
  assert.ok(!/written fresh/.test(r.stdout), name);
}
ok("--roast api: one tool-less turn, haiku by default, the allowlisted environment, numbers only in the prompt; a model that fails, rambles or invents a number leaves the built-in lines and says why");

// ---------------------------------------------------------------------------------------------- an empty database and a one-run database
{
  const empty = mkdtempSync(join(tmpdir(), "agent-loop-roast-empty-"));
  new Store(join(empty, "agent-loop.db")).close();
  const r = spawnSync(process.execPath, ["--experimental-sqlite", "--no-warnings", "dist/cli.js", "insights", "--data-dir", empty, "--roast", "offline"], { encoding: "utf8", cwd: ROOT });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/No runs recorded/.test(r.stdout) && !/Report card/.test(r.stdout), r.stdout);
  const one = mkdtempSync(join(tmpdir(), "agent-loop-roast-one-"));
  const s = new Store(join(one, "agent-loop.db")); const only = s.createRun("one", "/w"); s.finishRun(only.id, "done"); s.close();
  const r1 = spawnSync(process.execPath, ["--experimental-sqlite", "--no-warnings", "dist/cli.js", "insights", "--data-dir", one, "--roast", "offline"], { encoding: "utf8", cwd: ROOT });
  assert.ok(/(Only 1 run so far|1 run so far is not a pattern)/.test(r1.stdout) && /Report card: A/.test(r1.stdout), r1.stdout);
}
ok("an empty data dir says there is nothing to talk about; one run gets 'small sample' and an honest grade");

store.close(); raw.close();
console.log("\nALL ROAST TESTS PASSED");
