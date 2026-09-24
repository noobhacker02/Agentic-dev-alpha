import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * Where the audit database lives, per `--dir` (the directory the agents themselves read and
 * write). It used to be `<workDir>/.agent-loop/agent-loop.db` — inside the directory the Builder
 * phase has Write/Edit/Bash access to, so a phase could read, edit, or delete its own audit trail
 * (docs/STRESS-TEST-REPORT.md). It now lives under a data directory the agents never see, keyed by
 * the resolved `--dir` so repeated runs against the same project still accumulate in one file.
 *
 * `override` is `--data-dir` (or `AGENT_LOOP_DATA_DIR`), for a custom location or a test's own tmp
 * dir; the default is `~/.agent-loop` (or `AGENT_LOOP_HOME`, e.g. for a sandbox with a read-only or
 * unwritable home directory).
 */
export function resolveDataDir(workDir: string, override?: string): string {
  if (override) return resolve(override);
  const home = process.env.AGENT_LOOP_HOME || join(homedir(), ".agent-loop");
  const absWorkDir = resolve(workDir);
  const hash = createHash("sha256").update(absWorkDir).digest("hex").slice(0, 16);
  const label = sanitize(basename(absWorkDir)) || "run";
  return join(home, "runs", `${label}-${hash}`);
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
}
