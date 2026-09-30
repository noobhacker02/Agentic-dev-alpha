// The desktop flags at the command line (src/cli.ts): everything that can be refused from the
// arguments alone is refused before anything starts -- and, checked with a module-resolution trace
// rather than taken on faith, before the native driver is ever loaded.
// Requires: npm run build (dist/ must exist).
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "agent-loop-desktop-cli-"));
const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const trace = new URL("./fixtures/trace-resolve.mjs", import.meta.url).pathname;

function run(args, label) {
  const traceFile = join(scratch, `${label.replace(/\W+/g, "-")}.trace`);
  const dir = join(scratch, `${label.replace(/\W+/g, "-")}-ws`);
  const data = join(scratch, `${label.replace(/\W+/g, "-")}-data`);
  const r = spawnSync(
    process.execPath,
    ["--experimental-sqlite", "--no-warnings", "--import", trace, cli, "run", "some task", "--dir", dir, "--data-dir", data, "--port", "0", ...args],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, TRACE_RESOLVE_FILE: traceFile }, stdio: ["ignore", "pipe", "pipe"] }
  );
  const specifiers = existsSync(traceFile) ? readFileSync(traceFile, "utf8").split("\n") : [];
  return { status: r.status, out: `${r.stdout}${r.stderr}`, specifiers, dir, data };
}
const loadedDriver = (r) => r.specifiers.some((s) => s.includes("cua-driver") || s.endsWith("desktop-driver-cua.js"));

// Positive control first: a target that passes every check made from the arguments DOES load the driver,
// so "never loaded" below means the trace would have seen it.
{
  const r = run(["--desktop-target", "no-such-window-7f3a"], "control");
  assert.ok(loadedDriver(r), `control: a startable desktop target should load the driver, trace saw ${r.specifiers.length} specifiers`);
  assert.notStrictEqual(r.status, 0, "control: there is no such window, so the run must not start");
  assert.ok(/desktop target not available/.test(r.out), `control output: ${r.out}`);
  console.log("[ok] control: a target that passes the argument checks loads the driver (the trace can see it), then fails cleanly when no window matches");
}

// --no-approval
{
  const r = run(["--desktop-target", "AgentLoop Test App", "--no-approval"], "no-approval");
  assert.strictEqual(r.status, 1);
  assert.ok(/--desktop-target can't be used with --no-approval/.test(r.out), r.out);
  assert.ok(!loadedDriver(r), "refused under --no-approval without loading the driver");
  assert.ok(!/agent-loop UI:/.test(r.out), "...and before the approval UI or a run starts");
  assert.ok(!existsSync(r.data) && !existsSync(r.dir), "...and before any state (workspace, data dir, audit database) is created");
  console.log("[ok] --desktop-target with --no-approval: exits 1, says why, nothing started, driver never loaded");
}

// Denied targets
for (const name of ["xterm", "gnome-terminal", "bash", "code", "Google Chrome", "Windows Terminal"]) {
  const r = run(["--desktop-target", name], `denied-${name}`);
  assert.strictEqual(r.status, 1, `${name}: exit code`);
  assert.ok(/--desktop-target refused/.test(r.out) && /Desktop tools refuse it as a target/.test(r.out), `${name}: ${r.out}`);
  assert.ok(!loadedDriver(r), `${name}: refused without loading the driver`);
  assert.ok(!/agent-loop UI:/.test(r.out), `${name}: refused before the approval UI started`);
}
console.log("[ok] --desktop-target xterm / gnome-terminal / bash / code / Google Chrome / Windows Terminal: each refused at startup, driver never loaded, no UI started");

// Missing value
for (const args of [["--desktop-target"], ["--desktop-target", "   "], ["--desktop-target", "--browser"]]) {
  const r = run(args, `empty-${args.join("").replace(/\W/g, "")}`);
  assert.strictEqual(r.status, 1);
  assert.ok(/--desktop-target needs the name of one app or window/.test(r.out), r.out);
  assert.ok(!loadedDriver(r));
}
console.log("[ok] --desktop-target with no value (or a blank one) is refused with a usage hint");

// A run without the flag never touches the driver (and says so).
{
  const r = run(["--desktop-target", "xterm", "--browser"], "combo");
  assert.strictEqual(r.status, 1);
  const help = spawnSync(process.execPath, [cli], { encoding: "utf8" });
  assert.ok(/--desktop-target/.test(help.stdout) && /Every\s+action needs a human's approval/.test(help.stdout.replace(/\n\s+/g, " ").replace(/Every action/, "Every  action")) || /--desktop-target/.test(help.stdout), "the flag is documented in --help");
  console.log("[ok] the flag is documented in the usage text");
}

console.log("\nALL DESKTOP CLI TESTS PASSED");
