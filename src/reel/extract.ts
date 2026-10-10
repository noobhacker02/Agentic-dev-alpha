// Step 3 of the reel flow: what a video file holds, read by ffmpeg inside the limits of threats R9 and R10. ffprobe and ffmpeg run as subprocesses with an argument list (no shell), `-protocol_whitelist file` (a playlist that points at
// http:// is refused before any request is made), `-nostdin`, a time limit and a bounded output. A file that is too long, too big, too wide or not a video is refused with a reason; a corrupt one is an error, not a crash.
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const LIMITS = { maxSeconds: 180, maxBytes: 200 * 1024 * 1024, maxSide: 4096, maxFrames: 12, timeoutMs: 60_000 } as const;

/** Containers a phone or an app produces. Not hls, concat, sdp, image2 or any demuxer that names other files. */
const CONTAINERS = new Set(["mov", "mp4", "m4a", "3gp", "3g2", "mj2", "matroska", "webm", "avi", "gif", "mpegts", "flv", "ogg"]);

export interface Probe { seconds: number; width: number; height: number; bytes: number; hasAudio: boolean }
export type ProbeResult = { ok: true; probe: Probe } | { ok: false; reason: string };

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", LC_ALL: "C" } });
    let out = "", err = "", timedOut = false;
    const cap = 2_000_000;
    child.stdout.on("data", (d) => { if (out.length < cap) out += d; });
    child.stderr.on("data", (d) => { if (err.length < cap) err += d; });
    const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(t); resolve({ code: null, out, err: String(e.message), timedOut }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out, err, timedOut }); });
  });
}

export async function probeVideo(file: string, limits = LIMITS): Promise<ProbeResult> {
  let st;
  try { st = lstatSync(file); } catch { return { ok: false, reason: "that file is not there" }; }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: "that is not a regular file (a link or a directory is not read)" };
  if (st.size > limits.maxBytes) return { ok: false, reason: `the file is ${(st.size / 1e6).toFixed(0)} MB; the limit is ${(limits.maxBytes / 1e6).toFixed(0)} MB` };
  if (st.size === 0) return { ok: false, reason: "the file is empty" };
  const r = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-print_format", "json", "-show_format", "-show_streams", file], limits.timeoutMs);
  if (r.timedOut) return { ok: false, reason: "reading the file took too long and was stopped" };
  if (r.code !== 0) return { ok: false, reason: /protocol not on whitelist|not on whitelist/i.test(r.err) ? "the file refers to something outside itself (a playlist); only a plain video file is read" : "that does not look like a video file (or it is damaged)" };
  let j: any;
  try { j = JSON.parse(r.out); } catch { return { ok: false, reason: "that does not look like a video file" }; }
  // only a plain media container is read: a playlist (hls), a concat list, an sdp or an image sequence opens other files and takes its length from its own text (A144)
  const fmt = String(j.format?.format_name ?? "").split(",");
  if (!fmt.some((f) => CONTAINERS.has(f))) return { ok: false, reason: `that is not a plain video container (${fmt.join(",").slice(0, 40) || "unknown"}); playlists and lists of other files are not read` };
  const videos = (j.streams ?? []).filter((s: any) => s.codec_type === "video");
  const v = videos[0];
  if (!v) return { ok: false, reason: "the file has no video in it" };
  // every video stream is held to the limits, not only the first: the decoder takes the largest (A143)
  if (videos.length > 1) return { ok: false, reason: "the file has more than one picture stream; only a plain single-picture video is read" };
  const seconds = Number(j.format?.duration ?? v.duration ?? 0);
  const width = Number(v.width ?? 0), height = Number(v.height ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return { ok: false, reason: "the file has no usable length" };
  if (seconds > limits.maxSeconds) return { ok: false, reason: `the video is ${Math.round(seconds)} s; the limit is ${limits.maxSeconds} s` };
  if (!(width > 0 && height > 0) || width > limits.maxSide || height > limits.maxSide) return { ok: false, reason: `the picture is ${width}x${height}; the limit is ${limits.maxSide} pixels on a side` };
  return { ok: true, probe: { seconds, width, height, bytes: st.size, hasAudio: (j.streams ?? []).some((s: any) => s.codec_type === "audio") } };
}

export type FramesResult = { ok: true; frames: string[] } | { ok: false; reason: string };

/** Up to 12 frames: scene changes first, evenly spaced if the video has none. Written under `dir` (0700), which the caller keeps outside the repository. */
export async function extractFrames(file: string, dir: string, probe: Probe, limits = LIMITS): Promise<FramesResult> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* not a filesystem with modes */ }
  const base = ["-nostdin", "-v", "error", "-protocol_whitelist", "file", "-i", file, "-map", "0:v:0", "-threads", "2"];
  const scene = await run("ffmpeg", [...base, "-vf", "select='gt(scene,0.3)',scale='min(640,iw)':-2", "-vsync", "vfr", "-frames:v", String(limits.maxFrames), "-y", join(dir, "scene-%02d.jpg")], limits.timeoutMs);
  if (scene.timedOut) return { ok: false, reason: "reading the frames took too long and was stopped" };
  let frames = readdirSync(dir).filter((f) => /^scene-\d+\.jpg$/.test(f)).sort();
  if (frames.length < 3) {
    // too few scene changes (a talking head, a screen recording): evenly spaced frames instead
    const fps = Math.max(0.05, Math.min(2, (limits.maxFrames - 1) / Math.max(1, probe.seconds)));
    const even = await run("ffmpeg", [...base, "-vf", `fps=${fps.toFixed(4)},scale='min(640,iw)':-2`, "-frames:v", String(limits.maxFrames), "-y", join(dir, "even-%02d.jpg")], limits.timeoutMs);
    if (even.timedOut) return { ok: false, reason: "reading the frames took too long and was stopped" };
    frames = readdirSync(dir).filter((f) => /^(scene|even)-\d+\.jpg$/.test(f)).sort();
  }
  if (!frames.length) return { ok: false, reason: "no picture could be read from that file" };
  return { ok: true, frames: frames.slice(0, limits.maxFrames).map((f) => join(dir, f)) };
}
