/**
 * agent-loop's voice. The person running a coding agent for hours should be able to smile at it, so the
 * run has a personality: each agent has a temperament, the Overseer behaves like a legislature with a
 * veto, and the tool comments, with some bite, on how it is being used (an approval clicked in a blink, a
 * fourth repair, a run that failed). Dry by default, dark when allowed, never cruel. The full rules and the
 * checklist for adding a line are in docs/PERSONA.md; the ones that can break something are enforced here
 * and by test/persona.mjs:
 *
 *  - This is display only. Nothing here is imported by anything that builds text for a model
 *    (test/persona.mjs checks the import graph), so a joke can never change what an agent does or says.
 *  - Lines are a fixed catalog. The only things interpolated are a phase name from the enum and numbers,
 *    each re-validated on the way in. Nothing a page, a window, a file or a model wrote can reach a line.
 *  - Notes are separate, dimmed lines emitted after the event they remark on. They never replace or sit
 *    inside an approval prompt, an action description or a refusal reason.
 *  - Targets: the agents, the process, git, CI, the tool, and how the person uses the tool. Never the
 *    person's identity, looks, intelligence or health; never real people, parties, religion, groups,
 *    self-harm, violence toward people or real tragedies. "Politics" means the process of a legislature
 *    (veto, amendment, committee, filibuster), never a side.
 */
import type { EventBus } from "./bus.js";
import type { AgentEvent, PhaseName } from "./types.js";
import { PHASES } from "./types.js";

export const HUMOR_LEVELS = ["off", "dry", "dark"] as const;
export type HumorLevel = (typeof HUMOR_LEVELS)[number];

export function parseHumor(value: unknown, fallback: HumorLevel = "dark"): HumorLevel | undefined {
  if (value === undefined) return fallback;
  return (HUMOR_LEVELS as readonly string[]).includes(value as string) ? (value as HumorLevel) : undefined;
}

export type Speaker = PhaseName | "overseer" | "narrator";

export const PERSONAS: Record<Speaker, { name: string; tagline: string }> = {
  planner: { name: "Planner", tagline: "optimist with a spreadsheet" },
  "test-designer": { name: "Test Designer", tagline: "pessimist, usually right" },
  builder: { name: "Builder", tagline: "ships first, explains later" },
  verifier: { name: "Verifier", tagline: "trust issues, professionally" },
  gatekeeper: { name: "Gatekeeper", tagline: "a bouncer with a checklist" },
  overseer: { name: "Overseer", tagline: "holds the veto and uses it" },
  narrator: { name: "", tagline: "" },
};

export interface Line {
  text: string;
  /** Mildly dark. Shown at level "dark" only. */
  dark?: boolean;
  /** Who says it; the narrator when omitted. */
  by?: Speaker;
  /** Only while the run has had no repairs ("clean") or has had some ("repaired"); any time when omitted. A line that
   * says "everyone before me said yes" must not be spoken after three vetoes. */
  when?: "clean" | "repaired";
}

const d = (text: string, by?: Speaker): Line => ({ text, dark: true, by });
const l = (text: string, by?: Speaker): Line => ({ text, by });
const clean = (x: Line): Line => ({ ...x, when: "clean" });
const repaired = (x: Line): Line => ({ ...x, when: "repaired" });

/** Placeholders a line may contain. Anything else is a bug (test/persona.mjs lints every line). */
export const PLACEHOLDERS = ["{phase}", "{n}", "{cost}"] as const;

export type Moment =
  | "idle"
  | "run-start"
  | `phase-start:${PhaseName}`
  | `phase-retry:${PhaseName}`
  | "run-start-night"
  | "run-start-early"
  | "run-start-friday"
  | "run-start-weekend"
  | "run-long-30"
  | "run-long-60"
  | "tools-100"
  | "tools-250"
  | "prompts-25"
  | "prompts-50"
  | "overseer-repair-many"
  | "award-answer-fast"
  | "award-answer-slow"
  | "award-sent-back"
  | "award-priciest"
  | "award-tool-hog"
  | "award-quiet"
  | "phase-pass"
  | "overseer-continue"
  | "overseer-repair"
  | "overseer-stop"
  | "approval-denied"
  | "approval-denial-streak"
  | "approval-fast"
  | "approval-slow"
  | "rule-saved"
  | "rules-many"
  | "browser-start"
  | "desktop-start"
  | "desktop-refused"
  | "cost-1"
  | "cost-5"
  | "cost-20"
  | "run-done-clean"
  | "run-done-repaired"
  | "run-failed"
  | "run-stopped"
  | "insights-empty"
  | "insights-mostly-failed"
  | "insights-repairs"
  | "insights-many-rules"
  | "insights-denies-more"
  | "insights-never-denies"
  | "insights-default";

