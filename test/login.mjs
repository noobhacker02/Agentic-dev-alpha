// `agent-loop login <site>` and the agent-only profile in a real browser (docs/HYBRID-AGENT-SPEC.md S2; threats D4, D5, D6): a person signs in once in a window that keeps its profile in the agent-only directory, and a later
// LIVE browser session starts signed in; neither the person's password nor the site's session cookie ever appears in what agent-loop prints, and two users of one profile are refused. A simulated person drives the
// window (the same Chromium, headless) against a local site that answers for a made-up name; a resolver stand-in points the name at 127.0.0.1 and a stand-in for "public" treats only 127.0.0.1 as public.
//   npm run build && npm run test:login
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  console.log("\nALL LOGIN TESTS PASSED");
} finally {
  server.close();
}
process.exit(0);
