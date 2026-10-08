// Step 6 of the reel flow: the model supplies scores and citations, this code applies the thresholds and the hard refusals (docs/REEL-FLOW.md; threats R1, R6). A persuasive reel cannot argue past it: the verdict is a function of
// numbers that are clamped here, of whether the reader found an instruction aimed at an AI, and of patterns in the structured idea and the claims.
export interface Scores { relevance: number; value: number; feasibility: number; novelty: number; risk: number; cited?: Partial<Record<"relevance" | "value" | "feasibility" | "novelty" | "risk", boolean>> }
export interface Thresholds { value: number; relevance: number; feasibility: number; risk: number; askRisk: number; askSlack: number }
export const DEFAULT_THRESHOLDS: Thresholds = { value: 4, relevance: 3, feasibility: 3, risk: 2, askRisk: 3, askSlack: 1 };
export type Verdict = { verdict: "implement" | "ask" | "skip" | "refuse"; reason: string; scores: Required<Pick<Scores, "relevance" | "value" | "feasibility" | "novelty" | "risk">> };

const clamp = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.min(5, Math.max(0, Math.round(n))) : 0);

// Hard refusals: whatever the scores. A list, so a floor; the model's own risk label of 5 refuses too.
const REFUSE: Array<[RegExp, string]> = [
  [/\b(bypass\w*|evad\w*|circumvent\w*|defeat\w*|gets? around|getting around|beat\w*)\b[^.]{0,60}\b(captcha|anti[- ]?bot|bot detection|rate[- ]?limit|paywall|cloudflare|login wall|2fa|two[- ]factor|detection|ban|geo[- ]?block)/i, "circumvents an access control or anti-bot measure"],
  [/\b(scrap\w*|harvest\w*|collect\w*|dump\w*|steal\w*|stole|exfiltrat\w*)\b[^.]{0,60}\b(passwords?|credentials?|cookies?|session tokens?|api keys?|private (messages|data)|personal (data|information)|e-?mails? addresses|phone numbers)/i, "harvests credentials or personal data"],
  [/\b(keylogger|ransomware|malware|botnet|credential stuffer|account takeover|phishing kit|rootkit|infostealer)\b/i, "is malware"],
  [/\b(clon\w*|cop(y|ies|ying)|rip(s|ping)?|re-?upload\w*|repost\w*|download\w*)\b[^.]{0,60}\b(copyrighted|someone else'?s|their (videos?|content|app|brand|logo|design)|paid course|premium content)/i, "copies a third party's protected work"],
  [/\b(mass|bulk|auto)[- ]?(follow|unfollow|dm|message|comment|like|spam)\w*\b|\bfake (accounts?|reviews?|followers?|likes?)\b|\bsock ?puppets?\b/i, "is spam or fake engagement"],
];

export function judge(input: { scores: Scores; idea: string; claims?: string[]; instructionsToAnAI?: string[] }, th: Thresholds = DEFAULT_THRESHOLDS): Verdict {
  const s = input.scores;
  const c = s.cited ?? {};
  // a score with no citation is capped at 2
  const sc = (k: "relevance" | "value" | "feasibility" | "novelty" | "risk") => { const v = clamp(s[k]); return k === "risk" ? v : c[k] ? v : Math.min(v, 2); };
  const scores = { relevance: sc("relevance"), value: sc("value"), feasibility: sc("feasibility"), novelty: sc("novelty"), risk: clamp(s.risk) };
  const text = [input.idea, ...(input.claims ?? [])].join("\n");
  for (const [re, why] of REFUSE) if (re.test(text)) return { verdict: "refuse", reason: `refused: the idea ${why}`, scores };
  if (scores.risk >= 5) return { verdict: "refuse", reason: "refused: the reader rated the risk 5 of 5", scores };
  if ((input.instructionsToAnAI ?? []).length) return { verdict: scores.value >= th.value ? "ask" : "skip", reason: "the reel contains text addressed to an AI system; it is never built without the user's say-so", scores };
  const checks: Array<[string, boolean]> = [["value", scores.value >= th.value], ["relevance", scores.relevance >= th.relevance], ["feasibility", scores.feasibility >= th.feasibility], ["risk", scores.risk <= th.risk]];
  if (checks.every(([, ok]) => ok)) return { verdict: "implement", reason: "meets every threshold", scores };
  const near = (k: string) => k === "value" ? scores.value >= th.value - th.askSlack : k === "relevance" ? scores.relevance >= th.relevance - th.askSlack : k === "feasibility" ? scores.feasibility >= th.feasibility - th.askSlack : scores.risk <= th.risk + th.askSlack;
  const failing = checks.filter(([, ok]) => !ok).map(([k]) => k);
  if (failing.length <= 2 && failing.every(near) && scores.risk <= th.askRisk) return { verdict: "ask", reason: `close on ${failing.join(" and ")}; the user decides`, scores };
  return { verdict: "skip", reason: `below the bar on ${failing.join(", ")}`, scores };
}

/** The scorer's JSON to numbers: anything missing is 0 and uncited, so it cannot lift a verdict. */
export function parseScores(raw: string): { scores: Scores; citations: Record<string, string> } {
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  let j: any = {};
  try { if (a >= 0 && b > a) j = JSON.parse(raw.slice(a, b + 1)); } catch { /* all zeros */ }
  const cited: Scores["cited"] = {}; const citations: Record<string, string> = {};
  for (const k of ["relevance", "value", "feasibility", "novelty"] as const) {
    const c = typeof j?.cite?.[k] === "string" ? j.cite[k].slice(0, 300) : "";
    if (c.trim()) { cited[k] = true; citations[k] = c; }
  }
  return { scores: { relevance: clamp(j?.relevance), value: clamp(j?.value), feasibility: clamp(j?.feasibility), novelty: clamp(j?.novelty), risk: typeof j?.risk === "number" ? clamp(j.risk) : 5, cited }, citations };
}