export const CATALOG: Record<Moment, Line[]> = {
  idle: [
    l("Waiting for a run to start."),
    l("Idle. Even the Overseer needs a moment."),
    l("No run yet — the calm before the commits."),
    l("Standing by. Coffee's probably cold by now."),
    l("Idle. Unlike your CI queue, this part's free."),
    l("Nothing running. Good time to write that test you've been avoiding."),
    l("Idle. No commits, no incidents — a rare and beautiful combination."),
    l("Nothing running. Your last commit message still doesn't explain what changed."),
    l("Idle. That TODO from 2019 still isn't going to fix itself."),
    l("Nothing running. Somewhere, someone's about to force-push to main."),
    d("Idle. The agents aren't dead, merely between deadlines."),
    d("Nothing running. Production is fine. Production is always fine, until it isn't."),
    d("Idle. This is fine. (The dog is holding a pager.)"),
    d("No run. The merge conflict you're avoiding has started charging interest."),
    d("Idle. git blame: a time machine that only ever shows you yourself."),
    d("Standing by. Legend says someone once wrote the documentation before the code."),
    d("Idle. The Overseer has a veto and nothing to use it on. Give it something."),
    d("Idle. Bipartisan agreement: this page should have a run on it."),
    d("Nothing running. A filibuster is just a run that never starts."),
    d("Idle. Works on my machine, says the machine, unverified."),
  ],
  "run-start": [
    l("And we're off. The Planner has a plan; reality hasn't been consulted."),
    l("Run started. Expectations: high. Budget: noted."),
    l("Five agents enter. Some of them will complain."),
    l("Kickoff. Somewhere a test is already nervous."),
    d("Run started. Hope is not a strategy; the Verifier is here to help with that."),
    d("Launching. If this goes badly, the commit history will testify."),
    d("Five agents, one task, and a log that remembers everything."),
    d("Motion to begin: carried. The committee will now disagree at length.", "overseer"),
  ],
  "phase-start:planner": [
    l("Right. Step one: a plan nobody will follow exactly.", "planner"),
    l("Scoping it. The smaller the scope, the bigger the confidence.", "planner"),
    d("Planning. Optimism is free until the invoice arrives.", "planner"),
    d("Drafting the plan. Somewhere a deadline just felt a chill.", "planner"),
    l("Reading the task twice. The second time is for the parts nobody wrote down.", "planner"),
    d("Planning. Every unwritten requirement is a future incident.", "planner"),
  ],
  "phase-start:test-designer": [
    l("Writing the tests before anyone can argue with them.", "test-designer"),
    l("Listing the ways this could break. It's a short list; the list is long.", "test-designer"),
    d("I've seen how this ends. Writing it down as a test.", "test-designer"),
    d("Brainstorming failure modes. Enthusiastically.", "test-designer"),
    l("Plan received. I have concerns, and a spreadsheet of my own.", "test-designer"),
    d("The plan says 'should work'. I've drafted the eulogy.", "test-designer"),
  ],
  "phase-start:builder": [
    l("Building. The diff will be small and the explanation longer.", "builder"),
    l("Typing with confidence, which is not evidence.", "builder"),
    d("Shipping first; apologizing is a separate ticket.", "builder"),
    d("Building. If it compiles, it's basically legal.", "builder"),
    l("Tests received. Very demanding. I'll make them pass, eventually.", "builder"),
    d("Here come the tests. I'll treat them as suggestions; the Verifier won't.", "builder"),
  ],
  "phase-start:verifier": [
    l("Verifying. I believe you, in the legal sense of 'show me'.", "verifier"),
    l("Running it myself. Your word counts as a suggestion.", "verifier"),
    d("Trust is a vulnerability. Patching it.", "verifier"),
    d("Checking the claims. Claims have a mortality rate.", "verifier"),
    l("Builder says it works. Builder says a lot of things.", "verifier"),
    d("The Builder's report is in. Time to find out which parts are fiction.", "verifier"),
  ],
  "phase-start:gatekeeper": [
    l("Gate's closed until the checklist says otherwise.", "gatekeeper"),
    l("Final review. Nothing ships on vibes.", "gatekeeper"),
    d("On duty. Nobody is getting in on charm.", "gatekeeper"),
    d("Last stop. Rejected changes rest in the reflog.", "gatekeeper"),
    l("Verifier signed off. I'm going to look anyway.", "gatekeeper"),
    clean(d("Everyone before me said yes. That's usually when I find it.", "gatekeeper")),
    repaired(d("After all that iterating, I intend to be difficult.", "gatekeeper")),
    repaired(l("A lot of back and forth to get here. Let me see what survived.", "gatekeeper")),
  ],
  "phase-pass": [
    repaired(l("{phase} passed, at last. Nobody is cheering; everybody is tired.")),
    repaired(l("{phase}: green, finally. Let's not do that again.")),
    repaired(d("{phase} passed. The scars are included at no extra charge.")),
    clean(l("{phase} passed. Suspiciously smooth.")),
    l("{phase} done. The diff survived first contact."),
    clean(l("{phase}: green. Enjoy it; it's a loan.")),
    d("{phase} passed. The bugs simply haven't been introduced yet."),
    d("{phase} signed off. Another small victory for the dangerously optimistic."),
    d("{phase} passed. Somewhere, a flaky test smiles."),
  ],
  "phase-retry:planner": [
    l("Replanning, attempt {n}. The first plan met reality and lost.", "planner"),
    d("Attempt {n} at the plan. Optimism has been rebooted.", "planner"),
  ],
  "phase-retry:test-designer": [
    l("Attempt {n}. I'll adjust the tests until someone stops complaining.", "test-designer"),
    d("Attempt {n}. I said it would break. I'd like that noted.", "test-designer"),
  ],
  "phase-retry:builder": [
    l("Attempt {n}. I prefer the term 'iterating'.", "builder"),
    l("Back again, attempt {n}, with feedback and mild resentment.", "builder"),
    d("Attempt {n}. The first draft is dead; long live the second.", "builder"),
    d("Attempt {n}. Scar tissue is just commit history with feelings.", "builder"),
  ],
  "phase-retry:verifier": [
    l("Round {n}. Same suspicion, new evidence.", "verifier"),
    d("Round {n}. Trust is still a vulnerability.", "verifier"),
  ],
  "phase-retry:gatekeeper": [
    l("Review again, attempt {n}. The checklist hasn't changed; the diff has.", "gatekeeper"),
    d("Attempt {n}. The bouncer remembers your face.", "gatekeeper"),
  ],
  "run-start-night": [
    l("It's the middle of the night. The agents don't sleep; you might want to."),
    l("A late-night run. The best bugs get written after midnight."),
    d("Running at this hour. The commit history will not be flattering."),
    d("Night shift. A better-rested version of you is judging this schedule."),
  ],
  "run-start-early": [
    l("An early run. The agents are awake; the coffee is optional."),
    d("An early start. The bugs are still asleep. Move quietly."),
  ],
  "run-start-friday": [
    l("A Friday afternoon run. Bold."),
    d("Friday afternoon. This is how weekends get cancelled."),
  ],
  "run-start-weekend": [
    l("A weekend run. The agents don't get weekends; they share that with on-call."),
    d("Weekend work. The backlog respects no calendar."),
  ],
  "run-long-30": [
    l("Thirty minutes in. The agents are fine; you may want some water."),
    d("Half an hour. Somewhere a sprint goal is quietly rewriting itself."),
  ],
  "run-long-60": [
    l("An hour in. At this point it's a relationship."),
    d("An hour. The agents have started to recognise your approval rhythm."),
  ],
  "tools-100": [
    l("100 tool calls so far. Somebody is reading a lot of files."),
    d("100 tool calls. The Builder never met a file it didn't want to open."),
  ],
  "tools-250": [
    l("250 tool calls. That is a lot of looking for a small change."),
    d("250 tool calls. The repository has been examined, interrogated and released."),
  ],
  "prompts-25": [
    l("Prompt number 25. You are the bottleneck, and a good one."),
    d("25 prompts answered. The agents consider you their manager, and also their weather."),
  ],
  "prompts-50": [
    l("That's 50 prompts. At this point the approvals are a love language."),
    d("50 prompts. The trust fall has become a trust marathon."),
  ],
  "overseer-repair-many": [
    l("Veto number {n} this run. The Overseer is enjoying this a little.", "overseer"),
    l("Repair number {n}. The word 'iteration' is doing heavy lifting.", "overseer"),
    d("Veto {n}. At this point it's less a review than a hobby.", "overseer"),
    d("{n} repairs and counting. The budget would like a word, and a lawyer.", "overseer"),
  ],
  "award-answer-fast": [
    l("Your average answer time: {n}s. The agents have learned your rhythm, and not to rely on it."),
    l("About {n}s per approval. Skimming is a skill. So is regret."),
    d("You answered in about {n}s each time. A very trusting soul or a very fast reader."),
  ],
  "award-answer-slow": [
    l("Your average answer took {n}s. The agents used the time to reflect, then to wait."),
    d("About {n}s per answer. The agents have taken up a hobby."),
  ],
  "award-sent-back": [
    l("Most sent back: {phase}, {n} time(s). Resilient, or just stubborn."),
    l("{phase} was sent back {n} time(s). It builds character, supposedly."),
    d("{phase} got sent back {n} time(s). The Overseer has stopped saying please."),
  ],
  "award-priciest": [
    l("Most expensive agent: {phase}, at ${cost}. It has expensive taste."),
    l("{phase} spent ${cost}, the most of anyone. Big thinker, bigger invoice."),
    d("{phase} cost ${cost}. The accountant has questions and a long memory."),
  ],
  "award-tool-hog": [
    l("Most tool calls: {phase}, with {n}. Thorough or anxious; the log can't tell."),
    d("{phase} made {n} tool calls. It never met a file it didn't want to read."),
  ],
  "award-quiet": [
    l("Zero prompts this run. Everything was read-only or already trusted."),
    d("Not a single prompt. Either well-trusted agents or a very quiet crime scene."),
  ],
  "overseer-continue": [
    clean(l("Proceed. The record shows no objection.", "overseer")),
    repaired(l("Proceed, for now. The record shows several objections.", "overseer")),
    l("Continue. Nobody filed an appeal.", "overseer"),
    d("Continue. The veto stays in my pocket, loaded.", "overseer"),
    d("Carried. The opposition was a flaky test and has been dismissed.", "overseer"),
  ],
  "overseer-repair": [
    l("Sending it back for repairs. Amendment pending.", "overseer"),
    l("Repair. A second reading is scheduled.", "overseer"),
    d("Vetoed. The phase may appeal to nobody.", "overseer"),
    d("Checks and balances, working as designed. Sadly.", "overseer"),
    d("Motion to fix it: carried. Motion to stop breaking it: tabled.", "overseer"),
    d("Point of order: that was not done. Try again.", "overseer"),
  ],
  "overseer-stop": [
    l("Calling it. Some runs end in a hearing.", "overseer"),
    l("Stopping here. The record will be kept.", "overseer"),
    d("Halting the run. A moment of silence for the budget.", "overseer"),
    d("Run terminated. The committee thanks no one.", "overseer"),
  ],
  "approval-denied": [
    l("Denied. The agent has noted your standards."),
    l("No. Decisive, and slightly terrifying for the agent."),
    l("Rejected. The agent will reflect on its choices, briefly."),
    d("Denied. Somewhere an agent is updating its résumé."),
    d("A firm no. The agent feels it in whatever it has instead of feelings."),
    d("Rejected. The action joins the great reflog in the sky."),
  ],
  "approval-denial-streak": [
    l("Three no's in a row. The agent may be getting the message."),
    l("That's three refusals. The Overseer is considering mediation."),
    d("Three denials. The agent's confidence is now a rumor."),
    d("Streak of no: 3. Persistence is a virtue until it's a filibuster."),
  ],
  "approval-fast": [
    l("That was quick. Did you read it, or did you feel it?"),
    l("Approved in a blink. Trust, but verify; you skipped the second part."),
    l("Speed-approving. The agents love you; the auditor, less so."),
    d("Approved at the speed of trust. Sleep well."),
    d("Click, click, approve. Bold strategy. Let's see if the logs agree."),
  ],
  "approval-slow": [
    l("Welcome back. The agents aged a little."),
    l("That took a while. The agents used the time to rehearse."),
    d("The agents waited. It's the one thing they don't complain about."),
    d("Two minutes of silence. The Overseer held a vigil."),
  ],
  "rule-saved": [
    l("Standing rule saved. The agents will remember it, for this run only."),
    l("New rule. Delegation has entered the chat."),
    d("You've delegated. The agents sense it, politely."),
    d("Rule created. Bureaucracy, but for your own benefit."),
  ],
  "rules-many": [
    l("Three standing rules. You're running a small government."),
    d("That's a lot of standing rules. The agents are now the civil service."),
  ],
  "browser-start": [
    l("Browser up. A tiny Chromium, local pages only, no wandering."),
    l("The browser is open and on a short leash."),
    d("Browser launched. The internet is out there; it is not invited."),
    d("Chromium is awake. It has been told which URLs it may love."),
  ],
  "desktop-start": [
    l("One window, one agent, and every click asks first."),
    l("Desktop target locked. The agent gets one window and a chaperone."),
    d("The agent has been given exactly one window and no illusions."),
    d("One window. No Alt+Tab, no escape, one polite chaperone."),
  ],
  "desktop-refused": [
    l("A fence held. The agent was told no, politely."),
    l("Refused at the gate. The window stays as it was."),
    d("The fence did its job. The agent learned something about boundaries."),
    d("Blocked. Some doors are load-bearing."),
  ],
  "cost-1": [
    l("$1 so far. A coffee, roughly, if the coffee is bad."),
    l("$1 crossed. Still cheaper than a meeting."),
    d("$1 spent. The agents have no concept of money; you do."),
  ],
  "cost-5": [
    l("$5. That's lunch, or one very thorough refactor."),
    d("$5 and counting. Nobody is tracking it except you and the invoice."),
    d("$5. The budget was a suggestion the agents never received."),
  ],
  "cost-20": [
    l("$20. At this point it's a hobby."),
    d("$20. The accountant has entered the chat."),
  ],
  "run-done-clean": [
    l("Clean run, no repairs. Mark the calendar."),
    l("Done on the first pass. Suspicious, but we'll take it."),
    d("Flawless. The bugs are merely hiding; the Gatekeeper checked the obvious places."),
  ],
  "run-done-repaired": [
    l("Done, after {n} repair(s). Character building."),
    l("Finished, with {n} repair(s). The journey was the bug."),
    d("Done after {n} repair(s). Scar tissue is just commit history."),
    d("Delivered after {n} repair(s). Some survivors are merely cosmetic."),
  ],
  "run-failed": [
    l("It failed. The report has the details; the agents have excuses."),
    l("Run failed. Bugs: 1, Overseer: 0."),
    d("Run failed. The cause of death is in the report; the eulogy is yours."),
    d("Failed. The files endure. The run does not."),
    d("The run is dead. Long live the next run."),
  ],
  "run-stopped": [
    l("Stopped. The agents accept your authority, publicly."),
    d("Run stopped mid-thought. It didn't see it coming. Nothing ever does."),
  ],
  "insights-empty": [l("No runs yet. Nothing to judge, so you're safe for now.")],
  "insights-mostly-failed": [
    l("More failed runs than finished ones. The agents would like a word with the task descriptions."),
    d("Failed runs outnumber finished ones. Somebody's spec has a body count."),
  ],
  "insights-repairs": [
    l("Most runs needed repairs. That's not a bug; it's the Overseer earning its salary."),
    d("Repairs everywhere. The Overseer has asked for hazard pay."),
  ],
  "insights-many-rules": [
    l("Plenty of saved rules. The agents are the civil service; you are the legislature."),
    d("Lots of standing rules. The bureaucracy of trust is alive and well."),
  ],
  "insights-denies-more": [
    l("You deny more than you approve. The agents respect that, and fear it."),
    d("More no's than yes's. The agents have learned to ask nicely."),
  ],
  "insights-never-denies": [
    l("Plenty of approvals, zero denials. Either the agents are perfect or the reading is optional."),
    d("Zero denials. The agents have concluded you are a saint or a dashboard."),
  ],
  "insights-default": [
    l("That's the record. Judge it kindly; the agents won't."),
    d("The data is in. It isn't personal; it's just data, and it remembers."),
  ],
};

