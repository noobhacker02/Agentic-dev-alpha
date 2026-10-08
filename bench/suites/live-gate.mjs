// Does the LIVE gate classify the forms an address, a URL and a redirect can take? The agent may go only where the user's allowances list says, and never to a private address; the ways to get that wrong are
// look-alike names (`linkedin.com.evil.com`), credentials in the URL, ports, schemes, an address written as a decimal, hex, octal or IPv6 number, and a redirect that lands somewhere else. Rows: the forms that
// must be allowed (a gate that refuses everything is its own failure: nobody can use it) and the forms that must not be. Scored through the real policy and the real address rule of the build under test
// (`dist/` of the tree the runner is in, or of `root`), so the same rows can score an older build; a build without the gate scores 0.
// `scoreWith` takes any implementation of the same six questions, so test/bench-suites.mjs can show that a gate that allows everything, one that refuses everything and one that only looks at the start of a
// name each score low.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../lib.mjs";

export const ALLOWANCES = {
  allow: ["linkedin.com", "=boards.greenhouse.io", "example.org"],
  deny: ["ads.example.org"],
  platforms: { linkedin: ["linkedin.com"], greenhouse: ["boards.greenhouse.io"] },
};

// true = may be opened / reached / connected to / shown / is public
const OPEN_YES = [
  "https://linkedin.com/jobs", "https://www.linkedin.com/jobs/view/1?x=1#frag", "http://linkedin.com/", "https://LinkedIn.COM/", "https://linkedin.com./", "https://a.b.linkedin.com/",
  "https://boards.greenhouse.io/acme/jobs/1", "https://linkedin.com:443/", "http://linkedin.com:80/", "https://example.org/",
  // ordinary use that must keep working, including URLs that merely mention another site
  "https://www.linkedin.com/jobs/search/?keywords=a%20b&location=x", "https://www.linkedin.com/in/someone/", "https://uk.linkedin.com/jobs", "https://boards.greenhouse.io/acme", "https://boards.greenhouse.io/embed/job_app?for=acme",
  "https://example.org/careers", "https://sub.example.org/a/b?c=d", "http://example.org:80/", "https://example.org:443/x", "https://Example.ORG/Jobs", "https://linkedin.com/jobs?redirect=https://evil.com",
  "https://www.linkedin.com/jobs/view/1#https://evil.com", "https://linkedin.com//double//slash", "https://linkedin.com/?a=b&c=d",
];
const OPEN_NO = [
  // look-alikes, suffix and prefix tricks, userinfo and fragments that read like a listed name
  "https://linkedin.com.evil.com/", "https://evil.com/linkedin.com", "https://evil.com/?next=https://linkedin.com/", "https://linkedin.com@evil.com/", "https://evil.com#@linkedin.com/", "https://notlinkedin.com/",
  "https://evil-linkedin.com/", "https://api.boards.greenhouse.io/", "https://greenhouse.io/", "https://linkedın.com/", "https://xn--linkedn-q4a.com/", "https://linkedin.co/",
  // credentials and ports
  "https://user:pw@linkedin.com/", "https://user@linkedin.com/", "https://linkedin.com:8443/", "http://linkedin.com:22/", // devskill:allow (made-up credentials in a URL row: the gate must refuse them)
  // the deny list beats the allow list
  "https://ads.example.org/", "https://x.ads.example.org/",
  // addresses in every spelling, and names that mean this machine
  "http://127.0.0.1/", "http://localhost/", "http://app.localhost/", "http://[::1]/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/", "http://169.254.169.254/latest/meta-data/",
  "http://10.0.0.5/", "http://192.168.1.1/", "http://[::ffff:127.0.0.1]/", "http://100.64.0.1/",
  // schemes
  "file:///etc/passwd", "ftp://linkedin.com/", "javascript:alert(1)", "data:text/html,hi", "blob:https://linkedin.com/x", "about:blank", "not a url", "",
];
const REQUEST_YES = [["https://cdn.evil.com/lib.js", false], ["data:image/png;base64,AA", false], ["https://www.linkedin.com/x", true], ["about:blank", true], ["https://fonts.example.net/a.woff2", false], ["https://stats.example.net/collect", false], ["https://example.org/x", true]];
const REQUEST_NO = [["https://evil.com/", true], ["https://linkedin.com.evil.com/", true], ["data:text/html,hi", true], ["file:///etc/passwd", false], ["javascript:1", false], ["ftp://linkedin.com/", false], ["not a url", false]];
const SOCKET_YES = ["ws://linkedin.com/x", "wss://www.linkedin.com/x", "wss://linkedin.com/realtime", "ws://boards.greenhouse.io/x"];
const SOCKET_NO = ["ws://evil.com/", "ws://127.0.0.1/", "ws://[::1]/", "ws://ads.example.org/", "https://linkedin.com/", "not a url"];
const LANDING_YES = ["https://www.linkedin.com/x", "about:blank", "chrome-error://chromewebdata/", "data:text/html,x", "", "https://linkedin.com/", "https://boards.greenhouse.io/x", "https://example.org/a"];
const LANDING_NO = ["https://evil.com/", "http://127.0.0.1/", "file:///x", "https://linkedin.com.evil.com/", "https://ads.example.org/"];
const PUBLIC_YES = [
  "8.8.8.8", "1.1.1.1", "93.184.216.34", "142.250.80.46", "151.101.1.69", "2606:4700:4700::1111", "2001:4860:4860::8888",
  // just outside the private and special ranges
  "104.16.0.1", "13.107.42.14", "185.199.108.153", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "11.0.0.1", "2a00:1450:4001::200e", "2606:2800:220:1:248:1893:25c8:1946",
];
const PUBLIC_NO = [
  "127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1", "203.0.113.7",
  "::1", "::", "fe80::1", "fc00::1", "fd00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2002:7f00:0001::", "2001:db8::1", "not an address", "127.0.0.1%eth0",
];
const SITE_YES = [
  ["https://www.linkedin.com/jobs/1", "https://www.linkedin.com/apply"], ["https://www.linkedin.com/jobs/1", "https://media.linkedin.com/upload"], ["https://boards.greenhouse.io/a", "https://boards.greenhouse.io/b"],
  ["https://www.linkedin.com/jobs/1", "https://linkedin.com/apply"], ["https://example.org/a", "https://sub.example.org/b"], ["https://boards.greenhouse.io/a?x=1", "https://boards.greenhouse.io/a"],
];
const SITE_NO = [
  ["https://www.linkedin.com/jobs/1", "https://evil.com/steal"], ["https://www.linkedin.com/jobs/1", "https://boards.greenhouse.io/apply"], ["https://www.linkedin.com/jobs/1", "javascript:void(0)"],
  ["https://evil.com/page", "https://www.linkedin.com/apply"], ["https://www.linkedin.com/jobs/1", "https://linkedin.com.evil.com/apply"], ["https://www.linkedin.com/jobs/1", "https://ads.example.org/x"],
];

