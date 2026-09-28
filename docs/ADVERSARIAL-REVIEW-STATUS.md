# Adversarial review status: what's been found and fixed, what hasn't been checked yet

A running scorecard across the whole self-paced adversarial-review effort on this project, kept
separate from the per-finding detail already in `CHANGELOG.md` (the "Security" and "Cross-platform
audit" sections there have the full writeup, evidence, and fix for each item below) and from
`docs/LEAK-REVIEW-ui-video.md` (the UI/video-specific pass, referenced rather than repeated here).
Every fix listed was found by actually constructing the failing case and running it, not by reading
the code and reasoning about whether it looked safe — see `SKILL.md` Step 8 in the `dev-workflow`
skill, updated this round to say that explicitly, because reasoning alone had already missed all of
these once.

## Fixed, tested, pushed

| # | Finding | Where | Severity |
|---|---|---|---|
| 1 | Hard-deny safety net let 24/27 dangerous Bash commands through under `--no-approval` | `src/hooks.ts` | High |
| 2 | `dev-workflow`'s `check_staged.py` missed 16/19 secret formats, 19/26 destructive commands | Dev-Skill repo | High |
| 3 | Conflated completion/acceptance in phase verdicts; unbounded repair routing; no terminal state on Overseer API failure; decision authority pulled from worker-writable Markdown | `src/pipeline.ts`, `src/overseer.ts` | Correctness |
| 4 | Browser Agent: `open()`'s localhost-only check ran once at the call site; a loaded page could then navigate anywhere via link click, redirect, or background fetch | `src/browser-tools.ts` | High (sandbox escape) |
| 5 | No cap on screenshots — unbounded disk fill | `src/browser-tools.ts` | Low (DoS) |
| 6 | **Package-install approval bypass**: one approved `npm install <pkg>` saved a rule covering installing *any* future package, including malicious ones | `src/bash-analysis.ts` | Critical (supply-chain) |
| 7 | **Terminal escape-sequence injection**: Bash output, file content, and the model's own text reached the real terminal raw, including inside the approval-prompt body itself | `src/terminal.ts` | Critical (defeats the human-approval model) |
| 8 | **Browser `close()` cascade**: a failed video save re-threw after cleanup, skipping `browser.close()` (leaked Chromium) *and*, because `pipeline.ts` calls `close()` first in its own `finally` with no try/catch, skipping `store.finishRun`/`run-end` too — the run stuck "running" forever | `src/browser-tools.ts`, `src/pipeline.ts` | High (reliability) |
| 9 | `--port 0` (valid CLI value) broke the approval UI: host/origin allowlists and the printed URL were frozen at literal port 0 | `src/server.ts` | Medium (reliability) |
| 10 | Browser screenshot tool printed its full local filesystem path into the transcript/index/every WebSocket message — already visible in this project's own public demo screenshot and video | `src/browser-tools.ts` | Medium (info disclosure, proven via own repo) |
| 11 | `dev-workflow`'s git hooks only looked for `python3`; many Windows Python installs only have `python` | Dev-Skill repo | Medium (portability) |
| 12 | `export`/`set`/`declare`/`unset`/`alias`/`readonly` were missing from `NEVER_RULE`: a bland-looking `export LD_PRELOAD=…`/`NODE_OPTIONS=…` could earn a "don't ask again" rule, and — worse — once it ran (one human approval, or under `--no-approval`) it silently changed what an *already-trusted* rule like `Bash(npm test:*)` actually executed next, since env/alias state persists across Bash calls in the same session (confirmed via the SDK's own `CwdChangedHookInput`, which exists for the identical reason `cd` persists) but a rule's text match doesn't account for it | `src/bash-analysis.ts` | High (undermines every existing "don't ask again" rule, not just its own) |

Every row has a permanent regression test, and the full suite (11 test files, no API cost) plus
`test/stress/pipeline_logic.sh` (now 11 scenarios — see case K below) pass after each one — re-run
at every step, not just once at the end.

## Checked and confirmed already safe (no fix needed)

- `open()`'s URL regex against realistic bypass attempts (userinfo tricks, subdomain tricks, loopback
  encodings, protocol confusion) — verified against the real regex, not reasoned about.
- Path traversal against `/artifacts/<runId>/<file>` — `server.ts` uses `path.join`, which can't be
  escaped by a later absolute-looking segment; confirmed with a real request and a real secret file
  placed outside `artifactRoot`.
- The WebSocket/HTTP access control's core threat model (DNS-rebinding Host headers, another site's
  Origin even while holding a valid token, no/wrong token) — already soundly built and tested by a
  prior session; re-ran all of it, found nothing new.
