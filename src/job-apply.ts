// The job-apply flow's engine (docs/HYBRID-AGENT-SPEC.md S5; threats B1 to B12). It drives the same browser tools a model would, but every decision that matters is made by code and can be tested without a model:
// which fields are filled from facts and which park the item (`planField`), the check of the filled form against the plan before anything is sent, the ledger's intent row written before the submit click and its
// confirmation after, a stop at once on a challenge page or a rate limit (the site is paused, never retried), and a verify-before-retry for an attempt that has no confirmation. A model can be put in front of this
// (to read an unfamiliar form); it cannot change what the engine refuses.
import { createHash } from "node:crypto";
import { attestationIn, forbiddenIn, labelHash, normalizeLabel, otherPersonIn, planField, type Facts, type FieldInfo } from "./facts.js";
import { jobKey, type Job, type Ledger, type Row } from "./ledger.js";

export interface Tools { call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> }

export interface PageElement { ref: string; role: string; name: string; value?: string; checked?: boolean; options?: string[]; required: boolean; disabled: boolean; /** Set when the element lives in a frame (the frame's own name). */ frame?: string; /** The form it belongs to (an index of the page's forms), when the page tied it to one. */ form?: number }

const LINE = /^\[(s\d+e\d+)\] ([\w-]+) ("(?:[^"\\]|\\.)*") ?(.*)$/;
const jstr = (s: string): string => { try { return String(JSON.parse(s)); } catch { return ""; } };

/** Reads a JSON string or array starting at `i`; returns its text and the index after it. */
function readJson(rest: string, i: number): { text: string; end: number } | undefined {
  const open = rest[i];
  if (open === '"') {
    for (let k = i + 1; k < rest.length; k++) { if (rest[k] === "\\") k++; else if (rest[k] === '"') return { text: rest.slice(i, k + 1), end: k + 1 }; }
    return undefined;
  }
  if (open === "[") {
    let inStr = false;
    for (let k = i; k < rest.length; k++) {
      const ch = rest[k]!;
      if (inStr) { if (ch === "\\") k++; else if (ch === '"') inStr = false; } else if (ch === '"') inStr = true; else if (ch === "]") return { text: rest.slice(i, k + 1), end: k + 1 };
    }
  }
  return undefined;
}

/**
 * Reads the element lines of an `inspect` answer. The page's words arrive JSON-quoted, so a name cannot close its quote and forge a second element, and the rest of the line is read token by token, with every quoted
 * value skipped as a whole: a flag word (`disabled`, `required`, `checked`) counts only when it stands alone, never when it sits inside the page's own `id` or `value` (adversary round 4, A75).
 */
export function parseElements(inspectText: string): PageElement[] {
  const out: PageElement[] = [];
  for (const line of inspectText.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const rest = m[4] ?? "";
    const flags = new Set<string>();
    const kv: Record<string, string> = {};
    let i = 0;
    while (i < rest.length) {
      while (rest[i] === " ") i++;
      const w = /^[\w-]+/.exec(rest.slice(i));
      if (!w) break;
      i += w[0].length;
      if (rest[i] === "=" && /\d/.test(rest[i + 1] ?? "")) {
        const n = /^\d+/.exec(rest.slice(i + 1))![0];
        kv[w[0]] = n;
        i += 1 + n.length;
      } else if (rest[i] === "=") {
        const v = readJson(rest, i + 1);
        if (!v) break;
        kv[w[0]] = v.text;
        i = v.end;
      } else flags.add(w[0]);
    }
    let opts: string[] | undefined;
    if (kv.options) { try { opts = (JSON.parse(kv.options) as unknown[]).map(String); } catch { opts = undefined; } }
    out.push({
      ref: m[1]!, role: m[2]!, name: jstr(m[3]!), ...(kv.value !== undefined ? { value: jstr(kv.value) } : {}),
      ...(flags.has("unchecked") ? { checked: false } : flags.has("checked") ? { checked: true } : {}),
      ...(opts ? { options: opts } : {}), required: flags.has("required"), disabled: flags.has("disabled"),
      ...(kv.frame !== undefined ? { frame: jstr(kv.frame) } : {}), ...(kv.form !== undefined ? { form: Number(kv.form) } : {}),
    });
  }
  return out;
}

