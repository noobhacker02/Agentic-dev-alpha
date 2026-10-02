// What the page costs while it just sits there, which is most of its life: a prompt can wait for hours while you are away.
// Found by measuring: with a prompt waiting, plain mode burned 4.2% of a core, 15x the floor, because the "needs you" glow animated
// box-shadow (repainted every frame). It animates opacity now (0.31%). CPU is too noisy to assert in CI, so this guards the cause:
// while the page is busy, every infinite animation may animate only compositor-friendly properties. The CPU figures are printed.
//   npm run build && npm run test:ui-idle-cost
import assert from "node:assert";
import { harness } from "./ui-extras-helpers.mjs";

const COMPOSITOR_OK = new Set(["opacity", "transform", "offset", "easing", "composite", "computedOffset", "filter"]);
// The cat's frame strip steps background-position (sprite frames, `steps()` timed, one small element): allowed for `kf-cat-*` by name,
// and nothing else is.
const infinite = (page) => page.evaluate(() => document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().iterations === Infinity).map((a) => ({
  name: a.animationName || "(js)", target: (a.effect.target && (a.effect.target.id ? "#" + a.effect.target.id : a.effect.target.className || a.effect.target.tagName)) + "", props: [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k)))],
})));
const SPRITE_STRIP = new Set(["backgroundPositionX", "backgroundPositionY"]);
const bad = (list) => list.filter((a) => a.props.some((p) => !COMPOSITOR_OK.has(p) && !(a.name.startsWith("kf-cat-") && SPRITE_STRIP.has(p))));
const cpu = async (h, cdp) => { const m = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value])); await h.page.waitForTimeout(1500); const a = await m(); await h.page.waitForTimeout(6000); const b = await m(); return ((b.TaskDuration - a.TaskDuration) / 6) * 100; };

for (const plain of [true, false]) {
  const h = await harness();
  const cdp = await h.ctx.newCDPSession(h.page);
  await cdp.send("Performance.enable");
  await h.open(plain ? "?plain=1" : "?plain=0");
  h.startRun();
  await h.page.waitForSelector(".statusline");
  const working = await infinite(h.page);
  assert.deepStrictEqual(bad(working), [], `working (plain=${plain}): infinite animations that force repaints: ${JSON.stringify(bad(working))}`);
  const cpuWorking = await cpu(h, cdp);
  h.askApproval("q1");
  await h.page.waitForSelector("#prompt");
  await h.page.waitForFunction(() => document.querySelector(".step[data-waiting='1']") && document.querySelector(".blk.tool.awaiting"));
  const waiting = await infinite(h.page);
  assert.ok(waiting.some((a) => a.name === "glow-breathe"), `control: the waiting glow is animating (otherwise this checks nothing): ${JSON.stringify(waiting.map((a) => a.name))}`);
  assert.deepStrictEqual(bad(waiting), [], `prompt waiting (plain=${plain}): infinite animations that force repaints: ${JSON.stringify(bad(waiting))}`);
  const cpuWaiting = await cpu(h, cdp);
  console.log(`[ok] plain=${plain}: working → ${working.length} infinite animation(s), none repaint-bound, ${cpuWorking.toFixed(2)}% CPU; prompt waiting → ${waiting.length}, none repaint-bound, ${cpuWaiting.toFixed(2)}% CPU`);
  assert.deepStrictEqual(h.errors, []);
  await h.close();
}

// the control for the invariant itself: a page that animates box-shadow forever is caught
{
  const h = await harness();
  await h.open("?plain=1");
  await h.page.addStyleTag({ content: "@keyframes bad { 0%,100% { box-shadow: 0 0 0 0 red } 50% { box-shadow: 0 0 9px 2px red } } header { animation: bad 2s infinite; }" });
  const list = await infinite(h.page);
  assert.ok(bad(list).some((a) => a.name === "bad"), "control: a box-shadow animation is flagged");
  await h.close();
}
console.log("\nALL IDLE COST TESTS PASSED");
