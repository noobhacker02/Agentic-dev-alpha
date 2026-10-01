#!/usr/bin/env python3
"""Cuts the sprite sheets you supplied into the small PNGs the UI loads (ui/assets/**) and writes ui/assets/manifest.json.

The page never reads the sheets. It reads the small files and the manifest, so swapping a sprite is: drop a PNG in
ui/assets/, fix its entry in manifest.json, run `npm run check:sprites`. Nothing here runs at runtime.

  python3 scripts/build-sprites.py --cat cat.png --cursors cursors.png --dino dino.png --dino-ui dino-ui.png \
      --psd Gui_icons2.psd --out ui/assets

Needs: pillow, numpy, scipy, psd-tools (dev-time only). Pixel art is never resampled: every output pixel is a source pixel.
"""
import argparse, json, re
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi


def load(path):
    return Image.open(path).convert("RGBA")


def save(img, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)


def strip(frames, cw, ch):
    out = Image.new("RGBA", (cw * len(frames), ch), (0, 0, 0, 0))
    for i, f in enumerate(frames):
        assert f.size == (cw, ch), (f.size, cw, ch)
        out.alpha_composite(f, (i * cw, 0))
    return out


def components(img, fg_mask, dilate, min_area):
    """Bounding boxes of the sprites on a sheet, row-major. Dilation merges the pieces of one sprite (eyes, sparks)."""
    lab, _ = ndi.label(ndi.binary_dilation(fg_mask, iterations=dilate) if dilate else fg_mask)
    boxes = []
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        ys, xs = sl
        if (fg_mask[sl] & (lab[sl] == i)).sum() < min_area:
            continue
        boxes.append((xs.start, ys.start, xs.stop - xs.start, ys.stop - ys.start))
    boxes.sort(key=lambda b: (round(b[1] / 24), b[0]))
    return boxes


def largest_piece(img):
    """Keeps only the biggest connected piece of a sprite (drops stray edge pixels the sheet left around it)."""
    a = np.array(img)
    lab, n = ndi.label(a[..., 3] > 0, structure=np.ones((3, 3)))
    if n > 1:
        keep = np.argmax(ndi.sum(np.ones_like(lab), lab, range(1, n + 1))) + 1
        a[lab != keep] = 0
    return Image.fromarray(a)


def region(img, x0, y0, x1, y1, min_area=6):
    """Separate (undilated) sprites inside a window of a sheet, left to right."""
    fg = np.array(img)[..., 3] > 0
    mask = np.zeros_like(fg)
    mask[y0:y1, x0:x1] = fg[y0:y1, x0:x1]
    return sorted(components(img, mask, 0, min_area))


def tight(img):
    bb = img.getbbox()
    return img.crop(bb) if bb else img


