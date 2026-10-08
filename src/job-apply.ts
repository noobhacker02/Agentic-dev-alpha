// The job-apply flow's engine (docs/HYBRID-AGENT-SPEC.md S5; threats B1 to B12). It drives the same browser tools a model would, but every decision that matters is made by code and can be tested without a model:
// which fields are filled from facts and which park the item (`planField`), the check of the filled form against the plan before anything is sent, the ledger's intent row written before the submit click and its
// confirmation after, a stop at once on a challenge page or a rate limit (the site is paused, never retried), and a verify-before-retry for an attempt that has no confirmation. A model can be put in front of this
// (to read an unfamiliar form); it cannot change what the engine refuses.
import { createHash } from "node:crypto";
import { labelHash, normalizeLabel, planField, type Facts, type FieldInfo } from "./facts.js";
import { jobKey, type Job, type Ledger, type Row } from "./ledger.js";

export interface Tools { call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> }

export interface PageElement { ref: string; role: string; name: string; value?: string; checked?: boolean; options?: string[]; required: boolean; disabled: boolean }

const LINE = /^\[(s\d+e\d+)\] ([\w-]+) ("(?:[^"\\]|\\.)*")(.*)$/;
const jstr = (s: string): string => { try { return String(JSON.parse(s)); } catch { return ""; } };

/** Reads the element lines of an `inspect` answer. The page's words arrive JSON-quoted, so a name cannot close its quote and forge a second element. */
export function parseElements(inspectText: string): PageElement[] {
  const out: PageElement[] = [];
  for (const line of inspectText.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const rest = m[4] ?? "";
    const value = /\bvalue=("(?:[^"\\]|\\.)*")/.exec(rest);
    const options = /\boptions=(\[.*?\])(?= disabled| required| frame=| in-shadow-root|$)/.exec(rest);
    let opts: string[] | undefined;
    if (options) { try { opts = (JSON.parse(options[1]) as unknown[]).map(String); } catch { opts = undefined; } }
    out.push({
      ref: m[1], role: m[2], name: jstr(m[3]), ...(value ? { value: jstr(value[1]) } : {}), ...(/\bchecked\b/.test(rest) && !/\bunchecked\b/.test(rest) ? { checked: true } : /\bunchecked\b/.test(rest) ? { checked: false } : {}),
      ...(opts ? { options: opts } : {}), required: /\brequired\b/.test(rest), disabled: /\bdisabled\b/.test(rest),
    });
  }
  return out;
}

/** Text that means the site is asking whether a person is there, or telling the agent to slow down. The site is paused; nothing here tries to get past it (CLAUDE.md: never evade bans or anti-bot measures). */
export const CHALLENGE = /verify you are (a )?human|captcha|unusual activity|are you a robot|too many requests|rate limit|access denied|\b429\b|temporarily blocked/i;
export const CONFIRMED = /application (was )?(received|submitted|sent)|thank you for applying|successfully (applied|submitted)/i;
export const ALREADY_APPLIED = /you have already applied|already applied|application submitted on/i;
export const NOT_APPLIED = /\bapply now\b|\beasy apply\b/i;

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

/** The page on which a challenge, a rate limit or a refusal shows: judged on the title and the visible text, which is where such pages say it. */
export const challenged = (inspect: string): boolean => CHALLENGE.test(`${titleOf(inspect)}\n${visible(inspect)}`);