/**
 * Text that means the site is asking whether a person is there, or telling the agent to slow down. The site is paused (and the pause is written to the ledger, so a later process sees it); nothing here tries to get
 * past it (CLAUDE.md: never evade bans or anti-bot measures). Judged on the title and the visible text, in the languages a job seeker meets most. A bare "429" counts only in the title (a received application whose
 * page happens to print that number is not a rate limit).
 */
export const CHALLENGE = new RegExp([
  "verify (that )?you(?:'|\u2019)?re (a )?human", "verify you are (a )?human", "verifying you are (a )?human", "are you (a )?(human|robot)", "unusual (activity|traffic)", "suspicious (activity|behaviou?r|traffic)", "automated (queries|requests|access)",
  "too many requests", "access (to this page )?(has been )?denied", "temporarily blocked", "checking your browser", "checking if the site connection is secure", "press (&|and) hold",
  "(complete|solve|pass|prove|take) (the |a )?(captcha|security check|human verification)", "captcha (challenge|to continue)", "please verify", "confirm you are (a )?human",
  "bestätigen sie, dass sie (ein )?mensch", "sind sie ein roboter", "v[ée]rifi(ez|er) que vous [êe]tes (un )?humain", "[êe]tes-vous un robot", "verifica que eres humano", "comprueba que eres humano", "demuestra que eres humano", "demasiadas solicitudes", "zu viele anfragen", "trop de requ[êe]tes",
].join("|"), "i");
const CHALLENGE_TITLE = /^\s*(error[: ]*)?(429|403)\b|^\s*(access denied|forbidden)\b/i;
export const CONFIRMED = /application (was )?(received|submitted|sent)|thank you for applying|successfully (applied|submitted)/i;
export const ALREADY_APPLIED = /\byou(?:'|\u2019)?(?:ve| have) already applied\b|\bapplication submitted on\b/i;
/** Words of a page that failed: such a page is never a confirmation, whatever else it says (A63). */
const ERRORISH = /something went wrong|\berror\b|\bfail(ed|ure)?\b|try again|unable to|could ?n(?:o|')?t|can(?:no|')?t|\bwasn(?:'|\u2019)?t\b|\bwere ?n(?:'|\u2019)?t\b|\bdidn(?:'|\u2019)?t\b|\bnot (been )?(submitted|received|sent|accepted|processed|completed)|\b(declined|rejected|refused|denied|unsuccessful|incomplete|problem|invalid|missing|required)\b/i;

export interface ApplyDeps {
  tools: Tools;
  facts: Facts;
  ledger: Ledger;
  /** The NAME of the designated résumé (uploads.json), never a path. */
  resume: string;
  job: Job;
  applyUrl: string;
  jobUrl?: string;
}

export type ApplyResult =
  | { status: "submitted"; seq: number }
  | { status: "parked"; reasons: string[]; scam: boolean }
  | { status: "duplicate" | "capped"; why: string; waitMs?: number }
  | { status: "paused-site"; why: string; seq?: number }
  | { status: "unverified"; seq: number; why: string }
  | { status: "error"; why: string };

const textOf = (r: { text: string }): string => r.text;
const visible = (inspect: string): string => /Visible text[^\n]*\n<<<\n([\s\S]*?)\n>>>/.exec(inspect)?.[1] ?? "";
const titleOf = (inspect: string): string => /^Title: (.*)$/m.exec(inspect)?.[1] ?? "";
const labelKey = (e: { name: string; role: string }): string => `${e.role}|${normalizeLabel(e.name)}`;
const plain = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, " ").trim();

/**
 * The page on which a challenge, a rate limit or a refusal shows. The title decides on its own; the body decides only on a page that is short and has no form to fill, which is what an interstitial is: a posting
 * or an application form that merely mentions "reCAPTCHA", "rate limiting" or "Cloudflare" in its text is not one (adversary round 5, A83).
 */
export const challenged = (inspect: string, jobTitle?: string): boolean => {
  const title = titleOf(inspect);
  const body = visible(inspect);
  const fields = parseElements(inspect).filter((e) => e.role !== "button" && e.role !== "link").length;
  // an interstitial is a short page with nothing to fill; a posting or a form is not one, and a page titled with the job's own name is the posting (A100: "403(b) Plan Administrator", "Security Check Analyst")
  if (fields >= 3) return false;
  if (jobTitle && plain(title).includes(plain(jobTitle))) return false;
  if (CHALLENGE_TITLE.test(title) || CHALLENGE_STRONG.test(title)) return true;
  return body.length < 400 && CHALLENGE.test(body);
};
/** A captcha on a form that has fields: not a site to pause, a step only a person can take. */
const CAPTCHA_ON_FORM = /captcha|i(?:'|\u2019)?m not a robot|are you (a )?(human|robot)/i;
const CHALLENGE_STRONG = /^\s*(just a moment|attention required|security check|verify you are human|verifying you are human|access denied|checking your browser|checking if the site connection)/i;
/** The status line of an `open` answer ("HTTP 429."): a site that says 429, 403 or 503 is asked to rest, not asked again. */
const httpStatus = (openText: string): number | undefined => { const m = /\bHTTP (\d{3})\b/.exec(openText); return m ? Number(m[1]) : undefined; };

/** All of the page's text, a section at a time, up to a limit; `complete` is false if the limit cut it short. */
async function readAll(tools: Tools): Promise<{ text: string; complete: boolean }> {
  let out = "";
  let offset = 0;
  for (let i = 0; i < 6; i++) {
    const r = await tools.call("text", offset ? { offset, length: 8000 } : { length: 8000 });
    out += `\n${r.text}`;
    // how far the reader got is in the tool's own first line ("characters 0-8,000 of 12,345"), which the page cannot write; a "(more: ...)" line in the page's text is not trusted (A98)
    const m = /^Text of [^\n]*?, characters ([\d,]+)-([\d,]+) of ([\d,]+)/.exec(r.text);
    if (!m) return { text: out, complete: /No more text/.test(r.text) };
    const end = Number(m[2]!.replace(/,/g, "")), total = Number(m[3]!.replace(/,/g, ""));
    if (end >= total) return { text: out, complete: true };
    offset = end;
  }
  return { text: out, complete: false };
}

/** The same text without accents, so "Résumé" is "resume". */
const bare = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
/** The job's title as a page names itself: the title or a heading is the job title (after "Apply:" or "Apply for", before "at Company" or "- Company"), not just a text that contains it (A89: "Senior Platform Engineer" is not "Platform Engineer"). */
function namesJob(title: string, text: string, job: Job): boolean {
  const want = plain(job.title);
  const wrapper = (c: string): string => plain(c).replace(/^(apply( to| for)?|job application( for)?|application( for)?)\s+/, "").replace(/\s+(at|@)\s+.*$/, "").replace(/\s+(careers?|jobs?)$/, "").trim();
  const candidates = [title, ...title.split(/\s[-|\u2013\u2014:\u00b7]\s/), ...text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 2)];
  const titled = candidates.some((c) => wrapper(c) === want || wrapper(c.replace(/\s[-|\u2013\u2014]\s.*$/, "")) === want);
  // and the company is named somewhere on the page: a sidebar line or a different company's posting that carries the same words is not this job (A104)
  return titled && plain(`${title}\n${text}`).includes(plain(job.company));
}
/** What a failing tool says, with the user's own words taken out of it: a park reason is printed. */
const redact = (text: string, secrets: string[]): string => secrets.filter((v) => v.length >= 3).reduce((t, v) => t.split(v).join("[your fact]"), text);

/** The one submit button: its whole name is one of a few plain phrases. A page with two, or with none, parks; "Send me job alerts" and "Submit and apply to 50 similar jobs" are not it (A68). */
const SUBMIT_NAME = /^(submit( application)?|apply|send application|submit my application)$/;
const pageFields = (els: PageElement[]): PageElement[] => els.filter((e) => e.role !== "button" && e.role !== "link");

export async function applyToJob(d: ApplyDeps): Promise<ApplyResult> {
  // a pause belongs to the platform label and to the host the page is on: the label is typed by the user, the host is not (round 6, A106)
  const host = (() => { try { return `host:${new URL(d.applyUrl).hostname.toLowerCase()}`; } catch { return ""; } })();
  const paused = d.ledger.paused(d.job.site) ?? (host ? d.ledger.paused(host) : undefined);
  if (paused) return { status: "paused-site", why: `${d.job.site} is paused (${paused.why}); run agent-loop apply --resume-site ${d.job.site} when you have looked at it yourself` };
  const start = d.ledger.mayStart(d.job, d.jobUrl ?? d.applyUrl);
  if (!start.ok) return { status: start.duplicateOf ? "duplicate" : "capped", why: start.why, ...(start.waitMs ? { waitMs: start.waitMs } : {}) };
  const pauseSite = (why: string): void => { d.ledger.pause(d.job.site, why); if (host) d.ledger.pause(host, why, d.job.site); };
  // the user's own words, to take out of anything that is printed
  const secrets = Object.values(d.facts.facts).map((f) => f!.value);

  const opened = await d.tools.call("open", { url: d.applyUrl });
  if (opened.isError) return { status: "error", why: `the application page could not be opened: ${redact(textOf(opened), secrets).slice(0, 200)}` };
  // a status that says "slow down" or "go away" is the site speaking, whatever the body says (A82)
  const code = httpStatus(textOf(opened));
  if (code === 429 || code === 403 || code === 503 || code === 401) { pauseSite(`HTTP ${code}`); return { status: "paused-site", why: `the site answered HTTP ${code}; the site is paused and is not retried by the agent` }; }
  if (code !== undefined && code >= 400) return { status: "error", why: `the application page answered HTTP ${code}` };
  let page = textOf(await d.tools.call("inspect", {}));
  if (challenged(page, d.job.title)) { pauseSite("a challenge or a rate limit"); return { status: "paused-site", why: "the site showed a challenge or a rate limit; the site is paused and is not retried by the agent" }; }
  // the whole readable text of the page, not the first 3000 characters the listing shows (A81)
  const { text: full, complete } = await readAll(d.tools);
  const reasons: string[] = [];
  let scam = false;
  // text on the page that says "you already applied" is the page's word, not the ledger's: ask, do not decide (A80)
  if (ALREADY_APPLIED.test(visible(page)) || ALREADY_APPLIED.test(full)) reasons.push("the page says you have already applied; if that is true there is nothing to do, and if it is not, apply by hand: page text is not proof either way");
  const text = `${titleOf(page)}\n${visible(page)}`;
  // 0. Is this the posting it was told about? The page names this job, not one that merely contains the words (A76, A89)
  if (!namesJob(titleOf(page), visible(page), d.job)) reasons.push(`the page does not look like the posting "${d.job.title.slice(0, 60)}" (neither its title nor its first lines name that job)`);

  // 1. Decide for every field, in code, before anything is touched
  const everything = parseElements(page);
  const all = everything.filter((e) => !e.disabled);
  const fields = pageFields(all);
  if (!complete) reasons.push("the page is longer than the flow reads (48,000 characters); it cannot be sure what the rest says");
  if (/\d+ more elements not shown/.test(page)) reasons.push("the page has more interactive elements than the listing shows (60); the flow cannot see all of the form");
  // a box or button that is already ticked or selected is an answer the page gave, whatever its role says or whether it is marked disabled (A85, A93)
  for (const e of everything) if (e.checked === true) reasons.push(`"${e.name.slice(0, 60)}" came already ${e.role === "radio" ? "selected" : "checked"}; the flow does not send an answer it did not choose`);
  if (fields.some((e) => e.frame !== undefined)) reasons.push("part of the form is inside a frame (a page of another origin may be behind it); the flow does not fill frames");
  if ((forbiddenIn(visible(page)) || forbiddenIn(full)) && fields.some((e) => e.role === "textbox")) { reasons.push("the page asks for an identity number, a birth date or a bank detail somewhere on it, which a real employer does not need before an offer (a likely scam)"); scam = true; }
  if (attestationIn(visible(page)) || attestationIn(full)) reasons.push("the page carries a legal attestation (\"I certify ...\"); a box, a typed name or a click can be the signature, and only you can make it");
  if (otherPersonIn(full)) reasons.push("the form has a block about somebody else (a referee, an emergency contact, whoever referred you); its Name, Email and Phone are not yours, and the flow cannot tell the blocks apart");
  if (everything.some((e) => CAPTCHA_ON_FORM.test(e.name))) reasons.push("the form carries a captcha; only a person can pass one");
  const plan = new Map<string, { value: string; ref: string; role: string; label: string; form?: number; key: string }>();
  const factUses = new Map<string, number>();
  const resumeRefs: PageElement[] = [];
  for (const f of fields) {
    if (f.frame !== undefined) continue;
    if (f.role === "file-input") {
      if (/\b(resume|cv|curriculum)\b/.test(bare(f.name))) resumeRefs.push(f);
      else if (f.required) reasons.push(`"${f.name.slice(0, 60)}" is a required file and only the résumé is designated`);
      continue;
    }
    if (f.checked === true) continue; // reported above
    // a select that arrives with a choice made is an answer the page gave (A112)
    if (f.role === "combobox" && (f.value ?? "").trim() && !/^(select|--|choose|please|pick|none|\s*$)/i.test(f.value ?? "") && planField({ label: f.name, required: false, role: f.role, ...(f.options ? { options: f.options } : {}) }, d.facts).action !== "fill") { reasons.push(`"${f.name.slice(0, 60)}" came with a choice already made ("${(f.value ?? "").slice(0, 30)}"); the flow does not send an answer it did not choose`); continue; }
    const info: FieldInfo = { label: f.name, required: f.required || /\*\s*$/.test(f.name), role: f.role, ...(f.options ? { options: f.options.filter((o) => o && !/^(select|--|choose)/i.test(o)) } : {}) };
    const p = planField(info, d.facts);
    if (p.action === "park") { reasons.push(p.why); if (p.scam) scam = true; }
    else if (p.action === "fill") { plan.set(labelKey(f), { value: p.value, ref: f.ref, role: f.role, label: f.name, key: p.key, ...(f.form !== undefined ? { form: f.form } : {}) }); factUses.set(p.key, (factUses.get(p.key) ?? 0) + 1); }
  }
  // the same fact asked twice ("Email" for you and "Email" for a reference) has no safe answer (A88)
  for (const [k, n] of factUses) if (n > 1) reasons.push(`${n} fields ask for "${k}"; one of them may be about someone else (a reference), and the flow cannot tell which`);
  if (resumeRefs.length !== 1) reasons.push(resumeRefs.length ? "the form has more than one field that could take the résumé" : "the form has no résumé field the flow can use");
  const submits = all.filter((e) => e.role === "button" && SUBMIT_NAME.test(normalizeLabel(e.name)));
  if (submits.length !== 1) reasons.push(submits.length ? "the page has more than one button that could submit the application" : "the page has no plain submit button the flow can find");
  // the button must belong to the very form the fields are in; a button of another form (a one-click "similar jobs" form) is not this application's (A94)
  const forms = new Set<number | undefined>([...plan.values()].map((p) => p.form).concat(resumeRefs.map((r) => r.form)));
  forms.add(submits[0]?.form);
  if (reasons.length === 0 && (forms.size !== 1 || [...forms][0] === undefined)) reasons.push("the fields and the submit button are not all in one form the page tied them to; the flow does not guess which button sends this application");
  if (reasons.length) return { status: "parked", reasons: reasons.map((r) => redact(r, secrets)), scam };
  const resumeRef = resumeRefs[0]!.ref;
  const before = new Map<string, PageElement[]>();
  for (const f of fields) (before.get(labelKey(f)) ?? before.set(labelKey(f), []).get(labelKey(f))!).push(f);
  const preText = visible(page);

  // 2. Fill
  for (const [, p] of plan) {
    const r = p.role === "combobox" ? await d.tools.call("select_option", { ref: p.ref, values: [p.value] }) : await d.tools.call("fill", { ref: p.ref, value: p.value });
    // what the browser said may hold the value that was typed (in any spelling), so it is not shown (A101)
    if (r.isError) return { status: "parked", reasons: [`"${p.label.slice(0, 60)}" could not be filled (the browser refused it; its message is not shown because it can repeat your own words)`], scam: false };
  }
  const up = await d.tools.call("upload", { ref: resumeRef, file: d.resume });
  if (up.isError) return { status: "parked", reasons: [`the résumé was not attached: ${redact(textOf(up), secrets).slice(0, 160)}`], scam: false };

  // 3. The form diff: what is on the page now is what was planned, and nothing else has changed, appeared or been ticked (A66)
  page = textOf(await d.tools.call("inspect", {}));
  const afterAll = parseElements(page);
  const after = afterAll.filter((e) => !e.disabled);
  const wrong: string[] = [];
  const afterFields = pageFields(after);
  const seenAfter = new Map<string, PageElement[]>();
  for (const e of afterFields) (seenAfter.get(labelKey(e)) ?? seenAfter.set(labelKey(e), []).get(labelKey(e))!).push(e);
  for (const [key, p] of plan) {
    const e = seenAfter.get(key)?.[0];
    if (!e) { wrong.push(`"${p.label.slice(0, 60)}" is no longer on the page`); continue; }
    if ((e.value ?? "").trim().toLowerCase() !== p.value.trim().toLowerCase()) wrong.push(`"${p.label.slice(0, 60)}" holds "${(e.value ?? "").slice(0, 40)}" and not what was filled`);
  }
  for (const [key, list] of seenAfter) {
    const was = before.get(key) ?? [];
    if (list.length > was.length) { wrong.push(`"${list[0]!.name.slice(0, 60)}" appeared after the fields were filled; the flow does not send what it did not plan`); continue; }
    if (plan.has(key) || list[0]!.role === "file-input") continue;
    list.forEach((e, k) => {
      const w = was[k]!;
      if ((e.value ?? "") !== (w.value ?? "") || e.checked !== w.checked) wrong.push(`"${e.name.slice(0, 60)}" changed after the fields were filled (not planned)`);
      else if (e.role === "textbox" && (e.value ?? "").trim()) wrong.push(`"${e.name.slice(0, 60)}" came with a value the page put there ("${(e.value ?? "").slice(0, 30)}"); the flow does not send what it did not write`);
    });
  }
  for (const e of afterAll) if (e.checked === true) wrong.push(`"${e.name.slice(0, 60)}" is checked`);
  if (forbiddenIn(visible(page)) || attestationIn(visible(page))) wrong.push("the page now asks for something it did not ask before the fields were filled");
  if (wrong.length) return { status: "parked", reasons: wrong.map((r) => redact(r, secrets)), scam: false };
  const submit = after.filter((e) => e.role === "button" && SUBMIT_NAME.test(normalizeLabel(e.name)));
  if (submit.length !== 1 || submit[0]!.form !== [...forms][0]) return { status: "parked", reasons: ["the submit button is no longer the single plain one in the form"], scam: false };

  // 4. Intent, then the click. The form hash is of the labels only: the values are the user's and do not belong in the ledger
  const hash = createHash("sha256").update(JSON.stringify([...plan.keys()].map((k) => labelHash(k)).sort())).digest("hex").slice(0, 16);
  const intent = d.ledger.intend(d.job, hash, d.jobUrl ?? d.applyUrl);
  if (!intent.ok) return { status: "duplicate", why: intent.why };
  const clicked = await d.tools.call("click", { ref: submit[0]!.ref });

  // 5. What came back. A confirmation is words that were NOT on the page before the click, on a page that is not an error and no longer offers the submit button (A63)
  const answer = textOf(await d.tools.call("inspect", {}));
  const seen = `${titleOf(answer)}\n${visible(answer)}`;
  const stillAsks = parseElements(answer).some((e) => e.role === "button" && SUBMIT_NAME.test(normalizeLabel(e.name)));
  // new confirming words on a page with no error wording come first: a thank-you page with a "protected by reCAPTCHA" footer is not a challenge (A99)
  if (!clicked.isError && CONFIRMED.test(seen) && !CONFIRMED.test(preText) && !ERRORISH.test(seen) && !stillAsks) {
    // the row may have been closed by the user while the form was in flight; then it is not ours to call confirmed (A107)
    if (d.ledger.confirm(intent.seq, "confirmation page")) return { status: "submitted", seq: intent.seq };
    return { status: "unverified", seq: intent.seq, why: "the page confirms, but the ledger row was closed in the meantime; check the site" };
  }
  if (challenged(answer, d.job.title)) { pauseSite("a challenge or a rate limit after a submit"); return { status: "paused-site", why: "the site showed a challenge or a rate limit after the submit; the attempt has no confirmation and is verified before any retry", seq: intent.seq }; }
  return { status: "unverified", seq: intent.seq, why: "the page after the submit shows no confirmation that was not already there; the attempt stays unaccounted for until it is verified on the site" };
}

/**
 * After a crash, a kill or an answer that never came: look at the site. If the site says it was received, the row is confirmed. Anything else leaves it alone: a page that offers "Apply now" proves nothing (it shows the
 * button for similar jobs too, A62), so only the user closes a row as not received (`agent-loop apply --forget <n>`).
 */
export async function verifyAttempt(tools: Tools, ledger: Ledger, row: Row, jobUrl: string): Promise<"confirmed" | "unknown"> {
  const opened = await tools.call("open", { url: jobUrl });
  if (opened.isError) return "unknown";
  const page = textOf(await tools.call("inspect", {}));
  if (challenged(page, row.title)) { ledger.pause(row.site, "a challenge or a rate limit while verifying"); return "unknown"; }
  if (ALREADY_APPLIED.test(visible(page))) { ledger.confirm(row.seq, "verified on the site (the page said so; page text can be wrong)"); return "confirmed"; }
  return "unknown";
}

export { jobKey };
