// LIVE mode, the platform of an application page (src/apply-command.ts, resolvePlatform): the site comes from the user's allowances file, the label the user typed must agree with it,
// and an address the file does not allow is refused. Pure function, no browser, no network: the URLs are only parsed, never opened.
//   npm run build && node test/apply-platform.mjs
import assert from "node:assert";
import { parseAllowances } from "../dist/allowances.js";
import { resolvePlatform } from "../dist/apply-command.js";

// the allowances file from bench/suites/live-gate.mjs, parsed the way the loader parses it
const parsed = parseAllowances({
  allow: ["linkedin.com", "=boards.greenhouse.io", "example.org"],
  deny: ["ads.example.org"],
  platforms: { linkedin: ["linkedin.com"], greenhouse: ["boards.greenhouse.io"] },
});
assert.ok(parsed.ok, JSON.stringify(parsed));
const A = parsed.value;

const notListed = (url) => `${url} is not on your allowances list, so nothing is opened`;
const ok = (url, site, expected) => {
  const r = resolvePlatform(A, url, site);
  assert.ok(r.ok && r.site === expected, `${JSON.stringify([url, site])} -> ${JSON.stringify(r)}, expected site ${expected}`);
};
const refuse = (url, site, reason) => {
  const r = resolvePlatform(A, url, site);
  assert.ok(!r.ok && r.reason === reason, `${JSON.stringify([url, site])} -> ${JSON.stringify(r)}, expected refusal: ${reason}`);
};
let n = 0;
const count = (k) => { n += k; };

// 1. --site omitted: the platform is the page's
for (const [url, expected] of [
  ["https://linkedin.com/jobs", "linkedin"],
  ["https://www.linkedin.com/jobs/view/1?x=1#frag", "linkedin"],
  ["https://uk.linkedin.com/jobs", "linkedin"],
  ["https://boards.greenhouse.io/acme/jobs/1", "greenhouse"],  // the more specific platform rule wins over the allow rule
  ["https://boards.greenhouse.io/embed/job_app?for=acme", "greenhouse"],
  ["https://example.org/careers", "example.org"],              // an allowed domain with no platform is its own site
  ["https://sub.example.org/a/b?c=d", "example.org"],
]) { ok(url, undefined, expected); count(1); }
ok("https://linkedin.com/jobs", "", "linkedin"); count(1);       // an empty --site is "not given" here (applyCommand refuses an empty one before this point)

// 2. --site given and the same platform: case and surrounding spaces do not matter
for (const [url, site, expected] of [
  ["https://linkedin.com/jobs", "linkedin", "linkedin"],
  ["https://linkedin.com/jobs", "LinkedIn", "linkedin"],
  ["https://linkedin.com/jobs", "  linkedin\t", "linkedin"],
  ["https://LINKEDIN.COM/jobs", "LINKEDIN", "linkedin"],
  ["https://boards.greenhouse.io/acme/jobs/1", " Greenhouse\n", "greenhouse"],
  ["https://example.org/careers", "Example.ORG ", "example.org"],
]) { ok(url, site, expected); count(1); }

// 3. --site given and a different platform: refused, with the platform the page really belongs to
const disagree = (derived, typed) => `that address belongs to the platform "${derived}" in your allowances file, not "${typed}"`;
refuse("https://linkedin.com/jobs", "greenhouse", disagree("linkedin", "greenhouse")); count(1);
refuse("https://boards.greenhouse.io/acme/jobs/1", "linkedin", disagree("greenhouse", "linkedin")); count(1);
refuse("https://example.org/careers", "linkedin", disagree("example.org", "linkedin")); count(1);
refuse("https://linkedin.com/jobs", "example.org", disagree("linkedin", "example.org")); count(1);
refuse("https://linkedin.com/jobs", "linkedin.com", disagree("linkedin", "linkedin.com")); count(1);   // a domain is not a platform name
refuse("https://linkedin.com/jobs", "   ", disagree("linkedin", "   ")); count(1);            // a space-only --site is given (not empty), so it must agree too
refuse("https://linkedin.com/jobs", "linked in", disagree("linkedin", "linked in")); count(1);
refuse("https://example.org/careers", "ads.example.org", disagree("example.org", "ads.example.org")); count(1);
refuse("https://linkedin.com/jobs", "  Greenhouse ", disagree("linkedin", "  Greenhouse ")); count(1);  // the message shows the typed text as it was typed
refuse("https://linkedin.com/jobs", "linkedın", disagree("linkedin", "linked?n")); count(1);             // non-ASCII is shown as ?
refuse("https://linkedin.com/jobs", "x".repeat(60), disagree("linkedin", "x".repeat(40))); count(1);     // the typed text is cut to 40 characters
refuse("https://linkedin.com/jobs", "linkedin\u0000", disagree("linkedin", "linkedin")); count(1);     // refused, but the NUL is stripped from the message, so it reads as the same name (finding, not fixed)