// ---------- picking

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface PickVars {
  phase?: PhaseName;
  n?: number;
  cost?: number;
}

/** The text of a line with its placeholders filled in from validated values only; undefined when a
 * placeholder's value is missing or isn't what it should be (a line is never shown half-filled). */
export function fill(text: string, vars: PickVars = {}): string | undefined {
  let out = text;
  if (out.includes("{phase}")) {
    if (!vars.phase || !(PHASES as readonly string[]).includes(vars.phase)) return undefined;
    out = out.replaceAll("{phase}", PERSONAS[vars.phase].name);
  }
  if (out.includes("{n}")) {
    if (typeof vars.n !== "number" || !Number.isInteger(vars.n) || vars.n < 0 || vars.n > 9999) return undefined;
    out = out.replaceAll("{n}", String(vars.n));
  }
  if (out.includes("{cost}")) {
    if (typeof vars.cost !== "number" || !Number.isFinite(vars.cost) || vars.cost < 0 || vars.cost > 1e6) return undefined;
    out = out.replaceAll("{cost}", vars.cost.toFixed(2));
  }
  return out;
}

export interface Picked {
  text: string;
  /** The catalog text before placeholders were filled: what a run remembers it has already used. */
  template: string;
  dark: boolean;
  by: Speaker;
}

