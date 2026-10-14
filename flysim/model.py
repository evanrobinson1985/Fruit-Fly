"""Leaky integrate-and-fire network driven by the connectome.

Follows the whole-brain model of Shiu et al. 2024 ("A Drosophila computational
brain model reveals sensorimotor processing", Nature 634:210), which showed that
this simple model, wired only from the connectome, predicts real circuit
activity (e.g. sugar neurons -> proboscis motor neuron MN9) well:

    dv/dt = (g - (v - v0)) / tau_m        (frozen while refractory)
    dg/dt = -g / tau_syn
    spike when v > v_th: v <- v_reset; after `delay`, every target gets
    g += w_syn * signed_synapse_count

Sensory drive is Poisson input spikes onto g with weight f_poi * w_syn.
"""
from __future__ import annotations

from dataclasses import dataclass

import numba
import numpy as np

from .data import Connectome, functional


@dataclass
class LIFParams:
    dt: float = 0.1          # ms
    v0: float = -52.0        # resting potential, mV
    v_reset: float = -52.0   # mV
    v_th: float = -45.0      # mV
    tau_m: float = 20.0      # membrane time constant, ms
    tau_syn: float = 5.0     # synaptic time constant, ms
    t_ref: float = 2.2       # refractory period, ms
    delay: float = 1.8       # synaptic delay, ms
    w_syn: float = 0.275     # mV per synapse
    f_poi: float = 250.0     # Poisson input strength, in units of w_syn
    # Spike-frequency adaptation (not in Shiu et al.; 0 disables it). Each spike
    # adds `adapt` mV of hyperpolarizing drive that decays with `tau_adapt`.
    adapt: float = 0.0       # mV
    tau_adapt: float = 200.0 # ms
    # Short-term synaptic depression (not in Shiu et al.; 0 disables it). Each
    # neuron's output strength x starts at 1, drops by fraction `stp_u` per
    # spike and recovers with `tau_rec`. The first spike after rest has the
    # full weight, so onset responses match the plain model.
    stp_u: float = 0.0
    tau_rec: float = 500.0   # ms


@numba.njit(cache=True)
def _seed(s):
    np.random.seed(s)


@numba.njit(cache=True, fastmath=True)
def _run(n_steps, t0, v, g, a_ad, x_stp, ref, buf, indptr, post, w, drive_idx, drive_p, poi_kick,
         dt_tau_m, decay_syn, decay_ad, b_ad, rec_stp, u_stp, v0, v_reset, v_th, ref_steps, w_syn, counts, mon_mask, mon_t, mon_i, mon_n):
    n = v.shape[0]
    D = buf.shape[0]
    spk = np.empty(n, np.int32)
    for s in range(n_steps):
        t = t0 + s
        slot = t % D
        row = buf[slot]
        # Sensory Poisson input.
        for k in range(drive_idx.shape[0]):
            if np.random.random() < drive_p[k]:
                g[drive_idx[k]] += poi_kick
        ns = 0
        for i in range(n):
            gi = g[i] * decay_syn + row[i]
            g[i] = gi if (gi > 1e-6 or gi < -1e-6) else 0.0  # avoid slow denormals
            row[i] = 0.0
            if a_ad[i] != 0.0:
                a_ad[i] = a_ad[i] * decay_ad if a_ad[i] > 1e-6 else 0.0
            if x_stp[i] < 1.0:
                x_stp[i] = min(1.0, x_stp[i] + (1.0 - x_stp[i]) * rec_stp + 1e-7)
            if ref[i] > 0:
                ref[i] -= 1
                continue
            v[i] += dt_tau_m * (g[i] - (v[i] - v0) - a_ad[i])
            if v[i] > v_th:
                v[i] = v_reset
                a_ad[i] += b_ad
                ref[i] = ref_steps
                spk[ns] = i
                ns += 1
        # Deliver this step's spikes `delay` steps into the future.
        tgt = buf[slot]  # slot was just cleared; it is next used D steps from now
        for a in range(ns):
            j = spk[a]
            counts[j] += 1
            if mon_mask[j] and mon_n[0] < mon_t.shape[0]:
                mon_t[mon_n[0]] = t
                mon_i[mon_n[0]] = j
                mon_n[0] += 1
            scale = w_syn * x_stp[j]
            x_stp[j] -= u_stp * x_stp[j]
            for e in range(indptr[j], indptr[j + 1]):
                tgt[post[e]] += w[e] * scale
    return t0 + n_steps


