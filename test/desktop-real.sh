#!/bin/bash
# Runs the real-driver desktop tests under a virtual display with a window manager and an accessibility
# bus: the closest thing to a real desktop a CI runner has.   usage: test/desktop-real.sh test/desktop-real.mjs ...
# Without the prerequisites it skips (exit 0) -- unless REQUIRE_DESKTOP_REAL=1, as in CI, where it fails.
# AGENT_LOOP_TEST_NO_WM=1 leaves the window manager out, to check the driver fails closed without one.
need() {
  if [ "${REQUIRE_DESKTOP_REAL:-}" = "1" ]; then echo "FAIL: $1 (REQUIRE_DESKTOP_REAL=1, so this is not allowed to be skipped)" >&2; exit 1; fi
  echo "[skip] $1"; exit 0
}
command -v xvfb-run >/dev/null 2>&1 || need "xvfb-run is not installed"
command -v dbus-run-session >/dev/null 2>&1 || need "dbus-run-session is not installed"
command -v openbox >/dev/null 2>&1 || need "openbox (a window manager) is not installed; the driver needs one to focus windows"
ATSPI=""
for p in /usr/libexec/at-spi-bus-launcher /usr/lib/at-spi2-core/at-spi-bus-launcher; do [ -x "$p" ] && ATSPI="$p" && break; done
export ATSPI
if [ "${REQUIRE_DESKTOP_REAL:-}" = "1" ] && ! command -v xprop >/dev/null 2>&1; then
  echo "FAIL: xprop (x11-utils) is not installed, so window-manager readiness can't be checked (REQUIRE_DESKTOP_REAL=1, so this is not allowed to be skipped)" >&2
  exit 1
fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
status=0
for script in "$@"; do
  echo "=== $script"
  xvfb-run -a -s "-screen 0 1280x800x24" dbus-run-session -- bash "$HERE/desktop-real-session.sh" "$script" 2> >(grep -v "dbus-daemon" >&2) || status=1
done
exit $status
