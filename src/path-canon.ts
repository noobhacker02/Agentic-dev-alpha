import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";

// Where a path really is. Shared by the file-tool hooks (src/hooks.ts) and the shell analysis (src/bash-analysis.ts), so "inside the working directory" means the same thing to both.

/**
 * The physical location a path names: every symlink followed, and `..` applied to the real directory it follows (the operating system resolves
 * `link/..` through the link, so collapsing it as text first, as `path.resolve` does, judges a different path from the one that will be opened).
 * The part of a path that does not exist yet (a file about to be created) is kept as written. Anything unexpected (a symlink loop, a permission
 * error) returns undefined, and callers treat that as "outside": a path that cannot be resolved is not one to trust.
 * Found by adversary round 1 (A1): a symlink inside --dir pointing at the agent profile read straight through the old, text-only check.
 */
export function canonicalPath(input: string, baseDir: string, hops = 0): string | undefined {
  if (hops > 40) return undefined; // a chain of links this long is a loop
  const raw = isAbsolute(input) ? input : baseDir + sep + input;
  const root = parse(raw).root;
  // `resolve` on the bare root only maps it to a place: on Windows "/" and "\\" are the current drive's root, not a directory named "/", and
  // walking up from the unmapped root made every `/tmp/...` path unresolvable, so every workdir looked like it had nothing inside it.
  let cur = resolve(root);
  for (const comp of raw.slice(root.length).split(/[\\/]+/)) {
    if (comp === "" || comp === ".") continue;
    if (comp === "..") {
      cur = dirname(cur);
      continue;
    }
    const next = cur.endsWith(sep) ? cur + comp : cur + sep + comp;
    try {
      cur = realpathSync.native(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      // Either nothing is there (a file about to be created: keep it as written), or a symlink whose target does not exist yet. Writing through
      // the second kind creates the file at the target, so follow it by hand.
      let link: string | undefined;
      try {
        if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next);
      } catch { /* not there at all */ }
      if (link === undefined) {
        cur = next;
      } else {
        const followed = canonicalPath(link, cur, hops + 1);
        if (followed === undefined) return undefined;
        cur = followed;
      }
    }
  }
  return cur;
}

const foldCase = (p: string): string => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);

export function isInside(workDir: string, candidate: string, baseDir: string = workDir): boolean {
  const root = canonicalPath(workDir, process.cwd());
  const resolved = canonicalPath(candidate, baseDir);
  if (root === undefined || resolved === undefined) return false;
  const r = foldCase(root), c = foldCase(resolved);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}


/**
 * What the file tools will actually open for the path text a model gave them (adversary round 2, A27 and A44). The tools expand a leading `~` to the home directory, so a hook that
 * read `~/x` as a directory called `~` inside --dir judged a different file from the one opened. Forms the check cannot place (another user's home, a network path, a drive-relative
 * path, a %VARIABLE%, a NUL) are refused rather than guessed at.
 */
export function toolPath(value: string): { path: string } | { refuse: string } {
  if (value.includes("\0")) return { refuse: "it contains a NUL byte" };
  if (/^\\\\/.test(value)) return { refuse: "it is a network (UNC) path" };
  if (/^[A-Za-z]:(?![\\/])/.test(value)) return { refuse: "it is a drive-relative path (C:name), which depends on a directory this check cannot see" };
  if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(value)) return { refuse: "it contains a %VARIABLE% that the tool may expand" };
  if (value === "~" || /^~[\\/]/.test(value)) return { path: join(homedir(), value.slice(1)) };
  if (value.startsWith("~")) return { refuse: "it starts with ~user, another user's home directory" };
  return { path: value };
}

/** `{a,b}` alternatives, one level at a time and bounded: enough to look at every directory a Glob pattern can name. */
export function expandBraces(pattern: string, limit = 64): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    if (out.length >= limit) return;
    const m = p.match(/\{([^{}]*,[^{}]*)\}/);
    if (!m) { out.push(p); return; }
    for (const alt of m[1].split(",")) walk(p.slice(0, m.index) + alt + p.slice((m.index ?? 0) + m[0].length));
  };
  walk(pattern);
  return out;
}