/**
 * One line for a moment at a level, chosen deterministically from `seed` and `counter` (so a run's
 * commentary is reproducible and testable, not random). `used` is the templates this run has already
 * spoken: a fresh one is preferred, so "Enjoy it; it's a loan" doesn't come out twice in one run just
 * because two different phases passed. "off" returns nothing; "dry" never returns a dark line.
 */
export function pick(moment: Moment, level: HumorLevel, seed: string, counter = 0, vars: PickVars = {}, used?: ReadonlySet<string>, repaired?: boolean): Picked | undefined {
  if (level === "off") return undefined;
  const eligible = (CATALOG[moment] ?? []).filter((x) => (level === "dark" || !x.dark) && (repaired === undefined || !x.when || (x.when === "repaired") === repaired));
  const filled = eligible.map((x) => ({ x, text: fill(x.text, vars) })).filter((e): e is { x: Line; text: string } => e.text !== undefined);
  if (!filled.length) return undefined;
  const fresh = filled.filter((e) => !used?.has(e.x.text));
  const pool = fresh.length ? fresh : filled;
  const e = pool[fnv1a(`${seed}|${moment}|${counter}`) % pool.length];
  return { text: e.text, template: e.x.text, dark: Boolean(e.x.dark), by: e.x.by ?? "narrator" };
}

