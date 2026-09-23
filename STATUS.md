# Status: agent-loop

## Summary

Built and ran the full pipeline end-to-end with real Claude Agent SDK calls, not just a design/dry-run. All
five phases (planner → test-designer → builder → verifier → gatekeeper) executed for real, produced real
artifacts, and the Overseer's continue/retry/stop logic ran between each one. The non-LLM plumbing — SQLite
store, event bus, WebSocket server, and the full human-approval round trip the whole project exists to enable
— was independently verified without spending API calls on it. Nothing here is claimed to work from reading
the code; every claim below has a command or a file behind it.

## What's good — verified with evidence

**Plumbing (no LLM calls, `npm run test:plumbing` against the built `dist/`):**
- `Store`: run/phase/verdict creation and the summary read the Overseer depends on round-trip correctly.
- `Store`: FTS5 full-text search over indexed log lines actually returns matches (`node:sqlite`'s bundled
  SQLite build supports FTS5 with zero extra native dependencies — confirmed before writing any code around
  it, not assumed).
- `EventBus` → `server.ts` → WebSocket client: an `approval-request` event emitted on the bus is received by a
  real connected WS client.
- WebSocket client → `server.ts` → `EventBus`: a `{"type":"decision", requestId, decision:"allow"}` message
  sent from the client resolves the exact `Promise` the `PreToolUse` hook is `await`-ing — this is the actual
  mechanism, not a simulation of it. This is the core of what the user asked this project to deliver ("engine
  + the approval UI... so we can test our development process and improve it").

**Full pipeline (real run, task: "Create a file named hello.txt ... containing exactly: agent-loop works",
`--no-approval` to run unattended, `--max-retries 0`):**
- Run finished with status `done`, exit code 0.
- `planner` wrote `PLAN.md` restating the task and scoping exactly one file, with explicit out-of-scope notes.
- `test-designer` read `PLAN.md` (not the conversation — a different `query()` call with zero shared context)
  and wrote `TESTPLAN.md`: 9 concrete, shell-executable scenarios plus a "gaps found" section.
- `builder` read `PLAN.md`/`TESTPLAN.md` and created `hello.txt` — verified byte-for-byte against the spec
  before reporting its own verdict.
- `verifier` **actually ran** `TESTPLAN.md`'s scenarios as shell commands (`test -f`, `wc -c`, `od -c`, `grep
  -qx`, `git rev-parse`, ...) rather than reading source and reasoning about it, and — this is the strongest
  single piece of evidence that the roles are doing real, independent work rather than rubber-stamping each
  other — **caught a real arithmetic bug**: `TESTPLAN.md`'s own byte-count scenario expected 17/18 bytes for
  a string that is actually 16/17 bytes. This was the test-designer's mistake, invisible to the builder (who
  wasn't checking the test plan's arithmetic, only the task), and it surfaced because the verifier phase
  executes rather than trusts.
- `gatekeeper` independently re-ran the core checks itself rather than trusting the verifier's report, and
  its `GATEKEEP.md` explicitly cites the verifier's caught bug as evidence that "verification genuinely
  executed... a rubber-stamp pass would have missed [it]."
- Every phase ended with a real, parseable verdict block; no phase needed a retry (Overseer's decision at each
  boundary was `continue`).
- Final artifact (`hello.txt`) matches the original task exactly: 16 bytes, "agent-loop works", no extra
  whitespace, no stray files, no unintended `git init`.
- 2,983 raw SDK stream events and 45 real assistant messages were emitted across the run — this is real
  streaming API traffic, not a mock.

## What's not yet verified

- **The approval UI's browser rendering itself** — the WS round-trip is proven (see plumbing tests above), and
  `ui/index.html` is real, functioning HTML/JS with no build step, but no one has looked at it rendered in an
  actual browser in this session (no display available in this environment). The event schema it consumes is
  exactly what `bus.ts`/`server.ts` emit, so this is a rendering/visual check, not a wiring risk.
- **Retry behavior** — this run's Overseer never had a reason to retry a phase, so `pipeline.ts`'s retry loop
  (same phase re-run with `retryFeedback` injected into the prompt) is implemented and typechecked but not
  yet exercised by a real failing phase. Worth a deliberately-adversarial task in a follow-up run.
- **A task that actually needs the approval UI live** (i.e. run with approval ON, on a real browser, clicking
  Approve/Reject on real pending tool calls) — not yet run; the current smoke run used `--no-approval` to
  finish unattended. The mechanism underneath it is proven; the live human-in-the-loop path itself is not.
- **Windows / remote portability** — built and run only in this Linux container so far. Nothing in the code is
  platform-specific (Node + `node:sqlite` + `ws`, no shell-outs beyond what the agents themselves invoke via
  the SDK's own Bash tool), but this is an assumption, not something tested on Windows yet.
- **Cost/token behavior at scale** — one tiny task was run. No data yet on cost or turn count for a
  non-trivial real feature.

## Architecture decisions worth recording

- Phases run as **separate top-level `query()` calls**, not as SDK-native subagent delegation via the `Agent`
  tool, because subagent delegation is model-driven/autonomous rather than externally sequenced — this
  pipeline needs a strict, deterministic order with pipeline-code-controlled retries, which the SDK's own
  subagent mechanism doesn't guarantee.
- `systemPrompt` is a real top-level `Options` field (a plain string fully replaces the default prompt); it
  was `outputStyle`, not `systemPrompt`, that requires the `settings` object — confirmed against the SDK docs
  directly rather than assumed, since an earlier pass in this project had incorrectly generalized that
  constraint to `systemPrompt` too.
- Verdicts are extracted from a fenced ` ```json ` block in each phase's final assistant message rather than
  via the SDK's `outputFormat: {type: 'json_schema'}` option — simpler to reason about and to debug from raw
  transcripts, at the cost of needing a text-parse fallback (implemented: a phase that doesn't return a
  parseable block is reported as failed rather than silently miscounted as a success).
- `node:sqlite` (built into Node 22.5+) instead of `better-sqlite3` — avoids a native-module build step
  entirely, and its bundled SQLite already supports FTS5 (confirmed with a throwaway test before committing to
  the approach).

## Test evidence

| Test plan item | Result |
|---|---|
| SQLite store: run/phase/verdict/summary round-trip | pass — `test/plumbing.mjs` |
| SQLite FTS5 log index search | pass — `test/plumbing.mjs` |
| Event bus → WS server → browser client (approval-request reaches the client) | pass — `test/plumbing.mjs` |
| Browser client → WS server → event bus (decision resolves the awaited hook promise) | pass — `test/plumbing.mjs` |
| Full 5-phase pipeline, real Agent SDK calls, unattended (`--no-approval`) | pass — run `877a43fe-ce02-4632-8fb5-1c55fce759e1`, status `done`, exit 0 |
| Each phase produces a real file artifact matching its spec | pass — `PLAN.md`, `TESTPLAN.md`, `hello.txt`, `VERIFY.md`, `GATEKEEP.md` all present and correct |
| Verifier phase actually executes checks rather than reading source | pass — caught a real byte-count bug in `TESTPLAN.md` that only shows up by running the check |
| TypeScript build/typecheck | pass — `npm run build` and `tsc --noEmit` both clean |
| Live approval UI in a real browser | not run — no display in this environment; WS mechanism proven, rendering unverified |
| Retry path (Overseer sends a phase back with feedback) | not exercised — implemented, typechecked, no failing phase occurred to trigger it |
| Windows / non-Linux run | not run |

## Decision needed

None blocking. Two things worth the user's input when convenient, not urgent:
1. Whether to push this to a GitHub repo now that there's a real, verified milestone (per the earlier
   agreement: ask once there's something real, not before) — no repo exists yet for this project.
2. Whether the next real test should specifically target the approval-UI-ON path and/or a task designed to
   force at least one retry, since those are the two verified-by-code-only areas above.
