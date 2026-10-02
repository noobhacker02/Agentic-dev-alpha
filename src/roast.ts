import { BANNED_TERMS, type HumorLevel } from "./persona.js";
import { PHASES } from "./types.js";
import type { Habits } from "./habits.js";

/**
 * `agent-loop insights` talks about *you*: how you actually use the tool, teased in the way a friend who has watched you
 * do it would tease. It is driven only by `Habits`, which is numbers and fixed labels computed from the audit database
 * (how fast approvals were answered, which phase got sent back, how much went into runs that failed). Nothing a person
 * typed (a task, a command, a rule, a file path) ever reaches a joke or a model: that is a property of the type, tested
 * with canary strings in `test/roast.mjs`.
 *
 * The rules are the persona's (docs/PERSONA.md): the target is a habit, never the person; no politics beyond the
 * process of a legislature; the same banned-term list; and every line sits next to something useful, because a roast
 * that teaches nothing is just noise. Free and deterministic offline; with `--roast api` a model writes fresh lines
 * from the same numbers (slang ages fast), every line is validated, and any failure falls back to the offline set.
 */

export { emptyHabits, QUICK_MS, type Habits } from "./habits.js";
const PHASE_SET = new Set<string>(PHASES);

// ------------------------------------------------------------------------------------------------ the catalogue

interface Line { text: string; dark?: boolean }
interface Finding {
  id: string;
  /** Not said when any of these also fires: it would be the same point made twice ("125 yeses in a blink" and "150 yeses, no nos"). */
  redundantWith?: string[];
  /** Higher is said first. */
  weight: number;
  when: (h: Habits) => boolean;
  lines: Line[];
  /** Something useful that goes with the joke. */
  tip?: string;
}

const worstPhase = (h: Habits): { phase: string; runs: number } => {
  let best = { phase: "builder", runs: 0 };
  for (const [phase, runs] of Object.entries(h.repairedRunsByPhase)) if (PHASE_SET.has(phase) && (runs ?? 0) > best.runs) best = { phase, runs: runs ?? 0 };
  return best;
};
const totalRepairedRuns = (h: Habits) => Object.values(h.repairedRunsByPhase).reduce<number>((n, x) => n + (x ?? 0), 0);

