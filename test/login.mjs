// `agent-loop login <site>` and the agent-only profile in a real browser (docs/HYBRID-AGENT-SPEC.md S2; threats D4, D5, D6): a person signs in once in a window that keeps its profile in the agent-only directory, and a later
// LIVE browser session starts signed in; neither the person's password nor the site's session cookie ever appears in what agent-loop prints, and two users of one profile are refused. A simulated person drives the
// window (the same Chromium, headless) against a local site that answers for a made-up name; a resolver stand-in points the name at 127.0.0.1 and a stand-in for "public" treats only 127.0.0.1 as public.
//   npm run build && npm run test:login
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import { runLogin } from "../dist/login.js";
import { parseAllowances } from "../dist/allowances.js";
import { BrowserSessionManager, __testHandlers } from "../dist/browser-tools.js";
import { liveBrowserPolicy } from "../dist/browser-policy.js";
import { EventBus } from "../dist/bus.js";

const posix = process.platform !== "win32";
const PASSWORD = "hunter2-correct-horse"; // devskill:allow (a made-up password the simulated person types, to prove it never leaks)
const SESSION = "SESSIONVALUE7f3a9c1e";
const hits = {};
let P = 0;
const server = createServer((req, res) => {
  const host = String(req.headers.host).split(":")[0];
  (hits[host] ??= []).push(req.url);
  const cookie = String(req.headers.cookie ?? "");
  const page = (title, body, headers = {}) => { res.writeHead(200, { "content-type": "text/html", ...headers }); res.end(`<!doctype html><title>${title}</title>${body}`); };
  if (host === "internal.example") return page("INTERNAL", "<h1>INTERNAL-TEXT</h1>");
  if (req.method === "POST" && req.url === "/login") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { res.writeHead(302, { location: "/account", "set-cookie": `sid=${SESSION}; Path=/; HttpOnly; Max-Age=86400` }); res.end(); });
    return;
  }
  if (req.url === "/file.bin") { res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="file.bin"' }); return res.end("DATA".repeat(64)); }
  if (req.url === "/dl") return page("Download", `<a id="dl" href="/file.bin">get the file</a>`);
  if (req.url === "/sw.js") { res.writeHead(200, { "content-type": "application/javascript" }); return res.end("self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(clients.claim())); self.addEventListener('fetch', (e) => e.respondWith(new Response('FROM-SW')));"); }
  if (req.url === "/data") return page("Data", "FROM-SERVER");
  if (req.url === "/swpage") return page("SW", `<script>window.sw = "pending"; navigator.serviceWorker.register("/sw.js").then(() => { window.sw = "registered"; }, (e) => { window.sw = "refused:" + e.name; });</script>`);
  if (req.url === "/account") return page("Account", cookie.includes(`sid=${SESSION}`) ? "<h1>Welcome back, noob</h1>" : "<h1>Please sign in</h1>");
  if (req.url === "/login") return page("Sign in", `<form method="post" action="/login"><input id="user" name="user"><input id="pw" name="pw" type="password"><button id="go">Sign in</button></form>`);
  return page("Home", "<h1>Home</h1>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
P = server.address().port;

const allowances = parseAllowances({ allow: ["login.example", "other.example"], platforms: { demo: ["login.example"], other: ["other.example"] } }).value;
const resolve = async (host) => (host === "internal.example" ? ["10.0.0.5"] : host.endsWith(".example") ? ["127.0.0.1"] : (() => { throw new Error("ENOTFOUND"); })());
const isPublic = (ip) => ip === "127.0.0.1";
const L = (path = "/") => `http://login.example:${P}${path}`;
const scratch = () => mkdtempSync(join(tmpdir(), "login-"));
const base = { allowances, headless: true, isPublic, resolve, extraPorts: [P] };

const filesUnder = (dir) => { const out = []; const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); let st; try { st = statSync(p); } catch { continue; } if (st.isDirectory()) walk(p); else out.push(p); } }; walk(dir); return out; };