export const meta = {
  id: "live-gate",
  title: "LIVE gate: address and URL forms, requests, sockets, redirect landings, public addresses and file destinations classified right (allowed ones allowed, the rest refused)",
  unit: "rows right",
  higherIsBetter: true,
  stage: "S2",
};

/** Every row: [kind, input, expected]. The kinds are the six questions an implementation answers. */
export function rows() {
  const out = [];
  for (const u of OPEN_YES) out.push(["open", u, true]);
  for (const u of OPEN_NO) out.push(["open", u, false]);
  for (const [u, nav] of REQUEST_YES) out.push(["request", [u, nav], true]);
  for (const [u, nav] of REQUEST_NO) out.push(["request", [u, nav], false]);
  for (const u of SOCKET_YES) out.push(["socket", u, true]);
  for (const u of SOCKET_NO) out.push(["socket", u, false]);
  for (const u of LANDING_YES) out.push(["landing", u, true]);
  for (const u of LANDING_NO) out.push(["landing", u, false]);
  for (const ip of PUBLIC_YES) out.push(["public", ip, true]);
  for (const ip of PUBLIC_NO) out.push(["public", ip, false]);
  for (const p of SITE_YES) out.push(["site", p, true]);
  for (const p of SITE_NO) out.push(["site", p, false]);
  return out;
}

/** Scores an implementation of { open(url), request(url, navigation), socket(url), landing(url), isPublic(ip), site(pageUrl, targetUrl) } (each answers true or false; one that throws is wrong). */
export function scoreWith(impl) {
  const all = rows();
  let value = 0;
  const wrong = [];
  for (const [kind, input, want] of all) {
    let got;
    try {
      got = kind === "open" ? impl.open(input) : kind === "request" ? impl.request(input[0], input[1]) : kind === "socket" ? impl.socket(input) : kind === "landing" ? impl.landing(input) : kind === "public" ? impl.isPublic(input) : impl.site(input[0], input[1]);
    } catch { got = "threw"; }
    if (got === want) value++;
    else wrong.push(`${kind} ${JSON.stringify(input)} -> ${got}`);
  }
  return { value, max: all.length, wrong };
}

/** The build under test, as an implementation, or null if it has no LIVE gate. */
async function load(root) {
  try {
    const url = (f) => pathToFileURL(join(root, "dist", f)).href;
    const a = await import(url("allowances.js"));
    const p = await import(url("browser-policy.js"));
    const parsed = a.parseAllowances(ALLOWANCES);
    if (!parsed.ok) return null;
    const policy = p.liveBrowserPolicy(parsed.value, {});
    return {
      open: (u) => policy.checkOpen(u).ok === true,
      request: (u, nav) => policy.allowRequest(u, { navigation: nav }).ok === true,
      socket: (u) => policy.allowWebSocket(u) === true,
      landing: (u) => policy.landing(u).ok === true,
      isPublic: (ip) => a.isPublicAddress(ip) === true,
      site: (page, target) => policy.destination(page, target).ok === true,
    };
  } catch {
    return null;
  }
}

export async function run(root = ROOT) {
  const impl = await load(root);
  const max = rows().length;
  if (!impl) return { value: 0, max, detail: { missing: "the build under test has no LIVE gate (dist/allowances.js or dist/browser-policy.js)" } };
  const { value, max: m, wrong } = scoreWith(impl);
  return { value, max: m, detail: { wrong: wrong.slice(0, 8) } };
}
