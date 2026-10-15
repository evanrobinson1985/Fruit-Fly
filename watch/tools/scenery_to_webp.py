"""Stitch the rendered scenery tiles into the three layer images the game draws. Needs Pillow."""
import json
import sys
from pathlib import Path

from PIL import Image

d = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "app/src/main/assets/scenery"
meta = json.loads((d / "scenery.json").read_text())
for layer, W in (("near", meta["width"]), ("front", meta["width"]), ("far", meta["farWidth"])):
    H = meta["height"]
    tiles = sorted(d.glob(f"{layer}_*.png"))
    strip = Image.new("RGBA", (W, H))
    for t in tiles:
        _, ty, tx = t.stem.split("_")
        im = Image.open(t)
        strip.paste(im, (int(tx) * im.width, int(ty) * im.height))
        t.unlink()
    if layer == "far":
        strip.convert("RGB").save(d / "far.webp", "WEBP", quality=84, method=6)
    else:
        strip.save(d / f"{layer}.webp", "WEBP", quality=86, method=6)
    print(layer, strip.size, (d / f"{layer}.webp").stat().st_size, "bytes")
