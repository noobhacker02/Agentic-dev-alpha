// The job-apply flow's engine (docs/HYBRID-AGENT-SPEC.md S5; threats B1 to B12). It drives the same browser tools a model would, but every decision that matters is made by code and can be tested without a model:
// which fields are filled from facts and which park the item (`planField`), the check of the filled form against the plan before anything is sent, the ledger's intent row written before the submit click and its
// confirmation after, a stop at once on a challenge page or a rate limit (the site is paused, never retried), and a verify-before-retry for an attempt that has no confirmation. A model can be put in front of this
// (to read an unfamiliar form); it cannot change what the engine refuses.
import { createHash } from "node:crypto";
import { attestationIn, forbiddenIn, labelHash, normalizeLabel, planField, type Facts, type FieldInfo } from "./facts.js";
import { jobKey, type Job, type Ledger, type Row } from "./ledger.js";

export interface Tools { call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> }

export interface PageElement { ref: string; role: string; name: string; value?: string; checked?: boolean; options?: string[]; required: boolean; disabled: boolean; /** Set when the element lives in a frame (the frame's own name). */ frame?: string }

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
      if (rest[i] === "=") {
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
      ...(kv.frame !== undefined ? { frame: jstr(kv.frame) } : {}),
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
  "verify (that )?you(?:'|\u2019)?re (a )?human", "verify you are (a )?human", "are you (a )?(human|robot)", "captcha", "unusual (activity|traffic)", "automated (queries|requests|access)", "too many requests", "rate limit",
  "access (to this page )?(has been )?denied", "temporarily blocked", "checking your browser", "just a moment", "attention required", "security check", "press (&|and) hold", "cloudflare",
  "bestätigen sie, dass sie (ein )?mensch", "sind sie ein roboter", "v[ée]rifi(ez|er) que vous [êe]tes (un )?humain", "[êe]tes-vous un robot", "verifica que eres humano", "demasiadas solicitudes", "zu viele anfragen", "trop de requ[êe]tes",
].join("|"), "i");
const CHALLENGE_TITLE = /\b429\b|^\s*(access denied|forbidden)\b/i;
export const CONFIRMED = /application (was )?(received|submitted|sent)|thank you for applying|successfully (applied|submitted)/i;
export const ALREADY_APPLIED = /you have already applied|already applied|application submitted on/i;
/** Words of a page that failed: such a page is never a confirmation, whatever else it says (A63). */
const ERRORISH = /something went wrong|\berror\b|\bfailed\b|try again|unable to|could not|not (been )?(submitted|received|sent)|invalid|\b50\d\b|\b40\d\b/i;

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

/** The page on which a challenge, a rate limit or a refusal shows: judged on the title and the visible text, which is where such pages say it. */
export const challenged = (inspect: string): boolean => CHALLENGE.test(`${titleOf(inspect)}\n${visible(inspect)}`) || CHALLENGE_TITLE.test(titleOf(inspect));

/** The one submit button: its whole name is one of a few plain phrases. A page with two, or with none, parks; "Send me job alerts" and "Submit and apply to 50 similar jobs" are not it (A68). */
const SUBMIT_NAME = /^(submit( application)?|apply|send application|submit my application)$/;
const pageFields = (els: PageElement[]): PageElement[] => els.filter((e) => e.role !== "button" && e.role !== "link");

