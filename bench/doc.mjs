// Renders the generated table in docs/BENCHMARK.md from latest.json + baseline.json + the improvement log.
// test/bench-table.mjs recomputes this and fails if the committed doc differs, so the table cannot drift from the numbers.
import { planned } from "./planned.mjs";

export const START = "<!-- bench:table:start -->";
export const END = "<!-- bench:table:end -->";

function cell(v) { return v == null ? "-" : v.max == null ? `${v.value}` : `${v.value}/${v.max}`; }
function change(meta, base, now) {
  if (!base || !now) return "-";
  // When the number of checks changed the raw counts are not comparable (6 of 8 to 7 of 10 is worse, not "+1"): compare the pass rates.
  if (base.max !== now.max && base.max && now.max) {
    const pts = Math.round((now.value / now.max - base.value / base.max) * 1000) / 10;
    if (pts === 0) return "same rate";
    const better = meta.higherIsBetter ? pts > 0 : pts < 0;
    return `${pts > 0 ? "+" : ""}${pts} points (${better ? "better" : "worse"}; ${base.max} -> ${now.max} checks)`;
  }
  const d = now.value - base.value;
  if (d === 0) return "no change";
  const better = meta.higherIsBetter ? d > 0 : d < 0;
  return `${d > 0 ? "+" : ""}${d} (${better ? "better" : "worse"})`;
}
export function improvementIds(improvementsMd, suiteId) {
  const ids = [];
  for (const block of improvementsMd.split(/^## /m).slice(1)) {
    const id = block.match(/^(IMP-\d+)/)?.[1];
    const suites = block.match(/^- \*\*Suites:\*\*\s*(.*)$/m)?.[1] ?? "";
    if (id && suites.split(/[,\s]+/).includes(suiteId)) ids.push(id);
  }
  return ids;
}

export function renderTable({ latest, baseline, metas, improvementsMd }) {
  const rows = [];
  for (const m of metas) {
    const base = baseline.suites?.[m.id], now = latest.suites?.[m.id];
    const links = improvementIds(improvementsMd, m.id).join(", ") || "-";
    rows.push(`| \`${m.id}\` | ${m.title} | ${cell(base)}${base ? ` @ ${base.commit}` : ""} | ${cell(now)} | ${change(m, base, now)} | ${links} |`);
  }
  for (const p of planned) {
    rows.push(`| \`${p.id}\` | ${p.title} | not built | not built | ${/^after/.test(p.stage) ? "planned: " : "planned in "}${p.stage}${p.real ? " (real model, gated)" : ""} | - |`);
  }
  return [
    START,
    "| Suite | What it measures | First recorded | Now | Change | Why / how |",
    "|---|---|---|---|---|---|",
    ...rows,
    `Latest run: commit \`${latest.commit}\`, ${latest.date}. Baselines are the first value ever recorded for a suite and are never overwritten without an entry in IMPROVEMENTS.md.`,
    END,
  ].join("\n");
}
