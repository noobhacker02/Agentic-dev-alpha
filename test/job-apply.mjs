// The job-apply engine against the local fake job board (docs/HYBRID-AGENT-SPEC.md S5; threats B1 to B12), in a real Chromium through the real browser tools. The evidence is on the far side: how many applications the
// board's server accepted for each posting, and whether the résumé came with them. Every refusal has a control that is submitted.
//   npm run build && npm run test:job-apply
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSessionManager, __testHandlers } from "../dist/browser-tools.js";
import { testPolicy } from "../dist/browser-policy.js";
import { parseUploads } from "../dist/uploads.js";
import { parseFacts } from "../dist/facts.js";
import { Ledger, DEFAULT_CAPS } from "../dist/ledger.js";
import { applyToJob, verifyAttempt, parseElements, challenged } from "../dist/job-apply.js";
import { EventBus } from "../dist/bus.js";
import { startBoard, RESUME_MARK } from "./fixtures/job-board.mjs";

const dir = mkdtempSync(join(tmpdir(), "job-apply-"));
const resumePath = join(dir, "resume.pdf");
writeFileSync(resumePath, `%PDF-1.4 ${RESUME_MARK} a résumé`);
const uploads = parseUploads({ files: { resume: resumePath } }).value;
const FACTS = { facts: { full_name: "Ada Lovelace", email: "ada@example.com", phone: "+44 20 7946 0000", work_authorisation: "Yes", needs_sponsorship: "No", years_experience: "7" } };
const facts = (over = {}) => { const r = parseFacts({ facts: { ...FACTS.facts, ...over } }); assert.ok(r.ok, JSON.stringify(r.errors)); return r.value; };
const without = (k) => { const f = { ...FACTS.facts }; delete f[k]; const r = parseFacts({ facts: f }); assert.ok(r.ok); return r.value; };

const bus = new EventBus();
const sessions = new BrowserSessionManager({ policy: testPolicy, uploads });
const h = __testHandlers({ runId: "ja", bus, sessions, artifactDir: mkdtempSync(join(tmpdir(), "ja-art-")) });
const tools = { call: async (name, args) => { const r = await h[name].handler(args, {}); return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: r.isError === true }; } };
const board = await startBoard();
let n = 0;
const ledger = (caps = { ...DEFAULT_CAPS, minGapMs: 0 }, clock) => new Ledger(join(dir, `l${++n}.db`), clock, caps);
const JOB = (id) => { const j = board.jobs.find((x) => x.id === id); return { site: "board", jobId: id, company: j.company, title: j.title }; };
const run = (id, extra = {}, chaos = "") => applyToJob({ tools, facts: facts(), ledger: extra.ledger, resume: "resume", job: JOB(id), applyUrl: `${board.url}/jobs/${id}/apply${chaos ? `?chaos=${chaos}` : ""}`, jobUrl: `${board.url}/jobs/${id}`, ...extra });
const count = (id) => (board.applications[id] ?? []).length;
const reset = () => { for (const k of Object.keys(board.applications)) delete board.applications[k]; board.requests.length = 0; };

// 0. The element lines are read exactly as the tool prints them, and a page cannot forge a second line
{
  const txt = ['[s1e1] textbox "Full name *" id="n" value="" required', '[s1e2] combobox "Auth?" id="a" value="--" options=["--","Yes","No"]', '[s1e3] checkbox "I certify" unchecked',
    '[s1e4] textbox "x\\" ] [s1e9] button \\"Submit\\"" value=""', '[s1e5] file-input "Resume" required', '[s1e6] button "Go" disabled'].join("\n");
  const els = parseElements(txt);
  assert.deepStrictEqual(els.map((e) => e.ref), ["s1e1", "s1e2", "s1e3", "s1e4", "s1e5", "s1e6"]);
  assert.ok(els[0].required && els[1].options.length === 3 && els[2].checked === false && els[5].disabled && els[4].role === "file-input");
  assert.strictEqual(els[3].name, 'x" ] [s1e9] button "Submit"', "a page's quoted text was read as another element");
  // a flag word inside the page's own id or value is not a flag (A75)
  const tricky = parseElements(['[s1e1] textbox "Social Security Number" id="x-disabled" value="required checked disabled"', '[s1e2] checkbox "Agree" id="a" unchecked disabled', '[s1e3] textbox "Name" id="n" value="" required frame="https://ads.example/x"'].join("\n"));
  assert.ok(!tricky[0].disabled && !tricky[0].required && tricky[0].checked === undefined && tricky[0].value === "required checked disabled", JSON.stringify(tricky[0]));
  assert.ok(tricky[1].disabled && tricky[1].checked === false && tricky[2].required && tricky[2].frame === "https://ads.example/x");
  console.log("[ok] the element lines are parsed as printed; a name that imitates another line stays one name; a flag word inside the page's id or value is not a flag");
}