export async function applyToJob(d: ApplyDeps): Promise<ApplyResult> {
  const paused = d.ledger.paused(d.job.site);
  if (paused) return { status: "paused-site", why: `${d.job.site} is paused (${paused.why}); run agent-loop apply --resume-site ${d.job.site} when you have looked at it yourself` };
  const start = d.ledger.mayStart(d.job);
  if (!start.ok) return { status: start.duplicateOf ? "duplicate" : "capped", why: start.why, ...(start.waitMs ? { waitMs: start.waitMs } : {}) };
  const pauseSite = (why: string): void => d.ledger.pause(d.job.site, why);

  const opened = await d.tools.call("open", { url: d.applyUrl });
  if (opened.isError) return { status: "error", why: `the application page could not be opened: ${textOf(opened).slice(0, 200)}` };
  let page = textOf(await d.tools.call("inspect", {}));
  if (challenged(page)) { pauseSite("a challenge or a rate limit"); return { status: "paused-site", why: "the site showed a challenge or a rate limit; the site is paused and is not retried by the agent" }; }
  if (ALREADY_APPLIED.test(visible(page))) return { status: "duplicate", why: "the site shows that you already applied" };

  const reasons: string[] = [];
  let scam = false;
  const text = `${titleOf(page)}\n${visible(page)}`;
  // 0. Is this the posting it was told about? A link that leads to another job, or a page that is not a form for it, parks (A76)
  if (!plain(text).includes(plain(d.job.title))) reasons.push(`the page does not look like the posting "${d.job.title.slice(0, 60)}" (its title is not on the page)`);

  // 1. Decide for every field, in code, before anything is touched
  const all = parseElements(page).filter((e) => !e.disabled);
  const fields = pageFields(all);
  if (fields.some((e) => e.frame !== undefined)) reasons.push("part of the form is inside a frame (a page of another origin may be behind it); the flow does not fill frames");
  if (forbiddenIn(visible(page)) && fields.some((e) => e.role === "textbox")) { reasons.push("the page asks for an identity number, a birth date or a bank detail somewhere on it, which a real employer does not need before an offer (a likely scam)"); scam = true; }
  if (attestationIn(visible(page)) && fields.some((e) => e.role === "checkbox")) reasons.push("the page carries a legal attestation (\"I certify ...\") next to a checkbox; only you can make it");
  const plan = new Map<string, { value: string; ref: string; role: string; label: string }>();
  let resumeRef: string | undefined;
  for (const f of fields) {
    if (f.frame !== undefined) continue;
    if (f.role === "file-input") {
      if (/resume|\bcv\b|curriculum/i.test(f.name)) resumeRef = f.ref;
      else if (f.required) reasons.push(`"${f.name.slice(0, 60)}" is a required file and only the résumé is designated`);
      continue;
    }
    // a box that arrives already ticked is an answer the page gave, not one the flow chose
    if (f.role === "checkbox" && f.checked === true) { reasons.push(`"${f.name.slice(0, 60)}" came already checked; the flow does not send an answer it did not choose`); continue; }
    const info: FieldInfo = { label: f.name, required: f.required || /\*\s*$/.test(f.name), role: f.role, ...(f.options ? { options: f.options.filter((o) => o && !/^(select|--|choose)/i.test(o)) } : {}) };
    const p = planField(info, d.facts);
    if (p.action === "park") { reasons.push(p.why); if (p.scam) scam = true; }
    else if (p.action === "fill") plan.set(labelKey(f), { value: p.value, ref: f.ref, role: f.role, label: f.name });
  }
  if (!resumeRef) reasons.push("the form has no résumé field the flow can use");
  const submits = all.filter((e) => e.role === "button" && SUBMIT_NAME.test(normalizeLabel(e.name)));
  if (submits.length !== 1) reasons.push(submits.length ? "the page has more than one button that could submit the application" : "the page has no plain submit button the flow can find");
  if (reasons.length) return { status: "parked", reasons, scam };
  const before = new Map<string, PageElement[]>();
  for (const f of fields) (before.get(labelKey(f)) ?? before.set(labelKey(f), []).get(labelKey(f))!).push(f);
  const preText = visible(page);

  // 2. Fill
  for (const [, p] of plan) {
    const r = p.role === "combobox" ? await d.tools.call("select_option", { ref: p.ref, values: [p.value] }) : await d.tools.call("fill", { ref: p.ref, value: p.value });
    if (r.isError) return { status: "parked", reasons: [`"${p.label.slice(0, 60)}" could not be filled: ${textOf(r).slice(0, 120)}`], scam: false };
  }
  const up = await d.tools.call("upload", { ref: resumeRef, file: d.resume });
  if (up.isError) return { status: "parked", reasons: [`the résumé was not attached: ${textOf(up).slice(0, 160)}`], scam: false };

  // 3. The form diff: what is on the page now is what was planned, and nothing else has changed, appeared or been ticked (A66)
  page = textOf(await d.tools.call("inspect", {}));
  const after = parseElements(page).filter((e) => !e.disabled);
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
  if (forbiddenIn(visible(page)) || attestationIn(visible(page)) && afterFields.some((e) => e.role === "checkbox")) wrong.push("the page now asks for something it did not ask before the fields were filled");
  if (wrong.length) return { status: "parked", reasons: wrong, scam: false };
  const submit = after.filter((e) => e.role === "button" && SUBMIT_NAME.test(normalizeLabel(e.name)));
  if (submit.length !== 1) return { status: "parked", reasons: ["the submit button is no longer the single plain one"], scam: false };

  // 4. Intent, then the click. The form hash is of the labels only: the values are the user's and do not belong in the ledger
  const hash = createHash("sha256").update(JSON.stringify([...plan.keys()].map((k) => labelHash(k)).sort())).digest("hex").slice(0, 16);
  const intent = d.ledger.intend(d.job, hash, d.jobUrl ?? d.applyUrl);
  if (!intent.ok) return { status: "duplicate", why: intent.why };
  const clicked = await d.tools.call("click", { ref: submit[0]!.ref });

  // 5. What came back. A confirmation is words that were NOT on the page before the click, on a page that is not an error and no longer offers the submit button (A63)
  const answer = textOf(await d.tools.call("inspect", {}));
  const seen = `${titleOf(answer)}\n${visible(answer)}`;
  if (challenged(answer)) { pauseSite("a challenge or a rate limit after a submit"); return { status: "paused-site", why: "the site showed a challenge or a rate limit after the submit; the attempt has no confirmation and is verified before any retry", seq: intent.seq }; }
  const stillAsks = parseElements(answer).some((e) => e.role === "button" && SUBMIT_NAME.test(normalizeLabel(e.name)));
  if (!clicked.isError && CONFIRMED.test(seen) && !CONFIRMED.test(preText) && !ERRORISH.test(seen) && !stillAsks) { d.ledger.confirm(intent.seq, "confirmation page"); return { status: "submitted", seq: intent.seq }; }
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
  if (challenged(page)) { ledger.pause(row.site, "a challenge or a rate limit while verifying"); return "unknown"; }
  if (ALREADY_APPLIED.test(visible(page))) { ledger.confirm(row.seq, "verified on the site"); return "confirmed"; }
  return "unknown";
}

export { jobKey };
