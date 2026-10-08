# Adversary review, round 7

- Date: 2026-10-08
- Round: 7 (a code round on the job-apply slice after the round-6 fixes, IMP-035)
- Targets: `src/facts.ts`, `src/ledger.ts`, `src/job-apply.ts`, `src/apply-command.ts`, the page-side guards in `src/browser-tools.ts`, `scripts/run-suites.mjs`, `test/fixtures/job-board.mjs` and the four suites. Commit `cffe31e`.
- What I ran: a scratch worktree at `/tmp/r7-wt` (built, `node_modules` symlinked), Node with `--experimental-sqlite`, the real `applyToJob`, the real browser tool handlers (`__testHandlers`, `testPolicy`) in the real Chromium, against my own local HTTP servers on 127.0.0.1 (`/tmp/r7-scratch/h.mjs`: a page server that logs every request and POST body). No real site was contacted.
- Triage: no `round-07-triage.md` yet.

## Findings table

| id | severity | status | title |
|---|---|---|---|
| A114 | high | CONFIRMED (run) | the `form=N` rule is per document: a plain "Apply" button inside an iframe (form=0 of the frame) is "in the same form" as the main fields (form=0), and the engine clicks it |
| A115 | medium | CONFIRMED (run) | a posting whose id lives in the query string (`careers?gh_jid=222`) is refused as "already applied" because `canonUrl` drops the query; the advertised way out (`--forget`) closes the real application |
| A116 | medium | CONFIRMED (run) | the HTTP status of the SUBMIT is never read: a form POST answered 429 (a polite page of 400+ characters) leaves the site unpaused and the next application is sent at once |
| A117 | medium | CONFIRMED (run) | the company test of `namesJob` is "the company name appears anywhere on the page": a Globex posting with an "also hiring at Acme" sidebar is applied to and recorded as Acme |
| A118 | low | CONFIRMED (run) | `--resume-site ""` (an empty argument, e.g. an unset shell variable) un-pauses every platform-level pause at once |
| A119 | low | CONFIRMED (run) | `--verify` keeps visiting a platform after a challenge, visits an already paused one, and ignores the HTTP status of the page it opens |
| A120 | high | CONFIRMED (run) | a page that submits during the fill (file input or select with `onchange="form.submit()"`) sends a real application before `intend`; the CLI says "Nothing was sent." and the next run sends it again |
| A121 | medium | CONFIRMED (run) | an ARIA checkbox, switch or radio that arrives ticked (`aria-checked="true"`) has no `checked` flag in the listing, so the "already ticked" guards never see it and its consent is submitted |
| A122 | medium | CONFIRMED (run) | the two yes/no work-authorisation facts are unanchored: "authorized to work ... and willing to undergo a background check / relocate / are you 18" is answered with the stored "Yes" |
| A123 | medium | CONFIRMED (run) | values the page chose in `number`, `range` and `search` inputs (roles spinbutton, slider, searchbox) are sent as the user's answers; only role `textbox` is checked for a page-set value |
| A124 | low | CONFIRMED (run) | a refusal because an earlier attempt is UNCONFIRMED exits 0 ("applied"), the same code as a confirmed duplicate |
| A125 | medium | CONFIRMED (run) | `verifyAttempt` confirms an unsent application from ANY page that says "application submitted on ..." (a redirect to "My applications"); it never checks that the page is the posting |
| A126 | low | CONFIRMED (run) | the form-diff message `holds "<value>"` prints the page-altered value of a fact (a `maxlength` prefix, a masked or reformatted copy): `redact` only removes exact copies |
| A127 | low | CONFIRMED (run) | `run-suites.mjs --timeout-min` does not stop a hung suite (`shell: true` + `child.kill()` kills only the shell); an interrupt leaves `suite-tmp-*` behind |
<!-- table-end -->

## Findings

<!-- findings-start -->

### A114 (high) the `form=N` rule is per document: a plain "Apply" button inside an iframe (form=0 of the frame) is "in the same form" as the main fields (form=0), and the engine clicks it

- **Status:** CONFIRMED (run)
- **Claim attacked:** A94 FIXED (round 5): "every element in the listing carries the form it belongs to (`form=N`); the planned fields, the résumé field and the submit button must all be in one form, and a button of another form is never clicked". A77: "a form field in a frame parks the item".
- **Where:** `src/browser-tools.ts` `describeElementInPage`: `form: el.form ? Array.from(doc.forms).indexOf(el.form) : -1` where `doc = el.ownerDocument`. The index is per DOCUMENT, so the first form of an iframe is `form=0`, the same token as the first form of the main page. `src/job-apply.ts`: the frame check is `fields.some((e) => e.frame !== undefined)` and `fields = pageFields(all)` removes buttons and links; the submit button is chosen from `all` and only its `form` number is compared (`submits[0]?.form`, again at step 3 `submit[0]!.form !== [...forms][0]`). A button inside a frame is never looked at for `frame`.
- **Reproduction (run, `/tmp/r7-scratch/t1.mjs`):** the main page is "Platform Engineer at Acme" with one real form (name, email, résumé, a button whose name is not one of the plain phrases: "Finish") and an `<iframe>` that holds a separate one-button form `<form method=post action="/frame-post"><button>Apply</button></form>` (an embedded "apply" widget, a "similar jobs" one-click form, any third-party form).
  ```
  {"status":"unverified","seq":1,"why":"the page after the submit shows no confirmation ..."}
  server saw: GET /apply, GET /frame, POST /frame-post
  [s4e4] button "Finish" id="fin" form=0
  [s4e9] button "Apply" form=0 frame="127.0.0.1:36767/frame"
  ```
  The planned fields are `form=0` of the main document, the only plain submit button is the frame's `Apply`, also `form=0` of the frame's own document, so `forms.size === 1` and the engine writes `intend` and clicks the frame's button. The main application form is never submitted; an unrelated form (here a local one, in real life any embedded origin) is.
