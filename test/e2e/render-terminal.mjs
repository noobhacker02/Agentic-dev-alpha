// Renders real command-line output as PNG images for the README and docs. The commands are the real built CLI (dist/cli.js).
// Two things are stand-ins, and each picture says so in its own title bar:
//   - `insights` reads a made-up history, built below from numbers (30 runs of a made-up person), because yours is yours.
//   - the --max-cost run uses the test suite's stand-in model, which charges $0.01 a call, so the cap is reached in two calls
//     and nothing is spent. The stopping is the real code; the prices are not real prices.
// `doctor` is the real thing, run on this machine. Home and temp folders are replaced with ~ and <data>, and the run's #token=... secret with a
// placeholder, so no local paths or secrets are in the images.
//
//   npm run build && node --experimental-sqlite --no-warnings test/e2e/render-terminal.mjs [outDir]
import { chromium } from "playwright-core";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../dist/store.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const outDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "agent-loop-terminal-"));
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "agent-loop-terminal-work-"));

function findChrome() {
  if (process.env.AGENT_LOOP_CHROME_PATH) return process.env.AGENT_LOOP_CHROME_PATH;
  const base = "/opt/pw-browsers";
  if (!existsSync(base)) return undefined;
  const dir = readdirSync(base).find((d) => d.startsWith("chromium-"));
  const exe = dir && join(base, dir, "chrome-linux", "chrome");
  return exe && existsSync(exe) ? exe : undefined;
}

// ---------------------------------------------------------------- a made-up history, for `insights`
function seedHistory(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "agent-loop.db");
  const store = new Store(dbPath);
  const raw = new DatabaseSync(dbPath);
  const ev = (runId, phase, type, payload, ts) => raw.prepare("INSERT INTO events (run_id, phase, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)").run(runId, phase, ts, type, JSON.stringify(payload));
  const setRun = (id, over) => { for (const [k, v] of Object.entries(over)) raw.prepare(`UPDATE runs SET ${k} = ? WHERE id = ?`).run(v, id); };
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const now = Date.now();
  const day = 86_400_000;
  const tasks = ["fix the flaky checkout test", "add a /health route", "migrate the users table", "rename the config loader", "write tests for the parser", "bump the dependencies", "clean up the old scripts"];
  const statuses = [...Array(23).fill("done"), ...Array(3).fill("failed"), ...Array(3).fill("stopped"), ...Array(1).fill("running")];
  let reqN = 0;
  const RULES = ["Bash(npm test:*)", "Bash(git diff:*)", "Edit", "Bash(node scripts/build.js:*)", "Bash(ls:*)", "Write", "Bash(git status:*)", "Bash(npm run lint:*)"];   // what "don't ask again" really saves
  statuses.forEach((status, i) => {
    const task = i % 6 === 0 ? tasks[0] : tasks[(i * 5 + 1) % tasks.length];
    const r = store.createRun(task, "/w");
    let start = now - (35 - i) * day * 0.95 - Math.floor(rnd() * 8) * 3_600_000;
    if (status === "running") start = now - (2 + i % 3) * day;   // never finished: the terminal was closed
    if (i === 5 || i === 11 || i === 17 || i === 23) { const d = new Date(start); d.setHours(2, 40, 0, 0); start = d.getTime(); }   // four 2:40 a.m. runs
    const startIso = new Date(start).toISOString();
    setRun(r.id, { status, created_at: startIso });
    const mins = status === "running" ? 0 : 6 + Math.floor(rnd() * 24) + (i === 9 ? 85 : 0);
    ev(r.id, null, "run-start", { type: "run-start" }, startIso);
    const cost = status === "running" ? 0.4 : (i === 9 ? 7.9 : 0.8 + rnd() * 2.7);
    ev(r.id, "builder", "usage", { costUsd: cost }, new Date(start + 60_000).toISOString());
    if (status !== "running") ev(r.id, null, "run-end", { type: "run-end" }, new Date(start + mins * 60_000).toISOString());
    for (const [name, attempts] of [["planner", 1], ["builder", i % 4 === 1 ? 2 : 1], ["verifier", i % 9 === 3 ? 2 : 1]]) for (let a = 1; a <= attempts; a++) store.startPhase(r.id, name, a);
    if (i % 3 === 0 && status !== "running") {
      const n = 12 + (i % 5);
      for (let k = 0; k < n; k++) {
        const id = `q${++reqN}`;
        const t0 = start + (k + 2) * 40_000;
        const input = { command: k % 4 === 0 ? "npm test" : `ls src/${k}` };
        ev(r.id, "builder", "approval-request", { requestId: id, toolName: "Bash", toolInput: input }, new Date(t0).toISOString());
        const slow = i === 12 && k === 3;
        const deny = k === 7 && (i === 6 || i === 18);
        const took = slow ? 25 * 60_000 : deny ? 9_000 : 500 + Math.floor(rnd() * 1500);   // about two in three under 1.5 s: a habit, not a caricature
        const extra = k % 4 === 0 && i % 6 === 0 && k < 8 ? { rememberedRule: RULES[(i / 6) * 2 + k / 4] } : {};
        ev(r.id, "builder", "approval-resolved", { requestId: id, decision: deny ? "deny" : "allow", auto: false, ...extra }, new Date(t0 + took).toISOString());
        if (deny) {   // the same call asked again, and allowed: "said no, then yes"
          const id2 = `q${++reqN}`;
          ev(r.id, "builder", "approval-request", { requestId: id2, toolName: "Bash", toolInput: input }, new Date(t0 + took + 1000).toISOString());
          ev(r.id, "builder", "approval-resolved", { requestId: id2, decision: "allow", auto: false }, new Date(t0 + took + 1900).toISOString());
        }
      }
    }
  });
  ev(store.listRuns()[0].id, "builder", "approval-auto-allowed", { rule: RULES[0] }, new Date(now - day).toISOString());
  raw.close(); store.close();
}

