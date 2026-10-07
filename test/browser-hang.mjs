// A page whose main thread is busy answers nothing, and nothing the browser tools did had a deadline (adversary round 2, A31): `inspect`, `click` and `scroll` waited for ever on a page with
// one `for(;;){}`, a bug an agent that verifies apps will meet sooner or later, in a run meant to go unattended. Every tool now gives up after a deadline, says why, and leaves a fresh tab so the run
// can carry on. Real Chromium and a local server, with a short deadline so the test is quick; no API calls.
//   npm run build && npm run test:browser-hang
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { BrowserSessionManager, __testHandlers } from "../dist/browser-tools.js";
import { EventBus } from "../dist/bus.js";

const app = createServer((req, res) => {
  const path = req.url.split("?")[0];
  res.writeHead(200, { "content-type": "text/html" });
  if (path === "/busy") return res.end(`<!doctype html><title>busy</title><h1>Busy</h1><button id="b">go</button><script>setTimeout(()=>{for(;;){}},300)</script>`);
  if (path === "/frame-busy") return res.end(`<!doctype html><title>outer</title><h1>Outer</h1><input id="name"><iframe src="/busy-inner"></iframe>`);
  if (path === "/busy-inner") return res.end(`<!doctype html><title>inner</title><script>setTimeout(()=>{for(;;){}},300)</script>`);
  res.end(`<!doctype html><title>fine</title><h1>Fine</h1><button id="ok">ok</button>`);
});
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${app.address().port}`;
const bus = new EventBus();
const DEADLINE = 1500;
const sessions = new BrowserSessionManager();
const h = __testHandlers({ runId: "hang", bus, sessions, artifactDir: mkdtempSync(join(tmpdir(), "hang-art-")), toolDeadlineMs: DEADLINE });
const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await h[name].handler(args, {});
  return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: !!r.isError, ms: Date.now() - t0 };
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // 1. A busy page: the tools answer with an error inside the deadline (plus a little) instead of waiting for ever, and say what happened.
  for (const tool of ["inspect", "click", "scroll"]) {
    await sessions.close("hang", bus, "completed").catch(() => {});
    await call("open", { url: base + "/busy" });
    await settle(1000); // the loop starts at 300 ms
    const args = tool === "click" ? { selector: "#b" } : tool === "scroll" ? { dy: 600 } : {};
    const r = await call(tool, args);
    assert.ok(r.isError && /the page is not responding/.test(r.text), `${tool} on a busy page: ${r.isError ? "" : "no error; "}${r.text.slice(0, 200)}`);
    assert.ok(r.ms >= DEADLINE - 100 && r.ms < DEADLINE + 8000, `${tool} took ${r.ms} ms (deadline ${DEADLINE})`);
    assert.ok(/fresh tab t\d+/.test(r.text), `${tool}: no fresh tab was left for the run to carry on in: ${r.text}`);
  }
  console.log("[ok] inspect, click and scroll on a page stuck in a loop each give up at the deadline, say the page is not responding, and leave a fresh tab");

  // 2. The run can carry on in the fresh tab, and the stuck one can be closed.
  {
    await sessions.close("hang", bus, "completed").catch(() => {});
    await call("open", { url: base + "/busy" });
    await settle(1000);
    const hung = await call("inspect");
    const fresh = hung.text.match(/fresh tab (t\d+)/)?.[1];
    assert.ok(fresh, `no fresh tab: ${hung.text}`);
    const opened = await call("open", { url: base + "/ok" });
    assert.ok(!opened.isError && /Fine|fine/.test((await call("inspect")).text), `the fresh tab does not work: ${opened.text}`);
    const tabs = await call("list_tabs");
    assert.ok(/t1/.test(tabs.text) && new RegExp(fresh).test(tabs.text), `list_tabs: ${tabs.text}`);
    const closed = await call("close_tab", { tabId: "t1" });
    assert.ok(!closed.isError && /Closed t1/.test(closed.text) && closed.ms < DEADLINE, `the stuck tab could not be closed quickly (${closed.ms} ms): ${closed.text}`);
    console.log("[ok] the run carries on in the fresh tab (open and inspect work) and the stuck tab is closed without waiting for its page");
  }

  // 3. A frame with the loop in it (it shares the page's thread) is the same.
  {
    await sessions.close("hang", bus, "completed").catch(() => {});
    await call("open", { url: base + "/frame-busy" });
    await settle(1000);
    const r = await call("inspect");
    assert.ok(r.isError && /the page is not responding/.test(r.text) && r.ms < DEADLINE + 8000, `a busy frame: ${r.text.slice(0, 200)} (${r.ms} ms)`);
    console.log("[ok] a busy loop inside an iframe on an otherwise normal page is the same: inspect gives up and says why");
  }

  // 4. Controls: a slow tool that finishes inside the deadline is left alone, and ordinary tools are not slowed.
  {
    await sessions.close("hang", bus, "completed").catch(() => {});
    await call("open", { url: base + "/ok" });
    const slow = await call("wait", { timeoutMs: 1000 });
    assert.ok(!slow.isError && /waited 1000ms/.test(slow.text) && slow.ms >= 950, `a 1 s wait under a ${DEADLINE} ms deadline was cut: ${slow.text}`);
    const quick = await call("inspect");
    assert.ok(!quick.isError && quick.ms < 3000 && !/not responding/.test(quick.text), `an ordinary inspect: ${quick.text.slice(0, 100)} (${quick.ms} ms)`);
    const tooSlow = await call("wait", { timeoutMs: 3000 });
    assert.ok(tooSlow.isError && /not responding/.test(tooSlow.text), "control: a wait longer than the deadline is cut (the deadline really applies)");
    console.log("[ok] a 1 s wait and an ordinary inspect are left alone under the same deadline; a wait longer than the deadline is cut");
  }
} finally {
  await sessions.close("hang", bus, "completed").catch(() => {});
  app.close();
}
console.log("\nALL BROWSER HANG TESTS PASSED");
process.exit(0);
