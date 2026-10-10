// Runs every suite of `npm test` on its own and prints which passed, so a failure on one system is a list, not the first failure hiding the
// rest. Portable (no bash `timeout`, which macOS lacks; works with Windows' npm.cmd). Used by the cross-platform workflow.
//   node scripts/run-suites.mjs [--timeout-min 10] [suite-name ...]
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const ti = args.indexOf("--timeout-min");
const minutes = ti >= 0 ? Number(args.splice(ti, 2)[1]) : 10;
if (!(minutes > 0) || !Number.isFinite(minutes)) { console.error("[run-suites] --timeout-min needs a positive number of minutes"); process.exit(2); }
const timeoutMs = minutes * 60_000;
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
const suites = args.length ? args : [...new Set(scripts.test.match(/test:[a-z0-9-]+/g) ?? [])];

// Each suite gets a temporary directory of its own, removed when it ends: some suites make gigabytes, a full disk once failed nine unrelated suites in a second each and ended a review, and two suites at once must not
// count each other's leftovers. (World-readable: a suite that drops to another user needs to reach it.)
const free = () => { try { const f = statfsSync(tmpdir()); return (Number(f.bavail) * Number(f.bsize)) / 1e9; } catch { return NaN; } };
const base = mkdtempSync(join(tmpdir(), "suite-tmp-"));
chmodSync(base, 0o755);
console.log(`[run-suites] ${free().toFixed(1)} GB free in ${tmpdir()} at the start`);

const live = new Set();
const killTree = (child) => {
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
};
// an interrupt ends the running suite's whole tree and removes the temporary directories instead of leaving gigabytes behind (A127)
const bail = (sig) => () => { for (const c of live) killTree(c); try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ } process.exit(sig === "SIGINT" ? 130 : 143); };
process.on("SIGINT", bail("SIGINT")); process.on("SIGTERM", bail("SIGTERM")); process.on("SIGHUP", bail("SIGTERM"));

const run = (suite) => new Promise((resolve) => {
  const mine = mkdtempSync(join(base, `${suite.replace(/[^a-z0-9-]/g, "")}-`));
  chmodSync(mine, 0o755);
  // its own process group (POSIX), so a timeout or an interrupt ends npm and everything under it: `child.kill()` on a shell ends only the shell and the suite runs on (adversary round 7, A127)
  const child = spawn("npm", ["run", "-s", suite], { shell: true, detached: process.platform !== "win32", env: { ...process.env, TMPDIR: mine, TMP: mine, TEMP: mine } });
  live.add(child);
  let out = "";
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => { out += `\n[run-suites] timed out after ${timeoutMs / 60000} min\n`; killTree(child); }, timeoutMs);
  child.on("close", (code) => { clearTimeout(timer); live.delete(child); try { rmSync(mine, { recursive: true, force: true }); } catch { /* left for the final sweep */ } resolve({ code, out }); });
});

const failed = [];
let passed = 0;
for (const suite of suites) {
  const t0 = Date.now();
  const { code, out } = await run(suite);
  writeFileSync(`suite-${suite}.log`, out);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (code === 0) { passed++; console.log(`PASS ${suite} (${secs}s)`); }
  else { failed.push(suite); console.log(`FAIL ${suite} (${secs}s)\n---- last lines of ${suite}\n${out.trim().split("\n").slice(-25).join("\n")}\n----`); }
}
try { rmSync(base, { recursive: true, force: true }); } catch { /* nothing more to do */ }
if (free() < 1) console.log(`[run-suites] only ${free().toFixed(1)} GB free at the end: a failure above may be the disk`);
console.log(`\npassed: ${passed}\nfailed: ${failed.length ? failed.join(" ") : "none"}`);
process.exit(failed.length ? 1 : 0);
