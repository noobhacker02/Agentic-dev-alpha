// LIVE mode, part one (docs/HYBRID-AGENT-SPEC.md, S2): which hosts the agent may navigate to (the allowances list), which addresses it may never connect to (private, loopback,
// link-local, metadata), and what a user's config file may say. Pure functions and one file loader; the gate and the browser use them in the next increment. No browser, no network.
//   npm run build && npm run test:allowances
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostRule, parseAllowances, hostStatus, platformOf, navigationVerdict, isPublicAddress, loadAllowances, normalizeHost } from "../dist/allowances.js";

const posix = process.platform !== "win32";
const ok = (raw) => { const r = parseAllowances(raw); assert.ok(r.ok, JSON.stringify(r.errors)); return r.value; };
const bad = (raw) => { const r = parseAllowances(raw); assert.ok(!r.ok, `accepted: ${JSON.stringify(raw)}`); return r.errors.join(" | "); };

// 1. A rule names a domain; things that are not a plain domain are refused when the file is read, not guessed at later
{
  assert.deepStrictEqual(hostRule("linkedin.com"), { host: "linkedin.com", exact: false });
  assert.deepStrictEqual(hostRule("=boards.greenhouse.io"), { host: "boards.greenhouse.io", exact: true });
  assert.deepStrictEqual(hostRule("LinkedIn.COM."), { host: "linkedin.com", exact: false }, "case and a trailing dot are normalised");
  assert.deepStrictEqual(hostRule("bücher.example"), { host: "xn--bcher-kva.example", exact: false }, "a non-ASCII name is kept as its punycode form");
  for (const text of ["", " ", "com", "localhost", "*.linkedin.com", "linkedin.*", "https://linkedin.com", "linkedin.com/jobs", "linkedin.com:443", "user@linkedin.com", "a b.com", "1.2.3.4", "[::1]", "::1", "127.0.0.1",
    "co.uk", "com.au", "github.io", "a..b.com", "-bad.com", "bad-.com", "x".repeat(64) + ".com", ("a.".repeat(130)) + "com", "linkedin.com\u0000", "linkedin.com\n", "‮linkedin.com", "="]) {
    assert.strictEqual(hostRule(text), undefined, `a rule was accepted: ${JSON.stringify(text)}`);
  }
  assert.strictEqual(hostRule(42), undefined);
  assert.ok(!/[\u202e\u200b\u0000-\u001f]/.test(bad({ allow: ["\u202eevil.com", "a\u200b.com"] })), "a bidi or zero-width character from the file reached an error message");
  assert.strictEqual(hostRule(null), undefined);
  assert.strictEqual(normalizeHost("EXAMPLE.com."), "example.com");
  assert.strictEqual(normalizeHost("exa mple.com"), undefined);
  console.log("[ok] a rule is a plain domain (case folded, punycode, a leading = for exactly that host); addresses, ports, paths, wildcards, one-label names and public suffixes are refused");
}

// 2. Matching: the domain and its subdomains, never a look-alike
{
  const a = ok({ allow: ["linkedin.com", "=boards.greenhouse.io"], deny: [] });
  for (const h of ["linkedin.com", "www.linkedin.com", "WWW.LinkedIn.com", "a.b.c.linkedin.com", "linkedin.com.", "boards.greenhouse.io"]) assert.strictEqual(hostStatus(a, h), "allowed", h);
  for (const h of ["evil-linkedin.com", "notlinkedin.com", "linkedin.com.evil.com", "linkedin.com@evil.com", "linkedin.co", "linkedinxcom", "xn--linkedn-q4a.com", "linkedın.com", "api.boards.greenhouse.io", "greenhouse.io", "", "localhost"]) {
    assert.strictEqual(hostStatus(a, h), "unlisted", `${JSON.stringify(h)} was ${hostStatus(a, h)}`);
  }
  console.log("[ok] a domain rule covers the domain and its subdomains on a dot boundary; look-alikes, suffix tricks and homographs are not covered; an exact rule covers only that host");
}

