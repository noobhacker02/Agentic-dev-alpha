// Sound (ui/sound.js) in a real Chromium: silent by default with no audio engine created at all, starts only from a
// click, follows what the run is doing, is rate-limited, stays quiet for replayed history, never autoplays after a
// reload, and its output is audible and never clips (measured on the real output with an analyser). No API calls:
//   npm run build && npm run test:ui-sound
import assert from "node:assert";
import { harness } from "./ui-extras-helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Counts every AudioContext the page builds, and taps whatever reaches the speakers so the test can measure it.
const INSTRUMENT = `(() => {
  window.__ac = 0; window.__peak = 0;
  for (const k of ["AudioContext", "webkitAudioContext"]) {
    const C = window[k]; if (!C) continue;
    window[k] = new Proxy(C, { construct(t, a, nt) { window.__ac++; return Reflect.construct(t, a, nt); } });
  }
  const connect = AudioNode.prototype.connect; let analyser = null;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = connect.call(this, dest, ...rest);
    if (dest instanceof AudioDestinationNode) {
      if (!analyser || analyser.context !== this.context) { analyser = this.context.createAnalyser(); analyser.fftSize = 2048; }
      connect.call(this, analyser);
    }
    return r;
  };
  window.__measure = (ms) => new Promise((done) => {
    let peak = 0; const buf = new Float32Array(2048), end = performance.now() + ms;
    (function tick() { if (analyser) { analyser.getFloatTimeDomainData(buf); for (const v of buf) peak = Math.max(peak, Math.abs(v)); }
      performance.now() < end ? setTimeout(tick, 15) : done(peak); })();
  });
})();`;
const st = (page) => page.evaluate(() => AL.sound.stats());
const notesOver = async (page, ms) => { const a = (await st(page)).notes; await sleep(ms); return (await st(page)).notes - a; };
const label = (page) => page.locator("#sound-toggle").innerText();
const running = (page) => page.waitForFunction(() => AL.sound.stats().ctx === "running", undefined, { timeout: 4000 });

// ---------- 1. silent by default, and truly: no audio engine is even built
{
  const h = await harness({ init: INSTRUMENT });
  await h.open();
  assert.strictEqual(await h.page.evaluate(() => AL.sound.mode), "off");
  assert.strictEqual((await st(h.page)).ctx, "none");
  assert.strictEqual(await label(h.page), "♪ off");
  h.startRun(); h.askApproval("a1");
  h.ev({ type: "phase-end", phase: "builder", attempt: 1, verdict: { completed: true, outcome: "pass", headline: "ok", details: "", concerns: [], blockingFindings: [] } });
  h.ev({ type: "run-end", status: "done" });
  await h.page.waitForSelector(".blk.run-end"); await sleep(600);
  assert.strictEqual(await h.page.evaluate(() => window.__ac), 0, "a whole run (approval, phase pass, run end) builds no AudioContext while sound is off");
  assert.strictEqual(await h.page.evaluate(() => localStorage.getItem("agent-loop-sound")), null, "nothing was stored either");
  console.log("[ok] sound is off by default: after a whole run, not one AudioContext was ever created");
  await h.close();
}

// ---------- 2. blips, then music, then off
{
  const h = await harness({ init: INSTRUMENT });
  const { page } = h;
  await h.open();
  await page.locator("#sound-toggle").click();
  await running(page);
  assert.strictEqual(await label(page), "♪ blips");
  assert.strictEqual(await page.evaluate(() => window.__ac), 1, "one context, created by the click");
  assert.strictEqual(await page.evaluate(() => localStorage.getItem("agent-loop-sound")), "sfx");
  assert.strictEqual((await st(page)).music, false, "blips only: no music loop");
  await sleep(300);

  const sfx0 = (await st(page)).sfx;
  h.startRun(); h.askApproval("b1");
  await page.waitForFunction((n) => AL.sound.stats().sfx > n, sfx0);
  assert.strictEqual((await st(page)).sfx, sfx0 + 1, "an approval arriving chimes once");
  await page.keyboard.press("y");
  await page.waitForFunction((n) => AL.sound.stats().sfx > n, sfx0 + 1);
  assert.strictEqual((await st(page)).sfx, sfx0 + 2, "answering blips once");
  h.ev({ type: "phase-end", phase: "builder", attempt: 1, verdict: { completed: true, outcome: "pass", headline: "ok", details: "", concerns: [], blockingFindings: [] } });
  await page.waitForFunction((n) => AL.sound.stats().sfx > n, sfx0 + 2);
  h.ev({ type: "run-end", status: "done" });
  await page.waitForFunction((n) => AL.sound.stats().sfx > n, sfx0 + 3);
  assert.strictEqual((await st(page)).sfx, sfx0 + 4, "phase pass and run end each have their own sound");
  await sleep(250); // clear of the last chime, so the limiter has nothing to say about the first
  const played = await page.evaluate(() => [AL.sound.sfx("prompt"), AL.sound.sfx("prompt"), AL.sound.sfx("prompt")]);
  assert.deepStrictEqual(played, [true, false, false], "three chimes asked for in the same instant: one plays (the limiter, checked deterministically)");
  await sleep(150);
  const mid = (await st(page)).sfx;
  h.askApproval("b2"); h.askApproval("b3"); h.askApproval("b4");   // and end to end: a burst of approvals is not a burst of chimes
  await sleep(600);
  assert.ok((await st(page)).sfx - mid < 3, `three approvals arriving together do not make three chimes (${(await st(page)).sfx - mid})`);
  console.log("[ok] blips: a chime per approval, an answer blip, phase and run-end sounds, and a burst is rate-limited to one");
  assert.deepStrictEqual(h.errors, []);
  await h.close();
}

