// Plain mode in the real page (ui/plain.js): one switch that turns every cartoon off, remembered, and the page works the same.
// Real Chromium, real server, no API calls:
//   npm run build && npm run test:ui-plain
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "./ui-extras-helpers.mjs";
import { writeRunReport } from "../dist/report.js";

const ROOT = new URL("..", import.meta.url).pathname;
const gone = (page, sel) => page.evaluate((s) => { const n = document.querySelector(s); return !n || n.hidden || getComputedStyle(n).display === "none"; }, sel);
const cartoons = (page) => page.evaluate(() => ({
  plain: document.documentElement.dataset.plain,
  catGone: (() => { const c = document.getElementById("cat"); return !c || c.hidden || getComputedStyle(c).display === "none"; })(),
  iconsShown: [...document.querySelectorAll(".px")].filter((n) => getComputedStyle(n).display !== "none").length,
  iconsTotal: document.querySelectorAll(".px").length,
  cursors: document.documentElement.dataset.cursors,
  soundBtnShown: getComputedStyle(document.getElementById("sound-toggle")).display !== "none",
  soundMode: AL.sound ? AL.sound.mode : "none",
  catEnabled: AL.mascot.state().enabled,
  favicon: document.getElementById("favicon").href,
  toggle: document.getElementById("plain-toggle").textContent,
  stored: (() => { try { return localStorage.getItem("agent-loop-plain"); } catch { return "?"; } })(),
}));
const waitPlain = (page, v) => page.waitForFunction((x) => document.documentElement.dataset.plain === x, v, { timeout: 5000 });

// ---------- 1. the live switch: everything goes, the page still works, and everything comes back as it was
{
  const h = await harness({ init: () => { try { localStorage.setItem("agent-loop-sound", "sfx"); localStorage.setItem("agent-loop-cursors", "on"); } catch {} } });
  const { page } = h;
  await h.open();
  h.startRun();
  h.askApproval("q1");
  await page.waitForSelector("#prompt");
  await page.waitForFunction(() => AL.mascot.state().mood === "attention");
  let c = await cartoons(page);
  assert.strictEqual(c.plain, "off");
  assert.ok(!c.catGone && c.iconsShown > 3 && c.cursors === "on" && c.soundBtnShown && c.catEnabled, `by default the cartoons are on: ${JSON.stringify(c)}`);
  assert.strictEqual(c.toggle, "cartoons: on");
  assert.ok(c.favicon.startsWith("data:image/png"), "the lock favicon is showing");
  assert.strictEqual(c.soundMode, "sfx", "a remembered sound mode is waiting for a click");

  await page.click("#plain-toggle");
  await waitPlain(page, "on");
  c = await cartoons(page);
  assert.ok(c.catGone && !c.catEnabled, "the cat is gone");
  assert.strictEqual(c.iconsShown, 0, `no pixel icon is drawn (${c.iconsTotal} exist in the page)`);
  assert.ok(c.iconsTotal > 3, "…and the icons were there to hide, so this is not vacuous");
  assert.strictEqual(c.cursors, "off");
  assert.ok(!c.soundBtnShown && c.soundMode === "off", "the sound button is gone and sound is off");
  assert.ok(!c.favicon.startsWith("data:image/png"), "no pixel favicon");
  assert.strictEqual(c.toggle, "cartoons: off");
  assert.strictEqual(c.stored, "on");
  // the prompt still works, with keys and with the mouse, and the cat does not come back for it
  assert.ok(await page.locator("#prompt .opt").first().isVisible(), "the permission prompt is still there with its buttons");
  assert.ok((await page.locator("#prompt").innerText()).includes("npm test"), "…showing exactly what would run");
  assert.ok(await gone(page, "#cat"), "no cat on the prompt");
  await page.keyboard.press("y");
  await page.waitForSelector("#prompt", { state: "detached" });
  await page.keyboard.press("m");
  assert.strictEqual(await page.evaluate(() => AL.sound.mode), "off", "the m key does not start sound in plain mode");
  assert.ok(await gone(page, "#cat"), "no cat after the answer either");
  console.log("[ok] plain mode, live: the cat, every pixel icon, the cursors, the sound button and the favicon go at once; the prompt still shows what would run and is answered by key");

  // the help window shows it, and the individual options wait
  await page.keyboard.press("?");
  assert.ok(await page.locator("#opt-plain").isChecked(), "the help window shows plain mode on");
  assert.ok(await page.locator("#opt-cat").isDisabled() && await page.locator("#opt-sound").isDisabled() && await page.locator("#opt-cursors").isDisabled(), "the single options are locked while plain mode is on");
  assert.ok(await page.locator("#opt-cat").isChecked() && await page.locator("#opt-cursors").isChecked(), "…and show what they will be when it ends");
  await page.keyboard.press("Escape");

  // switch back: it is all as it was, including the remembered sound mode (still waiting for a click)
  await page.locator("#help-btn").click();
  await page.locator("#opt-plain").uncheck();
  await waitPlain(page, "off");
  await page.keyboard.press("Escape");
  c = await cartoons(page);
  assert.ok(c.catEnabled && c.iconsShown > 3 && c.cursors === "on" && c.soundBtnShown, `everything is back: ${JSON.stringify(c)}`);
  assert.strictEqual(c.soundMode, "sfx", "the remembered sound mode came back");
  assert.strictEqual(c.stored, "off");
  h.ev({ type: "tool-call", phase: "builder", toolUseId: "tu-n", toolName: "Bash", toolInput: { command: "ls" } });
  h.askApproval("q2");
  await page.waitForFunction(() => AL.mascot.state().mood === "attention" && AL.mascot.state().anchor === "prompt", undefined, { timeout: 6000 });
  console.log("[ok] switched off again: the cat is back and runs to the next prompt, icons, cursors and the remembered sound mode return");
  assert.deepStrictEqual(h.errors, [], "no page errors");
  await h.close();
}

