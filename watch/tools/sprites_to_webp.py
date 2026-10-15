"""Convert rendered sprite PNGs to WebP (and delete the PNGs). Needs Pillow."""
from pathlib import Path

from PIL import Image

d = Path(__file__).resolve().parents[1] / "app/src/main/assets/sprites"
for png in sorted(d.glob("*.png")):
    Image.open(png).save(png.with_suffix(".webp"), "WEBP", quality=88, method=6)
    png.unlink()
print(f"{len(list(d.glob('*.webp')))} frames in {d}")
