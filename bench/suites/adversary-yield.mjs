// Confirmed findings per adversary round (docs/adversary/round-NN.md). The value is the latest round's count. It is TRACKED, NOT SCORED (`higherIsBetter: null`): a rising count can mean a better adversary,
// and a round in which the adversary wrote nothing, or filed everything as UNCONFIRMED, would otherwise read as the best result (adversary round 2, A36). What says whether the loop works is in the detail:
// for every round with a triage file, how many of its findings are FIXED and how many are still open, and the count above low. The stage-closing rule is about findings above low that are open, not about the total.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib.mjs";

export const meta = { id: "adversary-yield", title: "Confirmed findings in the latest adversary round (tracked, not scored: more can mean a better adversary)", unit: "findings", higherIsBetter: null, stage: "after every stage" };

export function parseRound(md) {
  const rows = [...md.matchAll(/^\|\s*(A\d+)\s*\|\s*(critical|high|medium|low)\s*\|\s*([^|]+?)\s*\|/gim)];
  const confirmed = rows.filter((r) => /^CONFIRMED/i.test(r[3]));
  const by = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of confirmed) by[r[2].toLowerCase()]++;
  return { total: rows.length, confirmed: confirmed.length, by };
}

/** From a triage file: how many findings carry each disposition, and how many above low are neither FIXED nor REJECTED (SPEC and SCHEDULED are planned, not done). */
export function parseTriage(md) {
  const rows = [...md.matchAll(/^\|\s*(A\d+)\s*\|\s*(critical|high|medium|low)\s*\|\s*([A-Z]+)/gm)];
  const by = {};
  for (const r of rows) by[r[3]] = (by[r[3]] ?? 0) + 1;
  const notFixedAboveLow = rows.filter((r) => /^(critical|high|medium)$/.test(r[2]) && r[3] !== "FIXED" && r[3] !== "REJECTED").length;
  return { findings: rows.length, byDisposition: by, notFixedAboveLow };
}

export async function run() {
  const dir = join(ROOT, "docs/adversary");
  const files = readdirSync(dir).filter((f) => /^round-\d+\.md$/.test(f)).sort();
  const rounds = {};
  for (const f of files) {
    const id = f.replace(/\.md$/, "");
    rounds[id] = parseRound(readFileSync(join(dir, f), "utf8"));
    const triage = join(dir, `${id}-triage.md`);
    if (existsSync(triage)) rounds[id].triage = parseTriage(readFileSync(triage, "utf8"));
  }
  const latest = rounds[files.at(-1).replace(/\.md$/, "")];
  return { value: latest.confirmed, max: null, detail: rounds };
}