// ---------- 1b. the guards underneath the switch: the scripts themselves refuse what plain mode forbids
{
  const h = await harness({ init: () => { try { localStorage.setItem("agent-loop-sound", "sfx"); } catch {} } });
  const { page } = h;
  await h.open("?plain=1");
  const snd = () => page.evaluate(() => ({ mode: AL.sound.mode, waiting: AL.sound.waiting, ctx: AL.sound.stats().ctx, stored: localStorage.getItem("agent-loop-sound") }));
  assert.deepStrictEqual(await snd(), { mode: "off", waiting: false, ctx: "none", stored: "sfx" }, "a page that loads in plain mode with sound remembered is silent, is not waiting for a click, and has no audio engine");
  await page.mouse.click(300, 300); await page.keyboard.press("m");
  assert.deepStrictEqual(await snd(), { mode: "off", waiting: false, ctx: "none", stored: "sfx" }, "clicks and keys do not start it");
  // calling the API directly changes nothing either, and does not overwrite what you chose
  await page.evaluate(() => { AL.sound.setMode("music"); AL.sound.cycle(); AL.sound.restore(); AL.sound.setMode("off"); });
  assert.deepStrictEqual(await snd(), { mode: "off", waiting: false, ctx: "none", stored: "sfx" }, "setMode / cycle / restore are refused in plain mode and the remembered mode is left alone");
  await page.evaluate(() => AL.mascot.setEnabled(true));
  assert.ok(await gone(page, "#cat") && !(await page.evaluate(() => AL.mascot.state().enabled)), "setEnabled(true) cannot bring the cat back in plain mode");
  assert.strictEqual(await page.evaluate(() => localStorage.getItem("agent-loop-cat")), "on", "…but it is remembered for when plain mode ends");
  await page.evaluate(() => AL.setPlain(false));
  await waitPlain(page, "off");
  assert.ok(!(await gone(page, "#cat")), "and then the cat is there");
  assert.strictEqual((await snd()).mode, "sfx", "and the sound mode you chose is back");
  console.log("[ok] the scripts refuse what plain mode forbids on their own (sound setMode/cycle/restore, the cat's setEnabled), without overwriting what you chose");
  assert.deepStrictEqual(h.errors, []);
  await h.close();
}

// ---------- 1c. the turning glyph holds still in plain mode (and turns without it: the control)
{
  const h = await harness();
  const { page } = h;
  await h.open("?plain=0");
  h.startRun();
  await page.waitForSelector(".statusline .spin");
  const sample = async () => { const seen = new Set(); for (let i = 0; i < 12; i++) { seen.add(await page.evaluate(() => document.querySelector(".statusline .spin").textContent)); await page.waitForTimeout(120); } return seen; };
  assert.ok((await sample()).size >= 3, "control: the glyph turns when cartoons are on");
  await page.evaluate(() => AL.setPlain(true));
  await waitPlain(page, "on");
  const frozen = await sample();
  assert.deepStrictEqual([...frozen], ["✻"], `in plain mode it holds still on the first glyph: ${[...frozen]}`);
  assert.ok(await page.evaluate(() => !!document.querySelector(".statusline .spin")), "…and it is still there");
  console.log("[ok] the turning glyph turns normally and holds still in plain mode");
  await h.close();
}

