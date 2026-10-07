# Round 2 triage

Round 2 (a fresh-context agent, a **code** round: `src/net-gate.ts` and its use, `src/hooks.ts`, the S1 and S1b browser tools, `scripts/checkpoint.mjs` and the compaction hooks, `bench/`) reported **31 findings**:
1 critical, 3 high, 13 medium, 11 low, plus 3 it could not confirm here (A44 needs Windows or macOS, A45's harm was not shown, A46 needs a live session). The agent was cut off by the account's usage limit after its
findings table and last finding were written; its file was written as it went, so nothing was lost. Dispositions: **FIXED**, **SPEC**, **SCHEDULED**, **REJECTED**, as in round 1. This file is kept truthful at every
commit: a row says FIXED only in the commit that fixes it. Work is in batches, in this order: **2** security (A51 first, then A27, A28, A29, A30, A44), **3** process kills (A39, A41), **4** the browser tools'
honesty (A21, A24, A25, A26, A31, A37, A38, A42, A47, A50), **5** tooling (A32, A33, A34, A35, A36, A48), **6** documents (A40, and the claims behind A22, A25, A26, A43). A22, A23, A43, A45 and A46 wait for the stage named.

| id | severity | disposition | what changed, or is planned | test, or where it will be |
|---|---|---|---|---|
| A21 | high | SCHEDULED | batch 4: a repeat of a delivered notice becomes undelivered again, counts as activity for the settle rule, and emits an event at 2, 10, 100 | `test/browser-observability.mjs` (a page that repeats a delivered failure) |
| A22 | medium | SCHEDULED | before S5 (the form diff depends on it): run the walk and the fill guard where the page cannot reach (isolated world, or natives captured by an init script); until then BROWSER-AGENT 4c says the reader is advisory against a page that cooperates with it | S5 prerequisite; test page from the finding (6 lines) |
| A23 | low | SCHEDULED | S4 (the watchdog reads this signal): report every gate refusal that is not provably the browser's own, once per host:port with a count | `test/browser-redirect-gate.mjs` with the `no-referrer` page |
| A24 | medium | SCHEDULED | batch 4: judge reachability through scrollable ancestors, and tell the agent that scrolling the container is the remedy | `test/browser-frames.mjs` section 5 (a 30-question scrolling dialog as the allowed twin) |
| A25 | low | SCHEDULED | batch 4 (claim narrowed to the three signals now; the wider rule and `elementFromPoint` check with S5) | `test/browser-frames.mjs` variants page |
| A26 | medium | SCHEDULED | batch 4: scan cap says so, text tool keeps the reader's notes; closed roots through an `attachShadow` init script follow with S5 (the docs' headline claim is qualified now) | `test/browser-frames.mjs` (100,001 leading elements; 25 frames; a slow frame) |
| A27 | high | FIXED | `toolPath`: a leading ~ is the home directory as the tools expand it; ~user, UNC, drive-relative, %VAR% and NUL are refused; scope and sensitive hooks both use it | `test/path-text.mjs` section 1; benchmark `file-hooks` |
| A28 | medium | FIXED | the sensitive-file hook resolves against `--dir` (`createSensitiveFileHook(workDir)`) | `test/path-text.mjs` section 3 (run from another directory) |
| A29 | low | FIXED | Glob's pattern is checked (absolute, `..`, ~, braces); the credential list matches `.env.*` except the template files, keys, certs, `.docker`, `.kube`, `.gnupg`, `.agent-loop` and `.git` | `test/path-text.mjs` sections 4 and 5 |
| A30 | medium | FIXED | git's global options are dropped before matching; rm of any top-level directory or its contents is denied; after `cd /`, any recursive forced rm is | `test/safety-rewrites.mjs`, 16 deny and 14 allow rows |
| A31 | medium | SCHEDULED | batch 4: a deadline on every browser tool; a busy page reports "not responding" and the tab can be closed without the renderer | `test/browser-tools.mjs` (a `for(;;){}` page, and one inside a frame) |
| A32 | medium | SCHEDULED | batch 5: checkpoint refuses unless a secret scanner is wired in, and the ignore list widens | `test/checkpoint.mjs` case 4b (no hook, `.env.local`) |
| A33 | low | SCHEDULED | batch 5: a per-repository branch allow-list and an origin check; `branch-not-designated` state | `test/checkpoint.mjs` |
| A34 | medium | SCHEDULED | batch 5 (Dev-Skill): redactor matches key names with word characters before them, plus Cookie, Set-Cookie and Bearer; keeping the summaries in a public repository is a decision for the user | `tests/handoff_hook_test.py` (the finding's table) |
| A35 | low | SCHEDULED | batch 5: a baseline justification names the old and the new value and is used once | `test/bench-integrity.mjs` |
| A36 | low | SCHEDULED | batch 5: tokens built at run time in the pages, a source-echo control with the full HTML, the closed-shadow check anchored to the tool's sentence, a yield metric that does not reward silence | `test/bench-suites.mjs` |
| A37 | low | SCHEDULED | batch 4: visible text stripped, fenced as data, look-alike headers neutralised | `test/browser-observability.mjs` (the forging page) |
| A38 | medium | SCHEDULED | batch 4: one `safeUrl` rendering everywhere, the title cleaned and capped, a byte cap per string field in `emitEvent` | `test/browser-observability.mjs`, `test/bus-history.mjs` |
| A39 | medium | SCHEDULED | batch 3: an invalid upstream status is a 502, the response callback cannot throw, the CLI gets a last-resort handler that runs the cleanup | `test/net-gate.mjs` (000, 099, a non-numeric status line) |
| A40 | low | SCHEDULED | batch 6 (docs): the two paragraphs corrected with the measurement; the browser's own DoH probe named | BROWSER-AGENT sections 4 and 7 |
| A41 | high | SCHEDULED | batch 3: the route callback cannot reject, a last-resort handler runs the cleanup, popups are capped per session and closed tabs leave `everTabs` | `test/browser-tools.mjs` (three popups opened and closed, video on) |
| A42 | medium | SCHEDULED | batch 4: a password's typed value and keys are never recorded; `fill` refuses a password field in LIVE mode | `test/browser-observability.mjs` or a new `test/no-secrets-recorded.mjs` (the D6 test, no longer planned) |
| A43 | medium | SCHEDULED | S2 (the allowances list gains ports): TEST mode allows the ports of the app under test; the docs say "every local port" until then (batch 6) | `test/net-gate.mjs` (a second listener that must receive 0 connections) |
| A44 | medium | FIXED | drive-relative, UNC and %VAR% forms refused before the file system is touched (argued, not run on Windows: the string forms are tested on all three systems by CI) | `test/path-text.mjs` section 2 |
| A45 | low | SCHEDULED | S4: suppression keyed to the request chain, not a two-second window | `test/browser-observability.mjs` |
| A46 | medium | SCHEDULED | one experiment for the user (start `claude` in `agent-loop/` and check for injected context); if the hooks are absent, add the same settings under `agent-loop/.claude/` | `tests/handoff_hook_test.py` |
| A47 | medium | SCHEDULED | batch 4: the query filters inside the page, then the 60-ref budget applies to the matches | `test/browser-frames.mjs` (100 buttons and one more) |
| A48 | low | SCHEDULED | batch 5: `test:bench-table` re-measures the deterministic suites and compares values; CI re-measures the browser suites | `test/bench-table.mjs` |
| A49 | low | FIXED | `bench/adversary.mjs`: a section ends at the end of the input (`(?![\s\S])`, not the letter Z), a Reproduction field needs a command, code or output and cannot say "none" | `test/adversary-round.mjs`, 6 new controls, each failed on the old validator |
| A50 | low | SCHEDULED | batch 4: the head says how many were left out, undelivered entries are listed first, only what was listed is marked delivered | `test/browser-observability.mjs` |
| A51 | critical | FIXED | read-only auto-approval is an allow-list of safe forms: a sed script is a plain p, d, q or one s/// with flags that cannot run or write; git only in reading forms (branch and remote list-only, no --output, --no-index, --ext-diff); no output or exec flags (rg --pre, sort -o, tree -o, find -L); every non-flag word judged by its real location; a glob, brace expansion, tilde or variable asks; less and more ask (IMP-016) | `test/bash-readonly.mjs`, 216 rows (110 attack rows ran without a prompt before); 61 mutants, 2 equivalent; benchmark `shell-readonly` 106 to 216 of 216 |

Not closed: every SCHEDULED row. The standing rule applies: a stage is not closed while a high or critical finding about it is open. Batch 2 is done: the critical (A51) and the path high (A27) are FIXED.
Still open and high: A21 (repeated notices) and A41 (popups kill the process); A22 stays scheduled before S5.

Found while fixing A51, not by the adversary (the same class, added to the fix): the file tools could write `.git/config`, and an auto-approved `git status` then runs `core.fsmonitor`; `less '+!cmd'`, `printf -v PATH`, `ps eww`,
`date -f`, `file -C` and `sort --compress-program` were read-only by name. All are in the A51 table and now ask or are denied.
