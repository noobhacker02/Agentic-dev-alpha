// "Can't reach agent-loop" and the dinosaur (ui/offline.js), in a real Chromium against a real server that really
// goes away and comes back: the screen waits a moment so a blip never shows it, appears, counts attempts, plays,
// keeps the page's other keys quiet, and leaves by itself when the server returns (one socket, no duplicates).
// It must never appear for a finished run or a saved report. No API calls:
//   npm run build && npm run test:ui-offline
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { writeRunReport } from "../dist/report.js";
import { harness, chromePath } from "./ui-extras-helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const game = (page) => page.evaluate(() => AL.offline.state());
const ink = (page) => page.evaluate(() => {
  const c = document.getElementById("dino"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let grey = 0, paper = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i] === 83 && d[i + 1] === 83 && d[i + 2] === 83) grey++; else if (d[i] === 247) paper++; }
  return { grey, paper, w: c.width, h: c.height };
});

// ---------- 1. the server goes away mid-run, and comes back
{
  const h = await harness();
  const { page } = h;
  const sockets = [];
  page.on("websocket", (w) => sockets.push(w));
  await h.open(); h.startRun();
  await page.waitForSelector(".phase-sep");
  assert.strictEqual(await page.locator("#offline").count(), 0, "while connected there is no overlay at all");

  const t0 = Date.now();
  await h.srv.close();
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("disconnected"));
  assert.ok((await page.locator("#offline").count()) === 0 || (await page.locator("#offline").isHidden()), "a dropped connection does not flash the screen at once");
  await page.waitForSelector("#offline:not([hidden])", { timeout: 5000 });
  const after = Date.now() - t0;
  assert.ok(after >= 800, `the screen waited out blips before showing (${after} ms)`);
  assert.strictEqual(await page.locator("#off-title").innerText(), "Can't reach agent-loop");
  assert.strictEqual(await page.getAttribute("#offline", "role"), "alertdialog");
  assert.strictEqual(await page.evaluate(() => document.activeElement && document.activeElement.id), "offline", "focus moves into the dialog");
  const first = +/\d+/.exec(await page.locator("#off-attempt").innerText())[0];
  await sleep(3600);
  const later = +/\d+/.exec(await page.locator("#off-attempt").innerText())[0];
  assert.ok(later > first, `the attempt counter climbs while it keeps trying (${first} → ${later})`);
  console.log("[ok] the server dies mid-run: no flash for a blip, then a dialog, focus inside it, attempts counted");

  // the dinosaur is drawn from the sprites, in the right place
  const idle = await ink(page);
  assert.ok(idle.grey > 700 && idle.paper > idle.grey * 4, `dino and ground are drawn in the sprite grey on paper: ${JSON.stringify(idle)}`);
  assert.ok(idle.w === 600 || idle.w === 1200, `a 600px-wide 4:1 canvas (${idle.w}x${idle.h})`);
  assert.strictEqual(idle.h * 4, idle.w, "the canvas is 4:1 like Chrome's");
  assert.strictEqual((await game(page)).playing, false, "it waits for you to start");

  // keys: the page's own shortcuts are quiet while it is up
  await page.keyboard.press("t"); await page.keyboard.press("?");
  assert.ok(await page.locator("#tree").isHidden(), "t does not switch views behind the dialog");
  assert.ok(await page.locator("#help").isHidden(), "? does not open help behind the dialog");

  // play: jump, duck, score, die, high score, restart
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
  // Conditions, not fixed sleeps: the game caps each frame's time step, so on a loaded machine game time runs slower than the clock.
  await page.waitForFunction(() => AL.offline.state().y > 5, undefined, { timeout: 4000 }).catch(() => {});
  assert.ok((await game(page)).y > 5, "Space makes the dino leave the ground");
  await page.waitForFunction(() => AL.offline.state().y === 0 || AL.offline.state().over, undefined, { timeout: 10000 });
  assert.strictEqual((await game(page)).y, 0, "and come back down");
  await page.keyboard.down("ArrowDown");
  assert.strictEqual((await game(page)).duck, true, "↓ ducks");
  await page.keyboard.up("ArrowDown");
  assert.strictEqual((await game(page)).duck, false, "releasing ↓ stands up");
  await page.waitForFunction(() => AL.offline.state().score > 0 || AL.offline.state().over, undefined, { timeout: 6000 });
  assert.ok((await game(page)).score > 0, "the score runs");
  const a = (await ink(page)).grey; await sleep(250); const b = (await ink(page)).grey;
  assert.ok(a !== b || (await game(page)).over, "the picture changes as it runs");
  let over;
  for (let i = 0; i < 60 && !(over = (await game(page))).over; i++) await sleep(250); // never jump again: a cactus gets it
  assert.ok(over.over && over.score > 0, `it ends when a cactus hits: ${JSON.stringify(over)}`);
  assert.strictEqual(await page.evaluate(() => localStorage.getItem("agent-loop-dino-hi")), String(over.score), "the best score is remembered");
  assert.ok((await ink(page)).grey > idle.grey, "GAME OVER and the restart arrow are drawn");
  await page.keyboard.press("Space");
  const again = await game(page);
  assert.ok(again.playing && !again.over && again.score < over.score + 1 && again.hi === over.score, `Space starts over and keeps the best: ${JSON.stringify(again)}`);
  console.log("[ok] the dinosaur: drawn from your sprites on a 4:1 canvas, jumps, ducks, scores, dies on a cactus, remembers the best, restarts; the page's other keys stay quiet");

  // the server comes back: the dialog leaves by itself, the run is replayed, and there is exactly one socket
  await h.restartServer();
  await page.waitForFunction(() => document.getElementById("offline").hidden === true, undefined, { timeout: 8000 });
  assert.strictEqual(await page.locator("#status").innerText(), "live");
  assert.ok((await page.locator(".phase-sep").count()) >= 1, "the run is replayed");
  assert.deepStrictEqual(await game(page), { shown: false, playing: false, over: false, score: 0, hi: 0, y: 0, duck: false, speed: 0, obs: [] }, "the game stopped");
  assert.strictEqual(sockets.filter((w) => !w.isClosed()).length, 1, "exactly one live socket after the reconnect");
  console.log("[ok] the server returns: the dialog leaves by itself, the run is replayed, one socket, the game stops");

  // "Retry now" reconnects at once instead of waiting out the timer
  await h.srv.close();
  await page.waitForSelector("#offline:not([hidden])", { timeout: 5000 });
  const n = await page.evaluate(() => AL.offline.attempt);
  await page.waitForFunction((k) => AL.offline.attempt > k, n, { timeout: 5000 }); // a try just failed: the next is 1.5 s away
  await h.restartServer();
  const c0 = Date.now();
  await page.locator("#off-retry").click();
  await page.waitForFunction(() => document.getElementById("status").textContent === "live", undefined, { timeout: 5000 });
  assert.ok(Date.now() - c0 < 1000, `Retry now did not wait for the timer (${Date.now() - c0} ms)`);
  assert.strictEqual(sockets.filter((w) => !w.isClosed()).length, 1, "still exactly one live socket after Retry now");
  // hammering it with the server up must still leave exactly one socket: a click while one is opening does nothing
  await h.srv.close();
  await page.waitForSelector("#offline:not([hidden])", { timeout: 5000 });
  const m = await page.evaluate(() => AL.offline.attempt);
  await page.waitForFunction((k) => AL.offline.attempt > k, m, { timeout: 5000 });
  await h.restartServer();
  await page.evaluate(() => { for (let i = 0; i < 6; i++) document.getElementById("off-retry").click(); }); // six clicks in the same tick
  await page.waitForFunction(() => document.getElementById("status").textContent === "live", undefined, { timeout: 5000 });
  await sleep(400);
  assert.strictEqual(sockets.filter((w) => !w.isClosed()).length, 1, "six rapid Retry clicks still leave exactly one live socket");
  console.log("[ok] Retry now reconnects immediately and never opens a second socket, even clicked six times at once");
  assert.deepStrictEqual(h.errors, []);
  await h.close();
}

