// Records walkthrough videos of agent-loop's features, in the real web UI in a real Chromium, for
// docs/media and the README. Nothing here calls a model: the runs are the deterministic simulated runs
// from test/persona-sim.mjs (shaped from numbers in real runs) and hand-written event scripts, played
// through the real server, tracker, persona director and page. The page's clock is controlled (Playwright's
// page.clock), so a 36-minute run's header timer and every timestamp agree with the events instead of
// racing real time. Captions explain each step; a cursor makes the clicks visible.
//
//   npm run build && node --experimental-sqlite --no-warnings test/e2e/record-features.mjs [lineage|persona|desktop|all] [outDir]
//
// Writes <name>.webm to outDir (default: a temp dir) and, with ffmpeg, <name>.mp4 next to it.
import { chromium } from "playwright-core";
import { readdirSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EventBus } from "../../dist/bus.js";
import { startServer } from "../../dist/server.js";
import { LineageTracker, buildLineage, renderLineageText } from "../../dist/lineage.js";
import { PersonaDirector } from "../../dist/persona.js";
import { simulateRun } from "../persona-sim.mjs";

const which = process.argv[2] ?? "all";
const outDir = process.argv[3] ?? mkdtempSync(join(tmpdir(), "agent-loop-videos-"));
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

function findChrome() {
  if (process.env.AGENT_LOOP_CHROME_PATH) return process.env.AGENT_LOOP_CHROME_PATH;
  const root = "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => d.startsWith("chromium-"));
  const exe = dir && join(root, dir, "chrome-linux", "chrome");
  return exe && existsSync(exe) ? exe : undefined;
}

// A caption bar under the app and a visible cursor, both outside the app's own DOM and styles.
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

async function session(name, { humor = "dark", simStart, artifactRoot, director = false, tracker = true } = {}) {
  const bus = new EventBus();
  if (tracker) new LineageTracker(bus).attach();
  if (director) new PersonaDirector(bus, { level: "dark", clock: { hourOf: () => 15, dayOf: () => 2 } }).attach();
  const srv = await startServer(bus, 0, { humor, artifactRoot });
  const browser = await chromium.launch({ executablePath: findChrome() });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: join(outDir, `.${name}-raw`), size: { width: 1280, height: 800 } } });
  const page = await ctx.newPage();
  await page.addInitScript(OVERLAY);
  const start = Date.parse(simStart ?? "2026-10-01T14:00:00Z");
  await page.clock.install({ time: start });
  await page.goto(srv.url);
  await page.clock.pauseAt(start + 500);
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "live");
  let now = start + 500;
  const api = {
    bus, page, srv,
    get now() { return now; },
    /** Moves the page's clock to a simulated time, instantly. */
    async advanceTo(ms) { if (ms > now) { await page.clock.runFor(ms - now); now = ms; } },
    /** Plays one event: the page's clock catches up to its timestamp, then it goes through the bus. */
    async play(e, { pause = 0 } = {}) {
      if (e.ts) await api.advanceTo(Date.parse(e.ts));
      bus.emitEvent(e);
      await tick();
      if (pause) await sleep(pause);
    },
    async caption(step, text, hold = 2500) { await page.evaluate(([s, t]) => window.__caption && window.__caption(s, t), [step, text]); if (hold) await sleep(hold); },
    /** Glides the cursor to an element, then clicks it. */
    async click(locator, { hold = 500 } = {}) {
      const box = await locator.boundingBox();
      if (!box) throw new Error("nothing to click");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 });
      await sleep(250);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(hold);
    },
    async hover(locator, hold = 600) {
      const box = await locator.boundingBox();
      if (box) await page.mouse.move(box.x + Math.min(box.width / 2, 120), box.y + Math.min(box.height / 2, 14), { steps: 20 });
      await sleep(hold);
    },
    async finish() {
      await sleep(800);
      await ctx.close();
      const raw = await page.video().path();
      await browser.close();
      await srv.close();
      const webm = join(outDir, `${name}.webm`);
      renameSync(raw, webm);
      const mp4 = join(outDir, `${name}.mp4`);
      const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-c:v", "libx264", "-preset", "slow", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4]);
      rmSync(join(outDir, `.${name}-raw`), { recursive: true, force: true });
      if (r.status === 0) rmSync(webm, { force: true });
      console.log(`[recorded] ${name}: ${r.status === 0 ? mp4 : webm + " (ffmpeg missing or failed; the .webm is what there is)"}`);
      return r.status === 0 ? mp4 : webm;
    },
  };
  return api;
}