// 3. Deny beats allow, whatever the order
{
  const a = ok({ allow: ["example.com"], deny: ["ads.example.com", "=evil.com"] });
  assert.strictEqual(hostStatus(a, "www.example.com"), "allowed");
  assert.strictEqual(hostStatus(a, "ads.example.com"), "denied");
  assert.strictEqual(hostStatus(a, "x.ads.example.com"), "denied");
  const b = ok({ allow: ["evil.com", "good.org"], deny: ["evil.com"] });
  assert.strictEqual(hostStatus(b, "evil.com"), "denied");
  assert.strictEqual(hostStatus(b, "good.org"), "allowed");
  console.log("[ok] the deny list beats the allow list, for the host and for its subdomains");
}

// 4. A site is a platform: many hosts, one name (the caps count a platform, not a hostname)
{
  const a = ok({
    allow: ["linkedin.com", "greenhouse.io", "myworkdayjobs.com", "acme-careers.com"],
    platforms: { linkedin: ["linkedin.com"], greenhouse: ["greenhouse.io"], workday: ["myworkdayjobs.com"] },
  });
  assert.strictEqual(platformOf(a, "www.linkedin.com"), "linkedin");
  assert.strictEqual(platformOf(a, "boards.greenhouse.io"), "greenhouse");
  assert.strictEqual(platformOf(a, "acme.wd5.myworkdayjobs.com"), "workday");
  assert.strictEqual(platformOf(a, "globex.wd1.myworkdayjobs.com"), "workday", "a second Workday tenant is the same site, not a fresh quota");
  assert.strictEqual(platformOf(a, "jobs.acme-careers.com"), "acme-careers.com", "an allowed host with no platform is its own site, named by the rule that allowed it");
  assert.strictEqual(platformOf(a, "evil.com"), undefined, "an unlisted host has no platform");
  const f = ok({ allow: ["example.com", "jobs.example.com"] });
  assert.strictEqual(platformOf(f, "x.jobs.example.com"), "jobs.example.com", "with no platform map the most specific allow rule names the site");
  assert.strictEqual(platformOf(f, "www.example.com"), "example.com");
  const d = ok({ allow: ["example.com"], deny: ["x.example.com"], platforms: { ex: ["example.com"] } });
  assert.strictEqual(platformOf(d, "x.example.com"), undefined, "a denied host has no platform");
  const m = ok({ allow: ["example.com", "careers.example.com"], platforms: { general: ["example.com"], careers: ["careers.example.com"] } });
  assert.strictEqual(platformOf(m, "a.careers.example.com"), "careers", "the most specific platform rule wins");
  assert.strictEqual(platformOf(m, "www.example.com"), "general");
  console.log("[ok] hosts map to a platform (the most specific rule wins); an unmapped allowed host is its own site; unlisted and denied hosts have none");
}

// 5. A navigation is judged on its URL: scheme, credentials, port, address literal, host
{
  const a = ok({ allow: ["linkedin.com", "example.org"], deny: ["bad.example.org"], platforms: { linkedin: ["linkedin.com"] } });
  const go = (u) => navigationVerdict(a, u);
  const good = go("https://www.linkedin.com/jobs/view/123?x=1#frag");
  assert.deepStrictEqual([good.ok, good.host, good.platform], [true, "www.linkedin.com", "linkedin"]);
  assert.ok(go("http://example.org/").ok && go("https://example.org:443/").ok && go("http://example.org:80/").ok && go("http://example.org:443/").ok && go("https://example.org:80/").ok);
  const refused = {
    "https://evil.com/": /evil\.com.*not on the allowances list/,
    "https://linkedin.com.evil.com/": /not on the allowances list/,
    "https://bad.example.org/": /denied/,
    "ftp://linkedin.com/": /only http and https/i,
    "file:///etc/passwd": /only http and https/i,
    "javascript:alert(1)": /only http and https/i,
    "data:text/html,hi": /only http and https/i,
    "blob:https://linkedin.com/abc": /only http and https/i,
    "about:blank": /only http and https/i,
    "https://user:pw@linkedin.com/": /credentials/i, // devskill:allow (a made-up credential in a URL, to prove such URLs are refused)
    "https://:pw@linkedin.com/": /credentials/i,
    "https://user@linkedin.com/": /credentials/i,
    "https://linkedin.com@evil.com/": /not on the allowances list/,
    "https://www.linkedin.com:8443/": /port/i,
    "http://www.linkedin.com:22/": /port/i,
    "https://127.0.0.1/": /address/i,
    "https://[::1]/": /address/i,
    "https://2130706433/": /address/i,
    "https://0x7f.1/": /address/i,
    "https://169.254.169.254/latest/meta-data/": /address/i,
    "https://localhost/": /localhost|not on the allowances list/i,
    "https://app.localhost/": /not on the allowances list/,
    "not a url": /not a valid URL/i,
    "": /not a valid URL/i,
  };
  for (const [u, why] of Object.entries(refused)) {
    const v = go(u);
    assert.ok(!v.ok && why.test(v.reason), `${JSON.stringify(u)} -> ${JSON.stringify(v)}`);
  }
  const ctl = go("https://evil\u001b[2J.com/");
  assert.ok(!ctl.ok && !/[\u0000-\u001f\u007f-\u009f]/.test(ctl.reason), "a control byte from the URL reached the message");
  assert.ok(go("https://" + "a".repeat(5000) + ".com/").reason.length < 400, "a long URL made a long message");
  console.log("[ok] a navigation needs http or https, no credentials, port 80 or 443, a name (never an address in any spelling) that the allowances list covers and the deny list does not");
}

