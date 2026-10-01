// The cat and the pixel set in the real page (ui/mascot.js, ui/sprites.js, ui/index.html), in a real Chromium.
// Measured, not eyeballed: where the cat stands for each state, that it runs to a waiting prompt and hops until
// you answer, that it stays out of the buttons, that the cursors and icons really load, and that the page works the
// same with any of it missing, switched off, or under reduced motion. No API calls:
//   npm run build && npm run test:ui-mascot
import assert from "node:assert";
import { harness, catBox, box } from "./ui-extras-helpers.mjs";

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);
const state = (page) => page.evaluate(() => AL.mascot.state());
const settledAt = async (page, mood, anchor) => {
  await page.waitForFunction(([m, a]) => { const s = AL.mascot.state(); return s.mood === m && s.anchor === a; }, [mood, anchor], { timeout: 6000 });
  return catBox(page);
};

// ---------- 1. the whole story, in one page
{
  const h = await harness();
  const { page } = h;
  await h.open();

  // before any run: the cat is on the welcome card, standing on its spot
  let cat = await settledAt(page, "idle", "welcome");
  const spot = await box(page, "#w-cat-spot");
  near(cat.left, spot.left, 2, "idle cat stands on the welcome card's spot (left)");
  near(cat.bottom, spot.bottom, 2, "…and on its floor");
  assert.ok((await page.locator("#welcome").innerText()).includes("Welcome"), "there is a welcome card");
  console.log("[ok] before a run the cat stands on the welcome card");

  // a run starts: it walks down to the input box and dances
  h.startRun();
  cat = await settledAt(page, "working", "home");
  let input = await box(page, "#dock .inputrow");
  near(cat.bottom, input.top + 4, 2, "working cat stands on the input box");
  near(cat.right, input.right - 16, 2, "…at its right end");
  assert.ok(await page.evaluate(() => document.querySelector("#cat .cat-body").classList.contains("cat-dance")), "it dances while an agent works");
  assert.strictEqual(await page.evaluate(() => getComputedStyle(document.querySelector("#cat .cat-body")).animationName), "kf-cat-dance", "the dance is really animating (frames step)");
  console.log("[ok] a run starts: the cat goes to the input box and dances");

  // an agent needs you: it runs to the prompt, sits on its edge, hops, and says who
  h.askApproval("q1");
  await page.waitForSelector("#prompt");
  cat = await settledAt(page, "attention", "prompt");
  let prompt = await box(page, "#prompt");
  near(cat.bottom, prompt.top + 8, 2, "the cat's feet are on the prompt's top edge");
  near(cat.right, prompt.right - 18, 2, "…at its right corner");
  const overlap = Math.max(0, Math.min(cat.bottom, prompt.bottom) - Math.max(cat.top, prompt.top));
  assert.ok(overlap <= 10, `the cat covers only ${overlap}px of the prompt, so it never hides a button`);
  for (const b of await page.locator("#prompt .opt").all()) {
    const o = await b.boundingBox();
    assert.ok(cat.bottom <= o.y + 1 || cat.right < o.x || cat.left > o.x + o.width, "the cat is clear of every answer button");
  }
  assert.strictEqual(await page.locator("#cat .cat-bubble").innerText(), "builder needs you", "it says who needs you");
  assert.ok(await page.evaluate(() => document.querySelector("#cat .cat-wrap").classList.contains("hopping")), "it is hopping");
  const seen = new Set();
  for (let i = 0; i < 12; i++) { seen.add(await page.evaluate(() => getComputedStyle(document.querySelector("#cat .cat-wrap")).transform)); await page.waitForTimeout(90); }
  assert.ok(seen.size >= 3, `the hop is real motion: ${seen.size} distinct positions over a second`);
  console.log("[ok] an approval arrives: the cat runs to the prompt, feet on its edge, hops, names the agent, covers no button");

  // it travelled there, rather than appearing: partway through, it was somewhere in between
  assert.ok(await page.evaluate(() => getComputedStyle(document.getElementById("cat")).transitionDuration !== "0s"), "moving is animated (a transition), not a jump cut");

  // the tab says so too: a lock while you are needed, a bolt while it works, a heart when it is done
  const fav = () => page.evaluate(() => document.getElementById("favicon").href);
  const lock = await fav();
  assert.ok(lock.startsWith("data:image/png;base64,"), "the tab icon becomes the lock while you are needed");
  assert.ok((await page.title()).startsWith("(1)"), "…and the title counts what is waiting");

  // you answer: it goes home and goes back to work, the bubble goes away
  await page.keyboard.press("y");
  cat = await settledAt(page, "working", "home");
  input = await box(page, "#dock .inputrow");
  near(cat.bottom, input.top + 4, 2, "after the answer the cat is back by the input box");
  assert.strictEqual(await page.locator("#cat .cat-bubble").isHidden(), true, "the bubble is gone");
  assert.ok(!(await page.evaluate(() => document.querySelector("#cat .cat-wrap").classList.contains("hopping"))), "it stopped hopping");
  const bolt = await fav();
  assert.ok(bolt.startsWith("data:image/png;base64,") && bolt !== lock, "the tab icon changes to the working bolt once you have answered");
  console.log("[ok] you answer: the cat goes home and the hopping stops, and the tab icon follows");

  // two waiting: still one prompt on screen, the cat stays with it
  h.askApproval("q2"); h.askApproval("q3");
  await page.waitForSelector("#prompt .count");
  cat = await settledAt(page, "attention", "prompt");
  prompt = await box(page, "#prompt");
  near(cat.bottom, prompt.top + 8, 2, "with several waiting the cat still sits on the one prompt");
  console.log("[ok] several approvals waiting: the cat stays on the prompt");
  // they get answered (the server tells the page), so the run can finish with nothing waiting
  h.ev({ type: "approval-resolved", phase: "builder", requestId: "q2", toolUseId: "tu-q2", decision: "allow" });
  h.ev({ type: "approval-resolved", phase: "builder", requestId: "q3", toolUseId: "tu-q3", decision: "allow" });
  await page.waitForSelector("#prompt", { state: "detached" });

  // the run ends well / badly
  await page.waitForTimeout(300);
  h.ev({ type: "phase-end", phase: "builder", attempt: 1, verdict: { completed: true, outcome: "pass", headline: "Built it", details: "", concerns: [], blockingFindings: [] } });
  h.ev({ type: "run-end", status: "done" });
  await page.waitForSelector(".blk.run-end");
  await page.waitForFunction(() => AL.mascot.state().mood === "win");
  await page.waitForTimeout(1200);
  await page.waitForFunction(() => !document.getElementById("cat").classList.contains("travelling"));
  cat = await catBox(page);
  assert.strictEqual((await state(page)).anchor, "run-end", "after a success it stands by the closing card");
  const closing = await box(page, ".blk.run-end");
  near(cat.bottom, closing.top + 6, 2, "its feet are on the closing card's top edge (measured after the card has finished sliding in)");
  assert.ok(await page.evaluate(() => document.querySelector("#cat .cat-body").classList.contains("cat-win")), "stars");
  const heart = await fav();
  assert.ok(heart.startsWith("data:image/png;base64,") && heart !== bolt && heart !== lock, "the tab icon becomes a heart when the run is done");
  console.log("[ok] run done: the cat celebrates with stars, the tab shows a heart");

  // pet it
  await page.locator("#cat .cat-body").click();
  assert.ok(await page.locator("#cat .cat-heart").count() >= 1, "a heart floats up");
  assert.ok((await page.locator("#cat .cat-bubble").innerText()).length > 0, "it says something");
  await page.waitForTimeout(1500);
  assert.strictEqual(await page.locator("#cat .cat-heart").count(), 0, "the heart goes away again");
  console.log("[ok] clicking the cat gives a heart and a word");
  assert.deepStrictEqual(h.errors, [], "no console errors or exceptions");
  await h.close();
}

