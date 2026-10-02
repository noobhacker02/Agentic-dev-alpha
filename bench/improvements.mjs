// Validates docs/IMPROVEMENTS.md (and the skill-side log, which uses the same format with SKILL- ids).
export const FIELDS = ["Problem", "Why it matters", "Change (how)", "Measured", "Cost / trade-off", "Suites", "Skill impact", "Follow-ups"];

export function parseEntries(md, prefix = "IMP") {
  const out = [];
  const re = new RegExp(`^## (${prefix}-\\d+) · ([^·\\n]+?) · (.+)$`, "gm");
  const heads = [...md.matchAll(re)];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const end = i + 1 < heads.length ? heads[i + 1].index : md.length;
    const body = md.slice(h.index + h[0].length, end);
    const fields = {};
    for (const f of FIELDS) {
      const m = body.match(new RegExp(`^- \\*\\*${f.replace(/[()/]/g, "\\$&")}:\\*\\*\\s*([\\s\\S]*?)(?=^- \\*\\*|\\n## |$(?![\\s\\S]))`, "m"));
      fields[f] = m ? m[1].replace(/\s+/g, " ").trim() : null;
    }
    out.push({ id: h[1], date: h[2].trim(), title: h[3].trim(), fields });
  }
  return out;
}

/** knownSuites: ids of built and planned benchmark suites. Returns a list of problems (empty = fine). */
export function validateImprovements(md, { knownSuites = [], prefix = "IMP" } = {}) {
  const problems = [];
  const entries = parseEntries(md, prefix);
  if (!entries.length) problems.push("no entries found");
  const seen = new Set();
  let last = 0;
  for (const e of entries) {
    const n = Number(e.id.split("-")[1]);
    if (seen.has(e.id)) problems.push(`${e.id}: duplicate id`);
    seen.add(e.id);
    if (n <= last) problems.push(`${e.id}: ids must increase (after ${prefix}-${String(last).padStart(3, "0")})`);
    last = n;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.date !== "backfilled") problems.push(`${e.id}: date must be YYYY-MM-DD or "backfilled", got "${e.date}"`);
    for (const f of FIELDS) if (!e.fields[f]) problems.push(`${e.id}: missing or empty field "${f}"`);
    const measured = e.fields["Measured"];
    if (measured && !/\d/.test(measured) && !/not measurable because/i.test(measured)) problems.push(`${e.id}: "Measured" has no number and no "not measurable because ..."`);
    const suites = e.fields["Suites"];
    if (suites && suites.toLowerCase() !== "none") {
      for (const s of suites.split(/[,\s]+/).filter(Boolean)) if (knownSuites.length && !knownSuites.includes(s)) problems.push(`${e.id}: unknown benchmark suite "${s}"`);
    }
  }
  return problems;
}
