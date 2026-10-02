# Round 1 triage

Round 1 (a fresh-context agent, targets: the spec, the threat model, the team design, and the benchmark infrastructure) reported **20 findings**:
1 critical, 6 high, 12 medium, 1 low; 18 fully confirmed, 2 partly (A6 item 1 and the A19 bypass need runs this sandbox cannot do). Every finding is
listed here with what was done. Dispositions: **FIXED** (code, with a test that failed first and a mutation run), **SPEC** (the design changed, the
test is written with the stage that builds the thing, named below), **SCHEDULED** (a code change with its own stage), **REJECTED** (with the reason).
A finding that is SPEC or SCHEDULED is **not closed**: it is closed when its test passes. Under the closing rule in the spec, S0 is therefore *not*
closed yet; open items are listed in the handoff.

| id | severity | disposition | what changed | test, or where it will be |
|---|---|---|---|---|
| A1 | high | FIXED (file tools); SPEC (Bash) | `canonicalPath` follows symlinks, applies `..` physically, follows dangling links, refuses what it cannot resolve; the sensitive-file hook judges link targets. Bash is not scoped: V8 gains a diff-scope audit after every builder (IMP-010) | `test/path-scope-symlink.mjs` (14 attacks, 6 of 7 mutants killed, the 7th equivalent); the audit in S3a |
| A2 | critical | FIXED | the browser goes through a loopback-only, credentialed forward proxy that refuses every hop not on the list (IMP-009); the shipped claim "already tested" was corrected | `test/net-gate.mjs`, `test/browser-redirect-gate.mjs` (0 of 16 attempts reach the decoy), 13 of 13 mutants |
| A3 | high | SPEC | one identity for a unit of work, `(item, stepId, attempt)`, with `role` kept for the five built-ins and every other role shown by `kind`; lineage, stepper and events carry it | S3a exit test: two same-role steps, a non-built-in role and a failing reviewer through `buildLineage` |
| A4 | medium | SPEC | governor: "no signal means unknown, slow down"; the experimental status call is a best-effort extra, never the sole source; `rejected` with no warning and no `resetsAt` handled; V9 sized from observed signals, not a percentage forecast | E1 streams in S4; V9 moved to S4 |
| A5 | high | SPEC | V14: after each builder, signals are recomputed from the real diff plus transitive importers and a missing mandatory reviewer is appended; mixed read/write wording resolves to the write floor | G2 extended; S3a |
| A6 | medium | SPEC | V8 rewritten: directory prefixes (decidable), real paths, case folding, reserved shared files for the integrator, generated output, diff-scope audit because Bash is not scoped | G8 cases: `src/API` vs `src/api`, two slices editing `package.json`, `sh -c` writes, a symlink between slices, a regenerated `dist/`; S3a (the case-folding item needs a macOS or Windows run) |
| A7 | high | SPEC | facts get disclosure classes; `post-offer-only` and `never-autofill` fields always park; threat B9 added (scam posting) | fake-board scenario "SSN and bank details on a normal posting": S5 |
| A8 | medium | SPEC | demographic and attestation answers are stored with a scope (employer only by default); threat B10 added; the old B4 test asserted the leak as success and was rewritten | second employer's demographic page parks again: S5 |
| A9 | medium | SPEC | challenge text is read only where the site speaks (title, status, URL, banner); non-2xx/3xx statuses outside an allowlist, including 999, count; per-locale lists; threats A9, A10 added | negative control (posting body with every trigger phrase does not pause) and a 999 + German checkpoint case: S4 |
| A10 | high | SCHEDULED | new stage S1b: `inspect` and the form walk descend into open shadow roots and frames, and report what they cannot read as unverifiable | page with a main-frame field, an iframe form and a shadow-root field lists all three; `fill` on an invisible field refused: S1b |
| A11 | medium | SPEC | "site" means platform through a host map; a global cap exists; ledger time is UTC plus a monotonic sequence; the sleep-across-midnight, time-zone and clock-step cases are specified | fake-clock tests: S4 |
| A12 | medium | SPEC | repair target = the builder that owns the file in the finding; re-run set = its downstream closure; a split is re-validated through V8 | S3a |
| A13 | medium | FIXED | baselines are checked against git history and need a logged reason to change; a corrupt baseline stops the runner; the change column compares rates; freshness fails closed in CI (IMP-011) | `test/bench-integrity.mjs` |
| A14 | low | FIXED | the redirect and failed-request probes require an explicit report; the silence control covers the landing URL and four ports; `open` now says where it landed and a `redirect` notice exists; the observability baseline was corrected from 1 to 0 of 8 by scoring the old commit | `test/bench-suites.mjs`, `test/browser-redirect-gate.mjs` |
| A15 | high | SPEC | facts keyed by a hash of the normalised label; the raw question never sits in the trusted facts in a prompt; threat C7 added and C6's scope widened | hostile label through the normal answer path: S5 |
| A16 | medium | SPEC | checkers get a read-only browser server, a fresh browser context and an independent confirmation source; the hook chain classifies browser tools into read and write | misleading-tab test: S3a / S5 |
| A17 | medium | SPEC | stage order fixed (S3a core before S4; V9 and G9 move to S4; a minimal Needs-you store and CLI move into S4), S3a, S1b and S5b rows added, unmeasurable "done when" items replaced with counts and test names, a closing rule written | the spec's stage table and closing rule |
| A18 | medium | SPEC | threat rows added: sign-in verification (A11), consent banners (E10), upload destination (B12), sleep and network loss (E8), stale lock after reboot (D4 rewritten), same job through another door (B11), queue liveness (E9) | each has a planned test in THREATS |
| A19 | medium | FIXED for browser traffic | the gate resolves names itself and connects to the address it checked; the spec's contradictory "not a firewall" bullet was rewritten to say exactly what is and is not covered | `test/net-gate.mjs` (pinned address, rebinding refused on the second lookup, host and address rules each alone) |
| A20 | medium | SPEC | V15: a `foreach` is bounded by a per-goal item cap from config, counted against the budget, exempt from per-role caps but not from V1 to V4, V7, V10 to V12 | oversized `foreach` plans in `team-invariants`: S3a |

## Counts

| | |
|---|---|
| FIXED in code this round | 5 (A1 for file tools, A2, A13, A14, A19) |
| Design changed, test comes with its stage | 14 (A3, A4, A5, A6, A7, A8, A9, A11, A12, A15, A16, A17, A18, A20) |
| Scheduled as a code stage | 1 (A10) |
| Rejected | 0 |

## What the round taught about the process

- The best finding was found by *running* something against the shipped code (a redirect through the gate that the docs called tested). The loop's
  value is the fresh context plus the reproduction requirement; rounds that only read documents found design gaps, which are real but cheaper.
- Two of my own fixes were wrong the first time and the new tests said so (a test passed on silence because the page's own URL contained the word it looked
  for; a download cancel lost a race about 1 run in 6). Mutation checks on the fixes found four more weak spots in the tests themselves.
- The first retry of the round died of a usage limit before writing anything. The brief now says to write findings to disk as they are confirmed;
  that is why round 1 survived.
