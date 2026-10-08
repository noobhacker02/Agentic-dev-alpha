// `agent-loop apply` as a person runs it (docs/HYBRID-AGENT-SPEC.md S5): a real process, the user's files in an agent-loop directory (facts.json, uploads.json), the ledger in ledger.db, a local board on the far side.
// What is checked is what the person sees (the text and the exit code) and what the board counted. Every refusal has a control that is submitted.
//   npm run build && npm run test:apply-cli
import assert from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startBoard, RESUME_MARK } from "./fixtures/job-board.mjs";
import { Ledger, DEFAULT_CAPS } from "../dist/ledger.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist/cli.js");
const home = mkdtempSync(join(tmpdir(), "apply-cli-home-"));
chmodSync(home, 0o700);
const resumePath = join(mkdtempSync(join(tmpdir(), "apply-cli-docs-")), "resume.pdf");
writeFileSync(resumePath, `%PDF-1.4 ${RESUME_MARK} a résumé`);
const put = (name, obj) => { writeFileSync(join(home, name), JSON.stringify(obj), { mode: 0o600 }); };
put("uploads.json", { files: { resume: resumePath } });
put("facts.json", { facts: { full_name: "Ada Lovelace", email: "ada@example.com", work_authorisation: "Yes", needs_sponsorship: "No", years_experience: "7" } });
put("caps.json", { minGapSeconds: 0 });
const board = await startBoard();

const apply = (id, extra = [], chaos = "") => new Promise((resolve) => {
  const j = board.jobs.find((x) => x.id === id);
  const p = spawn(process.execPath, ["--experimental-sqlite", "--no-warnings", cli, "apply", `${board.url}/jobs/${id}/apply${chaos ? `?chaos=${chaos}` : ""}`, "--test", "--site", "board", "--company", j.company, "--title", j.title, "--job-id", id, ...extra], { cwd: root, env: { ...process.env, AGENT_LOOP_HOME: home } });
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  const t = setTimeout(() => p.kill("SIGKILL"), 120000);
  p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
});
const raw = (args, env = {}) => new Promise((resolve) => { const p = spawn(process.execPath, ["--experimental-sqlite", "--no-warnings", cli, "apply", ...args], { cwd: root, env: { ...process.env, AGENT_LOOP_HOME: home, ...env } }); let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d)); p.on("close", (code) => resolve({ code, out, err })); });
const count = (id) => (board.applications[id] ?? []).length;

// 1. The arguments
{
  const r = await new Promise((res) => { const p = spawn(process.execPath, ["--no-warnings", cli, "apply"], { cwd: root, env: { ...process.env, AGENT_LOOP_HOME: home } }); let e = ""; p.stderr.on("data", (d) => (e += d)); p.on("close", (c) => res({ code: c, err: e })); });
  assert.ok(r.code === 1 && /needs the application page and what it is for/.test(r.err), JSON.stringify(r));
  console.log("[ok] without the page and what it is for, apply says what it needs and exits 1");
}