const verdict = (outcome, headline, extra = {}) => ({ completed: true, outcome, headline, details: "", concerns: [], blockingFindings: [], ...extra });

// ---------------------------------------------------------------- lineage
async function lineage() {
  const s = await session("lineage-tree", { humor: "off", simStart: "2026-10-01T14:00:00Z" });
  const RUN = "demo-run";
  let t = 0, id = 0;
  const at = (dt) => new Date(Date.parse("2026-10-01T14:00:00Z") + 1000 + (t += dt) * 1000).toISOString();
  const ev = (e, dt = 5, pause = 220) => s.play({ runId: RUN, ts: at(dt), ...e }, { pause });
  const tool = async (phase, name, input, summary = "ok", ok = true, dt = 3) => {
    const u = `t${++id}`;
    await ev({ type: "tool-call", phase, toolUseId: u, toolName: name, toolInput: input }, dt, 120);
    await ev({ type: "tool-result", phase, toolUseId: u, toolName: name, isError: !ok, summary }, 1, 140);
  };
  const events = [];
  const events_ = events; void events_;

  await s.caption("1", "A run is five agents handing work to each other. Here is one, running.", 2500);
  await ev({ type: "run-start", task: "Add a dark-mode toggle to the settings page", workDir: "/work/app" }, 1);
  await ev({ type: "phase-start", phase: "planner", attempt: 1 }, 1);
  await tool("planner", "Read", { file_path: "/work/app/src/settings.js" }, "(48 lines)");
  await tool("planner", "Glob", { pattern: "src/**/*.css" }, "src/theme.css");
  await ev({ type: "usage", phase: "planner", role: "phase", costUsd: 0.24, turns: 3, durationMs: 1 }, 8, 100);
  await ev({ type: "phase-end", phase: "planner", attempt: 1, verdict: verdict("pass", "Plan written: two files and one test", { details: "Toggle in settings.js, persisted in localStorage, one Playwright test.", concerns: ["no design for the icon yet"] }) }, 20);
  await ev({ type: "overseer-decision", phase: "planner", decision: { action: "continue", reasoning: "the plan is specific enough to build" } }, 1);
  await ev({ type: "phase-start", phase: "builder", attempt: 1 }, 1);
  await tool("builder", "Write", { file_path: "/work/app/src/settings.js" }, "wrote 61 lines");
  await tool("builder", "Write", { file_path: "/work/app/src/theme.css" }, "wrote 24 lines");
  await tool("builder", "Edit", { file_path: "/work/app/src/settings.js" }, "edited");
  await tool("builder", "Write", { file_path: "/work/app/.env" }, "refused: you said no", false);
  await ev({ type: "approval-request", phase: "builder", requestId: "q1", toolUseId: "q1", toolName: "Bash", toolInput: { command: "npm test" } }, 4, 900);
  await ev({ type: "approval-resolved", phase: "builder", requestId: "q1", toolUseId: "q1", decision: "allow", auto: false }, 3);
  await ev({ type: "usage", phase: "builder", role: "phase", costUsd: 0.62, turns: 9, durationMs: 1 }, 5, 100);
  await ev({ type: "phase-end", phase: "builder", attempt: 1, verdict: verdict("pass", "Toggle renders and switches the theme") }, 60);
  await ev({ type: "overseer-decision", phase: "builder", decision: { action: "continue", reasoning: "tests pass" } }, 1);
  await ev({ type: "phase-start", phase: "verifier", attempt: 1 }, 1);
  await tool("verifier", "Bash", { command: "node tests/theme.spec.js" }, "1 failing: theme not restored after reload", false);
  await s.caption("2", "The Verifier finds a bug. The Overseer sends the run back to the Builder.", 1500);
  await ev({ type: "phase-end", phase: "verifier", attempt: 1, verdict: verdict("fail", "The choice is lost on reload", { blockingFindings: ["Theme isn't persisted across page loads"] }) }, 30);
  await ev({ type: "overseer-decision", phase: "verifier", decision: { action: "repair", repairTarget: "builder", reasoning: "persist it, then verify again", feedbackForRepair: "read and write localStorage" } }, 1, 800);
  await ev({ type: "trusted-decision-recorded", phase: "builder", text: "Use localStorage, not cookies" }, 2);
  await ev({ type: "phase-start", phase: "builder", attempt: 2 }, 1);
  await tool("builder", "Edit", { file_path: "/work/app/src/settings.js" }, "edited");
  await tool("builder", "Write", { file_path: "/work/app/tests/theme.spec.js" }, "wrote 30 lines");
  await ev({ type: "usage", phase: "builder", role: "phase", costUsd: 0.31, turns: 5, durationMs: 1 }, 5, 100);
  await ev({ type: "phase-end", phase: "builder", attempt: 2, verdict: verdict("pass", "Theme is saved and restored") }, 30);
  await ev({ type: "overseer-decision", phase: "builder", decision: { action: "continue", reasoning: "fixed" } }, 1);
  await ev({ type: "phase-start", phase: "verifier", attempt: 2 }, 1);
  await ev({ type: "phase-end", phase: "verifier", attempt: 2, verdict: verdict("pass", "Verified in the browser") }, 35);
  await ev({ type: "overseer-decision", phase: "verifier", decision: { action: "continue", reasoning: "good" } }, 1);
  await ev({ type: "phase-start", phase: "gatekeeper", attempt: 1 }, 1);
  await ev({ type: "phase-end", phase: "gatekeeper", attempt: 1, verdict: verdict("pass", "Ready to ship") }, 28);
  await ev({ type: "overseer-decision", phase: "gatekeeper", decision: { action: "continue", reasoning: "done" } }, 1);
  await ev({ type: "run-end", status: "done" }, 1, 1200);

  await s.caption("3", "Now the same run as a tree. One click on “tree” in the header.", 1500);
  const page = s.page;
  await s.click(page.locator("#view-toggle"), { hold: 2500 });
  await s.caption("4", "Each dot is one attempt, in order. The repair branches off the attempt that failed and rejoins.", 1000);
  await page.locator('#tree .tn[data-id="verifier#1"]').scrollIntoViewIfNeeded();
  await s.hover(page.locator('#tree .tn[data-id="builder#2"] .hd'), 4500);
  await s.caption("5", "What each agent handed on to the next one — one click opens the full note.", 800);
  await s.click(page.locator('#tree .tn[data-id="planner#1"] summary', { hasText: "what it told the next phase" }), { hold: 3200 });
  await s.caption("6", "Which files it wrote. Only writes that succeeded count — the refused .env write is counted, never listed.", 800);
  await page.locator('#tree .tn[data-id="builder#1"]').scrollIntoViewIfNeeded();
  await s.click(page.locator('#tree .tn[data-id="builder#1"] summary', { hasText: "written or edited" }), { hold: 4500 });
  await s.caption("7", "Who made what: per agent, and per file — which attempts touched it, in order.", 800);
  await page.evaluate(() => { document.getElementById("tree").scrollTo({ top: 1e9, behavior: "smooth" }); });
  await sleep(5000);
  await s.caption("8", "The transcript is one click back.", 800);
  await page.evaluate(() => { document.getElementById("tree").scrollTo({ top: 0, behavior: "smooth" }); });
  await sleep(700);
  await s.click(page.locator("#view-toggle"), { hold: 1800 });

  // The same tree from a terminal, for any recorded run.
  const text = renderLineageText(buildLineage(s.bus.allEvents().filter((e) => e.type !== "lineage-updated"), RUN));
  const esc = (x) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><meta charset=utf-8><body style="margin:0;background:#1f1e1d;color:#e8e6e3;font:15px/1.45 ui-monospace,Menlo,Consolas,monospace;padding:26px 34px 70px"><div style="color:#d97757;margin-bottom:10px">$ agent-loop lineage</div><pre style="margin:0;white-space:pre-wrap">${esc(text)}</pre>`));
  await page.evaluate(() => { document.body.style.paddingBottom = "70px"; });
  await s.caption("9", "From a terminal: agent-loop lineage, for any recorded run — as text, JSON or markdown. Every run also saves lineage.md and lineage.json.", 9000);
  return s.finish();
}

// ---------------------------------------------------------------- persona
async function persona() {
  const s = await session("persona-voice", { humor: "dark", director: true, tracker: false, simStart: "2026-10-01T14:00:00Z" });
  const page = s.page;
  await s.caption("1", "Agents with a personality — and a leash. Even the idle screen has a voice.", 1800);
  await s.advanceTo(s.now + 9000); await sleep(1800);
  await s.caption("2", "Three levels, per page: dark, dry, off. The run's own setting is the ceiling.", 800);
  for (let i = 0; i < 3; i++) { await s.click(page.locator("#humor-toggle"), { hold: 400 }); await s.advanceTo(s.now + 8000); await sleep(1500); }
  await s.caption("3", "Now a run. Each agent introduces itself, in its own voice.", 1200);
  const { events } = simulateRun("rough", { runId: "demo-run", startMs: s.now + 2000 });
  const shown = events.filter((e) => e.type !== "tool-call");
  let seenNote = 0;
  const marks = { veto: false, streak: false, awards: false };
  for (const e of shown) {
    // Approval prompts stay up long enough to read; the rest plays quickly.
    const isAsk = e.type === "approval-request";
    await s.play(e, { pause: isAsk ? 380 : e.type === "phase-start" || e.type === "overseer-decision" ? 380 : 60 });
    if (e.type === "overseer-decision" && e.decision.action === "repair" && !marks.veto) {
      marks.veto = true;
      await s.caption("4", "A veto — and the agent that was sent back replies. They talk to each other.", 4200);
    }
    if (isAsk && !marks.streak && s.bus.allEvents().filter((x) => x.type === "persona-note" && x.moment === "approval-denial-streak").length) {
      marks.streak = true;
    }
    if (e.type === "approval-request" && e.requestId === "r4") {
      await s.caption("5", "An approval prompt never has a joke in it — it's the one place that has to be exact.", 3800);
    }
    if (e.type === "run-end" && !marks.awards) marks.awards = true;
    seenNote = s.bus.allEvents().filter((x) => x.type === "persona-note").length;
  }
  void seenNote;
  await page.evaluate(() => { document.getElementById("scroll").scrollTo({ top: 1e9, behavior: "smooth" }); });
  await s.caption("6", "At the end: awards from the run's own numbers — who was sent back most, who cost the most, how fast you answered.", 6500);
  await s.caption("7", "It notices how you use the tool: three refusals in a row, five approvals in a blink, a long wait.", 4500);
  await s.caption("8", "Turn it down to dry: the dark lines disappear.", 800);
  await s.click(page.locator("#humor-toggle"), { hold: 1200 }); // off
  await s.click(page.locator("#humor-toggle"), { hold: 2500 }); // dry (cycle: dark -> off -> dry)
  await s.caption("9", "Off: no jokes at all. It is display-only: it never reaches a model.", 800);
  await s.click(page.locator("#humor-toggle"), { hold: 1200 });
  await s.click(page.locator("#humor-toggle"), { hold: 2600 });
  return s.finish();
}

// ---------------------------------------------------------------- desktop UI
async function desktop() {
  const root = mkdtempSync(join(tmpdir(), "agent-loop-desktop-video-"));
  const RUN = "demo-run";
  mkdirSync(join(root, RUN), { recursive: true });
  const demo1 = join(process.cwd(), "docs", "screenshots", "desktop", "01-window-capture.png");
  copyFileSync(demo1, join(root, RUN, "cap1.png"));
  copyFileSync(demo1, join(root, RUN, "cap2.png")); // the typed text is refused later in this video, so no capture may show it
  const s = await session("desktop-agent-ui", { humor: "off", artifactRoot: root, simStart: "2026-10-01T14:00:00Z" });
  const page = s.page;
  let t = 0, id = 0;
  const base = Date.parse("2026-10-01T14:00:00Z");
  const ts = (dt = 3) => new Date(base + 1000 + (t += dt) * 1000).toISOString();
  const ev = (e, dt = 3, pause = 250) => s.play({ runId: RUN, ts: ts(dt), ...e }, { pause });
  const TITLE = "AgentLoop Test App | ready";
  const ask = async (toolName, toolInput, rule) => {
    const toolUseId = `d${++id}`;
    await ev({ type: "tool-call", phase: "verifier", toolUseId, toolName, toolInput }, 2, 150);
    const { requestId, wait } = s.bus.requestApproval({ runId: RUN, phase: "verifier", toolUseId, toolName, toolInput, rule });
    wait.then((d) => s.bus.emitEvent({ type: "approval-resolved", runId: RUN, phase: "verifier", requestId, toolUseId, decision: d.decision, auto: false, ts: ts(2) }));
    await page.waitForSelector("#prompt");
    return requestId;
  };

  await s.caption("1", "Desktop control: you choose ONE window before the run starts. The agent can see and operate that window — nothing else.", 800);
  await ev({ type: "run-start", task: "Verify the settings dialog in the desktop app", workDir: "/work/app" }, 1);
  await ev({ type: "phase-start", phase: "verifier", attempt: 1 }, 1);
  await ev({ type: "desktop-session-started", target: { processName: "python3.12", appName: "Tk", pid: 4242, windowId: "8388611", title: TITLE }, driverVersion: "0.30.4" }, 1, 2500);
  await s.caption("2", "“capture” returns that window's pixels (never the whole screen) and a snapshot id.", 800);
  await ev({ type: "desktop-snapshot", snapshotId: "dshot-1", title: TITLE, width: 420, height: 260, screenshotPath: "/x/cap1.png" }, 2, 200);
  await ev({ type: "desktop-action-started", actionId: "a1", toolName: "capture", input: {} }, 0, 100);
  await ev({ type: "desktop-action-completed", actionId: "a1", toolName: "capture", isError: false, durationMs: 5, result: 'Window python3.12 (pid 4242, window 8388611).\nSnapshot dshot-1: 420x260 px.\n[d1e1] push-button "Increment"\n[d1e2] text "Name"' }, 0, 3200);
  await s.caption("3", "Every input action asks a human first, one at a time — here, a click, shown on the window exactly as it was captured.", 800);
  const r1 = await ask("mcp__desktop__click", { x: 105, y: 65, snapshotId: "dshot-1" });
  await sleep(4200);
  await s.caption("4", "No “don't ask again” for input: approving one click never approves the next.", 3500);
  await s.click(page.locator('#prompt .opt[data-choice="allow"]'), { hold: 900 });
  await page.waitForFunction(() => !document.querySelector("#prompt"));
  await ev({ type: "desktop-snapshot", snapshotId: "dshot-2", title: "AgentLoop Test App | count=1", width: 420, height: 260, screenshotPath: "/x/cap2.png" }, 2, 200);
  await ev({ type: "desktop-action-started", actionId: "a2", toolName: "click", input: {} }, 0, 100);
  await ev({ type: "desktop-action-completed", actionId: "a2", toolName: "click", isError: false, durationMs: 220, result: "Clicked (105, 65). Window title is now: AgentLoop Test App | count=1" }, 0, 1800);
  await s.caption("5", "Typing: the exact text is shown, with invisible characters made visible — so what you read is what lands.", 800);
  await ask("mcp__desktop__type_text", { text: "hello from the agent\n\u001b[2J", snapshotId: "dshot-2" });
  await sleep(4200);
  await s.click(page.locator('#prompt .opt[data-choice="deny"]'), { hold: 400 });
  await sleep(300);
  await page.keyboard.type("not that one, it has a control code in it", { delay: 25 });
  await sleep(500);
  await page.keyboard.press("Enter");
  await sleep(1500);
  await ev({ type: "desktop-action-started", actionId: "a3", toolName: "type_text", input: {} }, 0, 100);
  await ev({ type: "desktop-action-completed", actionId: "a3", toolName: "type_text", isError: true, durationMs: 1, result: "Refused: you said no. Nothing was sent." }, 0, 600);
  await s.caption("6", "You said no: nothing is sent, and the agent is told why. Refused actions are counted, not hidden.", 4000);
  await s.caption("7", "The panel follows every capture; pin an older one, or jump back to live.", 800);
  await s.click(page.locator("#desktop-panel .desk-gallery img").first(), { hold: 1800 });
  const jump = page.locator("#desktop-panel .desk-jump-live");
  if (await jump.count()) await s.click(jump, { hold: 1500 });
  await ev({ type: "desktop-session-ended", status: "completed" }, 4, 1500);
  await s.caption("8", "Terminals, shells, IDEs, browsers and password managers are refused as targets. Never under --no-approval.", 4800);
  return s.finish();
}

const todo = which === "all" ? ["lineage", "persona", "desktop"] : [which];
for (const name of todo) {
  if (name === "lineage") await lineage();
  else if (name === "persona") await persona();
  else if (name === "desktop") await desktop();
  else throw new Error(`unknown scene ${name}`);
}
console.log(`\nDone. Files are in ${outDir}`);
process.exit(0);
