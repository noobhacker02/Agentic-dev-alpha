// The repository scan behind the team's signals: relative PATHS only. The text inside a file is never read here (threat G3: a README that asks for 30 researchers has no way in),
// links are never followed (a link could lead out of the project), and the walk is bounded in depth and in files, so a huge or hostile tree costs a fixed amount.
import { readdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_DEPTH = 8;
/** Directories that are not the project's own source: dependencies, build output, version control, caches, and this tool's own configuration (an agent can write there). */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt", ".cache", ".turbo", ".venv", "venv", "__pycache__", ".tox", "target", ".agent-loop",
]);

export interface ScanOpts {
  max?: number;
  maxDepth?: number;
  /** Lists a directory. Tests give one that returns entries in an unhelpful order, because file systems differ on whether `readdir` is sorted. */
  readDir?: (dir: string) => import("node:fs").Dirent[];
}

/** Relative, forward-slash paths of the files under `root`, breadth first (shallow files win when the limit is reached), in a stable order. A missing or unreadable directory is an empty scan. */
export function scanRepoPaths(root: string, opts: ScanOpts = {}): string[] {
  const max = Math.max(0, Math.floor(opts.max ?? DEFAULT_MAX_FILES));
  const maxDepth = Math.max(0, Math.floor(opts.maxDepth ?? DEFAULT_MAX_DEPTH));
  const list = opts.readDir ?? ((dir: string) => readdirSync(dir, { withFileTypes: true }));
  const out: string[] = [];
  let level: string[] = [""];
  for (let depth = 0; depth <= maxDepth && level.length && out.length < max; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      let entries: import("node:fs").Dirent[];
      try {
        entries = list(rel ? join(root, rel) : root);
      } catch {
        continue; // unreadable or gone: skip it, do not crash
      }
      for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (e.isFile()) {
          if (out.length >= max) return out;
          out.push(path);
        } else if (e.isDirectory() && !SKIP_DIRS.has(e.name)) next.push(path); // isDirectory() is false for a link, so links are skipped
      }
    }
    level = next;
  }
  return out;
}
