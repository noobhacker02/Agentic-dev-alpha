// The agent-only browser profile (docs/HYBRID-AGENT-SPEC.md S2; threats D4 and D5). A logged-in session is a credential: it lives in one directory per site under the user's own agent-loop home, mode 0700, never inside
// the project or the working directory the agents write to (a Bash call could read it there), never reached through a link, and used by one process at a time. The lock survives a crash and a reboot (a pid that
// is alive but is not the process that took the lock is a different process) without ever being taken from a holder that may be alive. Chromium's own leftovers in a persistent profile are removed only once their
// owner is provably gone.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SITE_RE = /^[a-z][a-z0-9-]{0,30}$/;
/** A lock file that cannot be read is probably being written; it is held this long, and after that it is a broken file. */
const BROKEN_FILE_GRACE_MS = 10_000;
const RECOVERY_STALE_MS = 30_000;

/** A site is a platform name from the allowances file: lower-case letters, digits and hyphens. */
export function siteName(raw: unknown): string | undefined {
  return typeof raw === "string" && SITE_RE.test(raw) ? raw : undefined;
}

/** Is `child` the same as, or somewhere under, `parent`? A directory whose own name starts with two dots (`..x`) is a child, not a way out; only `..` itself or `..` followed by a separator climbs out. */
export const within = (parent: string, child: string): boolean => {
  const r = relative(parent, child);
  return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r);
};

/** The real path of `p`, even if it does not exist yet: the nearest ancestor that exists is resolved through its links (on macOS `/var` is a link to `/private/var`, and a directory that is not there yet still lives under it) and the rest is appended. */
export const realOrResolved = (p: string): string => {
  const full = resolve(p);
  const rest: string[] = [];
  for (let cur = full; ; ) {
    try { return rest.length ? join(realpathSync(cur), ...rest) : realpathSync(cur); } catch { /* not there: try its parent */ }
    const parent = dirname(cur);
    if (parent === cur) return full;
    rest.unshift(basename(cur));
    cur = parent;
  }
};

export interface PrepareOptions {
  /** The user's agent-loop directory. */
  home: string;
  site: string;
  /** Directories the profile must be neither inside nor around: the repository and the working directory the agents write to. */
  forbidden?: string[];
  /** Who "you" is (tests); defaults to the current user. */
  uid?: number;
}

export type PrepareResult = { ok: true; dir: string; lockPath: string } | { ok: false; error: string };

/** Makes sure `path` is a directory of ours that nobody else can read, creating it 0700. Never through a link. */
function ensurePrivateDir(path: string, label: string, uid: number | undefined): string | undefined {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return `${label} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})`;
    try {
      mkdirSync(path, { mode: 0o700 });
      if (process.platform !== "win32") chmodSync(path, 0o700);
      return undefined;
    } catch (e) {
      return `${label} cannot be created (${(e as NodeJS.ErrnoException).code ?? "error"})`;
    }
  }
  if (st.isSymbolicLink()) return `${label} is a link; it must be a real directory, so a profile cannot be planted or read behind it`;
  if (!st.isDirectory()) return `${label} is not a directory`;
  if (process.platform !== "win32") {
    if (uid !== undefined && st.uid !== uid) return `${label} is not owned by you`;
    if (st.mode & 0o077) chmodSync(path, 0o700);
  }
  return undefined;
}

