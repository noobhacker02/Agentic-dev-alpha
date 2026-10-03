// Controls for the benchmark scorers: each check must MISS when the tools say nothing (even when the page URL is shown), and HIT on a real report.
import assert from "node:assert";
import { CHECKS, PROBE_PATHS } from "../bench/suites/observability.mjs";
import { CHECKS as FORM_CHECKS, PROBE_PATHS as FORM_PATHS } from "../bench/suites/form-coverage.mjs";
import { generate, scoreWith } from "../bench/suites/team-invariants.mjs";
import { scoreSizing, TASKS as SIZING_TASKS } from "../bench/suites/team-sizing.mjs";
import { validatePlan } from "../dist/team/plan.js";
import { BUILTIN_ROSTER } from "../dist/team/roster.js";
import { composeOffline } from "../dist/team/compose.js";
import { computeSignals } from "../dist/team/signals.js";

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

// ---- form-coverage: the same controls. A check must miss on silence, on a page whose labels and source are echoed as plain text (the field is mentioned,
// not offered as a ref), and hit on a real report.
{
  const fids = Object.keys(FORM_CHECKS);
  assert.strictEqual(fids.length, 8);
  const head = (port, extra = "") => `Opened http://127.0.0.1:${port}/f in t1. Title: Apply\nURL: http://127.0.0.1:${port}/f\nTitle: Apply\nTab: t1 (1 open)\n\nVisible text (truncated):\nApply for the job${extra}\n\nInteractive elements (snapshot s1):\n`;
  const echoed = `\nMAIN-FIELD-1 YEARS-FIELD-2 XORIGIN-FIELD-3 SHADOW-FIELD-4\n<input id="trap-9" name="website" style="opacity:0">\n<closed-card></closed-card> was closed`;
  const quietForm = (port, extra) => head(port, extra) + "(none)";
  const refsFor = (tokens, extra = "") => tokens.map((t, i) => `[s1e${i + 1}] textbox "${t}" id="x${i}" value="${extra}"`).join("\n");
  const formPositives = {
    "main-frame-field": head(1234) + refsFor(["Main-frame field MAIN-FIELD-1"]),
    "same-origin-iframe-field": head(1234) + refsFor(["Years of experience YEARS-FIELD-2"]),
    "cross-origin-iframe-field": head(1234) + refsFor(["Cross-origin field XORIGIN-FIELD-3"]),
    "open-shadow-root-field": head(1234) + refsFor(["Shadow field SHADOW-FIELD-4"]),
    "iframe-field-fillable-by-ref": "Filled s1e2\n" + head(1234) + `[s2e2] spinbutton "Years of experience YEARS-FIELD-2" id="years" value="7"`,
    "closed-shadow-root-reported": head(1234) + "(none)\nCould not read: 1 custom element may hold a closed shadow root, so its fields cannot be listed.",
    "hidden-trap-flagged-not-offered": head(1234) + "(none)\nNot visible to a person, so not listed (pages use such fields to catch bots): text field id=\"trap-9\" name=\"website\"",
    "hidden-trap-fill-refused": "Refused: #trap-9 is not visible to a person (a page uses fields like that to catch bots).",
  };
  const quietCases = [];
  for (const port of [1234, 40412, 404, 80404]) for (const p of FORM_PATHS) quietCases.push(quietForm(port, ""), quietForm(port, echoed), `THREW locator.fill: Timeout 5000ms exceeded.`);
  const formSilence = (checks) => {
    for (const id of fids) for (const q of quietCases) if (checks[id](q)) return `${id} passed on silence: ${q.slice(0, 80)}`;
    return null;
  };
  assert.strictEqual(formSilence(FORM_CHECKS), null, "a form-coverage check passes on silence");
  for (const id of fids) assert.ok(FORM_CHECKS[id](formPositives[id]), `${id} does not accept its own real report`);
  const lenientForm = Object.fromEntries(fids.map((i) => [i, () => true]));
  assert.notStrictEqual(formSilence(lenientForm), null, "the form silence control cannot detect a lenient scorer");
  const tokenMatcher = { ...FORM_CHECKS, "same-origin-iframe-field": (o) => /YEARS-FIELD-2/.test(o) };
  assert.notStrictEqual(formSilence(tokenMatcher), null, "the form silence control cannot detect a check that matches the page's own text");
  const echoMatcher = { ...FORM_CHECKS, "hidden-trap-flagged-not-offered": (o) => /trap-9/.test(o) && /opacity|hidden/i.test(o) };
  assert.notStrictEqual(formSilence(echoMatcher), null, "the form silence control cannot detect a check that accepts the page's own source");
  // Offering the trap as an ordinary field is the failure the check exists for.
  assert.ok(!FORM_CHECKS["hidden-trap-flagged-not-offered"](head(1234) + refsFor(["x trap-9"]) + "\nhidden text trap-9"), "listing the trap as a ref still counted as flagging it");
  console.log(`[ok] bench scorers (form-coverage): ${fids.length} checks miss on silence and on echoed page text and hit on a report; lenient, text-matching and source-echo scorers are caught`);
}

