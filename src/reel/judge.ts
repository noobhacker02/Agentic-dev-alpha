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

// small capitals, Latin-extended and IPA letters, more Cyrillic and Armenian look-alikes (round-9 verifier: A149)
Object.assign(LOOKALIKE, {
  "\u1d00": "a", "\u0299": "b", "\u1d04": "c", "\u1d05": "d", "\u1d07": "e", "\ua730": "f", "\u0262": "g", "\u029c": "h", "\u026a": "i", "\u1d0a": "j", "\u1d0b": "k", "\u029f": "l", "\u1d0d": "m", "\u0274": "n", "\u1d0f": "o", "\u1d18": "p", "\u0280": "r", "\ua731": "s", "\u1d1b": "t", "\u1d1c": "u", "\u1d20": "v", "\u1d21": "w", "\u028f": "y", "\u1d22": "z",
  "\u0251": "a", "\u0261": "g", "\u0131": "i", "\u00f8": "o", "\u0153": "o", "\u00e6": "a", "\u043a": "k", "\u043c": "m", "\u043d": "h", "\u0442": "t", "\u0432": "b", "\u0562": "b", "\u0566": "q", "\u0578": "n", "\u057d": "u", "\u0585": "o", "\u0581": "g", "\u0561": "a", "\u0570": "h",
});

