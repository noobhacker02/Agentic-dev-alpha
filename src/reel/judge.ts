// Step 6 of the reel flow: the model supplies scores and citations, this code applies the thresholds and the hard refusals (docs/REEL-FLOW.md; threats R1, R6). A persuasive reel cannot argue past it: the verdict is a function of
// numbers that are clamped here, of whether the reader found an instruction aimed at an AI, and of patterns in the idea, the claims, the summary and what was shown.
export interface Scores { relevance: number; value: number; feasibility: number; novelty: number; risk: number; cited?: Partial<Record<"relevance" | "value" | "feasibility" | "novelty" | "risk", boolean>> }
export interface Thresholds { value: number; relevance: number; feasibility: number; risk: number; askRisk: number; askSlack: number }
export const DEFAULT_THRESHOLDS: Thresholds = { value: 4, relevance: 3, feasibility: 3, risk: 2, askRisk: 3, askSlack: 1 };
export type Verdict = { verdict: "implement" | "ask" | "skip" | "refuse"; reason: string; scores: Required<Pick<Scores, "relevance" | "value" | "feasibility" | "novelty" | "risk">> };

/** A score in 0..5. Anything that is not a finite number is the WORST value for that score (0, or 5 for risk): a forged `1e999` or a string is never the safe one (A139). A finite negative number is the worst too: a negative risk is not 0 (A163). */
const clamp = (n: unknown, worst = 0): number => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.min(5, Math.round(n)) : worst);

