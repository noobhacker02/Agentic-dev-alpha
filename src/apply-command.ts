// `agent-loop apply <application page>`: one application, through the job flow's engine (src/job-apply.ts). It reads the user's own files from the agent-loop directory (allowances.json, facts.json, uploads.json),
// keeps the ledger there (ledger.db), and runs the browser in LIVE mode with the agent-only profile for the site, or with --test in TEST mode (localhost only, no profile) against a local board.
// It prints what happened and exits with a code a script can read: 0 submitted or already applied, 1 error, 3 parked (the user is asked), 4 the site was paused, 5 sent but not confirmed, 6 capped.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllowances, platformOf } from "./allowances.js";
import { BrowserSessionManager, browserToolHandlers } from "./browser-tools.js";
import { liveBrowserPolicy, testPolicy } from "./browser-policy.js";
import { EventBus } from "./bus.js";
import { agentLoopHome } from "./data-dir.js";
import { loadFacts } from "./facts.js";
import { applyToJob, verifyAttempt, type ApplyResult } from "./job-apply.js";
import { Ledger, loadCaps } from "./ledger.js";
import { stripTerminalControlBytes } from "./text-safety.js";
import { loadUploads } from "./uploads.js";
import type { CommandResult, ParsedArgs } from "./team/cli-commands.js";

const clean = (s: string, n = 200): string => stripTerminalControlBytes(s).replace(/[^\x20-\x7e]/g, "?").slice(0, n);

type Handler = { handler(a: unknown, e: unknown): Promise<{ content: Array<{ text?: string }>; isError?: boolean }> };

