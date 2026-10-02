// Confirmed findings per adversary round (docs/adversary/round-NN.md). The value is the latest round's count; it should fall round over round. A round whose count does not
// fall is either not fixing causes or finding a new class each time; the detail lists every round so a person can tell which.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib.mjs";

export const meta = { id: "adversary-yield", title: "Confirmed findings in the latest adversary round (should fall)", unit: "findings", higherIsBetter: false, stage: "after every stage" };

export function parseRound(md) {
  const rows = [...md.matchAll(/^\|\s*(A\d+)\s*\|\s*(critical|high|medium|low)\s*\|\s*([^|]+?)\s*\|/gim)];
  const confirmed = rows.filter((r) => /^CONFIRMED/i.test(r[3]));
  const by = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of confirmed) by[r[2].toLowerCase()]++;
  return { total: rows.length, confirmed: confirmed.length, by };
}

export async function run() {
  const dir = join(ROOT, "docs/adversary");
  const files = readdirSync(dir).filter((f) => /^round-\d+\.md$/.test(f)).sort();
  const rounds = {};
  for (const f of files) rounds[f.replace(/\.md$/, "")] = parseRound(readFileSync(join(dir, f), "utf8"));
  const latest = rounds[files.at(-1).replace(/\.md$/, "")];
  return { value: latest.confirmed, max: null, detail: rounds };
}
