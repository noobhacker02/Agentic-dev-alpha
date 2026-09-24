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
  echo "  exit=$rc  llm_calls=$(wc -l < "$log" 2>/dev/null || echo 0)"
}

db_path_for() { sed -n 's/^Audit database:    //p' "$OUT/full-$1.log"; }

echo "### A: gatekeeper reports NO-GO, Overseer says continue   (correct: run must NOT end 'done')"; runit gatekeeper-nogo 5101
echo "### B: --max-retries abc, phase keeps failing              (correct: reject the flag, not loop forever)"; runit always-retry 5102 --max-retries abc
echo "### C: Overseer API error                                 (correct: run marked 'failed' in the DB)"; runit overseer-throws 5104
node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log('  run status in DB:',d.prepare('select status from runs').all().map(r=>r.status))" "$(db_path_for overseer-throws)"
echo "### D: Overseer returns garbage                           (correct: safe fallback; this one holds)"; runit garbage-overseer 5105
echo "### E: builder writes DECISIONS.md pre-approving failures (correct: phase-written entries not 'settled')"; runit injected-decisions 5106
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
