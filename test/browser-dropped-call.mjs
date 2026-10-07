// While a page opens and closes windows, or the machine is busy, Chromium sometimes drops a call: the browser tools got "Resulting promise was garbage collected" for an `inspect` right after a popup
// storm (the full suite failed on it twice, see docs/SELF-HEALING.md). The call did not complete and the next one works, so a read is asked again once, and an action is not repeated (it may have
// happened) but says so in words an agent can act on. The drop cannot be forced on a real page, so the test makes the real page's call fail the way the browser does, once or always.
// Real Chromium and a local server; no API calls.
//   npm run build && npm run test:browser-dropped-call
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { BrowserSessionManager, __testHandlers } from "../dist/browser-tools.js";
import { EventBus } from "../dist/bus.js";

const app = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>dropped</title><h1>Dropped</h1><button id="b" onclick="window.clicks=(window.clicks||0)+1">go</button><p>Some words on the page.</p>`);
});
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${app.address().port}`;
const bus = new EventBus();
const sessions = new BrowserSessionManager();
const h = __testHandlers({ runId: "drop", bus, sessions, artifactDir: mkdtempSync(join(tmpdir(), "drop-art-")) });
const call = async (name, args = {}) => {
  const r = await h[name].handler(args, {});
  return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: !!r.isError };
};
const DROPPED = (what) => new Error(`${what}: Resulting promise was garbage collected.`);
const RAW = /Resulting promise was garbage collected/;

try {
  await call("open", { url: `${base}/` });
  const session = sessions.get("drop");
  const frame = session.tabs[0].page.mainFrame();
  const realEvaluateHandle = frame.evaluateHandle.bind(frame);
  const failFirst = (n) => {
    let left = n, calls = 0;
    frame.evaluateHandle = (...a) => { calls += 1; return left-- > 0 ? Promise.reject(DROPPED("frame.evaluateHandle")) : realEvaluateHandle(...a); };
    return { calls: () => calls };
  };
  const restore = () => { frame.evaluateHandle = realEvaluateHandle; };

  // 1. A read that was dropped once is asked again, and the agent gets the answer, not the drop.
  {
    const probe = failFirst(1);
    const r = await call("inspect");
    restore();
    assert.ok(!r.isError && /Dropped/.test(r.text), `inspect after one dropped call: ${r.isError ? "an error: " : "no heading: "}${r.text.slice(0, 200)}`);
    assert.ok(!RAW.test(r.text), `the raw browser error reached the agent: ${r.text.slice(0, 200)}`);
    assert.strictEqual(probe.calls(), 2, `a dropped read is asked exactly once more (calls: ${probe.calls()})`);
    console.log("[ok] inspect that the browser dropped once is asked again once and answers");
  }

  // 2. A read that is dropped every time gives up after the one retry, says nothing was changed, and does not show the browser's wording.
  {
    const probe = failFirst(99);
    const r = await call("inspect");
    restore();
    assert.ok(r.isError, "an inspect that failed twice is an error");
    assert.strictEqual(probe.calls(), 2, `no more than one retry (calls: ${probe.calls()})`);
    assert.ok(!RAW.test(r.text), `the raw browser error reached the agent: ${r.text}`);
    assert.ok(/dropped/.test(r.text) && /busy or changing/.test(r.text) && /Nothing was changed/.test(r.text) && /call inspect again/i.test(r.text), `the message does not say what happened and what to do: ${r.text}`);
    console.log("[ok] a read dropped twice stops after one retry and says: dropped, the page was busy or changing, nothing changed, call again");
  }

  // 3. The next call after a drop is a normal one (nothing was left half-done: refs, notices, the active tab).
  {
    const r = await call("inspect");
    assert.ok(!r.isError && /Dropped/.test(r.text) && /\bs\d+e\d+\b/.test(r.text), `inspect after the drops: ${r.text.slice(0, 200)}`);
    console.log("[ok] the call after a drop is a normal answer with refs");
  }

  // 3b. `text` reads through a locator: a drop there used to come back as "the page has 0 characters", which is a false statement, not an error.
  {
    const proto = Object.getPrototypeOf(session.tabs[0].page.locator("body"));
    const realInnerText = proto.innerText;
    let left = 1, calls = 0;
    proto.innerText = function (...a) { calls += 1; return left-- > 0 ? Promise.reject(DROPPED("locator.innerText")) : realInnerText.apply(this, a); };
    let r;
    try { r = await call("text"); } finally { proto.innerText = realInnerText; }
    assert.ok(!r.isError && /Some words on the page/.test(r.text) && !/0 characters/.test(r.text), `text after one dropped call: ${r.text.slice(0, 200)}`);
    assert.strictEqual(calls, 2, `a dropped text read is asked once more (calls: ${calls})`);
    console.log("[ok] text that the browser dropped once is asked again and returns the page's words, not an empty page");
  }

  // 4. An action that was dropped is NOT repeated (it may have happened): one attempt, and the message says it may or may not have happened and to look.
  {
    const proto = Object.getPrototypeOf(session.tabs[0].page.locator("#b")); // a selector is acted on through a Locator
    const realClick = proto.click;
    let clicks = 0;
    proto.click = function (...a) { clicks += 1; return Promise.reject(DROPPED("locator.click")); };
    let r;
    try { r = await call("click", { selector: "#b" }); } finally { proto.click = realClick; }
    assert.strictEqual(clicks, 1, `a dropped click was tried ${clicks} times (an action must not be repeated)`);
    assert.ok(r.isError && !RAW.test(r.text), `a dropped click: ${r.text}`);
    assert.ok(/may or may not have happened/.test(r.text) && /inspect/.test(r.text), `the message does not say the click may have happened and to look: ${r.text}`);
    console.log("[ok] a dropped click is tried once, not repeated, and the message says it may or may not have happened");
  }

  // 5. Errors that are not drops are left alone: no retry, the browser's own message stays.
  {
    let calls = 0;
    frame.evaluateHandle = () => { calls += 1; return Promise.reject(new Error("frame.evaluateHandle: Execution context was destroyed, most likely because of a navigation")); };
    const r = await call("inspect");
    restore();
    assert.strictEqual(calls, 1, `an ordinary failure was retried (${calls} calls)`);
    assert.ok(r.isError && /Execution context was destroyed/.test(r.text), `an ordinary failure lost its message: ${r.text}`);
    console.log("[ok] a failure that is not a drop is not retried and keeps its message");
  }
} finally {
  await sessions.close("drop", bus, "completed").catch(() => {});
  app.close();
}
console.log("\nALL DROPPED-CALL TESTS PASSED");
