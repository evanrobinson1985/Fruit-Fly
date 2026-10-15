"""Export the watch game's brain: the connectome subcircuit between the game's
senses and behaviors, validated against the full brain.

Writes watch/app/src/main/assets/brain.bin (+ brain.json) and watch/VALIDATION.md.

    PYTHONPATH=. python watch/tools/export_brain.py
"""
from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np
import pandas as pd

from flysim import data, interface, model, subcircuit

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "app/src/main/assets"
MIN_SYN, HOPS, GROOM_HOPS = 8, 3, 2


def head_touch(raw):
    """Head mechanosensory (bristle) neurons by side: what a tickle or dust stimulates."""
    nn = raw.neurons
    sc, cl, sub = (nn[k].fillna("") for k in ("superclass", "class", "subclass"))
    idx = np.flatnonzero((sc.eq("cb_sensory") & cl.eq("mechanosensory") & sub.isin(["", "grooming"])).to_numpy())
    side = nn.side.to_numpy()
    return {s: idx[side[idx] == s] for s in "LR"}


def groups(io, rmap, touch, groom):
    m = lambda idx: [int(i) for i in rmap[np.asarray(idx)] if i >= 0]
    return {
        "taste": m(io.grn),
        "odor": {s: m(v) for s, v in io.orn.items()},
        "loom": {s: m(v) for s, v in io.loom.items()},
        "touch": {s: m(v) for s, v in touch.items()},
        # groom: DNg12, head sweeps alternating with front-leg rubbing (Guo et al. 2022).
        "motor": {**{k: {s: m(v) for s, v in d.items()} for k, d in io.motor.items()}, "groom": {s: m(v) for s, v in groom.items()}},
    }


def peak_mn9(brain, g, taste_idx, hz, ms=1000):
    """Peak 60 ms-smoothed MN9 rate during `ms` of taste input (what the game thresholds)."""
    brain.set_rates(taste_idx, hz)
    sm = pk = 0.0
    mn9 = list(g["motor"]["feed"].values())
    for _ in range(int(ms / 20)):
        cnt = brain.run(20)
        r = max(cnt[i].mean() / 0.02 for i in mn9 if len(i))
        sm += (r - sm) / 3
        pk = max(pk, sm)
    return pk


