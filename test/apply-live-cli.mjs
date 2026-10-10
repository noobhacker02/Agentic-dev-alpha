// `agent-loop apply` in LIVE mode (no --test), as a process, with nothing reaching a network: every case here is refused or finishes before any page is opened.
// Found by the platform packet's verifier: `apply --verify` in LIVE mode was always refused ("is not on your allowances list") because the platform was derived from an address that --verify does not have.
//   npm run build && node test/apply-live-cli.mjs
import assert from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist/cli.js");
const home = mkdtempSync(join(tmpdir(), "apply-live-"));
chmodSync(home, 0o700);
const resume = join(mkdtempSync(join(tmpdir(), "apply-live-docs-")), "resume.pdf");
writeFileSync(resume, "%PDF-1.4 a resume");
const put = (name, obj) => writeFileSync(join(home, name), JSON.stringify(obj), { mode: 0o600 });
put("uploads.json", { files: { resume } });
put("facts.json", { facts: { full_name: "Ada Lovelace", email: "ada@example.com" } });
put("allowances.json", { allow: ["linkedin.com", "=boards.greenhouse.io"], deny: [], platforms: { linkedin: ["linkedin.com"], greenhouse: ["boards.greenhouse.io"] } });
const run = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, ["--experimental-sqlite", "--no-warnings", cli, "apply", ...args], { cwd: root, env: { ...process.env, AGENT_LOOP_HOME: home } });
  let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  const t = setTimeout(() => p.kill("SIGKILL"), 60000);
  p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
});

// 1. --verify in LIVE mode names no page: with nothing to verify it finishes, it is not refused for a missing address
{
  const r = await run(["--verify"]);
  assert.ok(r.code === 0 && /Nothing to verify/.test(r.out), `LIVE --verify was refused: ${JSON.stringify(r)}`);
  console.log("[ok] LIVE --verify with an empty ledger finishes (exit 0), it is not refused for lack of an address");
}
// 2. a --site that disagrees with the allowances file is refused before anything is opened
{
  const r = await run(["https://www.linkedin.com/jobs/view/1", "--site", "greenhouse", "--company", "A", "--title", "B"]);
  assert.ok(r.code === 1 && /belongs to the platform "linkedin"/.test(r.err + r.out), JSON.stringify(r));
  const r2 = await run(["https://www.linkedin.com/jobs/view/1", "--site", "  GreenHouse ", "--company", "A", "--title", "B"]);
  assert.ok(r2.code === 1 && /belongs to the platform "linkedin"/.test(r2.err + r2.out), JSON.stringify(r2));
  console.log("[ok] LIVE: a --site that is not the platform of the page's host is refused (exit 1), in any case and spacing");
}
// 3. an address that is not on the list, or is not an address, is refused
{
  for (const u of ["https://evil.example/jobs/1", "https://linkedin.com.evil.example/jobs/1", "not a url"]) {
    const r = await run([u, "--site", "linkedin", "--company", "A", "--title", "B"]);
    assert.ok(r.code === 1 && /not on your allowances list/.test(r.err + r.out), `${u}: ${JSON.stringify(r)}`);
  }
  console.log("[ok] LIVE: an address that is not on the list, a look-alike and a non-address are refused (exit 1)");
}
console.log("\nALL APPLY LIVE CLI TESTS PASSED");
