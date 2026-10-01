// Records two walkthrough videos of the redesigned UI, WITH sound, for docs/media and the README:
//   ui-v3-tour      the welcome card, a run, the cat running to a waiting prompt and hopping until you answer, stars, help, light look
//   offline-dino    the server goes away mid-run, the dinosaur dialog, a bot that actually plays it, the reconnect
// Nothing calls a model: the runs are scripted events through the real server into the real page, in a real Chromium, in
// real time (the cat's movement needs the page's real animation frames, so there is no fake clock here).
//
// The page's own sound cannot be heard in a headless browser (it is muted), so the audio is *rendered offline* by the page's
// own synthesiser (AL.sound.render) from a timeline of what happened when, then muxed into the video with ffmpeg. It is
// the same notes the page plays live: the music follows the moods, the chimes land when the prompt appears.
//
//   npm run build && node --experimental-sqlite --no-warnings test/e2e/record-ui-v3.mjs [tour|dino|all] [outDir]
import { chromium } from "playwright-core";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EventBus } from "../../dist/bus.js";
import { startServer } from "../../dist/server.js";
import { chromePath, freePort } from "../ui-extras-helpers.mjs";

const which = process.argv[2] ?? "all";
const outDir = process.argv[3] ?? mkdtempSync(join(tmpdir(), "agent-loop-ui-videos-"));
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A caption bar under the app, and a visible cursor, both outside the app's own DOM and styles.
const OVERLAY = `
(() => {
  const boot = () => {
    if (document.getElementById("__cap")) return;
    const css = document.createElement("style");
    css.textContent = \`
      body { padding-bottom: 54px !important; }
      #__cap { position: fixed; left: 0; right: 0; bottom: 0; height: 54px; z-index: 99999; display: flex; align-items: center; padding: 0 22px;
        background: #141413; color: #f2efe9; font: 600 16px/1.3 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; border-top: 2px solid #d97757; }
      #__cap b { color: #d97757; margin-right: 10px; font-weight: 800; }
      #__cur { position: fixed; z-index: 100000; width: 22px; height: 22px; margin: -4px 0 0 -4px; pointer-events: none; border: 2px solid #fff; border-radius: 50%;
        background: rgba(217,119,87,.55); box-shadow: 0 0 0 2px rgba(0,0,0,.45); transition: transform .08s; }
      #__cur.down { transform: scale(.7); background: rgba(217,119,87,.95); }
    \`;
    document.head.appendChild(css);
    const cap = document.createElement("div"); cap.id = "__cap"; document.body.appendChild(cap);
    const cur = document.createElement("div"); cur.id = "__cur"; cur.style.left = "-50px"; document.body.appendChild(cur);
    addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => cur.classList.add("down"), true);
    addEventListener("mouseup", () => cur.classList.remove("down"), true);
    window.__caption = (step, text) => { cap.innerHTML = (step ? "<b>" + step + "</b>" : "") + text.replace(/&/g, "&amp;").replace(/</g, "&lt;"); };
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", boot); else boot();
})();`;

async function session(name) {
  const port = await freePort(), token = "v".repeat(48), bus = new EventBus();
  const s = { name, port, token, bus, marks: [], srv: await startServer(bus, port, { token }) };
  s.browser = await chromium.launch({ executablePath: chromePath() });
  s.ctx = await s.browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: join(outDir, `.${name}-raw`), size: { width: 1280, height: 800 } } });
  s.page = await s.ctx.newPage();
  s.t0 = Date.now();                                   // the video's clock starts about here
  await s.page.addInitScript(OVERLAY);
  await s.page.goto(`http://127.0.0.1:${port}/#token=${token}`);
  await s.page.waitForFunction(() => document.getElementById("status")?.textContent === "live");
  const runId = "demo-run";
  s.ev = (o) => bus.emitEvent({ runId, ts: new Date().toISOString(), ...o });
  /** What happened when, for the soundtrack: { mood } or { sfx } at the moment it is called. */
  s.mark = (o) => s.marks.push({ at: (Date.now() - s.t0) / 1000, ...o });
  s.caption = async (step, text, hold = 2500) => { await s.page.evaluate(([a, b]) => window.__caption && window.__caption(a, b), [step, text]); if (hold) await sleep(hold); };
  s.click = async (locator, hold = 500) => {
    const b = await locator.boundingBox();
    await s.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 24 });
    await sleep(250); await s.page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await sleep(hold);
  };
  s.finish = async () => {
    await sleep(900);
    const seconds = (Date.now() - s.t0) / 1000 + 0.5;
    // Render the soundtrack in the page, from the page's own synthesiser, then mux.
    const b64 = await s.page.evaluate(async ([secs, timeline]) => {
      const buf = await AL.sound.render(secs, timeline);
      const d = buf.getChannelData(0), n = d.length, wav = new DataView(new ArrayBuffer(44 + n * 2));
      const w = (o, str) => [...str].forEach((c, i) => wav.setUint8(o + i, c.charCodeAt(0)));
      w(0, "RIFF"); wav.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
      wav.setUint32(24, buf.sampleRate, true); wav.setUint32(28, buf.sampleRate * 2, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true); w(36, "data"); wav.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) wav.setInt16(44 + i * 2, Math.max(-1, Math.min(1, d[i])) * 32767, true);
      let bin = ""; const bytes = new Uint8Array(wav.buffer);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }, [seconds, s.marks]);
    const wavPath = join(outDir, `.${name}.wav`);
    writeFileSync(wavPath, Buffer.from(b64, "base64"));
    await s.ctx.close();
    const raw = await s.page.video().path();
    await s.browser.close();
    try { await s.srv.close(); } catch { /* already closed by the script */ }
    const webm = join(outDir, `${name}.webm`);
    renameSync(raw, webm);
    const mp4 = join(outDir, `${name}.mp4`);
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-i", wavPath, "-map", "0:v", "-map", "1:a", "-af", "dynaudnorm=f=150:g=21:p=0.95,loudnorm=I=-18:TP=-2:LRA=9", "-ar", "44100", "-ac", "2", "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", mp4]);
    rmSync(join(outDir, `.${name}-raw`), { recursive: true, force: true }); rmSync(wavPath, { force: true });
    if (r.status === 0) rmSync(webm, { force: true });
    console.log(`[recorded] ${name}: ${r.status === 0 ? mp4 : webm + " (ffmpeg failed: " + r.stderr + ")"}  (${seconds.toFixed(0)} s)`);
    return r.status === 0 ? mp4 : webm;
  };
  return s;
}
const verdict = (outcome, headline) => ({ completed: true, outcome, headline, details: "", concerns: [], blockingFindings: [] });

