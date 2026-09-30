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
}

const d = (text: string, by?: Speaker): Line => ({ text, dark: true, by });
const l = (text: string, by?: Speaker): Line => ({ text, by });

/** Placeholders a line may contain. Anything else is a bug (test/persona.mjs lints every line). */
export const PLACEHOLDERS = ["{phase}", "{n}", "{cost}"] as const;

export type Moment =
  | "idle"
  | "run-start"
  | `phase-start:${PhaseName}`
  | "phase-pass"
  | "phase-fail"
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
  ],
  "phase-start:test-designer": [
    l("Writing the tests before anyone can argue with them.", "test-designer"),
    l("Listing the ways this could break. It's a short list; the list is long.", "test-designer"),
    d("I've seen how this ends. Writing it down as a test.", "test-designer"),
    d("Brainstorming failure modes. Enthusiastically.", "test-designer"),
  ],
  "phase-start:builder": [
    l("Building. The diff will be small and the explanation longer.", "builder"),
    l("Typing with confidence, which is not evidence.", "builder"),
    d("Shipping first; apologizing is a separate ticket.", "builder"),
    d("Building. If it compiles, it's basically legal.", "builder"),
  ],
  "phase-start:verifier": [
    l("Verifying. I believe you, in the legal sense of 'show me'.", "verifier"),
    l("Running it myself. Your word counts as a suggestion.", "verifier"),
    d("Trust is a vulnerability. Patching it.", "verifier"),
    d("Checking the claims. Claims have a mortality rate.", "verifier"),
  ],
  "phase-start:gatekeeper": [
    l("Gate's closed until the checklist says otherwise.", "gatekeeper"),
    l("Final review. Nothing ships on vibes.", "gatekeeper"),
    d("On duty. Nobody is getting in on charm.", "gatekeeper"),
    d("Last stop. Rejected changes rest in the reflog.", "gatekeeper"),
  ],
  "phase-pass": [
    l("{phase} passed. Suspiciously smooth."),
    l("{phase} done. The diff survived first contact."),
    l("{phase}: green. Enjoy it; it's a loan."),
    d("{phase} passed. The bugs simply haven't been introduced yet."),
    d("{phase} signed off. Another small victory for the dangerously optimistic."),
    d("{phase} passed. Somewhere, a flaky test smiles."),
  ],
  "phase-fail": [
    l("{phase} failed. The Overseer will be told, loudly."),
    l("{phase} didn't make it. Not every phase gets a trophy."),
    l("{phase}: red. The reflog is taking notes."),
    d("{phase} has fallen. Its files will be remembered, mostly by git."),
    d("{phase} failed. Cause of death: optimism."),
    d("{phase} is down. The others are pretending not to notice."),
  ],
  "overseer-continue": [
    l("Proceed. The record shows no objection.", "overseer"),
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
  dark: boolean;
  by: Speaker;
}

/**
 * One line for a moment at a level, chosen deterministically from `seed` and `counter` (so a run's
 * commentary is reproducible and testable, not random). `avoid` is the text of the previous pick, so the
 * same line doesn't come twice in a row. "off" returns nothing; "dry" never returns a dark line.
 */
