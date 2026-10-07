# Testing: every suite, what it proves, and what spends money

Moved out of the README. `npm test` runs all 70 no-API suites in order; `node scripts/run-suites.mjs` runs each on its own with a timeout and prints which passed (it is what the macOS and Windows CI job uses).

```bash
npm run build
npm test                       # all of the no-API suites below, in one go (what CI runs)
npm run test:plumbing          # no LLM calls — store/bus/server/WebSocket wiring only
npm run test:server            # no LLM calls — approval server access control + approval replay
npm run test:scope             # no LLM calls — per-phase tool restriction, --dir path scoping, minimal env
npm run test:data-dir          # no LLM calls — audit database location stays outside --dir
npm run test:browser-tools     # no LLM calls — real Chromium, real DOM changes, real screenshot files
npm run test:ui                # no LLM calls — real Chromium drives the real UI: stepper, keyboard approvals, replay
npm run test:terminal          # no LLM calls — the terminal transcript + prompt, driven with real keypresses
npm run test:bash              # no LLM calls — which shell commands are read-only / get which "don't ask again" rule
npm run test:rules             # no LLM calls — "don't ask again" never stretches past what you saw
npm run test:report            # no LLM calls — the saved report.html opens from disk, inert against injected HTML
npm run test:sprites           # no LLM calls — the pixel set validates; every kind of wrong sprite is reported
npm run test:ui-mascot         # no LLM calls — real Chromium: the cat runs to a waiting prompt and hops, cursors, icons, reduced motion
npm run test:ui-offline        # no LLM calls — real Chromium: the offline dialog and the dinosaur, against a server that goes away and returns
npm run test:ui-sound          # no LLM calls — real Chromium: sound off by default, never autoplays, measured on the real output
npm run test:ui-plain          # no LLM calls — real Chromium: one switch turns every cartoon off; remembered; the page works the same
npm run test:ui-cartoon-stress # no LLM calls — real Chromium: 80 flapping approvals, hostile viewports, resizes, four server restarts
npm run test:ui-idle-cost      # no LLM calls — real Chromium: nothing repaint-bound runs while a prompt waits (it once cost 4.2% of a core)
npm run test:ui-stop           # no LLM calls — real Chromium: the Stop button, "still running", notifications, a skewed clock
npm run test:stop              # no LLM calls — cost cap, Ctrl-C, SIGTERM, the stop message; the run is saved as stopped
npm run test:stop-e2e          # no LLM calls — a real run, a real browser, two real clicks on Stop; 200 stop messages from 3 tabs
npm run test:concurrent        # no LLM calls — 5 (or CONCURRENT_RUNS=12) runs on one audit database; a database that fails mid-run
npm run test:doctor            # no LLM calls — every doctor diagnosis through injected probes, the real X11 probe, the CLI
npm run test:roast             # no LLM calls — the insights voice: lint, canaries, fake model, abandoned runs, the CLI
npm run test:real-model-stop   # a few cents, opt-in — the real SDK aborted mid-request and the real pipeline stopped mid-Planner
npm run check:sprites          # after swapping a sprite under ui/assets/: checks it against manifest.json
node test/e2e/record-run.mjs --out <dir> [--browser] [--smart] -- "<task>"   # real API calls — records a whole run as video
node test/browser-approval.mjs # real API calls — full pipeline, real browser, real Approve clicks
node test/validate-dev-workflow.mjs   # real API calls — does dev-workflow actually trigger + get followed?
node test/validate-decisions-log.mjs  # real API calls — ask once, never re-ask what's already decided
```

## Suites added with the hybrid-agent work (S0 to S3a, adversary rounds 1 and 2)

All no-API. Each was written to fail on the old code first, mutation-checked, and run twice; the benchmark column says which suite in [BENCHMARK.md](BENCHMARK.md) measures the same thing.