/** What the web UI needs, served as /persona.js: the idle lines, the personas, and the ceiling the run
 * was started with. Only catalog text; nothing from any run. */
export function uiData(maxLevel: HumorLevel) {
  return {
    maxLevel,
    idle: CATALOG.idle.map((x) => ({ text: x.text, dark: Boolean(x.dark) })),
    personas: Object.fromEntries(Object.entries(PERSONAS).map(([k, v]) => [k, v])),
  };
}

// ---------- insights footer

export interface InsightsLike {
  totalRuns: number;
  byStatus: Record<string, number>;
  byPhase: Array<{ runs: number; repairedRuns: number }>;
  topRules: Array<{ count: number }>;
  desktop: { humanApproved: number; humanDenied: number };
}

export function insightsMoment(i: InsightsLike): Moment {
  if (i.totalRuns === 0) return "insights-empty";
  const done = i.byStatus.done ?? 0;
  const failed = i.byStatus.failed ?? 0;
  if (failed > done) return "insights-mostly-failed";
  const repaired = Math.max(0, ...i.byPhase.map((p) => p.repairedRuns));
  if (i.totalRuns >= 2 && repaired * 2 >= i.totalRuns) return "insights-repairs";
  const dk = i.desktop;
  if (dk.humanDenied > dk.humanApproved) return "insights-denies-more";
  if (dk.humanApproved >= 10 && dk.humanDenied === 0) return "insights-never-denies";
  if (i.topRules.length >= 5) return "insights-many-rules";
  return "insights-default";
}

export function insightsLine(i: InsightsLike, level: HumorLevel): string | undefined {
  return pick(insightsMoment(i), level, `insights|${i.totalRuns}|${i.byStatus.done ?? 0}|${i.byStatus.failed ?? 0}`)?.text;
}

// ---------- the director: turns a run's events into notes

/**
 * Pacing. A real run is minutes long with dozens of events a minute, so what speaks has to be chosen.
 * Replaying realistic runs (test/persona-sim.mjs) showed the first version getting this backwards: a flat
 * minimum gap between notes swallowed exactly the lines that carry the personality (each agent's opening
 * line, the Overseer's veto) because they come a fraction of a second after the previous note, while
 * the generic "X passed" filler took the slots. So:
 *  - KEY moments (an agent's opening line, a retry, a veto, a refusal streak, the ending, the awards) always
 *    speak, up to a cap, and may come in pairs: the Overseer's veto and the Builder's reply.
 *  - Everything else is seasoning: at least SEASONING_GAP_MS after the last note of any kind, at most
 *    MAX_SEASONING_PER_RUN a run, and often skipped (a fixed chance, decided by the run's seed).
 *  - A template isn't repeated within a run until all of that moment's templates have been used.
 */
