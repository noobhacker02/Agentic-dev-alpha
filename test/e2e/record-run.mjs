// Records a real agent-loop run the way a person experiences it: a real Chromium opens the printed
// UI URL, every approval is clicked Approve (like a user who trusts every step), the whole session is
// saved as a video, and a screenshot is taken at every phase change. Real API usage.
//
//   node test/e2e/record-run.mjs --out <dir> [--browser] [--smart] [--dir <workDir>] [--port N] -- "<task>"
//
// --smart answers like a sensible person: "Yes, and don't ask again" whenever the prompt offers it,
// plain "Yes" otherwise. Without it, every prompt gets a plain "Yes".
//
// Writes <out>/run.webm, <out>/shots/NN-<phase>.png, <out>/final.png, <out>/summary.json.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const task = argv.slice(sep + 1).join(" ");
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && i < sep ? argv[i + 1] : d; };
const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 && i < sep; };
const out = resolve(opt("out", "e2e-out"));
const workDir = resolve(opt("dir", join(out, "workdir")));
const port = opt("port", "4700");
mkdirSync(join(out, "shots"), { recursive: true });

const root = new URL("../..", import.meta.url).pathname;
const nodeArgs = ["--experimental-sqlite", "--no-warnings"];
if (process.env.COST_LOG) nodeArgs.push("--import", join(root, "test/stress/proxy-sdk/register.mjs"));
const cliArgs = ["run", task, "--dir", workDir, "--port", port, ...(flag("browser") ? ["--browser"] : [])];
const t0 = Date.now();
const child = spawn(process.execPath, [...nodeArgs, join(root, "dist/cli.js"), ...cliArgs], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
const exited = new Promise((r) => child.on("exit", (c) => r(c)));

while (!/agent-loop UI: (\S+)/.test(log)) {
  if (Date.now() - t0 > 20000) throw new Error("UI never came up:\n" + log);
  await new Promise((r) => setTimeout(r, 200));
}
const url = log.match(/agent-loop UI: (\S+)/)[1];

const exe = process.env.AGENT_LOOP_CHROME_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch({ executablePath: exe });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: out, size: { width: 1280, height: 800 } } });
const page = await context.newPage();
await page.goto(url);

const approvals = [];
const phaseShots = [];
let seenPhaseStarts = 0;
let done = false;
exited.then(() => (done = true));
while (!done) {
  const prompt = page.locator("#prompt");
  if (await prompt.count()) {
    const title = (await prompt.locator(".title").innerText().catch(() => "")) || "";
    const body = (await prompt.locator(".body").innerText().catch(() => "")) || "";
    const canRemember = (await prompt.locator('.opt[data-choice="remember"]').count()) > 0;
    const key = flag("smart") && canRemember ? "2" : "1";
    approvals.push({ atSec: Math.round((Date.now() - t0) / 1000), what: (title + ": " + body.split("\n")[0]).slice(0, 160), answer: key === "2" ? "yes+remember" : "yes" });
    await page.waitForTimeout(400); // let the video show the prompt before answering
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
  }
  const starts = await page.locator(".phase-sep").count();
  if (starts > seenPhaseStarts) {
    seenPhaseStarts = starts;
    const label = (await page.locator(".phase-sep").last().getAttribute("data-phase")) || "phase";
    const file = join(out, "shots", `${String(phaseShots.length + 1).padStart(2, "0")}-${label}.png`);
    await page.screenshot({ path: file });
    phaseShots.push(file);
  }
  await page.waitForTimeout(300);
}
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, "final.png"), fullPage: true });
const cardCount = await page.locator("#transcript .blk").count();
const header = { cost: await page.locator("#cost").innerText(), elapsed: await page.locator("#elapsed").innerText() };
await context.close();
await browser.close();
const vid = readdirSync(out).find((f) => f.endsWith(".webm") && f !== "run.webm");
if (vid) renameSync(join(out, vid), join(out, "run.webm"));

const summary = {
  task, url: url.replace(/#token=.*/, "#token=…"), exitCode: await exited,
  status: (log.match(/finished with status: (\w+)/) || [])[1] ?? "no status line",
  costLine: (log.match(/Cost: .*/) || [""])[0],
  wallClockSec: Math.round((Date.now() - t0) / 1000),
  approvalsAnswered: approvals.length, approvals, transcriptBlocks: cardCount, uiHeader: header, phaseShots,
  tail: log.split("\n").slice(-6),
};
writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, approvals: undefined }, null, 2));