// ---------- 2. never for a finished run
{
  const h = await harness();
  await h.open(); h.startRun();
  h.ev({ type: "phase-end", phase: "builder", attempt: 1, verdict: { completed: true, outcome: "pass", headline: "ok", details: "", concerns: [], blockingFindings: [] } });
  h.ev({ type: "run-end", status: "done" });
  await h.page.waitForSelector(".blk.run-end");
  await h.srv.close();
  await h.page.waitForFunction(() => document.getElementById("status").textContent.includes("run over"));
  await sleep(2500);
  assert.strictEqual(await h.page.locator("#offline").count(), 0, "no offline screen for a run that finished");
  assert.ok((await h.page.locator("#transcript").innerText()).includes("Run done"), "the transcript stays");
  console.log("[ok] a finished run whose server stops shows no offline screen");
  await h.close();
}

// ---------- 3. never in a saved report
{
  const dir = mkdtempSync(join(tmpdir(), "agent-loop-offline-"));
  const ts = new Date().toISOString();
  const path = writeRunReport(dir, [
    { type: "run-start", runId: "r", task: "t", workDir: "/w", ts },
    { type: "run-end", runId: "r", status: "failed", ts },
  ]);
  const browser = await chromium.launch({ executablePath: chromePath() });
  const page = await browser.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.goto("file://" + path); await page.waitForSelector(".blk.run-end");
  await sleep(1800);
  assert.strictEqual(await page.locator("#offline").count(), 0, "a saved report has no server to lose");
  assert.strictEqual(await page.evaluate(() => AL.offline.isShown()), false);
  assert.strictEqual(await page.locator("#cat").count(), 1, "…but it does carry the cat (sprites are inline, no network)");
  assert.deepStrictEqual(errs, []);
  await browser.close();
  console.log("[ok] a saved report opened from disk never shows the offline screen, and still has its sprites");
}