export const MAX_NOTES_PER_RUN = 40;
export const MAX_SEASONING_PER_RUN = 12;
export const SEASONING_GAP_MS = 20_000;
export const FAST_APPROVAL_MS = 1500;
export const SLOW_APPROVAL_MS = 120_000;
export const LONG_RUN_MS = [30 * 60_000, 60 * 60_000] as const;
export const MAX_AWARDS = 2;

const KEY_MOMENT = /^(run-start|phase-start:|phase-retry:|overseer-repair|overseer-stop|approval-denial-streak|approval-fast|approval-slow|run-done|run-failed|run-stopped|award-)/;
/** The share of the time a seasoning moment speaks at all; the rest are skipped. */
const SEASONING_CHANCE: Partial<Record<Moment, number>> = { "phase-pass": 0.3, "overseer-continue": 0.3, "approval-denied": 0.6, "rule-saved": 0.7 };

interface RunState {
  seed: string;
  startMs: number;
  notes: number;
  seasoning: number;
  lastNoteAt: number;
  counters: Map<string, number>;
  used: Set<string>;
  once: Set<string>;
  repairs: number;
  repairsByPhase: Map<string, number>;
  humanAllows: number;
  denialStreak: number;
  rules: number;
  prompts: number;
  answerMs: number[];
  cost: number;
  costByPhase: Map<string, number>;
  tools: number;
  toolsByPhase: Map<string, number>;
  pendingAt: Map<string, number>;
}

const isPhase = (x: unknown): x is PhaseName => typeof x === "string" && (PHASES as readonly string[]).includes(x);
const finiteCost = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x < 1e6;
const maxEntry = (m: Map<string, number>): [string, number] | undefined => [...m.entries()].sort((a, b) => b[1] - a[1])[0];

export interface DirectorOptions {
  level: HumorLevel;
  /** Hour of day (0-23) and weekday (0 = Sunday) for a timestamp, in the person's own time zone. Injectable for tests. */
  clock?: { hourOf(ms: number): number; dayOf(ms: number): number };
}

/**
 * Listens to a bus and emits `persona-note` events. It reads only enumerated fields of events (types,
 * phase names, decisions, numbers, timestamps) and never their free text, so nothing a model, a page or a
 * window wrote can end up in a note. Notes are emitted after the event they follow has reached every
 * listener, and a failure to emit one is swallowed: commentary must never break a run.
 */
export class PersonaDirector {
  private runs = new Map<string, RunState>();
  private listener = (ev: AgentEvent) => this.onEvent(ev);
  private clock: NonNullable<DirectorOptions["clock"]>;

  constructor(private bus: EventBus, private opts: DirectorOptions) {
    this.clock = opts.clock ?? { hourOf: (ms) => new Date(ms).getHours(), dayOf: (ms) => new Date(ms).getDay() };
  }

  attach() {
    if (this.opts.level !== "off") this.bus.on("event", this.listener);
    return { detach: () => this.bus.off("event", this.listener) };
  }

  private state(runId: string, ts: string): RunState {
    let s = this.runs.get(runId);
    if (!s) {
      const at = Date.parse(ts);
      s = {
        seed: runId, startMs: Number.isFinite(at) ? at : Date.now(), notes: 0, seasoning: 0, lastNoteAt: -Infinity, counters: new Map(), used: new Set(), once: new Set(),
        repairs: 0, repairsByPhase: new Map(), humanAllows: 0, denialStreak: 0, rules: 0, prompts: 0, answerMs: [], cost: 0, costByPhase: new Map(), tools: 0,
        toolsByPhase: new Map(), pendingAt: new Map(),
      };
      this.runs.set(runId, s);
    }
    return s;
  }

  private say(ev: AgentEvent, moment: Moment, vars: PickVars = {}, opts: { once?: boolean; phase?: PhaseName; force?: boolean } = {}) {
    const s = this.state((ev as { runId: string }).runId, ev.ts);
    const at = Date.parse(ev.ts);
    const key = KEY_MOMENT.test(moment);
    if (opts.once && s.once.has(moment)) return;
    if (!opts.force) {
      if (s.notes >= MAX_NOTES_PER_RUN) return;
      if (!key) {
        if (s.seasoning >= MAX_SEASONING_PER_RUN || at - s.lastNoteAt < SEASONING_GAP_MS) return;
        const n = s.counters.get(`chance|${moment}`) ?? 0;
        s.counters.set(`chance|${moment}`, n + 1);
        const p = SEASONING_CHANCE[moment] ?? 1;
        if (p < 1 && (fnv1a(`${s.seed}|${moment}|${n}|chance`) % 1000) / 1000 >= p) return;
      }
    }
    const n = s.counters.get(moment) ?? 0;
    const picked = pick(moment, this.opts.level, s.seed, n, vars, s.used, s.repairs > 0);
    if (!picked) return;
    s.counters.set(moment, n + 1);
    s.used.add(picked.template);
    if (opts.once) s.once.add(moment);
    s.notes++;
    if (!key) s.seasoning++;
    if (Number.isFinite(at)) s.lastNoteAt = at;
    const note: AgentEvent = { type: "persona-note", runId: s.seed, phase: opts.phase, moment, text: picked.text, dark: picked.dark, speaker: picked.by, ts: ev.ts };
    // After the triggering event has been delivered to every listener, so a screen shows them in order.
    queueMicrotask(() => {
      try {
        this.bus.emitEvent(note);
      } catch {
        /* commentary must never break a run (the store may already be closed) */
      }
    });
  }