// 4. an address the allowances file does not allow: refused before the label is compared
for (const url of [
  "https://evil.com/",
  "https://linkedin.com.evil.com/",                // look-alike: the listed name is a prefix
  "https://evil-linkedin.com/",
  "https://notlinkedin.com/",
  "https://linkedin.co/",
  "https://linkedin.com@evil.com/",                // userinfo: the host is evil.com
  "https://evil.com#@linkedin.com/",
  "https://evil.com/?next=https://linkedin.com/",
  "https://api.boards.greenhouse.io/",              // the greenhouse rule is exact: subdomains are not listed
  "https://greenhouse.io/",
  "https://ads.example.org/",                       // the deny list beats the allow list
  "https://x.ads.example.org/",
  "https://linkedin.com.evil.com./",               // a trailing dot does not make it linkedin.com
  "http://127.0.0.1/",                             // addresses
  "http://[::1]/",
  "http://2130706433/",
  "http://0x7f000001/",
  "http://10.0.0.5/",
  "http://169.254.169.254/latest/meta-data/",
]) { refuse(url, undefined, notListed(url)); count(1); }
// the same refusal whatever the typed label says: the allowances check comes first
refuse("https://evil.com/", "linkedin", notListed("https://evil.com/")); count(1);
refuse("https://ads.example.org/", "example.org", notListed("https://ads.example.org/")); count(1);
refuse("http://127.0.0.1/", "greenhouse", notListed("http://127.0.0.1/")); count(1);
// a name written with a look-alike letter is a different name (it becomes punycode)
refuse("https://linkedın.com/", undefined, "https://linked?n.com/ is not on your allowances list, so nothing is opened"); count(1);

// 5. a page that is not an address at all: refused, with the text shown as it was given (cut to 120 characters, control bytes as ?)
refuse("not a url", undefined, notListed("not a url")); count(1);
refuse("", undefined, " is not on your allowances list, so nothing is opened"); count(1);
refuse(undefined, undefined, " is not on your allowances list, so nothing is opened"); count(1);
refuse("linkedin.com/jobs", undefined, notListed("linkedin.com/jobs")); count(1);   // no scheme: refused, not guessed
refuse("//linkedin.com/jobs", undefined, notListed("//linkedin.com/jobs")); count(1);
refuse("not a url", "linkedin", notListed("not a url")); count(1);                  // a bad page is refused before the label is compared
refuse("bad\u001b[31m url", undefined, notListed("bad[31m url")); count(1);
refuse("y".repeat(200), undefined, notListed("y".repeat(120))); count(1);

// 6. what is accepted on purpose, and what the navigation gate refuses later (src/browser-policy.ts, checked when the page is opened).
// The label is derived from the host: these URLs carry a credential, a port or a scheme the gate refuses, so the page is never opened.
// These expectations describe today's derivation; they are not an endorsement of those URLs.
ok("https://LINKEDIN.COM./jobs", undefined, "linkedin"); count(1);                // upper case and a trailing dot are the same host
ok("https://www.linkedin.com./", "linkedin", "linkedin"); count(1);
ok("https://ｌｉｎｋｅｄｉｎ.com/", undefined, "linkedin"); count(1);             // full-width letters are the same host to a browser
ok("https://linkedin.com:443/", undefined, "linkedin"); count(1);
ok("http://linkedin.com:80/", undefined, "linkedin"); count(1);
ok("https://linkedin.com?redirect=https://evil.com", undefined, "linkedin"); count(1);  // the query does not change the host
ok("https://user:pw@linkedin.com/jobs", undefined, "linkedin"); count(1); // devskill:allow (made-up credentials in a test row: the derivation reads the host; the navigation gate refuses the URL)
ok("https://linkedin.com:8443/jobs", undefined, "linkedin"); count(1);            // the port is refused by the navigation gate, not here
ok("ftp://linkedin.com/jobs", undefined, "linkedin"); count(1);                   // the scheme is refused by the navigation gate, not here

console.log(`[ok] resolvePlatform: ${n} cases (omitted, same, different, not listed, not an address, and the accepted-but-gated URLs)`);
console.log("\nALL APPLY PLATFORM TESTS PASSED");
