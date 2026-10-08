// `agent-loop apply` as a person runs it (docs/HYBRID-AGENT-SPEC.md S5): a real process, the user's files in an agent-loop directory (facts.json, uploads.json), the ledger in ledger.db, a local board on the far side.
// What is checked is what the person sees (the text and the exit code) and what the board counted. Every refusal has a control that is submitted.
//   npm run build && npm run test:apply-cli
import assert from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startBoard, RESUME_MARK } from "./fixtures/job-board.mjs";

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
  r = await apply("3", [], "lost");
  assert.ok(r.code === 5 && /Sent, not confirmed: .*\(ledger #2\)/.test(r.out), JSON.stringify(r));
  assert.strictEqual(count("3"), 1);
  const retry = await apply("3");
  assert.ok(retry.code === 0 && /no confirmation: verify it/.test(retry.out), JSON.stringify(retry));
  assert.strictEqual(count("3"), 1, "an unconfirmed attempt was sent a second time by a new process");
  // control: the clean form for the posting that parked is submitted
  r = await apply("2");
  assert.ok(r.code === 0 && /Applied: Globex/.test(r.out), JSON.stringify(r));
  assert.strictEqual(count("2"), 1);
  console.log("[ok] an identity-number ask exits 3 with 'Nothing was sent' and the scam note; a challenge exits 4; a lost answer exits 5 and a new process does not send it again; the clean form is applied");
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
