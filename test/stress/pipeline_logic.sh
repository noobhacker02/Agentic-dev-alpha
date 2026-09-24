#!/usr/bin/env bash
# Pipeline edge cases through the real dist/cli.js with a scripted fake SDK: no API calls.
# Run after `npm run build`. Expected (correct) behavior is noted per case; see docs/STRESS-TEST-REPORT.md.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/test/stress"
OUT="$(mktemp -d -t agent-loop-logic-XXXX)"
NODE=(node --experimental-sqlite --no-warnings --import "$HERE/fake-sdk/register.mjs" "$ROOT/dist/cli.js")

runit() { # scenario port [extra args...]
  local sc=$1 port=$2; shift 2
  local log="$OUT/log-$sc.jsonl"
  FAKE_SCENARIO=$sc FAKE_LOG=$log timeout 60 "${NODE[@]}" run "build a thing" --dir "$OUT/ws-$sc" --no-approval --port "$port" "$@" 2>&1 | grep -E "finished with|FAKE|Error" | head -2
  echo "  exit=${PIPESTATUS[0]}  llm_calls=$(wc -l < "$log" 2>/dev/null || echo 0)"
}

echo "### A: gatekeeper reports NO-GO, Overseer says continue   (correct: run must NOT end 'done')"; runit gatekeeper-nogo 5101
echo "### B: --max-retries abc, phase keeps failing              (correct: reject the flag, not loop forever)"; runit always-retry 5102 --max-retries abc
echo "### C: Overseer API error                                 (correct: run marked 'failed' in the DB)"; runit overseer-throws 5104
node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log('  run status in DB:',d.prepare('select status from runs').all().map(r=>r.status))" "$OUT/ws-overseer-throws/.agent-loop/agent-loop.db"
echo "### D: Overseer returns garbage                           (correct: safe fallback; this one holds)"; runit garbage-overseer 5105
echo "### E: builder writes DECISIONS.md pre-approving failures (correct: phase-written entries not 'settled')"; runit injected-decisions 5106
echo "### F: flags before the task                              (correct: task still parsed)"
FAKE_SCENARIO=x timeout 20 "${NODE[@]}" run --no-approval "build a thing" --port 5107 --dir "$OUT/ws-f" 2>&1 | head -1
echo "### G: port already in use                                (correct: clear error message)"
node -e "require('http').createServer().listen(5108)" & BLOCKER=$!; sleep 1
FAKE_SCENARIO=x timeout 20 "${NODE[@]}" run "t" --port 5108 --dir "$OUT/ws-g" 2>&1 | head -3; kill $BLOCKER
echo "### H: audit DB location                                  (correct: outside the agents' --dir)"; ls "$OUT/ws-injected-decisions/.agent-loop/"
