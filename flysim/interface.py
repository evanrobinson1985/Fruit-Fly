"""Hand-built links between the simulated world and identified neurons.

The connectome provides the wiring; it does not say what the world looks like
to a neuron or what a descending neuron's spikes do to the legs. Those links are
defined here, from the experimental literature, and are the main modeling
choice outside the connectome. Each entry cites the evidence it rests on.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .data import Connectome

# Olfactory receptor neuron (ORN) glomeruli activated by each odor. ORNs carry
# their antenna of origin in `rootSide`, which gives bilateral sampling.
ODORS = {
    # Apple cider vinegar: attractive; DM1 (Or42b), DM4 (Or59b), DM2 (Or22a), VA2 (Or92a)
    # (Semmelhack & Wang 2009, Nature 459:218).
    "vinegar": ["ORN_DM1", "ORN_DM4", "ORN_DM2", "ORN_VA2"],
    # CO2: aversive; V glomerulus (Gr21a/Gr63a) (Suh et al. 2004, Nature 431:854).
    "co2": ["ORN_V"],
    # Geosmin: aversive; DA2 (Or56a) (Stensmyr et al. 2012, Cell 151:1345).
    "geosmin": ["ORN_DA2"],
}

# Labellar/pharyngeal taste neurons activated by food. MaleCNS v1.0 does not
# annotate taste-receptor identity for these types; these are the types that
# drive the proboscis motor neuron MN9 in this model (results/validation.md),
# the signature of sugar-sensing GRNs (Shiu et al. 2024).
TASTE_FOOD = ["LB3b", "LB3c", "LB3d", "LB4a", "PhG1a", "PhG1b", "PhG1c"]

# Looming-sensitive visual projection neurons (von Reyn et al. 2017, Nat Neurosci
# 20:1309; Ache et al. 2019, Curr Biol 29:1073). Driven per eye.
LOOMING = ["LC4", "LPLC2"]

# Descending / motor neurons read out as behavior.
MOTOR = {
    "forward": ["DNp09"],           # P9: forward walking (Bidaye et al. 2020, Neuron 108:469)
    "backward": ["MDN"],            # moonwalker: backward walking (Bidaye et al. 2014, Science 344:97)
    "turn": ["DNa02", "DNa01"],     # ipsilateral turning (Rayshubskiy et al. 2020, bioRxiv; Yang et al. 2024)
    "escape": ["DNp01"],            # Giant Fiber: takeoff (von Reyn et al. 2014, Nat Neurosci 17:962)
    "feed": ["MN9"],                # proboscis extension motor neuron (Gordon & Scott 2009, Neuron 61:373)
}


@dataclass
class Interface:
    c: Connectome
    odor: str = "vinegar"
    taste: list = field(default_factory=lambda: list(TASTE_FOOD))
    orn_max_hz: float = 80.0   # ORN peak firing, Hz
    orn_half: float = 0.3      # concentration giving half-maximal ORN rate
    grn_hz: float = 80.0
    loom_max_hz: float = 150.0
    loom_ref_deg_s: float = 1000.0  # expansion rate (deg/s) giving ~63% of loom_max_hz

    def __post_init__(self):
        c, nn = self.c, self.c.neurons
        side = nn["side"].to_numpy()
        self.orn = {s: (lambda i: i[side[i] == s])(c.select(type=ODORS[self.odor])) for s in "LR"}
        # ORNs whose antenna of origin is unknown follow the side of the AL they enter.
        self.grn = c.select(type=self.taste)
        self.loom = {s: (lambda i: i[side[i] == s])(c.select(type=LOOMING)) for s in "LR"}
        self.motor = {k: {s: (lambda i: i[side[i] == s])(c.select(type=v)) for s in "LR"}
                      for k, v in MOTOR.items()}
        self.readout = np.unique(np.concatenate([i for d in self.motor.values() for i in d.values()]))

    def sensory_rates(self, sense: dict) -> list[tuple[np.ndarray, float]]:
        """Map world readings to (neuron indices, Poisson rate in Hz) pairs."""
        out = []
        for s in "LR":
            conc = max(sense["odor"][s], 0.0)
            out.append((self.orn[s], self.orn_max_hz * conc / (conc + self.orn_half)))
            loom = max(sense["loom"][s], 0.0)
            out.append((self.loom[s], self.loom_max_hz * (1 - np.exp(-loom / self.loom_ref_deg_s))))
        out.append((self.grn, self.grn_hz if sense["taste"] else 0.0))
        return out

    def motor_rates(self, counts: np.ndarray, ms: float) -> dict:
        """Mean firing rate (Hz) of each motor group, per side."""
        return {k: {s: (counts[i].mean() / (ms * 1e-3) if len(i) else 0.0) for s, i in d.items()}
                for k, d in self.motor.items()}
