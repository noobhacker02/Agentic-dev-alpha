# The pixel set and the sound: what ships, where it came from, how to change it

The run UI has a cat, pixel mouse cursors, small icons, an offline dinosaur and optional sound. This page says what each
piece is, **what is and is not known about where it came from**, how it gets to the page, and how to swap any of it.

## What ships

All of it is under [`ui/assets/`](../ui/assets/): 74 small PNGs and a `manifest.json`, **about 50 KB in total** (the sum of the file sizes; `du` over-reports because it counts disk blocks). They travel as one inline data script of about 71 KB (base64), which a live page loads once and every saved `report.html` carries, so a report opens with no network.

| Piece | What | Used for |
|---|---|---|
| `cat/` | `idle` (10 frames), `dance` (25), `hop`, `charge` (an aura), `win` (2 frames of stars), `shadow` | The cat ([`ui/mascot.js`](../ui/mascot.js)) |
| `cursors/` | 18 cursors with their hotspots: arrow, pointing hand, text, grab, grabbing, crosshair, move, four resize arrows, magnifier, lock, shovel, hammer, two "not allowed" | The page's mouse cursor (switchable) |
| `icons/` | 21 icons at 17 px and again at 12 px, plus a heart | One per agent on the phase stepper, one per tool in the transcript, the lock on a permission prompt, the tab icon |
| `dino/` | stand, run (2 frames), dead, duck (2 frames), the score digits, `GAME OVER`, the restart arrow | The offline screen ([`ui/offline.js`](../ui/offline.js)) |