export const FINDINGS: Finding[] = [
  {
    id: "quick-yes", weight: 90,
    when: (h) => h.approvals.approved >= 8 && h.quickYes / h.approvals.approved >= 0.6,
    lines: [
      { text: "{quick} of your {approved} approvals took under 1.5 seconds. That is not a code review, that is a reflex." },
      { text: "You approve at warp speed and read at terms-and-conditions speed: {quick} yeses in under 1.5 s. Sir, this is a Wendy's." },
      { text: "Speedrun any%: {quick} approvals in under 1.5 s. The prompt shows exactly what runs. It is right there. It has a little lock." },
      { text: "{quick}/{approved} approvals in a blink. 'Vibes-based security' is not in the threat model, bestie.", dark: true },
    ],
    tip: "the prompt shows the exact command or file. If you could not read it in 1.5 seconds, you did not.",
  },
  {
    id: "flip", weight: 85,
    when: (h) => h.deniedThenAllowed >= 1,
    lines: [
      { text: "You said no to the same request and later yes, {flippedTimes}. Lowkey the model just wore you down." },
      { text: "{flippedDenials} that became approvals. Character development, or the 'are you sure?' energy won." },
      { text: "Denied, then approved the exact same thing {flippedTimes}. It's giving 'I said what I said', and then you did not.", dark: true },
    ],
    tip: "when you deny, press n and type why. The agent is told, and it stops re-asking the same thing.",
  },
  {
    id: "wasted", weight: 80,
    when: (h) => h.wastedUsd >= 1,
    lines: [
      { text: "{wasted} went into runs that did not finish. A learning experience, billed per token." },
      { text: "{wasted} on failed or stopped runs. Not financial advice, but touch grass and tighten the task." },
      { text: "{wasted} of your money is now just heat. Thank you for warming the data center.", dark: true },
    ],
    tip: "smaller tasks fail cheaper. Split it, or type a decision up front so the Overseer treats it as settled.",
  },
  {
    id: "failing", weight: 75,
    when: (h) => h.runs >= 3 && h.failed > h.done,
    lines: [
      { text: "{failed} failed runs against {done} done. That ratio is giving 'skill issue', and I am choosing to blame the prompt." },
      { text: "More failures ({failed}) than finishes ({done}). We do not have to talk about it. But we will." },
      { text: "{done} done, {failed} failed. Statistically the call is coming from inside the task description.", dark: true },
    ],
    tip: "give the Planner a smaller ask and a definition of done.",
  },
  {
    id: "worst-phase", weight: 70,
    when: (h) => worstPhase(h).runs >= 2,
    lines: [
      { text: "The {phase} got sent back in {phaseRuns} of {runs} runs. Main character energy, supporting character results." },
      { text: "{phase}: repaired in {phaseRuns} runs. Every bill gets amended; this one got a filibuster." },
      { text: "Sent back {phaseRuns} times. The {phase} has had more readings than a bill stuck in committee.", dark: true },
    ],
    tip: "put what the {phase} keeps missing into the task up front, so it is not discovered the hard way.",
  },
  {
    id: "never-denies", weight: 68, redundantWith: ["quick-yes"],
    when: (h) => h.approvals.approved >= 15 && h.approvals.denied === 0,
    lines: [
      { text: "{approved} approvals, zero denials. Either the agents are flawless, or you are a 'yes' with extra steps." },
      { text: "{approved} yeses, no nos. That is either perfection or a button you really like.", dark: true },
    ],
    tip: "the whole point of the prompt is that 'no' is available. Try it once, on purpose.",
  },
  {
    id: "repeat-task", weight: 65,
    when: (h) => h.repeatedTaskMax >= 3,
    lines: [
      { text: "You ran the same task {repeats} times. Groundhog Day, but billable." },
      { text: "One task, {repeats} runs. At some point it is not the model, it is the sequel nobody asked for." },
    ],
    tip: "if one task keeps needing re-runs, split it, or write down the decision that keeps getting lost.",
  },
  {
    id: "unused-rules", weight: 60,
    when: (h) => h.rulesNeverReused >= 3,
    lines: [
      { text: "{unused} 'don't ask again' rules created and never used. Like gym memberships in February." },
      { text: "{unused} saved rules, zero reuses. Collecting them like Pokémon, except none of them evolve." },
    ],
    tip: "a rule lasts one run. Save one only for something you expect to run many times.",
  },
  {
    id: "desktop", weight: 58,
    when: (h) => h.desktop.sent >= 5,
    lines: [
      { text: "You let it click real windows {dsentTimes}, and the tools' own checks stopped {dstopped} more. Bold. Thank goodness for the denylist." },
      { text: "{dsent} real clicks and keystrokes into a real window. Main quest: 'trust but verify'. Side quest: 'mostly trust'.", dark: true },
    ],
  },
  {
    id: "night", weight: 55,
    when: (h) => h.nightRuns >= 2,
    lines: [
      { text: "{night} runs started between midnight and 5 a.m. Bold of you to assume the agents are the ones who need sleep." },
      { text: "{night} runs after midnight. -500 aura, plus whatever the tokens cost." },
      { text: "Your commit history will say 'fix' and mean 'help'. That is {night} runs after midnight.", dark: true },
    ],
    tip: "a run you start in the middle of the night still needs you awake for the approvals.",
  },
  {
    id: "many-denials", weight: 52,
    when: (h) => h.approvals.denied >= 6 && h.approvals.denied > h.approvals.approved,
    lines: [
      { text: "You denied more than you approved ({denied} against {approved}). Trust issues? Valid. Zero notes." },
      { text: "{denied} noes, {approved} yeses. The agents are on a probation period and it is going great.", dark: true },
    ],
  },
  {
    id: "abandoned", weight: 62,
    when: (h) => h.abandoned >= 2,
    lines: [
      { text: "{abandoned} runs are still marked 'running' from long ago. Closing the laptop mid-run is not a workflow, it is a ghost story." },
      { text: "{abandoned} runs never said goodbye: no end, no report, still 'running'. Respectfully, that is a group project nobody closed.", dark: true },
    ],
    tip: "Ctrl-C (or the stop button on the page) saves a run as stopped, with its report. Closing the terminal or a force-quit cannot.",
  },
  {
    id: "stopped", weight: 50,
    when: (h) => h.stopped >= 2,
    lines: [
      { text: "{stopped} runs stopped halfway. Ctrl-C is not a personality trait." },
      { text: "Rage-quit counter: {stopped}. Respect for the commitment to leaving." },
    ],
  },
  {
    id: "repairs", weight: 48,
    when: (h) => totalRepairedRuns(h) >= 5,
    lines: [
      { text: "{repairs} phase repairs in total. That is a filibuster with extra steps." },
      { text: "{repairs} repairs. At this point the repair loop has quorum.", dark: true },
    ],
  },
  {
    id: "long-run", weight: 45,
    when: (h) => h.longestRunMin >= 90,
    lines: [
      { text: "Longest run: {longest} minutes. A feature film with no director and your API budget as the lead." },
      { text: "A {longest}-minute run. Touch grass, the agents will wait. They have no choice.", dark: true },
    ],
  },
  {
    id: "clean", weight: 40,
    when: (h) => h.runs >= 3 && h.failed === 0 && h.stopped === 0 && h.deniedThenAllowed === 0,
    lines: [
      { text: "No failures, no flips, no rage-quits. This is unsettling. Are you okay?" },
      { text: "A clean record. Suspiciously clean. Ohio levels of suspicious.", dark: true },
    ],
  },
  {
    id: "slow", weight: 30,
    when: (h) => h.slowestAnswerMin >= 10,
    lines: [
      { text: "Your slowest answer took {slowest} minutes. The agent waited. It is fine. It has no feelings. Allegedly." },
    ],
  },
  {
    id: "small-sample", weight: 20,
    when: (h) => h.runs > 0 && h.runs <= 2,
    lines: [
      { text: "Only {runsCount} so far. Small sample size, big feelings." },
      { text: "{runsCount} so far is not a pattern, it is a vibe. Come back with more data." },
    ],
  },
];

