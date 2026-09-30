#!/bin/bash
# Runs inside the virtual display and session bus (started by test/desktop-real.sh): brings up the window
# manager and the accessibility bus, waits until the window manager is actually managing the display, then
# runs one test script.   usage: desktop-real-session.sh <test.mjs>
#
# "Started" isn't "ready", and a window manager that never came up looks, from inside a test, exactly like a
# driver that can't focus windows. So this checks the display for _NET_SUPPORTING_WM_CHECK (what a running
# window manager sets on the root window), notices if the window manager died, retries it, and fails with
# a message that says what actually went wrong.
if [ "${AGENT_LOOP_TEST_NO_WM:-}" != "1" ]; then
  ready=""
  for attempt in 1 2 3; do
    openbox >/dev/null 2>&1 &
    wm=$!
    if command -v xprop >/dev/null 2>&1; then
      for _ in $(seq 1 50); do
        kill -0 "$wm" 2>/dev/null || break
        if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q "window id"; then ready=1; break; fi
        sleep 0.2
      done
    else
      sleep 1.5; kill -0 "$wm" 2>/dev/null && ready=1
    fi
    [ -n "$ready" ] && break
    echo "window manager attempt $attempt did not come up; retrying" >&2
    kill "$wm" 2>/dev/null
    sleep 0.5
  done
  [ -n "$ready" ] || { echo "FAIL: no window manager came up on the virtual display after 3 tries" >&2; exit 1; }
fi
[ -n "${ATSPI:-}" ] && { "$ATSPI" --launch-immediately >/dev/null 2>&1 & }
sleep 0.5
exec node --experimental-sqlite --no-warnings "$1"