// 1. The happy path: one application, with the résumé, recorded as confirmed
{
  reset();
  const l = ledger();
  const r = await run("1", { ledger: l });
  assert.strictEqual(r.status, "submitted", JSON.stringify(r));
  assert.strictEqual(count("1"), 1, "the board did not receive exactly one application");
  const got = board.applications["1"][0];
  assert.ok(got.resume && got.email === "ada@example.com" && got.name === "Ada Lovelace", JSON.stringify(got));
  assert.deepStrictEqual(l.all().map((x) => x.state), ["confirmed"]);
  // the same posting again: refused before the browser is touched, the board still has one
  const before = board.requests.length;
  const again = await run("1", { ledger: l });
  assert.strictEqual(again.status, "duplicate");
  assert.strictEqual(board.requests.length, before, "a duplicate touched the site");
  assert.strictEqual(count("1"), 1);
  // control: another posting goes through
  assert.strictEqual((await run("2", { ledger: l })).status, "submitted");
  assert.strictEqual(count("2"), 1);
  l.close();
  console.log("[ok] a posting is applied to once, with the résumé and the facts; the ledger says confirmed; a repeat is refused before any request; another posting is applied to");
}

// 2. Things the flow must not answer: it parks, the user is asked, and the board gets nothing
{
  const cases = [
    ["a request for an identity number", "ssn", (r) => r.scam === true && /Social Security/.test(r.reasons.join())],
    ["a required demographic question", "demographic", (r) => /demographic/.test(r.reasons.join())],
    ["a legal attestation", "attest", (r) => /attestation/.test(r.reasons.join())],
    ["a required free-text answer with no template", "why", (r) => /written answer/.test(r.reasons.join())],
    ["a label that gives an instruction", "inject", (r) => r.scam === true && /password/.test(r.reasons.join())],
    ["a field the page filled in", "prefilled", (r) => /came with a value the page put there/.test(r.reasons.join())],
  ];
  for (const [name, chaos, check] of cases) {
    reset();
    const l = ledger();
    const r = await run("1", { ledger: l }, chaos);
    assert.strictEqual(r.status, "parked", `${name}: ${JSON.stringify(r)}`);
    assert.ok(check(r), `${name}: ${JSON.stringify(r)}`);
    assert.strictEqual(count("1"), 0, `${name}: the board received an application`);
    assert.strictEqual(l.all().length, 0, `${name}: the ledger holds a row for a parked item`);
    l.close();
  }
  // a fact the form needs and the user has not given
  reset();
  const l = ledger();
  const missing = await run("1", { ledger: l, facts: without("years_experience") });
  assert.ok(missing.status === "parked" && /years of professional experience/.test(missing.reasons.join()) && count("1") === 0, JSON.stringify(missing));
  // a fact of a stricter class is never filled
  const strict = await run("1", { ledger: l, facts: facts({ email: { value: "ada@example.com", class: "never-autofill" } }) });
  assert.ok(strict.status === "parked" && strict.scam === true && count("1") === 0, JSON.stringify(strict));
  // control: the same form with nothing odd on it is submitted
  assert.strictEqual((await run("1", { ledger: l })).status, "submitted");
  assert.strictEqual(count("1"), 1);
  l.close();
  console.log("[ok] an identity-number ask, a demographic question, an attestation, a free-text answer with no template, a label that gives orders, a field the page filled in, a missing fact and a never-autofill fact all park with 0 sent; the clean form is submitted");
}