| Script | What it proves |
|---|---|
| `test:safety` | The safety net and the sensitive-file guard against every bypass the stress test found (24 of 27 dangerous commands once got through) |
| `test:safety-rewrites` | Round 2, A30: `git -C repo push --force`, `rm -rf /etc` and the other cheap rewrites of a denied command are still denied (payloads XOR-encoded in the file so no scanner reads them as live) |
| `test:bash-readonly` | Round 2, A51: shell commands run without a prompt only in safe forms; 216 rows beside the ordinary commands that must stay quiet (benchmark `shell-readonly`) |
| `test:path-text` | Round 2, A27 to A29, A44: `~`, a relative link, Glob patterns, UNC and drive-relative forms and the credential list are judged as the file tools read them (benchmark `file-hooks`) |
| `test:path-scope-symlink` | Round 1, A1: a symlink inside `--dir` does not walk out of it, and `link/..` is judged by where it really is |
| `test:persona`, `test:ui-persona` | The voice: catalog lint, levels, determinism, hostile text in every event field; and the real page showing it |
| `test:lineage`, `test:ui-lineage` | The run's tree, rebuilt from events and cross-checked against them; and the tree view in a real browser |
| `test:browser-cu` | Refs, screenshot-bound `click_at`, tabs, hover, select, scroll, and every leak channel (WebSocket, WebRTC, service worker, popups) |
| `test:browser-observability` | What the browser tools tell the agent about a page: errors, failed requests, dialogs, downloads, repeats, the unseen notices, queries, fenced text, URLs, typed secrets, scrolling dialogs (benchmarks `observability`, `browser-honesty`) |
| `test:browser-frames` | Round 1, A10: `inspect` sees iframes and open shadow roots, says what it could not read, and refuses fields a person cannot see (benchmark `form-coverage`) |
| `test:browser-popup-storm` | Round 2, A41: ten and thirty popups that open and close themselves, video on, do not end the process; a storm of 150 leaves 60 tabs |
| `test:browser-hang` | Round 2, A31: a busy page makes every tool give up at its deadline and leave a fresh tab; a stuck tab closes quickly |
| `test:browser-dropped-call` | IMP-019: a call the browser drops ("Resulting promise was garbage collected") is asked again once for a read (`inspect`, `text`), never repeated for an action, and reported plainly otherwise; the popup-storm tests wait for the page's own end signal |
| `test:team-identity` | IMP-020 (A3): two builders, an integrator, a failing security reviewer and an item flow are distinct lineage nodes; old events and an old database read as before; hostile ids are ignored; insights count units; the repair bound |
| `test:team-write-scope` | IMP-021 (V7, V8): the write-scope hook for none, slice, tests, docs and shared, every spelling of a path outside a scope refused, the hook's tools and wording |
| `test:team-role-spec` | IMP-021: the tools, auto-approval, browser and desktop access and prompt of every built-in role and hostile ones; briefs and role files fenced as data |
| `test:team-browser-readonly` | IMP-021 (A16): a checker's browser registers 13 of 18 tools; every browser tool is classified acting or looking |
| `test:team-run-phase` | IMP-021: the real `runPhase` and hook chain for a team step (fake SDK runs scripted tool calls through the hooks): slice, reader, integrator, browser, desktop, approval; the built-in phases unchanged |
| `test:team-changes` | IMP-022: the before/after snapshot of the project tree (content hashes, links as links, derived directories left out, a snapshot cut short is refused) that the diff audit compares |
| `test:team-verdict` | IMP-022: a team step's verdict may carry a report (cleaned, cut), a team planner names steps to skip by role id; the built-in phases' verdicts are unchanged |
| `test:team-pipeline` | IMP-022: a composed team through the real pipeline with the fake SDK: plan order, step ids in events and store, reports, repair by step id, the diff audit closing Bash, budgets, stop, a refused plan, the five-phase path unchanged |
| `test:team-run-cli` | IMP-023: `--team auto|fixed5|<plan file>`: no flag and fixed5 change nothing, auto is the composer's team for the task and the repo's paths, a plan file is finalized (floor added, change reported), bad values and refused plans end the command before a database exists (exit 1 or 2), project roster roles need `--trust-project`, and the real command line runs a team with step ids in the stored run |
| `test:fatal` | Round 2, A39 and A41: an error nobody caught stops the run the ordinary way, including through the real command twice per kind of error |
| `test:net-gate` | The forward proxy that decides where the browser may go: absolute URIs, CONNECT, WebSocket upgrades, resolution, the credential, and an upstream that answers a status HTTP does not allow |
| `test:browser-redirect-gate` | Round 1, A2 (critical): a server-side redirect from an allowed page cannot reach a decoy host (16 ways of trying) |
| `test:team-roster`, `test:team-plan`, `test:team-signals`, `test:team-compose`, `test:team-cli` | S3a part one: the 19 built-in roles and the user's own, the plan validator (V1 to V8, V10 to V12, V15), signals from words and paths, the offline composer, and `roster` / `team --dry-run` (benchmarks `team-invariants`, `team-sizing`) |
| `test:ui-desktop` | The desktop panel and every approval prompt for a desktop input, in a real browser |
| `test:desktop-tools`, `test:desktop-adapter`, `test:desktop-cli`, `test:desktop-pipeline` | Desktop control against a scripted driver: target resolution, the five tools and every fence before an action, the driver adapter, the flags, and a real pipeline run |
| `test:insights` | `agent-loop insights` never prints a raw control byte from a stored rule |
| `test:bus-history` | The bus's replay never forgets the shape of a run, however long |
| `test:ui-replay` | A long run replays into the page quickly and correctly |
| `test:bench-suites` | The benchmark's scorers have teeth: each check misses on silence, on a page's own words and source, and hits on a real report |
| `test:bench-integrity` | A baseline cannot change without a row that names both values and is used once; a corrupt baseline stops the runner; freshness fails closed in CI |
| `test:bench-table` | The table in BENCHMARK.md is what the numbers say, **and every suite is measured again on this checkout** (full marks stay full marks) |
| `test:adversary-round` | Adversary rounds are real (a reproduction or an argument per finding), numbered without gaps, and every finding is triaged |
| `test:checkpoint` | `npm run checkpoint`: runs the repository's own scanner, pushes only the designated branch to the expected origin, respects a blocking hook, never forces, and `.gitignore` covers credential files |
| `test:improvements-log` | Every entry of IMPROVEMENTS.md has every field, a number or a reason for "Measured", and known suites |
| `test:handoff` | HANDOFF.md has its sections, a timestamp, and a covered commit no more than 8 behind |

Every `test/validate-*` and `test/browser-approval.mjs` script spends real API tokens — they exist because
reading the code isn't evidence something works.

