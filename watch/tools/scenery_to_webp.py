"""Stitch the rendered scenery slices into the two strip images the game draws. Needs Pillow."""
import json
import sys
from pathlib import Path

from PIL import Image

d = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "app/src/main/assets/scenery"
meta = json.loads((d / "scenery.json").read_text())
W, H = meta["width"], meta["height"]
for layer in ("behind", "front"):
    tiles = sorted(d.glob(f"{layer}_*.png"))
    strip = Image.new("RGBA", (W, H))
    for t in tiles:  # push-broom slices, left to right
        im = Image.open(t)
        strip.paste(im, (int(t.stem.split("_")[1]) * im.width, 0))
        t.unlink()
    if layer == "behind":
        strip.convert("RGB").save(d / "behind.webp", "WEBP", quality=86, method=6)
    else:
        strip.save(d / "front.webp", "WEBP", quality=86, method=6)
    print(layer, strip.size, (d / f"{layer}.webp").stat().st_size, "bytes")
