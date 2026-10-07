// Files the agent may attach to a web form (docs/HYBRID-AGENT-SPEC.md S2; threats B7 "uploading the wrong file", B12 "the résumé goes somewhere other than the employer"). The model never names a path: it names a file the
// user designated in `<home>/uploads.json` (their own agent-loop directory, never the project, so the project cannot designate anything). A designated file is a regular file, not a link, of a document or image
// type, within a size limit, not inside the agent-loop directory (which holds the profiles), and the same file it was when the session started (its real path is pinned; an optional SHA-256 pins its content).
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";
import { readUserJson } from "./allowances.js";
import { realOrResolved, within } from "./profile.js";
import { stripTerminalControlBytes } from "./text-safety.js";

/** What a person attaches to an application. No script, archive, key or database type is on it. */
export const UPLOAD_EXTENSIONS: readonly string[] = ["pdf", "doc", "docx", "rtf", "txt", "odt", "png", "jpg", "jpeg"];
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const HARD_MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 20;
const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;

export interface UploadFile {
  /** What the model calls it: lower-case letters, digits and hyphens ("resume", "cover-letter"). */
  name: string;
  /** Absolute path, as the user wrote it. */
  path: string;
  maxBytes: number;
  /** Lower-case hex SHA-256 of the content, if the user pinned it. */
  sha256?: string;
  /** The real path when the file was loaded; an upload is refused if it is somewhere else by then. */
  canonical?: string;
}

export interface Uploads {
  files: UploadFile[];
}

export const NO_UPLOADS: Uploads = { files: [] };

const clean = (s: string, n = 80): string => stripTerminalControlBytes(s).replace(/[^\x20-\x7e]/g, "?").slice(0, n);

export type ParsedUploads = { ok: true; value: Uploads } | { ok: false; errors: string[] };

/** Checks the shape of `uploads.json`. Unknown keys are refused (a misspelt "sha256" must not silently mean "unpinned"). `home` is the agent-loop directory; nothing inside it may be designated. */
export function parseUploads(raw: unknown, opts: { home?: string } = {}): ParsedUploads {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ['the file must be a JSON object like {"files": {"resume": "/home/you/documents/resume.pdf"}}'] };
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (k !== "files") errors.push(`unknown key "${clean(k, 40)}" (only "files" is allowed)`);
  const files = obj.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return { ok: false, errors: [...errors, '"files" must be an object of name: path'] };
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length > MAX_FILES) errors.push(`"files" has ${entries.length} entries; the limit is ${MAX_FILES}`);
  const out: UploadFile[] = [];
  const realHome = opts.home ? realOrResolved(opts.home) : undefined;
  for (const [name, spec] of entries.slice(0, MAX_FILES)) {
    const where = `files.${clean(name, 40)}`;
    if (!NAME_RE.test(name)) { errors.push(`${where}: a name is lower-case letters, digits and hyphens, starting with a letter (at most 31)`); continue; }
    let path: unknown = spec, sha256: unknown, maxBytes: unknown;
    if (spec && typeof spec === "object" && !Array.isArray(spec)) {
      const o = spec as Record<string, unknown>;
      for (const k of Object.keys(o)) if (!["path", "sha256", "maxBytes"].includes(k)) errors.push(`${where}: unknown key "${clean(k, 40)}"`);
      path = o.path; sha256 = o.sha256; maxBytes = o.maxBytes;
    }
    if (typeof path !== "string" || !path) { errors.push(`${where}: the path must be a text`); continue; }
    if (path.length > 1024 || /[\u0000-\u001f\u007f]/.test(path)) { errors.push(`${where}: the path is too long or holds a control character`); continue; }
    if (!isAbsolute(path)) { errors.push(`${where}: the path must be absolute (a relative path would mean whatever directory the agent is in)`); continue; }
    if (/[./\\ ]$/.test(path)) { errors.push(`${where}: the path must name a file (it ends in a dot, a space or a separator)`); continue; }
    const ext = extname(path).slice(1).toLowerCase();
    if (!UPLOAD_EXTENSIONS.includes(ext)) { errors.push(`${where}: only ${UPLOAD_EXTENSIONS.join(", ")} files can be designated (this one is ".${clean(ext, 12)}")`); continue; }
    if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256))) { errors.push(`${where}: sha256 must be 64 hexadecimal characters`); continue; }
    if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || (maxBytes as number) < 1 || (maxBytes as number) > HARD_MAX_BYTES)) { errors.push(`${where}: maxBytes must be a whole number from 1 to ${HARD_MAX_BYTES}`); continue; }
    if (realHome && within(realHome, realOrResolved(path))) { errors.push(`${where}: that file is inside the agent-loop directory, which holds the saved sign-ins; designate a file somewhere else`); continue; }
    let canonical: string | undefined;
    try { canonical = lstatSync(path).isSymbolicLink() ? undefined : realpathSync(path); } catch { /* not there yet: checked when it is used */ }
    out.push({ name, path, maxBytes: (maxBytes as number | undefined) ?? DEFAULT_MAX_BYTES, ...(sha256 ? { sha256: (sha256 as string).toLowerCase() } : {}), ...(canonical ? { canonical } : {}) });
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { files: out } };
}