// ---- team-invariants and team-sizing: a scorer has to be able to give a bad grade. A validator that accepts everything, one that refuses everything, and one that refuses for
// the wrong reason each score badly; so does a composer that always returns the same team, and one that always returns the smallest.
{
  const cases = generate(500);
  assert.strictEqual(cases.length, 500, "the generator did not make 500 cases");
  assert.deepStrictEqual(generate(500), cases, "the generator is not deterministic");
  const mutants = cases.filter((c) => c.kind === "mutant"), valid = cases.filter((c) => c.kind === "valid");
  assert.ok(valid.length >= 90 && mutants.length >= 380, `the mix of cases is off: ${valid.length} valid, ${mutants.length} mutants`);
  const rules = new Set(mutants.map((c) => c.expect));
  for (const r of ["V1", "V2", "V3", "V4", "V5", "V6", "V8", "V10", "V15", "WHY", "FIELD"]) assert.ok(rules.has(r), `no mutant breaks ${r}`);
  const real = (plan, ctx) => validatePlan(plan, { roster: BUILTIN_ROSTER, ...ctx });
  assert.strictEqual(scoreWith(real, cases).right, 500, "the real validator does not score full marks on its own suite");
  const lenient = scoreWith(() => ({ ok: true, violations: [] }), cases);
  const strict = scoreWith(() => ({ ok: false, violations: [{ rule: "V1" }] }), cases);
  const wrongRule = scoreWith((plan, ctx) => { const v = real(plan, ctx); return { ok: v.ok, violations: v.ok ? [] : [{ rule: "V1" }] }; }, cases);
  const crashing = scoreWith(() => { throw new Error("boom"); }, cases);
  assert.ok(lenient.right <= 120, `a validator that accepts everything scored ${lenient.right} of 500`);
  assert.ok(strict.right <= 120, `a validator that refuses everything scored ${strict.right} of 500`);
  assert.ok(wrongRule.right <= 250, `a validator that refuses for the wrong rule scored ${wrongRule.right} of 500`);
  assert.ok(crashing.right <= 120, `a validator that crashes scored ${crashing.right} of 500 (a crash is not a refusal)`);
  // dropping one rule from the real validator costs points: the suite notices a missing rule
  const noV4 = scoreWith((plan, ctx) => real(plan, { ...ctx, required: [] }), cases);
  assert.ok(noV4.right < 500 && noV4.wrong.V4 > 0, "a validator without V4 still scored full marks");
  console.log(`[ok] team-invariants: 500 deterministic cases (${valid.length} valid, ${mutants.length} mutants over ${rules.size} rules); lenient ${lenient.right}, strict ${strict.right}, wrong-rule ${wrongRule.right}, crashing ${crashing.right}; a validator without V4 loses ${500 - noV4.right}`);
}
{
  const real = (task, files) => composeOffline(task, computeSignals(task, { files }), BUILTIN_ROSTER).plan?.steps.map((s) => s.role) ?? [];
  const good = scoreSizing(real);
  assert.strictEqual(good.right, SIZING_TASKS.length, `the real composer misses: ${JSON.stringify(good.misses)}`);
  assert.strictEqual(good.oversized, 0);
  const fixedFive = scoreSizing(() => ["planner", "test-designer", "builder", "verifier", "gatekeeper"]);
  const smallest = scoreSizing(() => ["builder", "verifier", "gatekeeper"]);
  const huge = scoreSizing(() => Array.from({ length: 14 }, () => "builder"));
  assert.ok(fixedFive.right <= 8, `a fixed team of five scored ${fixedFive.right} of ${SIZING_TASKS.length}`);
  assert.ok(smallest.right <= 8, `the smallest team scored ${smallest.right}`);
  assert.strictEqual(huge.right, 0, "a team of fourteen builders scored points");
  assert.strictEqual(huge.oversized, SIZING_TASKS.length, "oversized plans were not counted");
  assert.strictEqual(scoreSizing(() => { throw new Error("boom"); }).right, 0, "a composer that crashes scored points");
  assert.strictEqual(SIZING_TASKS.length, 28, "the labelled task list changed size without the suite's title saying so");
  console.log(`[ok] team-sizing: 28 labelled tasks; the real composer ${good.right}; a fixed five ${fixedFive.right}, the smallest team ${smallest.right}, fourteen builders 0 with ${huge.oversized} oversized plans counted`);
}
