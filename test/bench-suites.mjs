// Controls for the benchmark scorers: each check must MISS when the tools say nothing (even when the page URL is shown), and HIT on a real report.
import assert from "node:assert";
import { CHECKS, PROBE_PATHS } from "../bench/suites/observability.mjs";

const ids = Object.keys(CHECKS);
assert.strictEqual(ids.length, 8);
// What a tool that says nothing prints. The port is not fixed, the redirect page shows the URL it landed on (as every real inspect does), and the page's own source
// may be echoed: none of those may count as a report.
const quiet = (p, port = 40412) => `Opened http://127.0.0.1:${port}${p} in t1. Title: t\nURL: http://127.0.0.1:${port}${p === "/p7" ? "/final-landing" : p}\nTitle: t\nTab: t1 (1 open)\n\nVisible text (truncated):\n<script src="/missing.js"></script>\n\nInteractive elements (snapshot s1):\n(none)`;
const positives = {
  "page-error": "Page error: Uncaught Error: boom-uncaught-7",
  "console-error": "console.error: render-failed-9",
  "failed-request": "- t1 http: 404 GET 127.0.0.1:1234/missing.js (script)",
  "dialog": "A dialog appeared and was dismissed: alert 'hello-dialog-5'",
  "download": "Download started: file.bin (not opened)",
  "blank-page": "The page appears blank (no visible text).",
  "redirect": "- t1 redirect: 302 127.0.0.1:1234/p7 -> 127.0.0.1:1234/final-landing",
  "long-text": "... THE-END-MARKER-42",
};

function silenceMisses(checks) {
  for (const id of ids) for (const p of PROBE_PATHS) for (const port of [1234, 40412, 404, 80404]) if (checks[id](quiet(p, port))) return `${id} reported by silence on ${p} (port ${port})`;
  return null;
}
assert.strictEqual(silenceMisses(CHECKS), null, "a check passes on silence");
for (const id of ids) assert.ok(CHECKS[id](positives[id]), `${id} does not accept its own real report`);

// The control itself must have teeth: a scorer that says yes to everything is caught.
const lenient = Object.fromEntries(ids.map((i) => [i, () => true]));
assert.notStrictEqual(silenceMisses(lenient), null, "the silence control cannot detect a lenient scorer");
const urlMatcher = { ...CHECKS, "blank-page": (o) => /blank|p6/.test(o) };
assert.notStrictEqual(silenceMisses(urlMatcher), null, "the silence control cannot detect a check that matches the URL");

console.log(`[ok] bench scorers: ${ids.length} checks miss on silence and hit on a report; lenient and URL-matching scorers are caught`);