// Inserted noise: characters that render as nothing or as a look-alike. Removed before the refusal list is matched (A137, A149). \p{Cf} is the soft hyphen, the joiners, the direction marks and the tag characters; \p{Mn} and \p{Me} the combining marks.
const NOISE = /[\p{Cf}\p{Mn}\p{Me}\u034f\u115f\u1160\u180e\u2800\u3164\ufe00-\ufe0f\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
// Cyrillic and Greek look-alikes folded to Latin, after lower-casing (A149). 24 pairs; a map, not a skeleton, so a word in another language is not changed beyond these letters.
const LOOKALIKE: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0445": "x", "\u0443": "y", "\u0456": "i", "\u0455": "s", "\u0458": "j", "\u0501": "d", "\u051b": "q",
  "\u051d": "w", "\u04bb": "h", "\u0475": "v", "\u0461": "w", "\u03bd": "v", "\u03bf": "o", "\u03b1": "a", "\u03c1": "p", "\u03b9": "i", "\u03ba": "k", "\u03c5": "u", "\u03b5": "e",
};
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKE).join("")}]`, "g");
const fold = (s: string): string => s.toLowerCase().replace(LOOKALIKE_RE, (c) => LOOKALIKE[c] ?? c);

/** The forms the refusal list is matched against (A149). `plain`: compatibility-normalised and folded, the inserted noise kept. `clean`: also with the noise removed (NFKD first, so a combining mark is a character of its own, then NFKC). `squashed`: `clean` with spaces, hyphens, underscores and dots taken out, for the stems only. */
const forms = (t: string): { plain: string; clean: string; squashed: string } => {
  const plain = fold(t.normalize("NFKC")).replace(/\s+/g, " ").trim();
  const clean = fold(t.normalize("NFKD").replace(NOISE, "").normalize("NFKC")).replace(/\s+/g, " ").trim();
  return { plain, clean, squashed: clean.replace(/[\s\-_.]+/g, "") };
};

// Hard refusals: whatever the scores. A list, so a floor, not a classifier: it does not cover a phrase it was not written for, and the model's own risk label of 5 refuses too.
const GAP = "[\\s\\S]{0,120}";
const CAPTCHA = "(?:h|re)?captchas?";
const GATE = `${CAPTCHA}|paywalls?|log-?ins?|login walls?|2fa`;
const REFUSE: Array<[RegExp, string]> = [
  [new RegExp(`\\b(bypass\\w*|evad\\w*|circumvent\\w*|defeat\\w*|sidestep\\w*|side-step\\w*|work(?:s|ing)? around|get(?:s|ting)? (?:a)?round|beat\\w*|unlock\\w*|rotat\\w*|avoid\\w*|trick\\w*|disabl\\w*|umgeh\\w*)\\b${GAP}\\b(${CAPTCHA}|anti[- ]?bot|bot[- ]detection|rate[- ]?limit\\w*|paywalls?|paywalled|cloudflare|login walls?|2fa|two[- ]factor|detection|bans?|geo[- ]?blocks?|ip[- ]?(?:bans?|blocks?)|proxies|proxy|fingerprint\\w*)`), "circumvents an access control or anti-bot measure"],
  // A150: "get past", "slip past", "skip" with a captcha, a paywall or a login
  [new RegExp(`\\b(?:get|gets|getting|got|slip|slips|slipping|slipped|sneak|sneaks|sneaking)\\s+(?:past|over|through)\\b${GAP}\\b(?:${GATE})`), "gets past an access control"],
  [new RegExp(`\\bskip(?:s|ped|ping)?\\b${GAP}\\b(?:${GATE})`), "skips an access control"],
  // A150: solving captchas, password spraying, cracking a login
  [new RegExp(`\\bsolv(?:e|es|er|ers|ing)\\b${GAP}\\b${CAPTCHA}|\\b${CAPTCHA}[- ]?solvers?\\b`), "solves captchas for someone"],
  [new RegExp(`\\bpassword[- ]?spray\\w*|\\bcrack\\w*\\b${GAP}\\b(logins?|log-ins?|passwords?|passcodes?|accounts?|credentials?|2fa)`), "guesses or cracks passwords to get into an account"],
  [new RegExp(`\\b(scrap\\w*|harvest\\w*|collect\\w*|dump\\w*|steal\\w*|stol\\w*|exfiltrat\\w*|siphon\\w*|grab\\w*|mine|mining|sniff\\w*|leak\\w*)\\b${GAP}\\b(passwords?|credentials?|cookies?|session tokens?|tokens?|api keys?|private (messages|data)|personal (data|information)|e-?mails?( addresses)?|phone numbers?|addresses|logins?|2fa codes?|contact (details?|info(?:rmation)?|numbers?|data))`), "harvests credentials or personal data"],
  // A150: finding a person's home or real name from their handle
  [new RegExp(`\\b(find|locate|track down|trace|dig up)\\b${GAP}\\b(home address|residential address|home location|real name|whereabouts)`), "locates a person"],
  [/\b(keylogg\w*|ransomware|malware|botnet|credential[- ]stuff\w*|account takeover|phishing|phish\w*|rootkit|infostealer|spyware|stalkerware|ddos|denial[- ]of[- ]service|trojan|exploit kit|sim[- ]swap\w*|brute[- ]?forc\w*|leaked (passwords?|credentials?|databases?))\b/, "is malware or an attack tool"],
  [new RegExp(`\\b(clon\\w*|cop(?:y|ies|ying)|rip(?:s|ping)?|re-?upload\\w*|repost\\w*|download\\w*|steal\\w*|pirat\\w*)\\b${GAP}\\b(copyrighted|someone else'?s|other people'?s|their (videos?|content|app|brand|logo|design|website)|paid course|premium content|watermark\\w*|competitor'?s? (website|app|product|site))`), "copies a third party's protected work"],
  [/\b(mass|bulk|auto(?:matic(?:ally)?)?)[- ]?(follow|unfollow|dm|message|comment|like|spam)\w*\b|\b(follows?|likes?|comments? on|dms?) (\d{2,}|hundreds|thousands)\b[\s\S]{0,40}\b(accounts?|posts?|users?|people)\b|\bfake (accounts?|reviews?|followers?|likes?|engagement|traffic|views?|clicks?|impressions?|downloads?|installs?|subscribers?|ratings?|stars?)\b|\bsock ?puppets?\b|\bgrow (your |my )?followers\b[\s\S]{0,40}\b(bot|automat\w*)|\b(creat\w*|regist\w*|generat\w*) (hundreds|thousands) of (fake )?accounts?\b/, "is spam or fake engagement"],
  // A150: impersonating a real person or organisation, and doxxing
  [new RegExp(`\\bimpersonat\\w*\\b${GAP}\\b(ceo|cfo|cto|executives?|employees?|staff|bank|family|parents?|officials?|police|brand|company|colleagues?|managers?|celebrit\\w*|politicians?)\\b`), "impersonates a real person or organisation"],
  [/\bdox(?:x+|xing|xed|es|ed)?\b/, "doxxes a person"],
];
// the stems that are refused when spacing, punctuation or look-alike letters hide them (A149); matched on the squashed form only
const STEMS = /bypass|evad|circumvent|sidestep|keylogg|ransomware|malware|phishing|spyware|ddos/;