// ---------- 4. without sprites it is still a playable game
{
  const h = await harness({ abort: ["/sprite-data.js"] });
  await h.open(); h.startRun();
  await h.srv.close();
  await h.page.waitForSelector("#offline:not([hidden])", { timeout: 5000 });
  await h.page.keyboard.press("Space");
  await sleep(900);
  const s = await game(h.page);
  assert.ok(s.playing && s.score > 0, "playable with no sprites: " + JSON.stringify(s));
  assert.ok((await ink(h.page)).grey > 300, "a plain block stands in for the dino");
  assert.deepStrictEqual(h.errors, []);
  console.log("[ok] with the sprites missing the offline screen still shows and the game still runs");
  await h.close();
}

// ---------- 5. on a phone
{
  const h = await harness({ viewport: { width: 390, height: 780 } });
  await h.open(); h.startRun();
  await h.srv.close();
  await h.page.waitForSelector("#offline:not([hidden])", { timeout: 5000 });
  const card = await h.page.evaluate(() => { const r = document.querySelector(".off-card").getBoundingClientRect(); const c = document.getElementById("dino").getBoundingClientRect(); return { right: r.right, left: r.left, canvas: c.width, scrollW: document.documentElement.scrollWidth }; });
  assert.ok(card.left >= 0 && card.right <= 390 && card.canvas <= 358 && card.scrollW === 390, `fits a 390px phone: ${JSON.stringify(card)}`);
  console.log("[ok] on a 390px phone the dialog and the game fit, with no sideways scroll");
  await h.close();
}
console.log("\nALL OFFLINE UI TESTS PASSED");