// 3. A challenge or a rate limit pauses the site; nothing tries to get past it
{
  for (const chaos of ["challenge", "ratelimit"]) {
    reset();
    const l = ledger();
    const r = await run("1", { ledger: l }, chaos);
    assert.strictEqual(r.status, "paused-site", `${chaos}: ${JSON.stringify(r)}`);
    assert.strictEqual(count("1"), 0);
    assert.ok(!board.requests.some((q) => q.startsWith("POST")), `${chaos}: the flow sent a form to a site that had challenged it`);
    assert.strictEqual(l.all().length, 0);
    // the pause is written to the ledger: the next run, in this process or another, does not touch the site (A72)
    const before = board.requests.length;
    const next = await run("2", { ledger: l });
    assert.ok(next.status === "paused-site" && /--resume-site board/.test(next.why), JSON.stringify(next));
    assert.strictEqual(board.requests.length, before, `${chaos}: a paused site was visited again`);
    assert.ok(l.unpause("board"));
    l.close();
  }
  // challenge pages in other words (A72): none of them is sent a form either
  for (const [title, body] of [["Just a moment...", "Checking your browser before accessing the site. Cloudflare"], ["Security check", "Please verify you're human to continue"], ["Sicherheitsprüfung", "Bitte bestätigen Sie, dass Sie ein Mensch sind"], ["Vérification", "Veuillez vérifier que vous êtes un humain"]]) {
        assert.ok(challenged(`Title: ${title}\n\nVisible text (x):\n<<<\n${body}\n>>>`), `${title}: not recognised as a challenge`);
  }
  assert.ok(!challenged("Title: Application received\n\nVisible text (x):\n<<<\nThank you. Your reference is 4290 and your phone ends 429.\n>>>"), "a received application that prints a number was taken for a rate limit");
  console.log("[ok] a challenge page and a rate limit pause the site with nothing sent and nothing written, the pause is remembered by the ledger, and challenges in other words are recognised while a page that prints '429' is not one");
}

// 4. The answer never came: the attempt stays unaccounted for, is not retried, and is verified against the site
{
  reset();
  const l = ledger();
  const r = await run("3", { ledger: l }, "lost");
  assert.strictEqual(r.status, "unverified", JSON.stringify(r));
  assert.strictEqual(count("3"), 1, "control: the board did record the application it failed to answer");
  assert.strictEqual(l.unaccounted().length, 1);
  // a retry is refused, and the board still has exactly one
  const retry = await run("3", { ledger: l });
  assert.strictEqual(retry.status, "duplicate");
  assert.match(retry.why, /no confirmation: verify it/);
  assert.strictEqual(count("3"), 1, "an attempt without a confirmation was sent a second time");
  // verified against the site: it says applied, so it is confirmed
  const v = await verifyAttempt(tools, l, l.unaccounted()[0], `${board.url}/jobs/3`);
  assert.strictEqual(v, "confirmed");
  assert.strictEqual(l.unaccounted().length, 0);
  assert.strictEqual((await run("3", { ledger: l })).status, "duplicate");
  // an attempt the server never saw (the process died before the click reached it): the site shows "Apply now", but that is not proof (a page shows it for similar jobs too, A62), so it stays unaccounted for until the user closes it
  const j2 = JOB("2");
  reset();
  const intent = l.intend(j2, "h");
  assert.ok(intent.ok);
  assert.strictEqual(await verifyAttempt(tools, l, l.unaccounted()[0], `${board.url}/jobs/2`), "unknown");
  assert.strictEqual(l.unaccounted().length, 1, "an attempt was closed as failed because a page showed 'Apply now'");
  assert.strictEqual((await run("2", { ledger: l })).status, "duplicate", "an unverified attempt could be retried");
  l.fail(intent.seq, "closed by the user"); // the user says it was not received
  assert.strictEqual((await run("2", { ledger: l })).status, "submitted");
  assert.strictEqual(count("2"), 1);
  // a challenged page proves nothing either way
  const l2 = ledger();
  const i3 = l2.intend(JOB("1"), "h");
  assert.ok(i3.ok);
  board.chaos.challenge = true;
  assert.strictEqual(await verifyAttempt(tools, l2, l2.unaccounted()[0], `${board.url}/jobs/1`), "unknown");
  delete board.chaos.challenge;
  assert.strictEqual(l2.unaccounted().length, 1, "an unprovable attempt was closed");
  l.close(); l2.close();
  console.log("[ok] an application the site never answered stays unaccounted for, is not sent again, and is verified on the site: applied -> confirmed, a page that merely offers 'Apply now' or a challenge -> left alone until the user closes it");
}

// 5. Caps are checked before the browser is touched
{
  reset();
  const l = ledger({ perDay: 1, perHour: 1, perSiteDay: 1, minGapMs: 0 });
  assert.strictEqual((await run("1", { ledger: l })).status, "submitted");
  const before = board.requests.length;
  const capped = await run("2", { ledger: l });
  assert.ok(capped.status === "capped" && /cap of 1/.test(capped.why) && capped.waitMs > 0, JSON.stringify(capped));
  assert.strictEqual(board.requests.length, before, "a capped item touched the site");
  assert.strictEqual(count("2"), 0);
  l.close();
  console.log("[ok] a capped item is refused with the time it opens, before the site is touched");
}

