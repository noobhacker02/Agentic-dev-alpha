#!/usr/bin/env bash
# Turns a moment of each walkthrough video into a small looping GIF in docs/media/previews/, because GitHub
# shows a GIF inline in a README while an .mp4 needs a click-through. Each preview is the part of the video
# that shows the feature doing its thing (start second, length), not the opening.
#
#   bash test/e2e/make-previews.sh            (needs a full ffmpeg)
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p docs/media/previews
gif() { # name start length fps width
  ffmpeg -y -loglevel error -ss "$2" -t "$3" -i "docs/media/$1.mp4" \
    -vf "fps=$4,scale=$5:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
    "docs/media/previews/$1.gif"
  echo "docs/media/previews/$1.gif ($(du -h "docs/media/previews/$1.gif" | cut -f1))"
}
gif lineage-tree 29 13 7 720          # the run as a tree: the fork, the repair, what each agent handed on
gif persona-voice 24 14 7 720         # a veto and the agent sent back replying, an approval prompt with no jokes
gif desktop-agent-ui 9 14 7 720       # the approval prompt: the exact click on the window as captured
gif desktop-real-window 8 18 7 720    # a real window: what the agent sees, clicks landing, a terminal refused
gif ui-v3-tour 20 17 8 720            # the cat runs to the waiting prompt, hops, and goes home when answered
gif offline-dino 6 16 8 720           # the offline dialog and a bot playing the dinosaur