/** Prepares `<home>/profiles/<site>`: 0700, owned by the user, not a link, and not inside (or around) the repository or the working directory. */
export function prepareProfile(o: PrepareOptions): PrepareResult {
  const site = siteName(o.site);
  if (!site) return { ok: false, error: `"${String(o.site).replace(/[^\x20-\x7e]/g, "?").slice(0, 40)}" is not a site name: use the platform name from your allowances file (lower-case letters, digits, hyphens)` };
  const uid = o.uid ?? process.getuid?.();
  try { mkdirSync(o.home, { recursive: true, mode: 0o700 }); } catch { /* reported below if it matters */ }
  let realHome: string;
  try { realHome = realpathSync(o.home); } catch { return { ok: false, error: "the agent-loop home directory cannot be read" }; }
  const profiles = join(realHome, "profiles");
  const dir = join(profiles, site);
  const bad = ensurePrivateDir(profiles, "the profiles directory", uid) ?? ensurePrivateDir(dir, `the ${site} profile`, uid);
  if (bad) return { ok: false, error: bad };
  const real = realpathSync(dir);
  for (const f of o.forbidden ?? []) {
    const rf = realOrResolved(f);
    if (within(rf, real)) return { ok: false, error: `the profile would be inside ${rf}, a directory the agents can read: put the agent-loop home somewhere else` };
    if (within(real, rf)) return { ok: false, error: `the profile would contain ${rf}, a directory the agents work in` };
  }
  return { ok: true, dir: real, lockPath: join(realHome, "profiles", `${site}.lock`) };
}

export interface LockHolder {
  pid: number;
  /** The start time of the process that took the lock, to tell it from a different process that was given the same pid later. */
  start?: string;
  host: string;
  nonce: string;
  since: string;
}

export interface LockEnv {
  pid?: number;
  host?: string;
  isAlive?: (pid: number) => boolean;
  startOf?: (pid: number) => string | undefined;
  now?: () => Date;
  /** Tests only: runs at the two points where another process could step in during a recovery ("stale-found": a stale lock has been read; "before-remove": about to remove it, mutex held). */
  between?: (stage: "stale-found" | "before-remove") => void;
}

export type LockResult = { ok: true; release(): void; staleRecovered?: LockHolder } | { ok: false; error: string; holder?: LockHolder };

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** When a process started, in a form that differs for a different process with the same pid (on Linux it includes the boot id, so a reboot cannot repeat it). Undefined if the process is not there or the time cannot be read. */
export function processStartTime(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // from field 3 on: the command name may hold spaces and parentheses
      const ticks = fields[19]; // field 22, starttime
      if (!ticks) return undefined;
      let boot = "";
      try { boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { /* without it the ticks alone still tell two processes apart within a boot */ }
      return `${boot}:${ticks}`;
    }
    if (process.platform === "win32") {
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8", timeout: 15_000, windowsHide: true });
      const out = (r.stdout ?? "").trim();
      return r.status === 0 && out ? out : undefined;
    }
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
    const out = (r.stdout ?? "").trim();
    return r.status === 0 && out ? out : undefined;
  } catch {
    return undefined;
  }
}

const readHolder = (path: string): LockHolder | undefined => {
  try {
    const h = JSON.parse(readFileSync(path, "utf8")) as LockHolder;
    return h && typeof h.pid === "number" && typeof h.host === "string" && typeof h.nonce === "string" ? h : undefined;
  } catch {
    return undefined;
  }
};

const sleepMs = (ms: number): void => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* a short busy wait is fine */ } };

/**
 * Takes the profile's lock, or says who has it. The lock is created whole and atomically (a complete temporary file hard-linked into place), so a reader never sees half of it. An existing lock is stale if
 * its holder is gone, or if the pid is alive but its start time is not the one written (a different process now). Anything that cannot be proven stale is held: another machine's lock, a live holder whose
 * start time cannot be read, a file that is still being written.
 */