/** Placeholders a line may use, and what each one is filled with. Anything else is a lint failure. */
export const PLACEHOLDERS = ["quick", "approved", "denied", "flipped", "flippedTimes", "flippedDenials", "wasted", "failed", "done", "stopped", "phase", "phaseRuns", "runs", "runsCount", "abandoned", "unused", "night", "repeats", "dsent", "dsentTimes", "dstopped", "repairs", "longest", "slowest"] as const;

const money = (n: number) => "$" + n.toFixed(2);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function varsFor(h: Habits): Record<(typeof PLACEHOLDERS)[number], string> {
  const w = worstPhase(h);
  return {
    quick: String(h.quickYes), approved: String(h.approvals.approved), denied: String(h.approvals.denied), flipped: String(h.deniedThenAllowed),
    wasted: money(h.wastedUsd), failed: String(h.failed), done: String(h.done), stopped: String(h.stopped), phase: w.phase, phaseRuns: String(w.runs),
    flippedTimes: plural(h.deniedThenAllowed, "time", "times"), flippedDenials: plural(h.deniedThenAllowed, "denial", "denials"),
    abandoned: String(h.abandoned), runs: String(h.runs), runsCount: plural(h.runs, "run", "runs"), dsentTimes: plural(h.desktop.sent, "time", "times"), unused: String(h.rulesNeverReused), night: String(h.nightRuns), repeats: String(h.repeatedTaskMax),
    dsent: String(h.desktop.sent), dstopped: String(h.desktop.stopped), repairs: String(totalRepairedRuns(h)),
    longest: String(Math.round(h.longestRunMin)), slowest: String(Math.round(h.slowestAnswerMin)),
  };
}

export function fillRoast(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
}

// ------------------------------------------------------------------------------------------------ the grade

/** A usage grade, from the numbers. It grades the habits, not you. */
export function gradeFor(h: Habits): string {
  if (h.runs === 0) return "n/a";
  // Outcomes first. A stopped run costs nothing (stopping early is the right thing to do, and the Stop button exists so that you will), and
  // an unused rule is trivia. A run killed so hard it never said goodbye does cost a little: that is the habit Ctrl-C replaces.
  let score = 100;
  score -= 40 * (h.failed / h.runs);
  if (h.approvals.approved >= 8) score -= 15 * (h.quickYes / h.approvals.approved);
  score -= 4 * Math.min(h.deniedThenAllowed, 3);
  score -= 3 * Math.min(h.abandoned, 3);
  score -= 1 * Math.min(h.rulesNeverReused, 3);
  score -= 8 * Math.min(1, totalRepairedRuns(h) / Math.max(1, h.runs * 2));
  score = Math.max(0, Math.min(100, score));
  const bands: Array<[number, string]> = [[93, "A"], [90, "A-"], [87, "B+"], [83, "B"], [80, "B-"], [77, "C+"], [73, "C"], [70, "C-"], [60, "D"]];
  return bands.find(([min]) => score >= min)?.[1] ?? "F";
}

const GRADE_COMMENTS: Record<string, Line[]> = {
  A: [{ text: "Ate. Left no crumbs." }, { text: "S-tier. Do not let it go to your head.", dark: true }],
  B: [{ text: "Solid. Mid, in the best possible way." }, { text: "Good enough that nobody has to have a meeting about it." }],
  C: [{ text: "It's giving participation trophy." }, { text: "Passing. The group chat has questions, but passing." }],
  D: [{ text: "Cooked, but recoverable." }, { text: "A rough semester, to be fair to you." }],
  F: [{ text: "We do not speak of the F." }, { text: "Skill issue, but it is a fixable skill.", dark: true }],
};

