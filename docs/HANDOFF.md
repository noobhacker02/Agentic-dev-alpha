# Handoff: read this first after any context loss

This file exists because the working conversation has already been compacted once and a summary is lossy. It is the
single place that says what was asked, what was decided, where things are, what is done, what is not, and what to do next.
**Update it at the end of every stage, after every commit that changes direction, and whenever the user adds a requirement.**
`test/handoff.mjs` fails if it falls more than 8 commits behind, or loses a section.

Updated: 2026-10-07T06:19:34Z
Covers agent-loop commit: 922e709
Covers Dev-Skill commit: df00698

Reading of the word "automcator" in the user's last message: auto-compaction of the conversation. If the user meant something
else, this paragraph is wrong and should be corrected.

## Standing instructions

- A standing `/loop`: an adversarial build, test and document cycle across **two repos**. Verify by running things. Keep a
  PM-style task list. Keep the dev-workflow skill improving.
  - agent-loop: `noobhacker02/Agentic-dev-alpha`, dir `/home/user/Dev-Skill/agent-loop`, branch `main`. (Nested inside the Dev-Skill
    checkout but **gitignored there**; it is a separate repo.)
  - Dev-Skill: `/home/user/Dev-Skill`, branch `claude/dev-workflow-process-v4kafr`.
- **Always keep a benchmark, keep improving both skills, and keep a changelog saying why and how each improvement was made**
  ([BENCHMARK.md](BENCHMARK.md), [IMPROVEMENTS.md](IMPROVEMENTS.md), and `dev-workflow/references/improvement-log.md`).
  "Both skills" = the dev-workflow skill and agent-loop with its flow skills.
- **Before the conversation is compacted**, this handoff must be current. Hooks save the compaction summary and re-inject this
  file; they are configured but their live firing is **unproven** until the next compaction happens (see Verified and not verified).
- **Save before usage runs out** (the user asked twice): when usage is nearly out, run `npm run checkpoint` (commits and pushes both repos, never `--no-verify`), update this file's
  "Next step" and what is verified, make anything in the background write to disk as it goes, and only then continue. Rules live in `CLAUDE.md` (loaded each session), the
  dev-workflow skill (Step 9) and `docs/SELF-HEALING.md`, the catalog of recoveries and of mistakes made more than once, which gets a row the second time anything fails.
- Persona rules: tease tool-usage habits, never the person; "politics" means legislature process only; dark but not too dark.
- Ask before costly real-model runs (the user has since said subscription use is fine: "we aren't paying money", but keep it bounded
  by usage windows).
- Commit and push each stage; re-run the whole suite before claiming it passes; check CI on Linux, macOS and Windows.
- Never push to a different branch of Dev-Skill than `claude/dev-workflow-process-v4kafr`. Do not open pull requests unless asked.

Hard rules I stated and must keep:

1. **Never evade bans or anti-bot.** No proxy rotation, fingerprint spoofing, CAPTCHA solving. On a challenge, 429 or 403:
   slow down, stop, tell the user, take a safer path.
2. **Never test against real LinkedIn or real sites from here.** Local fake job board only.
3. Passwords and cookies are never recorded, even though "keep everything for debugging" was chosen.
4. The profile directory is local-only, mode 0700, outside the repo and outside `--dir`; reports carry a "contains account pages,
   don't share" banner.
5. Report outcomes faithfully. A claim that "the suite passes" is about the commit it was run on.

## What the user asked, in their words

Newest last. Do not paraphrase these away.

1. "Update the git hubbrewseme and video and images all of it bro okay in-depth" / "So teste indeothnandntegh come back to me go"
   (README, videos, images, tested end to end). **Done.**
