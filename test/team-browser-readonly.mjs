// A checker's browser (docs/TEAM-COMPOSITION.md, "Checkers"; adversary A16): a step that is only meant to look at a page is given a browser server without the tools that act on it. The model has no tool to call,
// which is stronger than a hook that refuses it. This registers the real tool set both ways and compares the names.
//   npm run build && npm run test:team-browser-readonly
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSessionManager, __testHandlers, selectBrowserTools, BROWSER_ACTING_TOOLS } from "../dist/browser-tools.js";
import { EventBus } from "../dist/bus.js";

const opts = { runId: "ro", bus: new EventBus(), sessions: new BrowserSessionManager(), artifactDir: mkdtempSync(join(tmpdir(), "ro-art-")) };
const all = __testHandlers(opts);
const names = (readOnly) => selectBrowserTools(all, readOnly).map((t) => t.name).sort();

// the full browser, unchanged
assert.deepStrictEqual(names(false), Object.keys(all).sort(), "the full browser lost a tool");
for (const n of ["click", "fill", "press", "select_option", "upload", "click_at", "open", "inspect", "text", "screenshot", "scroll", "hover", "wait", "list_tabs"]) assert.ok(names(false).includes(n), `the full browser has no ${n}`);

// the read-only browser: exactly the acting tools are gone
const ro = names(true);
assert.deepStrictEqual(ro, Object.keys(all).filter((n) => !["click", "fill", "press", "select_option", "upload", "click_at"].includes(n)).sort(), "the read-only browser is not the full set minus the six acting tools");
assert.deepStrictEqual([...BROWSER_ACTING_TOOLS].sort(), ["click", "click_at", "fill", "press", "select_option", "upload"], "the list of acting tools changed");
for (const n of ["click", "fill", "press", "select_option", "upload", "click_at"]) assert.ok(!ro.includes(n), `the read-only browser has ${n}`);
for (const n of ["open", "inspect", "text", "notices", "screenshot", "scroll", "scroll_at", "hover", "wait", "list_tabs", "switch_tab", "close_tab", "resize"]) assert.ok(ro.includes(n), `the read-only browser lost ${n}, which only looks`);

// every tool that exists is either acting or listed as one a checker keeps: a new tool added later must be classified on purpose
const KEPT = ["open", "inspect", "text", "notices", "screenshot", "scroll", "scroll_at", "hover", "wait", "list_tabs", "switch_tab", "close_tab", "resize"];
const unclassified = Object.keys(all).filter((n) => !BROWSER_ACTING_TOOLS.includes(n) && !KEPT.includes(n));
assert.deepStrictEqual(unclassified, [], `a browser tool is neither acting nor known to be read-only: ${unclassified} (decide which, then list it here)`);
console.log(`[ok] the read-only browser registers ${ro.length} of ${names(false).length} tools: the six that click, type, press, select and attach a file are gone, the ones that look remain, and every tool is classified`);
console.log("\nALL TEAM BROWSER READ-ONLY TESTS PASSED");
process.exit(0);
