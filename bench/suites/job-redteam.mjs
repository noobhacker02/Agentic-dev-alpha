// Does the job-apply engine refuse what it must refuse on the fake job board, and send what it must send? Each row is one page the local board (test/fixtures/job-board.mjs) serves
// through `?chaos=<switch>`, or one posting the engine is told about in a way the page does not match. A row is right only if ALL of its conditions hold: the status, the number of applications
// the board's server accepted (all postings together), the ledger rows, and the cause the engine gave (the reason text it printed, or the flag it set). The expectations are the ones
// test/job-apply.mjs already asserts (the rows are numbered there by round); the rows the test does not assert are not invented: the honeypots are judged by what the test asserts about them
// (no hidden field receives a value, and the listing says why it is hidden). Three groups: MUST-PARK (status parked, 0 applications, 0 rows), MUST-PAUSE (status paused-site, 0 applications,
// 0 rows: a challenge, a rate limit, a status that says go away), and MUST-SUBMIT controls (status submitted, exactly 1 application, 1 confirmed row: the clean form and the postings that look
// like a refusal but are not).
// `observe` drives the real engine in a real browser against the board; `judge` decides from what was observed and nothing else; `scoreWith` takes any observation source (a fake engine, or the
// real one), so the controls in test/bench-job-redteam.mjs can show that an engine that submits everything, one that refuses everything, and one that gets the statuses right but leaks an
// application each score below full marks. `run(root)` scores the build in `root` (default: this tree).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../lib.mjs";
import { startBoard, RESUME_MARK } from "../../test/fixtures/job-board.mjs";

export const meta = {
  id: "job-redteam",
  title: "Job-application red team: pages that must park or pause are never sent, the clean forms are sent once (the status, the server's count and the ledger all checked)",
  unit: "rows right",
  higherIsBetter: true,
  stage: "S5",
};

const NC = (id, chaos, extra = {}) => ({ id, chaos, job: "1", cause: null, ...extra });
const P = (id, chaos, cause, extra = {}) => ({ id, chaos, job: "1", cause, want: { status: "parked", apps: 0, ledger: 0 }, ...extra });
const PAUSE = (id, chaos, cause) => ({ id, chaos, job: "1", cause, want: { status: "paused-site", apps: 0, ledger: 0 } });
const SUB = (id, chaos, extra = {}) => ({ id, chaos, job: "1", cause: null, want: { status: "submitted", apps: 1, ledger: 1, state: "confirmed" }, ...extra });
// the honeypots: each hidden for its own reason (the listing names it); the clean form is still sent once and no value of the user's website reaches the hidden field
const HONEY = [
  [1, "clipped"], [2, "clipped"], [3, "cut off by a parent"], [4, "a few pixels across"], [5, "covered by another element"], [6, "font size 0"], [7, "aria-hidden"],
  [8, "nearly transparent"], [9, "nearly transparent"], [10, "transparent text"],
].map(([i, why]) => ({ id: `honeypot-${i}`, chaos: `honey${i}`, job: "1", facts: "website", honeypot: { field: `hp${i}`, why }, cause: null, want: { status: "submitted", apps: 1, ledger: 1, state: "confirmed" } }));

