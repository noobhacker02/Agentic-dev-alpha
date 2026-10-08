// What the job flow may say about the user (docs/HYBRID-AGENT-SPEC.md "Facts and form answers"; threats B8, B9, A15). `facts.json` in the user's agent-loop directory is the only source of factual answers.
// Every fact has a disclosure class, and code (not the model) decides at fill time: a field that asks for something `post-offer-only` or `never-autofill` always parks the item, however well a value would fit, and
// so does a question the page should not be asking before an interview (an identity number, a birth date, a bank account), which is also reported as a likely scam. The label of a field is the page's own text, so it is
// data: it is cleaned, cut, normalised and hashed before anything is keyed by it, and it is never part of the trusted facts.
import { createHash } from "node:crypto";
import { readUserJson } from "./allowances.js";
import { stripTerminalControlBytes } from "./text-safety.js";

export type FactClass = "public" | "application" | "post-offer-only" | "never-autofill";

/** The facts the flow knows how to use, with the class each one has unless the user says otherwise (only to a stricter one). */
export const FACT_KEYS = {
  full_name: "public", first_name: "public", last_name: "public", email: "application", phone: "application", city: "application",
  linkedin: "public", github: "public", website: "public",
  work_authorisation: "application", needs_sponsorship: "application", years_experience: "application", salary_expectation: "application", notice_period: "application",
  date_of_birth: "post-offer-only", government_id: "post-offer-only", bank_account: "post-offer-only",
} as const satisfies Record<string, FactClass>;
export type FactKey = keyof typeof FACT_KEYS;

const CLASS_ORDER: FactClass[] = ["public", "application", "post-offer-only", "never-autofill"];
const stricter = (a: FactClass, b: FactClass): FactClass => (CLASS_ORDER.indexOf(a) >= CLASS_ORDER.indexOf(b) ? a : b);

export interface Fact { value: string; class: FactClass }
export interface Facts { facts: Partial<Record<FactKey, Fact>> }
export const NO_FACTS: Facts = { facts: {} };

export type ParsedFacts = { ok: true; value: Facts } | { ok: false; errors: string[] };

const clean = (s: string, n = 80): string => stripTerminalControlBytes(s).replace(/[^\x20-\x7e]/g, "?").slice(0, n);

/** Checks `facts.json`: {"facts": {"email": "me@example.com", "years_experience": {"value": "7", "class": "application"}}}. Unknown keys and unknown classes are refused; a class can only be made stricter than the key's own. */
export function parseFacts(raw: unknown): ParsedFacts {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ['the file must be a JSON object like {"facts": {"email": "me@example.com"}}'] };
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (k !== "facts") errors.push(`unknown key "${clean(k, 40)}" (only "facts" is allowed)`);
  const f = obj.facts;
  if (!f || typeof f !== "object" || Array.isArray(f)) return { ok: false, errors: [...errors, '"facts" must be an object of name: value'] };
  const out: Facts["facts"] = {};
  for (const [key, spec] of Object.entries(f as Record<string, unknown>)) {
    const where = `facts.${clean(key, 40)}`;
    if (!Object.prototype.hasOwnProperty.call(FACT_KEYS, key)) { errors.push(`${where}: not a fact this flow can use (${Object.keys(FACT_KEYS).join(", ")})`); continue; }
    const k = key as FactKey;
    let value: unknown = spec, cls: unknown;
    if (spec && typeof spec === "object" && !Array.isArray(spec)) {
      const o = spec as Record<string, unknown>;
      for (const ok of Object.keys(o)) if (ok !== "value" && ok !== "class") errors.push(`${where}: unknown key "${clean(ok, 40)}"`);
      value = o.value; cls = o.class;
    }
    if (typeof value !== "string" || !value.trim() || value.length > 300 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)) { errors.push(`${where}: the value must be a short text with no control or direction-changing characters`); continue; }
    if (cls !== undefined && !CLASS_ORDER.includes(cls as FactClass)) { errors.push(`${where}: class must be one of ${CLASS_ORDER.join(", ")}`); continue; }
    out[k] = { value: value.trim(), class: stricter(FACT_KEYS[k], (cls as FactClass | undefined) ?? FACT_KEYS[k]) };
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { facts: out } };
}