// ---------------------------------------------------------------- run the real CLI
const cli = (args, env = {}, extraNode = []) => spawnSync(process.execPath, ["--experimental-sqlite", "--no-warnings", ...extraNode, join(root, "dist/cli.js"), ...args], {
  cwd: root, encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, FORCE_COLOR: "1", ...env },
});
const scrub = (s, dirs) => {
  let t = s;
  for (const [d, label] of dirs) if (d) t = t.split(d).join(label);
  t = t.split(homedir()).join("~").split(tmpdir()).join("<tmp>");
  // The page address ends in a per-run secret; the run is over, but a secret-shaped string does not belong in a picture.
  return t.replace(/#token=[0-9a-f]{48}/g, "#token=<per-run secret>");
};

// ---------------------------------------------------------------- ANSI -> HTML, enough for what the CLI prints
const esc = (x) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function ansiToHtml(text) {
  const colours = { 30: "#6b6a68", 31: "#e5686a", 32: "#7fc47f", 33: "#e0b24f", 34: "#6aa2e8", 35: "#c586d8", 36: "#5cc1c9", 37: "#e8e6e3", 90: "#8a8985", 91: "#ff8a8c", 92: "#9be09b", 93: "#f0c870", 94: "#8fbcff", 95: "#dba3ec", 96: "#7fd9e0", 97: "#ffffff" };
  let out = "", open = false, bold = false, dim = false, fg = null;
  const style = () => `${fg ? `color:${fg};` : ""}${bold ? "font-weight:700;" : ""}${dim ? "opacity:.65;" : ""}`;
  const flush = () => { if (open) out += "</span>"; open = false; if (style()) { out += `<span style="${style()}">`; open = true; } };
  const re = /\u001b\[([0-9;]*)m/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    last = m.index + m[0].length;
    for (const code of (m[1] || "0").split(";").map(Number)) {
      if (code === 0) { bold = false; dim = false; fg = null; }
      else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 22) { bold = false; dim = false; }
      else if (code === 39) fg = null;
      else if (colours[code]) fg = colours[code];
    }
    flush();
  }
  out += esc(text.slice(last));
  if (open) out += "</span>";
  return out.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

async function shot(browser, file, { title, note, command, output }) {
  const page = await browser.newPage({ viewport: { width: 1040, height: 400 }, deviceScaleFactor: 2 });
  const html = `<!doctype html><meta charset=utf-8><body style="margin:0;background:#161514;font:15px/1.5 ui-monospace,Menlo,Consolas,'DejaVu Sans Mono',monospace">
    <div id="win" style="margin:0;width:1040px;box-sizing:border-box;background:#1f1e1d;border:1px solid #3a3836;border-radius:10px;overflow:hidden">
      <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:#2a2826;border-bottom:1px solid #3a3836">
        <i style="width:12px;height:12px;border-radius:50%;background:#e5686a"></i><i style="width:12px;height:12px;border-radius:50%;background:#e0b24f"></i><i style="width:12px;height:12px;border-radius:50%;background:#7fc47f"></i>
        <span style="margin-left:10px;color:#a8a5a0;font-size:13px">${esc(title)}</span>
      </div>
      <div style="padding:16px 22px 22px;color:#e8e6e3">
        <div style="color:#d97757;margin-bottom:8px">$ ${esc(command)}</div>
        <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font:inherit">${ansiToHtml(output)}</pre>
        ${note ? `<div style="margin-top:14px;padding-top:10px;border-top:1px dashed #3a3836;color:#8a8985;font-size:12.5px">${esc(note)}</div>` : ""}
      </div></div>`;
  await page.setContent(html);
  const box = await page.locator("#win").boundingBox();
  await page.setViewportSize({ width: 1040, height: Math.ceil(box.height) });
  await page.locator("#win").screenshot({ path: file });
  await page.close();
  console.log(`[image] ${file}`);
}

const dataDir = join(work, "history");
seedHistory(dataDir);
const dirs = [[work, "<data>"]];

const insights = cli(["insights", "--data-dir", dataDir, "--humor", "dark", "--roast", "offline"]);
if (insights.status !== 0) throw new Error(`insights failed:\n${insights.stdout}\n${insights.stderr}`);

const doctor = cli(["doctor"]);   // exit 1 is allowed: it reports what it finds

const capData = join(work, "cap-data");
const cap = cli(["run", "Add a /health route", "--dir", join(work, "cap-ws"), "--data-dir", capData, "--port", "0", "--no-approval", "--humor", "off", "--max-cost", "0.02"], { FAKE_SCENARIO: "trivial-skip" }, ["--import", new URL("../stress/fake-sdk/register.mjs", import.meta.url).href]);
if (!/Cost cap: \$0\.02/.test(cap.stdout)) throw new Error(`the cost cap did not show:\n${cap.stdout}\n${cap.stderr}`);

const browser = await chromium.launch({ executablePath: findChrome() });
await shot(browser, join(outDir, "terminal-insights.png"), {
  title: "agent-loop insights  ·  a made-up history: 30 runs of a made-up person",
  command: "agent-loop insights",
  output: scrub(insights.stdout, dirs),
  note: "The numbers come from the audit database; the lines come from a fixed catalogue (or, with --roast api, a model that is given only the numbers). The grade is made up for fun.",
});
await shot(browser, join(outDir, "terminal-doctor.png"), {
  title: "agent-loop doctor  ·  run on the machine that made this picture",
  command: "agent-loop doctor",
  output: scrub(doctor.stdout + doctor.stderr, dirs),
  note: "Checks Node, the SQLite module, credentials, Chromium and ffmpeg; with --desktop it tells a missing display, a dead display, a locked session and a missing or wrong driver apart.",
});
await shot(browser, join(outDir, "terminal-max-cost.png"), {
  title: "agent-loop run --max-cost 0.02  ·  with the test suite's stand-in model ($0.01 a call, nothing spent)",
  command: 'agent-loop run "Add a /health route" --max-cost 0.02',
  output: scrub(cap.stdout, dirs),
  note: "The stopping is the real code; the prices are the stand-in's. The cap is checked after a step finishes, so one long step can pass it by that step's cost: it is not a hard ceiling.",
});
await browser.close();
writeFileSync(join(outDir, ".terminal-texts.json"), JSON.stringify({ insights: scrub(insights.stdout, dirs), doctor: scrub(doctor.stdout + doctor.stderr, dirs), cap: scrub(cap.stdout, dirs) }, null, 1));
console.log(`\nDone. Files are in ${outDir}`);
process.exit(0);