# ------------------------------------------------------------------ the cat
def build_cat(src, out, man):
    a = np.array(load(src))
    bg = np.all(np.abs(a[..., :3].astype(int) - np.array([148, 148, 140])) <= 2, axis=-1)
    magenta = (a[..., 0] > 200) & (a[..., 1] < 80) & (a[..., 2] > 200)  # the sheet's separator lines
    a[bg | magenta] = 0
    clean = Image.fromarray(a)
    W, H = 56, 69
    crop = lambda x, y, w, h: clean.crop((x, y, x + w, y + h))
    # Frames are cut by the sheet's own grid (not by each sprite's box), so the sway and bob survive.
    idle = [crop(round(10 + 64.2 * c) - 4, 0, W, H) for c in range(10)]
    dance = [crop(42 + 128 * c - 4, 98 + 96 * r - 1, W, H) for r in range(5) for c in range(5)]
    cat = {}
    for name, frames, fps in (("idle", idle, 5), ("dance", dance, 10)):
        save(strip(frames, W, H), out / f"cat/{name}.png")
        cat[name] = {"file": f"cat/{name}.png", "frames": len(frames), "w": W, "h": H, "fps": fps}
    # One-off poses from the sheet's last row.
    # Windows are placed so the cat's body sits on the same centre line and floor as the idle frames
    # (measured: fur centroid and lowest fur pixel), so changing pose never makes it jump sideways or sink.
    for name, box, fps in (("charge", (31, 954, 68, 72), 0), ("hop", (181, 943, 56, 67), 0)):
        img = crop(*box)
        save(img, out / f"cat/{name}.png")
        cat[name] = {"file": f"cat/{name}.png", "frames": 1, "w": box[2], "h": box[3], "fps": fps}
    shadow = tight(crop(190, 1010, 40, 18))
    save(shadow, out / "cat/shadow.png")
    cat["shadow"] = {"file": "cat/shadow.png", "frames": 1, "w": shadow.width, "h": shadow.height, "fps": 0}
    win = [crop(302, 950, 114, 81), crop(430, 950, 114, 81)]
    save(strip(win, 114, 81), out / "cat/win.png")
    cat["win"] = {"file": "cat/win.png", "frames": 2, "w": 114, "h": 81, "fps": 2}
    man["cat"] = cat


# ------------------------------------------------------------------ cursors
# name -> (index in this sheet's row-major component list, where the hotspot is)
CURSORS = {
    "default": (0, "tip"), "hover": (1, "tip"), "not-allowed": (2, "tip"),
    "pointer": (10, "finger"), "no-drop": (12, "center"),
    "grab": (13, "center"), "grabbing": (16, "center"),
    "progress": (17, "center"), "wait": (26, "center"),
    "text": (44, "center"), "crosshair": (43, "center"), "move": (39, "center"),
    "ns-resize": (40, "center"), "ew-resize": (49, "center"),
    "nwse-resize": (41, "center"), "nesw-resize": (42, "center"),
    "zoom-in": (36, "lens"), "locked": (24, "center"),
}


def hotspot(img, mode):
    a = np.array(img)[..., 3] > 0
    ys, xs = np.nonzero(a)
    if mode == "tip":   # the arrow's point: the opaque pixel nearest the top-left corner
        i = np.argmin(xs + ys)
        return int(xs[i]), int(ys[i])
    if mode == "finger":  # the top of the raised finger
        top = ys.min()
        return int(round(xs[ys == top].mean())), int(top)
    if mode == "lens":  # the middle of the magnifier's glass, which is its upper-left
        return int(img.width * 0.4), int(img.height * 0.4)
    return img.width // 2, img.height // 2


def build_cursors(src, out, man):
    im = load(src)
    boxes = components(im, np.array(im)[..., 3] > 0, 1, 12)
    cur = {}
    for name, (idx, mode) in CURSORS.items():
        x, y, w, h = boxes[idx]
        img = im.crop((x, y, x + w, y + h))
        hx, hy = hotspot(img, mode)
        save(img, out / f"cursors/{name}.png")
        cur[name] = {"file": f"cursors/{name}.png", "w": w, "h": h, "x": hx, "y": hy}
    man["cursors"] = cur


# ------------------------------------------------------------------ icons (Craftpix GUI icons, two sizes each)
ICONS = {  # name -> icon number in the PSD's own layer names
    "planner": 44, "test-designer": 49, "builder": 53, "verifier": 9, "gatekeeper": 4, "overseer": 3,
    "running": 8, "approval": 11, "unlocked": 10, "thinking": 42, "time": 48, "decisions": 61,
    "persona": 12, "gear": 54, "quill": 93, "feather": 87, "pickaxe": 52, "magnifier": 51,
    "compass": 43, "fist": 7, "flame": 13,
}