/** Text in the one form the phrase lists compare: compatibility-normalised (full-width letters become plain ones), lower case, and without the characters that are invisible or reorder text (a soft hyphen or a zero-width space inside "certify" must not hide it, adversary round 6, A113). */
export const canonText = (raw: string): string => stripTerminalControlBytes(raw).normalize("NFKC").replace(/[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g, "").toLowerCase();

/** A label as it is compared: lower case, plain ASCII, no required-marker, one space between words. */
export function normalizeLabel(raw: string): string {
  // Parenthesised text is part of the question ("Phone (also enter your date of birth)", adversary round 4 A78), so only the brackets go.
  return canonText(raw).slice(0, 400).replace(/[*:?()\[\]]/g, " ").replace(/\s+/g, " ").trim();
}
/** A short stable key for a question (a saved answer is keyed by this, never by the raw text). */
export const labelHash = (raw: string): string => createHash("sha256").update(normalizeLabel(raw)).digest("hex").slice(0, 12);

export type Question =
  | { kind: "fact"; key: FactKey }
  | { kind: "forbidden"; reason: string } // an identity number, a birth date, a bank detail, a password: never asked of an applicant before an offer
  | { kind: "demographic" }
  | { kind: "attestation" }
  | { kind: "freetext" }
  | { kind: "unknown" };

const FORBIDDEN = /social security|social insurance|\bssn\b|national (id|insurance)|\bni number\b|\bnin\b|passport|date of birth|\bdob\b|birth ?date|\bbank\b|account number|routing number|sort code|\biban\b|\bswift\b|credit card|card number|driver'?s? licen[cs]e|mother'?s maiden|\bpassword\b|\bpin\b|tax (file |id )|\btin\b|aadhaar|\bcurp\b|identity (card|number)|\bbsn\b|\bpesel\b|\bnric\b/;
const DEMOGRAPHIC = /\bgender\b|\brace\b|ethnic|veteran|disabilit|sexual orientation|pronoun|hispanic|latino|religio|marital|transgender/;
const ATTESTATION = /certify|attest|declare|i agree|i accept|terms|privacy|consent|acknowledge|under penalty|true and (correct|complete)/;
const FREETEXT = /why (do you|are you|us|this)|cover letter|tell us|describe|explain|additional information|anything else|motivation/;
/** "in the United States", "to work in Canada": the fact says nothing about which country, so a question that names one has no fact (A110); "in this country" and "here" are fine. */
const NAMES_A_PLACE = /\b(in|within|to work in|for|into)\s+(?!this\b|the (country|location|role|position|job|company|team|future|near future|long term)\b|here\b|our\b|any\b|a\b|an\b|that\b|which\b)[a-z]/;
const NEGATION = /\b(without|not|no longer|unable|cannot|can't|isn't|aren't|never|except)\b|n't\b/;
const THIRD_PARTY = /spouse|partner|husband|wife|family|parent|child|dependant|dependent|employee|referr|colleague|manager|reference|referee|sponsor name|name of/;
const RULES: Array<[FactKey, RegExp]> = [
  // anchored: a question about someone or something else ("Reference email", "Manager's phone", "Current salary") is not the applicant's own fact (adversary round 4 A65)
  ["first_name", /^(legal |preferred )?(first|given) name$/],
  ["last_name", /^(legal )?(last|family) name$|^surname$/],
  ["full_name", /^(full |legal |your )?name$/],
  ["email", /^(your |work |personal |contact |primary )?e-?mail( address)?$/],
  ["phone", /^(your |mobile |cell |contact |primary |daytime )?(phone|telephone|mobile)( number)?$/],
  ["city", /^(current )?(city|location|city, state)$|^where are you (based|located)$/],
  ["linkedin", /^(your )?linkedin( profile)?( url| link)?$/],
  ["github", /^(your )?github( profile)?( url| link)?$/],
  ["website", /^(your )?(personal )?(website|portfolio|personal site|personal page)( url| link)?$/],
  ["needs_sponsorship", /sponsor/],
  ["work_authorisation", /authori[sz]ed to work|legally (authori[sz]ed|eligible)|right to work|eligible to work|work authori[sz]ation/],
  ["years_experience", /^(how many )?years of (professional |relevant |total |work )?experience( do you have)?$/],
  ["salary_expectation", /^(expected|desired|target) (annual |base )?(salary|compensation|pay)$|^salary expectations?$/],
  ["notice_period", /^notice period$|^(earliest )?(start date|available to start)$|^when can you start$/],
];

/** Phrases that, anywhere on an application page, mean the page asks for something forbidden (used on the page's visible text, so it leaves out words that a company name or a job description uses: "bank", "pin", "tin"). */
const FORBIDDEN_STRICT = /social security|social insurance|\bssn\b|national insurance|\bni number\b|national id|identity (card|number)|id (card )?number|passport (number|no)|date of birth|\bdob\b|birth ?date|born on|account number|routing number|sort code|\biban\b|\bswift\b|credit card|card number|mother'?s maiden|driver'?s? licen[cs]e (number|no)|aadhaar|\bcurp\b|tax file number|tax id|\bbsn\b|\bpesel\b|\bnric\b/;
/** A whole page's text in the form the phrase lists compare: not cut to a label's length (round 5, A81: the first version looked at the first 300 characters of a page). */
const flat = (t: string): string => canonText(t).replace(/[*:?()\[\]]/g, " ").replace(/\s+/g, " ");
export const forbiddenIn = (text: string): boolean => FORBIDDEN_STRICT.test(flat(text));
const ATTEST_TEXT = new RegExp([
  "\\bi,? (hereby )?(certify|attest|declare|confirm|agree|accept|acknowledge|understand|consent|authori[sz]e|warrant|swear|affirm|represent)\\b",
  "\\bby (submitting|clicking|applying|continuing|signing|checking|ticking|pressing)\\b[^.]{0,160}\\b(agree|confirm|certify|accept|declare|acknowledge|consent|true|accurate)\\b",
  "under penalty of perjury", "\\b(electronic |e-?|digital )?signature\\b", "\\bsign (here|below)\\b", "\\bthe undersigned\\b", "true and (correct|complete|accurate)",
].join("|"));
/** A block of the form that asks about somebody else (a referee, an emergency contact, whoever referred the applicant): its "Name", "Email" and "Phone" are not the applicant's (adversary round 6, A108). */
export const otherPersonIn = (text: string): boolean => /emergency contact|\breferees?\b|\breferences?\b(?!\s*(number|no\b|id\b|code|#|\d))|who referred you|referred by|\bnext of kin\b|\bguarantor\b|\bsupervisor'?s? (name|email|phone)/.test(flat(text));
export const attestationIn = (text: string): boolean => ATTEST_TEXT.test(flat(text));

/** What a field's label asks for. The order matters: a forbidden ask is judged before anything that could be filled. */
export function classifyQuestion(rawLabel: string, opts: { checkbox?: boolean } = {}): Question {
  const l = normalizeLabel(rawLabel);
  if (FORBIDDEN.test(l)) return { kind: "forbidden", reason: "asks for an identity number, a birth date, a bank detail or a password, which a real employer does not need before an offer (a likely scam)" };
  if (DEMOGRAPHIC.test(l)) return { kind: "demographic" };
  if (ATTESTATION.test(l) && (opts.checkbox || /^(i |by )/.test(l))) return { kind: "attestation" };
  // one question that asks two ("Authorized to work without sponsorship") has no single fact to answer it
  if (/sponsor/.test(l) && /authori[sz]ed|eligible|right to work/.test(l)) return { kind: "unknown" };
  for (const [key, re] of RULES) if (re.test(l)) {
    // a yes/no fact is only the answer to a plain question about the applicant: not one that is negated ("able to work without visa sponsorship", "not authorized") and not one about somebody else
    // ("your spouse", "sponsor name (employee who referred you)") (adversary round 5, A87, A95)
    if ((key === "needs_sponsorship" || key === "work_authorisation") && (!/\byou\b|\byour\b/.test(l) || NEGATION.test(l) || THIRD_PARTY.test(l) || NAMES_A_PLACE.test(l))) return { kind: "unknown" };
    return { kind: "fact", key };
  }
  if (ATTESTATION.test(l)) return { kind: "attestation" };
  if (FREETEXT.test(l)) return { kind: "freetext" };
  return { kind: "unknown" };
}

export type FieldPlan =
  | { action: "fill"; value: string; key: FactKey }
  | { action: "park"; why: string; scam?: boolean }
  | { action: "skip" };

export interface FieldInfo { label: string; required: boolean; role: string; options?: string[] }

/**
 * The decision for one field, made by code: fill from facts, park the item and ask the user, or leave an optional field alone. A required field that facts cannot answer parks; so does every demographic question and every
 * legal attestation (their answers belong to the user, saved per employer); a forbidden ask parks and is flagged as a likely scam.
 */
export function planField(field: FieldInfo, facts: Facts): FieldPlan {
  const q = classifyQuestion(field.label, { checkbox: field.role === "checkbox" });
  const shown = `"${clean(field.label, 60)}"`;
  switch (q.kind) {
    case "forbidden": return { action: "park", why: `${shown} ${q.reason}`, scam: true };
    case "demographic": return field.required ? { action: "park", why: `${shown} is a demographic question; only you can answer it` } : { action: "skip" };
    case "attestation": return { action: "park", why: `${shown} is a legal attestation; only you can make it` };
    case "freetext": return field.required ? { action: "park", why: `${shown} needs a written answer and no template is saved for it` } : { action: "skip" };
    case "unknown": return field.required ? { action: "park", why: `${shown} is required and no fact answers it` } : { action: "skip" };
    case "fact": {
      // a label as long as the longest the page listing shows may have been cut: what follows could change the question
      if (field.label.length >= 190) return field.required ? { action: "park", why: `${shown} is too long to judge safely` } : { action: "skip" };
      const fact = facts.facts[q.key];
      if (!fact) return field.required ? { action: "park", why: `${shown} is required and your facts have no "${q.key}"` } : { action: "skip" };
      if (fact.class === "post-offer-only" || fact.class === "never-autofill") return { action: "park", why: `${shown} asks for a ${fact.class} fact, which is never filled`, scam: true };
      if (field.options && field.options.length) {
        const hit = field.options.find((o) => o.trim().toLowerCase() === fact.value.trim().toLowerCase());
        if (!hit) return field.required ? { action: "park", why: `${shown} has no option that matches your fact "${q.key}"` } : { action: "skip" };
        return { action: "fill", value: hit, key: q.key };
      }
      return { action: "fill", value: fact.value, key: q.key };
    }
  }
}

export type LoadedFacts = { ok: true; value: Facts; source: "none" | "file"; path: string } | { ok: false; errors: string[] };

/** Reads `<home>/facts.json` the way the allowances file is read (the user's own file, not a link, not writable by others). No file means no facts: every required field then parks. */
export function loadFacts(home: string, opts: { uid?: number } = {}): LoadedFacts {
  const read = readUserJson(home, "facts.json", opts);
  if (!read.ok) return { ok: false, errors: read.errors };
  if (read.missing) return { ok: true, value: NO_FACTS, source: "none", path: read.path };
  const parsed = parseFacts(read.json);
  return parsed.ok ? { ok: true, value: parsed.value, source: "file", path: read.path } : { ok: false, errors: parsed.errors.map((e) => `${clean(read.path, 200)}: ${e}`) };
}
