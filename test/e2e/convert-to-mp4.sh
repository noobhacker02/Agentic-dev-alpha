#!/usr/bin/env bash
# Converts a Playwright-recorded .webm (e.g. record-run.mjs's run.webm, or a real --browser run's
# session recording) to .mp4 for docs/sharing: WebM playback outside Chromium-based browsers and VLC
# is inconsistent, MP4 is universal. Playwright's own bundled ffmpeg has no H.264 encoder or MP4
# muxer at all (VP8/WebM only), so this needs a full ffmpeg install (`apt-get install ffmpeg` /
# `brew install ffmpeg`), not the sandboxed one under PLAYWRIGHT_BROWSERS_PATH.
#
#   test/e2e/convert-to-mp4.sh <input.webm> [output.mp4]
#
# Existed only as one-off manual ffmpeg commands the first time this was needed (converting
# docs/media/*.webm); written down here so the next demo recording doesn't require re-deriving them.
set -euo pipefail

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found. Install a real build (not Playwright's bundled one, which has no H.264" >&2
  echo "encoder or MP4 muxer): apt-get install ffmpeg / brew install ffmpeg / choco install ffmpeg." >&2
  exit 1
fi

in="${1:?usage: convert-to-mp4.sh <input.webm> [output.mp4]}"
out="${2:-${in%.webm}.mp4}"

# -pix_fmt yuv420p: some players (older Safari/QuickTime, some Windows players) can't handle the
# yuv444p/yuv422p that a VP8/VP9 source sometimes carries. -movflags +faststart: moves the moov atom
# to the front so a linked file starts playing before it's fully downloaded, which matters for a
# docs page rather than a local file. -crf 20 -preset medium: visually near-lossless at a
# reasonable file size/encode-time tradeoff for short UI-demo clips, not tuned for anything longer.
ffmpeg -y -i "$in" -c:v libx264 -pix_fmt yuv420p -crf 20 -preset medium -c:a aac -movflags +faststart "$out"
echo "wrote $out"