export function acquireProfileLock(lockPath: string, env: LockEnv = {}): LockResult {
  const pid = env.pid ?? process.pid;
  const host = env.host ?? hostname();
  const alive = env.isAlive ?? isPidAlive;
  const startOf = env.startOf ?? processStartTime;
  const now = env.now ?? (() => new Date());
  const mine: LockHolder = { pid, start: startOf(pid), host, nonce: randomBytes(16).toString("hex"), since: now().toISOString() };
  const tmp = `${lockPath}.${mine.nonce}.tmp`;
  // A lock that cannot be made (the directory is gone, the disk is read-only, the filesystem has no hard links) is a refusal with a reason, not a crash.
  const failed = (err: unknown): LockResult => {
    const code = (err as NodeJS.ErrnoException)?.code ?? "error";
    const noLinks = ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"].includes(code);
    return { ok: false, error: `the profile's lock could not be created (${code})${noLinks ? "; the agent-loop home must be on a filesystem that supports hard links" : ""}` };
  };
  try { writeFileSync(tmp, JSON.stringify(mine), { mode: 0o600, flag: "wx" }); } catch (err) { return failed(err); }
  const release = (): void => {
    const cur = readHolder(lockPath);
    if (cur && cur.nonce === mine.nonce) { try { unlinkSync(lockPath); } catch { /* already gone */ } }
  };
  try {
    let recovered: LockHolder | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        linkSync(tmp, lockPath);
        return { ok: true, release, ...(recovered ? { staleRecovered: recovered } : {}) };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") return failed(err);
      }
      const holder = readHolder(lockPath);
      if (!holder) {
        let ageMs = Infinity;
        try { ageMs = now().getTime() - statSync(lockPath).mtimeMs; } catch { continue; } // it vanished between the two calls: try again
        if (ageMs < BROKEN_FILE_GRACE_MS) return { ok: false, error: "the profile's lock file is being written by another process; try again in a few seconds" };
        recovered = undefined; // a broken file has no holder to report
      } else {
        if (holder.host !== host) return { ok: false, holder, error: `this profile is locked by pid ${holder.pid} on another computer (${holder.host}); you are on ${host}. Remove ${lockPath} yourself if that machine is not using it` };
        let stale = !alive(holder.pid);
        if (!stale) {
          const current = startOf(holder.pid);
          stale = holder.start !== undefined && current !== undefined && current !== holder.start; // alive, but not the process that took the lock
        }
        if (!stale) return { ok: false, holder, error: `this profile is in use by pid ${holder.pid} (since ${holder.since}); close that run first` };
        recovered = holder;
      }
      env.between?.("stale-found");
      // Recovery is done under a small mutex, so two processes that both found the same stale lock cannot each remove the other's fresh one.
      const mutex = `${lockPath}.recovering`;
      let haveMutex = false;
      try { mkdirSync(mutex); haveMutex = true; } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          try { if (now().getTime() - statSync(mutex).mtimeMs > RECOVERY_STALE_MS) rmSync(mutex, { recursive: true, force: true }); } catch { /* gone */ }
        }
      }
      if (!haveMutex) { sleepMs(50); continue; }
      try {
        const again = readHolder(lockPath);
        env.between?.("before-remove");
        if ((again?.nonce ?? "") === (holder?.nonce ?? "")) { try { unlinkSync(lockPath); } catch { /* gone already */ } }
      } finally {
        rmSync(mutex, { recursive: true, force: true });
      }
    }
    return { ok: false, error: "could not take the profile's lock (it kept changing); try again" };
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

const SINGLETONS = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

/** Removes what a Chromium that died leaves in a persistent profile, but only when its owner is provably gone. They are links; they are removed, never followed. */
export function clearChromiumLeftovers(dir: string, env: LockEnv = {}): { ok: true; removed: string[] } | { ok: false; error: string } {
  const pid = env.pid ?? process.pid;
  const host = env.host ?? hostname();
  const alive = env.isAlive ?? isPidAlive;
  const present = SINGLETONS.filter((n) => { try { lstatSync(join(dir, n)); return true; } catch { return false; } });
  if (!present.length) return { ok: true, removed: [] };
  let target: string | undefined;
  try { target = readlinkSync(join(dir, "SingletonLock")); } catch { target = undefined; }
  const m = target ? /^(.*)-(\d+)$/.exec(target) : null;
  if (m) {
    const [, otherHost, otherPid] = m;
    if (otherHost !== host) return { ok: false, error: `Chromium's lock in this profile says it is in use on ${otherHost}; close it there first` };
    if (Number(otherPid) !== pid && alive(Number(otherPid))) return { ok: false, error: `a Chromium process (pid ${otherPid}) is running on this profile; close it first` };
  }
  for (const n of present) {
    try { unlinkSync(join(dir, n)); } catch (err) { return { ok: false, error: `Chromium's leftover ${n} in this profile could not be removed (${(err as NodeJS.ErrnoException).code ?? "error"})` }; }
  }
  return { ok: true, removed: present };
}

