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


# Spontaneous firing of sensory neurons with no stimulus (Hz), by annotation class.
# Real sensory neurons are never silent: ORNs fire spontaneously at ~1-20 Hz
# depending on receptor type (de Bruyne et al. 2001, Neuron 30:537); proprioceptors
# fire tonically with posture. The other values are low assumed rates. Photoreceptors
# (graded, non-spiking) get none. This background keeps the brain active at rest, so
# behavior can start on its own.
SPONTANEOUS_HZ = {
    "olfactory": 2.0,
    "proprioceptive": 4.0,   # chordotonal organs, campaniform sensilla, hair plates
    "mechanosensory": 3.0,   # Johnston's organ (wind, gravity, sound), grooming
    "other": 1.0,            # tactile bristles, taste, hygro/thermo, unknown
}


def spontaneous_rates(neurons) -> np.ndarray:
    """Background Poisson rate (Hz) for every neuron in `neurons`."""
    sc = neurons["superclass"].fillna("")
    cl = neurons["class"].fillna("")
    sensory = (sc.str.contains("sensory") & ~sc.eq("ol_sensory")).to_numpy()
    rate = np.zeros(len(neurons))
    rate[sensory] = SPONTANEOUS_HZ["other"]
    rate[sensory & cl.eq("olfactory").to_numpy()] = SPONTANEOUS_HZ["olfactory"]
    rate[sensory & cl.str.contains("proprioceptive").to_numpy()] = SPONTANEOUS_HZ["proprioceptive"]
    rate[sensory & cl.eq("mechanosensory").to_numpy()] = SPONTANEOUS_HZ["mechanosensory"]
    return rate


def motor_pools(neurons) -> dict:
    """Motor-neuron pools in the ventral nerve cord, read directly as behavior.

    legs: front/middle/hind leg motor neurons per side -> walking vigor and turning.
    jump: tergotrochanteral motor neurons (TTMn), the jump muscle of escape takeoff.
    flight: indirect flight-muscle motor neurons (DLMn, DVMn) -> wing power.
    wing: all wing motor neurons per side -> steering in flight.
    """
    ty = neurons["type"].fillna("")
    sub = neurons["subclass"].fillna("")
    side = neurons["side"].to_numpy()
    leg = sub.isin(["fl", "ml", "hl"]).to_numpy()
    wing = sub.eq("wm").to_numpy()
    return {
        "legs": {s: np.flatnonzero(leg & (side == s)) for s in "LR"},
        "jump": {s: np.flatnonzero(ty.eq("Tergotr. MN").to_numpy() & (side == s)) for s in "LR"},
        "flight": {s: np.flatnonzero((ty.str.startswith("DLMn") | ty.str.startswith("DVMn")).to_numpy() & (side == s)) for s in "LR"},
        "wing": {s: np.flatnonzero(wing & (side == s)) for s in "LR"},
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