class Brain:
    """The whole connectome as a spiking network.

    >>> brain = Brain(connectome)
    >>> brain.set_rates(idx, 150.0)      # Poisson drive in Hz
    >>> counts = brain.run(200.0)        # spikes per neuron in the next 200 ms
    """

    def __init__(self, c: Connectome, params: LIFParams | None = None, seed: int = 0, monitor=None,
                 max_events: int = 2_000_000):
        self.c = c
        self.p = p = params or LIFParams()
        self.n = c.n
        self.delay_steps = max(1, int(round(p.delay / p.dt)))
        self.ref_steps = int(round(p.t_ref / p.dt))
        self.rates = np.zeros(self.n, np.float64)
        self.mon_mask = np.zeros(self.n, np.bool_)
        if monitor is not None:
            self.mon_mask[np.asarray(monitor)] = True
        self.max_events = max_events
        self.seed = seed
        self.reset()

    def reset(self):
        p = self.p
        self.v = np.full(self.n, p.v0, np.float32)
        self.g = np.zeros(self.n, np.float32)
        self.a = np.zeros(self.n, np.float32)
        self.x = np.ones(self.n, np.float32)
        self.ref = np.zeros(self.n, np.int32)
        # Ring buffer slot t % D holds input arriving at step t; spikes at step t
        # write to the slot just consumed, which comes round again at t + D.
        self.buf = np.zeros((self.delay_steps, self.n), np.float32)
        self.step = 0
        self.total_counts = np.zeros(self.n, np.int64)
        self.mon_t = np.zeros(self.max_events, np.int64)
        self.mon_i = np.zeros(self.max_events, np.int32)
        self.mon_n = np.zeros(1, np.int64)
        _seed(self.seed)

    @property
    def time_ms(self) -> float:
        return self.step * self.p.dt

    def set_rates(self, idx, hz):
        self.rates[np.asarray(idx)] = hz

    def clear_rates(self):
        self.rates[:] = 0.0

    def run(self, ms: float) -> np.ndarray:
        """Advance `ms` milliseconds; return spike counts per neuron in that window."""
        p = self.p
        n_steps = int(round(ms / p.dt))
        drive_idx = np.flatnonzero(self.rates > 0).astype(np.int64)
        drive_p = (self.rates[drive_idx] * p.dt * 1e-3).astype(np.float64)
        counts = np.zeros(self.n, np.int64)
        self.step = _run(n_steps, self.step, self.v, self.g, self.a, self.x, self.ref, self.buf,
                         self.c.indptr, self.c.post, self.c.w, drive_idx, drive_p,
                         np.float32(p.f_poi * p.w_syn), np.float32(p.dt / p.tau_m),
                         np.float32(np.exp(-p.dt / p.tau_syn)),
                         np.float32(np.exp(-p.dt / p.tau_adapt)), np.float32(p.adapt),
                         np.float32(p.dt / p.tau_rec), np.float32(p.stp_u), np.float32(p.v0), np.float32(p.v_reset),
                         np.float32(p.v_th), self.ref_steps, np.float32(p.w_syn), counts,
                         self.mon_mask, self.mon_t, self.mon_i, self.mon_n)
        self.total_counts += counts
        return counts

    def spike_events(self):
        """(time_ms, neuron_index) for monitored neurons since the last reset."""
        n = self.mon_n[0]
        return self.mon_t[:n] * self.p.dt, self.mon_i[:n]


def rate_hz(counts: np.ndarray, idx, ms: float) -> np.ndarray:
    return counts[np.asarray(idx)] / (ms * 1e-3)


# "shiu2024": the published model unchanged. It works for brief probes from rest,
# but on the full male CNS (brain + VNC + optic lobes) it falls into
# self-sustaining whole-brain activity within a few hundred ms of any olfactory
# or gustatory input.
# "realistic": adds short-term synaptic depression and the connectome edits in
# data.functional(). Activity stays stimulus-locked and decays after the input
# ends, which closed-loop behavior needs.
PRESETS = {
    "shiu2024": (dict(), dict(drop_kc_kc=False, drop_sensory_inputs=False, drop_unclear=False)),
    "realistic": (dict(stp_u=0.2, tau_rec=500.0), dict()),
}


def make_brain(c: Connectome, preset: str = "realistic", seed: int = 0, monitor=None, **params) -> Brain:
    """Build a Brain from a raw connectome using a named preset; `params` override LIFParams."""
    p, edits = PRESETS[preset]
    return Brain(functional(c, **edits), LIFParams(**{**p, **params}), seed=seed, monitor=monitor)