2. "Did we properly implemented the browser and computer use controls from.open claw?" **Answered by an audit, docs/REFERENCE-AUDIT.md.**
3. "Anything that we are missing in this?, see our thing should be a hybrid of how OpenClaw do things and we put loop and goal in it
   and combine Claude in it with our UI so let's say not only development if said let's say apply for jobs or do some task it should
   automatically understand and have skills for such things we can have an intent based or router agent for haiku and then use and
   make an entire flow like a self sustaining agent which auto heals kinda so we know what the worse thing would be if he does that
   like ip ban and what not and foul thing's which could happen and then do everything in depth and fix it so make this and what you
   said and make a /goal for this and keep doing this until it's all done and fixed and all good okay in-depth okay any questions ask me"
4. Answers to my questions (first batch): first flow = job applications; autonomy = fully autonomous inside budget and rules; logins =
   "we do all of em but for now what's the easiest we log and keep it in and then our bot takes in control and starts doing it";
   spend = "Bro we are on subscription plan so use what's the problem we aren't paying money".
5. Second batch: runs on the user's own computer; unknown form answer = pause that job, ask, remember; pace = 30 a day, 10 an hour,
   1 to 3 minutes apart; self-heal = runtime only (retry, back off, re-plan, skip, pause, ask), no self-editing.
6. Third batch: "See when you are testing we will have like only allowance to run the local. Host but when we are using or exploring
   let's say our staging link or some scrolling or doing something like applying jobs in this case it should be have access to
   internet so we have like router and allowances list and we ofc have the overseerrr who is always seeing what is happening always";
   challenge = pause that site and wait, never auto-resume; privacy = "Keep everything for debugging"; job sources = generic
   form-reading + LinkedIn Easy Apply playbook + Greenhouse/Lever/Workday style + Indeed/other boards.
7. "Then we set a goal afterwards so plan nicely and we have more stuff in this we add this as well if we haven't as of now"
   + the **ponytail** repo (github.com/dietrichgebert/ponytail) + "we need to make it slowly pickup all the task slowly slowly one
   by one everything so it can do everything without cluttering" + "we still need to follow the overseerrr big model and executor
   small model like how pokeharnes does so copy anything and everything you feel from there as well ... feel free to have your own
   better logic ... /goal any questions ask me".
8. "Always keep a benchmark and keep improving both skills and tell and have changlog of why we did an improvement and how so we
   know logically oh okay we do this kinda okay".
9. "And whenever we are about to use automcator we make sure we have enough documentsuoksn to know what we did and what improvement
   can be done more so we don't forget any context about any work okay indepth nicely".
10. "And we keep adversity testing add in the flow as well like self learning as well of what we use very often we add and make it's
   into a process as well okay like I like Adversities testing using a. New spin up agent so fresh context and better data and then
   we get data and documents and we improve the whole setup and then test real life and bad we fix and then all.good and then we do
   adverdial testing and then fix and keep doing it until we hit our goal gotcha indoeyj /goal". Built into the spec as the
   adversary loop (a fresh agent each round) and the learning loop (proposals from repeated use, accepted by the user).
11. "Add this in the both the multi agent setup ours like we won't have constant numbers of 5 agents we would have more as well but
   like depending on task kinda and add this is dev skill as well indepth and nicely and propely". Designed in
   docs/TEAM-COMPOSITION.md (agent-loop) and `dev-workflow/references/team-composition.md` (skill).
12. "Okay continue /Goal also can you add something which esislti if I send a reel from Instagram reads it and then tells me what it's
   about and then if it's good enough we implemente it". Designed in docs/REEL-FLOW.md (stage S5b): the reliable path is the user giving
   a file or pasted text; reading the URL is a convenience that stops and asks when the site pushes back (no evasion); a reel's claim is
   treated as a hypothesis and implemented as a measured experiment. Real Instagram cannot be tested from here.
13. "We are about to be out of usage make sure whenever we are close to hitting usage we save everything before moving ahead so we don't redo stuff okay remember
   this in memory and process both and keep remembering all self healing stuff you can do and we should do okay so we don't rmekae shit a lot of em okay". Done:
   `CLAUDE.md` in both repos (loaded every session, the closest thing to memory this environment has), `scripts/checkpoint.mjs` (`npm run checkpoint`),
   `docs/SELF-HEALING.md`, skill Step 9 and `references/improvement-loop.md`, and the usage governor's checkpoint-before-pause in the spec.

