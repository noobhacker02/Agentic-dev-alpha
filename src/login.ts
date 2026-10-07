// `agent-loop login <site>` (docs/HYBRID-AGENT-SPEC.md S2): the user logs in to a site once, by hand, in a browser window that keeps its profile in the agent-only directory; later runs use that session. The agent never types
// a credential: this opens the window and waits, and it neither reads nor records what the person types or the cookies the site sets. The window goes through the same network gate as everything else, so a link on a
// sign-in page cannot lead it to a private address; it is not held to the allowances list, because signing in often goes through another provider.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { loadAllowances, livePolicy, navigationVerdict, type Allowances } from "./allowances.js";
import { launchPersistent } from "./browser-tools.js";
import { startNetGate } from "./net-gate.js";
import { acquireProfileLock, clearChromiumLeftovers, prepareProfile, siteName } from "./profile.js";
import { agentLoopHome } from "./data-dir.js";
import { stripTerminalControlBytes } from "./text-safety.js";
import type { CommandResult, ParsedArgs } from "./team/cli-commands.js";

export interface LoginOptions {
  site: string;
  /** The user's agent-loop directory. */
  home: string;
  allowances: Allowances;
  /** Where to start; by default the first domain of the platform. It must be on the list and belong to the platform. */
  url?: string;
  /** Directories the profile must not be inside (the repository, the working directory). */
  forbidden?: string[];
  /** Tests run the window headless and act as the person through `drive`. */
  headless?: boolean;
  drive?: (w: { context: BrowserContext; page: Page }) => Promise<void>;
  /** Tests point names at a local server. */
  isPublic?: (ip: string) => boolean;
  resolve?: (host: string) => Promise<string[]>;
  extraPorts?: number[];
  say?: (line: string) => void;
  /** Aborting closes the window (Ctrl-C). */
  signal?: AbortSignal;
}

export type LoginResult = { ok: true; dir: string } | { ok: false; error: string };

const clean = (s: string, n = 80): string => stripTerminalControlBytes(s).replace(/[^\x20-\x7e]/g, "?").slice(0, n);

export async function runLogin(o: LoginOptions): Promise<LoginResult> {
  const say = o.say ?? (() => {});
  const site = siteName(o.site);
  if (!site) return { ok: false, error: `"${clean(String(o.site), 40)}" is not a site name: use the platform name from your allowances file (lower-case letters, digits, hyphens)` };
  const platform = o.allowances.platforms.find((p) => p.name === site);
  if (!platform) {
    const known = o.allowances.platforms.map((p) => p.name);
    return { ok: false, error: `"${site}" is not a platform in your allowances file. ${known.length ? `Platforms there: ${known.join(", ")}.` : "It has no platforms."} Add it under "platforms" (for example "${site}": ["example.com"]) and its domains under "allow".` };
  }
  const start = o.url ?? (platform.rules[0] ? `https://${platform.rules[0].host}/` : undefined);
  if (!start) return { ok: false, error: `the ${site} platform has no domains; list one under "platforms"` };
  const verdict = navigationVerdict(o.allowances, start, { extraPorts: o.extraPorts });
  if (!verdict.ok) return { ok: false, error: `the login page ${clean(start, 100)} cannot be opened: ${verdict.reason}` };
  if (verdict.platform !== site) return { ok: false, error: `${clean(verdict.host)} belongs to the ${verdict.platform} platform, not ${site}` };

  const prepared = prepareProfile({ home: o.home, site, forbidden: o.forbidden });
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const lock = acquireProfileLock(prepared.lockPath);
  if (!lock.ok) return { ok: false, error: lock.error };
  let gate: Awaited<ReturnType<typeof startNetGate>> | undefined;
  let context: BrowserContext | undefined;
  const downloads = mkdtempSync(join(tmpdir(), "agent-loop-login-"));
  try {
    const left = clearChromiumLeftovers(prepared.dir);
    if (!left.ok) return { ok: false, error: left.error };
    gate = await startNetGate({ policy: livePolicy(o.allowances, { isPublic: o.isPublic }), resolve: o.resolve });
    context = await launchPersistent(prepared.dir, downloads, { server: `http://127.0.0.1:${gate.port}`, username: gate.username, password: gate.password }, { acceptDownloads: false, ...(o.headless ? {} : { viewport: null }) }, o.headless ?? false);  // devskill:allow (a runtime-generated credential or a type, not a secret)
    const page = context.pages()[0] ?? (await context.newPage());
    const closed = new Promise<void>((resolve) => context!.on("close", () => resolve()));
    // Ctrl-C must close the window whenever it arrives: while it opens (an abort that fires before anyone listens is never delivered again), while the page loads, or later.
    const closeNow = () => { void context?.close().catch(() => {}); };
    if (!o.drive) {
      if (o.signal?.aborted) closeNow();
      else o.signal?.addEventListener("abort", closeNow, { once: true });
    }
    say(`Opening ${verdict.host} in a browser window. Log in as you normally would, then close the window. agent-loop does not read what you type or the cookies the site sets.`);
    await page.goto(verdict.url, { waitUntil: "commit", timeout: 30_000 }).catch(() => { /* the person sees the error in the window, or the window was closed */ });
    if (o.drive) await o.drive({ context, page });
    else await closed;
    return { ok: true, dir: prepared.dir };
  } catch (err) {
    return { ok: false, error: `the login window could not be opened: ${clean(err instanceof Error ? err.message : String(err), 300)}` };
  } finally {
    await context?.close().catch(() => {});
    await gate?.close().catch(() => {});
    try { rmSync(downloads, { recursive: true, force: true }); } catch { /* best effort */ }
    lock.release();
  }
}

/** `agent-loop login <site> [--url <login page>]`. Everything but the window is checked before it opens, with a plain message. */
export async function loginCommand(args: ParsedArgs, env: { signal?: AbortSignal; say?: (line: string) => void } = {}): Promise<CommandResult> {
  const fail = (message: string): CommandResult => ({ out: "", err: `Error: ${message}\n`, code: 1 });
  const site = args._[0];
  if (!site) return fail('agent-loop login needs a site: agent-loop login <site> [--url <login page>]. The site is a platform name from "platforms" in your allowances file.');
  if (typeof args.url === "boolean") return fail("--url needs a value: the login page to open");
  const home = agentLoopHome();
  const loaded = loadAllowances(home);
  if (!loaded.ok) return fail(loaded.errors.join("\n"));
  if (loaded.source === "none") return fail(`there is no allowances file yet (${clean(loaded.path, 200)}). Create it with the domains you allow, and a platform for ${clean(site, 40)}, for example: {"allow": ["linkedin.com"], "platforms": {"linkedin": ["linkedin.com"]}}`);
  const dir = typeof args.dir === "string" ? args.dir : undefined;
  const r = await runLogin({
    site, home, allowances: loaded.value,
    ...(typeof args.url === "string" ? { url: args.url } : {}),
    forbidden: [process.cwd(), ...(dir ? [dir] : [])],
    say: env.say,
    signal: env.signal,
  });
  if (!r.ok) return fail(r.error);
  return { out: `Saved the ${clean(site, 40)} session in ${clean(r.dir, 200)} (readable only by you). Later runs that use this profile start logged in.\n`, err: "", code: 0 };
}
