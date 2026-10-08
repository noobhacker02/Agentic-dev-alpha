# Adversary review, round 5

- Date: 2026-10-08
- Round: 5 (a code round on the job-apply slice after the round-4 fixes, IMP-033)
- Targets: `src/facts.ts`, `src/ledger.ts`, `src/job-apply.ts`, `src/apply-command.ts`, `required` and the 200-character labels in `src/browser-tools.ts`, `test/fixtures/job-board.mjs`, and the four suites. Commit `3f27747`.
- What I ran: a scratch worktree at `/tmp/r5-wt` (built, `node_modules` symlinked), Node with `--experimental-sqlite`, the real `applyToJob`, the real browser tool handlers (`__testHandlers`, `testPolicy`) in the real Chromium, against my own local HTTP servers on 127.0.0.1 (`/tmp/r5-scratch/h.mjs` builds one: it serves a page, counts the POSTs it accepted and prints what was in them). No real site was contacted.
- Triage: no `round-05-triage.md` yet.

## Findings table

| id | severity | status | title |
|---|---|---|---|
| A80 | high | CONFIRMED (run) | `verifyAttempt` marks a never-sent application as confirmed when the posting's own text says "already applied"; the same test makes `apply` report a false duplicate |
| A81 | high | CONFIRMED (run) | a legal attestation is made for the user when it is signed by typing a name: the engine fills "Legal name" / "Your name" under "I certify ... under penalty of perjury" |
| A82 | high | CONFIRMED (run) | an HTTP 429 or 503 on the application page is not a rate limit to the engine: it parks (exit 3) and the next call hits the site again |
| A83 | medium | CONFIRMED (run) | `challenged()` pauses the whole platform on ordinary posting text: "reCAPTCHA", "rate limiting", "Cloudflare", "just a moment", "Req 429" in a title |
| A84 | medium | CONFIRMED (run) | the 60-element cap of `inspect` is invisible to the engine: a pre-ticked attestation checkbox after the 60th element is submitted |
| A85 | medium | CONFIRMED (run) | the page decides which controls the checks see: `role="button"` or `aria-disabled="true"` on a pre-ticked attestation box and it is submitted |
| A86 | medium | CONFIRMED (run) | honeypots hidden with ordinary CSS are listed and filled (`height:0;overflow:hidden`, `clip`, `clip-path`, `max-height:0`, a 2px box, `z-index:-1`, `font-size:0`, `aria-hidden`) |
| A87 | medium | CONFIRMED (run) | the unanchored fact rules fill statements about other people: "Is your spouse legally authorized to work ..." gets the applicant's `Yes`, "Sponsor name (employee who referred you)" gets `No` |
| A88 | medium | CONFIRMED (run) | a reference or emergency-contact block with bare "Name / Email / Phone" labels is filled with the applicant's own details |
| A89 | medium | CONFIRMED (run) | the posting check accepts a different job whose title contains the posting's title ("Senior Platform Engineer" for "Platform Engineer") |
| A90 | low | CONFIRMED (run) | `Ledger.repair()` moves the clock one day forward for a day: a single forward glitch re-opens the daily and hourly caps |
| A91 | low | CONFIRMED (run) | a park reason prints a fact value on stdout: a phone field with an input mask makes the engine print the user's phone number |
| A92 | low | CONFIRMED (run) | the unique index has no 30-day window: `mayStart` says yes after 31 days, the form is filled, and `intend` then refuses for ever |
| A93 | low | CONFIRMED (run) | a pre-selected radio button is sent as the page's answer: "Do you consent to us sharing your data with partners? Yes" (checked by default) |
| A94 | high | CONFIRMED (run) | the click goes to any button named "Apply" or "Submit application" anywhere on the page, not the submit button of the form that was filled: a "similar jobs" form is sent and the posting is recorded as |
| A95 | high | CONFIRMED (run) | negated or inverted work-authorisation and sponsorship questions get the fact's literal value, so the opposite answer is sent ("Are you able to work without visa sponsorship?" gets `No`) |
| A96 | low | CONFIRMED (run) | the commonest spelling "Résumé" is not recognised as the résumé field, and a later file field mentioning "CV" takes the résumé from the real one |
<!-- table-end -->

## Findings

<!-- findings-start -->

### A80 (high) `verifyAttempt` marks a never-sent application as confirmed when the posting's own text says "already applied"; the same test makes `apply` report a false duplicate

