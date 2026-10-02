// Runs every suite of `npm test` on its own and prints which passed, so a failure on one system is a list, not the first failure hiding the
// rest. Portable (no bash `timeout`, which macOS lacks; works with Windows' npm.cmd). Used by the cross-platform workflow.
//   node scripts/run-suites.mjs [--timeout-min 10] [suite-name ...]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const ti = args.indexOf("--timeout-min");
const timeoutMs = (ti >= 0 ? Number(args.splice(ti, 2)[1]) : 10) * 60_000;
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
const suites = args.length ? args : [...new Set(scripts.test.match(/test:[a-z0-9-]+/g) ?? [])];

const run = (suite) => new Promise((resolve) => {
  const child = spawn("npm", ["run", "-s", suite], { shell: true, env: process.env });
  let out = "";
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => { out += `\n[run-suites] timed out after ${timeoutMs / 60000} min\n`; child.kill(); }, timeoutMs);
  child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
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
console.log(`\npassed: ${passed}\nfailed: ${failed.length ? failed.join(" ") : "none"}`);
process.exit(failed.length ? 1 : 0);
