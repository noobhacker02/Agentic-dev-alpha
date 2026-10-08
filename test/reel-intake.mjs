// Reel flow steps 1 and 3 (docs/REEL-FLOW.md; threats R9, R10, R12): a link reduces to host + shortcode (igsh and every other parameter gone), only Instagram links are accepted, and a video file is probed and cut into frames inside limits
// (too long, too wide, a symlink, a playlist that points at a URL, a file that is not a video are each refused with a reason). Needs ffmpeg/ffprobe; skips with a note when they are not installed.
//   npm run build && npm run test:reel-intake
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalReelUrl, contentKey } from "../dist/reel/intake.js";
import { probeVideo, extractFrames, LIMITS } from "../dist/reel/extract.js";

// 1. links
{
  const a = canonicalReelUrl("https://www.instagram.com/reel/Cx12_abCD34/?igsh=MWxx&utm_source=ig_web");
  assert.ok(a.ok && a.canonical === "https://www.instagram.com/reel/Cx12_abCD34/" && a.key === "ig:Cx12_abCD34", JSON.stringify(a));
  assert.ok(!a.canonical.includes("igsh") && !a.canonical.includes("utm"));
  // same reel, other shapes, one key
  for (const u of ["https://instagram.com/reels/Cx12_abCD34", "https://m.instagram.com/someone/reel/Cx12_abCD34/?igsh=zzz", "http://www.instagram.com/p/Cx12_abCD34/#frag", "  https://instagr.am/reel/Cx12_abCD34/  "]) {
    const r = canonicalReelUrl(u); assert.ok(r.ok && r.key === a.key, u + " " + JSON.stringify(r));
  }
  // refusals, each with a reason
  for (const [u, why] of [["not a url", /not a link/], ["ftp://www.instagram.com/reel/Cx12_abCD34/", /http/], ["https://evil.example/reel/Cx12_abCD34/", /Instagram/], ["https://www.instagram.com.evil.example/reel/Cx12_abCD34/", /Instagram/],
    ["https://user:pw@www.instagram.com/reel/Cx12_abCD34/", /password/], // devskill:allow (a fake credential in a link, to prove it is refused)
    ["https://www.instagram.com:8443/reel/Cx12_abCD34/", /port/], ["https://www.instagram.com/reel/", /code/], ["https://www.instagram.com/reel/a/", /code/], ["https://www.instagram.com/explore/", /code/]]) {
    const r = canonicalReelUrl(u); assert.ok(!r.ok && why.test(r.reason), u + " " + JSON.stringify(r));
  }
  assert.equal(contentKey("text", "hello"), contentKey("text", "hello"));
  assert.notEqual(contentKey("text", "hello"), contentKey("text", "hellO"));
  assert.notEqual(contentKey("text", "hello"), contentKey("file", "hello"));
  console.log("  links ok");
}

// 2. video files
const have = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
if (!have) { console.log("reel-intake: ffmpeg not installed; file checks skipped"); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), "reel-"));
const mk = (name, args) => { const f = join(dir, name); const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args, f]); assert.equal(r.status, 0, String(r.stderr)); return f; };
const short = mk("short.mp4", ["-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=10", "-f", "lavfi", "-i", "sine=duration=4", "-shortest", "-pix_fmt", "yuv420p"]);
{
  const p = await probeVideo(short);
  assert.ok(p.ok && p.probe.seconds > 3 && p.probe.seconds < 5 && p.probe.width === 320 && p.probe.hasAudio, JSON.stringify(p));
  const out = join(dir, "frames");
  const f = await extractFrames(short, out, p.probe);
  assert.ok(f.ok && f.frames.length >= 1 && f.frames.length <= LIMITS.maxFrames, JSON.stringify(f));
  for (const x of f.frames) assert.ok(statSync(x).size > 0 && x.startsWith(out));
  assert.equal(statSync(out).mode & 0o077, 0, "frames directory is private");
  console.log("  probe + frames ok:", f.frames.length, "frames");
}
{
  const tiny = { ...LIMITS, maxSeconds: 2 };
  const r = await probeVideo(short, tiny); assert.ok(!r.ok && /limit is 2 s/.test(r.reason), JSON.stringify(r));
  const r2 = await probeVideo(short, { ...LIMITS, maxSide: 100 }); assert.ok(!r2.ok && /pixels on a side/.test(r2.reason), JSON.stringify(r2));
  const r3 = await probeVideo(short, { ...LIMITS, maxBytes: 100 }); assert.ok(!r3.ok && /MB/.test(r3.reason), JSON.stringify(r3));
  const txt = join(dir, "notvideo.mp4"); writeFileSync(txt, "this is just text, not a video\n");
  const r4 = await probeVideo(txt); assert.ok(!r4.ok && /video/.test(r4.reason), JSON.stringify(r4));
  const empty = join(dir, "empty.mp4"); writeFileSync(empty, "");
  const r5 = await probeVideo(empty); assert.ok(!r5.ok && /empty/.test(r5.reason), JSON.stringify(r5));
  const link = join(dir, "link.mp4"); symlinkSync(short, link);
  const r6 = await probeVideo(link); assert.ok(!r6.ok && /regular file/.test(r6.reason), JSON.stringify(r6));
  const r7 = await probeVideo(join(dir, "nope.mp4")); assert.ok(!r7.ok && /not there/.test(r7.reason), JSON.stringify(r7));
  // R9: a playlist that points at a URL must not make a request. Listen locally and prove nothing connects.
  // Mutation note: removing `-protocol_whitelist file` from src/reel/extract.js does NOT fail this test on ffmpeg 6.1, because the hls demuxer already refuses network segments for a local playlist. The flag is defense in depth
  // (older or differently built ffmpeg); this test pins the observable behaviour (0 requests), not the flag.
  const { createServer } = await import("node:http");
  let hits = 0;
  const srv = createServer((q, s) => { hits++; s.end(); }); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const pl = join(dir, "evil.m3u8"); writeFileSync(pl, `#EXTM3U\n#EXTINF:1,\nhttp://127.0.0.1:${srv.address().port}/x.ts\n#EXT-X-ENDLIST\n`);
  const r8 = await probeVideo(pl); assert.ok(!r8.ok, JSON.stringify(r8));
  const fr = await extractFrames(pl, join(dir, "evil-frames"), { seconds: 1, width: 1, height: 1, bytes: 1, hasAudio: false });
  assert.ok(!fr.ok, JSON.stringify(fr));
  await new Promise((r) => srv.close(r));
  assert.equal(hits, 0, "a playlist reached out to the network");
  assert.ok(readdirSync(join(dir, "evil-frames")).length === 0);
  console.log("  refusals ok (R9: 0 requests from a playlist)");
}
console.log("reel-intake: all passed");