export async function applyToJob(d: ApplyDeps): Promise<ApplyResult> {
  const start = d.ledger.mayStart(d.job);
  if (!start.ok) return { status: start.duplicateOf ? "duplicate" : "capped", why: start.why, ...(start.waitMs ? { waitMs: start.waitMs } : {}) };

  const opened = await d.tools.call("open", { url: d.applyUrl });
  if (opened.isError) return { status: "error", why: `the application page could not be opened: ${textOf(opened).slice(0, 200)}` };
  let page = textOf(await d.tools.call("inspect", {}));
  if (challenged(page)) return { status: "paused-site", why: "the site showed a challenge or a rate limit; the site is paused and is not retried by the agent" };
  if (ALREADY_APPLIED.test(visible(page))) return { status: "duplicate", why: "the site shows that you already applied" };

  // 1. Decide for every field, in code, before anything is touched
  const fields = parseElements(page).filter((e) => !e.disabled && e.role !== "button" && e.role !== "link");
  const plan = new Map<string, { value: string; ref: string; role: string; label: string }>();
  const reasons: string[] = [];
  let scam = false;
  let resumeRef: string | undefined;
  for (const f of fields) {
    if (f.role === "file-input") {
      if (/resume|\bcv\b|curriculum/i.test(f.name)) resumeRef = f.ref;
      else if (f.required) reasons.push(`"${f.name.slice(0, 60)}" is a required file and only the résumé is designated`);
      continue;
    }
    const info: FieldInfo = { label: f.name, required: f.required || /\*\s*$/.test(f.name), role: f.role, ...(f.options ? { options: f.options.filter((o) => o && !/^(select|--|choose)/i.test(o)) } : {}) };
    const p = planField(info, d.facts);
    if (p.action === "park") { reasons.push(p.why); if (p.scam) scam = true; }
    else if (p.action === "fill") plan.set(labelKey(f), { value: p.value, ref: f.ref, role: f.role, label: f.name });
  }
  if (!resumeRef) reasons.push("the form has no résumé field the flow can use");
  if (reasons.length) return { status: "parked", reasons, scam };

  // 2. Fill
  for (const [, p] of plan) {
    const r = p.role === "combobox" ? await d.tools.call("select_option", { ref: p.ref, values: [p.value] }) : await d.tools.call("fill", { ref: p.ref, value: p.value });
    if (r.isError) return { status: "parked", reasons: [`"${p.label.slice(0, 60)}" could not be filled: ${textOf(r).slice(0, 120)}`], scam: false };
  }
  const up = await d.tools.call("upload", { ref: resumeRef, file: d.resume });
  if (up.isError) return { status: "parked", reasons: [`the résumé was not attached: ${textOf(up).slice(0, 160)}`], scam: false };

  // 3. The form diff: what is on the page is what was planned, and nothing else has a value
  page = textOf(await d.tools.call("inspect", {}));
  const after = parseElements(page).filter((e) => !e.disabled);
  const wrong: string[] = [];
  for (const [key, p] of plan) {
    const e = after.find((x) => labelKey(x) === key);
    if (!e) { wrong.push(`"${p.label.slice(0, 60)}" is no longer on the page`); continue; }
    if ((e.value ?? "").trim().toLowerCase() !== p.value.trim().toLowerCase()) wrong.push(`"${p.label.slice(0, 60)}" holds "${(e.value ?? "").slice(0, 40)}" and not what was filled`);
  }
  for (const e of after) {
    if (e.role !== "textbox" || plan.has(labelKey(e))) continue;
    if ((e.value ?? "").trim()) wrong.push(`"${e.name.slice(0, 60)}" came with a value the page put there ("${(e.value ?? "").slice(0, 30)}"); the flow does not send what it did not write`);
  }
  if (wrong.length) return { status: "parked", reasons: wrong, scam: false };

  // 4. Intent, then the click
  const submit = after.find((e) => e.role === "button" && /submit/i.test(e.name)) ?? after.find((e) => e.role === "button" && /\bapply\b|send/i.test(e.name));
  if (!submit) return { status: "parked", reasons: ["the form has no submit button the flow can find"], scam: false };
  const hash = createHash("sha256").update(JSON.stringify([...plan.entries()].map(([k, p]) => [labelHash(k), p.value]).sort())).digest("hex").slice(0, 16);
  const intent = d.ledger.intend(d.job, hash);
  if (!intent.ok) return { status: "duplicate", why: intent.why };
  const clicked = await d.tools.call("click", { ref: submit.ref });

  // 5. What came back
  const answer = textOf(await d.tools.call("inspect", {}));
  const seen = `${titleOf(answer)}\n${visible(answer)}`;
  if (challenged(answer)) return { status: "paused-site", why: "the site showed a challenge or a rate limit after the submit; the attempt has no confirmation and is verified before any retry", seq: intent.seq };
  if (!clicked.isError && CONFIRMED.test(seen)) { d.ledger.confirm(intent.seq, "confirmation page"); return { status: "submitted", seq: intent.seq }; }
  return { status: "unverified", seq: intent.seq, why: "the page after the submit shows no confirmation; the attempt stays unaccounted for until it is verified on the site" };
}

/** After a crash, a kill or an answer that never came: look at the site, then decide. Confirmed if the site says so, failed only if it clearly shows the posting as not applied, otherwise left alone and the user asked. */
export async function verifyAttempt(tools: Tools, ledger: Ledger, row: Row, jobUrl: string): Promise<"confirmed" | "not-received" | "unknown"> {
  const opened = await tools.call("open", { url: jobUrl });
  if (opened.isError) return "unknown";
  const page = textOf(await tools.call("inspect", {}));
  if (challenged(page)) return "unknown";
  const seen = visible(page);
  if (ALREADY_APPLIED.test(seen)) { ledger.confirm(row.seq, "verified on the site"); return "confirmed"; }
  if (NOT_APPLIED.test(seen)) { ledger.fail(row.seq, "the site shows the posting as not applied"); return "not-received"; }
  return "unknown";
}

export { jobKey };
