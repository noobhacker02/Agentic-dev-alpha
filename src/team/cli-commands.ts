// `agent-loop roster` and `agent-loop team "<task>" --dry-run`: show a team without running one. Both work offline (no model, no network). They return the text and the exit
// code instead of printing, so the tests can call them directly; cli.ts prints. Everything printed passes through stripTerminalControlBytes: the task, role files and file
// names are all text somebody else could have written.
import { join, resolve } from "node:path";
import { agentLoopHome } from "../data-dir.js";
import { stripTerminalControlBytes } from "../text-safety.js";
import { composeOffline } from "./compose.js";
import { DEFAULT_CAP, type TeamPlan, type TeamStep } from "./plan.js";
import { loadRoster, toolClasses, type LoadedRoster, type RoleDef } from "./roster.js";
import { scanRepoPaths } from "./scan.js";
import { computeSignals, requiredRoles, type Signals } from "./signals.js";

export type ParsedArgs = Record<string, string | boolean | string[]> & { _: string[] };
export interface CommandResult {
  out: string;
  err: string;
  code: number;
}

export const MAX_CAP = 50;
/** JSON.stringify leaves C1 control characters (U+0080 to U+009F) as they are, and some terminals act on them: every string goes through the same filter as the text output. */
const toJson = (body: unknown): string => `${JSON.stringify(body, (_k, v: unknown) => (typeof v === "string" ? stripTerminalControlBytes(v) : v), 2)}\n`;
const clean = (s: unknown, n = 300): string => stripTerminalControlBytes(String(s ?? "")).replace(/\s+/g, " ").trim().slice(0, n);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The roster for a project directory: the built-in roles, the user's own, and (only with --trust-project) the project's. One definition for `roster`, `team` and `run --team`. */
export function loadTeamRoster(dir: string, trustProject: boolean): LoadedRoster {
  return loadRoster({ userDir: join(agentLoopHome(), "roster"), projectDir: join(dir, ".agent-loop", "roster"), trustProject });
}

function loadFor(args: ParsedArgs): { dir: string; roster: LoadedRoster } {
  const dir = resolve(typeof args.dir === "string" ? args.dir : "./agent-loop-workspace");
  return { dir, roster: loadTeamRoster(dir, args["trust-project"] === true) };
}

const roleLine = (r: RoleDef): string => {
  const tools = toolClasses(r);
  const skip = r.skippable === "no" ? "never skipped" : r.skippable === "tiny" ? "skipped only for a tiny task" : "may be skipped";
  return `  ${clean(r.id, 40).padEnd(20)}${r.kind.padEnd(8)}${r.model.padEnd(8)}up to ${r.max}; ${skip}; tools: ${tools.length ? tools.join(", ") : "none"}\n      ${clean(r.when, 200)}`;
};

/** `agent-loop roster`: who can be on a team, then yours, then what was refused or ignored and why. */
export function rosterCommand(args: ParsedArgs): CommandResult {
  const { roster } = loadFor(args);
  const builtin = roster.roles.filter((r) => r.builtin);
  const mine = roster.roles.filter((r) => !r.builtin);
  if (args.json === true) {
    const roles = roster.roles.map((r) => ({ id: r.id, kind: r.kind, model: r.model, tools: r.tools, writeScope: r.writeScope, skippable: r.skippable, max: r.max, when: clean(r.when, 200), builtin: r.builtin }));
    return { out: toJson({ roles, rejected: roster.rejected.map((p) => ({ file: clean(p.file, 300), reason: clean(p.reason) })), ignored: roster.ignored.map((p) => ({ file: clean(p.file, 300), reason: clean(p.reason) })) }), err: "", code: 0 };
  }
  const lines = [`Roster: ${builtin.length} built-in roles${mine.length ? `, ${mine.length} of yours` : ""}`, "", "Built-in", ...builtin.map(roleLine)];
  if (mine.length) lines.push("", `Yours (${mine.length}), from ${clean(join(agentLoopHome(), "roster"), 200)} or a project roster you trusted`, ...mine.map(roleLine));
  if (roster.rejected.length) lines.push("", `Refused (${roster.rejected.length}): read, and not used`, ...roster.rejected.map((p) => `  ${clean(p.file, 200)}: ${clean(p.reason)}`));
  if (roster.ignored.length) lines.push("", `Ignored (${roster.ignored.length}): not read at all`, ...roster.ignored.map((p) => `  ${clean(p.file, 200)}: ${clean(p.reason)}`), "  (--trust-project reads a roster inside the project; only do that if you wrote it)");
  return { out: `${lines.join("\n")}\n`, err: "", code: 0 };
}

const stepLine = (s: TeamStep, roster: RoleDef[]): string => {
  const model = roster.find((r) => r.id === s.role)?.model ?? "";
  const deps = [...(s.after ?? []), ...(s.checks ? [s.checks] : [])];
  const extra = [s.slice ? `slice ${s.slice.paths.map((p) => clean(p, 60)).join(", ")}` : "", deps.length ? `after ${deps.join(", ")}` : ""].filter(Boolean).join("; ");
  return `  ${s.id.padEnd(5)}${clean(s.role, 30).padEnd(20)}${model.padEnd(8)}${clean(s.why, 200)}${extra ? `  (${extra})` : ""}`;
};

