# Benchmark

A standing benchmark, kept current, so every improvement has a "before" and an "after". It exists because a claim in a README
that is typed by hand drifts; this table is generated from `bench/latest.json` and `bench/baseline.json` and a test fails if the
committed doc disagrees. The reasoning behind each movement is in [IMPROVEMENTS.md](IMPROVEMENTS.md) (the last column links it).

## Run it

```bash
npm run build
npm run bench                  # runs every built suite, records baselines for new ones, writes bench/latest.json
npm run bench -- --write-doc   # also regenerates the table below
```

Deterministic suites need no model and no network. Suites that use a real model are marked **gated**: they run only with
`AGENT_LOOP_REAL_MODEL_TESTS=1`, one at a time, and are bounded by the subscription's usage window (the SDK reports it), not by dollars.

## Rules

1. A baseline is the first value ever recorded for a suite. It is never overwritten silently; moving one needs an entry in
   [IMPROVEMENTS.md](IMPROVEMENTS.md) saying why.
2. A suite's scorer must be able to fail. `test/bench-suites.mjs` feeds each check silence (and the page's own URL) and requires
   a miss, and feeds it a real report and requires a hit. The first observability scorer passed "blank page" because the word
   appeared in the URL; that is why.
3. Changing what a suite counts is logged under "Definition changes" below, with the reason, in the same commit.
4. Numbers say what they measure and nothing more. "What these numbers do not show" below is part of the benchmark.
5. Adversary rounds ([HYBRID-AGENT-SPEC.md](HYBRID-AGENT-SPEC.md#the-adversary-loop-how-every-stage-is-tested-and-a-command-the-product-ships))
   report confirmed findings per round into the table's `adversary-yield` row; it should fall round over round.

## Results

<!-- bench:table:start -->
| Suite | What it measures | First recorded | Now | Change | Why / how |
|---|---|---|---|---|---|
| `adversary-yield` | Confirmed findings in the latest adversary round (tracked, not scored: more can mean a better adversary) | 20 @ 7138e1b | 14 | -6 (not scored) | IMP-018, IMP-031 |
| `browser-honesty` | Browser tools: a repeated failure, a query, a scrolling form, a huge page, forged text, a typed secret, a hung page, a popup storm and a bad status line all handled | 0/11 @ ecc83f2 | 11/11 | +11 (better) | IMP-017, IMP-018, IMP-019 |
| `file-hooks` | File-tool and safety hooks: paths and commands that must be denied, beside the ordinary ones that must not | 65/242 @ f10a830 | 242/242 | +177 (better) | IMP-016, IMP-031 |
| `form-coverage` | Form fields the agent is shown across iframes, shadow roots and hidden traps | 1/8 @ 646cdcb | 8/8 | +7 (better) | IMP-014, IMP-018 |
| `live-gate` | LIVE gate: address and URL forms, requests, sockets, redirect landings, public addresses and file destinations classified right (allowed ones allowed, the rest refused) | 0/156 @ b695f8c | 156/156 | +156 (better) | IMP-030, IMP-031 |
| `observability` | Page problems the agent is told about | 0/8 @ 7138e1b | 8/8 | +8 (better) | IMP-006, IMP-008, IMP-011, IMP-017, IMP-018 |
| `safety` | Dangerous commands the safety net denies | 26/26 @ 7138e1b | 26/26 | no change | IMP-001, IMP-006 |
| `shell-readonly` | Shell commands that run without a prompt: ordinary reading quiet, everything that writes, runs code or reads outside asks | 106/216 @ f10a830 | 216/216 | +110 (better) | IMP-016, IMP-031 |
| `team-invariants` | Generated team plans: valid accepted, every invalid one rejected for the right rule (V1 to V8, V10 to V12, V15) | 500/500 @ 1845dc7 | 500/500 | no change | IMP-015 |
| `team-sizing` | Labelled tasks composed into the expected size band with the mandatory roles; oversized plans counted | 28/28 @ 1845dc7 | 28/28 | no change | IMP-015 |
| `router` | Labelled tasks routed to the right flow, or to a question | not built | not built | planned in S3 | - |
| `router-injection` | Router injection set that grants nothing | not built | not built | planned in S3 | - |
| `watchdog` | Challenge/ban/loop traces detected, with false alarms on benign traces | not built | not built | planned in S4 | - |
| `crash-resume` | Kill points after which resume applies exactly once | not built | not built | planned in S4 | - |
| `redteam` | Fake-board red-team scenarios passed (server-side counts asserted) | not built | not built | planned in S5 | - |
| `reel-extract` | Synthetic videos (overlay, silent, too long, huge, corrupt, playlist trick) handled as expected | not built | not built | planned in S5b | - |
| `reel-read` | Reader output: schema validated, citations checked, bad ones dropped | not built | not built | planned in S5b | - |
| `reel-judge` | Score vectors to verdicts, including every hard refusal | not built | not built | planned in S5b | - |
| `reel-injection` | Hostile captions and frame text: no tool call, never implement, task text clean | not built | not built | planned in S5b | - |
| `reel-e2e` | Fake reel to a kept and a reverted experiment on a fake metric | not built | not built | planned in S5b | - |
| `learner` | Learner precision and recall on a seeded history | not built | not built | planned in S6b | - |
| `team-vs-fixed` | Plain session vs fixed five vs dynamic team: score, cost, time (real model) | not built | not built | planned in S7 (real model, gated) | - |
| `pipeline-vs-plain` | Five-phase pipeline vs one plain session on the same tasks (real model) | not built | not built | planned in S7 (real model, gated) | - |
Latest run: commit `c653d4d`, 2026-10-08. Baselines are the first value ever recorded for a suite and are never overwritten without an entry in IMPROVEMENTS.md.
<!-- bench:table:end -->

## Definition changes

| Date | Suite | Change | Why |
|---|---|---|---|
| 2026-10-02 | `safety` | Denominator 27 -> 26. `env` is listed separately as mitigated by the minimal environment. | The first run scored 26 of 27; `env` is not denied by design (`src/env.ts`, `test:scope`), so counting it as a miss misreported a documented decision. |
| 2026-10-02 | `observability` | Probe URLs made opaque (`/p1` ...). | The first scorer reported 2 of 8; "blank" matched the URL `/blank`. The real first baseline is 1 of 8. |
| 2026-10-02 | `observability` | The long-text probe follows the `text` tool's own pagination hint (`offset=N`), up to ten more calls. | The check needs an agent that reads a long page the way the tool tells it to. Before the `text` tool exists there is no hint, so the baseline (1 of 8) is unaffected. |
| 2026-10-02 | `observability` | The redirect probe now requires an explicit report of the redirect, and the failed-request probe requires `404` on the same line as `missing.js`. **Baseline corrected from 1 of 8 to 0 of 8.** | Adversary round 1 (A14): the one point the old tools earned was for the redirect, scored only because `inspect` prints the current URL. The corrected number was measured, not assumed: commit `7138e1b` was built in a scratch worktree and scored with the corrected suite (0 of 8). |
| 2026-10-07 | `browser-honesty` | The popup-storm check waits until the page reports its storm is over (a request to `/done`) plus half a second, instead of 2.5 s; the scenario (30 popups, 8 requests each, video on) is unchanged. No baseline moved: the unmodified build `ecc83f2` still scores 0 of 11 and this tree 11 of 11. | The full suite on `790771e` measured this check as failed on a loaded machine (10 of 11): the fixed wait ended mid-storm (IMP-019). |

## The two skills

- **agent-loop** (this repo): the table above.
- **dev-workflow** (the Dev-Skill repo): `dev-workflow/references/benchmark.md` there records SKILL.md size, the scanner's detection
  rate on its stress cases, and the real-model A/B results, in the same shape. Run its `tests/bench_skill.py`.

## What these numbers do not show

- `observability` scores whether a token reaches the agent through the tools, not whether a model uses it well.
- `safety` is 26 hand-picked spellings of dangerous commands; a new spelling is a new test, not a pass.
- `form-coverage` scores what the tools show about one hand-built page (three kinds of container, one closed shadow root, one trap); it does not show that every real application form is read in full, and it does not test pages that load frames late by script.
- `browser-honesty` scores eleven behaviours on hand-built pages and one stand-in upstream. The three that end or hang a process (a storm of popups, a bad status line, a page stuck in a loop) run in a child with a time limit, and a timeout counts as a failure; the popup storm is a race, so it is judged by a scenario harsh enough that the old build died in six runs of six, which is not every race a page could set up. It does not show that no other page can end a run.
- Nothing here measures real sites, real accounts, or real bans. The fake job board (S5) simulates them; the README will say so.
- Real-model arms are single runs per cell unless the row says otherwise. Treat one run as an anecdote.
