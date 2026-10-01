// Realistic run event streams, for judging the persona on something with the shape of a real run instead of a
// scripted-model run that lasts under a second. The shapes come from real runs recorded in docs/UI.md and
// docs/STRESS-TEST-REPORT.md: a real pipeline takes about 6 minutes (6.3 for the Roman-numeral task), makes
// 10 or so LLM sessions, asks for 11-16 approvals when the UI is configured as shipped, and costs about $1.40.
// Deterministic (seeded), so a number printed here is the same every time.
//
//   simulateRun("typical"): 6.3 minutes, 11 prompts answered in a few seconds each, no repairs
//   simulateRun("rough"):   about 30 minutes, three repairs, a refusal streak, a slow answer
//   simulateRun("speedy"):  a person approving 25 prompts in under a second each
//   simulateRun("failed"):  repairs run out and the run fails
//   simulateRun("night"):   a typical run started at 02:40 local
//
// Returns { events, durationSec }. Every event has the fields the real ones have.

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const PHASES = ["planner", "test-designer", "builder", "verifier", "gatekeeper"];

const PROFILES = {
  typical: { phaseSec: [55, 35, 130, 80, 35], prompts: 11, answer: [2, 25], repairs: [], cost: 1.41, tools: 70, start: [2026, 8, 30, 14, 5] },
  rough: {
    phaseSec: [60, 45, 150, 100, 55], prompts: 30, answer: [3, 60], cost: 6.2, tools: 260, start: [2026, 8, 30, 15, 20],
    repairs: [{ after: "verifier", target: "builder" }, { after: "gatekeeper", target: "builder" }, { after: "verifier", target: "builder" }],
    refusalStreak: 3, slowAnswerSec: 190,
  },
  speedy: { phaseSec: [50, 30, 120, 80, 30], prompts: 25, answer: [0.4, 0.9], repairs: [], cost: 1.9, tools: 90, start: [2026, 8, 30, 11, 0] },
  failed: {
    phaseSec: [55, 35, 130, 80, 35], prompts: 14, answer: [2, 20], cost: 3.1, tools: 110, start: [2026, 8, 30, 16, 10],
    repairs: [{ after: "verifier", target: "builder" }, { after: "verifier", target: "builder" }], endStatus: "failed",
  },
  night: { phaseSec: [55, 35, 130, 80, 35], prompts: 11, answer: [2, 25], repairs: [], cost: 1.41, tools: 70, start: [2026, 8, 30, 2, 40] },
};

export function simulateRun(name, { runId = `sim-${name}`, seed = 7, startMs } = {}) {
  const p = PROFILES[name];
  if (!p) throw new Error(`unknown profile ${name}`);
  const rand = rng(seed + name.length);
  const t0 = startMs ?? new Date(...p.start).getTime();
  let t = 0; // seconds since start
  const events = [];
  const at = () => new Date(t0 + t * 1000).toISOString();
  const push = (e) => events.push({ runId, ts: at(), ...e });
  const verdict = (outcome, headline) => ({ completed: true, outcome, headline, details: "", concerns: [], blockingFindings: outcome === "pass" ? [] : ["something is wrong"] });

  // Order the phases run in, with repairs inserted where the profile says. Attempts are numbered per phase and
  // only ever go up, as in the real pipeline (a second "builder attempt 2" would be a different run).
  const plan = [];
  const attemptOf = {};
  const add = (phase) => { attemptOf[phase] = (attemptOf[phase] ?? 0) + 1; const step = { phase, attempt: attemptOf[phase], fail: false }; plan.push(step); return step; };
  for (const ph of PHASES) {
    let step = add(ph);
    for (const r of p.repairs.filter((x) => x.after === ph)) {
      step.fail = true;
      step.repairTarget = r.target;
      add(r.target);
      step = add(ph);
    }
  }
  const totalPhaseSec = plan.reduce((n, step) => n + p.phaseSec[PHASES.indexOf(step.phase)], 0);
  const promptsPerSec = p.prompts / totalPhaseSec;
  let promptCarry = 0, rid = 0, costSoFar = 0, toolsLeft = p.tools, refusals = 0, askedTotal = 0;

  push({ type: "run-start", task: "Build the thing", workDir: "/tmp/sim" });
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const dur = p.phaseSec[PHASES.indexOf(step.phase)];
    t += 0.2;
    push({ type: "phase-start", phase: step.phase, attempt: step.attempt });
    const prompts = Math.round((promptCarry += dur * promptsPerSec));
    promptCarry -= prompts;
    const slots = dur / (prompts + 1);
    for (let k = 0; k < prompts; k++) {
      t += slots * (0.6 + rand() * 0.8);
      const requestId = `r${++rid}`;
      push({ type: "approval-request", phase: step.phase, requestId, toolUseId: requestId, toolName: "Bash", toolInput: { command: "npm test" } });
      askedTotal++;
      let wait = p.answer[0] + rand() * (p.answer[1] - p.answer[0]);
      if (p.slowAnswerSec && askedTotal === Math.round(p.prompts / 2)) wait = p.slowAnswerSec;
      let decision = "allow";
      if (p.refusalStreak && refusals < p.refusalStreak && askedTotal >= 6) { decision = "deny"; refusals++; }
      t += wait;
      push({ type: "approval-resolved", phase: step.phase, requestId, toolUseId: requestId, decision, auto: false });
      if (decision === "allow" && rand() < 0.2) {
        // an approval that saves a rule
        events[events.length - 1].rememberedRule = `Bash(rule-${rid}:*)`;
      }
      // tool activity and cost between prompts
      const tc = Math.min(toolsLeft, Math.round((p.tools / p.prompts) * (0.5 + rand())));
      for (let c = 0; c < tc; c++) push({ type: "tool-call", phase: step.phase, toolUseId: `t${rid}-${c}`, toolName: "Read", toolInput: { file_path: "/tmp/sim/a" } });
      toolsLeft -= tc;
      const cost = (p.cost / (plan.length * 4)) * (0.6 + rand() * 0.8);
      costSoFar += cost;
      push({ type: "usage", phase: step.phase, costUsd: cost, inputTokens: 1, outputTokens: 1 });
    }
    t = Math.max(t, 0) + slots * 0.5;
    const failing = step.fail;
    push({ type: "phase-end", phase: step.phase, attempt: step.attempt, verdict: verdict(failing ? "fail" : "pass", failing ? "Found a problem" : "Done") });
    t += 0.3;
    if (failing) {
      push({ type: "overseer-decision", phase: step.phase, decision: { action: "repair", repairTarget: step.repairTarget, reasoning: "fix it" } });
    } else if (i < plan.length - 1) {
      push({ type: "overseer-decision", phase: step.phase, decision: { action: "continue", reasoning: "ok" } });
    }
  }
  t += 0.5;
  push({ type: "run-end", status: p.endStatus ?? "done" });
  return { events, durationSec: t, totalCost: costSoFar };
}

/** Replays events through a director on a fresh bus, awaiting a tick after each so notes interleave as they would live. */
export async function replay(events, makeDirector) {
  const { EventBus } = await import("../dist/bus.js");
  const bus = new EventBus();
  const notes = [];
  bus.on("event", (e) => e.type === "persona-note" && notes.push(e));
  makeDirector(bus);
  const tick = () => new Promise((r) => setImmediate(r));
  for (const e of events) {
    bus.emitEvent(e);
    await tick();
  }
  return { notes, history: bus.allEvents() };
}
