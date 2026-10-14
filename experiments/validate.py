"""Check the simulated brain against known fly circuits, for both presets.

1. Looming detectors (LC4, LPLC2) -> Giant Fiber (DNp01) -> flight motor neurons.
2. Each taste-neuron type -> proboscis motor neuron MN9.
3. Stability: is the network quiet again 200 ms after a stimulus ends?

Writes results/validation.md.
    python experiments/validate.py
"""
from pathlib import Path

import numpy as np

from flysim import data, model

STIM_MS, HZ = 500.0, 100.0


def probe(brain, c, idx, read):
    brain.reset()
    brain.set_rates(idx, HZ)
    n = brain.run(STIM_MS)
    brain.clear_rates()
    brain.run(100)
    after = brain.run(200)
    return {k: model.rate_hz(n, v, STIM_MS).mean() for k, v in read.items()}, int((n > 0).sum()), int((after > 0).sum())


def main():
    c = data.load()
    nn = c.neurons
    read = {"GF": c.select(type="DNp01"), "MN9_L": c.select(type="MN9", side="L"),
            "MN9_R": c.select(type="MN9", side="R"),
            "DLMn": c.select(type="DLMn c-f")}
    tastes = sorted(nn.loc[nn["class"].eq("gustatory"), "type"].dropna().unique())
    probes = {"LC4": c.select(type="LC4"), "LPLC2": c.select(type="LPLC2"),
              "ORN vinegar": c.select(type=["ORN_DM1", "ORN_DM4", "ORN_DM2", "ORN_VA2"]),
              **{t: c.select(type=t) for t in tastes}}
    lines = ["# Validation", "",
             f"Each input type is driven at {HZ:.0f} Hz Poisson for {STIM_MS:.0f} ms from rest. Rates are means "
             "over that window. 'Active' counts neurons that spiked during the stimulus; 'still active' counts "
             "neurons spiking 100-300 ms after it ended (should be ~0 for a healthy network).", ""]
    for preset in ["realistic", "shiu2024"]:
        brain = model.make_brain(c, preset)
        lines += [f"## Preset `{preset}`", "",
                  "| input | n | GF Hz | DLMn Hz | MN9 L Hz | MN9 R Hz | active | still active |",
                  "|---|---|---|---|---|---|---|---|"]
        for name, idx in probes.items():
            r, act, after = probe(brain, c, idx, read)
            lines.append(f"| {name} | {len(idx)} | {r['GF']:.0f} | {r['DLMn']:.0f} | {r['MN9_L']:.0f} | "
                         f"{r['MN9_R']:.0f} | {act} | {after} |")
            print(preset, lines[-1])
        lines.append("")
    out = Path("results")
    out.mkdir(exist_ok=True)
    (out / "validation.md").write_text("\n".join(lines))
    print("Wrote results/validation.md")


if __name__ == "__main__":
    main()
