// What a step really changed (docs/TEAM-COMPOSITION.md, V8 and G8). The write-scope hook judges the file tools; Bash is outside it, so after every step the project tree is compared with how it was before and every
// changed path is audited against the step's slice. A snapshot is bounded and honest: ordinary files by content hash, large ones by size and time, links read as links and never followed, derived directories (builds,
// caches, dependencies) left out because builds and tests write there, and a snapshot that was cut short says so, because an audit over part of a tree has to fail closed.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export interface TreeSnapshot {
  /** Project-relative path with forward slashes, to a signature of what is there. */
  files: Map<string, string>;
  /** The walk stopped at the file limit: this snapshot does not describe the whole tree. */
  truncated: boolean;
  /** Directories and files that could not be read. */
  unreadable: string[];
}

/** Directories no step is judged on: dependencies, version control, builds, test output and caches. */
const DERIVED = new Set([".git", "node_modules", "dist", "build", "out", "coverage", ".cache", ".next", "__pycache__", ".pytest_cache", ".agent-loop"]);
const HASH_LIMIT = 1024 * 1024;
export const DEFAULT_MAX_FILES = 20_000;

export function snapshotTree(root: string, opts: { maxFiles?: number } = {}): TreeSnapshot {
  const max = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const files = new Map<string, string>();
  const unreadable: string[] = [];
  let truncated = false;
  const walk = (rel: string): void => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      unreadable.push(rel || ".");
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!DERIVED.has(e.name)) walk(childRel);
        continue;
      }
      if (files.size >= max) { truncated = true; return; }
      const abs = join(root, childRel);
      try {
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) files.set(childRel, `l:${readlinkSync(abs)}`);
        else if (st.isFile()) {
          const exec = st.mode & 0o111 ? "x" : "-";
          files.set(childRel, st.size <= HASH_LIMIT ? `f:${exec}:${st.size}:${createHash("sha1").update(readFileSync(abs)).digest("hex")}` : `f:${exec}:${st.size}:${st.mtimeMs}`);
        }
      } catch {
        unreadable.push(childRel);
      }
    }
  };
  walk("");
  return { files, truncated, unreadable };
}

/** The paths added, changed or removed between two snapshots, sorted. Throws when either was cut short: a comparison over part of a tree proves nothing. */
export function changedBetween(before: TreeSnapshot, after: TreeSnapshot): string[] {
  if (before.truncated || after.truncated) throw new Error("the project tree is too large to compare completely: a snapshot was cut short (incomplete), so what the step changed cannot be audited");
  const out = new Set<string>();
  for (const [p, sig] of after.files) if (before.files.get(p) !== sig) out.add(p);
  for (const p of before.files.keys()) if (!after.files.has(p)) out.add(p);
  return [...out].sort();
}
