# Status: agent-loop

## Summary

Built and ran the full pipeline end-to-end with real Claude Agent SDK calls across five real runs: two tiny
smoke tasks, one live-browser approval-UI run (18 real Approve clicks), one real non-trivial feature build
(a working CLI tool, independently re-verified by hand), and one run of the project's actual meta-goal — using
agent-loop to test whether the sibling `dev-workflow` skill really works. All five pipeline phases (planner →
test-designer → builder → verifier → gatekeeper) executed for real every time, and three separate real bugs/
constraints were caught along the way: an arithmetic mistake by an earlier phase caught by a later one (twice,
in two different runs), a genuine process-exit deadlock in the server that only a real lingering browser
connection could expose, and a root-user restriction on `bypassPermissions` that forced a real fix in the
validation script. The non-LLM
plumbing — SQLite store, event bus, WebSocket server, the full human-approval round trip — was independently
verified too. Nothing here is claimed to work from reading the code; every claim below has a command, a real
run ID, or a file behind it.

## What's good — verified with evidence

**Real, non-trivial feature build (task: a dependency-free Node.js `wordcount.js` CLI matching `wc`
conventions, unattended, default retry budget):**
- Finished `done` in ~7 minutes wall clock (19:49:50 → 19:56:49), no retries needed — every phase succeeded
  on attempt 1 (honest finding, not forced: this run had a real retry budget available and simply didn't need
  it, unlike the earlier smoke runs which used `--max-retries 0`).
- `test-designer` independently caught a real arithmetic bug in `PLAN.md`: the Planner's hand-derived word
  count for `sample1.txt` was wrong (16 vs. the correct 17); `builder` used the corrected value and confirmed
  it with a fresh `wc` run rather than trusting either document. This is a **second, distinct instance** of a
  later phase catching an earlier phase's real mistake (the first was the byte-count bug in the `hello.txt`
  smoke run) — two different bugs, caught at two different phase boundaries, is stronger evidence this isn't
  a one-off fluke.
- **Independently re-verified outside the pipeline entirely** (not trusting the Verifier/Gatekeeper's own
  claims): ran `wc sample1.txt sample2.txt` myself and got 17/2/86 and 10/4/67 — matches `README.md`'s
  documented table exactly. Ran `node wordcount.js sample1.txt`/`sample2.txt`/a nonexistent path myself:
  output matched exactly (`17\n2\n86`, `10\n4\n67`), and the missing-file case printed a clear error to
  stderr and exited 1, as documented.
- The one honestly-flagged gap: an EACCES/permission-denied test scenario couldn't be genuinely exercised
  because this sandbox runs as root (permission bits don't block root) — `test-designer`, `verifier`, and
  `gatekeeper` all independently noted this as inconclusive rather than silently passing or hiding it.
- Resource use for one real feature: ~7 minutes wall clock, 5,845 raw SDK stream events, 59 real assistant
  messages across all 5 phases + Overseer calls — the first real data point on what a non-trivial task costs,
  beyond the tiny smoke tasks above.

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

**The actual meta-goal: using agent-loop to test whether dev-workflow works (`test/validate-dev-workflow.mjs`):**
- This is not one of the 5 pipeline phases — a standalone script reusing the same `query()`-streaming pattern,
  since forcing a one-off audit into `PipelineConfig`/`PhaseName` would be over-engineering.
- Installs the sibling `dev-workflow` skill as a real `.claude/skills/dev-workflow/` in a fresh throwaway repo
  (an existing tiny Node app, not a blank project) and runs one real session with an ordinary feature request
  that never says "spec" or "workflow" — a genuine test of whether the skill's own description triggers it,
  not whether it complies when told to.
- **Found a real, environment-specific constraint the hard way**: `permissionMode: "bypassPermissions"` is
  refused outright by Claude Code when running as root ("cannot be used with root/sudo privileges for security
  reasons") — this sandbox runs as root. Fixed by using an unconditional-allow `PreToolUse` hook instead (the
  same mechanism `src/hooks.ts`'s own approval hook uses when `requireApproval` is false), which isn't affected
  by that restriction since hooks run before permission-mode evaluation. Worth remembering: agent-loop's own
  CLI never used `bypassPermissions` in the first place, for the same underlying reason.
- Result: the `Skill` tool fired correctly, unprompted, and all 9 independently-checked artifacts dev-workflow's
  own loop requires were present and correct — see `Dev-Skill/specs/dev-workflow-skill/STATUS.md` (Iteration 3)
  for the full breakdown. No defects found in dev-workflow this run.

## What's not yet verified

- **Retry behavior** — three real runs now (two trivial smoke tasks, one real non-trivial feature with the
  full default retry budget available) and none has ever needed a retry; every phase has succeeded on attempt
  1 every time. `pipeline.ts`'s retry loop is implemented and typechecked but genuinely unexercised — this is
  an honest gap, not something to paper over by forcing a contrived failure. It would need either a
  deliberately adversarial/impossible task, or real usage over enough runs that a phase eventually fails on
  its own.
- **Windows / remote portability** — built and run only in this Linux container so far. Nothing in the code is
  platform-specific (Node + `node:sqlite` + `ws`, no shell-outs beyond what the agents themselves invoke via
  the SDK's own Bash tool), but this is an assumption, not something tested on Windows yet.

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
| Real non-trivial feature build (`wordcount.js` CLI, default retry budget) | pass — run `8bc5bd07-f143-4424-b987-f1ed2c8b085e`, status `done`, exit 0, ~7 min wall clock |
| Built tool actually works, checked independently of the pipeline's own claims | pass — `wc`, `node wordcount.js sample1.txt`/`sample2.txt`/missing-file all run by hand, output matches `README.md` exactly |
| A second, distinct instance of a later phase catching an earlier phase's real mistake | pass — test-designer caught a wrong word count in the Planner's `PLAN.md` (16 vs. correct 17), builder used the corrected value |
| Retry path (Overseer sends a phase back with feedback) | not exercised — implemented, typechecked; 3 real runs (2 smoke, 1 real feature with full retry budget available) and none has ever needed one |
| Windows / non-Linux run | not run |
| agent-loop validates dev-workflow's real-world skill triggering | pass — `test/validate-dev-workflow.mjs`, Skill tool fired unprompted, 9/9 artifact checks passed, see Dev-Skill's `specs/dev-workflow-skill/STATUS.md` (Iteration 3) |

## Decision needed

None blocking. Pushed to https://github.com/noobhacker02/test-dev-1. Remaining open items, not urgent:
1. The retry path is still genuinely unexercised after 3 real runs — needs either a deliberately
   adversarial/impossible task or enough real usage that a phase eventually fails on its own; not worth
   forcing artificially just to check a box.
2. Windows/remote portability is still unverified — an assumption, not something disproven.
3. The dev-workflow validation script has only run once, with one task phrasing — a single pass is real
   signal but not enough to call triggering "solved"; worth a few more runs with different task phrasing
   before trusting it broadly.
