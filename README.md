# agent-loop

A multi-agent dev-loop orchestrator built on the real [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).
An **Overseer** drives five specialized worker phases through a task, each phase running as its own isolated
`query()` call, all of it streamed live to a browser UI where every tool call can be approved or rejected by a
human in real time.

This exists to answer one question: **does our dev-workflow actually work, and how do we tell?** The approval
UI is the point, not a nice-to-have — watching every step of an agent's work live, and being able to say "no,
not that," is how this project (and eventually the `dev-workflow` skill it's meant to test) gets evaluated and
improved rather than trusted on faith.

## Architecture

```
                     ┌─────────────┐
     task ──────────▶│  Pipeline   │
                     └──────┬──────┘
                            │ runs phases in order, retries on Overseer's say-so
              ┌─────────────┼─────────────┬─────────────┬─────────────┐
              ▼             ▼             ▼             ▼             ▼
          planner   test-designer     builder       verifier     gatekeeper
        (PLAN.md)    (TESTPLAN.md)  (implements)   (VERIFY.md)  (GATEKEEP.md)
              │             │             │             │             │
              └──────┬──────┴──────┬──────┴──────┬──────┴──────┬──────┘
                     ▼                                          each phase ends
              short structured verdict                          in a fenced ```json
              (success/headline/details/concerns)                verdict block
                     │
                     ▼
                Overseer (reads only the short verdicts + prior
                summaries from SQLite — never a full transcript)
                     │
          continue ──┼── retry (same phase, with feedback) ── stop
```

Every phase is its own top-level `query()` call with its own system prompt, its own restricted tool list, and
zero memory of any other phase's conversation — deliberately, since subagent delegation in the SDK is
model-driven rather than externally sequenced, and this pipeline needs a strict, deterministic order with a
retry loop the pipeline code controls. Phases hand off through files (`PLAN.md`, `TESTPLAN.md`, `VERIFY.md`,
`GATEKEEP.md`) in the working directory plus short indexed summaries in SQLite — not shared conversation state.

The **Overseer** is a separate `query()` call too, invoked between phases. It never reads a phase's raw
transcript or tool calls — only the phase's own short verdict and the other phases' prior summaries pulled
from the SQLite index. This is the "keep the main agent's memory as small as possible" requirement: the
Overseer reads and decides like a person skimming status updates, not by re-deriving everything a worker
already did.

### Why every tool call, not just the risky ones

The SDK's own permission evaluation runs hooks → deny rules → ask rules → permission mode → allow rules →
`canUseTool`, in that order — and `canUseTool` is *skipped entirely* for anything auto-approved earlier in
that chain. That ruled it out as "the" approval mechanism on its own. A `PreToolUse` hook runs before all of
that, for every tool call, unconditionally — see `src/hooks.ts` — which is what makes "every step goes through
the UI" actually true rather than aspirational.

### Indexed logs, not RAG

`src/store.ts` is a single SQLite file with FTS5 full-text search over structured rows (runs, phases, indexed
log lines). No vector embeddings, no similarity search — explicitly out of scope for what this needs. The
Overseer and a human both query the same short rows: "what did the builder phase do, and why."

## Layout

| Path | What |
|---|---|
| `src/types.ts` | Shared types: phases, events, verdicts, decisions |
| `src/store.ts` | SQLite + FTS5 store (`node:sqlite`, no native build step) |
| `src/bus.ts` | Event bus: agent events out, human approve/deny decisions in |
| `src/hooks.ts` | The `PreToolUse` hooks — the safety net and the approval-UI round-trip |
| `src/phases.ts` | The five phase system prompts + `runPhase()`, the actual `query()` wrapper |
| `src/overseer.ts` | Overseer decision logic (continue / retry / stop) |
| `src/pipeline.ts` | Sequences the five phases, applies Overseer decisions, retry budget |
| `src/server.ts` | HTTP + WebSocket server: broadcasts events, receives decisions |
| `ui/index.html` | The live timeline + Approve/Reject UI (vanilla JS, no build step) |
| `src/cli.ts` | `agent-loop run "<task>"` entry point |

## Usage

```bash
npm install
npm run build
node dist/cli.js run "<task description>" [--dir <workDir>] [--port 4173] [--no-approval] [--max-retries 2]
```

Open the printed URL to watch the run live and approve/reject tool calls as they happen. `--no-approval` skips
the human-in-the-loop UI (only the built-in destructive-command safety net still applies) — useful for
unattended smoke runs.

## Status

See `STATUS.md` for the current, evidence-based state (what's been actually run and verified vs. what's still
untested). Built as a companion/successor project to the `dev-workflow` skill in the parent repo, following
the same standard: nothing is claimed to work until it's actually been run and the output inspected.