// ------------------------------------------------------------------------------------------------ choosing lines

/** Small deterministic hash: the same numbers give the same roast, and a change in the numbers can change it. */
function hash(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return x >>> 0;
}
export const habitsKey = (h: Habits) => JSON.stringify(h);

export interface Roast {
  lines: string[];
  tips: string[];
  grade: string;
  gradeComment: string;
  /** Which findings fired, in the order they were said. */
  findings: string[];
}

export function roast(h: Habits, level: HumorLevel, maxLines = 3): Roast {
  const empty: Roast = { lines: [], tips: [], grade: gradeFor(h), gradeComment: "", findings: [] };
  if (level === "off" || h.runs === 0) return empty;
  const seed = hash(habitsKey(h));
  const vars = varsFor(h);
  const all = FINDINGS.filter((f) => f.when(h));
  const firedIds = new Set(all.map((f) => f.id));
  const fired = all.filter((f) => !f.redundantWith?.some((id) => firedIds.has(id))).sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const lines: string[] = [], tips: string[] = [], findings: string[] = [];
  for (const f of fired) {
    if (lines.length >= maxLines) break;
    const pool = f.lines.filter((l) => level === "dark" || !l.dark);
    if (!pool.length) continue;
    lines.push(fillRoast(pool[(seed + hash(f.id)) % pool.length].text, vars));
    findings.push(f.id);
    if (f.tip && tips.length < 2) tips.push(fillRoast(f.tip, vars));
  }
  const grade = gradeFor(h);
  const comments = (GRADE_COMMENTS[grade[0]] ?? []).filter((l) => level === "dark" || !l.dark);
  const gradeComment = comments.length ? comments[(seed >>> 3) % comments.length].text : "";
  return { lines, tips, grade, gradeComment, findings };
}

// ------------------------------------------------------------------------------------------------ the catalogue's own lint

export const MAX_LINE = 170;
export const BANNED = BANNED_TERMS;