- **Status:** CONFIRMED (run)
- **Claim attacked:** A62/A63 FIXED: "a confirmation is words that were not on the page before the click"; "`verifyAttempt` returns `confirmed` or `unknown`". IMP-033: only a real confirmation closes a row as confirmed.
- **Where:** `src/job-apply.ts` `verifyAttempt`: `if (ALREADY_APPLIED.test(visible(page))) { ledger.confirm(row.seq, "verified on the site"); return "confirmed"; }`, with `ALREADY_APPLIED = /you have already applied|already applied|application submitted on/i`, tested on the whole visible text of the posting page. Round 4 fixed the `apply` path (A63) with a before/after comparison; the verify path has no before state and no check that the phrase is the posting's own status badge.
- **Reproduction (run, `/tmp/r5-scratch/b4.mjs`):** a row is written with `intend` (a crash before the click: nothing was sent), the posting page is an ordinary job description containing "Candidates who have already applied in the last 6 months do not need to reapply." and an "Apply now" link:
  ```
  verify -> confirmed row state confirmed posts 0
  ```
  The server received 0 applications; the ledger now says `confirmed`, the 30-day duplicate rule blocks every retry ("already applied to this posting"), and `agent-loop apply --verify` prints "the site shows it was received (now confirmed)" with exit code 0. `--forget` cannot undo it (it closes only `intended` rows). The `apply` side has the same root cause with a safe direction: a job description with "If you have already applied to us in the past 90 days, please do not apply again" gives `{"status":"duplicate","why":"the site shows that you already applied"}` and 0 requests, exit 0, "Not applied" (a posting is silently skipped).