## Decisions made

See the table in [HYBRID-AGENT-SPEC.md](HYBRID-AGENT-SPEC.md#decisions-already-made-by-the-user). In one line each:

- Serial queue, work-in-progress limit 1, fresh context per item (user: "slowly, one by one, without cluttering"). We do **not** fan out.
- Model tiering: Haiku router, big-model Overseer and Advisor, small-model executors, a different-context Verifier, code-first watchdog.
- TEST mode localhost only; LIVE mode allowances list; router proposes, only user config grants.
- LIVE gate is **not a firewall**; the docs must say so.
- Usage governor reads the SDK's `rate_limit_event` / `rate_limits`, **not** the undocumented usage endpoint with CLI credentials.
- Exactly-once submit through intent-before-commit plus verify-before-retry.

## Where everything is

| What | Where |
|---|---|
| The spec, written before code | `agent-loop/docs/HYBRID-AGENT-SPEC.md` |
| Threat model, one test per row | `agent-loop/docs/HYBRID-AGENT-THREATS.md` (team-design threats G1 to G10 are in TEAM-COMPOSITION.md until merged) |
| Reel flow design (Instagram reel to summary to measured experiment) | `agent-loop/docs/REEL-FLOW.md` |
| Dynamic team design (roster, composer, validator) | `agent-loop/docs/TEAM-COMPOSITION.md`; skill side `dev-workflow/references/team-composition.md` |
| Adversary round reports | `agent-loop/docs/adversary/round-NN.md` |
| Compaction hook (PreCompact/PostCompact/SessionStart) | `dev-workflow/scripts/handoff_hook.py`, config `.claude/settings.json` + `.claude/handoff.json` in the Dev-Skill repo, test `tests/handoff_hook_test.py` |
| Benchmark plan and results table | `agent-loop/docs/BENCHMARK.md`, `agent-loop/bench/` |
| Why and how each improvement was made | `agent-loop/docs/IMPROVEMENTS.md`; skill side: `dev-workflow/references/improvement-log.md` |
| Per-run history of changes | `agent-loop/CHANGELOG.md`, `Dev-Skill/CHANGELOG.md` |
| Cross-project lessons | `dev-workflow/references/verification-lessons.md`, `roadmap.md` |
| OpenClaw browser and computer-use audit | `agent-loop/docs/REFERENCE-AUDIT.md` (section "OpenClaw's browser and computer-use controls") |
| Compaction summaries, saved by hook | `agent-loop/docs/handoff/compactions/` (if the hook ran) |
| Read-only reference clones | `/home/user/openclaw/openclaw`, `/home/user/mavericksxx/pokemon-harness`, `/home/user/dietrichgebert/ponytail` (may be gone in a fresh container) |
| Scratch probes | the session scratchpad: `probe-openclaw-gaps.mjs`, `probe2.mjs`, `probe3.mjs`, `dino-flake.mjs` (not committed) |
| Full earlier transcript | `/root/.claude/projects/-home-user-Dev-Skill/2b694e04-9ba6-57bf-a716-25249490b892.jsonl` (container-local) |

Key source files for the hybrid work: `src/pipeline.ts` (phase loop, Overseer decide, repair budgets, stop control), `src/phases.ts`
(PHASE_SPECS, `query()` options, hook chain, mcpServers), `src/browser-tools.ts` (15 tools, localhost gate around lines 226 to 250),
`src/desktop-tools.ts`, `src/hooks.ts`, `src/overseer.ts`, `src/server.ts`, `src/store.ts`.

Ideas taken from the reference projects are listed in the spec ("Model tiering" and "Ponytail ideas adopted"). PokeHarness files read:
`src/shared/arceus.ts`, `harnessInstructions.ts`, `delegateSpawn.ts`, `src/main/bundledHarnessAgents.ts`, `docs/usage-limits-research.md`
(top). **Not yet read**: `shelved-delegation-gate-and-session-refresh.md`, `arceus-v2-plan.md`, the rest of the usage-limits doc,
ponytail `agentic/`.

## Stage status

Tasks #83 to #97 in the task list. Update this table when a stage's exit checklist is fully met. The closing rule is in the spec: a stage is *closed* only
when its latest adversary round has no open confirmed finding at medium or above; a high or critical always blocks.

| Stage | State |
|---|---|
| S0 spec, threats, benchmark, improvement log, handoff, team and reel designs | **built, not closed**: adversary round 1 (20 findings) is triaged in `docs/adversary/round-01-triage.md`; 5 fixed in code, 14 design changes whose tests come with their stages, 1 scheduled (A10). |
| S1 browser observability + network gate | **built, attacked twice** (`observability` 0 to 8 of 8; the redirect decoy gets 0 of 16; symlink walk closed). Adversary round 2 (31 findings, `docs/adversary/round-02-triage.md`): batches 2 to 6 are fixed in code (IMP-016, IMP-017, IMP-018), the rest wait for S2, S4, S5. `browser-honesty` 0 to 11 of 11. |
| S1b read what is really on the page (frames, shadow DOM, unverifiable fields) | **built** (IMP-014; adversary A10 closed; `form-coverage` 1 to 8 of 8; `test:browser-frames` 14 checks, 17 mutants killed). The form *diff* is S5. CI green on all three systems at `916e776`. |
| S2 LIVE mode (allowances on the gate, profile, login handoff, gated upload with destination check) | not started |
| S3a team composition core (roster, composer, validator, lineage identity, post-build gate) | **part one built** (IMP-015: roster, plan validator V1 to V8 V10 to V12 V15, signals, offline composer, `roster` and `team --dry-run`; suites `team-invariants` 500/500, `team-sizing` 28/28). **Part two not built**: wiring into the pipeline, store, events, UI, hook chain (task #101). |
| S3 Haiku router, flow registry, `agent-loop do` | not started |
| S4 watchdog, queue, ledger, governor (V9/G9), minimal Needs-you store and CLI | not started |
| S5 job-apply flow, fake job board, red team | not started |
| S5b reel flow | design written (docs/REEL-FLOW.md); not built |
| S6 UI, docs, README, media | not started |
| S6b `agent-loop adversary` and `agent-loop learn` | not started (the loops are run by hand meanwhile) |
| S7 real-model end to end, pipeline-vs-plain, team-vs-fixed, CI on three systems | not started |

## Next step

1. **Round 2 batches 3 to 6 are committed locally as `922e709` (a WIP checkpoint) and are NOT pushed.** The standing commitment is: do not push until the full local suite has passed on the exact commit
   (`scratchpad/full-on-commit.sh <commit>` makes a fresh worktree and runs `CI=1 node scripts/run-suites.mjs --timeout-min 10` plus `pipeline_logic.sh`), then push and read CI on Linux, macOS and Windows
   (also confirm Windows `test:bash-readonly` after the `ASK` filter, and the new `test:fatal`, `test:browser-popup-storm`, `test:browser-hang` and the re-measuring `test:bench-table` on all three).
   Still to do before that run: IMP-017 and IMP-018 in `docs/IMPROVEMENTS.md` (draft in the scratchpad `imp-017-018.tmpl`; numbers: 66 mutants run, survivors accounted for in the entry), `node bench/run.mjs --write-doc`,
   `test:improvements-log`, `test:bench-table`, `test:handoff`.
2. The Dev-Skill repo is pushed (`df00698`: lessons 28 and 29, SKILL-013 to SKILL-016, the compaction redactor, the scanner-copies test).
3. **Needs you (a decision, nothing blocks on it):** the compaction summaries in `docs/handoff/compactions/` are committed by `checkpoint` to a public repository. The redactor is fixed (SKILL-015) and found nothing in the three
   summaries saved so far; the newest summary (`20261007T051726Z-auto.md`) was run through the fixed redactor (0 lines changed) and committed like the two before it. Say whether to keep committing them (they are lossy digests of the whole session), to ignore the directory, or to keep them local.
4. Then **S3a part two** (task #101: `--team auto|fixed5|<file>`, events with `stepId`/`role`/`item`, store columns, lineage identity, variable-length stepper, Overseer append/split/skip, diff-scope audit, V14 and V7 wiring),
   then an adversary round on it; then S2, S3, S4, S5, S5b, S6, S6b, S7 in the spec's order. Round 2 leftovers: A22 (before S5), A23 and A45 (S4), A43 (S2 ports), A25 and A26 part 2 (S5), A38's generic event cap, A42's LIVE-mode refusal (S2).

## Verified and not verified

Verified (by running, with the evidence in CHANGELOG/STATUS):

- CI green on all three systems at agent-loop `e0764be` (37 suites on macOS and Windows; the cross-platform job blocks).
- Round 1's critical finding was reproduced by running our handlers and by our own test before the fix (a decoy received `/r301-exfil?data=secret`), and fixed: the decoy gets 0 of 16 attempts, 13 of 13 gate mutants and 6 of 7 hook mutants killed.
- OpenClaw gaps demonstrated by running our handlers: uncaught exception, `console.error` and a 404'd script look healthy through
  `inspect`; dialogs dismissed and downloads discarded silently.
- The SDK exposes `SDKRateLimitEvent` and `rate_limits` (read from the type definitions).
- The SDK has `PreCompact` (input: `trigger`, `custom_instructions`), `PostCompact` (input: `compact_summary`) and `SessionStart`
  (input: `source` incl. `compact`; output `additionalContext`) hooks (read from the type definitions). `PreCompact` has no documented
  way to block or inject, so it can only warn.

Verified this session (by running; each about the working tree, not about a pushed commit):

- Round 2 batches 3 to 6 on the tree that became `922e709`: `test:fatal` (including the real command, twice per kind of error), `test:browser-popup-storm`, `test:browser-hang`, `test:browser-observability` (all 22 sections, twice), `test:net-gate`,
  `test:checkpoint`, `test:bench-integrity`, `test:bench-suites`, `test:adversary-round`; benchmark `browser-honesty` 0 of 11 on the old build `ecc83f2` in every run since the popup scenario was made harsher, 11 of 11 here.
  Mutation checks: 66 mutants on the browser, gate and fatal code (15 survivors accounted for in IMP-017: 8 closed by new assertions, 1 redundant line deleted, 6 redundant layers or unexercised guards named), 29 on `checkpoint`, 14 on the baseline check, 0 survivors.
- Dev-Skill: `tests/handoff_hook_test.py` (3 mutants), `improvement_log_test.py` (16 entries), `scanner_copies_test.py`, `bench_skill_test.py`, `tests/stress/scan_stress2.py` (9 of 11, its two documented holes).

Not verified:

- **The full suite on `922e709` or any later commit, and CI on any system for it.** Windows CI at `ecc83f2` failed only `test:bash-readonly` (rows that need a symlink); the fix is in `922e709` and was checked only by simulating `win32` on Linux.
  `test:ui-plain` failed once on macOS at `f10a830` and passed at `ecc83f2`; the cause is unproven.
- The new tests have not run on macOS or Windows (popups, the child-process scenarios, the CLI fatal test, the scanner run by `checkpoint` with `python` instead of `python3`).

- **That the harness fires the PreCompact hook** (PostCompact **is verified live** now: `docs/handoff/compactions/20261003T060319Z-auto.md` was written by it after the second compaction; the first compaction predates the hook). `SessionStart` **is verified live**: after a session-limit interruption
  the session resumed with source `resume` and the handoff was injected. PreCompact is tested only with the documented JSON payload (it can only warn);
  nothing in `docs/handoff/compactions/` shows it fired, so treat it as unconfirmed.
- Art licences (second-hand note only), sound never heard by a person, desktop control only on Linux, no CI for the real-model runs.
- The pipeline-vs-plain experiment has not been run (authorised by "use what's the problem", still to do in S7).
- Everything about LIVE mode, the router, the watchdog, the ledger, the job flow, team composition and the reel flow: not built.
- macOS and Windows: the new decoy tests skip where `127.0.0.2` is not routable; the symlink test skips on Windows; neither platform has run the new tests in CI yet.
- Real Instagram, real LinkedIn and real ATS sites: never exercised, by rule.

## Improvement backlog

Things known to be improvable, with why. Move an item to IMPROVEMENTS.md when it is done.

| Item | Why it matters | Evidence |
|---|---|---|
| Browser tools tell the agent nothing about console errors, page errors, failed requests | The agent reports "page looks fine" on a broken page; the watchdog needs the signal anyway | Probe: a page with an uncaught exception, `console.error`, and a 404 script looks healthy via `inspect` |
| Dialogs are dismissed and downloads discarded silently | A lure the agent cannot see; also a bug source | Probe, same |
| No `text`/`query`, no resize/emulate, no drag, no evaluate | Cannot read a long job description or test responsive pages | REFERENCE-AUDIT.md OpenClaw tables |
| Desktop tools lack scroll, drag, wait, set_value, invoke_menu, zoom | Cannot do many real desktop tasks | Same |
| Per-application five-phase cost is too high | A 30-application goal would burn the usage window | Measured earlier: pipeline cost vs plain (4,039 vs 4,037 of 4,040 at $1.41 vs $0.08) |
| `ui-offline` dino test flaked once on Linux CI | Unexplained flake; assertion now waits up to 5 s | CHANGELOG; cause unconfirmed |
| Cross-platform CI does not cover desktop control or real-model runs | Claims about those rest on one machine | README honest-gaps list |
| PokeHarness docs not fully read | May hold a delegation gate or session refresh idea worth copying | See Where everything is |
| Dev-workflow skill has no rule about keeping a handoff or logging why an improvement was made | This session lost context once | This file |
| The pipeline can only shrink (skip test-designer); it cannot add agents, and the job flow needs per-item pairs | A typo fix pays for five agents, a migration gets the same five | `PHASES` constant and `SKIPPABLE_PHASES` in src/types.ts; IMP-003 cost; docs/TEAM-COMPOSITION.md |
| Task #28 was marked completed as "dynamic worker/phase count" but the code only allows skipping one phase | A completed task that overstated what was built | src/types.ts line 21 |

## Gotchas learned

(Full detail in `dev-workflow/references/verification-lessons.md`.)

- `path.normalize` gives backslashes on Windows: use `posix.normalize`. `node --import` wants a file URL. `file://` plus a Windows path is
  not a URL: use `pathToFileURL`. Windows `PATHEXT` is case-insensitive (`.CMD`). macOS has no `timeout`.
- Playwright's default headless is the headless shell, which lacks notification permission: use `channel: "chromium"`.
- A job allowed to fail shows "success" while suites inside it are red.
- A subprocess probe with a timeout must treat a timeout as unknown, not absent; test it with a PATH holding only the target.
- Scripted recordings must script every timestamp, including ones the system stamps (a header read "1309m 48s").
- Mutation-check tests against the built `dist`, with a control run; reproduce a failure on the exact browser build first.
- Background waits: use `nohup` plus log polling; a wait loop returned early when the launcher shell exited.
- "The suite passes" is about the commit it ran on. Re-run after any change, including "small" ones.

## How to resume

```bash
cd /home/user/Dev-Skill/agent-loop && git status --short && git log --oneline | head -5
cat docs/HANDOFF.md | head -60            # this file
npm run -s typecheck && npm test           # the whole suite; 37 suites at the time of writing
cd .. && git status --short && git log --oneline | head -3   # Dev-Skill side
```

Then read the **Next step** section and the task list (#83 onward). If a compaction summary exists in `docs/handoff/compactions/`,
read the newest one too, and compare it with this file: anything in the summary that is not here should be added here.
