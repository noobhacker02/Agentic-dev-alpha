// Suites that do not exist yet. They show in the table as "not built" with the stage that will build them, so the table is also
// the to-do list for measurement. Remove an entry here when its suite file lands in suites/.
export const planned = [
  { id: "router", title: "Labelled tasks routed to the right flow, or to a question", unit: "of N", higherIsBetter: true, stage: "S3" },
  { id: "router-injection", title: "Router injection set that grants nothing", unit: "of N", higherIsBetter: true, stage: "S3" },
  { id: "watchdog", title: "Challenge/ban/loop traces detected, with false alarms on benign traces", unit: "of N", higherIsBetter: true, stage: "S4" },
  { id: "crash-resume", title: "Kill points after which resume applies exactly once", unit: "of N", higherIsBetter: true, stage: "S4" },
  { id: "redteam", title: "Fake-board red-team scenarios passed (server-side counts asserted)", unit: "of N", higherIsBetter: true, stage: "S5" },
  { id: "reel-extract", title: "Synthetic videos (overlay, silent, too long, huge, corrupt, playlist trick) handled as expected", unit: "of N", higherIsBetter: true, stage: "S5b" },
  { id: "reel-read", title: "Reader output: schema validated, citations checked, bad ones dropped", unit: "of N", higherIsBetter: true, stage: "S5b" },
  { id: "reel-judge", title: "Score vectors to verdicts, including every hard refusal", unit: "of N", higherIsBetter: true, stage: "S5b" },
  { id: "reel-injection", title: "Hostile captions and frame text: no tool call, never implement, task text clean", unit: "of N", higherIsBetter: true, stage: "S5b" },
  { id: "reel-e2e", title: "Fake reel to a kept and a reverted experiment on a fake metric", unit: "of N", higherIsBetter: true, stage: "S5b" },
  { id: "learner", title: "Learner precision and recall on a seeded history", unit: "of N", higherIsBetter: true, stage: "S6b" },
  { id: "team-vs-fixed", title: "Plain session vs fixed five vs dynamic team: score, cost, time (real model)", unit: "score", higherIsBetter: true, stage: "S7", real: true },
  { id: "pipeline-vs-plain", title: "Five-phase pipeline vs one plain session on the same tasks (real model)", unit: "score", higherIsBetter: true, stage: "S7", real: true },
];
