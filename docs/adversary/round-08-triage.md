# Round 8 triage

Round 8 (a fifth fresh-context agent, a **code** round on `c55c81c`: the round-7 fixes and, for the first time, the reel flow stage 1) reported **21 findings**: 1 high, 11 medium, 9 low, all reproduced by running code. It confirmed that A114, A116, A119 (status), A120 (file input) and A121 to A126 hold. Dispositions as in earlier rounds; every FIXED row has a section in the same tests, and the mutants of the new code are listed in IMP-038. Seventeen of the 21 are in the reel code written the day before, which says what a flow written test-first by its author is worth until a stranger attacks it.

| id | severity | disposition | what changed, or is planned | test |
|---|---|---|---|---|
| A128 | medium | FIXED | `inspect` prints how many requests the tab made that can write (anything but GET, HEAD, OPTIONS); a change in that number counts as "the page moved", so a script's `fetch` during the fill is "unverified" with the row kept | `test/job-apply.mjs` section 9 (`fetchsubmit`) |
| A129 | medium | FIXED (inverted) | a work-authorisation or sponsorship label with any clause marker (`, ; & + /`, and, or, subject to, including, if, with ...) has no fact | `test/facts.mjs` section 2 |
| A130 | medium | FIXED | a `listbox` that arrives with a choice parks like a combobox | `test/job-apply.mjs` section 9 (`listboxpre`) |
| A131 | medium | FIXED | a native input, textarea or select keeps its own role when the page calls it a link, button or other non-field | `test/job-apply.mjs` section 9 (`roleinput`) |
| A132 | low | FIXED | the company must match on word boundaries (and be two letters or more) | `test/job-apply.mjs` section 9 ("Meta" vs "Metabase") |
| A133 | medium | FIXED (inverted) | the address keeps only parameters known to name a posting (an allow-list); host without `www.`, path lower-cased, decoded, `//` collapsed, `index.html` dropped; the stored address is 2000 characters | `test/ledger.mjs` section 10 |
| A134 | low | FIXED | one `stop` helper pauses label and host in `verifyAttempt` | `test/job-apply.mjs` section 9 |
| A135 | low | FIXED | 401, 403, 407, 420, 429, 451, 503, 509, 520 to 529 and 999 pause the site | `test/job-apply.mjs` section 9 (`http999`) |
| A136 | low | FIXED | SIGHUP ends the tree and cleans up; a `--timeout-min` that is not a positive number exits 2 | `test/run-suites.mjs` section 3 |
| A137 | high | FIXED (wider stems, normalised text); SPEC (it is a list) | the refusal list reads NFKC text without invisible characters, covers stolen/phish/spyware/DDoS/leaked/sidestep/work around/unlock/emails/watermark ... with a 120-character gap that may cross a full stop; a missing or non-numeric risk is the worst risk. A wording nobody listed can still pass: the list is a floor, and `refuse` is not the only gate (the user's yes) | `test/reel-read.mjs` section 2 (19 hostile ideas) |
| A138 | medium | FIXED | `instructions_to_an_ai_found` fails closed: any non-empty value that is not an empty list counts | `test/reel-read.mjs` section 1 |
| A139 | medium | FIXED | a citation counts only if it is at least 8 characters and a stretch of the project text; non-finite scores are the worst value (risk 5, others 0) | `test/reel-read.mjs` section 4 |
| A140 | medium | FIXED | `<<<` and `>>>` are neutralised inside a fenced body | `test/reel-e2e.mjs` (last section) |
| A141 | medium | FIXED | every reader field is one line (whitespace collapsed, invisible characters dropped) and so is every printed field | `test/reel-read.mjs` section 1; `test/reel-e2e.mjs` |
| A142 | low | FIXED (partly) | a quote needs 12 characters and a content word shared with its claim; with no frame text yet, no claim is "demonstrated". A claim's meaning is still not checked against its quote | `test/reel-read.mjs` section 1 |
| A143 | medium | FIXED | a file with more than one picture stream is refused; the decoder is told `-map 0:v:0` | `test/reel-intake.mjs` |
| A144 | medium | FIXED | only a plain media container (mov/mp4, matroska/webm, avi, gif, mpegts, flv, ogg) is read; playlists, concat lists and image sequences are refused | `test/reel-intake.mjs` |
| A145 | low | FIXED | frames live under `<home>/evidence/` (0700) and are removed after the read | `test/reel-e2e.mjs` |
| A146 | low | FIXED | the file key is a streaming hash of the whole file | `test/reel-e2e.mjs` |
| A147 | low | FIXED | only `/<kind>/<code>/` or `/<account>/<kind>/<code>/` from the start of the path; reserved words are not codes | `test/reel-intake.mjs` |
| A148 | low | FIXED | the agent-loop directory is created; a reader error is a result (exit 1), not a crash | `test/reel-e2e.mjs` |

Not fixed and stated: the A137 list is a floor; the model's own risk label is the second gate and the user's yes is the third. The single real-model sample in the report (a caption injection flagged and scored `skip`) is one sample, not a result.
