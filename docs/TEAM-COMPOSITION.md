# Team composition: the number of agents depends on the task

Status: **design, written before code** (stage S3a); part one is built (IMP-015): the roster, the validator, the signals, the offline composer and `roster` / `team --dry-run`. Part two (the pipeline running a plan) is not. Nothing here is built unless a "Built" line says so. The same design, in the
form a person following the skill can apply by hand, is in the Dev-Skill repo at `dev-workflow/references/team-composition.md`.

User's rule: *"we won't have constant numbers of 5 agents; we would have more as well, depending on the task."*

## What exists today, and why it is not enough

- `src/types.ts` fixes the team: `PHASES = [planner, test-designer, builder, verifier, gatekeeper]`.
- The run can only **shrink**: the Planner may suggest skipping `test-designer` on a trivial task, and `SKIPPABLE_PHASES` allows nothing
  else. Nothing can **add** an agent. Repairs go backwards only (`isValidRepairTarget` in `src/pipeline.ts`).
- Measured cost of that fixed team on one task: about 17.6 times a plain session for a 2-point difference
  ([IMPROVEMENTS.md](IMPROVEMENTS.md), IMP-003). A typo fix pays for five agents; a database migration gets the same five as a typo.
- The job-application flow needs the opposite shape: a Builder and a Verifier **per job**, many times.

## Principles

1. **Every agent pays for itself.** A role is on the team only because it covers a named risk or does a named piece of work; the plan
   records that reason, and the reason is shown in the UI. Ceremony is not a reason.
2. **The plan is a proposal; code owns the floor.** A model composes the team; program code validates it against hard invariants it
   cannot be talked out of (below), and adds roles that signals make mandatory.