// 6. Addresses the agent may never connect to, however the name got there
{
  const publicOnes = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "104.16.0.1", "151.101.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.255.255", "169.255.0.1", "11.0.0.1", "9.255.255.255",
    "126.255.255.255", "128.0.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.254", "192.0.1.1", "192.169.0.1", "191.255.255.255",
    "2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e", "2000::1", "64:ff9b::808:808", "2002:808:808::1", "::ffff:8.8.8.8", "2001:200::1", "3fff:1000::1"];
  const privateOnes = ["0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.100.100.200", "127.0.0.1", "127.255.255.254", "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255",
    "192.0.0.192", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "100.127.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "192.88.99.1",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "::127.0.0.1", "fe80::1", "2001:1ff::1", "fe80::1%eth0", "2606:4700:4700::1111%eth0", "fc00::1", "fd00:ec2::254", "fdff::1", "ff02::1", "2001:db8::1", "2001::1", "3fff::1",
    "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1", "2002:c0a8:101::1", "100::1", "5f00::1", "::ffff:8.8.8.8x"];
  for (const ip of publicOnes) assert.strictEqual(isPublicAddress(ip), true, `${ip} should be reachable`);
  for (const ip of privateOnes) assert.strictEqual(isPublicAddress(ip), false, `${ip} should never be reachable`);
  for (const junk of ["", "not-an-ip", "1.2.3", "256.1.1.1", "1.2.3.4.5", "01.2.3.4", "1.2.3.4/8", " 8.8.8.8", "8.8.8.8 ", "8.8.8.8\n", "::g", "0x7f.0.0.1", "2130706433", "localhost", 8, null, undefined]) {
    assert.strictEqual(isPublicAddress(junk), false, `${JSON.stringify(junk)} was accepted as an address`);
  }
  console.log(`[ok] ${publicOnes.length} public addresses pass, ${privateOnes.length} private, loopback, link-local, metadata, reserved and embedded-private addresses (IPv4-mapped, NAT64, 6to4) and ${17} non-addresses do not`);
}