/** The reason a text is refused, or undefined. The rules run over the plain and the clean forms. A stem counts only when squashing made it: "bypass the cache" is not refused, "by pass the cache" is. */
function refusal(text: string): string | undefined {
  const f = forms(text);
  for (const [re, why] of REFUSE) if (re.test(f.plain) || re.test(f.clean)) return why;
  if (STEMS.test(f.squashed) && !STEMS.test(f.clean)) return "is written to hide a refused word with spaces, punctuation or look-alike letters";
  return undefined;
}

export function judge(input: { scores: Scores; idea: string; claims?: string[]; instructionsToAnAI?: string[]; about?: string; shown?: string[] }, th: Thresholds = DEFAULT_THRESHOLDS): Verdict {
  const s = input.scores;
  const c = s.cited ?? {};
  // a score with no citation is capped at 2
  const sc = (k: "relevance" | "value" | "feasibility" | "novelty" | "risk") => { const v = clamp(s[k]); return k === "risk" ? v : c[k] ? v : Math.min(v, 2); };
  const scores = { relevance: sc("relevance"), value: sc("value"), feasibility: sc("feasibility"), novelty: sc("novelty"), risk: clamp(s.risk, 5) };
  // every text the reader produced (A150): the idea, the claims, the summary and what was shown
  const why = refusal([input.idea, ...(input.claims ?? []), input.about ?? "", ...(input.shown ?? [])].join("\n"));
  if (why) return { verdict: "refuse", reason: `refused: the text ${why}`, scores };
  if (scores.risk >= 5) return { verdict: "refuse", reason: "refused: the reader rated the risk 5 of 5", scores };
  if ((input.instructionsToAnAI ?? []).length) return { verdict: scores.value >= th.value ? "ask" : "skip", reason: "the reel contains text addressed to an AI system; it is never built without the user's say-so", scores };
  const checks: Array<[string, boolean]> = [["value", scores.value >= th.value], ["relevance", scores.relevance >= th.relevance], ["feasibility", scores.feasibility >= th.feasibility], ["risk", scores.risk <= th.risk]];
  if (checks.every(([, ok]) => ok)) return { verdict: "implement", reason: "meets every threshold", scores };
  const near = (k: string) => k === "value" ? scores.value >= th.value - th.askSlack : k === "relevance" ? scores.relevance >= th.relevance - th.askSlack : k === "feasibility" ? scores.feasibility >= th.feasibility - th.askSlack : scores.risk <= th.risk + th.askSlack;
  const failing = checks.filter(([, ok]) => !ok).map(([k]) => k);
  if (failing.length <= 2 && failing.every(near) && scores.risk <= th.askRisk) return { verdict: "ask", reason: `close on ${failing.join(" and ")}; the user decides`, scores };
  return { verdict: "skip", reason: `below the bar on ${failing.join(", ")}`, scores };
}

// A citation must be a stretch of the project description (8 characters or more), with a word of 5 letters or more that is not a stop word (A163): "the and that with" proves nothing.
const STOP_WORDS = new Set(["about", "above", "after", "again", "being", "could", "every", "other", "their", "there", "these", "those", "which", "where", "while", "would", "should", "still", "think", "through"]);
const citable = (c: string): boolean => c.length >= 8 && (c.match(/\p{L}{5,}/gu) ?? []).some((w) => !STOP_WORDS.has(w));

/** The scorer's JSON to numbers: anything missing is 0 and uncited, so it cannot lift a verdict. A citation counts only if it is a stretch of the project description, checked here: a string such as "." is not one (A139), nor a string of stop words (A163). */
export function parseScores(raw: string, projectText = ""): { scores: Scores; citations: Record<string, string> } {
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  let j: any = {};
  try { if (a >= 0 && b > a) j = JSON.parse(raw.slice(a, b + 1)); } catch { /* all zeros */ }
  const hay = forms(projectText).clean;
  const cited: Scores["cited"] = {}; const citations: Record<string, string> = {};
  for (const k of ["relevance", "value", "feasibility", "novelty"] as const) {
    const c = typeof j?.cite?.[k] === "string" ? forms(j.cite[k]).clean.slice(0, 300) : "";
    if (citable(c) && hay.includes(c)) { cited[k] = true; citations[k] = c; }
  }
  return { scores: { relevance: clamp(j?.relevance), value: clamp(j?.value), feasibility: clamp(j?.feasibility), novelty: clamp(j?.novelty), risk: clamp(j?.risk, 5), cited }, citations };
}
