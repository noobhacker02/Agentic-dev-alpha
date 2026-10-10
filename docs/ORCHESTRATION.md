# Orchestration: Sonnet conducts, Haiku builds, a different Sonnet checks

Decided 2026-10-10 on the user's instruction: "use Sonnet 5.5 to orchestrate everything, many Haiku 5.5 agents build, efficiently on the cloud, several Sonnets take care of it."

## Roles

| Role | Model | Does | Never does |
|---|---|---|---|
| **Conductor** | Sonnet (this session) | splits the goal into work packets, writes each packet's brief, merges, runs the guarded suite, pushes, reads CI, keeps HANDOFF and the task list | build large features itself while packets wait |
| **Builder** | Haiku, many at once | one packet each, in its own git worktree and branch, test first, commits on its branch | push, touch another packet's files, edit `docs/HANDOFF.md`, claim a green it did not see |
| **Verifier** | Sonnet, a *different* agent from the builder | re-runs the packet's tests twice, runs the old code against the new tests (they must fail), mutation-checks the new code, reads the diff adversarially, writes `PASS` or `FAIL + reasons` | fix the builder's code (it sends it back) |
| **Adversary** | Sonnet, fresh context, once per stage | attacks the merged result; findings go to `docs/adversary/round-NN.md` | modify tracked files |

All of them run in this cloud container as subagents (`Agent` with `model`); a packet can also be given its own cloud session (`create_session`) when the container's CPU or disk is the limit. Builders and verifiers never share a worktree.

## A work packet

A packet is a file in `docs/packets/NN-name.md` (or the prompt itself) with: the goal in one sentence; the files it may touch (and the ones it may not); the exact test command that must pass; "new tests fail on the old code first" and "assert the cause, not only the effect"; the docs it must update (IMPROVEMENTS entry text goes in its hand-back, not in the file, to avoid merge conflicts); what it must say it did **not** run.

Rules every packet carries (from `CLAUDE.md`): never contact real third-party sites; never record passwords or cookies; no `--no-verify`; a scanner false positive only with `// devskill:allow (reason)`; do not open pull requests; do not push.

## Flow

1. Conductor cuts packets that touch **disjoint files**. Two packets that must touch the same file are one packet, or run in order.
2. Builders start in parallel: `git -C agent-loop worktree add /tmp/wt-<packet> -b work/<packet> <base>`; `npm run build`; test first; commit on `work/<packet>`.
3. A verifier is started for each finished builder (Sonnet, new context). `FAIL` goes back to a builder with the reasons; two FAILs in a row on one packet and the conductor takes it.
4. Conductor merges the `PASS` branches one at a time (`git merge --no-ff`), rebuilds, runs the touched suites, then the guarded suite (`suite-then-push.sh <short-commit>`), then reads CI on all three systems.
5. After each stage, a fresh adversary round; triage into `docs/adversary/round-NN-triage.md`; the findings become new packets. The loop stops when a round finds nothing at medium or above.

## Why this and not one big agent

- Most packets are well-specified (a command, a table, a guard, a test): Haiku is enough and cheap, and many run at once.
- The expensive judgement is concentrated where it pays: splitting the work, checking it, merging it, and attacking it. Rounds 4 to 8 showed that the author's own tests miss the cases that matter, so the builder never signs off its own work.
- A builder that cannot push cannot ship a mistake; the guarded suite is the only gate to `main`.

## Limits, stated

- Haiku builders get the *how* in the brief. A packet that needs design (a new state machine, a security argument) stays with the conductor or a Sonnet builder.
- A subagent's report is model output, not evidence: the verifier and the guarded suite are the evidence.
- Parallel builders share one machine's CPU and disk: at most 4 builders and 2 verifiers at a time, each worktree removed when merged.