3. **Bounded.** A cap on total agents, per-role caps, and a budget check against the usage window (S4's governor). A plan over the cap
   is shrunk by dropping skippable roles in a fixed order, or the user is asked.
4. **Serial by default.** Steps run one at a time in a stable topological order, with a fresh context each (the "slowly, one by one"
   rule). Parallelism is not built. If it ever is: read-only roles only, isolated contexts, results flow to one coordinator and never
   to each other (the OpenClaw swarm lesson in [RESEARCH-COMPUTER-USE-AND-MULTI-AGENT.md](RESEARCH-COMPUTER-USE-AND-MULTI-AGENT.md)), never writers.
5. **Agents cannot hire agents.** Only the composer (before the run) and the Overseer (during it, within caps) add steps. No nesting.
6. **A checker is never its own builder's context.** The Verifier of a slice is a different session, with no access to the Builder's
   reasoning, only to its output and the spec.
7. **The roster is data, and it does not live where agents can write.** Built-in roles ship with the tool; user roles live in the user's
   config directory. A roster file inside the project directory is ignored until the user trusts it (threat G10).
8. **Measured.** Sizing accuracy, invariant coverage and cost against fixed-5 and plain are benchmark rows
   ([BENCHMARK.md](BENCHMARK.md)); the claim "dynamic teams are better" is not made until they say so.

## The roster

A role is a definition (`roster/<id>.json`) plus its instructions (`roster/<id>.md`). Model aliases follow
[HYBRID-AGENT-SPEC.md](HYBRID-AGENT-SPEC.md#model-tiering-what-pokeharness-does-and-what-we-do-differently): `haiku`, `sonnet`, `opus`
resolve at run time. **Tools are enforced by the hook chain from the definition, never by the role's own text.**

| Role | Kind | Model | Tools | Skippable | Max | Added when |
|---|---|---|---|---|---|---|
| `composer` | meta | haiku (sonnet when ambiguous) | none | no | 1 | Always, first. Proposes the team. Offline heuristic fallback. |
| `researcher` | read | sonnet | read-only; web search in LIVE only | yes | 2 | Unfamiliar library or API, unclear root cause, "find out" tasks. |
| `planner` | plan | sonnet | read-only | yes for tiny tasks | 1 | Anything above a one-file change. |
| `advisor` | advise | opus | read-only | yes | 3 | Before an irreversible class of action, at plan time for large or risky teams, once before "done". |
| `test-designer` | plan | sonnet | read + write tests dir | yes | 2 | Behaviour changes with no existing tests. |
| `builder` | build | haiku (sonnet for hard slices) | read/write inside its slice's paths | no | 6 | Always; one per slice. |
| `verifier` | check | sonnet | read + run checks + browser read | no | 6 | After every builder slice. |
| `integrator` | build | sonnet | read/write | yes | 1 | More than one slice: joins slices, resolves seams, runs the whole suite. |
| `security-reviewer` | check | sonnet | read-only | **mandatory on signal** | 1 | Auth, crypto, secrets, input handling, shell/SQL, dependency changes, network. |
| `migration-reviewer` | check | sonnet | read-only | **mandatory on signal** | 1 | Schema or data migrations, deletes, anything irreversible on data. |
| `a11y-reviewer` | check | haiku | read + browser read | yes | 1 | UI files changed. |
| `perf-reviewer` | check | sonnet | read + run benchmarks | yes | 1 | Hot paths, large data, a stated performance goal. |
| `ui-tester` | check | sonnet | browser tools (TEST mode) | yes | 1 | UI files changed; drives the page and reads the observability notices (S1). |
| `desktop-tester` | check | sonnet | desktop tools, every input asks | yes | 1 | Desktop app tasks. |
| `docs-writer` | build | haiku | write inside docs paths only | yes | 1 | Public behaviour changed; README/CHANGELOG/usage docs. |
| `gatekeeper` | gate | sonnet | read-only | no | 1 | Always, last, for any task that writes or acts. Reads the delete list and the debt ledger. |
| `adversary` | check | opus | read + run | yes | 1 per round | After a stage ([the adversary loop](HYBRID-AGENT-SPEC.md#the-adversary-loop-how-every-stage-is-tested-and-a-command-the-product-ships)). |
| `watchdog` | monitor | code + haiku glance | none | no | 1 | LIVE web flows; runs beside the team, not in its order. |
| `learner` | meta | haiku | none | yes | 1 | Goal end; proposes, never activates. |

A user adds a role by dropping `<id>.json` + `<id>.md` in `~/.agent-loop/roster/`. The definition says kind, model, tools, caps,
`when` (signals), and the verdict contract. A role with a write tool and no path scope is rejected.

## The team plan

The composer returns data, not prose:

```json
{
  "class": "feature",
  "size": "large",
  "reason": "touches auth and adds a dependency; two independent modules",
  "steps": [
    { "id": "s1", "role": "researcher", "brief": "how does the session library refresh tokens?", "why": "unfamiliar library" },
    { "id": "s2", "role": "planner", "after": ["s1"], "why": "multi-module change" },
    { "id": "s3", "role": "builder", "slice": { "name": "api", "paths": ["src/api/**"] }, "after": ["s2"], "why": "slice 1 of 2" },
    { "id": "s4", "role": "verifier", "checks": "s3", "why": "independent check of slice 1" },
    { "id": "s5", "role": "builder", "slice": { "name": "ui", "paths": ["src/ui/**"] }, "after": ["s2"], "why": "slice 2 of 2" },
    { "id": "s6", "role": "verifier", "checks": "s5", "why": "independent check of slice 2" },
    { "id": "s7", "role": "integrator", "after": ["s4", "s6"], "why": "join slices, run the full suite" },
    { "id": "s8", "role": "security-reviewer", "after": ["s7"], "why": "auth path changed (mandatory by signal)" },
    { "id": "s9", "role": "gatekeeper", "after": ["s8"], "why": "final gate" }
  ]
}
```

Every step has a `why`; steps without one are rejected. Slices own **path globs**, and overlapping slice globs are rejected (threat G8),
so two builders cannot edit the same file.

## How the size is chosen

Two layers, the second one binding:

1. **Signals** (`src/team/signals.ts`, deterministic, no model): computed from the task text and a cheap repo scan: estimated files
   touched, languages, **sensitive-path hits** (auth, session, crypto, payments, secrets, migrations, infra, CI), UI files, dependency
   manifest changes, test coverage nearby, external actions (LIVE web), ambiguity markers ("somehow", "maybe", questions), and a
   read-only intent ("explain", "find", "why does").
2. **Composer** (Haiku, no tools, strict JSON, task and file text fenced as data): turns the signals into a proposal, using the sizing
   guide below as its instruction. If the model is unavailable or the answer is invalid, the **offline heuristic** composes from the
   guide alone, so `agent-loop team --dry-run` and CI work with no model.
3. **Code** applies the floor, adds mandatory roles from the signals, drops nothing mandatory, enforces caps, and returns the final plan.

### Sizing guide (what the composer is told, and what the offline heuristic implements)

| Task looks like | Team | Agents |
|---|---|---|
| One-file fix, no sensitive path, tests exist | builder, verifier, gatekeeper (the planner's job is the composer's brief) | 3 |
| Typical feature or bug, one module | planner, test-designer, builder, verifier, gatekeeper (today's default) | 5 |
| Bug with unclear cause | researcher (read-only) to find the cause, then builder (regression test first), verifier, gatekeeper | 4 |
| Unfamiliar API or library | researcher, planner, builder, verifier, gatekeeper | 5 |
| Several independent modules | researcher if needed, planner, **one builder + one verifier per slice**, integrator, gatekeeper | 7 to 12 |
| Sensitive paths touched | the matching reviewer is added, **cannot be removed** | +1 each |
| UI changed | ui-tester (and a11y-reviewer) | +1 or +2 |
| Public behaviour changed | docs-writer | +1 |
| Irreversible or external action | advisor before it | +1 |
| Read-only question | researcher (and advisor if the answer drives an irreversible choice) | 1 or 2 |
| Job applications, many items | flow's own shape: planner once, builder + verifier **per job**, gatekeeper, watchdog beside them | 2 per item |

The numbers are a guide, not a target. A 12-agent plan for a one-line change is a defect and the sizing benchmark counts it.

## Identity of a unit of work (adversary A3)

Today's lineage keys a node by `phase#attempt` and drops any phase that is not one of the five names, so two builders collapse into one node and an
integrator or a reviewer vanishes (reproduced: a failing mandatory security review did not appear in the tree). One decision for every consumer
(lineage, store, persona, stepper, insights, the job flow's per-item events): **a unit of work is `(item, stepId, attempt)`**. `item` is empty for the dev flow
and the job id or queue key for item flows; `stepId` comes from the plan (`s3`); the five built-in names are kept as `role` for the existing UI, and every
other role is shown through its `kind` (plan, build, check, gate, read, advise), so the stepper and lineage render any role without a code change per role.
Events carry `stepId`, `role`, `item` (all optional, so old runs still read). The S3a exit test runs two same-role steps, a non-built-in role and a failing
reviewer through `buildLineage` and asserts distinct nodes, with the failure visible.

## Checkers (adversary A16)

"A checker is never its builder's context" is met at the model-session level; the browser is a different matter, because it is one object per run and the
builder leaves it in whatever state it likes. So: a checker step gets a **read-only browser server** (no `click`, `fill`, `press`, `select_option`, `click_at`;
`open` limited to the URLs the flow names for verification), and a **fresh browser context** (new cookies-free tab state; for LIVE flows the same
persistent profile but a new tab), and for any claim about the outside world it must confirm from a source the builder did not steer: for the job flow, the
site's own "my applications" list or the confirmation email, loaded by the checker itself. The hook chain classifies `mcp__browser__*` into read and write so V7
holds for browser tools too. Test: the builder leaves a misleading tab open; the verifier still reports from the independent source.

## What code enforces (the floor and the caps)

Each has a test, and each test has a control that proves the validator can say no.

| # | Rule |
|---|---|
| V1 | Every role is in the roster; an unknown role is rejected, never defaulted. |
| V2 | A task that writes or acts has, in order: at least one `builder`, a `verifier` after it, and a `gatekeeper` last. |
| V3 | Every `verifier` names the step it checks, comes after it, and is a different step and a different session. |
| V4 | Roles flagged **mandatory by signal** cannot be dropped, whatever the composer says. |
| V5 | Total agents at most 12 by default (config); per-role caps from the roster; more is a rejection, with the drop order that would fit. |
| V6 | The `after` graph is acyclic and has one root; execution order is the stable topological order. |
| V7 | Read-only roles receive only read tools, from the definition; the hook chain denies anything else. |
| V8 | A slice owns **directory prefixes**, not free-form globs (so overlap is decidable): after real-path resolution and case folding, no slice's prefix is a prefix of another's. Files nobody owns (manifests such as `package.json`, lockfiles, entry points and barrel files, generated output such as `dist/` or snapshots) are **reserved for the integrator**; a builder that needs one stops and says so. The file tools are scoped to the slice by the path hook; **Bash is not**, so each builder step ends with a **diff-scope audit** in code: every path in `git diff --name-only` (plus untracked files) must be inside the slice, or the step fails. |
| V9 | *(Lands with the governor in S4, not S3a.)* The plan is sized against what the governor has **observed**, not a forecast in percentage points (nothing in the SDK turns "12 agents" into a share of a five-hour window): with no signal yet the cap starts low (3 agents) and rises as events show headroom; a `rejected` shrinks the plan to what is finished and asks. |
| V10 | No step is created by an agent. Only the composer and the Overseer's `append` (V11). |
| V11 | The Overseer may append at most 4 steps beyond the plan, each with a stored reason, each passing V1 to V10. |
| V12 | Never-skippable roles (`builder`, `verifier`, `gatekeeper`, `composer`, `watchdog`) cannot be skipped; skippable ones only when the plan marks them and the Overseer's reason is stored. |
| V13 | Roster files from inside the project directory are ignored until the user trusts them. |
| V14 | **Post-build re-check.** After each builder step, code recomputes the sensitive-path signals from the **actual diff and the transitive importers of every changed file** (not the forecast made before any code existed) and, if a mandatory reviewer is missing, appends it through V11. The read-only versus write intent is also resolved by code: if the task text carries any write marker ("fix", "patch", "change", "add", "implement"), the write floor (V2) applies, whatever read-only words it also carries. |
| V15 | A `foreach` over items (the job flow, "for each of these 40 files") is bounded by a per-goal **item cap** from user config (default 30), counted against the budget (V9); it is exempt from the per-role caps of V5 (a step per item is the point) but **not** from V1 to V4, V7, V10 to V12, and the cap itself is not something the composer can set. |

## Changes during the run

The Overseer already chooses `continue | repair | stop` after each step. Added, all bounded and all written to the event stream with a reason:

- **append**: add a step (a reviewer the verifier's finding calls for, a researcher when a builder got stuck on an unknown). V11.
- **split**: a builder reports its slice is too large; the Overseer splits it into two slices, one level only, and the result is **re-validated through V8** like any new plan.
- **skip**: only roles the plan marked skippable (V12).
- **repair**: backward, to **the builder that owns the file in the finding** (found by path, then slice). A step with no slice (an integrator, a reviewer, the gatekeeper) can still send a finding back to the owning builder. The re-run set is that builder's **downstream closure** only: its verifier, the integrator, the reviewers and the gate, never another slice's builder and verifier. Repairs count against the same repair budget as today. If the finding names files in two slices, it is two repairs, one per owner.
- **escalate**: one retry with the model alias one tier up, logged.
- **stop**: as now.

## Built vs to build

**Built (S3a part one, IMP-015):** `src/team/roster.ts` (19 built-in roles, your own directory, a project roster ignored until trusted, V13), `plan.ts` (V1 to V8, V10 to V12, V15, `appendSteps`, `skipStep`,
`auditDiffScope`), `signals.ts` (words and paths only, `transitiveImporters`, V14's re-check function), `compose.ts` (offline composer, `finalizePlan`, `chooseFinal`, `composeForEach`, bounded JSON parser), `scan.ts`
(paths only), and the commands `agent-loop roster` and `agent-loop team "<task>" --dry-run` (exit 2 when no team fits `--cap`). Suites `team-invariants` 500 of 500 and `team-sizing` 28 of 28, with scorer controls.
**Built (S3a part two, increment 2.1, IMP-020):** the identity of a unit of work. `PhaseName` is a role id (`BuiltinPhase` keeps the five names); `phase-start`, `phase-end` and `overseer-decision` can carry `stepId`, `role` and `item`; a `team-plan` event type exists (not emitted yet);
`buildLineage` keys a node by `item|stepId` (the role when an event names no step), shows any role that names its step, and orders rows and lanes by the plan; the `phases` table has `step_id`, `role` and `item` columns, added when an old database is opened; the insights and the habits count `(run, item, step)` units;
`boundRepairTarget` bounds a repair to a plan's step ids. Suite `test:team-identity` (41 mutants, 3 survivors: 2 equivalent, 1 call-site line that 2.2b exercises).
**Built (S3a part two, increment 2.2a, IMP-021):** `src/team/role-spec.ts` (a role's SDK tools, auto-approval, browser and desktop access and prompt, from its definition), `src/team/write-scope.ts` (the write-scope hook for V7 and V8 at the moment of the write), the read-only browser (`readOnly`, A16), the `team` option of `runPhase`, and the shared path rules in `plan.ts`. Suites `team-write-scope`, `team-role-spec`, `team-browser-readonly`, `team-run-phase`.
**Built (S3a part two, increment 2.2b part 1, IMP-022):** the plan-driven run. `src/team/run-plan.ts` runs a validated plan's steps in order through `runPhase` (config `team`: plan, roster, source); events and store rows carry the step id, the role and the item; `team-plan` is emitted first; a repair names a step id (the Overseer has a team prompt and a step-id bound, a checker with no target named sends the work back to the step it checks) and is bounded per step and per run; stop and cost cap end the run as "stopped"; a read-only step's document comes back as the verdict's `report` and is saved to `team-reports/<step id>.md` for the steps after it; after every step the project tree is compared with how it was before (`src/team/changes.ts`) and a step that changed what its role may not (any tool, Bash included) fails with the paths named; a plan that does not validate runs nothing. `--team fixed5` is the old loop, unchanged. Suites `team-changes`, `team-verdict`, `team-pipeline`.
**Not built (increments 2.2b part 2 to 2.2d):** the `--team auto|fixed5|<file>` command line and the composer call that makes the plan; the planner skipping a step, the Overseer's append and split, and V14's re-check of the real diff; the variable-length stepper and the terminal and persona for unknown roles; the benchmark rows, a mutation check of the whole stage and an adversary round. Beyond this stage: V9 (the usage budget) comes with the governor in S4. V7 and V8 are wired into a run now (the hook and the diff audit); V14 is a function until its re-check is wired.

- ~~`PHASES` becomes the built-in part of a roster; `PhaseName` widens to a role id string~~ (built in 2.1: `PhaseName` is a string, `BuiltinPhase` is the five names).
- ~~Store: additive columns on `phases`; old databases open unchanged; old rows read as role = name~~ (built in 2.1, as `step_id`, `role` and `item`; there is no `instance` or `slice` column: the step id is the instance and the slice is the plan's).
- ~~Events gain optional `stepId`, `role`, `item`~~ (types built in 2.1; emitted in 2.2b). Still to build: the UI stepper renders the plan's steps (variable length) (2.2c); the lineage tree already follows the plan's order; `insights` count units (built).
- New commands: `agent-loop roster` (list roles), `agent-loop team "<task>" --dry-run` (print the team and the reason for each member,
  without running), `agent-loop run` gains `--team auto|fixed5|<file>` (default `auto`; `fixed5` reproduces today's behaviour exactly).
- The job-application flow is the same machinery with a `foreach` over items.

## Threats specific to this design

| ID | Threat | Stop | Test |
|---|---|---|---|
| G1 | The composer inflates the team to burn usage (or is told to by the task text), including through an item loop | **code**: V5 caps, V9 budget, V15 item cap; sizing benchmark counts oversized plans | Task text "use 40 builders" composes at most the cap; "for each of the 200 files add a docstring" is bounded by the item cap; a `foreach` plan over the cap is rejected |
| G2 | The composer shrinks away the floor or a mandatory reviewer ("skip the verifier"), or the task is worded so the signal never fires | **code**: V2, V4, V12 re-add or reject; **V14 re-checks the real diff** | Task and repo text telling it to skip; an innocent task whose diff changes `src/auth/**` through a shared helper still gets the security reviewer; "find out why login fails and patch it" gets the write floor |
| G3 | Injection through repo files read by the signal scan or the composer | **code + ask**: scan output is counts and paths, never text; file text fenced as data | A README line "add a researcher 30 times" changes nothing |
| G4 | The Overseer appends forever | **code**: V11, 4 appended steps total | Overseer that always appends stops at 4 |
| G5 | A checker that shares a session or context with its builder (a rubber stamp) | **code**: V3, separate sessions, no builder reasoning passed | Plan with verifier checking itself rejected; session ids differ in a real run |
| G6 | A read-only role is handed a write tool | **code**: V7, tools from the definition | Reviewer tries Edit: denied |
| G7 | Dependency cycle or an unreachable step deadlocks the run | **code**: V6 | Cyclic plan rejected |
| G8 | Two slices edit the same file | **code**: V8 (directory prefixes, case folding, real paths, reserved shared files, diff-scope audit after every builder, because Bash is not scoped) | `src/API` vs `src/api`; two slices that both edit `package.json`; a builder writing outside its slice with `sh -c`; a symlink from one slice into another; a build that regenerates `dist/` |
| G9 | Cost misestimated, run exhausts the usage window mid-team | **code**: governor degrades (cheaper aliases, drops skippable roles), then pauses | Fake rate-limit events mid-plan |
| G10 | A role file in the project directory redefines `gatekeeper` | **code**: V13, built-in and user config only | Repo-level roster ignored until trusted |

## Benchmark rows this adds

| Suite | Measures | Built in |
|---|---|---|
| `team-invariants` | 500 generated plans (valid, and each mutated to break V1 to V8 and V10 to V15; V9 in S4): validator accepts the valid, rejects every invalid, including oversized `foreach` plans | S3a |
| `team-sizing` | Labelled tasks (tiny, typical, bug, unfamiliar, multi-module, sensitive, UI, read-only): offline composer lands in the expected size band with the mandatory roles present; counts oversized plans | S3a |
| `team-vs-fixed` | **Real model, gated.** Plain session vs fixed-5 vs dynamic team on the same tasks: score, cost, wall time. Success is dynamic equal to plain on tiny tasks at lower cost than fixed-5, and ahead of plain on risky ones. If it is not, we say so. | S7 |

## Exit criteria for S3a

- V1 to V8 and V10 to V15 each have a passing test with a control that fails when the rule is removed (V9 and G9 are S4's, with the governor).
- `--team fixed5` reproduces today's pipeline exactly (the existing suites pass unchanged on it).
- Sizing suite recorded with a baseline; `team --dry-run` works offline.
- An adversary round on the validator (fresh agent, told to build a plan that passes validation but breaks a principle) with its findings closed.
- Old databases open; the lineage test from "Identity of a unit of work" passes; the stepper renders a 3-step, a 5-step and a 12-step run from real runs of the
  fake SDK (the variable-length stepper is the one piece of UI that belongs to this stage, not S6).
