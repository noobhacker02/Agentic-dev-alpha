# Testing: every suite, what it proves, and what spends money

Moved out of the README. `npm test` runs all 37 no-API suites in order; `node scripts/run-suites.mjs` runs each on its own with a timeout and prints which passed (it is what the macOS and Windows CI job uses).

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

Every `test/validate-*` and `test/browser-approval.mjs` script spends real API tokens — they exist because
reading the code isn't evidence something works.