// ---------- 3. the music follows the run, is audible, and never clips
{
  const h = await harness({ init: INSTRUMENT });
  const { page } = h;
  await h.open();
  await page.locator("#sound-toggle").click(); await running(page);
  await page.locator("#sound-toggle").click();
  assert.strictEqual(await label(page), "♪ music");
  assert.strictEqual((await st(page)).music, true);
  const idle = await notesOver(page, 3000);
  assert.ok(idle >= 3, `idle music is sparse but there (${idle} notes in 3 s)`);
  h.startRun();
  await page.waitForFunction(() => AL.sound.stats().mood === "working");
  const working = await notesOver(page, 3000);
  assert.ok(working > idle * 2, `while an agent works the music is busier: ${working} vs ${idle} notes in 3 s`);
  const peak = await page.evaluate(() => window.__measure(2500));
  assert.ok(peak > 0.01, `the music is audible on the real output (peak ${peak.toFixed(3)})`);
  assert.ok(peak < 0.6, `…and does not clip (peak ${peak.toFixed(3)})`);
  h.askApproval("m1");
  await page.waitForFunction(() => AL.sound.stats().mood === "attention");
  await sleep(600);
  const waiting = await notesOver(page, 3000);
  assert.ok(waiting < working / 2, `while something waits on you it thins out: ${waiting} vs ${working}`);
  console.log(`[ok] music: ${idle} notes idle → ${working} working → ${waiting} while waiting on you; peak ${peak.toFixed(2)} (audible, no clipping)`);

  // it stops a few seconds after the run ends, and says so with a jingle
  await page.keyboard.press("y");
  await page.waitForFunction(() => AL.sound.stats().mood === "working");
  h.ev({ type: "run-end", status: "done" });
  await page.waitForFunction(() => AL.sound.stats().mood === "done");
  assert.strictEqual((await st(page)).music, true, "it lingers briefly after the run ends");
  await page.waitForFunction(() => AL.sound.stats().music === false, undefined, { timeout: 14000 });
  const stopped = (await st(page)).notes; await sleep(700);
  assert.strictEqual((await st(page)).notes, stopped, "and then it is silent: no more notes are scheduled");
  console.log("[ok] after the run ends the music plays on briefly, then stops for good");

  // off really is off
  await page.locator("#sound-toggle").click();               // music -> off
  assert.strictEqual(await label(page), "♪ off");
  await page.waitForFunction(() => AL.sound.stats().ctx === "suspended");
  console.log("[ok] switching to off suspends the audio engine");
  assert.deepStrictEqual(h.errors, []);
  await h.close();
}