/** Why the team has the size it has, in words, from what code decided. */
function sizeReasons(s: Signals, plan: TeamPlan, cap: number, changes: string[]): string[] {
  const out: string[] = [];
  if (!s.writes) out.push("The task reads or explains, so nothing is written: no builder, no verifier, no gatekeeper.");
  else out.push("The task writes, so every builder has an independent verifier and the team ends with the gatekeeper; none of those can be dropped.");
  out.push(`About ${plural(s.estimatedFiles, "file")}${s.modules.length ? ` in ${s.modules.map((m) => clean(m, 60)).join(", ")}` : ""}${s.testsNearby ? "; the repository has tests" : "; no tests were found"}.`);
  if (s.writes && s.sensitive.length) {
    const areas = s.sensitive.map((x) => `${x.area} (${x.via === "path" ? "from a path" : "from the words"})`).join(", ");
    const req = requiredRoles(s);
    out.push(`Sensitive: ${areas}. ${req.join(" and ")} ${req.length === 1 ? "is" : "are"} mandatory and cannot be dropped.`);
  }
  const flags = [s.ui && "UI files", s.performance && "a performance goal", s.publicBehaviour && "public behaviour", s.irreversible && "an irreversible action", s.external && "an action on the outside world", s.unclearCause && "an unclear cause", s.unfamiliar && "an unfamiliar library or API", s.ambiguity >= 2 && "an ambiguous request"].filter(Boolean);
  if (flags.length) out.push(`Also noticed: ${flags.join(", ")}.`);
  out.push(`${plural(plan.steps.length, "agent")} of a cap of ${cap} (--cap changes it; the plan cannot).`);
  for (const c of changes) out.push(`Code changed the plan: ${clean(c, 240)}`);
  return out;
}

/** `agent-loop team "<task>" --dry-run`: the team that would run, a reason for each member, and why this size. Never runs anything. */
export function teamCommand(args: ParsedArgs): CommandResult {
  const task = args._.join(" ").trim();
  if (!task) return { out: "", err: 'Error: no task given. Usage: agent-loop team "<task>" --dry-run [--dir <workDir>] [--cap <n>] [--json] [--trust-project]\n', code: 1 };
  let cap = DEFAULT_CAP;
  if (args.cap !== undefined) {
    const n = typeof args.cap === "string" && /^\d+$/.test(args.cap) ? Number(args.cap) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_CAP) return { out: "", err: `Error: --cap needs a whole number from 1 to ${MAX_CAP} (got ${typeof args.cap === "string" ? `"${clean(args.cap, 20)}"` : "nothing"}).\n`, code: 1 };
    cap = n;
  }
  if (args["dry-run"] !== true) return { out: "", err: "Error: agent-loop team only shows the team. Add --dry-run, or run it with: agent-loop run \"<task>\" --team auto. Nothing here starts an agent.\n", code: 1 };

  const { dir, roster } = loadFor(args);
  const signals = computeSignals(task, { files: scanRepoPaths(dir) });
  const result = composeOffline(task, signals, roster.roles, { cap, workDir: dir });
  const shown = clean(task, 200);
  const refused = roster.rejected.length + roster.ignored.length;

  if (args.json === true) {
    const body = { task: shown, source: result.source, cap, plan: result.plan, validation: result.validation, signals, changes: result.changes.map((c) => clean(c, 300)), roster: { refused: roster.rejected.length, ignored: roster.ignored.length } };
    return { out: toJson(body), err: "", code: result.plan ? 0 : 2 };
  }
  if (!result.plan) {
    const lines = [`No team fits the cap of ${cap} for: ${shown}`, ...result.validation.violations.slice(0, 5).map((v) => `  ${v.rule}: ${clean(v.message, 300)}`), "Raise --cap, or narrow the task so it needs fewer agents. The floor (builder, verifier, gatekeeper, and what the signals make mandatory) cannot be dropped to fit."];
    return { out: "", err: `${lines.join("\n")}\n`, code: 2 };
  }
  const plan = result.plan;
  const order = result.validation.order.length ? result.validation.order : plan.steps.map((s) => s.id);
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const lines = [
    `Team for: ${shown}`,
    `  ${plural(plan.steps.length, "agent")} · ${plan.size} · ${clean(plan.class, 30)}${dir ? ` · ${clean(dir, 100)}` : ""}`,
    "",
    ...order.map((id) => stepLine(byId.get(id)!, roster.roles)),
    "",
    "Why this size",
    ...sizeReasons(signals, plan, cap, result.changes).map((l) => `  - ${l}`),
  ];
  if (refused) lines.push(`  - ${plural(refused, "roster file")} refused or ignored (agent-loop roster says which and why).`);
  lines.push("", "No model was used: this is the offline composer (the sizing guide as code). A model's proposal, when there is one, goes through the same checks and the same caps.");
  return { out: `${lines.join("\n")}\n`, err: "", code: 0 };
}