// ---------- 2. a failed run
{
  const h = await harness();
  await h.open(); h.startRun();
  h.ev({ type: "phase-end", phase: "builder", attempt: 1, verdict: { completed: false, outcome: "fail", headline: "Tests fail", details: "", concerns: [], blockingFindings: ["x"] } });
  h.ev({ type: "run-end", status: "failed" });
  await h.page.waitForFunction(() => AL.mascot.state().mood === "fail");
  await h.page.waitForFunction(() => !document.getElementById("cat").classList.contains("travelling")); // it dances on the way over; judge it once it has arrived
  assert.ok(await h.page.evaluate(() => document.querySelector("#cat .cat-wrap").classList.contains("slump")), "a failed run slumps the cat");
  assert.ok(!(await h.page.evaluate(() => document.querySelector("#cat .cat-body").classList.contains("spr-play"))), "…and it stops dancing");
  console.log("[ok] a failed run: the cat slumps and stops dancing");
  await h.close();
}

// ---------- 3. it naps when nothing happens, and wakes at a touch (fake clock: no 90 s wait)
{
  const h = await harness({ clock: true });
  await h.open();
  await h.page.clock.runFor(95_000);
  await h.page.waitForFunction(() => AL.mascot.state().mood === "sleep");
  assert.strictEqual(await h.page.locator("#cat .cat-zzz").isVisible(), true, "z z z");
  // an unrelated update to the page's state must not wake it; only activity does
  await h.page.evaluate(() => AL.mascot.sync({ status: "idle", pending: 0, say: "", offline: false }));
  assert.strictEqual((await state(h.page)).mood, "sleep", "a state update with nothing new in it leaves a sleeping cat asleep");
  await h.page.mouse.move(300, 300); await h.page.mouse.move(320, 320);
  await h.page.waitForFunction(() => AL.mascot.state().mood === "idle");
  console.log("[ok] after 90 s of quiet the cat naps; moving the mouse wakes it");
  // and an agent needing you wakes it for real
  await h.page.clock.runFor(95_000); await h.page.waitForFunction(() => AL.mascot.state().mood === "sleep");
  h.startRun(); h.askApproval("qs");
  await h.page.waitForFunction(() => AL.mascot.state().mood === "attention");
  console.log("[ok] a sleeping cat still answers a waiting prompt");
  await h.close();
}

