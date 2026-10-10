# Round 9 triage (provisional)

Round 9 (a fifth fresh Sonnet adversary, on `c5b2f02`: the code the builder agents wrote after round 8) reported **15 findings**: 1 high, 7 medium, 7 low, each reproduced by running code. Four packets are in flight (R9-A reel, R9-B ledger and platform, R9-C engine writes, R9-D benchmark rows); every row below is SCHEDULED until its branch passes a verifier and is merged, and flips to FIXED then. Nothing here is claimed fixed.

| id | severity | disposition | what is planned | test |
|---|---|---|---|---|
| A149 | high | SCHEDULED | packet R9-A: reel: normalise by Unicode class, fold look-alikes, match the squashed form | the packet's tests (named when merged) |
| A150 | medium | SCHEDULED | packet R9-A: reel: judge about/shown/claims too; wider list stated as a floor | the packet's tests (named when merged) |
| A151 | medium | SCHEDULED | packet R9-C: engine: count writes over the whole browser context, a new page is a move; the script-GET residual is stated | the packet's tests (named when merged) |
| A152 | medium | SCHEDULED | packet R9-B: ledger: address spellings | the packet's tests (named when merged) |
| A153 | medium | SCHEDULED | packet R9-B: ledger: canonicalise the full address before cutting | the packet's tests (named when merged) |
| A154 | low | SCHEDULED | packet R9-B: ledger: false merges | the packet's tests (named when merged) |
| A155 | low | SCHEDULED | packet R9-B: ledger: canonicalisation version and fallback scan | the packet's tests (named when merged) |
| A156 | low | SCHEDULED | packet R9-B: ledger: atomic migration | the packet's tests (named when merged) |
| A157 | medium | SCHEDULED | packet R9-A: reel: remove frames on every path | the packet's tests (named when merged) |
| A158 | medium | SCHEDULED | packet R9-A: ideas: no yes for a refused idea, show verdict and reason, a person must be there | the packet's tests (named when merged) |
| A159 | low | SCHEDULED | packet R9-B: apply: derive a platform name the profile accepts | the packet's tests (named when merged) |
| A160 | low | SCHEDULED | packet R9-B: apply: separate ledger file for --test | the packet's tests (named when merged) |
| A161 | low | SCHEDULED | packet R9-A: reel: --project read with the --text checks | the packet's tests (named when merged) |
| A162 | medium | SCHEDULED | packet R9-D: bench: rows for caps, gap, address, redaction, recorded pauses, reference block | the packet's tests (named when merged) |
| A163 | low | SCHEDULED | packet R9-A: reel: citation content word, negative risk is the worst risk | the packet's tests (named when merged) |

Also from the report, not numbered: a first-open migration race fails closed (A156), and the single real-model injection sample held (one sample, not a result).