// 2. One application, and once only
{
  const r = await apply("1");
  assert.ok(r.code === 0 && /Applied: Acme, Platform Engineer \(ledger #1, confirmed by the site\)/.test(r.out), JSON.stringify(r));
  assert.strictEqual(count("1"), 1);
  assert.ok(board.applications["1"][0].resume && board.applications["1"][0].email === "ada@example.com");
  // run again, from a new process: the ledger on disk refuses it and the site is not touched
  const before = board.requests.length;
  const again = await apply("1");
  assert.ok(again.code === 0 && /Not applied: .*already applied to this posting/.test(again.out), JSON.stringify(again));
  assert.strictEqual(count("1"), 1);
  assert.strictEqual(board.requests.length, before, "the second process touched the site");
  console.log("[ok] a first run applies (exit 0, the board counts one, with the résumé); a second process is refused from the ledger on disk and the board is not touched");
}

// 3. What needs the user, what pauses a site, what is not confirmed
{
  let r = await apply("2", [], "ssn");
  assert.ok(r.code === 3 && /Needs you: Globex/.test(r.out) && /Nothing was sent/.test(r.out) && /may be a scam/.test(r.out) && /Social Security/.test(r.out), JSON.stringify(r));
  assert.strictEqual(count("2"), 0);
  r = await apply("2", [], "challenge");
  assert.ok(r.code === 4 && /Site paused/.test(r.out), JSON.stringify(r));
  assert.strictEqual(count("2"), 0);
  assert.strictEqual((await raw(["--resume-site", "board"])).code, 0); // the user has looked at the site
  r = await apply("3", [], "lost");
  assert.ok(r.code === 5 && /Sent, not confirmed: .*\(ledger #2\)/.test(r.out), JSON.stringify(r));
  assert.strictEqual(count("3"), 1);
  const retry = await apply("3");
  // an earlier attempt with no confirmation is not "done": exit 5, like "sent, not confirmed" (A124); a confirmed duplicate stays 0 (section 2)
  assert.ok(retry.code === 5 && /no confirmation: verify it/.test(retry.out), JSON.stringify(retry));
  assert.strictEqual(count("3"), 1, "an unconfirmed attempt was sent a second time by a new process");
  // control: the clean form for the posting that parked is submitted
  r = await apply("2");
  assert.ok(r.code === 0 && /Applied: Globex/.test(r.out), JSON.stringify(r));
  assert.strictEqual(count("2"), 1);
  console.log("[ok] an identity-number ask exits 3 with 'Nothing was sent' and the scam note; a challenge exits 4; a lost answer exits 5 and a new process does not send it again; the clean form is applied");
}

// 3b. --verify: a new process looks at the site for every attempt that has no confirmation
{
  const run = (args) => new Promise((resolve) => { const p = spawn(process.execPath, ["--experimental-sqlite", "--no-warnings", cli, "apply", ...args], { cwd: root, env: { ...process.env, AGENT_LOOP_HOME: home } }); let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d)); p.on("close", (code) => resolve({ code, out, err })); });
  // an attempt the process died in the middle of: the ledger holds it and the page it was for, the site never saw it
  const l = new Ledger(join(home, "ledger.db"), Date.now, { ...DEFAULT_CAPS, minGapMs: 0 });
  const rowsBefore = l.unaccounted().length;
  assert.strictEqual(rowsBefore, 1, "control: only the lost attempt for the third posting is unaccounted for");
  assert.ok(l.intend({ site: "board", jobId: "4", company: "Hooli", title: "Backend Engineer" }, "h", `${board.url}/jobs/4`).ok);
  l.close();
  const v = await run(["--verify", "--test"]);
  assert.ok(v.code === 5 && /the site shows it was received \(now confirmed\)/.test(v.out) && /Hooli, Backend Engineer: cannot tell from the site; left unaccounted for.*agent-loop apply --forget \d+/.test(v.out), JSON.stringify(v));
  assert.strictEqual(count("4"), 0, "verifying sent an application");
  // the site showing 'Apply now' is no proof: the retry is still refused until the user closes the row
  const blocked = await apply("4");
  assert.ok(blocked.code === 5 && /no confirmation: verify it/.test(blocked.out) && count("4") === 0, JSON.stringify(blocked));
  const seq = /--forget (\d+)/.exec(v.out)[1];
  const bad = await run(["--forget", "9999"]);
  assert.ok(bad.code === 1 && /no attempt that can be closed has the number 9999/.test(bad.err), JSON.stringify(bad));
  const tooSoon = await run(["--forget", seq]);
  assert.ok(tooSoon.code === 1 && /only \d+ seconds old and may still be in flight/.test(tooSoon.err), JSON.stringify(tooSoon));
  const gone = await run(["--forget", seq, "--even-if-recent"]);
  assert.ok(gone.code === 0 && /as not received. That posting can be applied to again/.test(gone.out), JSON.stringify(gone));
  const none = await run(["--verify", "--test"]);
  assert.ok(none.code === 0 && /Nothing to verify/.test(none.out), JSON.stringify(none));
  const again = await apply("4");
  assert.ok(again.code === 0 && /Applied: Hooli/.test(again.out) && count("4") === 1, JSON.stringify(again));
  console.log("[ok] --verify looks at the site for every unconfirmed attempt: received -> confirmed, anything else -> left alone with the way to close it; --forget closes one by the user's word and only then can it be tried again; it sends nothing");
}

// 3c. Round 4 (A72, A74): a paused site stays paused across processes, the flag order does not matter, a cap of 0 has no time, the ledger is private, a home that cannot be made is a message
{
  const run = (args, env = {}) => new Promise((resolve) => { const p = spawn(process.execPath, ["--experimental-sqlite", "--no-warnings", cli, "apply", ...args], { cwd: root, env: { ...process.env, AGENT_LOOP_HOME: home, ...env } }); let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d)); p.on("close", (code) => resolve({ code, out, err })); });
  // --test before the page: the page is still the page
  const fresh = ["--site", "board", "--company", "Zed", "--title", "Janitor", "--job-id", "98"];
  const early = await run(["--test", `${board.url}/jobs/7/apply?chaos=challenge`, ...fresh]);
  assert.ok(early.code === 4 && /Site paused/.test(early.out), JSON.stringify(early));
  const before = board.requests.length;
  const stays = await run([`${board.url}/jobs/7/apply`, "--test", ...fresh]);
  assert.ok(stays.code === 4 && /--resume-site board/.test(stays.out), JSON.stringify(stays));
  assert.strictEqual(board.requests.length, before, "a paused site was visited by a new process");
  const lifted = await run(["--resume-site", "board"]);
  assert.ok(lifted.code === 0 && /no longer paused/.test(lifted.out), JSON.stringify(lifted));
  assert.ok(/was not paused/.test((await run(["--resume-site", "board"])).out));
  // A118: an empty platform name (an unset shell variable) must not lift every pause
  {
    await run(["--test", `${board.url}/jobs/7/apply?chaos=challenge`, ...fresh]);
    for (const blank of ["", "  "]) { const r = await run(["--resume-site", blank]); assert.ok(r.code === 1 && /needs the platform name/.test(r.err), JSON.stringify(r)); }
    assert.ok(/Site paused/.test((await run([`${board.url}/jobs/7/apply`, "--test", ...fresh])).out), "an empty --resume-site lifted the pause");
    assert.ok((await run(["--resume-site", "board"])).code === 0);
  }
  // a cap of 0: the person is not told "Infinity"
  put("caps.json", { minGapSeconds: 0, perDay: 0 });
  const zero = await run(["--test", `${board.url}/jobs/7/apply`, "--site", "board", "--company", "Zed", "--title", "Janitor", "--job-id", "99"]);
  assert.ok(zero.code === 6 && /cap of 0/.test(zero.out) && !/Infinity|NaN/.test(zero.out), JSON.stringify(zero));
  put("caps.json", { minGapSeconds: 0 });
  // the ledger is the user's alone
  if (process.platform !== "win32") assert.strictEqual(statSync(join(home, "ledger.db")).mode & 0o077, 0, "ledger.db is readable by others");
  // a home that cannot be made is a message, not a stack trace
  const blocker = join(mkdtempSync(join(tmpdir(), "apply-cli-block-")), "file");
  writeFileSync(blocker, "x");
  const nohome = await run(["--verify", "--test"], { AGENT_LOOP_HOME: join(blocker, "inside") });
  assert.ok(nohome.code === 1 && /cannot be made/.test(nohome.err) && !/at .*\.js:\d+/.test(nohome.err), JSON.stringify(nohome));
  console.log("[ok] round 4: a challenge pauses the site for every later process until --resume-site; --test may come before the page; a cap of 0 says so without a time; ledger.db is private; an impossible home is a message");
}

