import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "./types.js";
import { uiData, type HumorLevel } from "./persona.js";
import { spritesScript } from "./sprites.js";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");
const UI_FILE = join(UI_DIR, "index.html");

/** Script text that can sit inside <script>…</script> without being able to close it early. */
const inlineSafe = (js: string) => js.replace(/<\/script/gi, "<\\/script");

/**
 * The live UI dies with the run's server, so without this there'd be no way to look back at what a
 * run did. Writes the same UI as a single self-contained file with the run's events embedded
 * (window.__REPLAY__), next to that run's screenshots and video, which it references by relative
 * path -- open it straight from disk, no server, no token.
 */
export function writeRunReport(dir: string, events: AgentEvent[], humor: HumorLevel = "dark", plain = false): string {
  mkdirSync(dir, { recursive: true });
  const html = readFileSync(UI_FILE, "utf8");
  // "<" escaped so no event text can close the <script> element early.
  const data = JSON.stringify(events).replace(/</g, "\\u003c");
  const persona = JSON.stringify(uiData(humor)).replace(/</g, "\\u003c");
  // Function replacers, never replacement strings: event text such as `echo $'x'` or `$&` would otherwise be
  // expanded by String.replace's own $-patterns and corrupt (or break out of) the embedded data.
  let out = html.replace("<script>", () => `<script>window.__REPLAY__ = ${data};</script>\n<script>`);
  // The live page loads its data and helper scripts from the server; a file opened from disk has no server,
  // so each one goes inline: persona text, the sprites, and the page's own modules.
  out = out.replace(/<script src="\/([\w-]+)\.js"><\/script>/g, (tag, name: string) => {
    if (name === "persona") return `<script>window.__PERSONA__ = ${persona};</script>`;
    if (name === "plain") return `<script>window.__PLAIN_DEFAULT__ = ${plain ? "true" : "false"};\n${inlineSafe(readFileSync(join(UI_DIR, "plain.js"), "utf8"))}</script>`;
    if (name === "sprite-data") return `<script>${spritesScript()}</script>`;
    try {
      return `<script>${inlineSafe(readFileSync(join(UI_DIR, `${name}.js`), "utf8"))}</script>`;
    } catch {
      return tag;
    }
  });
  const path = join(dir, "report.html");
  writeFileSync(path, out);
  return path;
}
