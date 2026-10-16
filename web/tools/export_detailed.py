"""Export the extra wiring of the "detailed" model (flysim.model.make_detailed) for the
browser: web/assets/brain-detail.png (int32 arrays in a grayscale PNG, see pngpack.py)
and a "detailed" entry in web/assets/brain.json with the arrays' layout and parameters.

    python web/tools/export_detailed.py      (after export_brain.py)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from flysim import data, model

sys.path.insert(0, str(Path(__file__).parent))
import pngpack  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "assets"


def main():
    raw = data.load()
    lif, edits = model.PRESETS["realistic"]
    c = data.functional(raw, **edits)
    d = model.Detailed(c, data.modulatory(raw))
    ty = c.neurons["type"].fillna("").to_numpy().astype(str)
    oa = np.flatnonzero(np.diff(d.m_indptr) > 0)
    da = np.flatnonzero(np.diff(d.d_indptr) > 0)
    gp = np.flatnonzero(np.diff(d.gap_indptr) > 0)
    mbons = np.flatnonzero(d.mbon_of >= 0)
    arrays = {
        # Octopamine neurons, their out-degree, targets and synapse counts.
        "oa": oa, "oaDeg": np.diff(d.m_indptr)[oa], "oaPost": d.m_post,
        "oaCount": np.round(d.m_w / d.p.oa_w).astype(np.int64),
        # Dopamine neuron -> MBON synapse counts (normalized per MBON in the browser).
        "da": np.repeat(np.arange(c.n), np.diff(d.d_indptr)), "daMbon": mbons[d.d_post],
        "daCount": np.zeros(len(d.d_post), np.int64),
        "kc": np.flatnonzero(np.char.startswith(ty, "KC")), "mbon": mbons,
        # Giant Fiber -> TTMn / PSI electrical synapses.
        "gapPre": np.repeat(np.arange(c.n), np.diff(d.gap_indptr)), "gapPost": d.gap_post,
    }
    # Raw counts behind the normalized DAN -> MBON weights.
    mod = data.modulatory(raw)
    pre = np.repeat(np.arange(raw.n), np.diff(mod.indptr))
    nt = c.neurons.nt.to_numpy()
    sel = (nt[pre] == "dopamine") & (d.mbon_of[mod.post] >= 0)
    assert (pre[sel] == arrays["da"]).all()
    arrays["daCount"] = mod.count[sel]
    layout, parts, off = {}, [], 0
    for k, a in arrays.items():
        a = np.asarray(a, "<i4")
        layout[k] = [off, len(a)]
        parts.append(a.tobytes())
        off += len(a)
    (OUT / "brain-detail.png").write_bytes(pngpack.encode(b"".join(parts)))
    meta = json.loads((OUT / "brain.json").read_text())
    meta["detailed"] = {"file": "brain-detail.png", "ints": off, "layout": layout, "params": d.p.__dict__}
    (OUT / "brain.json").write_text(json.dumps(meta))
    print(f"{len(oa)} octopamine neurons, {len(d.m_post)} targets; {len(d.d_post)} DAN->MBON pairs; "
          f"{len(arrays['kc'])} KCs, {len(mbons)} MBONs; {len(d.gap_post)} gap junctions; {off * 4 / 1e6:.1f} MB raw")


if __name__ == "__main__":
    main()