// 3d. Round 6 (A105): four runs started at once on one ledger with an hourly cap of 2 send two applications, not four
{
  const home2 = mkdtempSync(join(tmpdir(), "apply-cli-home2-"));
  chmodSync(home2, 0o700);
  const put2 = (name, obj) => writeFileSync(join(home2, name), JSON.stringify(obj), { mode: 0o600 });
  put2("uploads.json", { files: { resume: resumePath } });
  put2("facts.json", { facts: { full_name: "Ada Lovelace", email: "ada@example.com", work_authorisation: "Yes", needs_sponsorship: "No", years_experience: "7" } });
  put2("caps.json", { perHour: 2, minGapSeconds: 0 });
  const board2 = await startBoard();
  const one = (id) => new Promise((resolve) => {
    const j = board2.jobs.find((x) => x.id === id);
    const p = spawn(process.execPath, ["--experimental-sqlite", "--no-warnings", cli, "apply", `${board2.url}/jobs/${id}/apply`, "--test", "--site", "board", "--company", j.company, "--title", j.title, "--job-id", id], { cwd: root, env: { ...process.env, AGENT_LOOP_HOME: home2 } });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.on("close", (code) => resolve({ code, out }));
  });
  const results = await Promise.all(["1", "2", "3", "4"].map(one));
  const accepted = ["1", "2", "3", "4"].filter((id) => (board2.applications[id] ?? []).length > 0).length;
  assert.ok(accepted <= 2, `four parallel runs with an hourly cap of 2 sent ${accepted}: ${JSON.stringify(results.map((r) => r.code))}`);
  assert.ok(accepted >= 1, `control: nothing was sent: ${JSON.stringify(results)}`);
  assert.ok(results.some((r) => r.code === 6 || /cap/.test(r.out)), `nobody was told about the cap: ${JSON.stringify(results)}`);
  await board2.close();
  console.log("[ok] four runs started at once on one ledger with an hourly cap of 2: the board accepted at most 2, the others were told the cap is reached");
}

// 4. The user's files are read like the allowances file, and LIVE mode needs one
{
  writeFileSync(join(home, "facts.json"), JSON.stringify({ facts: { favourite_colour: "blue" } }), { mode: 0o600 });
  const bad = await apply("1");
  assert.ok(bad.code === 1 && /not a fact this flow can use/.test(bad.err), JSON.stringify(bad));
  put("facts.json", { facts: { email: "ada@example.com" } });
  const live = await new Promise((res) => { const p = spawn(process.execPath, ["--experimental-sqlite", "--no-warnings", cli, "apply", `${board.url}/jobs/1/apply`, "--site", "board", "--company", "Acme", "--title", "X"], { cwd: root, env: { ...process.env, AGENT_LOOP_HOME: home } }); let e = ""; p.stderr.on("data", (d) => (e += d)); p.on("close", (c) => res({ code: c, err: e })); });
  assert.ok(live.code === 1 && /no allowances file yet/.test(live.err), JSON.stringify(live));
  console.log("[ok] a facts file with an unknown fact is refused; LIVE mode without an allowances file opens nothing");
}
await board.close();
console.log("\nALL APPLY CLI TESTS PASSED");
process.exit(0);
