# Round 7 triage

Round 7 (a fourth fresh-context agent, a **code** round on the job slice at `cffe31e`, the commit that carried the round-6 fixes) reported **14 findings**: 2 high, 7 medium, 5 low, all reproduced by running the real engine or the real CLI against
local servers (A126 at library level only). Dispositions as in rounds 1 to 6; every FIXED row has a section in the same tests that fails on the previous `src/` (checked for A114, A120 by the order the tests failed, and for the others by a
mutant that removes the fix), and the mutants are listed in IMP-037. Round 7 is the first round in which the high findings were both **structural** (a form number scoped to a document; the intent written after the first side effect) and not wording.

| id | severity | disposition | what changed, or is planned | test |
|---|---|---|---|---|
| A114 | high | FIXED | a plain-named button in a frame is never the submit button: it parks with a reason that names the frame (the form number only means something inside one document) | `test/job-apply.mjs` section 9 (`framebtn`: 0 posts to the frame's form) |
| A115 | medium | FIXED | the address test keeps the query that names a posting (`?gh_jid=222`) minus tracking parameters, and a `#/route`; the refusal names the matched row's company and title | `test/ledger.mjs` section 8 |
| A116 | medium | FIXED | `inspect` prints the HTTP status of the main document's latest navigation; 429, 403, 503 or 401 after the submit pauses the site and leaves the attempt unaccounted for | `test/job-apply.mjs` section 9 (`submit429`) |
| A117 | medium | FIXED | the company must be in the title or the first six lines of the page, not anywhere on it | `test/job-apply.mjs` section 9 (`alsohiring`, with the accepted control) |
| A118 | low | FIXED | an empty `--resume-site` is an error | `test/apply-cli.mjs` 3c |
| A119 | low | FIXED | `verifyAttempt` skips a paused platform or host, pauses on a 429/403/503/401 status, and the CLI loop gets both because it calls it for each row | `test/job-apply.mjs` section 9 (`polite429`: a 429 with a polite body; a paused platform is not visited) |
| A120 | high | FIXED (structural) | the intent is written **before** the first field is touched; a run that parks afterwards takes the row back (`retract`) only if the page did not move, and a navigation (or an error that looks like one) leaves the row and answers "unverified", never "nothing was sent" | `test/job-apply.mjs` section 9 (`uploadsubmit`: the second run is refused and the board counts 1); `test/ledger.mjs` section 9 |
| A121 | medium | FIXED | `aria-checked` and `aria-pressed` set the listing's checked flag | `test/job-apply.mjs` section 9 (`ariatick`) |
| A122 | medium | FIXED (the wording); SPEC (it is a list) | a work-authorisation or sponsorship question that also asks something else ("... and willing to undergo a background check", a second question) has no fact | `test/facts.mjs` section 2 |
| A123 | medium | FIXED | a value the page put in a number, slider or search box parks like one in a text box | `test/job-apply.mjs` section 9 (`numbers`) |
| A124 | low | FIXED | an earlier attempt with no confirmation exits 5, not 0; a cap hit inside `intend` is "capped" (6), not "duplicate" | `test/apply-cli.mjs` sections 3 and 3b; `test/ledger.mjs` section 9 |
| A125 | medium | FIXED | `verifyAttempt` confirms only on a page that names the posting's title | `test/job-apply.mjs` section 9 (`myapps`) |
| A126 | low | FIXED | the form-diff reason no longer prints the value the page left in a field | `test/job-apply.mjs` section 9 (`maxlen`) |
| A127 | low | FIXED | `scripts/run-suites.mjs` runs each suite in its own process group and kills the group on a timeout; an interrupt kills the group and removes `suite-tmp-*` | `test/run-suites.mjs` |

Not fixed and stated: a page that submits during the fill **and** answers with the same URL and title (a form shown again) looks, to the check that decides between "retract" and "unverified", like a page that did not move; the row is then
retracted although something was sent. The intent-first order narrows this to that case; the browser would need to report the non-GET requests a page made to close it (planned with the watchdog, S4).
