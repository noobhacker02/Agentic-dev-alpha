// `agent-loop run "<task>" --team auto|fixed5|<plan file>`: choosing the team for a run (docs/TEAM-COMPOSITION.md). `fixed5` (and no flag) is the five phases in order, as always. `auto` is the offline composer.
// A file is a plan somebody wrote: it goes through the same floor and the same checks as any proposal (the floor is added, a plan that cannot be repaired is refused) and is never silently replaced by another.
// A bad value is an error before anything starts: no run, no database, no model. This returns data and never exits the process, so the tests can call it; cli.ts prints and exits.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { stripTerminalControlBytes } from "../text-safety.js";
import type { PipelineConfig } from "../types.js";
import { loadTeamRoster, MAX_CAP, type ParsedArgs } from "./cli-commands.js";
import { composeOffline, finalizePlan, type ComposeResult } from "./compose.js";
import { DEFAULT_CAP } from "./plan.js";
import { scanRepoPaths } from "./scan.js";
import { computeSignals } from "./signals.js";

const MAX_PLAN_BYTES = 200_000;
const clean = (s: unknown, n = 300): string => stripTerminalControlBytes(String(s ?? "")).replace(/\s+/g, " ").trim().slice(0, n);

export interface TeamOption {
  /** Absent for the five phases. */
  team?: NonNullable<PipelineConfig["team"]>;
  /** A repair budget that grows with the team (the five-phase default is 20). */
  maxRepairs?: number;
  /** What to tell the user before the run starts. */
  summary: string[];
  /** What code changed in a plan it was given or composed, in words. */
  notes: string[];
  /** 1 for a usage error, 2 for a plan that is refused. */
  error?: { code: 1 | 2; message: string };
}

const fail = (code: 1 | 2, message: string): TeamOption => ({ summary: [], notes: [], error: { code, message } });

export function resolveTeamOption(args: ParsedArgs, ctx: { task: string; workDir: string; cwd?: string }): TeamOption {
  const raw = args.team;
  if (raw === undefined || raw === "fixed5") return { summary: [], notes: [] };
  if (typeof raw !== "string" || !raw.trim()) return fail(1, "--team needs a value: auto (the composer picks the team), fixed5 (the five phases, the default), or the path of a plan file (JSON).");

  let cap = DEFAULT_CAP;
  if (args.cap !== undefined) {
    const n = typeof args.cap === "string" && /^\d+$/.test(args.cap) ? Number(args.cap) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_CAP) return fail(1, `--cap needs a whole number from 1 to ${MAX_CAP} (got ${typeof args.cap === "string" ? `"${clean(args.cap, 20)}"` : "nothing"}).`);
    cap = n;
  }
  const roster = loadTeamRoster(ctx.workDir, args["trust-project"] === true);
  const signals = computeSignals(ctx.task, { files: scanRepoPaths(ctx.workDir) });
  const opts = { cap, workDir: ctx.workDir };

  let result: ComposeResult;
  let source: "auto" | "file";
  if (raw === "auto") {
    source = "auto";
    result = composeOffline(ctx.task, signals, roster.roles, opts);
  } else {
    source = "file";
    const path = resolve(ctx.cwd ?? process.cwd(), raw);
    const shown = clean(path, 200);
    let text: string;
    try {
      const st = statSync(path);
      if (!st.isFile()) return fail(1, `--team ${shown} is not a file.`);
      if (st.size > MAX_PLAN_BYTES) return fail(1, `--team ${shown} is too large for a plan (${st.size} bytes; the limit is ${MAX_PLAN_BYTES}).`);
      text = readFileSync(path, "utf8");
    } catch (err) {
      return fail(1, `--team ${shown}: cannot read it (${clean((err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : err), 80)}); no such file?`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail(1, `--team ${shown} is not valid JSON.`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail(1, `--team ${shown}: a plan must be an object with a "steps" list.`);
    result = finalizePlan(parsed, signals, roster.roles, opts);
  }

  if (!result.plan) {
    const why = result.validation.violations.slice(0, 5).map((v) => `${v.rule}: ${clean(v.message)}`).join("; ");
    return fail(2, source === "auto" ? `no team fits the cap of ${cap} for this task (${why}). Raise --cap, or narrow the task.` : `the plan in ${clean(raw, 200)} was refused (${why}).`);
  }
  const plan = result.plan;
  const parts = plan.steps.map((s) => `${s.id} ${s.role}${s.slice ? ` (${clean(s.slice.name, 30)})` : ""}`);
  return {
    team: { plan, roster: roster.roles, source },
    maxRepairs: Math.max(20, plan.steps.length * 3),
    summary: [`Team (${source}): ${plan.steps.length} steps: ${parts.join(", ")}`],
    notes: result.changes.map((c) => clean(c)),
  };
}
