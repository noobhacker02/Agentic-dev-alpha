import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "./types.js";

const UI_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "index.html");

/**
 * The live UI dies with the run's server, so without this there'd be no way to look back at what a
 * run did. Writes the same UI as a single self-contained file with the run's events embedded
 * (window.__REPLAY__), next to that run's screenshots and video, which it references by relative
 * path -- open it straight from disk, no server, no token.
 */
export function writeRunReport(dir: string, events: AgentEvent[]): string {
  mkdirSync(dir, { recursive: true });
  const html = readFileSync(UI_FILE, "utf8");
  // "<" escaped so no event text can close the <script> element early.
  const data = JSON.stringify(events).replace(/</g, "\\u003c");
  const out = html.replace("<script>", `<script>window.__REPLAY__ = ${data};</script>\n<script>`);
  const path = join(dir, "report.html");
  writeFileSync(path, out);
  return path;
}
