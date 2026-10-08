// `agent-loop apply <application page>`: one application, through the job flow's engine (src/job-apply.ts). It reads the user's own files from the agent-loop directory (allowances.json, facts.json, uploads.json),
// keeps the ledger there (ledger.db), and runs the browser in LIVE mode with the agent-only profile for the site, or with --test in TEST mode (localhost only, no profile) against a local board.
// It prints what happened and exits with a code a script can read: 0 submitted or already applied, 1 error, 3 parked (the user is asked), 4 the site was paused, 5 sent but not confirmed, 6 capped.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllowances } from "./allowances.js";
import { BrowserSessionManager, browserToolHandlers } from "./browser-tools.js";
import { liveBrowserPolicy, testPolicy } from "./browser-policy.js";
import { EventBus } from "./bus.js";
import { agentLoopHome } from "./data-dir.js";
import { loadFacts } from "./facts.js";
import { applyToJob, type ApplyResult } from "./job-apply.js";
import { Ledger, loadCaps } from "./ledger.js";
import { stripTerminalControlBytes } from "./text-safety.js";
import { loadUploads } from "./uploads.js";
import type { CommandResult, ParsedArgs } from "./team/cli-commands.js";

const clean = (s: string, n = 200): string => stripTerminalControlBytes(s).replace(/[^\x20-\x7e]/g, "?").slice(0, n);

export async function applyCommand(args: ParsedArgs): Promise<CommandResult> {
  const fail = (message: string): CommandResult => ({ out: "", err: `Error: ${message}\n`, code: 1 });
  const applyUrl = args._[0];
  const str = (k: string): string | undefined => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  const test = args.test === true;
  const site = str("site"), company = str("company"), title = str("title");
  if (!applyUrl || !site || !company || !title) return fail('agent-loop apply needs the application page and what it is for: agent-loop apply <application page> --site <platform> --company "<company>" --title "<job title>" [--job-id <id>] [--job-url <posting page>] [--resume <name>] [--test]');
  const home = agentLoopHome();
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
  }
  const caps = loadCaps(home);
  if (!caps.ok) return fail(caps.errors.join("\n"));
  const resume = str("resume") ?? "resume";
  const bus = new EventBus();
  const sessions = new BrowserSessionManager({ policy, uploads: uploads.value, ...(test ? {} : { profile: { site, home, forbidden: [process.cwd()] } }) });
  const handlers = browserToolHandlers({ runId: "apply", bus, sessions, artifactDir: mkdtempSync(join(tmpdir(), "agent-loop-apply-")) }) as unknown as Record<string, { handler(a: unknown, e: unknown): Promise<{ content: Array<{ text?: string }>; isError?: boolean }> }>;
  const tools = { call: async (name: string, a: Record<string, unknown>) => { const r = await handlers[name]!.handler(a, {}); return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: r.isError === true }; } };
  const ledger = new Ledger(join(home, "ledger.db"), Date.now, caps.value);
  let r: ApplyResult;
  try {
    r = await applyToJob({ tools, facts: facts.value, ledger, resume, job: { site, company, title, ...(str("job-id") ? { jobId: str("job-id")! } : {}) }, applyUrl, ...(str("job-url") ? { jobUrl: str("job-url")! } : {}) });
  } catch (err) {
    r = { status: "error", why: clean(String((err as Error)?.message ?? err)) };
  } finally {
    ledger.close();
    await sessions.close("apply", bus, "completed").catch(() => {});
  }
  const what = `${clean(company, 60)}, ${clean(title, 80)}`;
  switch (r.status) {
    case "submitted": return { out: `Applied: ${what} (ledger #${r.seq}, confirmed by the site).\n`, err: "", code: 0 };
    case "duplicate": return { out: `Not applied: ${what}. ${clean(r.why)}\n`, err: "", code: 0 };
    case "capped": return { out: `Not applied yet: ${what}. ${clean(r.why)}${r.waitMs ? ` (opens in about ${Math.ceil(r.waitMs / 60000)} min)` : ""}.\n`, err: "", code: 6 };
    case "parked": return { out: `Needs you: ${what}. Nothing was sent.\n${r.reasons.map((x) => `  - ${clean(x)}`).join("\n")}${r.scam ? "\nThis posting asks for something a real employer does not ask for before an offer. It may be a scam.\n" : "\n"}`, err: "", code: 3 };
    case "paused-site": return { out: `Site paused: ${what}. ${clean(r.why)}\n`, err: "", code: 4 };
    case "unverified": return { out: `Sent, not confirmed: ${what} (ledger #${r.seq}). ${clean(r.why)}\n`, err: "", code: 5 };
    case "error": return fail(r.why);
  }
}