// ------------------------------------------------------------------ the tour
async function tour() {
  const s = await session("ui-v3-tour");
  const { page } = s;
  const WD = "/home/dev/todo-app";
  const approval = async (toolName, toolInput, label) => {
    const { requestId } = s.bus.requestApproval({ runId: "demo-run", phase: "builder", toolUseId: "tu-" + Math.random().toString(36).slice(2, 7), toolName, toolInput, rule: label });
    s.mark({ sfx: "prompt" }); s.mark({ mood: "attention" });
    return requestId;
  };

  await s.caption("1", "The page, redone: a welcome card, pixel icons for every agent — and a cat.", 3600);
  await s.caption("2", "Sound is off until you turn it on. ♪ cycles off → blips → music; it is all generated in the browser.", 1200);
  await s.click(page.locator("#sound-toggle"), 300); await s.click(page.locator("#sound-toggle"), 600);
  s.mark({ mood: "idle" });
  await sleep(1800);

  await s.caption("3", "A run starts. The cat walks down to the input box and dances while an agent works.", 0);
  s.mark({ mood: "working" });
  s.ev({ type: "run-start", task: "Add a /health route that returns uptime", workDir: WD });
  await sleep(500);
  s.ev({ type: "phase-start", phase: "planner", attempt: 1 });
  await sleep(700);
  s.ev({ type: "tool-call", phase: "planner", toolUseId: "p1", toolName: "Read", toolInput: { file_path: WD + "/server.js" } }); await sleep(300);
  s.ev({ type: "tool-result", phase: "planner", toolUseId: "p1", toolName: "", isError: false, summary: "const http = require('http');\nconst PORT = 3000;\n// routes live below" }); await sleep(900);
  s.ev({ type: "tool-call", phase: "planner", toolUseId: "p2", toolName: "Glob", toolInput: { pattern: "**/*.js" } }); await sleep(300);
  s.ev({ type: "tool-result", phase: "planner", toolUseId: "p2", toolName: "", isError: false, summary: "server.js\ntest/health.test.js" });
  await sleep(2800);
  s.ev({ type: "assistant-text", phase: "planner", text: "I'll add **/health** next to `/ping`, and a test for it." });
  s.ev({ type: "phase-end", phase: "planner", attempt: 1, verdict: verdict("pass", "Wrote PLAN.md") }); s.mark({ sfx: "pass" });
  await sleep(800);
  s.ev({ type: "overseer-decision", phase: "planner", decision: { action: "continue", reasoning: "The plan is specific enough to build." } });
  await page.evaluate(() => AL.mascot.react("charge", 1400)); // what the page does itself for a live Overseer decision
  await sleep(1500);
  s.ev({ type: "phase-start", phase: "builder", attempt: 1 });
  await sleep(1200);
  s.ev({ type: "tool-call", phase: "builder", toolUseId: "b0", toolName: "Write", toolInput: { file_path: WD + "/server.js", content: "// /health added" } }); await sleep(250);
  s.ev({ type: "tool-result", phase: "builder", toolUseId: "b0", toolName: "", isError: false, summary: "File updated" });
  await sleep(1500);

  await s.caption("4", "An agent needs you. The cat runs to the prompt, stands on its edge and hops until you answer.", 0);
  s.ev({ type: "tool-call", phase: "builder", toolUseId: "b1", toolName: "Bash", toolInput: { command: "npm test" } });
  await approval("Bash", { command: "npm test" }, "Bash(npm test)");
  await page.waitForSelector("#prompt");
  await sleep(6500);

  await s.caption("5", "Every prompt says in words what it asks. You answer, and the cat goes home.", 0);
  await s.click(page.locator('#prompt .opt[data-choice="allow"]'), 300);
  s.mark({ sfx: "allow" }); s.mark({ mood: "working" });
  s.ev({ type: "tool-result", phase: "builder", toolUseId: "b1", toolName: "", isError: false, summary: "PASS test/health.test.js\n  ✓ GET /health returns uptime\n\nTests: 1 passed" });
  await sleep(3200);

  await s.caption("6", "Done: stars. Click the cat — it does nothing useful, but it is friendly.", 0);
  s.ev({ type: "phase-end", phase: "builder", attempt: 1, verdict: verdict("pass", "Built it, tests pass") }); s.mark({ sfx: "pass" });
  s.ev({ type: "usage", phase: "builder", role: "phase", costUsd: 0.42, turns: 5, durationMs: 90000 });
  await sleep(700);
  s.ev({ type: "run-end", status: "done" }); s.mark({ mood: "done" }); s.mark({ sfx: "win" });
  await page.waitForSelector(".blk.run-end");
  await sleep(3500);
  const catBox = await page.locator("#cat .cat-body").boundingBox();
  await s.click(page.locator("#cat .cat-body"), 0); s.mark({ sfx: "meow" });
  await sleep(2400);

  await s.caption("7", "Press ? for the shortcuts, options and credits. t flips to the tree. m cycles the sound.", 0);
  await page.keyboard.press("?"); await sleep(4200); await page.keyboard.press("Escape"); await sleep(500);
  await s.caption("8", "A light look too — pick whichever suits you. (The soundtrack here is the page's own music, rendered offline.)", 0);
  await s.click(page.locator("#theme-toggle"), 2800);
  await s.click(page.locator("#theme-toggle"), 1200);
  void catBox;
  return s.finish();
}

