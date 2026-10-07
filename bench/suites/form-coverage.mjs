// Can the agent see the whole application form? One page with a field in the main frame, a field in a same-origin iframe, a field in a
// cross-origin iframe (Greenhouse embeds its form this way), a field in an open shadow root, a custom element with a closed shadow root (not readable by
// anyone's script), and a text field a person cannot see (opacity 0: the classic trap for bots). The scorer plays an agent that does the obvious: open, look
// (inspect), and act through what it was shown. A field counts as seen only if it appears as a ref line, the thing an agent can act on; text in a page's
// source does not. Nothing is told to the scorer about how the tools report.
// Adversary round 1, finding A10: a diff of the filled form against the facts that sees one field of four reports "no mismatch" for questions it never read.
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../lib.mjs";

export const meta = {
  id: "form-coverage",
  title: "Form fields the agent is shown across iframes, shadow roots and hidden traps",
  unit: "of 8",
  higherIsBetter: true,
  stage: "S1b",
};

/** The pages, shared with test/browser-frames.mjs so the benchmark and the test look at the same form. `alt` is another origin on the same server
 * (localhost against 127.0.0.1), which is what makes a frame cross-origin while staying inside the local-only rule. */
export function formPages({ alt }) {
  return {
    "/f": `<!doctype html><title>Apply</title><h1>Apply for the job</h1>
<label>Main-frame field MAIN-FIELD-1 <input id="mainfield"></label>
<iframe id="grnhse_iframe" name="grnhse_iframe" src="/f-frame" style="width:600px;height:200px"></iframe>
<iframe id="xo" name="xo" src="${alt}/f-frame-x" style="width:600px;height:120px"></iframe>
<x-card></x-card>
<script>customElements.define('x-card', class extends HTMLElement { constructor(){ super(); this.attachShadow({mode:'open'}).innerHTML = '<label>Shadow field SHADOW-FIELD-4 <input id="shadowfield"></label>'; } });</script>
<closed-card></closed-card>
<script>customElements.define('closed-card', class extends HTMLElement { constructor(){ super(); this.attachShadow({mode:'closed'}).innerHTML = '<label>Closed field CLOSED-FIELD <input id="closedfield"></label>'; } });</script>
<input id="trap-9" name="website" style="opacity:0" tabindex="-1" autocomplete="off">`,
    "/f-frame": `<!doctype html><title>frame</title><label>Years of experience YEARS-FIELD-2 <input id="years" type="number"></label>
<label>Visa sponsorship? <select id="visa"><option>No</option><option>Yes</option></select></label><button id="submit">Submit application</button>`,
    "/f-frame-x": `<!doctype html><title>frame</title><label>Cross-origin field XORIGIN-FIELD-3 <input id="xfield"></label>`,
  };
}

const refLine = (token) => new RegExp(`\\[s\\d+e\\d+\\][^\\n]*${token}`);

// Pure checks, exported so test/bench-suites.mjs can prove each one fails on silence and passes on a report.
export const CHECKS = {
  "main-frame-field": (o) => refLine("MAIN-FIELD-1").test(o),
  "same-origin-iframe-field": (o) => refLine("YEARS-FIELD-2").test(o),
  "cross-origin-iframe-field": (o) => refLine("XORIGIN-FIELD-3").test(o),
  "open-shadow-root-field": (o) => refLine("SHADOW-FIELD-4").test(o),
  // Acting through what inspect showed: the field in the frame was filled by its ref and inspect then shows the value.
  "iframe-field-fillable-by-ref": (o) => /\[s\d+e\d+\][^\n]*YEARS-FIELD-2[^\n]*value="7"/.test(o),
  // A field no script can read is something the agent has to be told it cannot see, not something it can ignore.
  // Anchored to the tool's own sentence ("... may hold a closed shadow root ..."): the page's source has `attachShadow({mode:'closed'})` on one line, which the looser pattern accepted (A36).
  "closed-shadow-root-reported": (o) => /custom element[^\n]*may hold a closed shadow root/i.test(o),
  // The trap is named, said to be hidden, and not offered as a field to act on.
  // (A line with markup in it is the page's own source echoed back, not the tool's report.)
  "hidden-trap-flagged-not-offered": (o) => !refLine("trap-9").test(o) && o.split("\n").some((l) => /trap-9/.test(l) && !/[<>]/.test(l) && /hidden|not visible|invisible|offscreen/i.test(l)),
  "hidden-trap-fill-refused": (o) => !/^Filled\b/m.test(o) && /not visible|refus|person|catch bots|honeypot/i.test(o),
};
export const PROBE_PATHS = ["/f"];

export async function run() {
  let port = 0;
  const pages = (alt) => formPages({ alt });
  const app = createServer((req, res) => {
    const path = req.url.split("?")[0];
    const body = pages(`http://localhost:${port}`)[path];
    if (!body) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "text/html" }); res.end(body);
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  port = app.address().port;
  const base = `http://127.0.0.1:${port}`;

  const { BrowserSessionManager, __testHandlers } = await import(pathToFileURL(join(ROOT, "dist/browser-tools.js")).href);
  const { EventBus } = await import(pathToFileURL(join(ROOT, "dist/bus.js")).href);
  const bus = new EventBus();
  const sessions = new BrowserSessionManager();
  const artifactDir = mkdtempSync(join(tmpdir(), "bench-form-"));
  const h = __testHandlers({ runId: "bench-form", bus, sessions, artifactDir });
  const text = async (name, args = {}) => {
    if (!h[name]) return "";
    try {
      const r = await h[name].handler(args, {});
      return r.content.map((c) => c.text ?? "").join("\n");
    } catch (e) { return `THREW ${e.message}`; }
  };
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const fresh = async () => { await sessions.close("bench-form", bus, "completed").catch(() => {}); };
  const look = async () => { const o = await text("open", { url: base + "/f" }); await settle(600); return o + "\n" + (await text("inspect")); };

  const probes = {
    "main-frame-field": look,
    "same-origin-iframe-field": look,
    "cross-origin-iframe-field": look,
    "open-shadow-root-field": look,
    "iframe-field-fillable-by-ref": async () => {
      const shown = await look();
      const m = shown.match(/\[(s\d+e\d+)\][^\n]*YEARS-FIELD-2/);
      if (!m) return shown;
      const filled = await text("fill", { ref: m[1], value: "7" });
      return filled + "\n" + (await text("inspect"));
    },
    "closed-shadow-root-reported": look,
    "hidden-trap-flagged-not-offered": look,
    "hidden-trap-fill-refused": async () => { await look(); return await text("fill", { selector: "#trap-9", value: "x" }); },
  };

  const passed = [], failed = [];
  try {
    for (const id of Object.keys(probes)) {
      await fresh();
      const shown = await probes[id]();
      (CHECKS[id](shown) ? passed : failed).push(id);
    }
  } finally {
    await fresh();
    app.close();
  }
  return { value: passed.length, max: Object.keys(probes).length, detail: { seen: passed, missed: failed } };
}
