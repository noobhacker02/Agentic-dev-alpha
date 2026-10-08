// Step 4 of the reel flow, the part that is code: the reader (a model with no tools) returns JSON; this turns it into a trusted summary or refuses it. Unknown keys are dropped, lengths are capped, and every claim must cite
// evidence that exists: a quote that is a substring of the caption, transcript or frame text, or a frame index inside the bundle (threat R4). A claim whose citation fails is dropped, never trusted.
export interface Evidence { caption: string; transcript: string; frameText: string[]; frames: number }
export interface Claim { text: string; kind: "demonstrated" | "asserted"; cite: { frame?: number; quote?: string } }
export interface Summary {
  about: string; shown: string[]; claims: Claim[]; idea: string;
  perception: { caption: boolean; frames: number; transcript: boolean };
  instructionsToAnAI: string[]; droppedClaims: number;
}
export type ReadResult = { ok: true; summary: Summary } | { ok: false; reason: string };

const cap = (s: unknown, n: number): string => (typeof s === "string" ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, n) : "");
const norm = (s: string): string => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

export function parseReaderOutput(raw: string, ev: Evidence): ReadResult {
  // the first JSON object in the text, in case the model wrapped it in a fence
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, reason: "the reader did not return JSON" };
  let j: any;
  try { j = JSON.parse(raw.slice(start, end + 1)); } catch { return { ok: false, reason: "the reader's JSON could not be parsed" }; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, reason: "the reader's JSON is not an object" };
  const about = cap(j.about, 800);
  if (!about) return { ok: false, reason: "the reader gave no summary" };
  const hay = [ev.caption, ev.transcript, ...ev.frameText].map(norm);
  const claims: Claim[] = []; let dropped = 0;
  for (const c of Array.isArray(j.claims) ? j.claims.slice(0, 20) : []) {
    const text = cap(c?.text, 300);
    const kind = c?.kind === "demonstrated" ? "demonstrated" : "asserted"; // anything unclear is the weaker word
    const frame = Number.isInteger(c?.cite?.frame) ? c.cite.frame : undefined;
    const quote = cap(c?.cite?.quote, 300);
    const frameOk = frame === undefined || (frame >= 0 && frame < ev.frames);
    const quoteOk = !quote || (norm(quote).length >= 4 && hay.some((h) => h.includes(norm(quote))));
    const cited = frame !== undefined || !!quote;
    if (!text || !cited || !frameOk || !quoteOk) { dropped++; continue; }
    claims.push({ text, kind, cite: { ...(frame !== undefined ? { frame } : {}), ...(quote ? { quote } : {}) } });
  }
  // "demonstrated" needs a frame: words alone can only assert
  for (const c of claims) if (c.kind === "demonstrated" && c.cite.frame === undefined) c.kind = "asserted";
  const strs = (a: unknown, n: number, m: number) => (Array.isArray(a) ? a.slice(0, n).map((x) => cap(x, m)).filter(Boolean) : []);
  return {
    ok: true,
    summary: {
      about, shown: strs(j.shown, 10, 300), claims, idea: cap(j.idea, 600),
      // what was perceived comes from the evidence we gave, never from what the model says it saw
      perception: { caption: ev.caption.length > 0, frames: ev.frames, transcript: ev.transcript.length > 0 },
      instructionsToAnAI: strs(j.instructions_to_an_ai_found, 10, 300), droppedClaims: dropped,
    },
  };
}