// 7. The config file: the user's, in their own directory, strict about its shape and who can write it
{
  const home = mkdtempSync(join(tmpdir(), "allowances-"));
  const write = (text, name = "allowances.json") => writeFileSync(join(home, name), text);
  let r = loadAllowances(home);
  assert.ok(r.ok && r.value.allow.length === 0 && r.value.deny.length === 0 && r.source === "none", "no file means nothing is allowed");
  assert.strictEqual(hostStatus(r.value, "linkedin.com"), "unlisted");
  write(JSON.stringify({ allow: ["linkedin.com"], deny: ["ads.linkedin.com"], platforms: { linkedin: ["linkedin.com"] } }));
  if (posix) chmodSync(join(home, "allowances.json"), 0o600);
  r = loadAllowances(home);
  assert.ok(r.ok && r.source === "file" && hostStatus(r.value, "www.linkedin.com") === "allowed" && hostStatus(r.value, "ads.linkedin.com") === "denied", JSON.stringify(r));
  const refuse = (text, why) => { write(text); if (posix) chmodSync(join(home, "allowances.json"), 0o600); const x = loadAllowances(home); assert.ok(!x.ok && why.test(x.errors.join(" | ")), `${text.slice(0, 60)} -> ${JSON.stringify(x)}`); };
  refuse("{not json", /not valid JSON/i);
  refuse("[]", /object/i);
  refuse('{"allow": "linkedin.com"}', /allow.*list/i);
  refuse('{"allow": [1]}', /allow\[0\]/);
  refuse('{"allow": ["https://linkedin.com"]}', /allow\[0\]/);
  refuse('{"allow": ["linkedin.com"], "extra": true}', /unknown key.*extra/i);
  refuse('{"platforms": {"x": "linkedin.com"}}', /platforms\.x/);
  refuse('{"platforms": {"bad name!": ["a.com"]}}', /platform name/i);
  refuse('{"allow": ["a.com"], "platforms": {"x": ["b.com"]}}', /platform.*x.*b\.com.*not on the allow/i);
  refuse(JSON.stringify({ allow: Array.from({ length: 501 }, (_, i) => `h${i}.example.com`) }), /at most 500/i);
  refuse(" ".repeat(200_000) + "{}", /too large/i);
  refuse(JSON.stringify({ allow: ["a.com"], platforms: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`p${i}`, ["a.com"]])) }), /more than 100/i);
  if (posix) {
    write("{}"); chmodSync(join(home, "allowances.json"), 0o666);
    const w = loadAllowances(home);
    assert.ok(!w.ok && /writable by others/i.test(w.errors.join()), "a file anyone can write granted allowances");
    chmodSync(join(home, "allowances.json"), 0o660);
    assert.ok(!loadAllowances(home).ok, "a group-writable file granted allowances");
    chmodSync(join(home, "allowances.json"), 0o602);
    assert.ok(!loadAllowances(home).ok, "a file that only the world can write granted allowances");
    chmodSync(join(home, "allowances.json"), 0o600);
    assert.ok(loadAllowances(home).ok, "a file only its owner can write was refused");
    const me = process.getuid();
    const other = loadAllowances(home, { uid: me + 1 });
    assert.ok(!other.ok && /not owned by you/.test(other.errors.join()), "a file owned by someone else granted allowances");
    assert.ok(loadAllowances(home, { uid: me }).ok);
    const real = join(home, "real.json"); writeFileSync(real, '{"allow":["linkedin.com"]}'); chmodSync(real, 0o600);
    try { unlinkSync(join(home, "allowances.json")); symlinkSync(real, join(home, "allowances.json")); const l = loadAllowances(home); assert.ok(!l.ok && /link/i.test(l.errors.join()), "a symlinked config was read"); } catch (e) { if (e.code !== "EPERM") throw e; }
  }
  const dirHome = mkdtempSync(join(tmpdir(), "allowances-dir-"));
  mkdirSync(join(dirHome, "allowances.json"));
  const asDir = loadAllowances(dirHome);
  assert.ok(!asDir.ok && /not a file/i.test(asDir.errors.join()), "a directory was read as the config");
  console.log("[ok] no config means nothing is allowed; the file is checked for shape, size, unknown keys, platform names, and (on POSIX) that nobody else can write it and that it is not a link");
}
// 8. A name the rules cannot parse must not slip past the deny list (adversary round 3, A57): browsers resolve "x_y.ads.example" and the resolver may answer; it is under a denied domain
{
  const a = ok({ allow: ["example.org"], deny: ["ads.example.org"] });
  const { livePolicy } = await import("../dist/allowances.js");
  const p = livePolicy(a);
  for (const h of ["x_y.ads.example.org", "_dmarc.ads.example.org", "a b.ads.example.org", "x_y.ADS.Example.ORG.", "ads_.ads.example.org"]) {
    assert.equal(p.allowHost(h), false, `${JSON.stringify(h)} is under a denied domain but the net gate let it through`);
    assert.notEqual(hostStatus(a, h), "allowed", `${JSON.stringify(h)} counted as allowed`);
  }
  assert.equal(hostStatus(a, "x_y.ads.example.org"), "denied");
  // controls: an unparseable name that is not under a denied domain is still unlisted (not denied), and ordinary names keep working
  assert.equal(hostStatus(a, "x_y.other.example"), "unlisted");
  assert.equal(p.allowHost("x_y.other.example"), true, "an unrelated odd name was refused (the gate refuses more than the deny list)");
  assert.equal(p.allowHost("cdn.example.net"), true);
  assert.equal(p.allowHost("ads.example.org"), false);
  console.log("[ok] a name with an underscore or a space under a denied domain is denied, not 'unlisted'");
}
console.log("\nALL ALLOWANCES TESTS PASSED");