  private onEvent(ev: AgentEvent) {
    if (ev.type === "persona-note") return;
    const runId = (ev as { runId?: string }).runId;
    if (typeof runId !== "string") return;
    const s = this.state(runId, ev.ts);
    const at = Date.parse(ev.ts);

    // How long the run has been going: spoken on whatever event first shows it has crossed a mark.
    if (Number.isFinite(at)) {
      const elapsed = at - s.startMs;
      if (elapsed >= LONG_RUN_MS[1]) this.say(ev, "run-long-60", {}, { once: true });
      else if (elapsed >= LONG_RUN_MS[0]) this.say(ev, "run-long-30", {}, { once: true });
    }

    switch (ev.type) {
      case "run-start": {
        const h = this.clock.hourOf(at), day = this.clock.dayOf(at);
        // An unreadable timestamp gives NaN, which compares false everywhere, so it lands on the plain opening.
        const moment: Moment = h < 5 ? "run-start-night" : h < 7 ? "run-start-early" : day === 5 && h >= 15 ? "run-start-friday" : day === 0 || day === 6 ? "run-start-weekend" : "run-start";
        this.say(ev, moment, {}, { force: true });
        break;
      }
      case "phase-start":
        if (!isPhase(ev.phase)) break;
        // The attempt number is only ever shown through fill(), which accepts a whole number from 0 to 9999 and nothing else.
        if (ev.attempt === 1) this.say(ev, `phase-start:${ev.phase}`, {}, { phase: ev.phase });
        else this.say(ev, `phase-retry:${ev.phase}`, { n: ev.attempt }, { phase: ev.phase });
        break;
      case "overseer-decision": {
        const a = ev.decision.action;
        if (a === "repair") {
          s.repairs++;
          const target = isPhase(ev.decision.repairTarget) ? ev.decision.repairTarget : ev.phase;
          if (isPhase(target)) s.repairsByPhase.set(target, (s.repairsByPhase.get(target) ?? 0) + 1);
          this.say(ev, s.repairs >= 3 ? "overseer-repair-many" : "overseer-repair", { n: s.repairs }, { phase: isPhase(ev.phase) ? ev.phase : undefined });
        } else if (a === "stop") {
          this.say(ev, "overseer-stop", {}, { phase: isPhase(ev.phase) ? ev.phase : undefined });
        } else if (isPhase(ev.phase)) {
          // A pass is worth a word only now and then: the verdict block already says it passed.
          const moment: Moment = fnv1a(`${s.seed}|${s.counters.get("pass") ?? 0}`) % 2 ? "overseer-continue" : "phase-pass";
          s.counters.set("pass", (s.counters.get("pass") ?? 0) + 1);
          this.say(ev, moment, { phase: ev.phase }, { phase: ev.phase });
        }
        break;
      }
      case "approval-request":
        s.pendingAt.set(ev.requestId, Date.parse(ev.ts));
        break;
      case "approval-resolved": {
        const asked = s.pendingAt.get(ev.requestId);
        s.pendingAt.delete(ev.requestId);
        if (ev.auto) break;
        const waited = asked !== undefined ? Date.parse(ev.ts) - asked : undefined;
        s.prompts++;
        if (waited !== undefined && waited >= 0 && Number.isFinite(waited)) s.answerMs.push(waited);
        if (s.prompts === 25) this.say(ev, "prompts-25", {}, { once: true });
        if (s.prompts === 50) this.say(ev, "prompts-50", {}, { once: true });
        if (ev.decision === "deny") {
          s.denialStreak++;
          s.humanAllows = 0;
          if (s.denialStreak === 3) this.say(ev, "approval-denial-streak", {}, { once: true });
          else this.say(ev, "approval-denied", {}, {});
        } else {
          s.denialStreak = 0;
          s.humanAllows++;
          if (waited !== undefined && waited >= SLOW_APPROVAL_MS) this.say(ev, "approval-slow", {}, { once: true });
          else if (waited !== undefined && waited >= 0 && waited < FAST_APPROVAL_MS && s.humanAllows >= 5) this.say(ev, "approval-fast", {}, { once: true });
          if (ev.rememberedRule) {
            s.rules++;
            this.say(ev, s.rules === 3 ? "rules-many" : "rule-saved", {}, { once: s.rules !== 3 });
          }
        }
        break;
      }
      case "tool-call":
        s.tools++;
        if (isPhase(ev.phase)) s.toolsByPhase.set(ev.phase, (s.toolsByPhase.get(ev.phase) ?? 0) + 1);
        if (s.tools === 100) this.say(ev, "tools-100", {}, { once: true });
        if (s.tools === 250) this.say(ev, "tools-250", {}, { once: true });
        break;
      case "browser-session-started":
        this.say(ev, "browser-start", {}, { once: true });
        break;
      case "desktop-session-started":
        this.say(ev, "desktop-start", {}, { once: true });
        break;
      case "desktop-action-completed":
        if (ev.isError) this.say(ev, "desktop-refused", {}, { once: true });
        break;
      case "usage": {
        if (!finiteCost(ev.costUsd)) break;
        const before = s.cost;
        s.cost += ev.costUsd;
        if (isPhase(ev.phase)) s.costByPhase.set(ev.phase, (s.costByPhase.get(ev.phase) ?? 0) + ev.costUsd);
        for (const [t, m] of [[1, "cost-1"], [5, "cost-5"], [20, "cost-20"]] as const) {
          if (before < t && s.cost >= t) this.say(ev, m, { cost: s.cost }, { once: true });
        }
        break;
      }
      case "run-end": {
        const moment: Moment =
          ev.status === "done" ? (s.repairs === 0 ? "run-done-clean" : "run-done-repaired") : ev.status === "stopped" ? "run-stopped" : "run-failed";
        this.say(ev, moment, { n: s.repairs }, { force: true });
        for (const [m, vars] of this.awards(s, ev.status).slice(0, MAX_AWARDS)) this.say(ev, m, vars, { force: true });
        this.runs.delete(runId);
        break;
      }
    }
  }

