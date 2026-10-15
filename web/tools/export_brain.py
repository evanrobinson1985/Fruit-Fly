"""Export the 'realistic' connectome for the browser engine (web/src/brain-worker.js).

Writes web/assets/brain.json plus brain-NN.png parts (byte stream stored in
grayscale PNGs, see pngpack.py; each part <= 14 MB). The stream holds three
varint sections:
  out-degree per neuron | target index deltas within each row | zigzag signed weights

    python web/tools/export_brain.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from flysim import data, interface, model

sys.path.insert(0, str(Path(__file__).parent))
import pngpack  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "assets"
MAX_PNG = 14_500_000


def varint(a: np.ndarray) -> bytes:
    a = a.astype(np.uint64)
    nbytes = np.ones(len(a), np.int64)
    for k in range(1, 5):
        nbytes += a >= (1 << (7 * k))
    out = np.zeros(int(nbytes.sum()), np.uint8)
    pos = np.r_[0, np.cumsum(nbytes)[:-1]]
    for k in range(5):
        m = nbytes > k
        byte = (a[m] >> np.uint64(7 * k)) & np.uint64(0x7F)
        out[pos[m] + k] = byte | np.where(nbytes[m] > k + 1, 0x80, 0).astype(np.uint64)
    return out.tobytes()


def positions(c, annot_path):
    """Soma position per neuron (um); neurons without a soma in the CNS sit at their partners' mean."""
    a = pd.read_feather(annot_path, columns=["bodyId", "somaLocation", "tosomaLocation"]).set_index("bodyId")
    loc = a.somaLocation.where(a.somaLocation.notna(), a.tosomaLocation).reindex(c.neurons.bodyId)
    xyz = np.full((c.n, 3), np.nan)
    ok = loc.notna().to_numpy()
    xyz[ok] = np.stack(loc[ok].to_numpy()) * 0.008  # 8 nm voxels -> um
    pre = np.repeat(np.arange(c.n), np.diff(c.indptr))
    w = np.abs(c.w).astype(np.float64)
    for _ in range(3):
        known = ~np.isnan(xyz[:, 0])
        for src, dst in ((pre, c.post), (c.post, pre)):  # partners downstream first, then upstream
            m = known[dst] & ~known[src]
            tot = np.bincount(src[m], w[m], c.n)
            for d in range(3):
                s = np.bincount(src[m], w[m] * xyz[dst[m], d], c.n)
                fill = (tot > 0) & np.isnan(xyz[:, d])
                xyz[fill, d] = s[fill] / tot[fill]
            known = ~np.isnan(xyz[:, 0])
    xyz[np.isnan(xyz)] = np.nanmean(xyz)
    return xyz


def main():
    raw = data.load()
    lif, edits = model.PRESETS["realistic"]
    c = data.functional(raw, **edits)
    nz = c.w != 0
    pre = np.repeat(np.arange(c.n), np.diff(c.indptr))[nz]
    post, w = c.post[nz].astype(np.int64), np.round(c.w[nz]).astype(np.int64)
    deg = np.bincount(pre, minlength=c.n)
    delta = post.copy()
    same = np.r_[False, pre[1:] == pre[:-1]]
    delta[same] = post[same] - post[np.flatnonzero(same) - 1]
    assert (delta >= 0).all()
    sections = [varint(deg), varint(delta), varint((w << 1) ^ (w >> 63))]
    stream = b"".join(sections)

    OUT.mkdir(parents=True, exist_ok=True)
    for old in [*OUT.glob("brain-*.bin"), *OUT.glob("brain-*.png")]:
        old.unlink()
    k = 3
    while True:  # split into k parts until each compressed part fits the host's file limit
        bounds = np.linspace(0, len(stream), k + 1).astype(int)
        pngs = [pngpack.encode(stream[a:b]) for a, b in zip(bounds[:-1], bounds[1:])]
        if max(map(len, pngs)) <= MAX_PNG:
            break
        k += 1
    chunks = []
    for i, (png, a, b) in enumerate(zip(pngs, bounds[:-1], bounds[1:])):
        name = f"brain-{i:02d}.png"
        (OUT / name).write_bytes(png)
        chunks.append({"file": name, "bytes": int(b - a), "png_bytes": len(png)})

    io = interface.Interface(raw)
    side = c.neurons.side.to_numpy()
    by_side = lambda idx: {s: idx[side[idx] == s].tolist() for s in "LR"}
    groups = {
        "odor": {o: by_side(raw.select(type=t)) for o, t in interface.ODORS.items()},
        "taste": io.grn.tolist(),
        "loom": {s: v.tolist() for s, v in io.loom.items()},
        "motor": {k: {s: v.tolist() for s, v in d.items()} for k, d in io.motor.items()},
    }
    xyz = positions(c, data.DEFAULT_DATA_DIR / data.ANNOT)
    lo, hi = xyz.min(0), xyz.max(0)
    q = np.round((xyz - lo) / (hi - lo) * 65535).astype(np.uint16)
    (OUT / "brain-pos.png").write_bytes(pngpack.encode(q.tobytes()))
    sc = c.neurons.superclass.fillna("unknown")
    classes = sorted(sc.unique())
    (OUT / "brain-class.png").write_bytes(pngpack.encode(sc.map({k: i for i, k in enumerate(classes)}).to_numpy(np.uint8).tobytes()))
    meta = {
        "n": int(c.n), "edges": int(nz.sum()), "sections": [len(s) for s in sections], "chunks": chunks,
        "png_bytes": sum(c["png_bytes"] for c in chunks),
        "params": {**model.LIFParams(**lif).__dict__}, "groups": groups,
        "pos_range_um": [lo.tolist(), hi.tolist()], "classes": classes,
        "source": "MaleCNS v1.0 (Janelia FlyEM / Google, CC-BY 4.0), traced neurons, minconf 0.5",
    }
    (OUT / "brain.json").write_text(json.dumps(meta))
    print(f"{c.n} neurons, {nz.sum()} edges -> {meta['png_bytes'] / 1e6:.1f} MB in {len(chunks)} PNG parts")


if __name__ == "__main__":
    main()
