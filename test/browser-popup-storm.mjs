// A page that opens and closes popups must not be able to end the agent-loop process (adversary round 2, A41). With video recording on (every normal run), a page that closed while one of its
// requests was inside the route callback made `route.continue()` reject with TargetClosedError; nobody awaited that callback, so it was an unhandled rejection and Node 22 ended the whole
// process: the browser was orphaned and the run stayed "running" in the database. Three window.open/close pairs were enough about one time in three; ten with eight requests each, five times in six. The popup limit did not help (popups that close themselves never
// reach it) and every popup ever opened stayed in memory for the life of the session.
// The failure kills the process, so the scenario runs in a child process and the parent reads its exit status. Real Chromium, a local server, no API calls.
//   npm run build && npm run test:browser-popup-storm
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert";

const SELF = fileURLToPath(import.meta.url);

if (process.argv[2] === "child") {
  const { BrowserSessionManager, __testHandlers } = await import("../dist/browser-tools.js");
  const { EventBus } = await import("../dist/bus.js");
  const n = Number(process.argv[3]);
  const video = process.argv[4] === "video";
  const app = createServer((req, res) => {
    const path = req.url.split("?")[0];
    res.writeHead(200, { "content-type": "text/html" });
    if (path === "/storm") return res.end(`<!doctype html><title>storm</title><h1>Storm</h1><script>let i=0;const t=setInterval(()=>{const w=window.open('/pop?'+i);setTimeout(()=>{try{w.close()}catch{}},8);if(++i>=${n})clearInterval(t)},15)</script>`);
    if (path === "/pop") return res.end(`<!doctype html><title>pop</title><script>for(let k=0;k<8;k++){fetch('/slow?'+Math.random()).catch(()=>{});new Image().src='/img?'+Math.random()}</script>`);
    if (path === "/slow" || path === "/img") return void setTimeout(() => res.end("x"), 40);
    res.end(`<!doctype html><title>t</title><h1>ok</h1>`);
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const bus = new EventBus();
  const videoDir = mkdtempSync(join(tmpdir(), "storm-video-"));
  const sessions = new BrowserSessionManager(video ? { videoDirFor: () => videoDir } : {});
  const h = __testHandlers({ runId: "storm", bus, sessions, artifactDir: mkdtempSync(join(tmpdir(), "storm-art-")) });
  const call = async (name, args = {}) => { const r = await h[name].handler(args, {}); return r.content.map((c) => c.text ?? "").join("\n"); };
  await call("open", { url: `${base}/storm` });
  await new Promise((r) => setTimeout(r, Math.max(1500, n * 40 + 800)));
  const after = await call("inspect");
  const tabsText = await call("list_tabs");
  const session = sessions.sessions.get("storm");
  const result = { answers: /Storm/.test(after), everTabs: session.everTabs.length, openTabs: session.tabs.length, refused: session.refusedTabs, mentionsRefusal: /popup\(s\) were closed as they opened/.test(tabsText) };
  await sessions.close("storm", bus, "completed");
  result.videos = readdirSync(videoDir).filter((f) => f.endsWith(".webm")).length;
  app.close();
  console.log(`RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

const runChild = (n, mode) => {
  const r = spawnSync(process.execPath, ["--experimental-sqlite", "--no-warnings", SELF, "child", String(n), mode], { encoding: "utf8", timeout: 120_000 });
  const m = (r.stdout + r.stderr).match(/RESULT (\{.*\})/);
  return { status: r.status, result: m ? JSON.parse(m[1]) : undefined, out: `${r.stdout}${r.stderr}`.slice(-600) };
};

// 1. With video on, popups that open and close themselves do not end the process (control: one popup never did).
{
  const one = runChild(1, "video");
  assert.strictEqual(one.status, 0, `control: a single popup with video on ended the process (${one.status}): ${one.out}`);
  for (const n of [10, 30]) {
    for (let run = 1; run <= 2; run++) {
      const r = runChild(n, "video");
      assert.strictEqual(r.status, 0, `${n} popups with video on, run ${run}: the process ended with status ${r.status}\n${r.out}`);
      assert.ok(r.result?.answers, `${n} popups, run ${run}: the browser tools no longer answer afterwards: ${JSON.stringify(r.result)}`);
    }
  }
  console.log("[ok] ten and thirty popups that open and close themselves with eight requests each, video on, twice each: the process lives and the tools still answer (one popup was always fine; on the old build this storm ended the process in five runs of six, and three popups with one request each in about one of three)");
}

// 2. A storm is bounded: the number of tabs ever held, not only the number open, and the agent is told popups were closed.
{
  const r = runChild(150, "plain");
  assert.strictEqual(r.status, 0, `a storm of 150 popups ended the process (${r.status}): ${r.out}`);
  assert.ok(r.result.everTabs <= 60, `the session held ${r.result.everTabs} tabs after a storm of 150 popups (limit 60)`);
  assert.ok(r.result.refused > 0 && r.result.mentionsRefusal, `the storm was not reported to the agent: ${JSON.stringify(r.result)}`);
  assert.ok(r.result.openTabs <= 10, `${r.result.openTabs} tabs were open at once (limit 10)`);
  console.log(`[ok] a storm of 150 popups leaves at most 60 tabs ever held (${r.result.everTabs}), at most 10 open (${r.result.openTabs}), ${r.result.refused} closed on arrival, and list_tabs tells the agent`);
}
console.log("\nALL POPUP STORM TESTS PASSED");