try {
  // 1. The person signs in once; the profile keeps the session; what agent-loop prints holds neither the password nor the cookie
  const home = scratch();
  const said = [];
  {
    const r = await runLogin({
      ...base, site: "demo", home, url: L("/login"), say: (l) => said.push(l),
      drive: async ({ page }) => {
        await page.waitForSelector("#user", { timeout: 15000 });
        await page.fill("#user", "noob"); await page.fill("#pw", PASSWORD); await page.click("#go");
        await page.waitForURL(/\/account/, { timeout: 15000 });
        assert.ok(/Welcome back/.test(await page.content()), "control: the simulated sign-in did not work");
      },
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(r.dir.endsWith(join("profiles", "demo")));
    if (posix) { assert.strictEqual(statSync(r.dir).mode & 0o777, 0o700); assert.strictEqual(statSync(join(home, "profiles")).mode & 0o777, 0o700); }
    assert.ok(said.length >= 1 && said.every((l) => !l.includes(PASSWORD) && !l.includes(SESSION)), `a message held a secret: ${said.join(" | ")}`);
    assert.ok(!existsSync(join(home, "profiles", "demo.lock")), "the login left the profile locked");
    assert.deepStrictEqual(hits["internal.example"] ?? [], []);
    const withPassword = filesUnder(r.dir).filter((f) => { try { return readFileSync(f).includes(PASSWORD); } catch { return false; } }); // devskill:allow (the made-up password, searched for in the profile's files)
    assert.deepStrictEqual(withPassword, [], `the password was written into the profile: ${withPassword}`);
    console.log("[ok] a person signs in once in the agent-only window: the profile is 0700 and unlocked afterwards, and neither the password nor the session cookie is in anything agent-loop printed or in the profile's files");
  }

  // 2. A later LIVE session on that profile starts signed in (control: a fresh profile does not)
  {
    const bus = new EventBus();
    const policy = liveBrowserPolicy(allowances, { isPublic, resolve, extraPorts: [P] });
    const run = async (profileHome) => {
      const sessions = new BrowserSessionManager({ policy, profile: { site: "demo", home: profileHome } });
      const h = __testHandlers({ runId: "lg", bus, sessions, artifactDir: mkdtempSync(join(tmpdir(), "lg-art-")) });
      const call = async (name, args = {}) => { const r = await h[name].handler(args, {}); return r.content.map((c) => c.text ?? "").join("\n"); };
      try {
        const opened = await call("open", { url: L("/account") });
        const seen = await call("inspect");
        return { opened, seen, sessions, bus, call, h };
      } finally {
        await sessions.close("lg", bus, "completed").catch(() => {});
      }
    };
    const signedIn = await run(home);
    assert.ok(/Welcome back, noob/.test(signedIn.seen), `the saved session was not used:\n${signedIn.seen.slice(0, 400)}`);
    assert.ok(!signedIn.seen.includes(SESSION) && !signedIn.opened.includes(SESSION), "the session cookie reached what the agent was shown");
    const fresh = await run(scratch());
    assert.ok(/Please sign in/.test(fresh.seen), `control: a fresh profile was signed in:\n${fresh.seen.slice(0, 300)}`);
    assert.ok(!existsSync(join(home, "profiles", "demo.lock")), "the session left the profile locked");
    console.log("[ok] a LIVE browser session on the profile starts signed in and shows the agent nothing of the cookie; a fresh profile is signed out");
  }

  // 3. Two users of one profile: a second session and a login are refused while the first is open, and work after it closes
  {
    const bus = new EventBus();
    const policy = liveBrowserPolicy(allowances, { isPublic, resolve, extraPorts: [P] });
    const a = new BrowserSessionManager({ policy, profile: { site: "demo", home } });
    const b = new BrowserSessionManager({ policy, profile: { site: "demo", home } });
    await a.getOrCreate("two-a", bus);
    await assert.rejects(() => b.getOrCreate("two-b", bus), /profile was refused.*in use by pid \d+/i, "a second session took a profile that was in use");
    const l = await runLogin({ ...base, site: "demo", home, url: L("/login"), drive: async () => { throw new Error("the login should not have opened"); } });
    assert.ok(!l.ok && /in use by pid \d+/.test(l.error), JSON.stringify(l));
    await a.close("two-a", bus, "completed");
    const after = await b.getOrCreate("two-b", bus);
    assert.ok(after.page, "the profile could not be used after the first session closed");
    await b.close("two-b", bus, "completed");
    console.log("[ok] while one session has the profile, a second session and a login are refused with the holder's pid; both work after it closes");
  }

  // 4. The window is on the same gate: the person cannot be led to a private address, and nothing off the list is needed to sign in elsewhere
  {
    const h2 = scratch();
    let status;
    const r = await runLogin({
      ...base, site: "demo", home: h2, url: L("/login"),
      drive: async ({ page }) => {
        const resp = await page.goto(`http://internal.example:${P}/`, { waitUntil: "domcontentloaded" }).catch(() => null);
        status = resp?.status();
        const other = await page.goto(`http://other.example:${P}/`, { waitUntil: "domcontentloaded" }).catch(() => null);
        assert.ok(other && other.status() === 200, "control: a public host was refused in the login window");
      },
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(status, 403, `the login window reached a private address (status ${status})`);
    assert.deepStrictEqual(hits["internal.example"] ?? [], [], "a private address received a request from the login window");
    console.log("[ok] the login window is behind the same gate: a private address is refused, a public host is reachable");
  }

  // 5. What is refused before any window opens
  {
    const home2 = scratch();
    const refuse = async (opts, why) => { const r = await runLogin({ ...base, home: home2, drive: async () => { throw new Error("a window opened"); }, ...opts }); assert.ok(!r.ok && why.test(r.error), `${JSON.stringify(opts)} -> ${JSON.stringify(r)}`); };
    await refuse({ site: "../etc" }, /not a site name/);
    await refuse({ site: "linkedin" }, /not a platform in your allowances file.*demo, other/);
    await refuse({ site: "demo", url: "https://evil.example/login" }, /cannot be opened.*not on the allowances list/);
    await refuse({ site: "demo", url: `http://other.example:${P}/login` }, /belongs to the other platform, not demo/);
    await refuse({ site: "demo", url: "file:///etc/passwd" }, /only http and https/);
    await refuse({ site: "demo", url: L("/login"), forbidden: [tmpdir()] }, /inside/);
    await refuse({ site: "demo", allowances: parseAllowances({ allow: ["login.example"], platforms: {} }).value }, /no platforms|not a platform/);
    assert.ok(!existsSync(join(home2, "profiles", "demo")) || readdirSync(join(home2, "profiles", "demo")).length === 0, "a refused login left a profile behind");
    console.log("[ok] a bad site name, an unknown platform, a login page off the list or on another platform, a profile inside a forbidden directory, and a file: URL are refused before any window opens");
  }

  // 6. The command line: its own messages, no browser
  {
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const root = fileURLToPath(new URL("..", import.meta.url));
    const run = (args, env) => spawnSync(process.execPath, ["--experimental-sqlite", "--no-warnings", cli, "login", ...args], { cwd: root, encoding: "utf8", timeout: 60000, env: { ...process.env, ...env } });
    const h3 = scratch();
    let r = run([], { AGENT_LOOP_HOME: h3 });
    assert.ok(r.status === 1 && /needs a site/.test(r.stderr), `no site: ${r.status} ${r.stderr}`);
    r = run(["linkedin"], { AGENT_LOOP_HOME: h3 });
    assert.ok(r.status === 1 && /no allowances file yet/.test(r.stderr) && /"platforms"/.test(r.stderr), `no file: ${r.status} ${r.stderr}`);
    const file = join(h3, "allowances.json");
    writeFileSync(file, JSON.stringify({ allow: ["linkedin.com"], platforms: { linkedin: ["linkedin.com"] } }));
    if (posix) { chmodSync(file, 0o666); r = run(["linkedin"], { AGENT_LOOP_HOME: h3 }); assert.ok(r.status === 1 && /writable by others/.test(r.stderr), `loose file: ${r.stderr}`); chmodSync(file, 0o600); }
    r = run(["greenhouse"], { AGENT_LOOP_HOME: h3 });
    assert.ok(r.status === 1 && /not a platform in your allowances file.*linkedin/.test(r.stderr), `unknown platform: ${r.stderr}`);
    r = run(["linkedin", "--url"], { AGENT_LOOP_HOME: h3 });
    assert.ok(r.status === 1 && /--url needs a value/.test(r.stderr), `bare --url: ${r.stderr}`);
    r = run(["linkedin", "--url", "https://evil.example/"], { AGENT_LOOP_HOME: h3 });
    assert.ok(r.status === 1 && /not on the allowances list/.test(r.stderr), `off-list url: ${r.stderr}`);
    assert.ok(!existsSync(join(h3, "profiles")), "a refused login made a profiles directory");
    console.log("[ok] the command line says what is missing (a site, the allowances file, the platform, a safe file mode, a value for --url, a login page on the list) and opens nothing");
  }
  // 7. What the mutation check found missing (IMP-028)
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Servers are closed asynchronously, so count after a moment (earlier sections' gates may still be closing)
    const count = () => process._getActiveHandles().filter((h) => h?.constructor?.name === "Server").length;
    const servers = async () => { await sleep(400); return count(); };
    const loginDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("agent-loop-login-")).sort();

    // 7a. With no --url, the login page is the platform's first domain
    const denied = parseAllowances({ allow: ["example.com"], deny: ["a.example.com"], platforms: { demo: ["a.example.com"] } });
    assert.ok(denied.ok, JSON.stringify(denied));
    const noUrl = await runLogin({ ...base, allowances: denied.value, site: "demo", home: scratch(), drive: async () => { throw new Error("a window opened"); } });
    assert.ok(!noUrl.ok && /login page https:\/\/a\.example\.com\/ cannot be opened/.test(noUrl.error), `no --url did not start from the platform's first domain: ${JSON.stringify(noUrl)}`);

    // 7b. Error text is cut and made plain ASCII before it is shown
    const long = await runLogin({ ...base, site: "x".repeat(300) + "\u001b[2J‮é", home: scratch() });
    assert.ok(!long.ok && long.error.length < 260 && /^[\x20-\x7e]*$/.test(long.error), `an error held more than it should: ${JSON.stringify(long.error)}`);
    const accented = await runLogin({ ...base, site: "café", home: scratch() });
    assert.ok(!accented.ok && /^[\x20-\x7e]*$/.test(accented.error) && /caf\?/.test(accented.error), JSON.stringify(accented));

    // 7c. A Chromium that says the profile is in use on another computer is believed, by the login and by a session, and neither leaves the lock
    for (const who of ["login", "session"]) {
      const h = scratch();
      const prepared = (await import("../dist/profile.js")).prepareProfile({ home: h, site: "demo" });
      assert.ok(prepared.ok);
      if (posix) {
        for (const n of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) symlinkSync(n === "SingletonLock" ? "elsewhere-host-4242" : "/nonexistent-singleton-target", join(prepared.dir, n));
        if (who === "login") {
          const r = await runLogin({ ...base, site: "demo", home: h, url: L("/login"), drive: async () => { throw new Error("a window opened on a profile in use elsewhere"); } });
          assert.ok(!r.ok && /in use on elsewhere-host/.test(r.error), `login: ${JSON.stringify(r)}`);
        } else {
          const sessions = new BrowserSessionManager({ policy: liveBrowserPolicy(allowances, { isPublic, resolve, extraPorts: [P] }), profile: { site: "demo", home: h } });
          await assert.rejects(() => sessions.getOrCreate("elsewhere", new EventBus()), /profile was refused.*in use on elsewhere-host/);
        }
        assert.ok(!existsSync(join(h, "profiles", "demo.lock")), `${who}: the refusal left the profile locked`);
      }
    }

    // 7d. A profile that is inside a directory the agents work in is refused by a session as well as by the login
    {
      const outer = scratch();
      const sessions = new BrowserSessionManager({ policy: liveBrowserPolicy(allowances, { isPublic, resolve, extraPorts: [P] }), profile: { site: "demo", home: join(outer, "home"), forbidden: [outer] } });
      await assert.rejects(() => sessions.getOrCreate("inside", new EventBus()), /profile was refused.*inside/);
      assert.ok(!existsSync(join(outer, "home", "profiles", "demo.lock")), "a refused session left a lock");
    }

    // 7e. A browser that cannot start is a plain refusal, and it leaves nothing behind: no lock, no open gate, no temporary directory
    {
      const saved = process.env.AGENT_LOOP_CHROME_PATH;
      process.env.AGENT_LOOP_CHROME_PATH = join(tmpdir(), "no-such-chromium-binary");
      try {
        const h = scratch();
        const handlesBefore = await servers(), dirsBefore = loginDirs();
        const r = await runLogin({ ...base, site: "demo", home: h, url: L("/login"), drive: async () => {} });
        assert.ok(!r.ok && /login window could not be opened/.test(r.error), `a browser that could not start was reported as a login: ${JSON.stringify(r)}`);
        assert.ok(!existsSync(join(h, "profiles", "demo.lock")), "a failed launch left the profile locked");
        assert.strictEqual(await servers(), handlesBefore, "a failed launch left the network gate open");
        assert.deepStrictEqual(loginDirs(), dirsBefore, "a failed launch left a temporary directory");

        const h2 = scratch();
        const sessions = new BrowserSessionManager({ policy: liveBrowserPolicy(allowances, { isPublic, resolve, extraPorts: [P] }), profile: { site: "demo", home: h2 } });
        const before2 = await servers();
        await assert.rejects(() => sessions.getOrCreate("nolaunch", new EventBus()), /Could not launch Chromium|no-such-chromium/);
        assert.ok(!existsSync(join(h2, "profiles", "demo.lock")), "a session whose browser did not start left the profile locked");
        assert.strictEqual(await servers(), before2, "a session whose browser did not start left its network gate open");
      } finally { if (saved === undefined) delete process.env.AGENT_LOOP_CHROME_PATH; else process.env.AGENT_LOOP_CHROME_PATH = saved; }
    }

    // 7f. After a normal login: the gate is closed and the temporary downloads directory is gone; in the window a download is refused
    {
      const before = await servers(), dirsBefore = loginDirs();
      let during = [];
      const r = await runLogin({
        ...base, site: "demo", home: scratch(), url: L("/dl"),
        drive: async ({ page }) => {
          await page.waitForSelector("#dl", { timeout: 15000 });
          await page.click("#dl");
          await sleep(1500);
          during = loginDirs().filter((d) => !dirsBefore.includes(d)).flatMap((d) => readdirSync(join(tmpdir(), d)));
        },
      });
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepStrictEqual(during, [], `the login window saved a download: ${during}`);
      assert.strictEqual(await servers(), before, "the login left its network gate open");
      assert.deepStrictEqual(loginDirs(), dirsBefore, "the login left its temporary directory behind");
    }

    // 7g. Ctrl-C closes the window and ends the login cleanly, whenever it arrives: before the page has started to load (a signal that fired before anyone listened is never delivered again), and later
    {
      const early = new AbortController();
      const r1 = await Promise.race([runLogin({ ...base, site: "demo", home: scratch(), url: L("/login"), signal: early.signal, say: () => early.abort() }), sleep(30000).then(() => "hung")]);
      assert.ok(r1 !== "hung" && r1.ok, `Ctrl-C while the window was opening did not end the login: ${JSON.stringify(r1)}`);
      const already = new AbortController();
      already.abort();
      const r2 = await Promise.race([runLogin({ ...base, site: "demo", home: scratch(), url: L("/login"), signal: already.signal }), sleep(30000).then(() => "hung")]);
      assert.ok(r2 !== "hung" && r2.ok, `a login started after Ctrl-C did not end: ${JSON.stringify(r2)}`);
      const ctl = new AbortController();
      let opened = false;
      const running = runLogin({ ...base, site: "demo", home: scratch(), url: L("/login"), signal: ctl.signal, say: () => { opened = true; } });
      for (let i = 0; i < 100 && !opened; i++) await sleep(100);
      assert.ok(opened, "the login never said it was opening");
      await sleep(1500);
      ctl.abort();
      const r = await Promise.race([running, sleep(30000).then(() => "hung")]);
      assert.ok(r !== "hung" && r.ok, `Ctrl-C did not end the login: ${JSON.stringify(r)}`);
    }

    // 7h. A session on the profile: one tab (the one the browser opened, not a second), no service worker, no download kept
    {
      const h = scratch();
      const sessions = new BrowserSessionManager({ profile: { site: "demo", home: h } });
      const bus = new EventBus();
      try {
        const sess = await sessions.getOrCreate("profile-session", bus);
        assert.strictEqual(sess.context.pages().length, 1, `a profile session opened ${sess.context.pages().length} tabs`);
        // Playwright's "block" does not make register() fail: it keeps the worker from running. So: a worker that answers every request must not be there, and a fetch must reach the server.
        await sess.page.goto(`http://127.0.0.1:${P}/swpage`, { waitUntil: "load" });
        await sess.page.waitForFunction(() => window.sw !== "pending", null, { timeout: 10000 });
        await sleep(2000);
        assert.strictEqual(sess.context.serviceWorkers().length, 0, "a service worker is running in a profile session");
        const body = await sess.page.evaluate(async () => await (await fetch("/data")).text());
        assert.ok(/FROM-SERVER/.test(body) && !/FROM-SW/.test(body), `a service worker answered a request in a profile session: ${body.slice(0, 80)}`);
        await sess.page.goto(`http://127.0.0.1:${P}/dl`, { waitUntil: "load" });
        // The browser refuses downloads itself; cancelling one afterwards loses a race with a small file about one time in six, so click many times: a browser that accepts them leaves a file almost every run, and one that refuses them never does
        for (let i = 0; i < 20; i++) { await sess.page.click("#dl").catch(() => {}); await sleep(120); }
        await sleep(1000);
        assert.deepStrictEqual(readdirSync(sess.downloadsDir), [], "a profile session kept a download");
      } finally { await sessions.close("profile-session", bus, "completed").catch(() => {}); }
    }

    // 7i. The command line forbids the working directory and --dir as places for the profile
    {
      const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
      const root = fileURLToPath(new URL("..", import.meta.url));
      const outer = scratch();
      const home = join(outer, "agent-home");
      mkdirSync(home, { mode: 0o700 });
      writeFileSync(join(home, "allowances.json"), JSON.stringify({ allow: ["login.example"], platforms: { demo: ["login.example"] } }), { mode: 0o600 });
      const run = (cwd, extra) => spawnSync(process.execPath, ["--experimental-sqlite", "--no-warnings", cli, "login", "demo", ...extra], { cwd, encoding: "utf8", timeout: 60000, env: { ...process.env, AGENT_LOOP_HOME: home } });
      let r = run(outer, []);
      assert.ok(r.status === 1 && /would be inside/.test(r.stderr), `the working directory was not forbidden: ${r.status} ${r.stderr}`);
      r = run(root, ["--dir", outer]);
      assert.ok(r.status === 1 && /would be inside/.test(r.stderr), `--dir was not forbidden: ${r.status} ${r.stderr}`);
      assert.ok(!existsSync(join(home, "profiles", "demo.lock")), "a refused login left a lock");
    }
    console.log("[ok] hardening: the platform's first domain is the default login page; error text is cut and plain; another computer's Chromium lock is believed; a session cannot take a forbidden place; a browser that cannot start leaves no lock, gate or directory; the login window refuses downloads, closes on Ctrl-C and cleans up; a profile session has one tab, no service worker and keeps no download; the command line forbids the working directory and --dir");
  }

  console.log("\nALL LOGIN TESTS PASSED");
} finally {
  server.close();
}
process.exit(0);
