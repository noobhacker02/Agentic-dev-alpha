// Adversarial sweep of the cartoon code in a real Chromium: 80 approvals flapping, a cat clicked 60 times, hostile viewports
// (320 px wide, 300 px tall), resizes while it hops, markup in run text, sound mode churn, four server restarts in a row. No API calls.
//   npm run build && npm run test:ui-cartoon-stress
import assert from "node:assert";
import { harness, catBox, box } from "./ui-extras-helpers.mjs";
const log = (...a) => console.log(...a);
const ok = (m) => console.log(`[ok] ${m}`);
const findings = [];
const check = (cond, msg) => { if (!cond) { findings.push(msg); log("  FINDING:", msg); } };

// 1. flapping approvals
{
  const h = await harness();
  await h.open(); h.startRun();
  for (let i = 0; i < 80; i++) { h.askApproval("f" + i); h.ev({ type: "approval-resolved", phase: "builder", requestId: "f" + i, toolUseId: "tu-f" + i, decision: "allow" }); }
  h.askApproval("last");
  await h.page.waitForSelector("#prompt");
  await h.page.waitForFunction(() => AL.mascot.state().mood === "attention" && AL.mascot.state().anchor === "prompt", undefined, { timeout: 8000 }).catch(() => check(false, "after 80 flaps the cat never settled on the prompt"));
  const cat = await catBox(h.page), prompt = await box(h.page, "#prompt");
  check(Math.abs(cat.bottom - (prompt.top + 8)) <= 2, `after flapping the cat is ${cat.bottom - prompt.top - 8}px off the prompt`);
  check(h.errors.length === 0, "page errors after flapping: " + h.errors.join("|"));
  const timers = await h.page.evaluate(() => document.querySelectorAll("#cat *").length);
  check(timers < 12, `cat DOM grew: ${timers} nodes`);
  await h.close();
}
// 2. click-spam the cat
{
  const h = await harness();
  await h.open();
  for (let i = 0; i < 60; i++) await h.page.evaluate(() => document.querySelector("#cat .cat-body").click());
  const hearts = await h.page.evaluate(() => document.querySelectorAll("#cat .cat-heart").length);
  check(hearts <= 5, `${hearts} hearts after spamming`);
  check(h.errors.length === 0, "errors: " + h.errors.join("|"));
  await h.close();
}
// 3. tiny and odd viewports
for (const vp of [{ width: 320, height: 480 }, { width: 1920, height: 300 }, { width: 600, height: 900 }]) {
  const h = await harness({ viewport: vp });
  await h.open(); h.startRun(); h.askApproval("q");
  await h.page.waitForSelector("#prompt");
  await h.page.waitForFunction(() => AL.mascot.state().mood === "attention", undefined, { timeout: 6000 });
  const cat = await catBox(h.page);
  check(cat.left >= -1 && cat.top >= -1 && cat.right <= vp.width + 1 && cat.bottom <= vp.height + 1, `${vp.width}x${vp.height}: cat out of the viewport ${JSON.stringify(cat)}`);
  const sw = await h.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  check(!sw, `${vp.width}x${vp.height}: sideways scroll`);
  // can the buttons be clicked with the cat there?
  for (const o of await h.page.locator("#prompt .opt").all()) {
    const b = await o.boundingBox();
    if (!b) continue;
    const hit = await h.page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && !!e.closest("#cat"); }, [b.x + b.width / 2, b.y + b.height / 2]);
    check(!hit, `${vp.width}x${vp.height}: the cat is over an answer button`);
  }
  await h.close();
}
// 4. resize while hopping
{
  const h = await harness();
  await h.open(); h.startRun(); h.askApproval("q");
  await h.page.waitForSelector("#prompt");
  for (const w of [900, 500, 1280, 360, 1000]) { await h.page.setViewportSize({ width: w, height: 700 }); await h.page.waitForTimeout(150); }
  await h.page.waitForTimeout(800);
  const cat = await catBox(h.page), prompt = await box(h.page, "#prompt");
  check(Math.abs(cat.bottom - (prompt.top + 8)) <= 2, `after resizes the cat is ${cat.bottom - prompt.top - 8}px off`);
  check(h.errors.length === 0, "errors: " + h.errors.join("|"));
  await h.close();
}
// 5. hostile page-state: huge task name / phase text in the bubble
{
  const h = await harness();
  await h.open();
  h.ev({ type: "run-start", task: "<img src=x onerror=alert(1)>".repeat(50), workDir: "/w" });
  h.ev({ type: "phase-start", phase: "builder", attempt: 1 });
  h.askApproval("q");
  await h.page.waitForSelector("#prompt");
  const txt = await h.page.locator("#cat .cat-bubble").innerText();
  check(txt === "builder needs you", "bubble text: " + txt);
  check(await h.page.evaluate(() => !document.querySelector("#cat img, #cat script")), "markup in the cat");
  await h.close();
}
// 6. sound spam and mode churn
{
  const h = await harness();
  await h.open();
  await h.page.click("body");
  await h.page.evaluate(() => { for (let i = 0; i < 300; i++) { AL.sound.cycle(); AL.sound.sfx("click"); AL.sound.setMood(["idle", "working", "attention", "done"][i % 4]); } });
  const st = await h.page.evaluate(() => AL.sound.stats());
  check(st.ctx === "running" || st.ctx === "suspended" || st.ctx === "none", "ctx: " + st.ctx);
  check(h.errors.length === 0, "sound errors: " + h.errors.join("|"));
  await h.page.evaluate(() => AL.sound.setMode("off"));
  await h.close();
}
// 7. reconnect storm: server up/down 6 times
{
  const h = await harness();
  await h.open(); h.startRun();
  for (let i = 0; i < 4; i++) {
    await h.srv.close();
    await h.page.waitForTimeout(1300);
    await h.restartServer();
    await h.page.waitForFunction(() => document.getElementById("status")?.textContent === "live", undefined, { timeout: 12000 }).catch(() => check(false, `no reconnect on cycle ${i}`));
  }
  const sockets = await h.page.evaluate(() => performance.getEntriesByType("resource").filter((r) => r.name.includes("/ws")).length);
  check(!(await h.page.locator("#offline").isVisible()), "offline dialog stuck");
  check(h.errors.length === 0, "reconnect errors: " + h.errors.join("|"));
  await h.close();
}
assert.deepStrictEqual(findings, [], findings.join("\n"));
ok("flapping approvals, cat click-spam, 320x480 / 1920x300 / 600x900 viewports (cat inside the window, over no button, no sideways scroll), resizes while hopping, markup in run text, sound churn, and four server restarts all behave");
console.log("\nALL CARTOON STRESS TESTS PASSED");