def main():
    raw = data.load()
    lif, edits = model.PRESETS["realistic"]
    params = model.LIFParams(**lif)
    full = data.functional(raw, **edits)
    io = interface.Interface(raw, odor="vinegar")
    touch = head_touch(raw)
    groom = interface.motor_pools(raw.neurons)["groomHead"]
    inputs = np.unique(np.r_[io.grn, io.orn["L"], io.orn["R"], io.loom["L"], io.loom["R"]])
    keep = subcircuit.select(full, inputs, io.readout, MIN_SYN, HOPS)
    # Grooming: head bristles -> DNg12 on paths of at most 3 synapses (GROOM_HOPS + 1). This adds
    # ~1,400 neurons and keeps DNg12's response to head touch within a few % of the full brain.
    keep = np.union1d(keep, subcircuit.select(full, np.r_[touch["L"], touch["R"]], np.r_[groom["L"], groom["R"]], MIN_SYN, GROOM_HOPS))
    sub, newid = subcircuit.subset(full, keep)
    gs, gf = groups(io, newid, touch, groom), groups(io, np.arange(full.n), touch, groom)
    print(f"subcircuit: {sub.n} neurons, {sub.n_edges} connections")

    import sys
    if "--no-validate" in sys.argv:
        return write(sub, gs, params)
    # Validation: mean motor rates over 500 ms of drive, full vs sub, 3 seeds.
    rows = []
    probes = [("Looming (LC4+LPLC2) 100 Hz", lambda g: g["loom"]["L"] + g["loom"]["R"], 100),
              ("Taste neurons 80 Hz", lambda g: g["taste"], 80),
              ("Vinegar ORNs 60 Hz", lambda g: g["odor"]["L"] + g["odor"]["R"], 60),
              ("Head bristles 120 Hz", lambda g: g["touch"]["L"] + g["touch"]["R"], 120)]
    for name, pick, hz in probes:
        for label, cc, g in (("full brain", full, gf), ("watch circuit", sub, gs)):
            r = []
            for seed in (1, 2, 3):
                b = model.Brain(cc, params, seed=seed)
                b.set_rates(pick(g), hz)
                cnt = b.run(500)
                r.append({k: max(cnt[v].mean() for v in d.values() if len(v)) * 2 for k, d in g["motor"].items()})
            rows.append({"input": name, "network": label, **pd.DataFrame(r).mean().round(0).to_dict()})
    table = pd.DataFrame(rows)

    # Hunger mechanic: probability of a feeding response vs. number of taste neurons recruited.
    rng = np.random.default_rng(0)
    rec = []
    for k in (1, 2, 4, 8, 12, 20, 40):
        hits = {}
        for label, cc, g in (("full brain", full, gf), ("watch circuit", sub, gs)):
            ok = 0
            for s in range(8):
                idx = rng.choice(len(g["taste"]), k, replace=False)
                b = model.Brain(cc, params, seed=100 + s)
                ok += peak_mn9(b, g, [g["taste"][i] for i in idx], 40) > 20
            hits[label] = ok / 8
        rec.append({"taste neurons responding": k, **hits})
        print(rec[-1])
    hunger = pd.DataFrame(rec)

    md = ["# Watch circuit validation", "",
          f"The watch game runs the connectome subcircuit on paths of at most {HOPS + 1} synapses "
          f"from its sensory inputs to its motor outputs (at most {GROOM_HOPS + 1} from the head "
          f"bristles to the DNg12 grooming neurons), using connections of {MIN_SYN}+ synapses to "
          f"choose neurons and keeping every connection among them: {sub.n:,} of {full.n:,} neurons "
          f"and {sub.n_edges:,} of {full.n_edges:,} connections. Same neuron model and parameters as "
          "the `realistic` preset.", "",
          "## Motor responses (peak group mean rate, Hz, 500 ms of input, mean of 3 seeds)", "",
          table.to_markdown(index=False), "",
          "## Hunger: feeding responses vs. taste neurons recruited", "",
          "Fraction of 8 trials (random taste neurons, 40 Hz, 1 s) in which MN9 crossed the game's "
          "20 Hz feeding threshold. In the game a hungry fly recruits many sugar-sensing neurons and "
          "a satiated one few (starvation raises sugar-neuron sensitivity; Inagaki et al. 2012).", "",
          hunger.to_markdown(index=False), ""]
    (ROOT / "VALIDATION.md").write_text("\n".join(md))
    write(sub, gs, params)


def write(sub, gs, params):
    ASSETS.mkdir(parents=True, exist_ok=True)
    w = np.round(sub.w).astype(np.int16)
    with open(ASSETS / "brain.bin", "wb") as f:  # little-endian: n, edges, indptr[n+1], post[e], w[e]
        f.write(struct.pack("<ii", sub.n, sub.n_edges))
        f.write(sub.indptr.astype("<i4").tobytes())
        f.write(sub.post.astype("<i4").tobytes())
        f.write(w.astype("<i2").tobytes())
    # Plain-text groups and parameters for the Kotlin loader: "<key> <values...>" per line.
    lines = [f"param {k} {v}" for k, v in params.__dict__.items()]
    lines.append("group taste " + " ".join(map(str, gs["taste"])))
    for kind in ("odor", "loom", "touch"):
        for side, idx in gs[kind].items():
            lines.append(f"group {kind}.{side} " + " ".join(map(str, idx)))
    for name, sides in gs["motor"].items():
        for side, idx in sides.items():
            lines.append(f"group motor.{name}.{side} " + " ".join(map(str, idx)))
    (ASSETS / "brain.txt").write_text("\n".join(lines) + "\n")
    (ASSETS / "brain.json").write_text(json.dumps({
        "n": int(sub.n), "edges": int(sub.n_edges), "params": params.__dict__, "groups": gs,
        "body_ids": sub.neurons.bodyId.astype(int).tolist(),
        "source": "MaleCNS v1.0 (Janelia FlyEM / Google, CC-BY 4.0) subcircuit; model of Shiu et al. 2024",
    }))
    print(f"wrote {ASSETS / 'brain.bin'} ({(ASSETS / 'brain.bin').stat().st_size / 1e6:.1f} MB) and VALIDATION.md")


if __name__ == "__main__":
    main()