export type LoadedUploads = { ok: true; value: Uploads; source: "none" | "file"; path: string } | { ok: false; errors: string[] };

/** Reads `<home>/uploads.json`. No file means nothing may be uploaded. */
export function loadUploads(home: string, opts: { uid?: number } = {}): LoadedUploads {
  const read = readUserJson(home, "uploads.json", opts);
  if (!read.ok) return { ok: false, errors: read.errors };
  if (read.missing) return { ok: true, value: NO_UPLOADS, source: "none", path: read.path };
  const parsed = parseUploads(read.json, { home });
  const shown = clean(read.path, 200);
  return parsed.ok ? { ok: true, value: parsed.value, source: "file", path: read.path } : { ok: false, errors: parsed.errors.map((e) => `${shown}: ${e}`) };
}

export type ResolvedUpload = { ok: true; name: string; path: string; fileName: string; bytes: number } | { ok: false; error: string };

/**
 * Turns the name the model gave into a file that may be attached right now, or says why not. The answer never contains the directory: the model is told the name and the file's own name, nothing about where the user keeps it.
 * Everything is checked again at the moment of use, because the file is the user's and anything on this computer may have touched it since the session started.
 */
export function resolveUpload(uploads: Uploads, name: unknown): ResolvedUpload {
  if (!uploads.files.length) return { ok: false, error: "no files are designated for upload; the user lists them in uploads.json in their agent-loop directory" };
  const known = uploads.files.map((f) => f.name);
  if (typeof name !== "string" || !uploads.files.some((f) => f.name === name)) {
    const looksLikePath = typeof name === "string" && /[/\\.:~]/.test(name);
    // A path is not echoed back: it is the model's own text, and it may be somebody else's (a page told it to).
    return { ok: false, error: looksLikePath ? `pass the NAME of a designated file, never a path. Designated names: ${known.join(", ")}` : `"${clean(String(name), 60)}" is not a designated file. Designated names: ${known.join(", ")}` };
  }
  const file = uploads.files.find((f) => f.name === name)!;
  const refuse = (why: string): ResolvedUpload => ({ ok: false, error: `the file for "${file.name}" ${why}` });
  let st;
  try {
    st = lstatSync(file.path);
  } catch (err) {
    return refuse((err as NodeJS.ErrnoException).code === "ENOENT" ? "is missing" : `cannot be read (${clean(String((err as NodeJS.ErrnoException).code ?? "error"), 20)})`);
  }
  if (st.isSymbolicLink()) return refuse("is a link, so it could lead anywhere; the user must designate the real file");
  if (!st.isFile()) return refuse("is not a regular file");
  if (st.size === 0) return refuse("is empty");
  if (st.size > file.maxBytes) return refuse(`is too large (${st.size} bytes; the limit is ${file.maxBytes})`);
  if (!UPLOAD_EXTENSIONS.includes(extname(file.path).slice(1).toLowerCase())) return refuse("is not a document or image type");
  let real: string;
  try { real = realpathSync(file.path); } catch { return refuse("cannot be read"); }
  if (file.canonical !== undefined && real !== file.canonical) return refuse("is not where it was when the session started, so it is refused");
  if (file.sha256) {
    const sum = createHash("sha256").update(readFileSync(real)).digest("hex");
    if (sum !== file.sha256) return refuse("has changed since the user pinned its SHA-256, so it is refused");
  }
  return { ok: true, name: file.name, path: real, fileName: basename(real), bytes: st.size };
}