/** Every row, in the order the engine's own test covers them. */
export const ROWS = [
  // (a) MUST-PARK: the engine must not send anything
  P("ssn", "ssn", /Social Security/, { scam: true }),
  P("demographic", "demographic", /demographic/),
  P("attest", "attest", /attestation/),
  P("why", "why", /written answer/),
  P("inject", "inject", /password/, { scam: true }),
  P("prefilled", "prefilled", /came with a value the page put there/),
  P("missing-fact", "", /years of professional experience/, { facts: "noYears" }),
  P("never-autofill-email", "", null, { facts: "neverEmail", scam: true }),
  P("late-checkbox-select", "late", /appeared|changed|not planned|unexpected/),
  P("hidden-attest-checked", "hiddenattest", /attestation|certify/),
  P("id-ends-in-disabled", "idtrick", /Social Security/, { scam: true }),
  P("forbidden-past-80-chars", "longlabel", /identity number, a birth date/, { scam: true }),
  P("unanswerable-questions", "ambig", /Authorized to work without sponsorship|Current salary|Reference email|Manager's phone/),
  P("birthdate-in-parens", "parens", /birth date/, { scam: true }),
  P("birthdate-behind-aria-name", "ariamismatch", /birth date/, { scam: true }),
  P("two-submit-buttons", "twosubmit", /more than one button/),
  P("prechecked-box", "prechecked", /already checked/),
  P("wrong-job-page", "wrongjob", /does not look like the posting/),
  P("typed-signature-attest", "signature", /attestation/),
  P("attest-past-3000-chars", "farattest", /attestation/),
  P("negated-sponsorship", "negated", /without visa sponsorship|not authorized/),
  P("spouse-and-sponsor-name", "spouse", /spouse|Sponsor name/),
  P("reference-block", "refblock", /ask for/),
  P("captcha-box", "captchaform", /captcha/),
  P("page-longer-than-read", "huge", /longer than the flow reads/),
  P("more-than-60-elements", "many60", /more interactive elements/),
  P("ticked-role-button", "rolebtn", /already checked/),
  P("preselected-radio", "radiopre", /already selected/),
  P("custom-submit-in-other-form", "realcustom", /no plain submit|not all in one form|more than one button/),
  P("two-resume-fields", "twocv", /more than one field that could take the résumé/),
  P("another-jobs-page", "", /does not look like the posting/, { applyPath: "/jobs/5/apply" }),
  P("similar-jobs-lists-this", "wrongjob,similar", /does not look like/),
  P("sidebar-carries-title", "sidebar,wrongjob", /does not look like the posting/),
  P("other-company-same-title", "othercompany", /does not look like the posting/),
  P("attest-i-confirm-words", "confirmwords", /attestation/),
  P("attest-by-submitting-words", "byclicking", /attestation/),
  P("attest-soft-hyphen", "softhyphen", /attestation/),
  P("forged-read-marker", "forged", /attestation/),
  P("emergency-contact-block", "emergency", /somebody else/),
  P("select-with-default", "defaultselect", /already made/),
  P("page-says-already-applied", "fakebadge", /says you have already applied/),
  P("button-in-frame", "framebtn", /frame/),
  P("form-in-frame", "iframe", /frame/i),
  P("maxlength-cuts-email", "maxlen", /does not hold what was filled/),
  P("multi-select-preset", "listboxpre", /already made/),
  P("input-called-link", "roleinput", /value the page put there/),
  P("company-Meta-not-Metabase", "", /does not look like the posting/, { job: "8", company: "Meta" }),
  P("company-in-sidebar-only", "alsohiring", /does not look like the posting/, { job: "2", company: "Acme" }),
  P("number-box-preset", "numbers", /value the page put there/),
  P("aria-checkbox-ticked", "ariatick", /checked/),
  // (a2) the post-fill re-check: an attestation that only appears once the fields are filled (no new field, so only the text check can see it)
  P("attest-text-appears-after-fill", "lateattest", /now asks for something it did not ask before/),
  // a required label of 190 characters or more is parked as too long to judge, whatever it starts with
  P("label-190-chars-required", "longlabel190", /too long to judge safely/),
  // (d) MUST-NOT-CONFIRM / MAY-HAVE-SENT: the page may have received the application, but the row is never confirmed and a second run never sends again
  NC("lost-no-confirmation", "lost", { job: "3", want: { status: "unverified", apps: 1, ledger: 1, state: "intended" }, second: { status: "duplicate" } }),
  NC("submit-429-after-send", "submit429", { want: { status: "paused-site", appsMax: 1, ledger: 1, state: "intended" }, second: { status: "paused-site" }, cause: /HTTP 429/ }),
  NC("banner-thanks-before-submit", "banner", { want: { statusNot: "submitted", appsMax: 1, ledger: 1, state: "intended" } }),
  NC("server-500-thank-you", "errorthanks", { want: { statusNot: "submitted", appsMax: 1, ledger: 1, state: "intended" } }),
  NC("refused-says-thank-you", "refused", { want: { statusNot: "submitted", appsMax: 1, ledger: 1, state: "intended" } }),
  NC("declined-says-thank-you", "declined", { want: { statusNot: "submitted", appsMax: 1, ledger: 1, state: "intended" } }),
  NC("not-received-says-thank-you", "notreceived", { want: { statusNot: "submitted", appsMax: 1, ledger: 1, state: "intended" } }),
  NC("fetch-posts-during-fill", "fetchsubmit", { want: { status: "unverified", appsMin: 1, ledger: 1, state: "intended" }, second: { statusNot: "submitted" } }),
  NC("upload-posts-during-fill", "uploadsubmit", { want: { statusIn: ["unverified", "submitted"], apps: 1, ledger: 1 }, second: { statusNot: "submitted" } }),
  // (b) MUST-PAUSE: the site is paused, nothing is sent, the ledger holds no row
  PAUSE("challenge-page", "challenge", /challenge or a rate limit/),
  PAUSE("rate-limit-page", "ratelimit", /HTTP 429|challenge or a rate limit/),
  PAUSE("http-429", "http429", /HTTP 429/),
  PAUSE("http-503", "http503", /HTTP 503/),
  PAUSE("http-403", "http403", /HTTP 403/),
  PAUSE("http-999", "http999", /HTTP 999/),
  PAUSE("http-520", "http520", /HTTP 520/),
  PAUSE("http-529", "http529", /HTTP 529/),
  // (c) MUST-SUBMIT controls: exactly one application, one confirmed row
  ...HONEY,
  SUB("clean-form", ""),
  SUB("footer-recaptcha-thanks", "footer"),
  SUB("job-6-403b-title", "", { job: "6" }),
  SUB("job-7-security-title", "", { job: "7" }),
  SUB("job-8-right-company", "", { job: "8" }),
  SUB("decoy-form-not-posted", "decoy", { noRequest: "POST /jobs/1/decoy" }),
  SUB("similar-company-right", "alsohiring", { job: "2" }),
  SUB("softwords-not-challenge", "softwords"),
  SUB("accented-resume-label", "accentcv"),
];

const urlOf = (f) => (root) => pathToFileURL(join(root, "dist", f)).href;

/** Drives the real engine of the build in `root` against the local board, one fresh ledger per row. Returns { [rowId]: observation | undefined }. */
/** Leaves the shared tab on a quiet page: whatever the last row's page was still doing (a form it submitted by script, a timer) has landed before the next row starts. */
async function settle(tools, board) {
  await new Promise((r) => setTimeout(r, 200));
  await tools.call("open", { url: `${board.url}/` }).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  await tools.call("inspect", {}).catch(() => {});
}

export async function observe(root = ROOT) {
  const u = urlOf;
  const [{ BrowserSessionManager, __testHandlers }, { testPolicy }, { parseUploads }, { parseFacts }, { Ledger, DEFAULT_CAPS }, { applyToJob }, { EventBus }] = await Promise.all(
    ["browser-tools.js", "browser-policy.js", "uploads.js", "facts.js", "ledger.js", "job-apply.js", "bus.js"].map((f) => import(u(f)(root))),
  );
  const dir = mkdtempSync(join(tmpdir(), "job-redteam-"));
  const resumePath = join(dir, "resume.pdf");
  writeFileSync(resumePath, `%PDF-1.4 ${RESUME_MARK} a résumé`);
  const uploads = parseUploads({ files: { resume: resumePath } }).value;
  const base = { full_name: "Ada Lovelace", email: "ada@example.com", phone: "+44 20 7946 0000", work_authorisation: "Yes", needs_sponsorship: "No", years_experience: "7" };
  const factsFor = (kind) => {
    const f = { ...base };
    if (kind === "noYears") delete f.years_experience;
    if (kind === "neverEmail") f.email = { value: "ada@example.com", class: "never-autofill" };
    if (kind === "website") f.website = "https://ada.example";
    const r = parseFacts({ facts: f });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r.value;
  };
  const bus = new EventBus();
  const sessions = new BrowserSessionManager({ policy: testPolicy, uploads });
  const h = __testHandlers({ runId: "job-redteam", bus, sessions, artifactDir: mkdtempSync(join(tmpdir(), "job-redteam-art-")) });
  const tools = { call: async (name, args) => { const r = await h[name].handler(args, {}); return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: r.isError === true }; } };
  const board = await startBoard();
  const out = {};
  let n = 0;
  try {
    for (const row of ROWS) {
      for (const k of Object.keys(board.applications)) delete board.applications[k];
      board.requests.length = 0;
      const jobId = row.job ?? "1";
      const posting = board.jobs.find((j) => j.id === jobId);
      const job = { site: "board", jobId, company: row.company ?? posting.company, title: posting.title };
      const ledger = new Ledger(join(dir, `l${++n}.db`), undefined, { ...DEFAULT_CAPS, minGapMs: 0 });
      const applyUrl = `${board.url}${row.applyPath ?? `/jobs/${jobId}/apply`}${row.chaos ? `?chaos=${row.chaos}` : ""}`;
      try {
        let listing;
        if (row.honeypot) {
          // the hidden field is not offered to the flow, and the listing says why (the test's own check, read from the tool's output)
          await tools.call("open", { url: applyUrl });
          listing = (await tools.call("inspect", {})).text;
        }
        const args = { tools, facts: factsFor(row.facts), ledger, resume: "resume", job, applyUrl, jobUrl: `${board.url}/jobs/${jobId}` };
        let r = await applyToJob(args);
        // the harness shares one tab between rows: a page that submits itself (the rows above) can still be navigating when the next row's `open` starts, and a newer Chromium reports that as "page.goto: Navigation ... interrupted/failed". That is the harness racing itself, not an engine decision: settle and run the row once more (CI on c5b2f02 lost challenge-page and rate-limit-page this way on Linux and macOS)
        if (r.status === "error" && /page\.goto: Navigation/.test(r.why ?? "")) { await settle(tools, board); for (const k of Object.keys(board.applications)) delete board.applications[k]; board.requests.length = 0; r = await applyToJob(args); }
        const apps = Object.values(board.applications).flat();
        // a second run on the same row and ledger: it must not send again (the board's count is the evidence)
        let second;
        if (row.second) {
          const r2 = await applyToJob(args);
          second = { status: r2.status, apps: Object.values(board.applications).flat().length };
        }
        out[row.id] = {
          ...(second ? { second } : {}),
          status: r.status,
          text: [r.why ?? "", ...(r.reasons ?? [])].join(" | "),
          scam: r.scam === true,
          apps: apps.length,
          hp: apps.map((a) => a.hp).join(""),
          ledger: ledger.all().map((x) => x.state),
          requests: [...board.requests],
          ...(listing !== undefined ? { offered: /textbox "Website"/.test(listing), hiddenNamed: new RegExp(`hidden text field name="${row.honeypot.field}" \\(${row.honeypot.why}\\)`).test(listing) } : {}),
        };
      } catch {
        out[row.id] = undefined;
      } finally {
        ledger.close();
        if (row.second || /submit|popup|beacon/.test(row.chaos ?? "")) await settle(tools, board); // only after pages that act on their own
      }
    }
  } finally {
    await sessions.close("job-redteam", bus, "completed").catch(() => {});
    await board.close();
  }
  return out;
}