- Every `innerHTML` write in `ui/index.html` traced source-to-sink — all properly escaped.
  `artifactUrl()`'s unescaped use in `href`/`src` is safe because its inputs are
  `encodeURIComponent`-ed and never user-controlled.
- `report.html`'s embedded event JSON is `<`-escaped against script injection; its output path is
  built from a server-generated UUID, not attacker-influenced.
- Path handling, home-directory resolution, and the SQLite store across Linux/macOS/Windows — all go
  through `node:path`/`node:os`/`node:sqlite`, no OS-specific assumptions found.

## Checked this round, confirmed no live attack surface

- **`store.ts`'s `searchLogs()` FTS5 query construction** — the search term binds through a
  parameterized `?` placeholder (no traditional SQL injection), but SQLite's FTS5 module still
  parses that bound string as a *query expression* with its own syntax (`AND`/`OR`/`NOT`, phrase
  quoting, column filters), so a malformed term could still throw at the FTS5 layer rather than the
  SQL layer. Turns out moot: `searchLogs()` is called from exactly one place in the entire codebase
  — `test/plumbing.mjs`, with the hardcoded literal `"fox"` — never from the CLI, the server, the
  WebSocket handlers, or the Overseer. No untrusted (or even user-supplied) input reaches it today.
  Not hardening speculatively against an input path that doesn't exist; revisit if this method is
  ever actually wired to a real caller.

- **`overseer.ts`'s decision-parsing against a hallucinated forward `repairTarget`** — an unrecognized
  `action` value safely falls through to the same conservative default as an unparseable response
  (traced, not just assumed). The one path with no prior test coverage at all: an Overseer decision
  claiming `repairTarget` is a phase *later* in the pipeline than the one that just failed (e.g.
  `planner` fails but the decision claims `gatekeeper` needs the redo). Both `overseer.ts`'s own
  bounds check and `pipeline.ts`'s `isValidRepairTarget` are supposed to reject this — added a new
  fake-SDK scenario (`forward-repair`) that hallucinates exactly this on every turn and asserted, via
  the same-run log, that `gatekeeper` (searched for its `write GATEKEEP.md` instruction) is never
  actually invoked. Held: the run correctly falls back to a same-phase repair every time and
  terminates cleanly once the retry budget is exhausted, exactly like the existing `always-retry`
  scenario. New permanent stress scenario (`test/stress/pipeline_logic.sh` case K); all 11 suites and
  now 11 stress scenarios still pass.

- **Cost-tracking accuracy across repair/retry loops and API-failure paths** — the entire stress
  suite never actually exercised the usage-EMISSION code in `src/phases.ts`/`src/overseer.ts` at
  all: `test/stress/fake-sdk/sdk.mjs`'s `query()` only ever yielded an `assistant` message, never
  the `result` message that carries `total_cost_usd`, so cost tracking under a real multi-attempt
  repair loop had zero coverage (`test/ui-render.mjs` only checks the UI's summing of hand-fed
  synthetic events, not the pipeline's own emission). Fixed by having the fake SDK yield a fixed
  $0.01 `result` after every completed call, then wired a permanent automated check into
  `pipeline_logic.sh`'s shared `runit()` so every scenario's printed "Cost: $X.XX" is checked
  against `0.01 × completed calls`, not spot-checked manually.
  This immediately found two real issues, both fixed:
  1. The check itself first compared against *attempted* calls, not *completed* ones, and
     misfired on `overseer-throws` (2 attempts logged, but the Overseer's call throws
     synchronously before its generator ever runs, so it never emits a `result` — correctly $0).
     Traced with the raw call log and CLI output before concluding this was the check's bug, not
     the pipeline's: `overseer.ts`/`phases.ts` correctly only add cost when a `result` actually
     arrives. Fixed by having the fake SDK mark completions separately from call attempts, and
     comparing against completions.
  2. That fix's own shell idiom (`` grep -c ... || echo 0 ``) double-printed `"0\n0"` on a
     real zero-match file, because `grep -c` already prints `0` to stdout before exiting `1` —
     caught by testing the idiom standalone against a real zero-match file before trusting it,
     not by reasoning that it "should" work. Fixed with `` count=$(grep -c ... 2>/dev/null); count=${count:-0} ``,
     which only substitutes on a genuinely empty result (missing file), verified against both a
     zero-match file and a missing file directly.
  All 11 stress scenarios and the full 80-assertion unit suite pass with the corrected check in
  place; see `CHANGELOG.md` for the full diff.

- **This session's new UI code** (`phaseCounts` breakdown in `renderDock()`, the per-phase
  `wait-badge` in `renderStepper()`) — traced both new `innerHTML` sinks source-to-sink rather than
  assuming the existing "every innerHTML write is escaped" finding still covered code written after
  it. `renderDock()`'s breakdown line (`ui/index.html:464`) is built from `state.pending[].phase`
  and passed through `esc()` before insertion (`ui/index.html:468`) — safe regardless of what
  reaches it. `renderStepper()`'s per-phase label (`ui/index.html:370`) is inserted unescaped, but
  its only source is `PHASES` (`ui/index.html:282`), a hardcoded five-element literal array baked
  into the client script — never a server event, tool name, or LLM-authored text — so there is no
  channel for adversarial content to reach that sink at all. Confirmed by reading the actual
  assignment, not inferred from the variable's name.