// ------------------------------------------------------------------ the offline dinosaur
async function dino() {
  const s = await session("offline-dino");
  const { page } = s;
  await s.caption("1", "A run is going. Then the page loses its server — crashed, or the terminal closed.", 0);
  s.ev({ type: "run-start", task: "Add a /health route that returns uptime", workDir: "/home/dev/todo-app" });
  s.ev({ type: "phase-start", phase: "builder", attempt: 1 });
  s.mark({ mood: "idle" }); s.mark({ mood: "working" });
  s.ev({ type: "tool-call", phase: "builder", toolUseId: "w1", toolName: "Write", toolInput: { file_path: "/home/dev/todo-app/server.js", content: "x" } });
  s.ev({ type: "tool-result", phase: "builder", toolUseId: "w1", toolName: "", isError: false, summary: "File updated" });
  await sleep(3600);
  await s.srv.close();
  await page.waitForSelector("#offline:not([hidden])", { timeout: 8000 });
  await s.caption("2", "Instead of freezing, it says so, counts the attempts — and lets you play Chrome's dinosaur while it keeps trying.", 3800);

  await s.caption("3", "Space jumps, ↓ ducks. (A bot is playing here.)", 0);
  await page.keyboard.press("Space"); s.mark({ sfx: "jump" });
  const until = Date.now() + 16000;
  let last = 0;
  while (Date.now() < until) {
    const g = await page.evaluate(() => AL.offline.state());
    if (g.over) break;
    // jump when the nearest cactus is about 0.36 s from being under the dinosaur
    const ahead = g.obs.filter((x) => x > 38).sort((a, b) => a - b)[0];
    if (ahead !== undefined && g.y === 0 && ahead <= 38.5 + 0.36 * g.speed && Date.now() - last > 500) { await page.keyboard.press("Space"); s.mark({ sfx: "jump" }); last = Date.now(); }
    await sleep(20);
  }
  const g = await page.evaluate(() => AL.offline.state());
  await s.caption("4", `Score ${g.score}. It dies sooner or later — the best score is remembered.`, 0);
  // let it hit one
  while (!(await page.evaluate(() => AL.offline.state().over))) await sleep(30);
  s.mark({ sfx: "die" });
  await sleep(2200);

  await s.caption("5", "The server comes back: the dialog leaves by itself, the run is replayed, and nothing was lost.", 0);
  s.srv = await startServer(s.bus, s.port, { token: s.token });
  await page.waitForFunction(() => document.getElementById("offline").hidden === true, undefined, { timeout: 10000 });
  s.mark({ sfx: "pass" });
  await sleep(1500);
  s.ev({ type: "phase-end", phase: "builder", attempt: 1, verdict: verdict("pass", "Built it") });
  s.ev({ type: "run-end", status: "done" }); s.mark({ mood: "done" }); s.mark({ sfx: "win" });
  await sleep(3800);
  return s.finish();
}

if (which === "tour" || which === "all") await tour();
if (which === "dino" || which === "all") await dino();