// ---------- 4. a remembered setting never autoplays; replayed history is silent
{
  const h = await harness({ init: INSTRUMENT });
  const { page } = h;
  const real = (id) => h.bus.requestApproval({ runId: "extras-run", phase: "builder", toolUseId: "tu-" + id, toolName: "Bash", toolInput: { command: "npm test" }, rule: "Bash(npm test)" });
  await h.open(); h.startRun();
  await page.locator("#sound-toggle").click(); await running(page);
  await page.locator("#sound-toggle").click();               // music
  await sleep(300);
  const first = real("r1");                                  // a REAL pending approval: the bus replays only those
  await page.waitForSelector("#prompt");
  await page.waitForFunction(() => AL.sound.stats().sfx >= 1);
  await page.reload();
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "live");
  await page.waitForSelector("#prompt");                     // proof that the replay really did bring the approval back
  assert.strictEqual(await label(page), "♪ music", "the button remembers");
  assert.strictEqual((await st(page)).ctx, "none", "but no audio engine exists yet");
  assert.strictEqual(await page.evaluate(() => AL.sound.waiting), true);
  assert.ok((await page.locator("#sound-toggle").getAttribute("title")).includes("starts at your next click"), "the tooltip says why it is quiet");
  await sleep(1500);
  assert.strictEqual(await page.evaluate(() => window.__ac), 0, "a reload never autoplays: still no AudioContext after 1.5 s");
  await page.mouse.click(400, 300);                          // the first click anywhere starts it
  await running(page);
  assert.strictEqual(await page.evaluate(() => window.__ac), 1);
  assert.strictEqual((await st(page)).music, true, "…and the remembered music starts");
  assert.strictEqual((await st(page)).sfx, 0, "the approval that was replayed from history made no sound");
  // Now the engine is running: make the server replay the whole run again. It must still be silent, and a new live approval must not be.
  await h.srv.close(); await h.restartServer();
  await page.waitForFunction(() => document.getElementById("status").textContent === "live" && AL.sound.stats().ctx === "running", undefined, { timeout: 9000 });
  await page.waitForSelector("#prompt");                     // the pending approval came back with the replay
  await sleep(500);
  assert.strictEqual((await st(page)).sfx, 0, "a reconnect replays a waiting approval with the engine running, and the replay is still silent");
  const second = real("r2");
  await page.waitForFunction(() => AL.sound.stats().sfx === 1);
  console.log("[ok] after a reload nothing plays until your first click; a replay (page load or reconnect) of a really waiting approval is silent even with sound running; the next live approval is not");

  // shortcut m cycles, and typing an m does not (both approvals are answered first so the decision box is on screen)
  await page.keyboard.press("y"); await page.keyboard.press("y");
  await Promise.all([first.wait, second.wait]);
  await page.waitForSelector("#decision-input");
  await page.locator("#decision-input").click();
  await page.keyboard.type("mmm");
  assert.strictEqual(await label(page), "♪ music", "typing m in the decision box changes nothing");
  await page.locator("#decision-input").fill(""); await page.mouse.click(600, 200);
  await page.keyboard.press("m");
  assert.strictEqual(await label(page), "♪ off", "m outside a text box cycles the mode (music → off)");
  console.log("[ok] m cycles the sound, and typing an m into the decision box does not");
  assert.deepStrictEqual(h.errors, []);
  await h.close();
}

// ---------- 4b. the music can be rendered offline (it puts the real music on the walkthrough videos)
{
  const h = await harness({ init: INSTRUMENT });
  await h.open();
  const run = () => h.page.evaluate(async () => {
    const buf = await AL.sound.render(6, [{ at: 0, mood: "idle" }, { at: 2, mood: "working" }, { at: 3, sfx: "prompt" }, { at: 4, mood: "attention" }]);
    const d = buf.getChannelData(0); let peak = 0, sum = 0, early = 0, late = 0;
    for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); peak = Math.max(peak, v); sum += v; if (i < 44100 * 2) early += v; else if (i < 44100 * 4) late += v; }
    return { length: buf.length, rate: buf.sampleRate, peak, sum, early, late, ac: window.__ac };
  });
  const a = await run(), b = await run();
  assert.strictEqual(a.length, 6 * 44100);
  assert.ok(a.peak > 0.02 && a.peak < 0.6, `rendered music is audible and does not clip (peak ${a.peak.toFixed(3)})`);
  assert.ok(a.late > a.early * 1.3, `the render follows the moods: the busy middle is louder than the idle start (${a.late.toFixed(0)} vs ${a.early.toFixed(0)})`);
  assert.ok(Math.abs(a.sum - b.sum) < 1e-3 * a.sum, "rendering is deterministic: the same timeline gives the same audio");
  assert.strictEqual(a.ac, 0, "rendering offline creates no real AudioContext (nothing can come out of a speaker)");
  assert.strictEqual((await st(h.page)).ctx, "none", "and the live engine is untouched");
  console.log(`[ok] the music renders offline from a timeline: audible, not clipping, follows the moods, deterministic, nothing played live (peak ${a.peak.toFixed(2)})`);
  await h.close();
}

// ---------- 5. no sound script: the page just has no sound button
{
  const h = await harness({ abort: ["/sound.js"], init: INSTRUMENT });
  await h.open(); h.startRun(); h.askApproval("n1");
  await h.page.waitForSelector("#prompt");
  assert.strictEqual(await h.page.locator("#sound-toggle").isHidden(), true, "no button when there is no sound");
  await h.page.keyboard.press("m");
  assert.strictEqual(await h.page.evaluate(() => window.__ac), 0);
  await h.page.keyboard.press("y"); await h.page.waitForSelector("#prompt", { state: "detached" });
  assert.deepStrictEqual(h.errors, []);
  console.log("[ok] without the sound script there is no button, m does nothing, and prompts still work");
  await h.close();
}
console.log("\nALL SOUND UI TESTS PASSED");