def build_icons(psd_path, out, man):
    """Each icon is drawn at two sizes. The PSD's layer *names* do not pair them reliably (a map's small twin can be named
    like a telescope), but their *positions* do: both sit in the same cell of a 12 x 10 grid (48 x 32 px cells)."""
    from psd_tools import PSDImage
    psd = PSDImage.open(psd_path)
    big_by_name, small_by_cell = {}, {}
    for layer in psd:
        m = re.match(r"icon\s*(\d+)_(\d)$", layer.name.lower().strip())
        if layer.kind != "pixel" or not m:
            continue
        im = layer.composite()
        if im is None:
            continue
        x0, y0, x1, y1 = layer.bbox
        cell = (int(((x0 + x1) / 2) // 48), int(((y0 + y1) / 2) // 32))
        if max(x1 - x0, y1 - y0) >= 14:
            big_by_name[int(m.group(1))] = (im.convert("RGBA"), cell)
        else:
            small_by_cell[cell] = im.convert("RGBA")
    icons = {}
    for name, n in ICONS.items():
        big, cell = big_by_name[n]
        small = small_by_cell.get(cell)
        assert small is not None, f"icon {name}: no small twin in cell {cell}"
        # A wrong pairing is easy to miss by eye; the two drawings of one icon have the same overall colour.
        mean = lambda im: np.array(im)[np.array(im)[..., 3] > 0][:, :3].mean(axis=0)
        assert np.abs(mean(big) - mean(small)).max() < 45, f"icon {name}: the 12px twin looks like a different drawing"
        for img, size, suffix in ((big, 17, ""), (small, 12, "-s")):
            img = tight(img)
            assert img.width <= size and img.height <= size, (name, img.size)
            canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            canvas.alpha_composite(img, ((size - img.width) // 2, (size - img.height) // 2))
            save(canvas, out / f"icons/{name}{suffix}.png")
        icons[name] = {"file": f"icons/{name}.png", "small": f"icons/{name}-s.png"}
    # The bottom row of the sheet holds 14px "skill" icons; the last is a heart.
    heart = [l for l in psd if l.name == "Skill_icon15"][0].composite().convert("RGBA")
    save(tight(heart), out / "icons/heart.png")
    icons["heart"] = {"file": "icons/heart.png"}
    man["icons"] = {"size": 17, "small": 12, "items": icons}


# ------------------------------------------------------------------ the dino
def drop_outline(img):
    """The sheet draws a white halo around each dino. Remove it (flood from outside through white), keep the white eye."""
    a = np.array(img)
    white = np.all(a[..., :3] >= 250, axis=-1) & (a[..., 3] > 0)
    outside = np.pad(a[..., 3] == 0, 1, constant_values=True)
    padded_white = np.pad(white, 1)
    lab, _ = ndi.label(outside | padded_white)
    reach = lab == lab[0, 0]
    halo = (padded_white & reach)[1:-1, 1:-1]
    a[halo] = 0
    return Image.fromarray(a)


def teal_to_alpha(img):
    a = np.array(img)
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    a[(g - r > 25) & (b - r > 25)] = 0  # the sheet's teal backdrop and any tint of it; the sprites are neutral grey
    return Image.fromarray(a)


def bottom_align(frames):
    w = max(f.width for f in frames)
    h = max(f.height for f in frames)
    out = []
    for f in frames:
        c = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        c.alpha_composite(f, (0, h - f.height))
        out.append(c)
    return out


def build_dino(dino_src, ui_src, out, man):
    im = teal_to_alpha(load(dino_src))
    a = np.array(im)
    fg = a[..., 3] > 0
    row = np.zeros_like(fg)
    row[0:54] = fg[0:54]  # the small, 1x row
    boxes = components(im, row, 1, 40)
    frames = [tight(drop_outline(im.crop((x, y, x + w, y + h)))) for (x, y, w, h) in boxes]
    stand, run1, run2, dead = frames[1], frames[3], frames[4], frames[6]
    duck = [frames[7], frames[8]]
    upright = bottom_align([stand, run1, run2, dead])
    cw, ch = upright[0].size
    save(strip(upright[1:3], cw, ch), out / "dino/run.png")
    save(upright[0], out / "dino/stand.png")
    save(upright[3], out / "dino/dead.png")
    d = bottom_align(duck)
    save(strip(d, d[0].width, d[0].height), out / "dino/duck.png")
    dino = {
        "stand": {"file": "dino/stand.png", "frames": 1, "w": cw, "h": ch},
        "run": {"file": "dino/run.png", "frames": 2, "w": cw, "h": ch, "fps": 8},
        "dead": {"file": "dino/dead.png", "frames": 1, "w": cw, "h": ch},
        "duck": {"file": "dino/duck.png", "frames": 2, "w": d[0].width, "h": d[0].height, "fps": 8},
    }
    # Score digits, "GAME OVER" and the restart arrow come from the other sheet (small row).
    ui = teal_to_alpha(load(ui_src))
    digits_row = region(ui, 0, 110, 150, 135)  # 0-9, H, I
    assert len(digits_row) == 12, f"expected 12 score glyphs, found {len(digits_row)}"
    glyph = [tight(ui.crop((x, y, x + w, y + h))) for (x, y, w, h) in digits_row]
    gh = max(g.height for g in glyph)
    gap = 1
    sheet = Image.new("RGBA", (sum(g.width + gap for g in glyph), gh), (0, 0, 0, 0))
    offsets, x = {}, 0
    for ch_, g in zip("0123456789HI", glyph):
        sheet.alpha_composite(g, (x, gh - g.height))
        offsets[ch_] = [x, g.width]
        x += g.width + gap
    save(sheet, out / "dino/digits.png")
    dino["digits"] = {"file": "dino/digits.png", "w": sheet.width, "h": gh, "glyphs": offsets}
    over = region(ui, 0, 130, 200, 155)  # the eight letters of GAME OVER
    assert len(over) == 8, f"expected 8 letters, found {len(over)}"
    x0, y0 = min(b[0] for b in over), min(b[1] for b in over)
    x1, y1 = max(b[0] + b[2] for b in over), max(b[1] + b[3] for b in over)
    go = tight(ui.crop((x0, y0, x1, y1)))
    save(go, out / "dino/gameover.png")
    dino["gameover"] = {"file": "dino/gameover.png", "w": go.width, "h": go.height}
    rx, ry, rw, rh = components(ui, np.array(ui)[..., 3] > 0, 1, 6)[2]
    rs = tight(largest_piece(ui.crop((rx, ry, rx + rw, ry + rh))))
    save(rs, out / "dino/restart.png")
    dino["restart"] = {"file": "dino/restart.png", "w": rs.width, "h": rs.height}
    man["dino"] = dino


CREDITS = [
    {"what": "cat", "who": "sprite sheet supplied by the project owner (original artist not stated on the sheet)"},
    {"what": "cursors", "who": "sprite sheet supplied by the project owner (original artist not stated on the sheet)"},
    {"what": "dino", "who": "Chrome offline dinosaur; sheet credits: madK, RealHeroicGamer, Resistiv, roomjaguarproductions, DogToon64"},
    {"what": "icons", "who": "Craftpix free GUI icons, https://craftpix.net/freebies/ , licence https://craftpix.net/file-licenses/"},
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cat", required=True)
    ap.add_argument("--cursors", required=True)
    ap.add_argument("--dino", required=True)
    ap.add_argument("--dino-ui", required=True)
    ap.add_argument("--psd", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    out = Path(args.out)
    man = {"version": 1, "credits": CREDITS}
    build_cat(args.cat, out, man)
    build_cursors(args.cursors, out, man)
    build_icons(args.psd, out, man)
    build_dino(args.dino, args.dino_ui, out, man)
    (out / "manifest.json").write_text(json.dumps(man, indent=2) + "\n")
    print("wrote", out / "manifest.json")


if __name__ == "__main__":
    main()
