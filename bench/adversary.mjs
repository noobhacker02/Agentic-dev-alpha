// Validates adversary round files and their triage (threats F4 to F6): every finding in the table has a section, every confirmed one has a reproduction or an
// argument, every finding is triaged with a disposition, and rounds are numbered without gaps.
export const DISPOSITIONS = ["FIXED", "SPEC", "SCHEDULED", "REJECTED"];

export function validateRound(md, triageMd) {
  const problems = [];
  const rows = [...md.matchAll(/^\|\s*(A\d+)\s*\|\s*(critical|high|medium|low)\s*\|\s*([^|]+?)\s*\|/gim)].map((m) => ({ id: m[1], status: m[3] }));
  if (!rows.length) problems.push("no findings table found");
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.id)) problems.push(`${r.id}: duplicate id`);
    seen.add(r.id);
    // A section ends at the next heading or at the end of the input. JavaScript has no \Z: `(?![\s\S])` is the end, and a bare Z would end a section at the first capital Z in it.
    const sec = md.match(new RegExp(`^### ${r.id} \\([^)]*\\)[^\\n]*\\n([\\s\\S]*?)(?=^### |^## |(?![\\s\\S]))`, "m"));
    if (!sec) { problems.push(`${r.id}: in the table but has no section`); continue; }
    if (/^CONFIRMED/i.test(r.status)) {
      // A reproduction, an argument or a scenario by name, or else concrete evidence: at least four quoted code, file or line references.
      // The label alone is not a reproduction (A49): a Reproduction field needs a command, code or output in it (a code span or a fenced block) and may not say "none"; an Argument or Scenario needs some substance.
      const field = (name) => sec[1].match(new RegExp(`\\*\\*${name}[^*\\n]*\\*\\*:?([\\s\\S]*?)(?=\\n- \\*\\*|(?![\\s\\S]))`, "i"))?.[1] ?? "";
      const repro = field("Reproduction");
      const reproOk = /`[^`\n]+`|```/.test(repro) && !/^\s*(none|n\/a|not run|no)\b/i.test(repro);
      const named = reproOk || field("Argument").trim().length >= 80 || field("Scenario").trim().length >= 80;
      const concrete = (sec[1].match(/`[^`\n]+`/g) ?? []).length >= 4;
      // A finding "confirmed by the documents' own text" is an argument from quotation; it must at least be substantial.
      const fromText = /text/i.test(r.status) && sec[1].length >= 600;
      if (!named && !concrete && !fromText) problems.push(`${r.id}: confirmed but gives no reproduction, argument, scenario or concrete evidence`);
    }
  }
  if (triageMd == null) { problems.push("no triage file"); return problems; }
  for (const r of rows) {
    const row = triageMd.match(new RegExp(`^\\|\\s*${r.id}\\s*\\|[^|]*\\|\\s*([^|]+?)\\s*\\|`, "m"));
    if (!row) { problems.push(`${r.id}: not triaged`); continue; }
    if (!DISPOSITIONS.some((d) => row[1].toUpperCase().startsWith(d))) problems.push(`${r.id}: triage disposition "${row[1].slice(0, 30)}" is not one of ${DISPOSITIONS.join(", ")}`);
  }
  return problems;
}

export function validateRoundNumbers(files) {
  const nums = files.map((f) => Number(f.match(/^round-(\d+)\.md$/)?.[1])).filter(Boolean).sort((a, b) => a - b);
  return nums.every((n, i) => n === i + 1) ? [] : [`round files are not numbered 1..N without gaps: ${nums.join(", ")}`];
}