Sound is not an asset: it is generated in the browser (see [Sound](#sound)). There are no audio files.

## Where it came from

Read this before publishing the repository.

| Piece | Source | What is known |
|---|---|---|
| Icons | The Craftpix free GUI-icon pack (`Gui_icons2.psd`), <https://craftpix.net/freebies/>; licence page <https://craftpix.net/file-licenses/> | Only the 22 icons the page uses are committed, cut from the pack. **The PSD itself is not committed.** The pack's licence text was not read for this project (the pack contains only a link to it). Second-hand, from a search and not from the licence itself: Craftpix freebies are described as free for personal and commercial use, with **re-distributing the original files on their own prohibited**. Cut-up icons inside a product are probably the permitted case; loose PNGs in a public repository are closer to the prohibited one. Confirm on <https://craftpix.net/file-licenses/> before publishing. |
| Cat | A sprite sheet supplied by the project owner | The sheet carries **no artist credit and no licence**, so this repository cannot state its terms. |
| Cursors | A sprite sheet supplied by the project owner | Same: **no artist credit, no licence on the sheet.** |
| Dinosaur | Chrome's offline dinosaur, from a sheet whose credit line reads "ripped by madK, RealHeroicGamer, Resistiv, roomjaguarproductions, and DogToon64" | The artwork is Google's/Chromium's; the sheet credits the people who extracted it. Their terms apply and were not checked here. |

So: the cat and the cursors have unknown terms, and the dinosaur and icons have terms nobody here has checked. If this
repository is public, or you ship the UI, **confirm you may publish these or replace them** (below). Nothing else in the
page depends on them: the UI works with any piece, or all of it, missing, and that is tested.

The cautious options, in order of effort: (1) keep the repository private, or tell people the art is for personal use; (2) stop committing the loose icon PNGs and generate them at build time from a pack you hold yourself (`scripts/` already slices the sheets; only the PSD would have to come from you); (3) replace the icons, the cat and the cursors with art you own or art under a licence you have read (CC0 sets exist). Plain mode (`--plain`) already runs the whole product without any of it.

The same credits are in `manifest.json`, shown in the page (press `?`, "Credits"), and travel inside every saved report.

## How it gets to the page

```
your sheets ──scripts/build-sprites.py──▶ ui/assets/*.png + manifest.json
                                              │
                                    src/sprites.ts (data URIs)
                                              │
              live page: GET /sprite-data.js     saved report: inlined into report.html
```

The page never reads a sheet and never touches the network for art. A saved `report.html` carries the sprites inline, so it
opens from disk with no server (`test/report.mjs` checks it makes no network request at all).
`ui/sprites.js` turns the manifest into CSS (classes for icons and poses, a custom property per cursor, keyframes for each
animation strip). If the data is missing, every helper returns nothing and the page draws plain glyphs.

## Changing a sprite

1. Replace the PNG under `ui/assets/`.
2. Edit its entry in `manifest.json`: for a strip, `frames` and the size of **one** frame (`w`, `h`) and `fps`; for a
   cursor, its size and **hotspot** (`x`, `y`, the pixel that is "the point"); for an icon, it must be 17×17, with a 12×12
   `small` twin.
3. `npm run check:sprites`.

The check ([`src/sprites.ts`](../src/sprites.ts), `validateSprites`) fails on: a missing file, a path that leaves the asset
folder or is not a PNG, bytes that are not a PNG, a strip whose width is not `frames × w` (or whose height is not `h`),
an animation with no `fps`, a hotspot outside its image, a cursor over the 128 px browsers allow, an icon of the wrong size,
no credits, or a total over 400 KB (the sprites ride inside every saved report). `test/sprites.mjs` proves each of those is
reported, that a `../` path in the manifest is never read, and that one bad entry drops only itself.

**Regenerating from sheets.** `scripts/build-sprites.py` cuts the supplied sheets into `ui/assets/`:

```bash
pip install pillow numpy scipy psd-tools            # dev-time only; nothing here runs at runtime
python3 scripts/build-sprites.py --cat cat.png --cursors cursors.png --dino dino.png --dino-ui dino-ui.png \
    --psd Gui_icons2.psd --out ui/assets
```

It never resamples (every output pixel is a source pixel) and it asserts what it can: that each icon's 12 px twin looks like
the same drawing as its 17 px one (the PSD's layer *names* do not pair them reliably; the script pairs them by position and
checks the colours), that the score glyphs and `GAME OVER` letters are all found, and that frames are cut on the sheet's own grid.
The cat's poses are cut so the cat sits on one centre line and one floor in every pose (measured, then checked: within 2 px),
so changing pose never makes it jump sideways or sink.

## Cursors

The page uses the pixel cursors everywhere by default, each with the system cursor as its fallback. They can be turned off
in the help window (`?`) and that is remembered in the browser. Browsers refuse cursor images over 128 px, and may fall back
to the system cursor for images over 32 px when the pointer is at the very edge of the window; the largest here is 34 px.
Not tested on Firefox or Safari.

## The cat

One element on a fixed layer, moved by `transform` to wherever the layout says it should stand (measured from the live
`getBoundingClientRect`, so it follows scrolling, resizing and the prompt sliding in). It never reads run content: the only
words it shows are `<agent> needs you` (from the phase name), a few fixed lines, and what it says when you click it.

| State | Where it stands | What it does |
|---|---|---|
| nothing running | on the welcome card, then by the input box | sways |
| an agent working | by the input box | dances |
| **a permission prompt waiting** | **on the prompt's top edge, at its right corner** | **hops, says who needs you, nudges after 20 s, 1 min and 3 min** |
| run done | by the closing card, if it is on screen | stars |
| run failed | by the closing card | slumps |
| 90 s of quiet | where it is | naps; any mouse movement or key wakes it |

It covers at most 10 px of a prompt and never a button (measured in `test/ui-mascot.mjs`). Under `prefers-reduced-motion` it
still goes to the prompt that needs you and says so, but it does not slide, hop or animate frames. It can be switched off in
the help window; it stays off after a reload, and nothing brings it back.

## The offline dinosaur

When the page loses its connection to the run's server and the run was not already over, a dialog appears after 0.9 s (so a
blip never flashes it): "Can't reach agent-loop", a count of attempts, **Retry now**, and Chrome's dinosaur game. Space or
↑ jumps, ↓ ducks, a tap jumps; the best score is remembered. It leaves by itself when the server comes back (the run is
replayed), keeps exactly one socket open, and never appears for a finished run or a saved report. The game is drawn at 1×
on a 4:1 canvas like Chrome's; the score digits, `GAME OVER` and restart arrow are the sprites, and the cacti are drawn in
code in the same grey. While it is up, the page's own keys (`y`, `n`, `t`, `m`, `?`) are quiet.

## Sound

**Off by default, and when it is off no audio engine is created at all** (tested: a whole run builds no `AudioContext`).
`♪` in the header, or `m`, cycles *off → blips → music*; the choice is remembered, but a remembered setting does **not**
start on page load (browsers forbid it and it would be rude): it starts at your first click or key press.

Everything is synthesised in the browser with Web Audio ([`ui/sound.js`](../ui/sound.js)): no files, nothing downloaded.

- **Blips**: a chime when a permission prompt arrives, a blip when you answer, a phrase for a phase passing or failing, a
  jingle at the end of a run, a meow when you click the cat. A burst makes one chime, not several (rate-limited).
- **Music**: a quiet chiptune loop (A minor, four chords) that follows the run. Pad and the occasional bell when idle;
  bass, arpeggio and soft drums while an agent works; thinned back out while something waits on you so the chime is clear;
  it plays on for 9 s after the run ends, then stops for good. Paused when the tab is hidden.
- Replayed history (a reload, or the page reconnecting) is silent, even with sound on.

Measured in `test/ui-sound.mjs` on the real output of a real Chromium: about 2.4× the notes while an agent works than when idle (26 against 11 in three seconds),
a peak amplitude of about 0.09 (audible, nowhere near clipping), and silence once the music stops. What is **not** tested: a
real speaker, other browsers, and how it sounds. Taste is yours to judge.

## What is not covered

- No test on Firefox or Safari (Chromium only), and none on a real touch device.
- Nothing here has been reviewed by a person who uses a screen reader. The cat is `aria-hidden`; the offline screen is an
  `alertdialog` with focus moved into it; the help window traps Tab and closes on Esc; all motion honours reduced-motion.
- The cat's and cursors' licence status (above) is unknown.