- **`data-dir.ts`'s hash-based run-directory naming** — reasoned-through and then verified against
  running code, not left as a "seems fine" note. Two failure modes checked: (1) accidental/adversarial
  collision between two *different* projects — the directory name is `${label}-${hash}`, where
  `label` (the sanitized basename) collides easily and by itself (e.g. `~/work/myapp` and
  `~/personal/myapp` both sanitize to `myapp`), but `hash` is 16 hex chars (64 bits) of
  `sha256(resolve(absWorkDir))`; ran both paths through the real function and got different hashes
  (`myproj-7db5779d9ca5cb42` vs `myproj-3679abae05b9f876`) — a full collision needs both parts to
  match, and forcing the hash half by choice of `--dir` string is a 2^64 preimage search, while
  accidental collision needs the birthday bound on 64 bits (~2^32 same-basename projects on one
  machine) to become likely — neither is reachable in practice for a single-user local CLI tool. (2)
  The opposite failure — the *same* directory hashing differently depending on how it's spelled,
  which would silently split one project's audit trail into two — checked with a trailing slash,
  a `.` segment, and a `..` segment against the real function: all four spellings of the same
  directory produced the identical hash, because `path.resolve()` normalizes before hashing. Both
  properties (different real paths reliably differ; the same real path never does) hold as run.

- **CI actually failed once, for real, in this project's own history** (run #16, commit `f395a61`,
  the Desktop-theme UI commit) — found by checking GitHub Actions run history after the user asked
  "did the build fail," not by assuming green because the *next* push passed. `npm test` failed at
  `test/plumbing.mjs:95`, asserting a `record-decision` WebSocket round-trip broadcasts its event.
  Confirmed that commit touched only `ui/index.html`, docs, and screenshots (`git show --stat`) — it
  could not have caused a server/bus-side WS timing failure. Root cause: the test sends the WS
  message, then does a *fixed* `setTimeout(r, 200)` sleep and checks the received-events buffer
  exactly once — a structural race (send → server → bus → a synchronous SQLite write → broadcast →
  client receive, all needing to finish inside 200ms) that will occasionally lose on a loaded runner
  regardless of how rarely it's actually observed. Tried to reproduce it 35 times (15 idle, 20 under
  artificial 4-core CPU saturation) and couldn't — consistent with a rare CI-specific hiccup, not a
  deterministic bug, but the pattern is racy by construction either way and had already failed for
  real once. Fixed by replacing both fixed-sleep-then-check-once waits in `test/plumbing.mjs`, and
  the equivalent one in `test/approval-server.mjs` (which had a better fix available: the server's
  own `replay-complete` sentinel, always sent right after replay finishes, is a deterministic
  condition to poll for instead of a guessed duration), with a `waitFor(predicate, {timeoutMs})`
  poller — faster on a healthy machine, robust under load. Checked the same pattern in
  `test/approval-rules.mjs` and `test/terminal.mjs` (both use short sleeps too) and left them alone:
  their target state is set synchronously in-process before any `await` in the code path under test,
  not across a real WS/HTTP/SQLite round-trip, so there's no equivalent race to fix. All 11 suites
  (81 assertions) and 11 stress scenarios still pass; re-ran the two fixed files 10 times each with
  no failures.

## Not yet adversarially reviewed

Nothing outstanding from this round. Every item opened in this document has a resolution above
(either "fixed, tested, pushed" or "checked, confirmed no live attack surface") — treat this section
as empty until the next round of adversarial review opens a new one, which is expected: "keep
checking" means this list is a queue, not a one-time audit.

## Verification discipline used throughout

1. Hypothesize a concrete, specific failure — not "is this secure?" but "what happens if I strip
   `python3` from `PATH`" or "what does this screenshot actually show pixel-for-pixel."
2. Go verify it for real against the running code (a constructed exploit script, a real browser, a
   real git hook invocation with a doctored `PATH` — never just re-reading the source and reasoning).
3. Fix what's confirmed.
4. Add a permanent regression test for it.
5. Re-run the full suite before moving to the next surface.

This is now also encoded directly in `dev-workflow`'s `SKILL.md` (Step 8), since it's the methodology
that actually found every item in the fixed table above.