// ---------- 2. your own choices are left alone by plain mode
{
  const h = await harness({ init: () => { try { localStorage.setItem("agent-loop-cat", "off"); localStorage.setItem("agent-loop-cursors", "off"); } catch {} } });
  const { page } = h;
  await h.open();
  await page.evaluate(() => AL.setPlain(true));
  await waitPlain(page, "on");
  await page.evaluate(() => AL.setPlain(false));
  await waitPlain(page, "off");
  const c = await cartoons(page);
  assert.ok(c.catGone && !c.catEnabled && c.cursors === "off", "a cat and cursors you had turned off stay off after plain mode ends");
  assert.strictEqual(await page.evaluate(() => localStorage.getItem("agent-loop-cat")), "off");
  console.log("[ok] plain mode does not overwrite what you chose for the cat and the cursors");
  await h.close();
}

// ---------- 3. remembered, and the address and the server can set it
{
  const h = await harness();
  const { page } = h;
  await h.open("?plain=1");
  assert.strictEqual((await cartoons(page)).plain, "on", "?plain=1 turns it on");
  await page.reload();
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "live");
  assert.strictEqual((await cartoons(page)).plain, "on", "…and a reload keeps it (remembered)");
  assert.ok((await cartoons(page)).catGone && (await cartoons(page)).iconsShown === 0, "a page that loads in plain mode never shows a cartoon");
  await page.goto(`http://127.0.0.1:${h.port}/?plain=0#token=${h.token}`);
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "live");
  assert.strictEqual((await cartoons(page)).plain, "off", "?plain=0 turns it off");
  assert.ok(!(await cartoons(page)).catGone, "…and the cat is there");
  await h.close();

  const d = await harness({ plain: true });
  await d.open();
  assert.strictEqual((await cartoons(d.page)).plain, "on", "the server's --plain is the default for a browser that has not chosen");
  assert.ok((await cartoons(d.page)).catGone);
  await d.page.evaluate(() => AL.setPlain(false));
  await d.page.reload();
  await d.page.waitForFunction(() => document.getElementById("status")?.textContent === "live");
  assert.strictEqual((await cartoons(d.page)).plain, "off", "a browser that chose 'off' keeps its choice over the server's default");
  const body = await (await fetch(`http://127.0.0.1:${d.port}/plain.js`)).text();
  assert.ok(body.startsWith("window.__PLAIN_DEFAULT__ = true;"), body.slice(0, 60));
  await d.close();
  const n = await harness();
  assert.ok((await (await fetch(`http://127.0.0.1:${n.port}/plain.js`)).text()).startsWith("window.__PLAIN_DEFAULT__ = false;"));
  await n.close();
  console.log("[ok] ?plain=1 / ?plain=0 and a reload, and the server's --plain default (a browser's own choice wins)");
}

// ---------- 4. the offline dialog without the game
{
  const h = await harness({ init: () => { try { localStorage.setItem("agent-loop-plain", "on"); } catch {} } });
  const { page } = h;
  await h.open();
  h.startRun();
  await h.srv.close();
  await page.waitForSelector("#offline", { state: "visible", timeout: 8000 });
  assert.ok((await page.locator("#off-title").innerText()).includes("Can't reach agent-loop"), "the dialog still says what happened");
  assert.ok(await page.locator("#off-retry").isVisible(), "…and offers Retry");
  assert.ok(await gone(page, "#offline #dino") && await gone(page, "#off-play") && await gone(page, "#offline .off-fine"), "no game, no play button, no game instructions");
  const pressed = await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true, cancelable: true })));
  assert.ok(pressed, "the space bar is not taken (no preventDefault) when there is no game");
  assert.strictEqual(await page.evaluate(() => AL.offline.state().playing), false);
  // turning plain mode off while the dialog is up starts the game; back on stops it
  await page.evaluate(() => AL.setPlain(false));
  await page.waitForFunction(() => getComputedStyle(document.getElementById("dino")).display !== "none");
  await page.keyboard.press("Space");
  await page.waitForFunction(() => AL.offline.state().playing, undefined, { timeout: 3000 });
  await page.evaluate(() => AL.setPlain(true));
  await page.waitForFunction(() => !AL.offline.state().playing && AL.offline.state().score === 0);
  // the server comes back: the dialog leaves by itself
  await h.restartServer();
  await page.waitForSelector("#offline", { state: "hidden", timeout: 12000 });
  console.log("[ok] offline in plain mode: the words and Retry stay, the dinosaur and its keys do not; switching plain mode while the dialog is up starts and stops the game");
  assert.deepStrictEqual(h.errors, []);
  await h.close();
}

