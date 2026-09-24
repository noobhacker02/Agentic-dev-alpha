/**
 * Every phase and the Overseer used to get `env: { ...process.env }` — the full shell environment
 * of whoever runs `agent-loop`, secrets and all. A phase running `cat .env` or `env` would then have
 * that written to SQLite in plain text and broadcast to every WebSocket client (see
 * docs/STRESS-TEST-REPORT.md). The SDK subprocess needs *some* environment to run and to
 * authenticate, but not the calling shell's unrelated app secrets (database URLs, other services'
 * API keys, ...).
 *
 * `env` on SDK options REPLACES the subprocess environment rather than merging with it, so building
 * this list is enough on its own — nothing extra leaks through underneath it.
 */
const BASE_VARS = ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "TMP", "TEMP"];

/** Prefixes covering Claude Code / Agent SDK auth, config and this environment's own plumbing. */
const ALLOWED_PREFIXES = ["CLAUDE_", "ANTHROPIC_"];

export function minimalEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of BASE_VARS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  for (const key of Object.keys(source)) {
    if (ALLOWED_PREFIXES.some((p) => key.startsWith(p))) env[key] = source[key];
  }
  return env;
}
