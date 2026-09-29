#!/usr/bin/env bash
# Pipeline edge cases through the real dist/cli.js with a scripted fake SDK: no API calls.
# Run after `npm run build`. Expected (correct) behavior is noted per case; see docs/STRESS-TEST-REPORT.md.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/test/stress"
OUT="$(mktemp -d -t agent-loop-logic-XXXX)"
NODE=(node --experimental-sqlite --no-warnings --import "$HERE/fake-sdk/register.mjs" "$ROOT/dist/cli.js")
# Self-contained: keeps this run's audit databases out of the real ~/.agent-loop.
export AGENT_LOOP_HOME="$OUT/data-home"

runit() { # scenario port [extra args...]
  local sc=$1 port=$2; shift 2
  local log="$OUT/log-$sc.jsonl" full="$OUT/full-$sc.log"
  FAKE_SCENARIO=$sc FAKE_LOG=$log timeout 60 "${NODE[@]}" run "build a thing" --dir "$OUT/ws-$sc" --no-approval --port "$port" "$@" > "$full" 2>&1
  local rc=$?
  grep -E "finished with|FAKE|Error" "$full" | head -2
  local calls completed
  # grep -c prints "0" (exit 1) on a real zero-match file but nothing (exit 2) on a missing one --
  # `|| echo 0` would double-print "0\n0" in the first case since grep's own "0" already reached
  # stdout before the exit status made `||` fire; ${var:-0} instead only substitutes on the empty
  # (missing-file) case, so it's the one plain composition that comes out right in both.
  calls=$(grep -c '"overseer"' "$log" 2>/dev/null); calls=${calls:-0}
  completed=$(grep -c '"result":true' "$log" 2>/dev/null); completed=${completed:-0}
  echo "  exit=$rc  llm_calls=$calls"
  # Every fake LLM call that actually completes (worker or Overseer) reports a fixed $0.01 cost via
  # its own "result" message (test/stress/fake-sdk/sdk.mjs), so the CLI's printed total must equal
  # 0.01 * completed-calls exactly. Deliberately counts completions, not call attempts: a call that
  # throws before its generator ever runs (overseer-throws) never gets a result and correctly costs
  # $0, so using raw llm_calls here would produce a false mismatch on that scenario. Applied to every
  # scenario, not spot-checked once, because this is the only place the real usage-EMISSION code in
  # src/phases.ts/src/overseer.ts gets exercised under a repair/retry loop -- test/ui-render.mjs only
  # checks the UI's summing of hand-fed events.
  if [ "$completed" -gt 0 ]; then
    local expected actual
    expected=$(awk -v n="$completed" 'BEGIN{printf "%.2f", n*0.01}')
    actual=$(sed -n 's/^Cost: \$\([0-9.]*\).*/\1/p' "$full")
    if [ "$actual" = "$expected" ]; then
      echo "  OK: cost \$$actual matches $completed completed calls x \$0.01"
    else
      echo "  FAIL: cost tracking mismatch -- expected \$$expected for $completed completed calls, CLI printed \$${actual:-<none>}"
    fi
  fi
}

db_path_for() { sed -n 's/^Audit database:    //p' "$OUT/full-$1.log"; }

echo "### A: gatekeeper reports NO-GO, Overseer says continue   (correct: run must NOT end 'done')"; runit gatekeeper-nogo 5101
echo "### B: --max-retries abc, phase keeps failing              (correct: reject the flag, not loop forever)"; runit always-retry 5102 --max-retries abc
echo "### C: Overseer API error                                 (correct: run marked 'failed' in the DB)"; runit overseer-throws 5104
node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log('  run status in DB:',d.prepare('select status from runs').all().map(r=>r.status))" "$(db_path_for overseer-throws)"
echo "### D: Overseer returns garbage                           (correct: safe fallback; this one holds)"; runit garbage-overseer 5105
echo "### E: builder writes DECISIONS.md pre-approving failures (correct: phase-written entries not 'settled')"; runit injected-decisions 5106
echo "### K: Overseer hallucinates a forward repairTarget         (correct: rejected, never actually reaches it)"; runit forward-repair 5111
if grep -q 'write GATEKEEP\.md' "$OUT/log-forward-repair.jsonl" 2>/dev/null; then
  echo "  FAIL: gatekeeper was actually invoked despite the forward repairTarget being invalid"
else
  echo "  OK: gatekeeper was never invoked -- the forward target was rejected every time"
fi
echo "### F: flags before the task                              (correct: task still parsed)"
FAKE_SCENARIO=x timeout 20 "${NODE[@]}" run --no-approval "build a thing" --port 5107 --dir "$OUT/ws-f" 2>&1 | head -1
echo "### G: port already in use                                (correct: clear error message)"
node -e "require('http').createServer().listen(5108)" & BLOCKER=$!; sleep 1
FAKE_SCENARIO=x timeout 20 "${NODE[@]}" run "t" --port 5108 --dir "$OUT/ws-g" 2>&1 | head -3; kill $BLOCKER
echo "### I: Planner suggests skipping test-designer (trivial task) (correct: run reaches 'done' with 8 LLM calls, not 10 -- test-designer never invoked)"
runit trivial-skip 5109
if grep -q 'write TESTPLAN\.md' "$OUT/log-trivial-skip.jsonl" 2>/dev/null; then
  echo "  FAIL: test-designer was invoked despite the suggested skip"
else
  echo "  OK: test-designer was never invoked"
fi
echo "### J: --browser wired in but no browser tool ever called   (correct: no crash, browser tools inert when unused)"
FAKE_SCENARIO=trivial-skip timeout 60 "${NODE[@]}" run "build a thing" --dir "$OUT/ws-browser-flag" --no-approval --browser --port 5110 > "$OUT/full-browser-flag.log" 2>&1
grep -E "finished with|Browser tools|Error" "$OUT/full-browser-flag.log" | head -3
if pgrep -f "chrome-linux/chrome" > /dev/null 2>&1; then
  echo "  FAIL: a Chromium process is still running (no tool call ever happened, so none should exist)"
else
  echo "  OK: no Chromium process running (browser tools are lazy -- none launched since none was used)"
fi
echo "### H: audit DB location                                  (correct: outside the agents' --dir, no .agent-loop/ left inside it)"
DB_E="$(db_path_for injected-decisions)"
echo "  audit db: $DB_E"
case "$DB_E" in
  "$OUT/ws-injected-decisions"*) echo "  FAIL: audit db is inside --dir" ;;
  *) echo "  OK: audit db is outside --dir" ;;
esac
if [ -e "$OUT/ws-injected-decisions/.agent-loop" ]; then
  echo "  FAIL: .agent-loop/ still created inside --dir"
else
  echo "  OK: no .agent-loop/ left inside --dir"
fi
