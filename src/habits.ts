import type { PhaseName } from "./types.js";

/**
 * How someone has actually used agent-loop, as numbers and fixed labels and nothing else. This is the only thing
 * `agent-loop insights` talks about (src/roast.ts) and the only thing a model is ever shown in `--roast api`. It lives
 * in its own file so the audit store can build it without depending on any display code. Add a field here and you
 * are deciding that it may appear in a joke and in a model's prompt: never add free text (a task, a command, a rule,
 * a path, a reason). test/roast.mjs plants canary strings in every such field and checks none gets out.
 */
export interface Habits {
  runs: number;
  done: number;
  failed: number;
  stopped: number;
  /** Runs still marked "running" more than 12 hours after they began: the process was closed or force-quit before it could say so. */
  abandoned: number;
  totalCostUsd: number;
  /** Money spent on runs that ended failed or stopped. */
  wastedUsd: number;
  priciestRunUsd: number;
  approvals: { asked: number; approved: number; denied: number; auto: number };
  /** Approvals answered "yes" in under QUICK_MS. */
  quickYes: number;
  slowestAnswerMin: number;
  /** The same tool call denied once and later allowed, counted per distinct call. */
  deniedThenAllowed: number;
  rulesCreated: number;
  rulesNeverReused: number;
  /** For each phase, how many runs needed more than one attempt of it. */
  repairedRunsByPhase: Partial<Record<PhaseName, number>>;
  /** Runs that started between 00:00 and 05:00 local time. */
  nightRuns: number;
  /** The most times any one task was run. */
  repeatedTaskMax: number;
  longestRunMin: number;
  desktop: { sent: number; stopped: number; approved: number; denied: number };
}

export const QUICK_MS = 1500;
export const ABANDONED_AFTER_MS = 12 * 60 * 60 * 1000;
export const emptyHabits = (): Habits => ({
  runs: 0, done: 0, failed: 0, stopped: 0, abandoned: 0, totalCostUsd: 0, wastedUsd: 0, priciestRunUsd: 0,
  approvals: { asked: 0, approved: 0, denied: 0, auto: 0 }, quickYes: 0, slowestAnswerMin: 0, deniedThenAllowed: 0,
  rulesCreated: 0, rulesNeverReused: 0, repairedRunsByPhase: {}, nightRuns: 0, repeatedTaskMax: 0, longestRunMin: 0,
  desktop: { sent: 0, stopped: 0, approved: 0, denied: 0 },
});

