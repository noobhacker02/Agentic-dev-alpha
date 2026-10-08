// scripts/run-suites.mjs (adversary round 7, A127): a timeout ends the suite's whole process tree, not only the shell, and an interrupt removes the per-suite temporary directories.
//   npm run build && npm run test:run-suites
import assert from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") { console.log("run-suites: process groups are POSIX; skipped on Windows"); process.exit(0); }
const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "run-suites.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const project = (slowMs) => {
  const dir = mkdtempSync(join(tmpdir(), "rs-proj-"));
  const tmp = mkdtempSync(join(tmpdir(), "rs-tmp-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "npm run -s test:slow", "test:slow": `node -e "setTimeout(()=>require('fs').writeFileSync('finished.txt','x'),${slowMs})"` } }));
  return { dir, tmp };
};
const start = (dir, tmp, extra = []) => {
  const p = spawn(process.execPath, [script, ...extra], { cwd: dir, env: { ...process.env, TMPDIR: tmp } });
  let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  const done = new Promise((res) => p.on("close", (code) => res({ code, out })));
  return { p, done, get out() { return out; } };
};

// 1. a timeout stops the suite itself: it never writes the file it would write when it finishes
{
  const { dir, tmp } = project(5000);
  const t0 = Date.now();
  const r = await start(dir, tmp, ["--timeout-min", "0.02"]).done; // 1.2 s
  assert.ok(r.code === 1 && /timed out after/.test(r.out) || /FAIL test:slow/.test(r.out), r.out);
  assert.ok(Date.now() - t0 < 4500, `the runner waited for the suite (${Date.now() - t0} ms)`);
  await sleep(5500);
  assert.ok(!existsSync(join(dir, "finished.txt")), "the suite kept running after its timeout and finished");
  console.log("[ok] a timeout ends the suite's whole process tree");
}
// 2. an interrupt ends the tree and removes the temporary directories
{
  const { dir, tmp } = project(5000);
  const run = start(dir, tmp);
  await sleep(1500);
  assert.ok(readdirSync(tmp).some((n) => n.startsWith("suite-tmp-")), "control: the runner made its temporary directory");
  run.p.kill("SIGINT");
  const r = await run.done;
  assert.ok(r.code === 130 || r.code === null, `exit ${r.code}`);
  await sleep(5500);
  assert.ok(!existsSync(join(dir, "finished.txt")), "the suite survived the interrupt and finished");
  assert.ok(!readdirSync(tmp).some((n) => n.startsWith("suite-tmp-")), "an interrupt left suite-tmp-* behind");
  console.log("[ok] an interrupt ends the tree and leaves no suite-tmp-* directory");
}
console.log("\nALL RUN-SUITES TESTS PASSED");
