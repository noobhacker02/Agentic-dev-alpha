// Test-only preload (test/fatal.mjs): once the run's first model call is in flight, raise an error nothing catches (FATAL_KIND=rejection or throw), the way a page that closes under a
// browser request does. Waits for the state (the fake SDK's call log has a line) and not for a fixed time, so a slow machine only starts later.
import { existsSync, readFileSync } from "node:fs";
const log = process.env.FATAL_WAIT_FOR_FILE;
const timer = setInterval(() => {
  try { if (!existsSync(log) || !readFileSync(log, "utf8").trim()) return; } catch { return; }
  clearInterval(timer);
  if (process.env.FATAL_KIND === "throw") setTimeout(() => { throw new RangeError("Invalid status code: 99"); }, 0);
  else Promise.reject(new Error("TargetClosedError: route.continue"));
}, 25);
