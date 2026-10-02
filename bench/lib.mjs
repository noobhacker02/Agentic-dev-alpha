// Shared helpers for the benchmark runner. No dependencies beyond Node.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(BENCH_DIR, "..");

export function gitShort(cwd = ROOT) {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" }).trim(); } catch { return "unknown"; }
}
export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}
/** Like readJson, but a file that exists and does not parse is an error, never an empty default: a corrupt baseline must not be silently re-recorded. */
export function readJsonStrict(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`${file} exists but is not valid JSON (${e.message}); refusing to continue and overwrite it`); }
}
export function writeJson(file, value) { writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); }
export function exists(p) { return existsSync(p); }
