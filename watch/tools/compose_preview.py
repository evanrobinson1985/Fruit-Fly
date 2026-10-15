"""Compose watch-screen previews from the game's own assets (scenery layers, sprite frames)
with the same placement rules as MainActivity.drawScene. Needs Pillow.

    python watch/tools/compose_preview.py <out dir>
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ASSETS = Path(__file__).resolve().parents[1] / "app/src/main/assets"
SIZE = 480                      # Galaxy Watch Ultra: 480 x 480
FLY = SIZE * 0.46               # sprite frame size on screen
SPRITE_MM = 5.98                # mm shown by a sprite frame
STAND_LINE, FEET_LINE = 0.71, 0.756
HALF_WIDTH, FOOD_RADIUS = 30.0, 2.0

meta = json.loads((ASSETS / "scenery/scenery.json").read_text())
layers = {n: Image.open(ASSETS / f"scenery/{n}.webp").convert("RGBA") for n in ("far", "near", "front")}
P = meta["pxPerMm"]


def sprite(name):
    return Image.open(ASSETS / f"sprites/{name}.webp").convert("RGBA")


def layer(img, cam_x, cam_z, k, stand_y, col0, rate):
    s = k / P
    u0 = col0 + (cam_x * rate - SIZE / 2 / k) * P
    v0 = meta["feetRow"] - (stand_y + cam_z * k) / s
    crop = img.crop((round(u0), round(v0), round(u0 + SIZE / s), round(v0 + SIZE / s)))
    return crop.resize((SIZE, SIZE), Image.LANCZOS)


def screen(x, z, facing, frame, food=(), night=False, stats=(80, 70, 60)):
    k = FLY / SPRITE_MM
    half = SIZE / 2 / k
    lim = max(0.0, HALF_WIDTH - half)
    cam_x = max(-lim, min(lim, x))
    cam_z = max(0.0, z - 2.5)
    stand_y = SIZE * STAND_LINE
    im = Image.new("RGBA", (SIZE, SIZE), (13, 12, 10, 255))
    im.alpha_composite(layer(layers["far"], cam_x, cam_z, k, stand_y, meta["farX0"], meta["parallax"]))
    im.alpha_composite(layer(layers["near"], cam_x, cam_z, k, stand_y, meta["x0"], 1.0))
    ground = stand_y + cam_z * k
    d = ImageDraw.Draw(im, "RGBA")
    sx = lambda xx: SIZE / 2 + (xx - cam_x) * k
    for fx, amount in food:
        r = FOOD_RADIUS * k * (0.45 + 0.55 * min(1, amount / 30))
        cx = sx(fx)
        d.ellipse((cx - r, ground - r * 0.32, cx + r, ground + r * 0.23), fill=(217, 164, 65, 230))
        d.ellipse((cx - r * 0.5, ground - r * 0.28, cx + r * 0.05, ground - r * 0.12), fill=(255, 244, 214, 170))
    px = sx(x)
    top = ground - z * k - FLY * FEET_LINE
    spr = sprite(frame).resize((round(FLY), round(FLY)), Image.LANCZOS)
    if facing < 0:
        spr = spr.transpose(Image.FLIP_LEFT_RIGHT)
    sh = max(0.2, min(1, 1 - z / 15))
    d.ellipse((px - FLY * 0.22 * sh, ground - 3, px + FLY * 0.22 * sh, ground + 4), fill=(0, 0, 0, round(51 * sh)))
    im.alpha_composite(spr, (round(px - FLY / 2), round(top)))
    im.alpha_composite(layer(layers["front"], cam_x, cam_z, k, stand_y, meta["x0"], 1.0))
    d = ImageDraw.Draw(im, "RGBA")
    for fx, _ in food:
        cx = sx(fx)
        if cx < 0 or cx > SIZE:
            ex, dd = (18, -1) if cx < 0 else (SIZE - 18, 1)
            d.polygon([(ex + dd * 10, ground - 8), (ex - dd * 4, ground - 16), (ex - dd * 4, ground)], fill=(230, 168, 74))
    if night:
        im.alpha_composite(Image.new("RGBA", (SIZE, SIZE), (6, 16, 42, 140)))
        d = ImageDraw.Draw(im, "RGBA")
    # Stat arcs and the Feed button, as on the watch.
    for i, (v, c) in enumerate(zip(stats, [(230, 168, 74), (127, 182, 232), (232, 143, 168)])):
        inset = 8 + i * 11
        box = (inset, inset, SIZE - inset, SIZE - inset)
        d.arc(box, 205, 335, fill=(255, 255, 255, 51), width=7)
        d.arc(box, 205, 205 + 130 * v / 100, fill=c, width=7)
    d.ellipse((SIZE / 2 - 37, SIZE - 14 * 1.5 - 74, SIZE / 2 + 37, SIZE - 14 * 1.5), fill=(230, 168, 74))
    d.text((SIZE / 2 - 14, SIZE - 14 * 1.5 - 42), "Feed", fill=(42, 28, 10))
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, SIZE, SIZE), fill=255)
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(im, (0, 0), mask)
    return out


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "previews")
    out.mkdir(parents=True, exist_ok=True)
    shots = {
        "1-wandering": screen(-8, 0, 1, "walk_04"),
        "2-walking-to-food": screen(3, 0, 1, "walk_10", food=[(6.5, 30)]),
        "3-feeding": screen(5.4, 0, 1, "feed_05", food=[(6.5, 22)], stats=(55, 70, 75)),
        "4-escape-flight": screen(14, 6.5, -1, "fly_02"),
        "5-sugar-off-screen": screen(-20, 0, -1, "idle_02", food=[(12, 30)]),
        "6-asleep": screen(-2, 0, 1, "sleep_00", night=True, stats=(60, 20, 50)),
    }
    for name, im in shots.items():
        im.save(out / f"{name}.png")
    sheet = Image.new("RGBA", (3 * SIZE + 40, 2 * SIZE + 20), (0, 0, 0, 0))
    for i, im in enumerate(shots.values()):
        sheet.alpha_composite(im, ((i % 3) * (SIZE + 20), (i // 3) * (SIZE + 20)))
    sheet.save(out / "screens.png")
    print("wrote", len(shots), "previews to", out)