export async function applyCommand(args: ParsedArgs): Promise<CommandResult> {
  const fail = (message: string): CommandResult => ({ out: "", err: `Error: ${message}\n`, code: 1 });
  // `--test` and `--verify` take no value, but the argument reader gives a flag the word that follows it: that word is a positional (the application page) again
  const positional = [...args._];
  const flag = (k: string): boolean => { const v = args[k]; if (v === undefined || v === false) return false; if (typeof v === "string") positional.unshift(v); return true; };
  const str = (k: string): string | undefined => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  const test = flag("test");
  const verify = flag("verify");
  const forget = str("forget"), resumeSite = str("resume-site");
  const applyUrl = positional[0];
  let site = str("site");
  const company = str("company"), title = str("title");
  const maintenance = verify || forget !== undefined || resumeSite !== undefined;
  if (!maintenance && (!applyUrl || !site || !company || !title)) return fail('agent-loop apply needs the application page and what it is for: agent-loop apply <application page> --site <platform> --company "<company>" --title "<job title>" [--job-id <id>] [--job-url <posting page>] [--resume <name>] [--test]   (or: agent-loop apply --verify | --forget <ledger number> | --resume-site <platform>)');
  const home = agentLoopHome();
  try { mkdirSync(home, { recursive: true, mode: 0o700 }); } catch (err) { return fail(`the agent-loop directory ${clean(home)} cannot be made: ${clean(String((err as NodeJS.ErrnoException).code ?? err))}`); }
  const caps = loadCaps(home);
  if (!caps.ok) return fail(caps.errors.join("\n"));
  const resume = str("resume") ?? "resume";
  let ledger: Ledger;
  try { ledger = new Ledger(join(home, "ledger.db"), Date.now, caps.value); } catch (err) { return fail(`the ledger ${clean(join(home, "ledger.db"))} cannot be opened: ${clean(String((err as Error).message ?? err))}`); }
  if (forget !== undefined) {
    const n = Number(forget);
    const row = Number.isInteger(n) && n > 0 ? ledger.forgettable().find((r) => r.seq === n) : undefined;
    // an attempt only seconds old may still be in flight in another process: closing it would let a second application go out (round 6, A107)
    const recent = row && args["even-if-recent"] !== true && Date.now() - row.at < 120_000;
    const closed = row && !recent ? ledger.fail(row.seq, "closed by the user: not received") : false;
    ledger.close();
    if (recent) return fail(`ledger #${row!.seq} is only ${Math.round((Date.now() - row!.at) / 1000)} seconds old and may still be in flight in another run; wait, or add --even-if-recent if you are sure it is not`);
    return closed && row ? { out: `Closed ledger #${row.seq} (${clean(row.company, 60)}, ${clean(row.title, 80)}) as not received. That posting can be applied to again.\n`, err: "", code: 0 } : fail(`no attempt that can be closed has the number ${clean(forget, 20)}; agent-loop apply --verify lists them`);
  }
  if (resumeSite !== undefined && !resumeSite.trim()) return fail("--resume-site needs the platform name (for example --resume-site linkedin); an empty name would lift every pause");
  if (resumeSite !== undefined) {
    const was = ledger.unpause(resumeSite);
    ledger.close();
    return { out: was ? `${clean(resumeSite, 40)} is no longer paused. Look at the site yourself first: a challenge page is the site asking for a person.\n` : `${clean(resumeSite, 40)} was not paused.\n`, err: "", code: 0 };
  }

  const facts = loadFacts(home);
  if (!facts.ok) return fail(facts.errors.join("\n"));
  const uploads = loadUploads(home);
  if (!uploads.ok) return fail(uploads.errors.join("\n"));
  let policy = testPolicy;
  if (!test) {
    const allow = loadAllowances(home);
    if (!allow.ok) return fail(allow.errors.join("\n"));
    if (allow.source === "none") return fail(`there is no allowances file yet (${clean(allow.path)}); without it LIVE mode opens nothing. Use --test against a local board, or create the file (see agent-loop login).`);
    policy = liveBrowserPolicy(allow.value, {});
    // the platform is the page's, not the label the user typed: the same address under another label would be a fresh quota and a fresh pause (round 6, A106)
    let derived: string | undefined;
    try { derived = platformOf(allow.value, new URL(applyUrl!).hostname); } catch { /* not an address */ }
    if (!derived) return fail(`${clean(applyUrl ?? "", 120)} is not on your allowances list, so nothing is opened`);
    if (site && site.trim().toLowerCase() !== derived.toLowerCase()) return fail(`that address belongs to the platform "${clean(derived, 40)}" in your allowances file, not "${clean(site, 40)}"`);
    site = derived;
  }
  /** A browser session for one platform (its own agent-only profile in LIVE mode), the tools it offers, and the way to close it. */
  const open = (forSite: string) => {
    const bus = new EventBus();
    const sessions = new BrowserSessionManager({ policy, uploads: uploads.value, ...(test ? {} : { profile: { site: forSite, home, forbidden: [process.cwd()] } }) });
    const handlers = browserToolHandlers({ runId: "apply", bus, sessions, artifactDir: mkdtempSync(join(tmpdir(), "agent-loop-apply-")) }) as unknown as Record<string, Handler>;
    const tools = { call: async (name: string, a: Record<string, unknown>) => { const r = await handlers[name]!.handler(a, {}); return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: r.isError === true }; } };
    return { tools, close: () => sessions.close("apply", bus, "completed").catch(() => {}) };
  };

  if (verify) {
    // Every attempt the ledger holds without a confirmation is looked at on the site: applied -> confirmed, shown as not applied -> can be tried again, anything else -> left alone and reported.
    const rows = ledger.unaccounted();
    const lines: string[] = [];
    let unknown = 0;
    try {
      for (const row of rows) {
        if (!row.url) { lines.push(`#${row.seq} ${clean(row.company, 60)}, ${clean(row.title, 80)}: no page was recorded for it; check the site by hand`); unknown++; continue; }
        const session = open(row.site);
        try {
          const v = await verifyAttempt(session.tools, ledger, row, row.url);
          if (v === "unknown") unknown++;
          lines.push(`#${row.seq} ${clean(row.company, 60)}, ${clean(row.title, 80)}: ${v === "confirmed" ? "the site shows it was received (now confirmed)" : `cannot tell from the site; left unaccounted for. If you have checked and it was not received: agent-loop apply --forget ${row.seq}`}`);
        } catch (err) { unknown++; lines.push(`#${row.seq}: ${clean(String((err as Error)?.message ?? err))}`); } finally { await session.close(); }
      }
    } finally { ledger.close(); }
    return { out: rows.length ? `${lines.join("\n")}\n` : "Nothing to verify: every attempt in the ledger is accounted for.\n", err: "", code: unknown ? 5 : 0 };
  }

  const session = open(site!);
  let r: ApplyResult;
  try {
    r = await applyToJob({ tools: session.tools, facts: facts.value, ledger, resume, job: { site: site!, company: company!, title: title!, ...(str("job-id") ? { jobId: str("job-id")! } : {}) }, applyUrl: applyUrl!, ...(str("job-url") ? { jobUrl: str("job-url")! } : {}) });
  } catch (err) {
    r = { status: "error", why: clean(String((err as Error)?.message ?? err)) };
  } finally {
    ledger.close();
    await session.close();
  }
  const what = `${clean(company!, 60)}, ${clean(title!, 80)}`;
  switch (r.status) {
    case "submitted": return { out: `Applied: ${what} (ledger #${r.seq}, confirmed by the site).\n`, err: "", code: 0 };
    // a posting already applied to is done (0); one whose earlier attempt has no confirmation is not: the user verifies it, like any other "sent, not confirmed" (5) (A124)
    case "duplicate": return { out: `Not applied: ${what}. ${clean(r.why)}\n`, err: "", code: r.unconfirmed ? 5 : 0 };
    case "capped": return { out: `Not applied yet: ${what}. ${clean(r.why)}${r.waitMs && Number.isFinite(r.waitMs) ? ` (opens in about ${Math.ceil(r.waitMs / 60000)} min)` : ""}.\n`, err: "", code: 6 };
    case "parked": return { out: `Needs you: ${what}. Nothing was sent.\n${r.reasons.map((x) => `  - ${clean(x)}`).join("\n")}${r.scam ? "\nThis posting asks for something a real employer does not ask for before an offer. It may be a scam.\n" : "\n"}`, err: "", code: 3 };
    case "paused-site": return { out: `Site paused: ${what}. ${clean(r.why)}\n`, err: "", code: 4 };
    case "unverified": return { out: `Sent, not confirmed: ${what} (ledger #${r.seq}). ${clean(r.why)}\n`, err: "", code: 5 };
    case "error": return fail(r.why);
  }
}
