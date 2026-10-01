import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The UI's pixel sprites (cat, cursors, icons, dino): small PNGs under ui/assets/ described by manifest.json.
 * The page gets them as one inline script of data URIs (window.__SPRITES__), so a live page and a saved
 * report.html carry identical sprites and neither needs the network. Nothing here reads a run: it is art only.
 *
 * To change a sprite: replace the PNG, fix its entry in manifest.json, run `npm run check:sprites`.
 * A missing or broken sprite never breaks the page: the entry is skipped and the page draws a plain glyph instead.
 */
export const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "assets");

/** The most the sprites may weigh in total; they ride inside every saved report. */
export const MAX_SPRITE_BYTES = 400_000;
/** Browsers refuse a cursor image over 128px. */
const MAX_CURSOR_PX = 128;

interface Img { file: string; w?: number; h?: number; frames?: number }

/** PNG width/height from the IHDR chunk, or null when the bytes are not a PNG. */
function pngSize(buf: Buffer): { w: number; h: number } | null {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig) || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** A manifest path as a safe file under the asset dir: relative, no `..`, a .png. Anything else is refused. */
function resolveAsset(dir: string, file: unknown): string | null {
  if (typeof file !== "string" || !file || isAbsolute(file) || !/\.png$/i.test(file)) return null;
  const clean = normalize(file);
  if (clean.startsWith("..") || clean.split(sep).includes("..")) return null;
  return join(dir, clean);
}

function readManifest(dir: string): any {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
}

interface Loaded { buf: Buffer; size: { w: number; h: number } }
function loadPng(dir: string, file: unknown): Loaded | null {
  const path = resolveAsset(dir, file);
  if (!path) return null;
  try {
    const buf = readFileSync(path);
    const size = pngSize(buf);
    return size ? { buf, size } : null;
  } catch {
    return null;
  }
}

/** Everything wrong with the sprite set, one line each; empty when it is sound. Used by the test and `npm run check:sprites`. */
export function validateSprites(dir: string = ASSET_DIR): string[] {
  const problems: string[] = [];
  let m: any;
  try { m = readManifest(dir); } catch (e) { return [`manifest.json unreadable: ${(e as Error).message}`]; }
  if (m?.version !== 1) problems.push("manifest.json: version must be 1");
  if (!Array.isArray(m?.credits) || !m.credits.length) problems.push("manifest.json: credits missing (every sprite needs its source named)");
  let total = 0;
  const check = (label: string, e: Img & Record<string, any>, kind: "strip" | "single" | "any") => {
    const png = loadPng(dir, e?.file);
    if (!png) { problems.push(`${label}: ${JSON.stringify(e?.file)} is missing, outside the asset folder, or not a PNG`); return; }
    total += png.buf.length;
    const { w, h } = png.size;
    if (kind === "any") return;
    const frames = e.frames ?? 1;
    if (!Number.isInteger(frames) || frames < 1) problems.push(`${label}: frames must be a positive integer`);
    else if (e.w !== undefined && e.h !== undefined && (w !== e.w * frames || h !== e.h)) {
      problems.push(`${label}: file is ${w}x${h} but the manifest says ${frames} frame(s) of ${e.w}x${e.h}`);
    }
    if (kind === "strip" && frames > 1 && !(Number(e.fps) > 0)) problems.push(`${label}: an animation needs fps > 0`);
  };
  for (const [name, e] of Object.entries<any>(m?.cat ?? {})) check(`cat.${name}`, e, "strip");
  for (const [name, e] of Object.entries<any>(m?.dino ?? {})) {
    if (e?.glyphs) {
      check(`dino.${name}`, { file: e.file, w: e.w, h: e.h }, "single");
      for (const [g, [x, gw]] of Object.entries<any>(e.glyphs)) if (x + gw > e.w) problems.push(`dino.${name}.${g}: glyph runs past the image`);
    } else check(`dino.${name}`, { ...e, frames: e.frames ?? 1 }, e.fps ? "strip" : "single");
  }
  for (const [name, e] of Object.entries<any>(m?.cursors ?? {})) {
    check(`cursors.${name}`, { file: e?.file, w: e?.w, h: e?.h }, "single");
    if (!(e?.w <= MAX_CURSOR_PX && e?.h <= MAX_CURSOR_PX)) problems.push(`cursors.${name}: browsers refuse a cursor over ${MAX_CURSOR_PX}px`);
    if (!(Number.isInteger(e?.x) && Number.isInteger(e?.y) && e.x >= 0 && e.y >= 0 && e.x < e.w && e.y < e.h)) problems.push(`cursors.${name}: hotspot (${e?.x}, ${e?.y}) is not inside the ${e?.w}x${e?.h} image`);
  }
  const ic = m?.icons ?? {};
  for (const [name, e] of Object.entries<any>(ic.items ?? {})) {
    const big = loadPng(dir, e?.file);
    if (name !== "heart" && big && (big.size.w !== ic.size || big.size.h !== ic.size)) problems.push(`icons.${name}: expected ${ic.size}x${ic.size}`);
    check(`icons.${name}`, { file: e?.file }, "any");
    if (e?.small) {
      const s = loadPng(dir, e.small);
      if (!s) problems.push(`icons.${name}.small: missing or not a PNG`);
      else { total += s.buf.length; if (s.size.w !== ic.small || s.size.h !== ic.small) problems.push(`icons.${name}.small: expected ${ic.small}x${ic.small}`); }
    }
  }
  if (total > MAX_SPRITE_BYTES) problems.push(`sprites weigh ${total} bytes; the limit is ${MAX_SPRITE_BYTES} (they are embedded in every saved report)`);
  return problems;
}

const dataUri = (b: Buffer) => "data:image/png;base64," + b.toString("base64");

/**
 * `window.__SPRITES__ = {...}`: the manifest with every file replaced by a data URI. Never throws: a manifest
 * that cannot be read yields an empty set (the page then draws plain glyphs), and a single bad entry is skipped.
 */
export function spritesScript(dir: string = ASSET_DIR): string {
  let out: Record<string, unknown> = {};
  try {
    const m = readManifest(dir);
    const section = (src: Record<string, any> | undefined, extra: (e: any) => Record<string, unknown> = () => ({})) => {
      const o: Record<string, unknown> = {};
      for (const [name, e] of Object.entries(src ?? {})) {
        const png = loadPng(dir, e?.file);
        if (!png) continue;
        const { file: _f, ...rest } = e;
        o[name] = { ...rest, src: dataUri(png.buf), ...extra(e) };
      }
      return o;
    };
    const items: Record<string, unknown> = {};
    for (const [name, e] of Object.entries<any>(m?.icons?.items ?? {})) {
      const big = loadPng(dir, e?.file);
      if (!big) continue;
      const small = loadPng(dir, e?.small);
      items[name] = { src: dataUri(big.buf), ...(small ? { small: dataUri(small.buf) } : {}) };
    }
    out = {
      cat: section(m?.cat),
      cursors: section(m?.cursors),
      dino: section(m?.dino),
      icons: { size: m?.icons?.size, small: m?.icons?.small, items },
      credits: Array.isArray(m?.credits) ? m.credits : [],
    };
  } catch {
    out = {};
  }
  // "<" escaped so nothing in the data can close the <script> element early.
  return `window.__SPRITES__ = ${JSON.stringify(out).replace(/</g, "\\u003c")};`;
}