// ---------- 4. it can be switched off, and stays off
{
  const h = await harness();
  await h.open();
  await h.page.keyboard.press("?");
  await h.page.waitForSelector("#help:not([hidden])");
  await h.page.locator("#opt-cat").uncheck();
  assert.strictEqual(await h.page.locator("#cat").isHidden(), true, "the cat disappears");
  assert.strictEqual((await state(h.page)).enabled, false);
  await h.page.keyboard.press("Escape");
  await h.page.reload(); await h.page.waitForFunction(() => document.getElementById("status")?.textContent === "live");
  assert.strictEqual((await state(h.page)).enabled, false, "and it stays off after a reload");
  h.startRun(); h.askApproval("qo");
  await h.page.waitForSelector("#prompt");
  assert.strictEqual(await h.page.locator("#cat").isHidden(), true, "even when something needs you the page does not bring it back");
  await h.page.keyboard.press("y"); // the prompt still works without it
  await h.page.waitForSelector("#prompt", { state: "detached" });
  console.log("[ok] the cat can be switched off in the help window, stays off after reload, and the prompt works without it");
  await h.close();
}

// ---------- 5. pixel cursors and icons really load, and can be turned off
{
  const h = await harness();
  const { page } = h;
  await h.open(); h.startRun();
  await page.waitForSelector(".step");
  const cursorOf = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).cursor, sel);
  const manifest = JSON.parse((await import("node:fs")).readFileSync("ui/assets/manifest.json", "utf8"));
  const hot = (n) => `${manifest.cursors[n].x} ${manifest.cursors[n].y}`;
  assert.ok((await cursorOf("body")).startsWith('url("data:image/png;base64,') && (await cursorOf("body")).endsWith(`${hot("default")}, auto`), "the page's own arrow, hotspot at its tip: " + (await cursorOf("body")).slice(-24));
  assert.ok((await cursorOf("#theme-toggle")).endsWith(`${hot("pointer")}, pointer`), "buttons get the pointing hand, hotspot at the fingertip");
  assert.ok((await cursorOf("#decision-input")).endsWith(`${hot("text")}, text`), "the input gets the text cursor");
  const icons = await page.evaluate(() => [...document.querySelectorAll(".step")].map((s) => { const i = s.querySelector(".px"); const cs = i && getComputedStyle(i); return { phase: s.dataset.phase, w: cs && cs.width, bg: cs && cs.backgroundImage.slice(0, 26) }; }));
  assert.strictEqual(icons.length, 5);
  for (const i of icons) assert.ok(i.w === "17px" && i.bg.startsWith('url("data:image/png;base64'), `${i.phase} has its 17px icon`);
  h.ev({ type: "tool-call", phase: "builder", toolUseId: "g", toolName: "Grep", toolInput: { pattern: "x" } });
  await page.waitForSelector(".blk.tool .line .px");
  assert.strictEqual(await page.evaluate(() => getComputedStyle(document.querySelector(".blk.tool .line .px")).width), "12px", "tool lines carry a 12px icon");
  console.log("[ok] cursors (with hotspots) and icons are really applied: arrow, hand, text cursor, 5 phase icons, tool icons");
  await page.keyboard.press("?"); await page.locator("#opt-cursors").uncheck(); await page.keyboard.press("Escape");
  assert.ok(!(await cursorOf("body")).includes("data:image"), "with pixel cursors off the system cursor is back");
  await page.reload(); await page.waitForFunction(() => document.getElementById("status")?.textContent === "live");
  assert.ok(!(await cursorOf("body")).includes("data:image"), "and it stays off after a reload");
  console.log("[ok] pixel cursors can be turned off, and it is remembered");
  await h.close();
}