  /** What the run's own numbers say about it, most pointed first: how fast the person answered, who was sent back
   * most, who cost most, who called the most tools. Only validated numbers and phase names go in. */
  private awards(s: RunState, status: string): Array<[Moment, PickVars]> {
    const out: Array<[Moment, PickVars]> = [];
    if (s.answerMs.length >= 5) {
      const avgSec = s.answerMs.reduce((a, b) => a + b, 0) / s.answerMs.length / 1000;
      if (avgSec < 3) out.push(["award-answer-fast", { n: Math.max(1, Math.round(avgSec)) }]);
      else if (avgSec >= 45) out.push(["award-answer-slow", { n: Math.min(9999, Math.round(avgSec)) }]);
    }
    if (s.prompts === 0 && status === "done") out.push(["award-quiet", {}]);
    const sentBack = maxEntry(s.repairsByPhase);
    if (sentBack && sentBack[1] >= 2 && isPhase(sentBack[0])) out.push(["award-sent-back", { phase: sentBack[0], n: sentBack[1] }]);
    const priciest = maxEntry(s.costByPhase);
    if (priciest && s.cost >= 0.5 && priciest[1] / s.cost >= 0.4 && isPhase(priciest[0])) out.push(["award-priciest", { phase: priciest[0], cost: priciest[1] }]);
    const hog = maxEntry(s.toolsByPhase);
    if (hog && hog[1] >= 40 && hog[1] / Math.max(1, s.tools) >= 0.4 && isPhase(hog[0])) out.push(["award-tool-hog", { phase: hog[0], n: hog[1] }]);
    return out;
  }
}

// ---------- catalog lint (used by test/persona.mjs, and by anyone adding a line)

/** Terms no line may contain (people, parties, groups, tragedies and the like; see docs/PERSONA.md). The
 * list is a net for contributions, not a substitute for reading a line. */
export const BANNED_TERMS = [
  "trump", "biden", "obama", "clinton", "putin", "netanyahu", "democrat", "republican", "gop", "maga", "liberal", "conservative", "left-wing", "right-wing",
  "nazi", "hitler", "holocaust", "genocide", "9/11", "suicide", "kill yourself", "kys", "murder", "rape", "terror",
  "jesus", "allah", "muhammad", "god", "bible", "quran", "church", "mosque", "jewish", "muslim", "christian", "hindu",
  "stupid", "idiot", "dumb", "moron", "fat", "ugly", "retard", "gay", "trans", "black", "white", "woman", "women", "man ", "men ",
  "idiot", "loser", "worthless", "useless",
];

export function lintCatalog(): string[] {
  const problems: string[] = [];
  const allowedPlaceholder = new Set<string>(PLACEHOLDERS);
  for (const [moment, lines] of Object.entries(CATALOG) as Array<[Moment, Line[]]>) {
    if (!lines.length) problems.push(`${moment}: no lines`);
    const seen = new Set<string>();
    for (const line of lines) {
      const where = `${moment}: "${line.text}"`;
      if (seen.has(line.text)) problems.push(`${where}: duplicate`);
      seen.add(line.text);
      if (line.text.length > 120) problems.push(`${where}: longer than 120 characters`);
      if (line.text.length < 8) problems.push(`${where}: too short to be a line`);
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩​-‏]/.test(line.text)) problems.push(`${where}: control, bidi or zero-width character`);
      for (const ph of line.text.match(/\{[^}]*\}/g) ?? []) if (!allowedPlaceholder.has(ph)) problems.push(`${where}: unknown placeholder ${ph}`);
      if (/[{}]/.test(line.text.replace(/\{[^}]*\}/g, ""))) problems.push(`${where}: stray brace`);
      const lower = ` ${line.text.toLowerCase()} `;
      for (const term of BANNED_TERMS) {
        const re = new RegExp(`(^|[^a-z])${term.trim().replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([^a-z]|$)`, "i");
        if (re.test(lower)) problems.push(`${where}: contains banned term "${term.trim()}"`);
      }
      if (line.by && !(line.by in PERSONAS)) problems.push(`${where}: unknown speaker ${line.by}`);
      if (line.when !== undefined && line.when !== "clean" && line.when !== "repaired") problems.push(`${where}: unknown "when" ${String(line.when)}`);
    }
    if (!moment.startsWith("insights-") && moment !== "rules-many" && moment !== "run-stopped" && moment !== "cost-20") {
      for (const state of ["clean", "repaired"] as const) {
        if (!lines.some((x) => !x.dark && (!x.when || x.when === state))) problems.push(`${moment}: needs at least one dry line for a ${state} run, so "dry" never comes up empty`);
      }
    }
  }
  return problems;
}