const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKE).join("")}]`, "g");
const fold = (s: string): string => s.toLowerCase().replace(LOOKALIKE_RE, (c) => LOOKALIKE[c] ?? c);

/** The forms the refusal list is matched against (A149). `plain`: compatibility-normalised and folded, the inserted noise kept. `clean`: also with the noise removed (NFKD first, so a combining mark is a character of its own, then NFKC). `squashed`: `clean` with spaces, hyphens, underscores and dots taken out, for the stems only. */
const LEET: Record<string, string> = { "4": "a", "@": "a", "3": "e", "1": "i", "!": "i", "0": "o", "$": "s", "5": "s", "7": "t", "|": "l" };
const forms = (t: string): { plain: string; clean: string; leet: string } => {
  const plain = fold(t.normalize("NFKC")).replace(/\s+/g, " ").trim();
  const clean = fold(t.normalize("NFKD").replace(NOISE, "").normalize("NFKC")).replace(/\s+/g, " ").trim();
  // leet: digits and symbols that stand for letters, spaces kept, so the ordinary rules run on it; skeleton: letters only (no spaces, digits, punctuation), so a separator of any kind is gone
  const leet = clean.replace(/[4@31!0$57|]/g, (c) => LEET[c] ?? c);
  return { plain, clean, leet };
};

// Hard refusals: whatever the scores. A list, so a floor, not a classifier: it does not cover a phrase it was not written for, and the model's own risk label of 5 refuses too.
const GAP = "[\\s\\S]{0,120}";
const CAPTCHA = "(?:h|re)?captchas?";
const GATE = `${CAPTCHA}|paywalls?|log-?ins?|login walls?|2fa`;
const REFUSE: Array<[RegExp, string]> = [
  [new RegExp(`\\b(bypass\\w*|evad\\w*|circumvent\\w*|defeat\\w*|sidestep\\w*|side-step\\w*|work(?:s|ing)? around|get(?:s|ting)? (?:a)?round|unlock\\w*|rotat\\w*|avoid\\w*|trick\\w*|disabl\\w*|umgeh\\w*)\\b${GAP}\\b(${CAPTCHA}|anti[- ]?bot|bot[- ]detection|rate[- ]?limit\\w*|paywalls?|paywalled|cloudflare|login walls?|2fa|two[- ]factor|detection|bans?|geo[- ]?blocks?|ip[- ]?(?:bans?|blocks?)|proxies|proxy|fingerprint\\w*)`), "circumvents an access control or anti-bot measure"],
  // "beat" only with a direct object that is a control ("beat detection in music" is not one)
  [new RegExp(`\\bbeat(?:s|ing)?\\s+(?:the\\s+|a\\s+)?(?:${CAPTCHA}|paywalls?|anti[- ]?bot|rate[- ]?limits?|bot[- ]detection|2fa|login walls?)`), "beats an access control"],
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
// stems matched on token-joined candidates (see hiddenStem): each letter may repeat, a "|" (a token boundary) may sit between any two letters, the stem must start at a token start and end at a token end, with an ordinary suffix allowed ("bypassing", "evaded", "keylogger"). So "b y p a s s", "bbypass", "byp4ss" and "key logger" match, "stand by passenger" and "add ostrich" do not (A149)
const word = (w: string): string => [...w].map((c) => `${c}+\\|?`).join("");
const SUFFIX = `(?:${["e", "es", "ed", "ing", "s", "er", "ers", "ger", "gers", "ging"].map(word).join("|")})?`;
const SKELETON = new RegExp(`(?<![a-z])(?:${["bypass", "circumvent", "sidestep", "keylog", "ransomware", "malware", "phishing", "spyware", "stalkerware", "infostealer", "rootkit", "evad"].map(word).join("|")}|d+\\|?d+\\|?o+\\|?s+)${SUFFIX}(?:\\||$)`);
const STEMS = /\b(?:ddos|bypass|circumvent|sidestep|keylogg|ransomware|malware|phishing|spyware|stalkerware|infostealer|rootkit|evade|evading)/;
// words that make a malware or attack-tool name a defensive idea ("detects phishing emails", "malware-free", "ddos-resilient"): such a text is a question for the user (ask), never an implement and never a final refusal
const DEFENSIVE = /\b(detect\w*|protect\w*|defen[cs]\w*|prevent\w*|block\w*|scan\w*|awareness|training|filter\w*|resilien\w*|monitor\w*|remov\w*|recogni[sz]\w*|mitigat\w*|anti)\b|-free\b|\bfree (?:of|from)\b/;


/** Candidate strings in which a refused stem could be hidden: every single token, and every run (up to 14 tokens) in which all but the last are four letters or fewer ("b y p a s s", "by pass", "key logger"), written with "|" at the token boundaries. A long word is never the first of a run, so "standby passenger" is not "bypass". Digits are tried as letters (k3ylogger) and as inserted noise (b4ypass). */
function hiddenStem(f: { clean: string; leet: string }): boolean {
  const forms = [f.leet, f.clean, f.clean.replace(/[0-9]+/g, "")];
  for (const form of forms) {
    const tokens = form.split(/[^a-z]+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      let run = "";
      for (let j = i; j < tokens.length && j < i + 14; j++) {
        run += `${tokens[j]}|`;
        if (SKELETON.test(run)) return true;
        if (tokens[j]!.length > 4) break;
      }
    }
  }
  return false;
}

/** The reason a text is refused (and whether it names an attack tool, which a defensive wording can soften to a question), or undefined. The rules run over the plain, the clean and the leet forms. */
function refusal(text: string): { why: string; tool: boolean; defensive: boolean } | undefined {
  const f = forms(text);
  const defensive = DEFENSIVE.test(f.clean) || DEFENSIVE.test(f.leet);
  for (const [re, why] of REFUSE) if (re.test(f.plain) || re.test(f.clean) || re.test(f.leet)) return { why, tool: why === "is malware or an attack tool", defensive };
  if (hiddenStem(f) && !STEMS.test(f.clean) && !STEMS.test(f.leet)) return { why: "is written to hide a refused word with spaces, punctuation, repeated letters or look-alike characters", tool: true, defensive };
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
  if (why) {
    // an attack tool named in a defensive sentence is a question for the user, not a final refusal and not an implement
    if (why.tool && why.defensive) return { verdict: "ask", reason: `the text names an attack tool in a defensive sense (${why.why}); the user decides`, scores };
    return { verdict: "refuse", reason: `refused: the text ${why.why}`, scores };
  }
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