// ---------- 6. reduced motion: the cat still goes where it is needed, without the motion
{
  const h = await harness({ reducedMotion: true });
  await h.open(); h.startRun(); h.askApproval("qr");
  await h.page.waitForSelector("#prompt");
  const cat = await settledAt(h.page, "attention", "prompt");
  const prompt = await box(h.page, "#prompt");
  near(cat.bottom, prompt.top + 8, 2, "reduced motion: still beside the prompt that needs you");
  assert.ok(!(await h.page.evaluate(() => document.querySelector("#cat .cat-wrap").classList.contains("hopping"))), "no hopping");
  const dur = await h.page.evaluate(() => getComputedStyle(document.getElementById("cat")).transitionDuration);
  assert.ok(parseFloat(dur) <= 0.001, `no sliding: the transition is ${dur}, so it is simply there`);
  assert.strictEqual(await h.page.evaluate(() => getComputedStyle(document.querySelector("#cat .cat-body")).animationName), "none", "no frame animation");
  assert.strictEqual(await h.page.locator("#cat .cat-bubble").innerText(), "builder needs you", "the words are still there");
  console.log("[ok] reduced motion: the cat is beside the waiting prompt and says so, with no hopping, sliding or frame animation");
  await h.close();
}

// ---------- 7. hostile text is only ever text
{
  const h = await harness();
  await h.open(); h.startRun();
  const bad = '<img src=x onerror="window.__pwned=1">';
  h.askApproval("qh", { phase: bad });
  await h.page.waitForFunction(() => AL.mascot.state().mood === "attention");
  assert.strictEqual(await h.page.evaluate(() => window.__pwned), undefined, "nothing ran");
  assert.strictEqual(await h.page.locator("#cat img").count(), 0, "no element was created inside the cat");
  assert.ok((await h.page.locator("#cat .cat-bubble").innerText()).includes("<img"), "the markup is shown as text");
  console.log("[ok] a hostile agent name in an approval is shown as text in the bubble and runs nothing");
  assert.deepStrictEqual(h.errors, []);
  await h.close();
}

