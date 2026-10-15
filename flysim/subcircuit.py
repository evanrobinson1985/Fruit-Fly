"""Cut a smaller, self-contained circuit out of the connectome.

Keeps every neuron that lies on a short, strong path from a set of input
neurons to a set of output neurons, plus all connections (of any strength)
among the kept neurons. Used for the watch game, where the full 165k-neuron
network is too heavy for the battery; see watch/README.md for how closely the
cut circuit matches the full brain.
"""
from __future__ import annotations

import numpy as np

from .data import Connectome


def _hops(start, src, dst, n, max_hops, mask):
    """Shortest path length (in synapses) from `start` along src->dst edges in `mask`."""
    dist = np.full(n, np.iinfo(np.int16).max, np.int32)
    dist[start] = 0
    front = np.zeros(n, bool)
    front[start] = True
    for d in range(1, max_hops + 1):
        nxt = np.zeros(n, bool)
        nxt[dst[mask & front[src]]] = True
        nxt &= dist > d
        dist[nxt] = d
        front = nxt
    return dist


def select(c: Connectome, inputs, outputs, min_synapses: int = 8, max_hops: int = 3) -> np.ndarray:
    """Indices of neurons on input->output paths of at most `max_hops` + 1 synapses,
    using only connections with at least `min_synapses` synapses."""
    pre = np.repeat(np.arange(c.n), np.diff(c.indptr))
    post = c.post.astype(np.int64)
    strong = np.abs(c.w) >= min_synapses
    f = _hops(inputs, pre, post, c.n, max_hops, strong)
    b = _hops(outputs, post, pre, c.n, max_hops, strong)
    keep = f + b <= max_hops + 1
    keep[inputs] = True
    keep[outputs] = True
    return np.flatnonzero(keep)


def subset(c: Connectome, keep_idx: np.ndarray) -> tuple[Connectome, np.ndarray]:
    """Induced sub-network on `keep_idx`. Returns it and an old->new index map (-1 = dropped)."""
    keep = np.zeros(c.n, bool)
    keep[keep_idx] = True
    newid = np.full(c.n, -1, np.int64)
    newid[keep_idx] = np.arange(len(keep_idx))
    pre = np.repeat(np.arange(c.n), np.diff(c.indptr))
    m = keep[pre] & keep[c.post] & (c.w != 0)
    p, q, w = newid[pre[m]], newid[c.post[m]], c.w[m]
    order = np.lexsort((q, p))
    p, q, w = p[order], q[order], w[order]
    indptr = np.zeros(len(keep_idx) + 1, np.int64)
    np.cumsum(np.bincount(p, minlength=len(keep_idx)), out=indptr[1:])
    neurons = c.neurons.iloc[keep_idx].reset_index(drop=True)
    return Connectome(neurons, indptr, q.astype(np.int32), w.astype(np.float32)), newid