- **Impact:** a click is made on a control the engine never vetted, in another document (possibly another origin), while the ledger says "an application to Acme / Platform Engineer was intended" and the user is told "sent, not confirmed". This is the very case A94 was closed for (a one-click "apply to similar jobs" form), reached by putting the decoy one frame down. Any page with a custom main-form button name ("Continue", "Finish", "Next") plus an embedded widget triggers it without malice.
- **Suggested fix:** include the frame in the form identity (`form=<frame>:<n>`, or print `form=` as `f<frame-index>.<n>`), and park when ANY element used by the plan (including the submit button and any button the plain-phrase test finds) has a `frame`; count the buttons in frames in the "more than one plain button" test so that a frame's `Apply` plus a main `Submit application` also parks (today the two-button check does see it, but only by accident of the names).

### A115 (medium) a posting whose id lives in the query string (`careers?gh_jid=222`) is refused as "already applied" because `canonUrl` drops the query; the advertised way out (`--forget`) closes the real application

- **Status:** CONFIRMED (run)
- **Claim attacked:** A106 FIXED (round 6): "the same address under another label is a duplicate"; the round-7 brief: "`?jobId=42` vs `?jobId=43` are different postings but canonUrl drops the query".
- **Where:** `src/ledger.ts` `canonUrl`: keeps `host + pathname` and drops the whole query string; `duplicate()` returns the first live row whose canonical address equals the new one, before it looks at the job id.
- **Reproduction (run, `/tmp/r7-scratch/t3.mjs`):** a local board whose postings are `/careers?gh_jid=1` and `/careers?gh_jid=2` (the shape Greenhouse's embedded boards and many company career pages use), two different titles, two different `--job-id`s, same label:
  ```
  1 {"status":"submitted","seq":1}
  2 {"status":"duplicate","why":"already applied to this posting (#1)"}
  server saw: GET /careers?gh_jid=1 ; POST /careers?gh_jid=1
  ```
  Library check (`/tmp/r7-scratch/t2.mjs`): `mayStart({jobId:"222", title:"Data Engineer"}, "https://acme.com/careers?gh_jid=222")` after a confirmed `?gh_jid=111` answers `already applied to this posting (#1)`. On platforms with one fixed path for every company (`/embed/job_app?for=acme&token=...`) all postings of the platform collapse into the first one applied to. The fragment goes the same way: `canonUrl("https://careers.acme.com/#/job/1")` and `.../#/job/2` are both `careers.acme.com` (hash-routed career sites).
- **Same family (run, `/tmp/r7-scratch/t16.mjs`):** the job id is compared without the company, so two employers on one platform whose ids are slugs (`acme.recruitee.com/o/developer`, `globex.recruitee.com/o/developer`, `--job-id developer`) are "the same posting": `already applied to this posting (#1)`.
- **Impact:** AVAILABILITY, not a duplicate: nothing is sent twice. But (a) the user is told, falsely, that they already applied to a posting they never saw; (b) every later posting behind a query-keyed address is refused for 30 days; (c) the only remedy the tool offers is `--forget <n>`, which closes the CONFIRMED row of the other, real application, re-opening *that* posting to a genuine second application. A tool that tells the user to delete a true record to get a false refusal out of the way trains the very step that causes duplicates.
- **Suggested fix:** keep the query in the canonical address for the by-address test (sorted, minus known tracking parameters `utm_*`, `gh_src`, `source`, `ref`, `lever-source`), or apply the by-address rule only when the job id and the title+company test give no answer AND the query is empty. If the query is dropped on purpose, say in the refusal that the match was by address and name the row's company and title, so the user can see it is a different job.

### A116 (medium) the HTTP status of the SUBMIT is never read: a form POST answered 429 (a polite page of 400+ characters) leaves the site unpaused and the next application is sent at once

- **Status:** CONFIRMED (run)
- **Claim attacked:** A82 FIXED (round 5): "`open` reports the main document's HTTP status; 429, 403, 503 and 401 pause the site"; spec "Self-healing": a 429 means the agent stops hitting the site.
- **Where:** `src/job-apply.ts` step 5 (after the click): the only rate-limit/challenge test on the answer is `challenged(answer)`, i.e. wording (`CHALLENGE`, applied only to a body under 400 characters with fewer than 3 fields) and a title list. The HTTP status of the form POST is never read: the `click` tool returns "Clicked sNeM." with no status, and the following `inspect` prints none either (checked: no "429" anywhere in its text or notices).
- **Reproduction (run, `/tmp/r7-scratch/t4.mjs`):** a local board whose form POST answers `429` with `Retry-After: 3600` and a normal-looking page (title "Slow down", "We have received a lot of submissions from your network. Come back in an hour." plus some 500 characters of recruiting boilerplate). Two different postings of the same site, applied one after the other:
  ```
  1 {"status":"unverified","seq":1,...}   paused: undefined
  2 {"status":"unverified","seq":2,...}   paused: undefined
  server saw: GET /jobs/1/apply ; POST /jobs/1/apply ; GET /jobs/2/apply ; POST /jobs/2/apply
  ```
  The site said 429 and the second POST went out at once; no pause row exists, so a third process does the same. (With the page's words kept below 400 characters and one of the listed phrases the pause fires; the status never matters.)
- **Impact:** "a site hammered after a 429" on the one request that matters most (the submit, which also leaves an `intended` row behind per attempt that the user must `--forget` one by one). The `open` fix covers navigations only; the POST is where rate limiting on application endpoints really happens.
- **Suggested fix:** have the browser tools remember the status (and `Retry-After`) of the last main-frame navigation or form response and print it in `click`/`inspect` ("HTTP 429." like `open` does); the engine then applies the same 429/403/503/401 rule to the post-submit answer, before the wording test, and pauses the site.

### A117 (medium) the company test of `namesJob` is "the company name appears anywhere on the page": a Globex posting with an "also hiring at Acme" sidebar is applied to and recorded as Acme

- **Status:** CONFIRMED (run)
- **Claim attacked:** A104 FIXED (round 6): "only the title and the first two lines can name the job, and the company must be on the page"; A89/A76: the page must be the posting it was told about.
- **Where:** `src/job-apply.ts` `namesJob`: `titled && plain(`${title}\n${text}`).includes(plain(job.company))`. The company test is a substring test over the title AND the whole visible text (3,000 characters plus frames), unconnected to the line that carries the job title. "At Globex" is stripped from the heading by `wrapper` (`/\s+(at|@)\s+.*$/`), and the company is then looked for anywhere else.
- **Reproduction (run, `/tmp/r7-scratch/t5.mjs`):** the posting is Globex's: `<title>Platform Engineer</title><h1>Platform Engineer at Globex</h1>`, the form, and an `<aside>Also hiring: Data Engineer at Acme, Backend Engineer at Hooli</aside>` (a "more jobs" widget, on nearly every job board). The command says `--company Acme --title "Platform Engineer"`:
  ```
  {"status":"submitted","seq":1}   requests: GET,POST   ledger: [["Acme","confirmed"]]
  ```
  The engine filled the user's name, e-mail and résumé into Globex's form, submitted it, and recorded "Acme / Platform Engineer" as confirmed.
- **Impact:** a real application to the wrong employer with the user's data, and a poisoned ledger: the real Acme "Platform Engineer" is then refused for 30 days as "already applied" (and `--forget` is the user's only way out). The only input needed is a link that points at the wrong tenant (a model that picked the wrong row of a results page, a redirect to a sibling posting) and any sidebar.
- **Suggested fix:** require the company where the job is named: in the same heading/first lines as the title (`at Acme`, `- Acme`, `Acme · ...`), or in the page title/host/`og:site_name`; a company that appears only in a later paragraph or list item does not count. If the page names a *different* company in the title line ("... at Globex" while the user said Acme), park instead of stripping it.

### A118 (low) `--resume-site ""` (an empty argument, e.g. an unset shell variable) un-pauses every platform-level pause at once

- **Status:** CONFIRMED (run)
- **Claim attacked:** A72/A106: "a pause survives the process and is lifted only by `agent-loop apply --resume-site <site>`"; round-7 brief: "can `--resume-site` lift too much?".
- **Where:** `src/apply-command.ts` (`str("resume-site")` returns `""` for an empty argument and `resumeSite !== undefined` takes the branch) and `src/ledger.ts` `unpause`: `DELETE FROM site_pauses WHERE site = ? OR label = ?` with both parameters `siteOf("")` = `""`. Every platform-level pause row is written with the default `label = ''` (`pause(site, why)`), so `label = ''` matches ALL of them.
- **Reproduction (run, `/tmp/r7-scratch/t6.mjs`, `AGENT_LOOP_HOME=/tmp/r7-scratch/home1`):** pauses written the way the engine writes them (`greenhouse`, `lever`, `workday` as platform labels, plus `host:...` rows for two of them):
  ```
  before:  greenhouse:PAUSED  host:boards.greenhouse.io:PAUSED  lever:PAUSED  host:jobs.lever.co:PAUSED  workday:PAUSED
  $ agent-loop apply --resume-site ""        (what `--resume-site "$SITE"` does when $SITE is unset)
   is no longer paused. Look at the site yourself first: ...         exit 0
  after:   greenhouse:-  host:boards.greenhouse.io:PAUSED  lever:-  host:jobs.lever.co:PAUSED  workday:-
  ```
  Three sites were un-paused by one empty argument; the message even prints a blank name. The platform-level pause is the ONLY pause for a site paused by `verifyAttempt` (`ledger.pause(row.site, ...)` writes no host row), for a site whose address would not parse, and for every `--test`-mode board.
- **Impact:** a challenged or rate-limited platform is silently made fair game again by a typo or an unset variable; the only record of why it was paused is deleted with it. Low-medium: needs a user mistake, but the command is documented as the "I have looked at it" gesture and nothing checks that a name was given.
- **Suggested fix:** refuse an empty (after trim) `--resume-site` and `--forget` value, and make `unpause` delete `WHERE site = ? OR (label = ? AND label != '')`; print what was lifted (the names, one per line) instead of a bare "no longer paused".

### A119 (low) `--verify` keeps visiting a platform after a challenge, visits an already paused one, and ignores the HTTP status of the page it opens

- **Status:** CONFIRMED (run, on the functions the CLI calls); the CLI loop is confirmed by text
- **Claim attacked:** A72/A82: "a site that showed a challenge or answered 429/403/503/401 is paused and is not asked again"; A107 / spec "Self-healing": a challenge stops the visits.
- **Where:** `src/apply-command.ts` `--verify`: `for (const row of rows) { const session = open(row.site); ... verifyAttempt(...) }` never asks `ledger.paused(row.site)` (nor the host) and goes on to the next row after a pause; `src/job-apply.ts` `verifyAttempt`: reads no HTTP status (the `open` text carries `HTTP 429.`; `applyToJob` parses it, `verifyAttempt` does not) and treats only wording as a challenge.
- **Reproduction (run, `/tmp/r7-scratch/t8.mjs`):** four `intended` rows on one platform whose posting pages answer `429` with an ordinary-looking page ("Please wait ... We are very busy right now."), then the same loop with a "Verify you are human" page:
  ```
  429 page : verdicts unknown x4   requests: 4   paused: undefined
  challenge: requests: 4           paused: {"why":"a challenge or a rate limit while verifying"}   (set after request 1, requests 2-4 still went out)
  ```
- **Impact:** a rate limit or a challenge met while verifying does not stop the verification run, and a site already paused by an earlier `apply` is visited anyway. Small (rows are few after a crash) but it is the exact "hammer after a challenge" the pause exists for, on a path with no per-request gap either.
- **Suggested fix:** in the `--verify` loop skip (and report) every row whose platform or host is paused, re-check after each row, and give `verifyAttempt` the same `HTTP 429/403/503/401` rule as `applyToJob` (pause, return `unknown`).

### A120 (high) a page that submits during the fill (file input or select with `onchange="form.submit()"`) sends a real application before `intend`; the CLI says "Nothing was sent." and the next run sends it again

- **Status:** CONFIRMED (run, the real CLI against a local board)
- **Claim attacked:** spec "Ledger: exactly once" / B-class: "nothing is sent before the `intended` row is written"; the CLI's own sentence for a parked item: "Nothing was sent."; A66 (the page changes during the fill) was closed only for fields that appear or change, not for a page that SUBMITS during the fill.
- **Where:** `src/job-apply.ts` steps 2 and 3: `fill`, `select_option` and `upload` run BEFORE `ledger.intend`, and a failing tool call there returns `parked` with a fixed text and no ledger row. `src/apply-command.ts` prints `Needs you: ... Nothing was sent.` for every `parked` result. Nothing in the engine asks whether the page navigated, or whether a request left, while it was filling.
- **Reproduction (run, `/tmp/r7-scratch/t10.mjs`, `agent-loop apply <page> --test --site board --company Acme --title "Platform Engineer" --job-id 1`, an `AGENT_LOOP_HOME` with `facts.json` and `uploads.json`):** an ordinary application form whose résumé field is `<input type=file onchange="this.form.submit()">` (the "choose a file and it goes" pattern; a `<select onchange="this.form.submit()">` does the same, `/tmp/r7-scratch/t9.mjs`). The upload step makes the page submit the form with every planned field and the résumé; the page navigates and the engine's next call dies:
  ```
  run 1: exit 3
  Needs you: Acme, Platform Engineer. Nothing was sent.
    - the r?sum? was not attached: Error: elementHandle.ownerFrame: Execution context was destroyed, most likely because of a navigation
  run 2: exit 3
  Needs you: Acme, Platform Engineer. Nothing was sent.
    - the r?sum? was not attached: Error: elementHandle.ownerFrame: Protocol error ...
  POSTs the board accepted: 2   | with the résumé bytes in them: 2
  ```
  The ledger has no row after run 1 (`ledger rows: 0` in `t9.mjs`), so run 2 is not a duplicate for it, fills and submits again.
- **Impact:** a REAL DUPLICATE APPLICATION, the harm the ledger exists for, announced as "Nothing was sent" and repeatable on every run. A page that submits on a file choice, on a select change, or after a timer (`setTimeout(() => form.submit(), 800)`) turns "the fill failed" into "the application is out and unrecorded". The `upload` error text is also just a Playwright message, so the user is not even told that the page navigated.
- **Suggested fix:** write the `intended` row BEFORE the first `fill`/`select_option`/`upload` (the row means "a request may leave from here on"; close it as `failed` yourself only when you can prove nothing left, i.e. the page URL, the document and the request log are unchanged), or at least: on any tool error during steps 2-3, compare the page URL/document with the one at planning time and the browser's request log for a non-GET; if either differs, leave an `intended` row and return `unverified` ("the page navigated while the form was being filled; something may have been sent"), never "Nothing was sent". A page's `onchange`/`oninput` submit handlers cannot be detected up front, so the ledger-first rule is the structural fix.

### A121 (medium) an ARIA checkbox, switch or radio that arrives ticked (`aria-checked="true"`) has no `checked` flag in the listing, so the "already ticked" guards never see it and its consent is submitted

- **Status:** CONFIRMED (run)
- **Claim attacked:** A85/A93 FIXED (rounds 5): "any element listed as ticked parks, whatever its role says and whether it is marked disabled; a radio the page selected parks"; A66: a box that arrives already ticked parks before anything is touched.
- **Where:** `src/browser-tools.ts` `describeElementInPage`: `checked: tag === "input" && (type === "checkbox" || type === "radio") ? Boolean(el.checked) : null`. Only native inputs get a checked state. An ARIA checkbox, switch or radio (`<div role="checkbox" aria-checked="true">`, which is what React/Material/Radix forms render) is listed as `checkbox "..."` with neither `checked` nor `unchecked`, so `PageElement.checked` is `undefined` and the `e.checked === true` guards in `src/job-apply.ts` never fire.
- **Reproduction (run, `/tmp/r7-scratch/t11.mjs`):** the usual three fields and résumé, plus
  `<div role="checkbox" aria-checked="true" tabindex="0">Share my profile with partner companies</div>`, a `role="switch" aria-checked="true"` "Send me marketing messages", a `role="radio" aria-checked="true"` "Share my data with recruiters", and the hidden input a widget library keeps in sync (`<input type=hidden name=share value=yes>`):
  ```
  listing:  [s2e4] checkbox "Share my profile with partner companies" id="c1"
            [s2e5] switch "Send me marketing messages"
            [s2e6] radio "Share my data with recruiters"          (no checked / unchecked flag)
  {"status":"submitted","seq":1}
  POST body:  name=Ada Lovelace, email=..., cv=resume.pdf, share=yes
  ```
  The page's pre-ticked consents were submitted as part of the user's application; the control with native `<input type=checkbox checked>` is parked (`prechecked`).
- **Impact:** the data-sharing / marketing / contact-my-references consents that the previous rounds decided the program must never send unchosen go out whenever the form is built from custom components. (The part the program cannot see in the page's own hidden state is the stated A67 limit; this one it CAN see and does not print.)
- **Suggested fix:** compute `checked` from `aria-checked` (and `aria-pressed` for toggle buttons, `aria-selected` for `option`/`tab` in a listbox/radiogroup) for any element with a checkable role, print `checked`/`unchecked` for them, and let the existing guards apply; treat `aria-checked="mixed"` as ticked. Park when a checkable role has no readable state at all.

### A122 (medium) the two yes/no work-authorisation facts are unanchored: "authorized to work ... and willing to undergo a background check / relocate / are you 18" is answered with the stored "Yes"

- **Status:** CONFIRMED (run)
- **Claim attacked:** A65/A95/A110 FIXED: "a yes/no fact is only the answer to a plain question addressed to 'you'"; spec "Facts and form answers": a fact answers the question it was stored for and nothing else.
- **Where:** `src/facts.ts` `RULES`: `needs_sponsorship: /sponsor/` and `work_authorisation: /authori[sz]ed to work|legally (authori[sz]ed|eligible)|right to work|eligible to work|work authori[sz]ation/` are UNANCHORED (the name rules are anchored, these two are not), and the compound-question guard (`/sponsor/` AND `/authori[sz]ed|eligible|right to work/` in one label) covers exactly one pairing. Nothing tests for a second question joined by "and" / "or" / ", " / a second "?".
- **Reproduction (run, `/tmp/r7-scratch/t13.mjs`, and `t12.mjs` for the labels alone):** two selects on an otherwise ordinary form:
  `Are you legally authorized to work in this country and willing to undergo a background check and a drug test? *` and `Do you require sponsorship, and do you agree to relocate to our head office? *` (options Yes / No). Facts: `work_authorisation: Yes`, `needs_sponsorship: No`.
  ```
  {"status":"submitted","seq":1}      POST: q=Yes  q2=No
  ```
  Also filled (library): "... authorized to work in this country and are you at least 18 years old?" -> Yes; "... eligible to work in this country and do you consent to a background check?" -> Yes; "... authorized to work in this country or do you hold a criminal record?" -> Yes. (The one with "never convicted" parked only because "never" is in the negation list.)
- **Impact:** the user's stored "Yes" answers a different, second question they were never asked: consent to a background check or drug test, willingness to relocate, age, a criminal-record question. These are statements about the person made without them, in the same family as the attestations the rounds closed; the posting is then sent.
- **Suggested fix:** a fact answers a label only when the label is that single question: park when the label contains a second clause (`\band\b|\bor\b|,|;` followed by a verb phrase such as `are you|do you|will you|would you|can you|have you|willing|agree|consent|confirm`), a second `?`, or more than ~120 characters; and anchor `needs_sponsorship` / `work_authorisation` to the question shapes that are known ("do you (now or in the future )?require ... sponsorship", "are you (legally )?(authori[sz]ed|eligible) to work( in ...)?").

### A123 (medium) values the page chose in `number`, `range` and `search` inputs (roles spinbutton, slider, searchbox) are sent as the user's answers; only role `textbox` is checked for a page-set value

- **Status:** CONFIRMED (run)
- **Claim attacked:** A66/A112 FIXED: "the flow does not send an answer it did not choose": a text box that arrives with a value parks ("came with a value the page put there"), a select that arrives with a choice made parks.
- **Where:** `src/job-apply.ts` step 3 diff: `else if (e.role === "textbox" && (e.value ?? "").trim()) wrong.push(...)`. The listing gives a `value` to every input that holds text (`holdsText` in `describeElementInPage`: number, range, search, date and so on), but only role `textbox` is checked. `type=number` is role `spinbutton`, `type=range` is `slider`, `type=search` is `searchbox`; there is no step-1 check at all for any role other than `combobox`/checkbox/radio.
- **Reproduction (run, `/tmp/r7-scratch/t15.mjs`):** the usual form plus `<label>Willing to travel (percent)</label><input type=number name=travel value="100">` and `<label>Share my data with partners (0 no, 10 yes)</label><input type=range name=share min=0 max=10 value="10">`:
  ```
  {"status":"submitted","seq":1}      POST: travel=100  share=10
  ```
- **Impact:** same class as A112 (a default the page chose is sent as the user's answer), through the roles the check forgot: "willing to travel 100%", "years in role 10", a consent slider. Medium-low: the page chose the value, but the program's stated promise is that it does not send those.
- **Suggested fix:** in step 1 and in the diff, treat any unplanned element that holds a value (`value` present and non-empty/non-default) and is not a button, a file input or a hidden control as "came with a value" for every role (`textbox`, `searchbox`, `spinbutton`, `slider`, `combobox`, `listbox`); a range/number that has a value but no label that a fact answers parks.

### A124 (low) a refusal because an earlier attempt is UNCONFIRMED exits 0 ("applied"), the same code as a confirmed duplicate

- **Status:** CONFIRMED (run)
- **Claim attacked:** `src/apply-command.ts` header: "exit codes a script can read: 0 submitted or already applied ... 5 sent but not confirmed".
- **Where:** `src/apply-command.ts`: `case "duplicate": return { ... code: 0 }` for every `duplicate` result, including the one that `mayStart` produces for an `intended` row ("an earlier attempt at this posting (#n) has no confirmation: verify it before trying again") and the one `intend` produces inside the lock.
- **Reproduction (run, `/tmp/r7-scratch/home3`, ledger seeded with one `intended` row):**
  ```
  $ agent-loop apply http://127.0.0.1:9/jobs/1/apply --test --site board --company Acme --title "Platform Engineer" --job-id 1
  Not applied: Acme, Platform Engineer. an earlier attempt at this posting (#1) has no confirmation: verify it before trying again
  exit 0
  ```
- **Impact:** a driver script (or a model reading exit codes) counts a posting whose application MAY have gone out and has never been confirmed as "done" (0 = applied), instead of "needs a person" (5). With the earlier exit-5 run forgotten, the unconfirmed attempt silently drops out of the batch's to-do list. Low: the text is right, the code is not.
- **Same code path, by text:** `applyToJob` answers `{ status: "duplicate" }` for ANY refusal of `intend` (`if (!intent.ok) return { status: "duplicate", why: intent.why }`), so a cap that closes between the start check and the lock (the parallel-process case A105 added the in-lock check for) also exits 0 with "Not applied ... the hourly cap is reached" instead of 6, and loses `waitMs`.
- **Suggested fix:** return 5 for a duplicate whose row is `intended` (and for the in-lock refusal), keep 0 only for `confirmed`.

### A125 (medium) `verifyAttempt` confirms an unsent application from ANY page that says "application submitted on ..." (a redirect to "My applications"); it never checks that the page is the posting

- **Status:** CONFIRMED (run)
- **Claim attacked:** A62/A80 (rounds 4-5): "`verifyAttempt` confirms only when the site says it was received"; A76/A89/A104: "the page must name the job".
- **Where:** `src/job-apply.ts` `verifyAttempt`: opens `row.url`, runs `challenged`, then `ALREADY_APPLIED.test(visible(page))` and confirms. It does not read the `Landed on ... (redirected)` part of the `open` answer, does not run `namesJob` (title and company of the row are available) and so any page the address leads to counts. `ALREADY_APPLIED` includes `\bapplication submitted on\b`, which is the standard wording of an account's "My applications" list.
- **Reproduction (run, `/tmp/r7-scratch/t17.mjs`):** an `intended` row for Acme / "Platform Engineer" whose attempt never sent anything (0 POSTs). The posting address has since been taken down and the site redirects it to the logged-in user's "My applications" page (as most ATS portals do), which lists *other* applications: "Data Engineer at Globex: Application submitted on 3 Jan":
  ```
  verdict: confirmed   row: [["Acme","Platform Engineer","confirmed","verified on the site (the page said so; page text can be wrong)"]]   POSTs: 0
  ```
- **Impact:** an application that was never sent is recorded as confirmed; the user is told "the site shows it was received (now confirmed)" and the posting is refused as "already applied" for 30 days. This is the quiet-failure side of the ledger (a missed application the user believes was made). The only reopening is `--forget`, which the user has no reason to try.
- **Suggested fix:** in `verifyAttempt` require that the page names the row's job and company (reuse `namesJob`) and that the final address (the `Landed on` part of `open`) is the row's address or on its host path; a redirect to a different path is `unknown`.

### A126 (low) the form-diff message `holds "<value>"` prints the page-altered value of a fact (a `maxlength` prefix, a masked or reformatted copy): `redact` only removes exact copies

- **Status:** CONFIRMED (run)
- **Claim attacked:** A101/A91 FIXED: "any message that reaches a park reason has the user's fact values taken out"; round-6 triage row A101: the failing-fill message is no longer shown, "the other messages still have the exact values taken out".
- **Where:** `src/job-apply.ts` step 3: `wrong.push(`"${p.label.slice(0, 60)}" holds "${(e.value ?? "").slice(0, 40)}" and not what was filled`)` is printed after `redact(r, secrets)`, which removes only an EXACT fact value (`t.split(v).join(...)`). The text it prints is the value the PAGE ended up with: a field with `maxlength`, an input mask or any `oninput` rewrite gives a prefix or a reformatting of the fact, which is not an exact copy. This was the second half of the round-6 report on A101 ("a value the page reformats ... or a long value cut at 40 characters is printed") and the fix covered only the fill-error branch.
- **Reproduction (run, `/tmp/r7-scratch/t18.mjs`):** facts `phone: "+44 20 7946 0000"`, `linkedin: "https://www.linkedin.com/in/ada-lovelace-1815"`; a phone field with `maxlength=9` and a LinkedIn field whose `oninput` replaces non-alphanumerics with `-`:
  ```
  ["\"Phone\" holds \"+44 20 79\" and not what was filled",
   "\"LinkedIn\" holds \"https---www-linkedin-com-in-ada-lovelace\" and not what was filled"]
  ```
  The CLI prints these lines under `Needs you:` (`clean()` only strips non-ASCII).
- **Impact:** a fact value (or most of it) reaches stdout/stderr, whatever reads them (a terminal log, a CI log, a model that ran the command). Low: it is the user's own data going to the user's own run, but it is exactly the channel D6 says is redacted.
- **Suggested fix:** do not echo the field's value at all (`"Phone" does not hold what was filled`), as was done for the fill error; where the value helps, show only its length.

### A127 (low) `run-suites.mjs --timeout-min` does not stop a hung suite (`shell: true` + `child.kill()` kills only the shell); an interrupt leaves `suite-tmp-*` behind

- **Status:** CONFIRMED (run)
- **Claim attacked:** `scripts/run-suites.mjs` header: "`--timeout-min` ... a failure on one system is a list, not the first failure hiding the rest" and the round-6 reason for the script (a full disk that ended a review).
- **Where:** `scripts/run-suites.mjs`: `spawn("npm", [...], { shell: true })` and `child.kill()` in the timeout. With `shell: true` the child is the shell; `kill()` ends only the shell, `npm` and `node` keep running with the pipes open, and the `close` event (which resolves the promise) fires only when they exit. There is also no handler for SIGINT/SIGTERM, so an interrupted run leaves `suite-tmp-*` (the very gigabytes the per-suite directory was introduced to remove) behind.
- **Reproduction (run):** a scratch `package.json` whose suite sleeps 40 s, `node scripts/run-suites.mjs --timeout-min 0.05 test:hang` (3 s):
  ```
  FAIL test:hang (40s)        ... [run-suites] timed out after 0.05 min
  elapsed 40s
  ```
  The suite was reported as failed at its own end, not at the timeout; a suite that never ends never lets the runner end.
- **Impact:** low (maintenance tooling, not the product): the timeout meant to stop a hung browser suite does not stop it, and on a CI matrix that is a stuck job instead of a list of failures; a manual interrupt leaves the temporary tree.
- **Suggested fix:** spawn with `detached: true` and kill the process group (`process.kill(-child.pid, "SIGKILL")`; `taskkill /T /F` on Windows), or avoid `shell: true` (`npm.cmd` on Windows through `process.execPath` + npm's cli script); register `SIGINT`/`SIGTERM` handlers that remove `base`.


## What I tried that held

Each was run against the real engine or CLI on my own local servers (scripts in `/tmp/r7-scratch/`, removed at the end) unless marked "by text".

- **`form=` rule (A94) against structural variants.** A submit button inside a shadow root (`form` is -1, parks), a button tied to ANOTHER form by `form="g"` while sitting in the main form (parks), a planned `<input form="nope">` that points to no form (parks), and a button physically outside the form but tied to it by `form="f"` (correctly submitted). Only the iframe case (A114) got through. Not a 30-form page: indexes are `Array.from(doc.forms).indexOf`, so the count does not matter, by text.
- **Fail-closed order inside the lock.** `intend` is called before the click and `ledger.intend` throwing (busy, read-only, trigger-abort) propagates before any click, by text and from the code path; the only unrecorded POSTs I found are the ones the page itself sends before `intend` (A120). Kill -9 of the CLI after the POST (`/tmp/r7-scratch/t20.mjs`): the next run answers "an earlier attempt ... has no confirmation", `--verify` confirms from a posting page that says "You have already applied", `--forget` of a 3-second-old row is refused without `--even-if-recent`. A107/A105 hold.
- **`target="_blank"` / popup.** A form with `target="_blank"` is refused at upload (`checkFileField`); an `onsubmit` that calls `window.open` leaves the row `intended` and the result `unverified` (safe side). Nothing is "confirmed" from another tab.
- **Consent banner over the submit button.** Playwright's actionability check makes the click fail rather than hit the banner; the result is `unverified` with the row left `intended` (the round-5 note; messages say "sent" although nothing was, safe side).
- **Meta refresh / location change between plan and click.** A stale ref makes the click fail ("Refs expire ... the page navigates"); no click on a new page's element was reproducible. (Only the "navigation during the fill" case, A120, matters.)
- **Fact rules for names, e-mail, phone, city, links, salary, notice, years.** ~100 labels through `planField` (`/tmp/r7-scratch/t7.mjs`): "Company name", "Name of ...", "Confirm email", "Reference ...", "Manager's ...", "Current company/title", "Github profile of the maintainer", "Email me job alerts", "Subscribe by email", "Name on card", "Contact name", "Hiring manager name" do not fill. The two work-authorisation / sponsorship rules are the exception (A122).
- **Select value/label swap.** `<option value="Yes">No</option>`: `select_option` may pick the wrong option, but the form diff compares the selected option's text with the plan and parks; held.
- **`Visible text` block forging** (a page line starting with `>>>`, `<<<`, `Title:` etc.): `pageTextBlock` marks them `(page text)`; `visible()`/`titleOf()` are not fooled. The `(more: ...)` forging is closed (A98); `readAll` reads the tool's own first line.
- **Round-6 FIXED rows tested against a variant:** A105 (four racing `intend`s are serialised, by the existing test and the code), A107 (`--forget` of a fresh row), A99 (confirmation with a reCAPTCHA footer is judged before the challenge), A82 (HTTP 429/403/503 on `open` pauses; the variant on the POST is A116), A112 (a select with a default is parked; the variant with other input types is A123), A85/A93 (native ticked boxes park; the variant with ARIA is A121), A104 (the variant with the company elsewhere on the page is A117), A110/A65 (single unambiguous questions are fine; compound questions are A122), A106 (the by-address rule works but is too wide, A115), A101 (the fill message is gone; the diff message is A126).
- **`canonUrl` variants (run, `t2.mjs`):** trailing slash, `/apply`, `/Apply`, `/apply/`, default port 443, case of host are folded; `www.`, a trailing dot on the host, path case, `//`, `;params`, percent-encoded slashes are NOT folded, so those spellings escape the by-address duplicate rule. This only matters when the label, the job id and the title+company all differ at the same time (the key and the name test still catch the usual repeat), so I did not file it; the over-folding of the query and fragment is A115.
- **`host:` pauses.** The host pause is taken from the address the user passed, not from the page, so a hostile page cannot pause a different host; it can pause its own platform LABEL, and that label is shared by every tenant of the platform (by text; availability only, the same design choice as A106, not filed).
- **caps.json:** NaN, negative, `Infinity`, strings, `__proto__`, unknown keys and 100001 are refused by `loadCaps`; 100000 and `minGapSeconds` of 100000 behave (by text).
- **`scripts/run-suites.mjs`:** with one real suite (`test:facts`) the per-suite directory is created, used as `TMPDIR` and removed, nothing is left in `/tmp`, nothing outside `base` is touched (`rmSync` on a path built by `mkdtemp`); a suite name is only used for the directory prefix after being cut to `[a-z0-9-]`. The timeout bug is A127.
- **CLI argument handling.** `--test <page>` and `--verify <page>` hand the word back as the positional; `--site`/`--company` with a following `--flag` give a clear error; `--resume` given a path is refused by `resolveUpload` (after the fields are typed, which is harmless); `--forget` with `0`, `""`, `abc`, a missing number is refused; `--job-id` with spaces is trimmed. The one bad one is `--resume-site ""` (A118). A raw ESC in the error text of a failed `open` is Playwright's own colour code (`\x1b[2m`), not page text, and the URL the user typed arrives percent-encoded: no injection reproduced, so not filed.

## Not tested

- **LIVE mode end to end** (real allowances, a real profile, a real HTTPS site): forbidden by the rules; the LIVE derivation of the platform (A106) is read, not run.
- **Cross-origin iframes and real captcha/Turnstile widgets**: `testPolicy` allows only localhost; I tested frames at another port of 127.0.0.1 (A114) but not an actual third-party origin or a challenge widget.
- **Windows paths and a suite that drops to another user** for `run-suites.mjs`.
- **A full disk, a read-only mount or `chattr +i` on `ledger.db`**: the sandbox runs as root and I would not fill the disk; I argued from the code that `intend` throws before the click, and did not reproduce a write failure on `confirm`.
- **A pause that arrives while another process is already filling** (the engine checks `paused()` once at the start and `intend` does not look at it): by text only, low, not filed as a finding. A process that started before the pause can still submit.
- **The over-blocking of real thank-you pages by `ERRORISH`** ("required", "problem", "missing", "can't" all occur on genuine confirmations): by text; it fails to the safe side (`unverified`), but then the only way to apply again is `--forget`, which is how a duplicate happens. It is the list/SPEC family and I did not find a structural way around it.
- **`inert` / `pointer-events:none` honeypots and further A86 tricks**: the guard is a list; I did not look for the next entry.
- **The mutation checks and the full suites**: not run (instructed not to).