// ---------- 8. the page works with any extra missing
for (const [what, abort] of [["no sprites at all", ["/sprite-data.js"]], ["no cat script", ["/mascot.js"]], ["no sprite helper", ["/sprites.js"]], ["none of the extras", ["/sprite-data.js", "/sprites.js", "/mascot.js", "/sound.js", "/offline.js"]]]) {
  const h = await harness({ abort });
  await h.open(); h.startRun(); h.askApproval("qm");
  await h.page.waitForSelector("#prompt");
  assert.ok((await h.page.locator("#welcome").innerText()).includes("Welcome"), `${what}: the welcome card renders`);
  assert.strictEqual(await h.page.locator(".step").count(), 5, `${what}: the stepper renders`);
  assert.ok((await h.page.locator("#prompt .title").innerText()).includes("Bash command"), `${what}: the prompt renders`);
  assert.ok(await h.page.evaluate(() => { const c = document.getElementById("cat"); return !c || c.hidden || getComputedStyle(c).display === "none"; }), `${what}: no cat is shown, and nothing complains`);
  await h.page.keyboard.press("y");
  await h.page.waitForSelector("#prompt", { state: "detached" });
  assert.deepStrictEqual(h.errors, [], `${what}: no errors`);
  await h.close();
}
// ---------- 8b. a permission prompt says, in plain words, what kind of thing it asks to do (from the tool, never its arguments)
{
  const h = await harness();
  await h.open(); h.startRun();
  const kinds = [["Bash", "runs a shell command"], ["Write", "changes files"], ["Edit", "changes files"], ["mcp__browser__click", "controls the browser"], ["mcp__desktop__click", "controls a desktop window"]];
  for (const [i, [tool, words]] of kinds.entries()) {
    const id = "kind" + i;
    h.ev({ type: "tool-call", phase: "builder", toolUseId: "tu-" + id, toolName: tool, toolInput: { command: "x", file_path: "/work/app/a.js", content: "c", old_string: "a", new_string: "b", ref: "s1e1" } });
    h.ev({ type: "approval-request", phase: "builder", requestId: id, toolUseId: "tu-" + id, toolName: tool, toolInput: { command: "x", file_path: "/work/app/a.js", content: "c", old_string: "a", new_string: "b", ref: "s1e1" }, rule: "r" });
    await h.page.waitForFunction((r) => document.querySelector("#prompt")?.dataset.request === r, id);
    assert.strictEqual(await h.page.locator("#prompt .kind").innerText(), words, `${tool} is labelled "${words}"`);
    h.ev({ type: "approval-resolved", phase: "builder", requestId: id, toolUseId: "tu-" + id, decision: "allow" });
    await h.page.waitForSelector("#prompt", { state: "detached" });
  }
  h.ev({ type: "tool-call", phase: "builder", toolUseId: "tu-u", toolName: "SomethingNew", toolInput: {} });
  h.ev({ type: "approval-request", phase: "builder", requestId: "ku", toolUseId: "tu-u", toolName: "SomethingNew", toolInput: {}, rule: "r" });
  await h.page.waitForSelector("#prompt");
  assert.strictEqual(await h.page.locator("#prompt .kind").count(), 0, "a tool it does not know gets no label rather than a guess");
  console.log("[ok] prompts are labelled in plain words: shell command, changes files, controls the browser / a desktop window; an unknown tool gets no label");
  assert.deepStrictEqual(h.errors, []);
  await h.close();
}

// ---------- 9. the help window never lets a key answer the permission prompt behind it
{
  const h = await harness();
  const { page } = h;
  await h.open(); h.startRun(); h.askApproval("qk");
  await page.waitForSelector("#prompt");
  await page.keyboard.press("?");
  await page.waitForSelector("#help:not([hidden])");
  for (const k of ["y", "n", "ArrowDown", "1", "2", "3"]) await page.keyboard.press(k);
  assert.ok(await page.locator("#prompt").isVisible(), "keys pressed in the help window did not answer the prompt");
  assert.strictEqual(await page.locator("#fb").evaluate((e) => e.classList.contains("open")), false, "…nor open its feedback box");
  await page.keyboard.press("Escape");
  assert.ok(await page.locator("#help").isHidden(), "Esc closes the help window");
  assert.ok(await page.locator("#prompt").isVisible(), "…and does not also reject the prompt behind it");
  await page.keyboard.press("y");
  await page.waitForSelector("#prompt", { state: "detached" });
  console.log("[ok] with the help window open, y / n / 1-3 / arrows / Esc never answer the prompt behind it; afterwards y still does");
  assert.deepStrictEqual(h.errors, []);
  await h.close();
}
console.log("[ok] with sprites, the cat, the helper, or every extra missing, the page still renders and a permission prompt can still be answered");
console.log("\nALL MASCOT UI TESTS PASSED");