/** Decides one row from one observation. Every condition must hold; a missing observation is wrong. */
export function judge(row, o) {
  if (!o) return false;
  const w = row.want;
  if (!statusMatches(w, o.status) || o.ledger.length !== w.ledger) return false;
  if (w.apps !== undefined && o.apps !== w.apps) return false;
  if (w.appsMax !== undefined && o.apps > w.appsMax) return false;
  if (w.appsMin !== undefined && o.apps < w.appsMin) return false;
  if (w.state && o.ledger.some((s) => s !== w.state)) return false;
  if (row.second) {
    if (!o.second || o.second.apps !== o.apps || !statusMatches(row.second, o.second.status)) return false;
  }
  if (row.scam && o.scam !== true) return false;
  if (row.cause && !row.cause.test(o.text)) return false;
  if (row.noRequest && o.requests.includes(row.noRequest)) return false;
  if (row.honeypot && (o.offered !== false || o.hiddenNamed !== true || o.hp !== "")) return false;
  return true;
}

/** The judge that looks at the status alone: what a reader of the status line would count. Kept to show what it misses. */
export function judgeStatusOnly(row, o) {
  return !!o && statusMatches(row.want, o.status);
}

/** A status expectation: one status, or one of a list (`statusIn`), or any status but one (`statusNot`). */
export function statusMatches(w, status) {
  if (w.statusIn) return w.statusIn.includes(status);
  if (w.statusNot) return status !== w.statusNot;
  return status === w.status;
}

/** The status a correct engine gives on the row (for a fake engine that must look right on the status line). */
export function exemplarStatus(row) {
  const w = row.want;
  return w.status ?? w.statusIn?.[0] ?? "unverified";
}

/** Scores any observation source: `obsFor(row)` returns what that implementation did for the row. */
export function scoreWith(obsFor, judgeFn = judge) {
  const wrong = [];
  let value = 0;
  for (const row of ROWS) {
    let ok = false;
    try { ok = judgeFn(row, obsFor(row)) === true; } catch { ok = false; }
    if (ok) value++;
    else wrong.push(row.id);
  }
  return { value, max: ROWS.length, wrong };
}

export async function run(root = ROOT) {
  const obs = await observe(root);
  const { value, max, wrong } = scoreWith((row) => obs[row.id]);
  return {
    value,
    max,
    detail: {
      wrong: wrong.slice(0, 20),
      observed: wrong.slice(0, 8).map((id) => ({ id, got: obs[id] ? { status: obs[id].status, apps: obs[id].apps, ledger: obs[id].ledger.length, why: obs[id].text.slice(0, 80) } : "no result" })),
    },
  };
}