- **Impact:** a lost application is recorded as sent, the user is told it worked, and the retry is blocked for 30 days with no tool to reopen a `confirmed` row. Any posting whose text contains the phrase triggers it, no hostile page needed ("Application submitted on [date]" is in many help texts).
- **Suggested fix:** in `verifyAttempt` require an affirmative, posting-specific signal (the posting's title next to the badge, or a badge element rather than free text) and otherwise `unknown`; give `--forget` a way to reopen a `confirmed` row with an explicit flag; in `apply` apply the same restriction to `ALREADY_APPLIED`.

### A81 (high) a legal attestation is made for the user when it is signed by typing a name: the engine fills "Legal name" / "Your name" under "I certify ... under penalty of perjury"

- **Status:** CONFIRMED (run)
- **Claim attacked:** A67 FIXED (the visible cases): "an attestation phrase ... in the page's visible text next to any checkbox parks"; spec: only the user makes a legal attestation.
- **Where:** `src/job-apply.ts`: `if (attestationIn(visible(page)) && fields.some((e) => e.role === "checkbox"))`. The attestation is only looked for when the page also has a checkbox, and only for the words "I certify / I attest / I declare / under penalty of perjury", and only in the first 3000 characters of the page (`inspect` cuts the body text at 3000). A typed signature is a text box labelled with the applicant's own name, which the `full_name` rule fills.
- **Reproduction (run, `/tmp/r5-scratch/b2.mjs`, `b3.mjs`, `b1.mjs`):** three pages, each with a résumé field and an email/name field, no checkbox:
  1. `<p>I certify that the information above is true and complete. Type your legal name to sign this application under penalty of perjury.</p><label>Legal name *</label><input name=sig required>`
  2. the wording "By entering my name below I confirm that all statements are accurate and I accept responsibility." and a field "Your name *".
  3. a 3,500-character job description, then the sentence of case 1 and a checkbox "Confirm" (not required), a text box "Legal name *".
  ```
  signature certify  {"status":"submitted","seq":1} posts: 1   POST name=Ada+Lovelace&email=ada@example.com&cv=resume.pdf&sig=Ada+Lovelace
  sig2               {"status":"submitted","seq":1} posts: 1   POST ...&sig=Ada+Lovelace
  long JD attestation text  {"status":"submitted","seq":1} posts: 1   POST ...&sig=Ada+Lovelace
  ```
  (With a second field of the *same* label, "Full name", the run parked only by accident: the duplicate-label diff. A signature labelled "Legal name" or "Your name" is not caught.)
- **Impact:** the engine types the user's name as the signature under a perjury statement, which is exactly "a legal attestation made for the user". Real boards put the e-signature block at the bottom of a long page.
- **Suggested fix:** park when the visible text (the whole page, not the first 3000 characters; read it in chunks) carries any attestation wording (add "confirm that", "I acknowledge", "I agree", "accurate", "sign", "signature", "electronic") **and** a text box is labelled with a name or a signature, not only a checkbox; treat a second name field as a signature unless the label says first/last; park a page whose text is longer than the cap.

### A82 (high) an HTTP 429 or 503 on the application page is not a rate limit to the engine: it parks (exit 3) and the next call hits the site again

- **Status:** CONFIRMED (run)
- **Claim attacked:** A72 FIXED (the list): "a bare `429` counts only in the title"; threat B11: stop at once on a rate limit, never retry.
- **Where:** `src/job-apply.ts` `challenged()` judges the title and the visible text only. The status of the document is in the `open` result ("[Page notices ...] t1 http: 429 GET host/a (document)") and the engine throws it away (`opened.isError` is false for a 429).
- **Reproduction (run, `/tmp/r5-scratch/b6.mjs`, `b7.mjs`):** a local server answers every request with status 429 and `Retry-After: 3600`, body `<title>Platform Engineer</title><p>Slow down.</p>`; the same with 503 and 403:
  ```
  open -> "Opened http://127.0.0.1:38575/a in t1. Title: Platform Engineer\n\n[Page notices ...]\n- t1 http: 429 GET 127.0.0.1:38575/a (document)"
  429 {"status":"parked","reasons":["the form has no résumé field the flow can use","the page has no plain submit button the flow can find"],"scam":false} paused: undefined
  503 ... parked ... paused: undefined
  403 ... parked ... paused: undefined
  ```
  The CLI prints "Needs you" and exits 3, which a driver script reads as "ask the user", not "stop hitting this site"; nothing is written to the ledger, so the next job on the same platform opens it again.
- **Impact:** a site that said "slow down" with the only signal HTTP has for it is hammered by a batch run. This is the "site hammered after a challenge" harm. Round 4's list work cannot cover a challenge or rate-limit page that says nothing the list knows.
- **Suggested fix:** parse the `http: <status> ... (document)` notice from `open` and `inspect`; 429 and 503 (and 403 on the document) pause the site and, on 429, honour `Retry-After` if present. Treat "an application page with no form at all" as a reason to count a failure for the site and pause it after N in a row.

### A83 (medium) `challenged()` pauses the whole platform on ordinary posting text: "reCAPTCHA", "rate limiting", "Cloudflare", "just a moment", "Req 429" in a title

- **Status:** CONFIRMED (run)
- **Claim attacked:** A72 FIXED: the challenge list "covers more wording"; a bare `429` "counts only in the title"; the pause "survives the process" and lasts until `--resume-site`.
- **Where:** `src/job-apply.ts` `CHALLENGE` (a plain substring list on the title and the first 3000 characters of the visible text) and `CHALLENGE_TITLE = /\b429\b|.../`; `pauseSite` writes the pause to the ledger, keyed by the user's `--site`.
- **Reproduction (run, `/tmp/r5-scratch/b5.mjs`):** one ordinary form page (it would have been submitted) with one added sentence or title:
  ```
  recaptcha          paused-site  ("This site is protected by reCAPTCHA and the Google Privacy Policy applies.")
  req429             paused-site  (<title>Platform Engineer (Req 429)</title>)
  justmoment         paused-site  ("It will take just a moment of your time to apply.")
  security           paused-site  ("You will run our security check pipeline.")
  cloudflare_company paused-site  ("Cloudflare is hiring.")
  ok                 submitted
  ```
  Also paused (`b18.mjs`): "You will implement rate limiting for our APIs.", "We detect unusual activity with ML.", "Access denied is a status you will handle.", "Experience with automated requests tooling". Each wrote a row to `site_pauses` for `board`, and every later `apply` on that platform answers "paused" (exit 4) until `--resume-site board`. "rate limiting" in a job description (an SRE posting) matches `rate limit` too.
- **Impact:** a denial of service on the user's own job search by any employer on the platform whose posting contains one of these phrases (innocently or on purpose); a "protected by reCAPTCHA" footer is on many boards, so the feature may pause the very sites it is meant to work on. The pause is not tied to the page: one bad posting pauses all of the user's applications on the platform. (The page cannot pause a *different* platform: the site key is the user's `--site`.)
- **Suggested fix:** judge a challenge on the title and the first lines only, plus the absence of a form; do not match words that appear in job text (`captcha` alone, `rate limit`, `cloudflare`, `just a moment`, `security check`); a pause that has fired on a page that also has a résumé field and a submit button is a false positive: park the item instead.

### A84 (medium) the 60-element cap of `inspect` is invisible to the engine: a pre-ticked attestation checkbox after the 60th element is submitted

- **Status:** CONFIRMED (run)
- **Claim attacked:** A66 FIXED: "a box that arrives already ticked parks before anything is touched"; the post-fill diff "covers every field".
- **Where:** `src/browser-tools.ts` `MAX_REFS_PER_SNAPSHOT = 60` and the text "(N more elements not shown ...)"; `src/job-apply.ts` never reads that note, so the field list it plans and diffs is the first 60 interactive elements (links count, so a page with a nav bar and a footer is easily over it).
- **Reproduction (run, `/tmp/r5-scratch/b3.mjs`):** the form (name, email, résumé, submit) first, then a footer of 70 links, then `<input type=checkbox checked form=f name=certify aria-label="Certify">` (the `form` attribute ties it to the form):
  ```
  checked attestation past 60 elements {"status":"submitted","seq":1} posts: 1
     POST name=Ada+Lovelace&email=ada@example.com&cv=resume.pdf&certify=on
  ```
  The control (the same box with only 20 links before it, `b10.mjs`) parks: `"Certify" came already checked`, 0 POSTs. The same blind spot hides a required forbidden field or a required demographic field: the engine submits a partial form and records a confirmation if the server says thanks.
- **Impact:** the attestation the page ticked is sent with the application, which A66 claimed to close.
- **Suggested fix:** park when `inspect` says elements were not shown (`more elements not shown`, `the list stops at 60`), or read the page with `query`/selectors until every element is seen; also count `form=` ties.

### A85 (medium) the page decides which controls the checks see: `role="button"` or `aria-disabled="true"` on a pre-ticked attestation box and it is submitted

- **Status:** CONFIRMED (run)
- **Claim attacked:** A66/A67/A75 FIXED: pre-ticked boxes and unplanned fields park; the parser can no longer be tricked by the page's own text.
- **Where:** `src/job-apply.ts` `pageFields` (`e.role !== "button" && e.role !== "link"`) and the checks keyed on `f.role === "checkbox"`. `describeElementInPage` returns `el.getAttribute("role") || implicit`, so the page chooses the role the engine sees.
- **Reproduction (run, `/tmp/r5-scratch/b8.mjs`):**
  ```
  control: <label><input type=checkbox checked name=cert> I certify ...        -> parked (attestation; came already checked)
  role=switch checked                                                         -> parked (attestation, by luck: the label matched)
  <p>I certify under penalty of perjury ...</p><input type=checkbox checked role=button name=cert aria-label='Agree'>
                                                                              -> {"status":"submitted"} POST ...&cert=on
  <input role=link name=ref value=PAGE aria-label='Referral'>                 -> submitted, POST ...&ref=PAGE
  ```
  The same with `aria-disabled` (`/tmp/r5-scratch/b14.mjs`): `<label><input type=checkbox checked aria-disabled=true name=cert> I certify that all of this is true</label>` -> `{"status":"submitted"}`, `POST ...&cert=on` (the tool reports `aria-disabled="true"` as `disabled`, the engine drops disabled elements, the browser still submits the control).
  The role-spoofed box is neither a field (so no "came already checked"), nor a checkbox (so the attestation text next to a checkbox does not apply), nor in the diff.
- **Impact:** every protection that keys on the role is one attribute away from not applying. A hostile or merely unusual page sends a ticked attestation or a page-filled value.
- **Suggested fix:** classify by the element's tag/type (the tools can report `type=checkbox`), not by the page-controlled `role`; or treat any element with `checked`/`value` state as a field whatever its role; park when an element has a role that disagrees with its tag.

### A86 (medium) honeypots hidden with ordinary CSS are listed and filled (`height:0;overflow:hidden`, `clip`, `clip-path`, `max-height:0`, a 2px box, `z-index:-1`, `font-size:0`, `aria-hidden`)

- **Status:** CONFIRMED (run)
- **Claim attacked:** the tool text for hidden fields ("Not visible to a person, so not listed ... a bot that fills it is a bot") and the S5 claim that a field a person cannot see is not filled.
- **Where:** `src/browser-tools.ts` `HUMAN_PROBLEM_SRC` (opacity 0, a box of 1px or less, a position outside the document) is the whole definition; `src/job-apply.ts` fills any listed field whose label matches a fact.
- **Reproduction (run, `/tmp/r5-scratch/b2.mjs`):** a form with a honeypot `<div style="STYLE"><label for=w>Website</label><input id=w name=hp></div>` and the fact `website` set; "filled-honeypot" is whether the POST carried the website value:
  ```
  displaynone false   visibilityhidden false   opacity0 false   offscreen false   scale0 false
  h0 (height:0;overflow:hidden) true      size2 (2px box) true       clip (clip:rect(0,0,0,0);1px) true
  clippath (clip-path:inset(100%)) true   maxh0 (max-height:0;overflow:hidden) true
  behind (position:absolute;z-index:-1) true     pointer (opacity:.01;pointer-events:none) true
  zeroW (width:0;overflow:hidden) true   fontsize0 true    aria (aria-hidden=true tabindex=-1, visible) true
  ```
  All of them still get `status: submitted`.
- **Impact:** the application carries a value in the field that exists to catch bots; a board that checks the honeypot rejects or silently drops it, and the ledger records a confirmation or an unverified attempt. Filling it also identifies the traffic as automated (the thing the module promises not to do).
- **Suggested fix:** list a field only if it has a non-zero box in the viewport after clipping by ancestors (`getBoundingClientRect` intersected with every ancestor's `overflow`/`clip`/`clip-path`/`max-height`), is not covered by another element at its centre, and has no `aria-hidden` ancestor; park (not skip) a form that has a field the engine could not classify as visible.

### A87 (medium) the unanchored fact rules fill statements about other people: "Is your spouse legally authorized to work ..." gets the applicant's `Yes`, "Sponsor name (employee who referred you)" gets `No`

- **Status:** CONFIRMED (run)
- **Claim attacked:** A65 FIXED: "the fact rules are anchored ... are not the applicant's own".
- **Where:** `src/facts.ts` `RULES`: `needs_sponsorship: /sponsor/` and `work_authorisation: /authori[sz]ed to work|legally (authori[sz]ed|eligible)|right to work|eligible to work|work authori[sz]ation/` are the two rules A65 left unanchored; only the combined question was handled.
- **Reproduction (run, `/tmp/r5-scratch/b1.mjs`):**
  ```
  spouse        label "Is your spouse legally authorized to work in this country? *" (select Yes/No)
                -> submitted   POST ...&s=Yes
  sponsor name  label "Sponsor name (employee who referred you)" (text, optional)
                -> submitted   POST ...&s=No
  ```
- **Impact:** a false statement about a third party goes out under the user's name, and a free-text field gets the word "No". Variants: "Does your employer sponsor ...", "Are you able to sponsor others", "Has your referrer sponsored", "Is a family member authorized to work".
- **Suggested fix:** anchor both rules to second-person own-subject questions ("Do you / Will you ... require sponsorship", "Are you authorized ...") and refuse a label that names someone else (spouse, partner, family, manager, reference, employer, referrer); never fill a free-text box from a yes/no fact.

### A88 (medium) a reference or emergency-contact block with bare "Name / Email / Phone" labels is filled with the applicant's own details

- **Status:** CONFIRMED (run)
- **Claim attacked:** A65 FIXED (`Reference email`, `Manager's phone` are not the applicant's own): the fix works on the label text only, but a block's meaning is in its `<legend>`/heading, which the engine never sees.
- **Where:** `src/facts.ts` `full_name: /^(full |legal |your )?name$/`, `email`, `phone` match the bare words; `src/job-apply.ts` plans each field from its own accessible name.
- **Reproduction (run, `/tmp/r5-scratch/b1.mjs`):** `<fieldset><legend>Professional reference</legend>` with "Name *", "Email address *", "Phone *" next to the applicant's "Full name" and "Email":
  ```
  reference {"status":"submitted","seq":1}  POST name=Ada+Lovelace&email=ada@example.com&cv=resume.pdf&rn=Ada+Lovelace&rm=ada@example.com&rp=+44+20+7946+0000
  ```
  (A reference with the same label as the applicant's own field, "Email" twice, parks only because of the duplicate-label diff.)
- **Impact:** the applicant lists themselves as their own reference, with their own phone and email, on a real application (a value typed into the wrong field, and a worse application than none).
- **Suggested fix:** include the field's `fieldset` legend / `aria-labelledby` group / nearest heading in the question; park a required field whose group name is not the applicant's own contact block; park any form that has a field whose label equals another field's label or a label that is a bare "Name".

### A89 (medium) the posting check accepts a different job whose title contains the posting's title ("Senior Platform Engineer" for "Platform Engineer")

- **Status:** CONFIRMED (run)
- **Claim attacked:** A76 FIXED: "the posting's title must be on the page it opened; otherwise the item parks".
- **Where:** `src/job-apply.ts`: `if (!plain(text).includes(plain(d.job.title)))`, a substring test on the title and 3000 characters of the page, where any link text, "similar jobs" list or breadcrumb counts.
- **Reproduction (run, `/tmp/r5-scratch/b1.mjs`):** the apply page is titled and headed "Senior Platform Engineer" while the job is "Platform Engineer":
  ```
  senior title {"status":"submitted","seq":1} posts: 1   POST name=Ada+Lovelace&email=ada@example.com&cv=resume.pdf
  ```
  Two more runs (`/tmp/r5-scratch/b10.mjs`): a page titled and headed "Janitor" whose "Similar jobs" list holds "Platform Engineer", for the job "Platform Engineer" -> `submitted`, 1 POST; the job "Engineer" against a page "Engineering Manager" -> `submitted`, 1 POST (a substring of a word).
- **Impact:** a real application is sent for a different (often more senior, or a different level) job than the ledger row says, and the ledger then records the wrong job as applied; a link swap that A76 was meant to catch passes.
- **Suggested fix:** compare the page's heading or `<title>` to the title as whole phrases (equality after normalisation, or the title between delimiters such as " - ", " at ", " | "), require the company too, and compare the job id if the URL carries it.

### A90 (low) `Ledger.repair()` moves the clock one day forward for a day: a single forward glitch re-opens the daily and hourly caps

- **Status:** CONFIRMED (run)
- **Claim attacked:** A73 FIXED: "rows stamped more than a day ahead of the clock are pulled back once, so a single forward jump ages out"; the header of `ledger.ts`: a stepped clock cannot open a second batch.
- **Where:** `src/ledger.ts` `repair()` sets `this.floor = Math.min(this.floor, limit)` where `limit = clock + MAX_LEAD_MS`, then `now()` returns `max(floor, real)`, so `now()` is `real + 1 day` while the repaired rows sit exactly at `real + 1 day`. Every window then starts a day too late: `at >= now - DAY` becomes `at >= real`, and the rows of the last 24 hours stop counting.
- **Reproduction (run, `/tmp/r5-scratch/l1.mjs`):** caps perDay 5, perHour 3. Five applications are made in five minutes; then one row is written by a process whose clock was 3 days ahead; the clock is back to normal one hour later:
  ```
  5 applied within minutes; next: {"ok":false,"why":"the daily cap of 5 is reached","waitMs":86160000}
  1h later, normal clock, next: {"ok":true}
  control without glitch row: {"ok":false,"why":"the daily cap of 5 is reached","waitMs":82560000}
  ```
  The next application is allowed one hour after five (cap 5 per day), and so on until the repaired row's window passes.
- **Impact:** the caps exist to keep the user from being banned; one clock error (a VM resume, a hostile or wrong time source) doubles the batch. The fix for "frozen for ever" over-corrected into "caps open".
- **Suggested fix:** after repair keep `now()` at the real clock (do not let `floor` rise to `limit`), clamp the repaired rows to `real` rather than `real + 1 day`, and keep counting the rows of the last 24 hours by their original order; or refuse to start (park) and tell the user when the ledger holds a future row.

### A91 (low) a park reason prints a fact value on stdout: a phone field with an input mask makes the engine print the user's phone number

- **Status:** CONFIRMED (run)
- **Claim attacked:** the standing rule "facts must never be printed or stored" and the A79 note that the ledger holds labels only.
- **Where:** `src/job-apply.ts` post-fill diff: `"${p.label}" holds "${(e.value ?? "").slice(0, 40)}" and not what was filled`; `src/apply-command.ts` prints each reason.
- **Reproduction (run, `/tmp/r5-scratch/c1.mjs`, real CLI process):** the facts file has `phone: "+44 20 7946 0000"`; the page strips non-digits on input:
  ```
  code 3  out: 'Needs you: Acme, Platform Engineer. Nothing was sent.\n  - "Phone *" holds "442079460000" and not what was filled\n'
  ```
  The value the page holds (the user's phone, reformatted) is printed; an email field, a name or any fact the page reformats is printed the same way up to 40 characters. The ledger and the artifact temp directory held no fact (checked with `grep -r`), so the leak is stdout only.
  A second path, with no hostile page at all (`/tmp/r5-scratch/c4.mjs`): a form with a "Preferred contact method" radio group labelled "Email" / "Phone". The `email` rule plans a `fill` of a radio, Playwright refuses, and `could not be filled: ${textOf(r).slice(0, 120)}` carries the call log:
  ```
  code 3  out: 'Needs you: Acme, Platform Engineer. Nothing was sent.\n  - "Email" could not be filled: Error: elementHandle.fill: Error: Input of type "radio" cannot be filled?Call log:?[2m    - fill("ada@example.com")[22\n'
  ```
  The user's email is on stdout verbatim (and the same for a checkbox group). The flow also cannot apply to any form with such a group.
- **Impact:** low (the user's own terminal), but a batch driver that logs stdout stores it, and an input mask (very common on phone fields) also parks the item every time: the flow cannot apply to such a board.
- **Suggested fix:** never put a tool error text into a reason without replacing the fact values in it (the engine knows them); do not plan a fill for a radio or checkbox (park or skip by role); print only "holds a different value" and its length; compare digit-only for phone and e-mail case-insensitively before parking.

### A92 (low) the unique index has no 30-day window: `mayStart` says yes after 31 days, the form is filled, and `intend` then refuses for ever

- **Status:** CONFIRMED (run)
- **Claim attacked:** A69 FIXED (unique index) against the spec's 30-day duplicate rule.
- **Where:** `src/ledger.ts`: the index `applications_live_key ON applications(key) WHERE state IN ('intended','confirmed')` has no `at` condition while `duplicate()` ignores rows older than `THIRTY_DAYS`.
- **Reproduction (run, `/tmp/r5-scratch/b4.mjs`):**
  ```
  mayStart after 31d: {"ok":true}
  intend after 31d: {"ok":false,"why":"posting already has a live row"}
  ```
- **Impact:** a posting applied to once can never be applied to again (a repost under the same job id), after the browser has opened the page, uploaded the résumé and filled the form; nothing is sent, so no duplicate, but the documented 30-day rule and the tools disagree, and there is no way to reopen a confirmed row.
- **Suggested fix:** make `fail`/an "expire" step close rows older than 30 days (state `expired`), or drop the time window from `duplicate()` and say so in the spec.

### A93 (low) a pre-selected radio button is sent as the page's answer: "Do you consent to us sharing your data with partners? Yes" (checked by default)

- **Status:** CONFIRMED (run)
- **Claim attacked:** A66 FIXED: "a box that arrives already ticked parks"; the diff "covers every field".
- **Where:** `src/job-apply.ts`: the "came already checked" park is `f.role === "checkbox" && f.checked === true`; radios are never looked at unless they change.
- **Reproduction (run, `/tmp/r5-scratch/b3.mjs`):** `<legend>Do you consent to us sharing your data with partners?</legend><input type=radio name=v value=y checked> Yes ...`:
  ```
  radio prechecked {"status":"submitted","seq":1}  POST ...&v=y
  ```
  A required radio group (legend "Do you need a visa? *", options "Yes"/"No") parks, but with the reason `"Yes" is required and no fact answers it` (the label is the option, not the question).
- **Impact:** consent defaults given by the page go out under the user's name; same class as A66, left out for radios.
- **Suggested fix:** treat a checked radio like a checked checkbox (park unless the question is a fact) and read the group's legend as the question.

### A94 (high) the click goes to any button named "Apply" or "Submit application" anywhere on the page, not the submit button of the form that was filled: a "similar jobs" form is sent and the posting is recorded as confirmed

- **Status:** CONFIRMED (run)
- **Claim attacked:** A68 FIXED: "the submit button must be the only button whose whole name is one of a few plain phrases"; the `decoy` test ("the decoy form receives 0 requests").
- **Where:** `src/job-apply.ts`: `submits = all.filter((e) => e.role === "button" && SUBMIT_NAME.test(...))` over the whole page, then `click` of `submit[0]`. Nothing ties the button to the form that holds the filled fields (its `form` owner), and the real button may have a name that is not on the list. The round-4 decoy in the fake board uses names that are not on the list ("Send me job alerts", "Submit and apply to 50 similar jobs"), so the test could not see this.
- **Reproduction (run, `/tmp/r5-scratch/b11.mjs`):** the posting's form (name, email, résumé, button "Submit your application") and below it a "Similar jobs" block, `<form action=/similar-job-99><input type=hidden name=job value=99>Data Entry Clerk <button type=submit>Apply</button></form>`:
  ```
  {"status":"submitted","seq":1} POSTs: [ '/similar-job-99' ] [ 'confirmed' ]
  ```
  The only request the server got was the one-click apply for job 99; the filled form never left; the ledger says the target posting is `confirmed` (the "Application received" page of the other form satisfied the confirmation test). The same with a form whose only button is "Submit application" and that holds none of the filled fields: `button of another form: submitted [ '/other' ]`.
- **Impact:** an application the user never chose is sent to a different job (with whatever the one-click form carries: a profile, a saved résumé), the wanted job is recorded as applied and blocked for 30 days. This is the duplicate/unwanted-application harm the ledger is there to stop, produced by the engine itself on an ordinary page with a "similar jobs" widget.
- **Suggested fix:** resolve the submit button through the filled fields' own form (`input.form` -> its submit controls) and require the button to be inside it; count every `Apply`/`Submit` button on the page (any name on the list, any form) and park when there is more than one; after the click compare the answer page with the posting (its title or job id).

### A95 (high) negated or inverted work-authorisation and sponsorship questions get the fact's literal value, so the opposite answer is sent ("Are you able to work without visa sponsorship?" gets `No`)

- **Status:** CONFIRMED (run)
- **Claim attacked:** A65 FIXED: "one question that asks two things has no single fact"; spec "Facts and form answers": a fact answers a question only when the question is the fact.
- **Where:** `src/facts.ts` `needs_sponsorship: /sponsor/` and `work_authorisation: /authori[sz]ed to work|.../` (unanchored, polarity-blind): the fact `needs_sponsorship: "No"` is copied into any Yes/No question that contains the word. `classifyQuestion` only looks for a second topic, not at the sense of the question.
- **Reproduction (run, `/tmp/r5-scratch/b13.mjs`):** facts `work_authorisation: Yes`, `needs_sponsorship: No`; a required Yes/No select per label; the answer the server received:
  ```
  Are you able to work without visa sponsorship? *                 -> submitted, s=No   (true answer: Yes)
  I do not require sponsorship *                                   -> submitted, s=No   (true answer: Yes)
  Can you start without needing sponsorship? *                     -> submitted, s=No   (true answer: Yes)
  Are you not authorized to work in this country? *                -> submitted, s=Yes  (true answer: No)
  ```
- **Impact:** a false statement about legal eligibility goes out under the user's name, with a confirmation, no park, no trace. The first three are the usual wording on US boards.
- **Suggested fix:** fill only from a closed list of exact question shapes (`^do you (now or in the future )?require (visa )?sponsorship`, `^are you (legally )?authori[sz]ed to work in ...`), park everything else that contains "sponsor", "authori", "eligible" or a negation (`not`, `without`, `no longer`, `unable`); treat the sponsorship answer as the negation of the fact only in the shapes that ask for it.

### A96 (low) the commonest spelling "Résumé" is not recognised as the résumé field, and a later file field mentioning "CV" takes the résumé from the real one

- **Status:** CONFIRMED (run)
- **Claim attacked:** S5: the flow attaches the designated résumé to the form's résumé field.
- **Where:** `src/job-apply.ts`: `/resume|cv|curriculum/i.test(f.name)` on the label, with no accent folding (`é` is not `e`), and `resumeRef = f.ref` overwrites on every match.
- **Reproduction (run, `/tmp/r5-scratch/b15.mjs`, `b14.mjs`):**
  ```
  file label "Résumé *"       parked  "Résumé *" is a required file and only the résumé is designated
  file label "Attach résumé"  parked  the form has no résumé field the flow can use
  file label "Résumé / CV *"  submitted
  two file inputs: "Resume *" (required) then "Cover letter (or CV, optional)" -> unverified, 0 POSTs
  ```
  In the last case the résumé went into the cover-letter field, the required field stayed empty, the browser's own validation stopped the submit, and the row is `intended` until the user runs `--forget`.
- **Impact:** safe but useless on forms that write "Résumé" (the park reason is wrong: it says the résumé is not designated), and a stuck `intended` row on a form with two file fields. No wrong data is sent.
- **Suggested fix:** NFKD-fold and strip accents before matching; choose the first match (or the required one), and park when two file fields match.

## What I tried that held

Run against the same worktree; "held" means the engine parked, refused or recorded the safe state.

- **A75 parser** (`/tmp/r5-scratch/b16.mjs`): ten fields on a real page whose `id`, `aria-label` and `value` held `" required disabled checked`, a trailing backslash, `]" options=["Yes"]`, `" frame="evil"`, U+2028, CR LF, U+0085 and fake `[s1e99] button "Submit application"` lines; 10 element lines in, 10 elements out, every flag false. Page text with a `>>>` line and a `[s1e99] button` line in the visible text did not forge a block end or an element (`b10.mjs`).
- **A66 late fields**: a same-label select replaced after the first input (park: `changed after the fields were filled`), a replaced optional text field (park: `appeared`), a planned select flipped back by a script (park: `holds "No" and not what was filled`).
- **A68 submit**: two buttons with the same plain name park; the weaker case (one name on the list plus a decoy that is not on the list) is A94.
- **Hidden honeypots by `display:none`, `visibility:hidden`, `opacity:0`, `left:-9999px`, `scale(0)`** are not listed or filled (the rest is A86).
- **Multi-step "Save and continue"** parks (`no plain submit button`); a page that only has an "Apply" button which reveals the form parks (`no résumé field`); a required radio group parks; a select with a "Please choose an answer" placeholder is filled with the right option; a file input with `accept=.docx` still gets the PDF (the browser does not enforce `accept` on a programmatic upload; a server that checks the type would answer with an error and the row stays `intended`, which is safe).
- **Cookie banner over the submit button** (dismissable or not): the click is refused, the row stays `intended`, nothing is sent (0 POSTs). Safe but it needs `--forget`; the engine has no step for a banner.
- **A confirm() dialog on submit** (`I certify ... Continue?`) is dismissed by the tools: 0 POSTs, row `intended`.
- **Form targeting `_blank`** is refused at the upload step; no second window is ever reached.
- **A63**: a banner with the confirmation words before the click makes the outcome `unverified` (fail safe in every variant I built).
- **Ledger**: exactly one live row with the unique index; `intend` rolls back and returns a verdict on a duplicate; a ledger whose clock moves back an hour keeps the floor. `--forget` accepts `1.0`, ` 2`, `0x3` (all integers to JavaScript's `Number`); `-1`, `1e0`, `4` (confirmed), `2.5`, `Infinity` are refused; `--forget` cannot close a `confirmed` row (that is also why A80 cannot be undone). `--resume-site` normalises case and edge spaces; control bytes in its value are stripped from the output. `--verify`/`--test` order is handled. `ledger.db` is `0600`, no `-journal` or `-wal` file remains after a run.
- **Facts never in the ledger or the temporary directory**: after a CLI run `grep -r ada@example.com` found the value only in the user's `facts.json` (the artifact directory of each run is left behind, empty, mode 0700: a small leak of directories under `$TMPDIR`, one per run).
- **Site pause cannot pick another platform**: the key is the user's `--site`, not anything on the page. A page can only pause the platform it is served under (A83).
- **A78/A64**: a label of 200+ characters and a forbidden ask in the visible text still park.
- **Known and stated in round 4 (A67, left open), not re-reported**: a CSS-hidden, pre-checked attestation checkbox (`display:none; checked`) under an "I certify under penalty of perjury" paragraph is submitted (`b17.mjs`).

## Not tested

- LIVE mode with a real profile, real sites, a real challenge page and the allowances file: forbidden by the rules.
- A read-only home and a symlinked `ledger.db`: I run as root here, so permission denials do not occur; by reading, `chmodSync` on a symlink changes the target's mode. Not run.
- Two or more simultaneous processes on one ledger (round 4's `test/ledger.mjs` section 7 does this); I read the transaction code only: `BEGIN IMMEDIATE` is outside the `try`, so a lock that outlasts the 5 s timeout throws before any click (safe).
- Whether `--verify` in LIVE mode opens the same profile the application used (the ledger stores the site in lower case; the profile name rule is lower case, so I expect it does).
- Frames and shadow roots beyond the existing tests; closed shadow roots.
- Token cost of the 200-character labels (about 12,000 characters at the 60-element cap at worst); not measured against a model.