// ---------- 5. a canvas that cannot draw must not take the dialog down
{
  const h = await harness({ init: () => { HTMLCanvasElement.prototype.getContext = () => null; } });
  const { page } = h;
  await h.open();
  h.startRun();
  await h.srv.close();
  await page.waitForSelector("#offline", { state: "visible", timeout: 8000 });
  assert.ok(await page.locator("#off-retry").isVisible() && (await page.locator("#off-title").innerText()).includes("Can't reach"), "the dialog shows without a canvas context");
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  await h.restartServer();
  await page.waitForSelector("#offline", { state: "hidden", timeout: 12000 });
  assert.deepStrictEqual(h.errors, [], "no page error without a canvas context");
  console.log("[ok] a canvas that cannot draw (getContext returns null): the offline dialog still shows, retries and leaves, with no page error");
  await h.close();
}

// ---------- 6. a saved report honours it
{
  const dir = mkdtempSync(join(tmpdir(), "agent-loop-plain-"));
  const events = [
    { type: "run-start", runId: "r", task: "t", ts: "2026-01-01T00:00:00Z" },
    { type: "phase-start", runId: "r", phase: "builder", attempt: 1, ts: "2026-01-01T00:00:01Z" },
    { type: "run-end", runId: "r", status: "done", ts: "2026-01-01T00:01:00Z" },
  ];
  for (const plain of [true, false]) {
    const file = writeRunReport(join(dir, String(plain)), events, "dark", plain);
    const h = await harness();
    await h.page.goto("file://" + file);
    await h.page.waitForFunction(() => document.getElementById("status")?.textContent === "saved report");
    const c = await cartoons(h.page);
    assert.strictEqual(c.plain, plain ? "on" : "off", `report written with plain=${plain}`);
    assert.strictEqual(c.catGone, plain, `the report's cat follows it (plain=${plain})`);
    assert.strictEqual(c.iconsShown === 0, plain);
    assert.deepStrictEqual(h.errors, []);
    await h.close();
  }
  console.log("[ok] a saved report written with --plain opens with no cartoons, and without it opens as before");
}

// ---------- 7. the command line
{
  const run = (args) => spawnSync(process.execPath, ["--experimental-sqlite", "--no-warnings", "dist/cli.js", ...args], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const help = run([]);
  assert.ok(/--plain\s+Start the page with every cartoon off/.test(help.stdout), "--plain is in the help");
  // --plain takes no value: the task after it is still the task (without that, the next word would be eaten and this says "no task description")
  const r = run(["run", "--plain", "do the thing", "--desktop-target", "x", "--no-approval", "--dir", mkdtempSync(join(tmpdir(), "agent-loop-plain-cli-"))]);
  assert.ok(!/no task description/.test(r.stderr) && /--no-approval/.test(r.stderr), `--plain must not swallow the task: ${r.stderr}`);
  console.log("[ok] agent-loop run --plain: documented, takes no value, leaves the task alone");

  // a real run with the fake SDK: the live server's default is plain, and so is the saved report; without the flag, neither is
  const { spawn } = await import("node:child_process");
  const { freePort } = await import("./ui-extras-helpers.mjs");
  const { readFileSync } = await import("node:fs");
  for (const flag of [true, false]) {
    const port = await freePort();
    const base = mkdtempSync(join(tmpdir(), "agent-loop-plain-run-"));
    const args = ["--experimental-sqlite", "--no-warnings", "--import", "./test/stress/fake-sdk/register.mjs", "dist/cli.js", "run", ...(flag ? ["--plain"] : []), "do the thing", "--dir", join(base, "w"), "--data-dir", join(base, "d"), "--port", String(port), "--no-approval", "--humor", "off"];
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_SCENARIO: "trivial-skip", FAKE_DELAY_MS: "700" } });
    let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    let served = "";
    for (let i = 0; i < 300 && !served; i++) {
      try { served = await (await fetch(`http://127.0.0.1:${port}/plain.js`)).text(); } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    const code = await new Promise((r) => child.on("close", r));
    assert.ok(served.startsWith(`window.__PLAIN_DEFAULT__ = ${flag};`), `the live server's default (--plain ${flag}): ${served.slice(0, 50)}`);
    const reportPath = (out.match(/Report: file:\/\/(\S+)/) || [])[1];
    assert.ok(reportPath, `no report was written (exit ${code}):\n${out.slice(-600)}`);
    assert.ok(readFileSync(reportPath, "utf8").includes(`window.__PLAIN_DEFAULT__ = ${flag};`), `the saved report's default (--plain ${flag})`);
  }
  console.log("[ok] a real run: --plain makes the live page and the saved report start plain; without it neither does");
}

console.log("\nALL PLAIN MODE TESTS PASSED");