/** Problems with a line of text, whoever wrote it (this file or a model). Empty when it is fine. */
export function lintLine(text: string, allowedNumbers?: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (text.length > MAX_LINE) problems.push(`longer than ${MAX_LINE} characters`);
  if (text.length < 12) problems.push("too short to be a line");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩​-‏]/.test(text)) problems.push("control, bidi or zero-width character");
  if (/[`]|\]\(|:\/\/|<[a-z/!]/i.test(text)) problems.push("markup, link or code in a joke");
  const lower = ` ${text.toLowerCase()} `;
  for (const term of BANNED_TERMS) {
    const re = new RegExp(`(^|[^a-z])${term.trim().replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([^a-z]|$)`, "i");
    if (re.test(lower)) problems.push(`banned term "${term.trim()}"`);
  }
  if (allowedNumbers) {
    for (const n of text.match(/\d+(?:\.\d+)?/g) ?? []) if (!allowedNumbers.has(n)) problems.push(`a number that is not in your data: ${n}`);
  }
  return problems;
}

/** Problems with the offline catalogue itself; empty when it is sound. */
export function lintRoastCatalogue(): string[] {
  const problems: string[] = [];
  const allowed = new Set<string>(PLACEHOLDERS);
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (const f of FINDINGS) {
    if (ids.has(f.id)) problems.push(`${f.id}: duplicate id`);
    ids.add(f.id);
    if (!f.lines.length) problems.push(`${f.id}: no lines`);
    if (!f.lines.some((l) => !l.dark)) problems.push(`${f.id}: needs a line for the dry level, so "dry" is never empty for it`);
    for (const text of [...f.lines.map((l) => l.text), ...(f.tip ? [f.tip] : [])]) {
      const where = `${f.id}: "${text}"`;
      if (seen.has(text)) problems.push(`${where}: duplicate`);
      seen.add(text);
      for (const ph of text.match(/\{[^}]*\}/g) ?? []) if (!allowed.has(ph.slice(1, -1) as never)) problems.push(`${where}: unknown placeholder ${ph}`);
      if (/[{}]/.test(text.replace(/\{[^}]*\}/g, ""))) problems.push(`${where}: stray brace`);
      // digits are only allowed where they are a fixed threshold the text states ("1.5 seconds", "5 a.m.")
      for (const p of lintLine(text.replace(/\{[^}]*\}/g, "0"), new Set(["0", "1.5", "5", "500"]))) problems.push(`${where}: ${p}`);
    }
  }
  for (const [g, lines] of Object.entries(GRADE_COMMENTS)) for (const l of lines) for (const p of lintLine(l.text)) problems.push(`grade ${g}: ${l.text}: ${p}`);
  return problems;
}

// ------------------------------------------------------------------------------------------------ optional: a model writes fresh lines

/** What the model is told. It contains the habits and the fired findings, and nothing a person typed. */
export function buildRoastPrompt(h: Habits, level: HumorLevel, r: Roast): { system: string; prompt: string } {
  const system = [
    "You write a few short, funny lines about how someone has been using a developer tool, from numbers only.",
    "Voice: a friend who has watched them use it, fluent in current internet slang and memes (use what is current and widely understood).",
    "Rules, all of them: tease the HABIT, never the person; no insults, no profanity, no slurs; nothing about identity, religion or politics",
    "(a legislature's procedure is fine: filibuster, committee, quorum, veto); no real people; no code, links or markdown.",
    "Use only the numbers you are given, and put the specific number of the finding into its line. Never invent a figure.",
    `Level: ${level === "dark" ? "dark humor allowed but never cruel" : "dry, wholesome"}.`,
    "Output ONLY a JSON array of strings, one line per finding, each under 160 characters. No preface.",
  ].join("\n");
  const vars = varsFor(h);
  const facts = r.findings.map((id) => {
    const f = FINDINGS.find((x) => x.id === id)!;
    return `- ${id}: ${fillRoast(f.lines[0].text, vars)}`;
  });
  const prompt = [
    "The person's usage, as numbers:",
    JSON.stringify(h),
    "",
    "Findings to write one fresh line each about (a plain version of each is shown; do not copy it, say it better and funnier):",
    ...facts,
    "",
    "Tone examples (do not reuse): 'It's giving participation trophy.' / 'Skill issue, but a fixable one.' / 'Ate. Left no crumbs.'",
  ].join("\n");
  return { system, prompt };
}

/** Every number a model's line may contain: the habits' own, formatted the ways a line would. */
export function allowedNumbersFor(h: Habits): Set<string> {
  const out = new Set<string>(["1.5"]);
  const add = (n: number) => { out.add(String(n)); out.add(String(Math.round(n))); out.add(n.toFixed(2)); out.add(n.toFixed(1)); };
  const v = varsFor(h);
  for (const x of Object.values(v)) for (const m of x.match(/\d+(?:\.\d+)?/g) ?? []) out.add(m);
  for (const n of [h.runs, h.done, h.failed, h.stopped, h.abandoned, h.totalCostUsd, h.wastedUsd, h.priciestRunUsd, h.approvals.asked, h.approvals.approved, h.approvals.denied, h.approvals.auto, h.quickYes, h.slowestAnswerMin, h.deniedThenAllowed, h.rulesCreated, h.rulesNeverReused, h.nightRuns, h.repeatedTaskMax, h.longestRunMin, h.desktop.sent, h.desktop.stopped, h.desktop.approved, h.desktop.denied]) add(n);
  return out;
}

/** Accepts only well-formed, safe, honest lines from whatever a model returned. */
export function acceptModelLines(raw: string, h: Habits, offline: readonly string[] = [], max = 4): string[] {
  const start = raw.indexOf("["), end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const allowed = allowedNumbersFor(h);
  const seen = new Set(offline);
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const text = item.replace(/\s+/g, " ").trim();
    if (!text || seen.has(text) || lintLine(text, allowed).length) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

export type Generate = (req: { system: string; prompt: string }) => Promise<{ text: string; costUsd: number }>;

export interface ModelRoast { lines: string[]; costUsd: number; note?: string }

/** Fresh lines from a model. Never throws: any failure, or too few valid lines, comes back as `lines: []` with a plain note. */
export async function roastWithModel(h: Habits, level: HumorLevel, generate: Generate, timeoutMs = 60_000): Promise<ModelRoast> {
  const base = roast(h, level);
  if (level === "off" || base.findings.length === 0) return { lines: [], costUsd: 0, note: "nothing to say yet" };
  const { system, prompt } = buildRoastPrompt(h, level, base);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      generate({ system, prompt }),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs); }),
    ]);
    const lines = acceptModelLines(res.text, h, base.lines);
    if (lines.length < 2) return { lines: [], costUsd: res.costUsd, note: "the model's lines did not pass the checks, so here is the built-in set" };
    return { lines, costUsd: res.costUsd };
  } catch (err) {
    return { lines: [], costUsd: 0, note: `could not reach the model (${err instanceof Error ? err.message.replace(/\s+/g, " ").slice(0, 120) : "unknown error"}), so here is the built-in set` };
  } finally {
    clearTimeout(timer);
  }
}
