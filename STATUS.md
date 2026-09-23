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

**Live browser approval UI (real run, task: "Create a file named world.txt ... containing exactly: browser
approval works", approval UI ON, `test/browser-approval.mjs`):**
- A real headless Chromium (the pre-installed binary, launched via `playwright-core`, resolved by scanning
  `/opt/pw-browsers` directly since the npm package's version doesn't reliably match the installed browser's
  revision number) opened the actual served page, and its WebSocket client reported `live`.
- The script clicked the real, rendered "Approve" button in the DOM — not a synthetic WebSocket message — for
  every pending tool call across all 5 phases: **18 real approve-clicks** across the full run.
- The pipeline produced the correct artifact (`world.txt`, exact content) and the browser's own timeline UI
  showed 18 "Approval allow" resolution cards, confirmed by both the CLI process's own exit and by querying
  the live DOM after the run.
- **Found and fixed a real bug in the process, not the test**: the first two attempts at this test correctly
  completed all 5 phases in under 3 minutes each time (confirmed via the SQLite phase timestamps) but the CLI
  process never exited afterward — `close()` in `server.ts` called `server.close(callback)`, and Node's
  `http.Server#close()` only fires its callback once every open connection ends *on its own*; a browser tab
  connected via WebSocket for the run's duration never does that. This is a genuine deadlock that would affect
  any real use of `agent-loop run` with the approval UI left open in a browser — `test/plumbing.mjs`'s
  short-lived WS client never exposed it because it closes its own socket immediately, which is exactly why a
  real, lingering browser connection was worth testing separately. Fixed by terminating tracked WS clients and
  calling `server.closeAllConnections()` before closing the HTTP server, instead of waiting for a natural
  disconnect. Re-ran after the fix: full pipeline, 18 real clicks, clean exit code 0.

## What's not yet verified

- **Retry behavior** — no run so far has had a reason to retry a phase, so `pipeline.ts`'s retry loop (same
  phase re-run with `retryFeedback` injected into the prompt) is implemented and typechecked but not yet
  exercised by a real failing phase. Worth a deliberately-adversarial task in a follow-up run.
- **Windows / remote portability** — built and run only in this Linux container so far. Nothing in the code is
  platform-specific (Node + `node:sqlite` + `ws`, no shell-outs beyond what the agents themselves invoke via
  the SDK's own Bash tool), but this is an assumption, not something tested on Windows yet.
- **Cost/token behavior at scale** — only tiny smoke tasks have been run. No data yet on cost or turn count for
  a non-trivial real feature.

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
| Live approval UI in a real browser, real Approve clicks | pass — `test/browser-approval.mjs`, 18/18 real clicks across all 5 phases, exit 0 |
| CLI process exits cleanly after a run with the approval UI left open | pass (after fix) — was a real deadlock (`server.close()` waiting on a connection that never closes itself), fixed in `src/server.ts` |
| Retry path (Overseer sends a phase back with feedback) | not exercised — implemented, typechecked, no failing phase occurred to trigger it |
| Windows / non-Linux run | not run |

## Decision needed

None blocking. Pushed to https://github.com/noobhacker02/test-dev-1. Remaining open items, not urgent:
1. A deliberately adversarial/ambiguous task to force the Overseer's retry-with-feedback path at least once.
2. A real, non-trivial feature build rather than another smoke task, to get real cost/turn-count data.
3. Windows/remote portability is still unverified — an assumption, not something disproven.