export function pick(moment: Moment, level: HumorLevel, seed: string, counter = 0, vars: PickVars = {}, avoid?: string): Picked | undefined {
  if (level === "off") return undefined;
  const eligible = (CATALOG[moment] ?? []).filter((x) => level === "dark" || !x.dark);
  const filled = eligible.map((x) => ({ x, text: fill(x.text, vars) })).filter((e): e is { x: Line; text: string } => e.text !== undefined);
  if (!filled.length) return undefined;
  let i = fnv1a(`${seed}|${moment}|${counter}`) % filled.length;
  if (filled.length > 1 && filled[i].text === avoid) i = (i + 1) % filled.length;
  const e = filled[i];
  return { text: e.text, dark: Boolean(e.x.dark), by: e.x.by ?? "narrator" };
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

/** Notes a run may get in total, and the least time between two (by event timestamps), so the
 * commentary stays a seasoning. Run-end notes ignore both. */
export const MAX_NOTES_PER_RUN = 30;
export const MIN_NOTE_GAP_MS = 6000;
export const FAST_APPROVAL_MS = 1500;
export const SLOW_APPROVAL_MS = 120_000;

interface RunState {
  seed: string;
  notes: number;
  lastNoteAt: number;
  counters: Map<string, number>;
  last: Map<string, string>;
  once: Set<string>;
  repairs: number;
  humanAllows: number;
  denialStreak: number;
  rules: number;
  cost: number;
  pendingAt: Map<string, number>;
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

  constructor(private bus: EventBus, private opts: { level: HumorLevel }) {}

  attach() {
    if (this.opts.level !== "off") this.bus.on("event", this.listener);
    return { detach: () => this.bus.off("event", this.listener) };
  }

  private state(runId: string): RunState {
    let s = this.runs.get(runId);
    if (!s) {
      s = { seed: runId, notes: 0, lastNoteAt: -Infinity, counters: new Map(), last: new Map(), once: new Set(), repairs: 0, humanAllows: 0, denialStreak: 0, rules: 0, cost: 0, pendingAt: new Map() };
      this.runs.set(runId, s);
    }
    return s;
  }

  private say(ev: AgentEvent, moment: Moment, vars: PickVars = {}, opts: { force?: boolean; once?: boolean; phase?: PhaseName } = {}) {
    const s = this.state((ev as { runId: string }).runId);
    const at = Date.parse(ev.ts);
    if (opts.once && s.once.has(moment)) return;
    if (!opts.force && (s.notes >= MAX_NOTES_PER_RUN || at - s.lastNoteAt < MIN_NOTE_GAP_MS)) return;
    const n = s.counters.get(moment) ?? 0;
    const picked = pick(moment, this.opts.level, s.seed, n, vars, s.last.get(moment));
    if (!picked) return;
    s.counters.set(moment, n + 1);
    s.last.set(moment, picked.text);
    if (opts.once) s.once.add(moment);
    s.notes++;
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
    const s = this.state(runId);
    switch (ev.type) {
      case "run-start":
        this.say(ev, "run-start", {}, { force: true });
        break;
      case "phase-start":
        if (ev.attempt === 1 && (PHASES as readonly string[]).includes(ev.phase)) this.say(ev, `phase-start:${ev.phase}`, {}, { phase: ev.phase });
        break;
      case "phase-end": {
        if (ev.verdict.headline === "Skipped") break;
        this.say(ev, ev.verdict.outcome === "pass" ? "phase-pass" : "phase-fail", { phase: ev.phase }, { phase: ev.phase });
        break;
      }
      case "overseer-decision": {
        const a = ev.decision.action;
        if (a === "repair") s.repairs++;
        this.say(ev, a === "repair" ? "overseer-repair" : a === "continue" ? "overseer-continue" : "overseer-stop", {}, { phase: ev.phase });
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
        if (ev.decision === "deny") {
          s.denialStreak++;
          s.humanAllows = 0;
          if (s.denialStreak === 3) this.say(ev, "approval-denial-streak", {}, { force: true, once: true });
          else this.say(ev, "approval-denied", {}, {});
        } else {
          s.denialStreak = 0;
          s.humanAllows++;
          if (waited !== undefined && waited >= SLOW_APPROVAL_MS) this.say(ev, "approval-slow", {}, { once: true });
          else if (waited !== undefined && waited >= 0 && waited < FAST_APPROVAL_MS && s.humanAllows >= 5) this.say(ev, "approval-fast", {}, { once: true });
          if (ev.rememberedRule) {
            s.rules++;
            this.say(ev, s.rules === 3 ? "rules-many" : "rule-saved", {}, { once: s.rules !== 3 ? true : false });
          }
        }
        break;
      }
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
        const before = s.cost;
        s.cost += ev.costUsd;
        for (const [t, m] of [[1, "cost-1"], [5, "cost-5"], [20, "cost-20"]] as const) {
          if (before < t && s.cost >= t) this.say(ev, m, { cost: s.cost }, { once: true });
        }
        break;
      }
      case "run-end": {
        const moment: Moment =
          ev.status === "done" ? (s.repairs === 0 ? "run-done-clean" : "run-done-repaired") : ev.status === "stopped" ? "run-stopped" : "run-failed";
        this.say(ev, moment, { n: s.repairs }, { force: true });
        this.runs.delete(runId);
        break;
      }
    }
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
    }
    if (!moment.startsWith("insights-") && moment !== "rules-many" && moment !== "run-stopped" && moment !== "cost-20" && !lines.some((x) => !x.dark)) {
      problems.push(`${moment}: needs at least one dry line, so "dry" never comes up empty`);
    }
  }
  return problems;
}
