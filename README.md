# agent-loop

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A multi-agent dev-loop orchestrator built on the real [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).
A low-memory **Overseer** drives five specialized worker phases through a task, each phase its own isolated
session, with every tool call streamed live to a browser UI where a human can approve or reject it in real time.

**Why it exists:** to answer one question honestly — *does our `dev-workflow` skill actually work, and how do
we tell?* The live approval UI is the point, not a nice-to-have: watching every step an agent takes, and being
able to say "no, not that," is how the process gets evaluated and improved instead of trusted on faith. This
project always fetches `dev-workflow` fresh from its own public repo (see [Consuming an external
skill](#consuming-an-external-skill-without-coupling-to-it) below) rather than vendoring a copy — the two
projects are independently versioned by design, one general-purpose, one agentic.

## How a run works

```
                                    ┌──────────────┐
   "build me X" ──────────────────▶│   Pipeline   │
                                    └──────┬───────┘
                                           │ five phases, strict order, retries on the Overseer's say-so
        ┌──────────┬──────────────┬───────┴──────┬───────────┬──────────────┐
        ▼          ▼              ▼              ▼           ▼              │
     planner  test-designer    builder        verifier    gatekeeper        │
    (PLAN.md)  (TESTPLAN.md)  (implements)   (VERIFY.md)  (GATEKEEP.md)     │
        │          │              │              │           │              │
        └────┬─────┴──────┬───────┴──────┬───────┴─────┬─────┘              │
             ▼                                          each phase ends in a
      short structured verdict                          fenced ```json verdict
      {success, headline, details, concerns}            block — never a raw transcript
             │
             ▼
   ┌───────────────────────────────────────────────────┐
   │                      Overseer                      │  reads only:
   │  reasons over the verdict + prior phase summaries  │   • this phase's verdict
   │  + DECISIONS.md (if one exists) — never a full      │   • prior phases' short summaries (SQLite)
   │  transcript — and returns one of:                  │   • DECISIONS.md, if present — treated as settled
   └──────────────┬──────────────────┬───────────────────┘
            continue            retry (same phase,          stop
                                 feedback attached)
```

Every tool call any phase makes, meanwhile, goes through one more gate before it runs:

```
tool call ──▶ PreToolUse hook ──▶ hard-deny safety net (rm -rf /, force-push, …)
                    │
                    ▼
          human-approval UI (WebSocket) ──▶ Approve / Reject, live, in a browser
                    │
                    ▼
              tool actually runs
```

## Why these specific design choices

- **Phases are separate top-level `query()` calls, not SDK subagents.** Subagent delegation in the SDK is
  model-driven, not externally sequenced — this pipeline needs a strict five-step order with retries the
  pipeline code controls, which the SDK's own subagent mechanism doesn't guarantee. Phases hand off through
  files (`PLAN.md`, `TESTPLAN.md`, `VERIFY.md`, `GATEKEEP.md`) plus short indexed SQLite summaries, never
  shared conversation state — each one starts with zero memory of any other phase's session.
- **Every tool call, not just the risky ones, goes through the approval UI.** The SDK's permission evaluation
  runs hooks → deny rules → ask rules → permission mode → allow rules → `canUseTool`, in that order —
  `canUseTool` is *skipped entirely* for anything auto-approved earlier in that chain, which rules it out as
  "the" approval mechanism on its own. A `PreToolUse` hook runs before all of that, unconditionally, for every
  call (`src/hooks.ts`) — the actual reason "every step goes through the UI" is true rather than aspirational.
- **Indexed logs, not RAG.** `src/store.ts` is one SQLite file with FTS5 full-text search over structured rows
  (runs, phases, indexed log lines). No vector embeddings, no similarity search — explicitly out of scope. The
  Overseer and a human query the same short rows: "what did the builder phase do, and why."
- **A run's own history survives even when nobody's watching.** `emitEvent` persists every event to SQLite as
  well as broadcasting it over WebSocket — an unattended run (no browser attached) still leaves a complete,
  queryable record, not just a live feed that vanishes if nobody was connected.
- **Decisions are read, not remembered.** See below.

### Decisions the Overseer reads, not remembers

If a `DECISIONS.md` exists in the working directory — the project-wide decision log `dev-workflow` itself
writes (see its `references/decisions-log-template.md`) — the pipeline reads it after every phase, indexes it,
and passes its current content straight into the Overseer's own prompt (`src/overseer.ts`). A decision a human
actually made (which payment provider, which auth strategy, whatever the real fork was) shouldn't live only
inside whichever phase's one-shot session happened to encounter it and vanish once that process exits. The
Overseer treats every logged entry as settled — not something to relitigate just because a later phase's
concerns mention it again. Worker phases get the same instruction in their own prompts (`src/phases.ts`), so a
real decision is read before any phase decides something is still open, not just fed to the Overseer after.

### Consuming an external skill without coupling to it

`dev-workflow` and `agent-loop` are two independently-versioned repos on purpose — one a general-purpose skill
meant to be usable anywhere, one an agentic environment that consumes and tests it. Nothing in `agent-loop`
hardcodes a path into a sibling checkout of `Dev-Skill`; `test/resolve-skill-source.mjs` instead:

1. Honors `DEV_WORKFLOW_SKILL_PATH` if explicitly set — an opt-in local override for fast iteration while
   developing the skill itself.
2. Otherwise **always shallow-clones the current `dev-workflow` straight from its public GitHub repo** — so
   validation runs against what's actually published right now, not a copy that can silently drift stale.
   `DEV_WORKFLOW_GIT_REF` optionally pins a branch/tag for a reproducible run.

This is what "the base skill upgrades all the time, the agentic side should always pick that up" actually
means in code — not a submodule, not a vendored copy, not a relative path that only works by accident of one
machine's directory layout.

## Layout

| Path | What |
|---|---|
| `src/types.ts` | Shared types: phases, events, verdicts, decisions |
| `src/store.ts` | SQLite + FTS5 store (`node:sqlite`, no native build step) |
| `src/bus.ts` | Event bus: agent events out (persisted *and* broadcast), human approve/deny decisions in |
| `src/hooks.ts` | The `PreToolUse` hooks — the safety net and the approval-UI round-trip |
| `src/phases.ts` | The five phase system prompts + `runPhase()`, the actual `query()` wrapper |
| `src/overseer.ts` | Overseer decision logic (continue / retry / stop), decision-log-aware |
| `src/pipeline.ts` | Sequences the five phases, watches `DECISIONS.md`, applies Overseer decisions |
| `src/server.ts` | HTTP + WebSocket server: broadcasts events, receives decisions |
| `ui/index.html` | The live timeline + Approve/Reject UI (vanilla JS, no build step) |
| `src/cli.ts` | `agent-loop run "<task>"` entry point |
| `test/plumbing.mjs` | No-LLM test of the store/bus/server/WebSocket round-trip |
| `test/browser-approval.mjs` | Real end-to-end test: a live pipeline run with a real headless-Chromium browser clicking Approve |
| `test/resolve-skill-source.mjs` | Fetches the current `dev-workflow` skill (GitHub by default, local path as opt-in override) |
| `test/validate-dev-workflow.mjs` | The project's actual meta-goal: does `dev-workflow` trigger and get followed on an ordinary request? |
| `test/validate-decisions-log.mjs` | Does a genuinely ambiguous task get asked about once, and never re-asked once logged? |

## Requirements

- **Node.js 22.5+** — required for `node:sqlite` (used for the store, no native build step).
- **git** — the test suite's skill-fetch (`test/resolve-skill-source.mjs`) and repo-seeding shell out to it;
  `agent-loop run` itself doesn't require git unless a task's own steps use it.
- **A working Claude Code CLI authentication.** `@anthropic-ai/claude-agent-sdk` bundles the actual `claude`
  binary (`npm install` alone is enough — nothing extra to install), but that binary still needs to
  authenticate: either an `ANTHROPIC_API_KEY` environment variable, or a machine already logged in via
  `claude login`. **Honest caveat:** every real run behind this project's `STATUS.md` happened *inside* an
  already-authenticated Claude Code session, which passes its own auth through automatically — running
  `agent-loop` from a genuinely clean terminal with only a bare `ANTHROPIC_API_KEY` set has not been
  independently verified here, even though it's how the SDK is documented to work.

## Usage

```bash
npm install
npm run build
node dist/cli.js run "<task description>" [--dir <workDir>] [--port 4173] [--no-approval] [--max-retries 2]
```

Open the printed URL to watch the run live and approve/reject tool calls as they happen. Use the exact URL: it
ends in `#token=…`, a per-run secret the page needs to connect. The server listens on `127.0.0.1` only and
refuses WebSocket connections from any other website's page, so nothing but that tab can approve a tool call.
Reloading the tab re-shows any approval still waiting. `--no-approval` skips
the human-in-the-loop UI (only the built-in destructive-command safety net still applies) — useful for
unattended runs.

## Testing

```bash
npm run build
npm run test:plumbing          # no LLM calls — store/bus/server/WebSocket wiring only
npm run test:server            # no LLM calls — approval server access control + approval replay
node test/browser-approval.mjs # real API calls — full pipeline, real browser, real Approve clicks
node test/validate-dev-workflow.mjs   # real API calls — does dev-workflow actually trigger + get followed?
node test/validate-decisions-log.mjs  # real API calls — ask once, never re-ask what's already decided
```

Every `test/validate-*` and `test/browser-approval.mjs` script spends real API tokens — they exist because
reading the code isn't evidence something works.

## Status

See `STATUS.md` for the current, evidence-based state: what's been actually run and independently verified vs.
what's still untested. Nothing here is claimed to work from reading the code — every claim has a run ID, a
command, or a file behind it.

## Related projects

[**dev-workflow**](https://github.com/noobhacker02/Dev-Skill) is the general-purpose spec-first development
skill this project exists to test and improve — see [Consuming an external
skill](#consuming-an-external-skill-without-coupling-to-it) above for how the two stay independently versioned.

## License

[MIT](LICENSE)
