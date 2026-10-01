// A long run replays into the page quickly and correctly (ui/index.html: replay batching). A reload, a reconnect and a saved
// report all replay the whole run in one burst; repainting the stepper/header/dock and forcing a layout after every event
// made 6,000 events take about 30 s. Now the replay only appends and the chrome is painted once. No API calls:
//   npm run build && node --experimental-sqlite --no-warnings test/ui-replay.mjs
import assert from "node:assert";
import { harness } from "./ui-extras-helpers.mjs";

async function replayMs(pairs) {
  const h = await harness();
  h.startRun();
  for (let i = 0; i < pairs; i++) {
    h.ev({ type: "tool-call", phase: "builder", toolUseId: "t" + i, toolName: i % 3 ? "Read" : "Bash", toolInput: i % 3 ? { file_path: "/work/app/f" + i + ".js" } : { command: "npm test " + i } });
    h.ev({ type: "tool-result", phase: "builder", toolUseId: "t" + i, toolName: "", isError: false, summary: "line a\nline b\nline c\nline d" });
  }
  h.ev({ type: "usage", phase: "builder", role: "phase", costUsd: 1.25, turns: 5, durationMs: 1000 });
  const t0 = Date.now();
  await h.page.goto(`http://127.0.0.1:${h.port}/#token=${h.token}`);
  await h.page.waitForFunction(() => document.getElementById("status")?.textContent === "live" && !!window.AL && document.querySelectorAll(".blk.tool").length > 0, undefined, { timeout: 90000 });
  // the painted chrome must be right the moment the page is usable, not after the next live event
  await h.page.waitForFunction(() => document.getElementById("cost").textContent === "1.25", undefined, { timeout: 5000 });
  const ms = Date.now() - t0;
  const seen = await h.page.evaluate(() => ({
    blocks: document.querySelectorAll("#transcript .blk").length,
    tools: +document.getElementById("s-tools").textContent,
    builder: document.querySelector('.step[data-phase="builder"]').dataset.state,
    planner: document.querySelector('.step[data-phase="planner"]').dataset.state,
    runState: document.getElementById("run-state").textContent,
    atBottom: Math.abs(document.getElementById("scroll").scrollHeight - document.getElementById("scroll").scrollTop - document.getElementById("scroll").clientHeight) < 4,
  }));
  assert.ok(h.errors.length === 0, "no errors: " + h.errors.join("; "));
  await h.close();
  return { ms, seen };
}

const small = await replayMs(500);
const big = await replayMs(3000);
assert.strictEqual(big.seen.builder, "active", "the stepper is painted when the replay ends");
assert.strictEqual(big.seen.runState, "running", "the header is painted when the replay ends");
assert.ok(big.seen.tools >= 2000 && big.seen.tools === big.seen.blocks - 1 || big.seen.tools > 2000, `the side panel counted the replayed tool calls (${big.seen.tools})`);
assert.ok(big.seen.atBottom, "a replay ends scrolled to the newest activity");
assert.ok(big.ms < 10_000, `a 6,000-event replay is usable in ${big.ms} ms (it took ~30 s before batching)`);
assert.ok(big.ms < small.ms * 14, `replay time grows about linearly: ${small.ms} ms for 1,000 events, ${big.ms} ms for 6,000 (quadratic growth would be ~36x)`);
console.log(`[ok] a 1,000-event replay is usable in ${small.ms} ms and a 6,000-event one in ${big.ms} ms; the stepper, header, cost and scroll position are right the moment it is`);
console.log("\nALL REPLAY TESTS PASSED");
