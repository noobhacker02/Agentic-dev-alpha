// What the browser tools tell the agent about eight things that go wrong on a page.
// The scorer plays an agent that does the obvious: act, then look (inspect), and read the page text with `text` if that tool exists.
// A problem counts as reported only if its distinctive token appears in what the agent was shown. Nothing is told to the scorer
// about how the tools report (pushed notices, a console tool): only what reaches the agent counts.
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../lib.mjs";

export const meta = {
  id: "observability",
  title: "Page problems the agent is told about",
  unit: "of 8",
  higherIsBetter: true,
  stage: "S1",
};

const FILLER = Array.from({ length: 400 }, (_, i) => `Line ${i} of a long job description about responsibilities and benefits.`).join(" ");
// The tokens are built at run time in the page (`"boom-uncaught-" + (3 + 4)`), so the page's own source never holds them: a tool set that only echoes the HTML cannot pass these checks (adversary round 2, A36).
export const PAGES = {
  "/p1": `<!doctype html><title>t</title><h1>App</h1><script>setTimeout(()=>{throw new Error("boom-uncaught-"+(3+4))},30)</script>`,
  "/p2": `<!doctype html><title>t</title><h1>App</h1><script>console.error("render-failed-"+(4+5))</script>`,
  "/p3": `<!doctype html><title>t</title><h1>App</h1><script src="/missing.js"></script>`,
  "/p4": `<!doctype html><title>t</title><button id="b" onclick="alert('hello-dialog-'+(2+3))">go</button>`,
  "/p5": `<!doctype html><title>t</title><a id="a" href="/file.bin">get the file</a>`,
  "/p6": `<!doctype html><title>t</title><div id="app"></div><script>/* renders nothing */</script>`,
  "/p8": `<!doctype html><title>t</title><h1>Job</h1><p>${FILLER}</p><p>THE-END-MARKER-42</p>`,
};

// Pure checks, exported so test/bench-suites.mjs can prove each one fails on silence and passes on a report.
export const CHECKS = {
  "page-error": (o) => /boom-uncaught-7/.test(o),
  "console-error": (o) => /render-failed-9/.test(o),
  "failed-request": (o) => /\b404\b[^\n]*missing\.js/.test(o),
  "dialog": (o) => /hello-dialog-5/.test(o),
  "download": (o) => /file\.bin/.test(o) && /download/i.test(o),
  "blank-page": (o) => /blank|empty page|no visible text|no text/i.test(o),
  // An explicit report that the page was redirected, naming where it ended up. The landing URL alone does not count: `inspect` prints the current URL.
  "redirect": (o) => /redirect[^\n]*final-landing/i.test(o),
  "long-text": (o) => /THE-END-MARKER-42/.test(o),
};
export const PROBE_PATHS = ["/p1", "/p2", "/p3", "/p4", "/p5", "/p6", "/p7", "/p8"];

export async function run() {
  const app = createServer((req, res) => {
    if (req.url === "/missing.js") { res.writeHead(404); return res.end("nope"); }
    if (req.url === "/file.bin") { res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="file.bin"' }); return res.end("DATA"); }
    if (req.url === "/p7") { res.writeHead(302, { location: "/final-landing" }); return res.end(); }
    if (req.url === "/final-landing") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<!doctype html><title>t</title><h1>Landed</h1>"); }
    const body = PAGES[req.url.split("?")[0]];
    if (!body) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "text/html" }); res.end(body);
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.address().port}`;

  const { BrowserSessionManager, __testHandlers } = await import(pathToFileURL(join(ROOT, "dist/browser-tools.js")).href);
  const { EventBus } = await import(pathToFileURL(join(ROOT, "dist/bus.js")).href);
  const bus = new EventBus();
  const sessions = new BrowserSessionManager();
  const artifactDir = mkdtempSync(join(tmpdir(), "bench-obs-"));
  const h = __testHandlers({ runId: "bench", bus, sessions, artifactDir });
  const text = async (name, args = {}) => {
    if (!h[name]) return "";
    try { return (await h[name].handler(args, {})).content.map((c) => c.text ?? "").join("\n"); } catch (e) { return `THREW ${e.message}`; }
  };
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const fresh = async () => { await sessions.close("bench", bus, "completed").catch(() => {}); };

  // Each probe returns everything the agent was shown for that problem.
  const probes = {
    "page-error": async () => { let s = await text("open", { url: base + "/p1" }); await settle(300); return s + (await text("inspect")); },
    "console-error": async () => { let s = await text("open", { url: base + "/p2" }); await settle(200); return s + (await text("inspect")); },
    "failed-request": async () => { let s = await text("open", { url: base + "/p3" }); await settle(200); return s + (await text("inspect")); },
    "dialog": async () => { await text("open", { url: base + "/p4" }); const c = await text("click", { selector: "#b" }); return c + (await text("inspect")); },
    "download": async () => { await text("open", { url: base + "/p5" }); const c = await text("click", { selector: "#a" }); await settle(300); return c + (await text("inspect")); },
    "blank-page": async () => { const s = await text("open", { url: base + "/p6" }); return s + (await text("inspect")); },
    "redirect": async () => { const s = await text("open", { url: base + "/p7" }); return s + (await text("inspect")); },
    // An agent that reads a long page follows the text tool's own hint ("call text with offset=N") until the end or ten more calls.
    "long-text": async () => {
      let out = (await text("open", { url: base + "/p8" })) + (await text("inspect"));
      let t = await text("text");
      out += t;
      for (let i = 0; i < 10; i++) {
        const m = t.match(/offset=(\d+)/);
        if (!m) break;
        t = await text("text", { offset: Number(m[1]) });
        out += t;
      }
      return out;
    },
  };
  const checks = CHECKS;

  const passed = [], failed = [];
  try {
    for (const id of Object.keys(probes)) {
      await fresh();
      const shown = await probes[id]();
      (checks[id](shown) ? passed : failed).push(id);
    }
  } finally {
    await fresh();
    app.close();
  }
  return { value: passed.length, max: Object.keys(probes).length, detail: { reported: passed, silent: failed } };
}
