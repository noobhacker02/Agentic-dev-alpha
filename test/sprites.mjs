// The UI's pixel sprites (src/sprites.ts, ui/assets/): the shipped set is sound, a swapped-in sprite that is wrong
// is caught, a bad manifest can never break the page or read outside the asset folder, and the live server and a
// saved report both carry the same art. No browser, no API calls:   npm run build && npm run test:sprites
import assert from "node:assert";
import vm from "node:vm";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSprites, spritesScript, ASSET_DIR } from "../dist/sprites.js";
import { startServer } from "../dist/server.js";
import { EventBus } from "../dist/bus.js";

const parse = (script) => { const ctx = { window: {} }; vm.runInNewContext(script, ctx); return ctx.window.__SPRITES__; };
const copy = () => { const d = mkdtempSync(join(tmpdir(), "agent-loop-sprites-")); cpSync(ASSET_DIR, d, { recursive: true }); return d; };
const edit = (dir, fn) => { const p = join(dir, "manifest.json"); const m = JSON.parse(readFileSync(p, "utf8")); fn(m); writeFileSync(p, JSON.stringify(m)); };

// --- the shipped set
assert.deepStrictEqual(validateSprites(), [], "the sprites that ship pass their own validator");
const real = parse(spritesScript());
const manifest = JSON.parse(readFileSync(join(ASSET_DIR, "manifest.json"), "utf8"));
for (const [section, entries] of [["cat", manifest.cat], ["cursors", manifest.cursors], ["dino", manifest.dino]]) {
  assert.deepStrictEqual(Object.keys(real[section]).sort(), Object.keys(entries).sort(), `every ${section} entry reaches the page`);
}
assert.deepStrictEqual(Object.keys(real.icons.items).sort(), Object.keys(manifest.icons.items).sort(), "every icon reaches the page");
for (const c of Object.values(real.cursors)) assert.ok(c.src.startsWith("data:image/png;base64,") && Number.isInteger(c.x) && Number.isInteger(c.y), "cursors carry their hotspot");
assert.ok(real.cat.idle.frames === 10 && real.cat.idle.fps > 0 && real.cat.dance.frames === 25, "animations carry frame count and fps");
assert.ok(real.credits.length >= 4, "credits travel with the art");
const script = spritesScript();
assert.ok(!/<\/script/i.test(script) && !/<script/i.test(script), "the data cannot close its own <script>");
assert.strictEqual(script, spritesScript(), "same input, same output");
assert.ok(script.length < 600_000, `sprite script is ${script.length} bytes`);
console.log("[ok] the shipped sprites validate, all reach the page, carry hotspots/fps/credits, and cannot close their script tag");

// --- a wrong sprite is caught, each way
const mutations = {
  "a missing file": [(d) => rmSync(join(d, "cat/idle.png")), /cat\.idle.*missing/],
  "a wrong frame count": [(d) => edit(d, (m) => { m.cat.idle.frames = 11; }), /cat\.idle.*11 frame/],
  "a hotspot outside the image": [(d) => edit(d, (m) => { m.cursors.default.x = m.cursors.default.w; }), /cursors\.default.*hotspot/],
  "an animation with no fps": [(d) => edit(d, (m) => { m.cat.dance.fps = 0; }), /cat\.dance.*fps/],
  "a cursor over the browser's limit": [(d) => edit(d, (m) => { m.cursors.default.w = 200; }), /cursors\.default/],
  "a file that is not a PNG": [(d) => writeFileSync(join(d, "cat/hop.png"), "not a png at all, just some text"), /cat\.hop.*not a PNG/],
  "an icon of the wrong size": [(d) => edit(d, (m) => { m.icons.size = 20; }), /icons\.planner.*expected 20x20/],
  "a manifest with no credits": [(d) => edit(d, (m) => { m.credits = []; }), /credits missing/],
  "a path outside the asset folder": [(d) => edit(d, (m) => { m.cat.idle.file = "../../../../etc/hostname.png"; }), /cat\.idle.*outside the asset folder/],
  "an absolute path": [(d) => edit(d, (m) => { m.cat.idle.file = "/etc/passwd"; }), /cat\.idle/],
  "sprites that outgrow the budget": [(d) => appendFileSync(join(d, "cat/dance.png"), Buffer.alloc(450_000)), /limit is 400000/],
};
for (const [what, [mutate, expect]] of Object.entries(mutations)) {
  const d = copy();
  mutate(d);
  const problems = validateSprites(d);
  assert.ok(problems.some((p) => expect.test(p)), `${what} should be reported; got ${JSON.stringify(problems)}`);
  rmSync(d, { recursive: true, force: true });
}
console.log(`[ok] ${Object.keys(mutations).length} kinds of wrong sprite are each reported`);

// --- a bad manifest can never break the page or read outside the folder
{
  const outside = mkdtempSync(join(tmpdir(), "agent-loop-outside-"));
  const secret = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.alloc(8), Buffer.from("TOP-SECRET-MARKER")]);
  writeFileSync(join(outside, "x.png"), secret);
  const d = copy();
  const rel = "../".repeat(10) + outside.replace(/^\//, "") + "/x.png";
  edit(d, (m) => { m.cat.idle.file = rel; });
  const out = spritesScript(d);
  assert.ok(!Buffer.from(out).toString().includes(Buffer.from("TOP-SECRET-MARKER").toString("base64").slice(0, 12)), "a ../ path in the manifest is never read");
  const parsed = parse(out);
  assert.ok(!parsed.cat.idle && parsed.cat.dance, "only the bad entry is dropped; the rest still load");
  rmSync(d, { recursive: true, force: true });

  const broken = copy();
  writeFileSync(join(broken, "manifest.json"), "{ this is not json");
  assert.strictEqual(spritesScript(broken), "window.__SPRITES__ = {};", "an unreadable manifest yields an empty set, not an exception");
  assert.ok(validateSprites(broken)[0].startsWith("manifest.json unreadable"));
  const none = mkdtempSync(join(tmpdir(), "agent-loop-empty-"));
  assert.strictEqual(spritesScript(none), "window.__SPRITES__ = {};", "a missing asset folder is survivable too");
  rmSync(broken, { recursive: true, force: true }); rmSync(none, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
}
console.log("[ok] a ../ path is never read, one bad entry drops only itself, an unreadable manifest or missing folder yields an empty set");

// --- the live server serves the same art, with no token (nothing from any run is in it)
{
  const bus = new EventBus();
  const srv = await startServer(bus, 0);
  const base = srv.url.replace(/#.*$/, "");
  const res = await fetch(base + "sprite-data.js");
  assert.strictEqual(res.status, 200);
  assert.ok((res.headers.get("content-type") ?? "").startsWith("text/javascript"));
  assert.strictEqual(await res.text(), spritesScript(), "the server and a saved report get identical sprites");
  const png = await fetch(base + "assets/cat/idle.png");
  assert.strictEqual(png.headers.get("content-type"), "image/png");
  assert.strictEqual((await fetch(base + "assets/%2e%2e/package.json")).status === 200, false, "the static route cannot climb out of ui/");
  await srv.close();
}
console.log("[ok] /sprite-data.js serves the same script a report inlines, PNGs are typed, the static route cannot climb out");
console.log("\nALL SPRITE TESTS PASSED");
