// Real end-to-end test of the approval UI: launches a real pipeline run with the
// approval UI ON, opens the actual rendered page in headless Chromium, and clicks
// the real "Approve" button in the DOM for every pending tool call — not a raw
// WebSocket message crafted by the test, an actual browser click on actual HTML.
//
// Requires: npm run build (dist/ must exist), PLAYWRIGHT_BROWSERS_PATH set to the
// pre-installed Chromium (see README). Spends real API tokens (a small task).
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

// The installed playwright-core version doesn't reliably match the pre-installed
// browser's revision number, so chromium.launch()'s default download-path lookup
// can miss it. Find the real binary directly instead of hardcoding a revision.
function findPreinstalledChrome() {
  const root = "/opt/pw-browsers";
  const dir = readdirSync(root).find((d) => d.startsWith("chromium-"));
  if (!dir) throw new Error(`No chromium-* directory found under ${root}`);
  const exe = join(root, dir, "chrome-linux", "chrome");
  if (!existsSync(exe)) throw new Error(`Expected chrome binary not found at ${exe}`);
  return exe;
}

const PORT = 4600;
const workDir = mkdtempSync(join(tmpdir(), "agent-loop-browser-test-"));
const task = "Create a file named world.txt in the working directory containing exactly the text: browser approval works";

console.log(`[setup] workDir=${workDir} port=${PORT}`);

const child = spawn(
  process.execPath,
  [
    "--experimental-sqlite",
    "dist/cli.js",
    "run",
    task,
    "--dir",
    workDir,
    "--port",
    String(PORT),
    "--max-retries",
    "0",
  ],
  { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"] }
);

let childOutput = "";
child.stdout.on("data", (d) => (childOutput += d.toString()));
child.stderr.on("data", (d) => (childOutput += d.toString()));

const childExit = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

// Wait for the server to be listening before opening the browser.
await new Promise((resolve, reject) => {
  const start = Date.now();
  const check = () => {
    if (childOutput.includes("agent-loop UI:")) return resolve();
    if (Date.now() - start > 15000) return reject(new Error("server did not start within 15s:\n" + childOutput));
    setTimeout(check, 200);
  };
  check();
});
console.log("[ok] pipeline process started and server is listening");

const browser = await chromium.launch({ executablePath: findPreinstalledChrome() });
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}/`);
await page.waitForSelector("#status");
console.log("[ok] browser opened the real UI page");

await page.waitForFunction(() => document.getElementById("status")?.textContent === "live", { timeout: 10000 });
console.log("[ok] page's WebSocket client reports 'live' (real WS connection from a real page)");

let clicksPerformed = 0;
const clickLoop = (async () => {
  while (child.exitCode === null) {
    const button = page.locator(".approval .btns .allow:not([disabled])").first();
    if (await button.count()) {
      await button.click();
      clicksPerformed++;
      console.log(`[click] approved a pending tool call in the real browser (#${clicksPerformed})`);
    }
    await page.waitForTimeout(250);
  }
})();

const TIMEOUT_MS = 5 * 60 * 1000;
const exitCode = await Promise.race([
  childExit,
  new Promise((_, reject) => setTimeout(() => reject(new Error("pipeline run timed out")), TIMEOUT_MS)),
]);
await clickLoop;

console.log(`[ok] pipeline process exited with code ${exitCode}, browser clicked Approve ${clicksPerformed} time(s)`);

await page.screenshot({ path: join(workDir, "final-ui-state.png"), fullPage: true });
console.log(`[ok] saved screenshot: ${join(workDir, "final-ui-state.png")}`);

const resolvedCount = await page.locator(".card").filter({ hasText: "Approval allow" }).count();
console.log(`[info] UI timeline shows ${resolvedCount} 'Approval allow' resolution card(s)`);

await browser.close();

assert.strictEqual(exitCode, 0, "pipeline should exit 0");
assert.ok(clicksPerformed > 0, "the browser should have had at least one real Approve click to perform");
assert.ok(existsSync(join(workDir, "world.txt")), "world.txt should exist after a real approved build phase");

console.log(`\nALL BROWSER APPROVAL TESTS PASSED (${clicksPerformed} real clicks, workDir kept at ${workDir})`);
