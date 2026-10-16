"""Load the MaleCNS v1.0 connectome and compile it into a signed sparse matrix.

Raw files (from gs://flyem-male-cns/v1.0/connectome-data/flat-connectome/):
  body-annotations-male-cns-v1.0-minconf-0.5.feather
  body-neurotransmitters-male-cns-v1.0.feather
  connectome-weights-male-cns-v1.0-minconf-0.5-traced-only.feather

The compiled cache (`connectome.npz` + `neurons.feather`) loads in ~1 s.
"""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

BUCKET = "gs://flyem-male-cns/v1.0/connectome-data/flat-connectome"
ANNOT = "body-annotations-male-cns-v1.0-minconf-0.5.feather"
NT = "body-neurotransmitters-male-cns-v1.0.feather"
WEIGHTS = "connectome-weights-male-cns-v1.0-minconf-0.5-traced-only.feather"
RAW_FILES = (ANNOT, NT, WEIGHTS)

DEFAULT_DATA_DIR = Path(os.environ.get("FLYSIM_DATA", Path(__file__).resolve().parent.parent / "data"))

# Sign of each fast transmitter in Drosophila. Glutamate acts mainly through the
# inhibitory GluCl channel and histamine through HisCl, so both are treated as
# inhibitory (as in Shiu et al. 2024, Nature 634:210). Monoamines act through
# slow metabotropic receptors; by default they are given no fast effect.
NT_SIGN = {
    "acetylcholine": 1.0,
    "gaba": -1.0,
    "glutamate": -1.0,
    "histamine": -1.0,
    "dopamine": 0.0,
    "serotonin": 0.0,
    "octopamine": 0.0,
    "tyramine": 0.0,
    "unclear": 1.0,  # most unresolved central neurons are cholinergic
}


def download(data_dir: Path = DEFAULT_DATA_DIR) -> None:
    """Fetch the three raw files (~570 MB) with gsutil if they are missing."""
    data_dir.mkdir(parents=True, exist_ok=True)
    missing = [f for f in RAW_FILES if not (data_dir / f).exists()]
    if not missing:
        return
    cmd = ["gsutil", "-m", "cp", *[f"{BUCKET}/{f}" for f in missing], str(data_dir)]
    print("Downloading:", " ".join(missing))
    subprocess.run(cmd, check=True)


@dataclass
class Connectome:
    """Neuron table plus a CSC-style matrix stored by presynaptic neuron.

    For presynaptic index j, its targets are post[indptr[j]:indptr[j+1]] with
    signed synapse counts w[indptr[j]:indptr[j+1]].
    """

    neurons: pd.DataFrame  # one row per simulated neuron, row index == model index
    indptr: np.ndarray
    post: np.ndarray
    w: np.ndarray

    @property
    def n(self) -> int:
        return len(self.neurons)

    @property
    def n_edges(self) -> int:
        return len(self.post)

    def index_of(self, body_ids) -> np.ndarray:
        lookup = pd.Series(np.arange(self.n), index=self.neurons.bodyId.values)
        return lookup.loc[list(body_ids)].to_numpy()

    def select(self, type=None, side=None, superclass=None, cls=None, regex=False) -> np.ndarray:
        """Model indices of neurons matching annotation filters.

        side matches somaSide, falling back to rootSide (sensory neurons have no soma in the CNS).
        type may be a string, list of strings, or regex (regex=True).
        """
        df = self.neurons
        m = np.ones(len(df), bool)
        if type is not None:
            if regex:
                m &= df["type"].fillna("").str.fullmatch(type).to_numpy()
            else:
                types = [type] if isinstance(type, str) else list(type)
                m &= df["type"].isin(types).to_numpy()
        if superclass is not None:
            m &= df["superclass"].eq(superclass).to_numpy()
        if cls is not None:
            m &= df["class"].eq(cls).to_numpy()
        if side is not None:
            m &= df["side"].eq(side).to_numpy()
        return np.flatnonzero(m)

    def outputs(self, j: int):
        s = slice(self.indptr[j], self.indptr[j + 1])
        return self.post[s], self.w[s]