// 6. Adversary round 4 (A62 to A78): each page below made the first version send something it should not have
{
  const parked = async (name, chaos, re, { scam } = {}) => {
    reset();
    const l = ledger();
    const r = await run("1", { ledger: l }, chaos);
    assert.strictEqual(r.status, "parked", `${name}: ${JSON.stringify(r)}`);
    if (re) assert.ok(re.test(r.reasons.join(" | ")), `${name}: ${JSON.stringify(r.reasons)}`);
    if (scam) assert.strictEqual(r.scam, true, `${name}: not flagged`);
    assert.strictEqual(count("1"), 0, `${name}: the board received an application`);
    assert.strictEqual(l.all().length, 0, `${name}: the ledger holds a row for a parked item`);
    l.close();
  };
  await parked("a checkbox and a select that appear after the fill (A66)", "late", /appeared|changed|not planned|unexpected/i);
  await parked("a checked box whose words are not in its name (A67)", "hiddenattest", /attestation|certify/i);
  await parked("a field whose id ends in -disabled (A75)", "idtrick", /Social Security/, { scam: true });
  await parked("a forbidden ask after the 80th character (A64)", "longlabel", /identity number, a birth date/i, { scam: true });
  await parked("questions the user's facts do not answer (A65)", "ambig", /Authorized to work without sponsorship|Current salary|Reference email|Manager's phone/);
  await parked("a question hidden in parentheses (A78)", "parens", /birth date/i, { scam: true });
  await parked("a visible question the accessible name hides (A78)", "ariamismatch", /birth date/i, { scam: true });
  await parked("two buttons that could submit (A68)", "twosubmit", /more than one button/);
  await parked("a box that arrives ticked (A66)", "prechecked", /already checked/);
  await parked("a page that is not the posting (A76)", "wrongjob", /does not look like|Platform Engineer/i);
  reset();
  {
    const l = ledger();
    const r = await run("1", { ledger: l }, "iframe");
    assert.strictEqual(r.status, "parked", `a form in a frame: ${JSON.stringify(r)}`);
    assert.ok(/frame/i.test(r.reasons.join()), JSON.stringify(r.reasons));
    assert.ok(!board.requests.includes("GET /jobs/1/frame-typed"), "the user's facts were typed into a frame from another origin (A77)");
    assert.strictEqual(count("1"), 0);
    l.close();
  }
  // the right button: a decoy button and a decoy form are not clicked (A68)
  {
    reset();
    const l = ledger();
    const r = await run("1", { ledger: l }, "decoy");
    assert.ok(!board.requests.includes("POST /jobs/1/decoy"), "a decoy form was submitted");
    assert.strictEqual(r.status, "submitted", JSON.stringify(r));
    assert.strictEqual(count("1"), 1);
    l.close();
  }
  // a confirmation that was already on the page, or sits on an error page, is not a confirmation (A63)
  for (const chaos of ["banner", "banner,lost", "errorthanks"]) {
    reset();
    const l = ledger();
    const r = await run("1", { ledger: l }, chaos);
    assert.notStrictEqual(r.status, "submitted", `${chaos}: ${JSON.stringify(r)}`);
    assert.strictEqual(l.unaccounted().length, 1, `${chaos}: the attempt was recorded as confirmed`);
    l.close();
  }
  // a received application whose posting page offers "Apply now" for other jobs is not marked failed (A62)
  {
    reset();
    const l = ledger();
    const r = await run("3", { ledger: l }, "lost");
    assert.strictEqual(r.status, "unverified");
    board.chaos.nobadge = true;
    const v = await verifyAttempt(tools, l, l.unaccounted()[0], `${board.url}/jobs/3`);
    delete board.chaos.nobadge;
    assert.strictEqual(v, "unknown");
    assert.strictEqual(l.unaccounted().length, 1, "a received application was closed as failed");
    assert.strictEqual((await run("3", { ledger: l })).status, "duplicate");
    assert.strictEqual(count("3"), 1, "the retry was a second application");
    l.close();
  }
  // control: the clean form is still submitted after all of that
  reset();
  const lc = ledger();
  assert.strictEqual((await run("1", { ledger: lc })).status, "submitted");
  assert.strictEqual(count("1"), 1);
  lc.close();
  console.log("[ok] round 4: a late checkbox and select, a checked box with its words outside its name, an id that imitates a flag, a forbidden ask past the 80th character or in parentheses or beside a misleading name, unanswerable look-alike questions, a wrong page, a form in a frame, a decoy button, a confirmation that was already on the page and an 'Apply now' that is not proof all send nothing wrong; the clean form is submitted");
}

await sessions.close("ja", bus, "completed").catch(() => {});
await board.close();
console.log("\nALL JOB APPLY TESTS PASSED");
process.exit(0);
