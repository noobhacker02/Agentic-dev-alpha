# Round 5 triage

Round 5 (a new fresh-context agent, a **code** round on the job slice at `3f27747`, the commit that carried the round-4 fixes) reported **17 findings**: 5 high, 7 medium, 5 low, all reproduced by running the real engine or the
real CLI against local servers. It confirmed that the round-4 fixes for A75, A66, A63 and the ledger rows hold, and found that the A68 decoy fix checked names only (A94). Dispositions as in rounds 1 to 4; every FIXED row has a section
in the same tests that fails on the previous `src/`, and the mutants of the new code are listed in IMP-034.

| id | severity | disposition | what changed, or is planned | test |
|---|---|---|---|---|
| A80 | high | FIXED | text on a page that says "you have already applied" is the page's word: on the application page it parks (it no longer decides "duplicate"), the phrase is the exact "you have already applied", and a row that `verify` confirmed only because a page said so can still be closed by the user with `--forget` | `test/job-apply.mjs` section 7 (`fakebadge`) |
| A81 | high | FIXED | an attestation phrase anywhere in the page's whole text parks the item (a box, a typed name or a click can be the signature); the whole text is read in sections (up to 48,000 characters, longer pages park) and the phrase lists see all of it, not the first 300 characters | `test/job-apply.mjs` section 7 (`signature`, `farattest`, `huge`) |
| A82 | high | FIXED | `open` reports the main document's HTTP status; 429, 403, 503 and 401 pause the site (written to the ledger), other 4xx and 5xx are an error | `test/job-apply.mjs` section 7 (`http429`, `http503`, `http403`: nothing is visited a second time) |
| A83 | medium | FIXED | a challenge by body text needs a short page with no form (under 400 characters, fewer than 3 fields); the title decides on its own only for 429/403 at the start or a few exact interstitial titles; "reCAPTCHA", "rate limiting", "Cloudflare" and "Req 429" in an ordinary posting are not one; a captcha *element* on a form parks (a step only a person can take) instead of pausing | `test/job-apply.mjs` section 7 (`softwords`, `captchaform`) |
| A84 | medium | FIXED | a listing that says it did not show all elements parks the item | `test/job-apply.mjs` section 7 (`many60`) |
| A85 | medium | FIXED | any element listed as ticked parks, whatever its role says and whether it is marked disabled | `test/job-apply.mjs` section 7 (`rolebtn`) |
| A86 | medium | FIXED (the seven ways reported) | the visibility guard also sees a zero font size, `aria-hidden`, a clip or clip-path, a parent that cuts the field off, a field a few pixels across and another element on top; a field it refuses is not filled. Other tricks may exist: the guard is a list | `test/job-apply.mjs` section 7 (`honey`: 7 hidden fields, the board receives 0 characters) |
| A87 | medium | FIXED | a yes/no fact is only the answer to a plain question addressed to "you": a question about a spouse, a partner, an employee or a sponsor's name has no fact | `test/facts.mjs` section 2; `test/job-apply.mjs` section 7 (`spouse`) |
| A88 | medium | FIXED | two fields that ask for the same fact (a reference block's "Name", "Email", "Phone" beside the applicant's own) park the item | `test/job-apply.mjs` section 7 (`refblock`) |
| A89 | medium | FIXED | the page must name the job: its title (or a segment of it, or one of the first lines) equals the job title once "Apply:", "at Company" and "- Company" are taken off; a longer title that contains it ("Senior Platform Engineer") or a similar-jobs list does not count | `test/job-apply.mjs` section 7 (job 5; `wrongjob,similar`) |
| A90 | low | FIXED | a row from the future is treated as written now and the clock is the real one (it was left a day ahead, which reopened the caps) | `test/ledger.mjs` section 7 |
| A91 | low | FIXED | any message that reaches a park reason has the user's fact values taken out | `test/job-apply.mjs` section 7 (a fill that fails with the phone and e-mail in its message) |
| A92 | low | FIXED | the unique index is gone (it had no 30-day window); the write transaction keeps two live rows apart, and a posting that `mayStart` allows after 31 days is not refused by `intend` | `test/ledger.mjs` section 7 |
| A93 | low | FIXED | a radio the page selected parks, like a ticked box | `test/job-apply.mjs` section 7 (`radiopre`) |
| A94 | high | FIXED | every element in the listing carries the form it belongs to (`form=N`); the planned fields, the résumé field and the submit button must all be in one form, and a button of another form is never clicked | `test/job-apply.mjs` section 7 (`realcustom`: the "Apply" decoy form receives 0 requests) |
| A95 | high | FIXED | a negated question ("able to work without visa sponsorship", "not authorized") is not a plain yes/no fact; it parks | `test/facts.mjs` section 2; `test/job-apply.mjs` section 7 (`negated`) |
| A96 | low | FIXED | a field named "Résumé" (accents folded) is the résumé field, and a second file field that could take it parks the item | `test/job-apply.mjs` section 7 (`accentcv`, `twocv`) |

Also from the report, not a numbered finding: a cookie banner over the submit button makes the click fail and leaves the `intended` row until the user closes it (`--forget`). That is the safe side and stays: the attempt is unaccounted for.