def build(data_dir: Path = DEFAULT_DATA_DIR, nt_sign: dict | None = None) -> Connectome:
    """Compile raw feather files into the cached signed connectome."""
    nt_sign = {**NT_SIGN, **(nt_sign or {})}
    annot = pd.read_feather(data_dir / ANNOT)
    annot = annot[annot.status == "Traced"].copy()

    nt = pd.read_feather(data_dir / NT, columns=["body", "consensus_nt", "celltype_predicted_nt", "predicted_nt"])
    nt = nt.drop_duplicates("body").set_index("body")
    # Consensus (type-level vote, or ground truth) first, then per-body prediction.
    best = nt.consensus_nt.where(nt.consensus_nt.notna() & (nt.consensus_nt != "unclear"), nt.celltype_predicted_nt)
    best = best.where(best.notna(), nt.predicted_nt).fillna("unclear")
    annot["nt"] = annot.bodyId.map(best).fillna("unclear").to_numpy()

    w = pd.read_feather(data_dir / WEIGHTS, columns=["body_pre", "body_post", "weight"])
    keep = set(annot.bodyId)
    w = w[w.body_pre.isin(keep) & w.body_post.isin(keep)]

    annot = annot.sort_values("bodyId").reset_index(drop=True)
    side = annot.somaSide.where(annot.somaSide.isin(["L", "R"]), annot.rootSide)
    annot["side"] = side.where(side.isin(["L", "R"]), None)
    cols = ["bodyId", "type", "instance", "superclass", "class", "subclass", "side", "nt",
            "flywireType", "receptorType", "assignedOlHex1", "assignedOlHex2"]
    neurons = annot[cols].copy()

    idx = pd.Series(np.arange(len(neurons)), index=neurons.bodyId.values)
    pre = idx.loc[w.body_pre.values].to_numpy()
    post = idx.loc[w.body_post.values].to_numpy()
    sign = neurons.nt.map(lambda t: nt_sign.get(t, 1.0)).to_numpy(np.float32)
    weight = w.weight.to_numpy(np.float32) * sign[pre]

    nz = weight != 0
    pre, post, weight = pre[nz], post[nz], weight[nz]
    order = np.lexsort((post, pre))
    pre, post, weight = pre[order], post[order].astype(np.int32), weight[order]
    indptr = np.zeros(len(neurons) + 1, np.int64)
    np.cumsum(np.bincount(pre, minlength=len(neurons)), out=indptr[1:])
    return Connectome(neurons, indptr, post, weight)


def load(data_dir: Path = DEFAULT_DATA_DIR, rebuild: bool = False) -> Connectome:
    """Load the compiled connectome, downloading and compiling it on first use."""
    data_dir = Path(data_dir)
    cache, table = data_dir / "connectome.npz", data_dir / "neurons.feather"
    if cache.exists() and table.exists() and not rebuild:
        z = np.load(cache)
        return Connectome(pd.read_feather(table), z["indptr"], z["post"], z["w"])
    download(data_dir)
    c = build(data_dir)
    np.savez(cache, indptr=c.indptr, post=c.post, w=c.w)
    c.neurons.to_feather(table)
    return c


def functional(c: Connectome, drop_kc_kc: bool = True, drop_sensory_inputs: bool = True,
               drop_unclear: bool = True) -> Connectome:
    """Copy of `c` with edits that make the wiring diagram behave like a brain.

    drop_kc_kc: Kenyon cell -> Kenyon cell synapses are axo-axonal in the
        mushroom body lobes and do not drive KC spiking; left in, the ~1M of
        them ignite self-sustaining activity across all ~4,000 KCs.
    drop_sensory_inputs: synapses onto sensory neurons sit on their axon
        terminals (presynaptic modulation). Sensory spikes start in the
        periphery, so in this model only the environment drives sensory neurons.
    drop_unclear: neurons whose transmitter prediction is "unclear" get no fast
        effect instead of being assumed excitatory.
    """
    nn = c.neurons
    pre = np.repeat(np.arange(c.n), np.diff(c.indptr))
    cut = np.zeros(c.n_edges, bool)
    if drop_kc_kc:
        kc = nn["type"].fillna("").str.startswith("KC").to_numpy()
        cut |= kc[pre] & kc[c.post]
    if drop_sensory_inputs:
        sens = nn["superclass"].fillna("").str.contains("sensory").to_numpy()
        cut |= sens[c.post]
    if drop_unclear:
        cut |= (nn["nt"] == "unclear").to_numpy()[pre]
    w = c.w.copy()
    w[cut] = 0
    return Connectome(nn, c.indptr, c.post, w)


# Monoamine transmitters act through slow metabotropic receptors, so build() gives
# them no fast synapses. The "detailed" model uses their wiring separately.
MONOAMINES = ("dopamine", "serotonin", "octopamine")


@dataclass
class Modulatory:
    """Outputs of the monoamine neurons: for presynaptic index j, targets
    post[indptr[j]:indptr[j+1]] with synapse counts count[...] (all >0)."""

    indptr: np.ndarray
    post: np.ndarray
    count: np.ndarray


def modulatory(c: Connectome, data_dir: Path = DEFAULT_DATA_DIR) -> Modulatory:
    """Synapses made by dopamine, serotonin and octopamine neurons (cached)."""
    data_dir = Path(data_dir)
    cache = data_dir / "modulatory.npz"
    if cache.exists():
        z = np.load(cache)
        return Modulatory(z["indptr"], z["post"], z["count"])
    mono = c.neurons.bodyId[c.neurons.nt.isin(MONOAMINES)]
    w = pd.read_feather(data_dir / WEIGHTS, columns=["body_pre", "body_post", "weight"])
    w = w[w.body_pre.isin(set(mono)) & w.body_post.isin(set(c.neurons.bodyId))]
    idx = pd.Series(np.arange(c.n), index=c.neurons.bodyId.values)
    pre = idx.loc[w.body_pre.values].to_numpy()
    post = idx.loc[w.body_post.values].to_numpy().astype(np.int32)
    count = w.weight.to_numpy(np.int32)
    order = np.lexsort((post, pre))
    pre, post, count = pre[order], post[order], count[order]
    indptr = np.zeros(c.n + 1, np.int64)
    np.cumsum(np.bincount(pre, minlength=c.n), out=indptr[1:])
    np.savez(cache, indptr=indptr, post=post, count=count)
    return Modulatory(indptr, post, count)
