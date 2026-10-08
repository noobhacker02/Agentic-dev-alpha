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
    if (typeof value !== "string" || !value.trim() || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) { errors.push(`${where}: the value must be a short text with no control characters`); continue; }
    if (cls !== undefined && !CLASS_ORDER.includes(cls as FactClass)) { errors.push(`${where}: class must be one of ${CLASS_ORDER.join(", ")}`); continue; }
    out[k] = { value: value.trim(), class: stricter(FACT_KEYS[k], (cls as FactClass | undefined) ?? FACT_KEYS[k]) };
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { facts: out } };
}

/** A label as it is compared: lower case, plain ASCII, no required-marker, one space between words. */
export function normalizeLabel(raw: string): string {
  return clean(raw, 300).toLowerCase().replace(/[*:]/g, " ").replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
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

const FORBIDDEN = /social security|\bssn\b|national (id|insurance)|\bnin\b|passport|date of birth|\bdob\b|birth ?date|\bbank\b|account number|routing number|\biban\b|\bswift\b|credit card|card number|driver'?s? licen[cs]e|mother'?s maiden|\bpassword\b|\bpin\b|tax id|\btin\b/;
const DEMOGRAPHIC = /\bgender\b|\brace\b|ethnic|veteran|disabilit|sexual orientation|pronoun|hispanic|latino|religio|marital|transgender/;
const ATTESTATION = /certify|attest|declare|i agree|i accept|terms|privacy|consent|acknowledge|under penalty|true and (correct|complete)/;
const FREETEXT = /why (do you|are you|us|this)|cover letter|tell us|describe|explain|additional information|anything else|motivation/;
const RULES: Array<[FactKey, RegExp]> = [
  ["first_name", /^(legal )?(first|given) name$/],
  ["last_name", /^(legal )?(last|family) name$|^surname$/],
  ["full_name", /^(full |legal |your )?name$/],
  ["email", /e-?mail/],
  ["phone", /phone|mobile|telephone|contact number/],
  ["city", /^(current )?(city|location|city, state)$|where are you (based|located)/],
  ["linkedin", /linkedin/],
  ["github", /github/],
  ["website", /website|portfolio|personal (site|page)/],
  ["needs_sponsorship", /sponsor/],
  ["work_authorisation", /authori[sz]ed to work|legally (authori[sz]ed|eligible)|right to work|eligible to work|work authori[sz]ation/],
  ["years_experience", /years of (professional |relevant |total )?experience|how many years/],
  ["salary_expectation", /salary|compensation|pay expectation/],
  ["notice_period", /notice period|available to start|start date|when can you start/],
];

/** What a field's label asks for. The order matters: a forbidden ask is judged before anything that could be filled. */
export function classifyQuestion(rawLabel: string, opts: { checkbox?: boolean } = {}): Question {
  const l = normalizeLabel(rawLabel);
  if (FORBIDDEN.test(l)) return { kind: "forbidden", reason: "asks for an identity number, a birth date, a bank detail or a password, which a real employer does not need before an offer (a likely scam)" };
  if (DEMOGRAPHIC.test(l)) return { kind: "demographic" };
  if (ATTESTATION.test(l) && (opts.checkbox || /^(i |by )/.test(l))) return { kind: "attestation" };
  for (const [key, re] of RULES) if (re.test(l)) return { kind: "fact", key };
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
