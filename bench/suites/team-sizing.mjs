// Does the offline composer size a team the way the sizing guide says, with the mandatory roles present and no oversized plan? 28 labelled tasks against one small repository's
// paths: each has the size band its guide row gives, roles that must be on the team and roles that must not. A plan over the cap of 12 counts as a defect on its own line.
// The composer is a parameter so test/bench-suites.mjs can score a fixed-size composer and require it to do badly.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../lib.mjs";

export const meta = {
  id: "team-sizing",
  title: "Labelled tasks composed into the expected size band with the mandatory roles; oversized plans counted",
  unit: "of 28",
  higherIsBetter: true,
  stage: "S3a",
};

export const FILES = [
  "README.md", "package.json", "src/index.ts", "src/api/users.ts", "src/api/orders.ts", "src/worker/jobs.ts", "src/cli/main.ts", "src/report/total.ts", "src/billing/ledger.ts",
  "src/auth/session.ts", "src/auth/login.ts", "src/auth/reset.ts", "src/util/format.ts", "src/ui/Button.tsx", "src/ui/theme.css", "test/users.test.ts", "src/db/migrations/001_init.sql",
];
// [task, min agents, max agents, must have, must not have]
export const TASKS = [
  ["fix the typo in README.md", 3, 3, ["builder", "verifier", "gatekeeper"], ["planner"]],
  ["fix the spelling of receive in src/util/format.ts", 3, 3, ["builder", "verifier", "gatekeeper"], ["planner"]],
  ["rename the helper in src/util/format.ts", 3, 3, ["builder", "verifier", "gatekeeper"], ["planner"]],
  ["use 40 builders to fix the typo in README.md", 3, 3, ["builder", "verifier", "gatekeeper"], []],
  ["add a retry to the fetchUser function", 5, 6, ["planner", "builder", "verifier", "gatekeeper"], []],
  ["add pagination to the orders list", 5, 6, ["planner", "builder", "verifier", "gatekeeper"], []],
  ["somehow maybe fix the thing?", 5, 6, ["builder", "verifier", "gatekeeper"], []],
  ["refactor the whole codebase to use async/await", 5, 6, ["planner", "builder", "verifier", "gatekeeper"], []],
  ["the report totals are sometimes wrong and nobody knows why", 4, 4, ["researcher", "builder", "verifier", "gatekeeper"], ["planner"]],
  ["orders occasionally show up twice, not sure why", 4, 4, ["researcher", "builder", "verifier", "gatekeeper"], ["planner"]],
  ["use the zod library to validate the config", 5, 5, ["researcher", "planner", "builder", "verifier", "gatekeeper"], []],
  ["use the pino library for logging", 5, 5, ["researcher", "planner", "builder", "verifier", "gatekeeper"], []],
  ["update src/api/users.ts and src/worker/jobs.ts", 7, 7, ["planner", "integrator", "gatekeeper"], []],
  ["update src/api/users.ts, src/worker/jobs.ts and src/cli/main.ts", 9, 9, ["planner", "integrator", "gatekeeper"], []],
  ["update src/api/users.ts, src/worker/jobs.ts, src/cli/main.ts, src/report/total.ts and src/billing/ledger.ts", 12, 12, ["integrator", "security-reviewer", "gatekeeper"], []],
  ["add a password reset endpoint in src/auth/reset.ts", 6, 8, ["security-reviewer", "builder", "verifier", "gatekeeper"], []],
  ["encrypt the stored tokens in src/auth/session.ts", 5, 8, ["security-reviewer", "builder", "verifier", "gatekeeper"], []],
  ["add a migration that drops the legacy column", 5, 9, ["migration-reviewer", "advisor", "builder", "verifier", "gatekeeper"], []],
  ["delete the old users table and drop the legacy column", 6, 9, ["migration-reviewer", "advisor", "builder", "verifier", "gatekeeper"], []],
  ["change the colour in src/ui/theme.css", 4, 4, ["ui-tester", "builder", "verifier", "gatekeeper"], ["planner"]],
  ["restyle the settings page", 6, 8, ["ui-tester", "builder", "verifier", "gatekeeper"], []],
  ["deploy the new build to production", 6, 6, ["advisor", "builder", "verifier", "gatekeeper"], []],
  ["make the report faster, it takes minutes on large data", 6, 6, ["perf-reviewer", "builder", "verifier", "gatekeeper"], []],
  ["add a --verbose flag to the CLI", 6, 6, ["docs-writer", "builder", "verifier", "gatekeeper"], []],
  ["find out why login fails and patch it", 5, 6, ["researcher", "security-reviewer", "builder", "verifier", "gatekeeper"], []],
  ["explain how the session refresh works", 1, 1, ["researcher"], ["builder", "gatekeeper"]],
  ["why does login fail?", 1, 1, ["researcher"], ["builder", "gatekeeper"]],
  ["explain the risks of dropping the users table first", 2, 2, ["researcher", "advisor"], ["builder", "gatekeeper"]],
];

/** `compose(task, files)` returns the roles of the team it would run (a list of role ids). */
export function scoreSizing(compose) {
  const misses = [];
  let right = 0, oversized = 0;
  for (const [task, min, max, must, mustNot] of TASKS) {
    let roles = [];
    try { roles = compose(task, FILES) ?? []; } catch { roles = []; }
    if (roles.length > 12) oversized += 1;
    const ok = roles.length >= min && roles.length <= max && must.every((r) => roles.includes(r)) && mustNot.every((r) => !roles.includes(r));
    if (ok) right += 1; else misses.push(`${task} (${roles.length}: ${roles.join(" ")})`);
  }
  return { right, total: TASKS.length, oversized, misses };
}

export async function run() {
  const { composeOffline } = await import(pathToFileURL(join(ROOT, "dist/team/compose.js")).href);
  const { computeSignals } = await import(pathToFileURL(join(ROOT, "dist/team/signals.js")).href);
  const { BUILTIN_ROSTER } = await import(pathToFileURL(join(ROOT, "dist/team/roster.js")).href);
  const { right, total, oversized, misses } = scoreSizing((task, files) => {
    const r = composeOffline(task, computeSignals(task, { files }), BUILTIN_ROSTER);
    return (r.plan ?? { steps: [] }).steps.map((s) => s.role);
  });
  return { value: right, max: total, detail: { oversizedPlans: oversized, misses } };
}
