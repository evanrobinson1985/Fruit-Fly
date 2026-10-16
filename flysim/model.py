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


@dataclass
class DetailedParams:
    """Extra biology for the "detailed" model (see make_detailed)."""
    # Octopamine: slow depolarizing drive on each target, per synapse per spike
    # (OAMB / Octβ receptors raise cAMP and excitability; arousal, flight).
    oa_w: float = 0.02       # mV per synapse per spike
    tau_mod: float = 1000.0  # ms, decay of the slow modulatory drive
    mod_max: float = 1.0     # mV, most it can depolarize a neuron (receptors saturate)
    # Mushroom body: KC -> MBON synapses depress when the KC fires while the
    # dopamine neurons of that MBON's compartment are active, and recover slowly.
    mb_eta: float = 1e-3     # fractional depression per KC spike per unit dopamine
    tau_dan: float = 1000.0  # ms, dopamine trace (in spikes) at each compartment
    tau_mem: float = 300.0   # s, recovery of depressed KC -> MBON synapses
    # Giant Fiber electrical synapses onto TTMn and PSI (shakB gap junctions): each
    # GF spike arrives as a brief depolarization, so TTMn follows it one-for-one at
    # the measured ~0.8 ms latency (Tanouye & Wyman 1980) instead of the chemical delay.
    gap_v: float = 10.0      # mV step in the target
    gap_delay: float = 0.8   # ms (conduction to the thoracic ganglion)


@numba.njit(cache=True, fastmath=True)
def _run_detailed(n_steps, t0, v, g, a_ad, x_stp, ref, buf, indptr, post, w, drive_idx, drive_p, poi_kick,
                  dt_tau_m, decay_syn, decay_ad, b_ad, rec_stp, u_stp, v0, v_reset, v_th, ref_steps, w_syn, counts,
                  mod, decay_mod, mod_max, m_indptr, m_post, m_w,
                  kc_start, mbon_of, f_kc, f_step, d_indptr, d_post, d_w, dm, dm_step, mb_eta, dt_dan, dt_mem,
                  gap_indptr, gap_post, gap_w, vbuf, mon_mask, mon_t, mon_i, mon_n):
    n = v.shape[0]
    D = buf.shape[0]
    DG = vbuf.shape[0]
    spk = np.empty(n, np.int32)
    for s in range(n_steps):
        t = t0 + s
        slot = t % D
        row = buf[slot]
        vrow = vbuf[t % DG]
        for k in range(drive_idx.shape[0]):
            if np.random.random() < drive_p[k]:
                g[drive_idx[k]] += poi_kick
        ns = 0
        for i in range(n):
            gi = g[i] * decay_syn + row[i]
            g[i] = gi if (gi > 1e-6 or gi < -1e-6) else 0.0
            row[i] = 0.0
            if vrow[i] != 0.0:
                if ref[i] == 0:
                    v[i] += vrow[i]
                vrow[i] = 0.0
            if a_ad[i] != 0.0:
                a_ad[i] = a_ad[i] * decay_ad if a_ad[i] > 1e-6 else 0.0
            if mod[i] != 0.0:
                mod[i] = mod[i] * decay_mod if (mod[i] > 1e-6 or mod[i] < -1e-6) else 0.0
            if x_stp[i] < 1.0:
                x_stp[i] = min(1.0, x_stp[i] + (1.0 - x_stp[i]) * rec_stp + 1e-7)
            if ref[i] > 0:
                ref[i] -= 1
                continue
            v[i] += dt_tau_m * (g[i] - (v[i] - v0) - a_ad[i] + mod[i])
            if v[i] > v_th:
                v[i] = v_reset
                a_ad[i] += b_ad
                ref[i] = ref_steps
                spk[ns] = i
                ns += 1
        tgt = buf[slot]
        for a in range(ns):
            j = spk[a]
            counts[j] += 1
            if mon_mask[j] and mon_n[0] < mon_t.shape[0]:
                mon_t[mon_n[0]] = t
                mon_i[mon_n[0]] = j
                mon_n[0] += 1
            scale = w_syn * x_stp[j]
            x_stp[j] -= u_stp * x_stp[j]
            kc = kc_start[j]
            for e in range(indptr[j], indptr[j + 1]):
                q = post[e]
                if kc >= 0 and mbon_of[q] >= 0:
                    # Plastic KC -> MBON synapse: recover, then depress by the local dopamine.
                    mb = mbon_of[q]
                    fk = 1.0 - (1.0 - f_kc[kc]) * np.exp(-(t - f_step[kc]) * dt_mem)
                    d = dm[mb] * np.exp(-(t - dm_step[mb]) * dt_dan)
                    fk -= mb_eta * d * fk
                    f_kc[kc] = fk
                    f_step[kc] = t
                    tgt[q] += w[e] * scale * fk
                    kc += 1
                else:
                    tgt[q] += w[e] * scale
            # Monoamine outputs: slow drive (octopamine) and dopamine traces at MBONs.
            for e in range(m_indptr[j], m_indptr[j + 1]):
                q = m_post[e]
                mod[q] = min(mod_max, mod[q] + m_w[e])
            for e in range(d_indptr[j], d_indptr[j + 1]):
                mb = d_post[e]
                dm[mb] = dm[mb] * np.exp(-(t - dm_step[mb]) * dt_dan) + d_w[e]
                dm_step[mb] = t
            # Electrical synapses: a voltage step DG steps later.
            for e in range(gap_indptr[j], gap_indptr[j + 1]):
                vbuf[(t + DG) % DG][gap_post[e]] += gap_w[e]
    return t0 + n_steps


class Detailed:
    """Wiring for the detailed model, built from the full and functional connectomes."""

    def __init__(self, c: Connectome, mod, p: DetailedParams | None = None):
        from .data import Connectome as _C  # noqa: F401
        self.p = p = p or DetailedParams()
        nn, n = c.neurons, c.n
        nt = nn.nt.to_numpy()
        ty = nn["type"].fillna("").to_numpy().astype(str)
        pre = np.repeat(np.arange(n), np.diff(mod.indptr))
        # Octopamine: slow excitation of every target.
        oa = nt[pre] == "octopamine"
        keep = oa
        self.m_indptr = np.zeros(n + 1, np.int64)
        np.cumsum(np.bincount(pre[keep], minlength=n), out=self.m_indptr[1:])
        self.m_post = mod.post[keep].astype(np.int32)
        self.m_w = (mod.count[keep] * p.oa_w).astype(np.float32)
        # Mushroom body: each MBON's dopamine is the DANs that synapse onto it,
        # weighted by synapse count and normalized to sum 1.
        is_kc, is_mbon = np.char.startswith(ty, "KC"), np.char.startswith(ty, "MBON")
        self.mbon_of = np.full(n, -1, np.int32)
        mbons = np.flatnonzero(is_mbon)
        self.mbon_of[mbons] = np.arange(len(mbons))
        da = (nt[pre] == "dopamine") & is_mbon[mod.post]
        dpre, dpost, dcount = pre[da], self.mbon_of[mod.post[da]], mod.count[da].astype(np.float64)
        tot = np.bincount(dpost, weights=dcount, minlength=len(mbons))
        self.d_indptr = np.zeros(n + 1, np.int64)
        np.cumsum(np.bincount(dpre, minlength=n), out=self.d_indptr[1:])
        self.d_post = dpost.astype(np.int32)
        self.d_w = (dcount / tot[dpost]).astype(np.float32)
        self.n_mbon = len(mbons)
        # Index of each KC's first KC -> MBON synapse in f (they are taken in row order).
        self.c = c
        self.kc_start = np.full(n, -1, np.int64)
        cpre = np.repeat(np.arange(n), np.diff(c.indptr))
        plastic = is_kc[cpre] & is_mbon[c.post]
        per = np.bincount(cpre[plastic], minlength=n)
        start = np.concatenate([[0], np.cumsum(per)[:-1]])
        self.kc_start[is_kc & (per > 0)] = start[is_kc & (per > 0)]
        self.n_plastic = int(plastic.sum())
        # Giant Fiber gap junctions onto TTMn and PSI, where the connectome links them.
        gf = np.flatnonzero(ty == "DNp01")
        rows = [(j, q) for j in gf for q in c.post[c.indptr[j]:c.indptr[j + 1]] if ty[q] in ("TTMn", "PSI")]
        gpre = np.array([r[0] for r in rows], np.int64)
        self.gap_indptr = np.zeros(n + 1, np.int64)
        np.cumsum(np.bincount(gpre, minlength=n), out=self.gap_indptr[1:])
        self.gap_post = np.array([r[1] for r in rows], np.int32)
        self.gap_w = np.full(len(rows), p.gap_v, np.float32)

    def memory(self, f) -> float:
        """Mean depression of the KC -> MBON synapses (0 = naive)."""
        return float(1 - f.mean()) if len(f) else 0.0


class Brain:
    """The whole connectome as a spiking network.

    >>> brain = Brain(connectome)
    >>> brain.set_rates(idx, 150.0)      # Poisson drive in Hz
    >>> counts = brain.run(200.0)        # spikes per neuron in the next 200 ms
    """

    def __init__(self, c: Connectome, params: LIFParams | None = None, seed: int = 0, monitor=None,
                 max_events: int = 2_000_000, detailed: Detailed | None = None):
        self.c = c
        self.detailed = detailed
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
        if self.detailed is not None:
            d = self.detailed
            self.mod = np.zeros(self.n, np.float32)
            self.f_kc = np.ones(d.n_plastic, np.float32)   # KC -> MBON strength (1 = naive)
            self.f_step = np.zeros(d.n_plastic, np.int64)
            self.dm = np.zeros(d.n_mbon, np.float32)        # dopamine trace per MBON
            self.dm_step = np.zeros(d.n_mbon, np.int64)
            self.vbuf = np.zeros((max(1, int(round(d.p.gap_delay / p.dt))), self.n), np.float32)
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
        if self.detailed is not None:
            d, dp = self.detailed, self.detailed.p
            self.step = _run_detailed(
                n_steps, self.step, self.v, self.g, self.a, self.x, self.ref, self.buf,
                self.c.indptr, self.c.post, self.c.w, drive_idx, drive_p,
                np.float32(p.f_poi * p.w_syn), np.float32(p.dt / p.tau_m), np.float32(np.exp(-p.dt / p.tau_syn)),
                np.float32(np.exp(-p.dt / p.tau_adapt)), np.float32(p.adapt),
                np.float32(p.dt / p.tau_rec), np.float32(p.stp_u), np.float32(p.v0), np.float32(p.v_reset),
                np.float32(p.v_th), self.ref_steps, np.float32(p.w_syn), counts,
                self.mod, np.float32(np.exp(-p.dt / dp.tau_mod)), np.float32(dp.mod_max), d.m_indptr, d.m_post, d.m_w,
                d.kc_start, d.mbon_of, self.f_kc, self.f_step, d.d_indptr, d.d_post, d.d_w, self.dm, self.dm_step,
                np.float32(dp.mb_eta), p.dt / dp.tau_dan, p.dt / (dp.tau_mem * 1000.0),
                d.gap_indptr, d.gap_post, d.gap_w, self.vbuf, self.mon_mask, self.mon_t, self.mon_i, self.mon_n)
            self.total_counts += counts
            return counts
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
# "realistic": adds short-term synaptic depression, spike-frequency adaptation and
# the connectome edits in data.functional(). Activity stays stimulus-locked and
# decays after the input ends, which closed-loop behavior needs. Adaptation
# (1 mV per spike, 200 ms) stops the antennal lobe's excitatory local neurons
# (lLN1_bc) from locking into ~250 Hz self-sustained firing under background input.
PRESETS = {
    "shiu2024": (dict(), dict(drop_kc_kc=False, drop_sensory_inputs=False, drop_unclear=False)),
    "realistic": (dict(stp_u=0.2, tau_rec=500.0, adapt=1.0, tau_adapt=200.0), dict()),
}


def make_brain(c: Connectome, preset: str = "realistic", seed: int = 0, monitor=None, **params) -> Brain:
    """Build a Brain from a raw connectome using a named preset; `params` override LIFParams."""
    p, edits = PRESETS[preset]
    return Brain(functional(c, **edits), LIFParams(**{**p, **params}), seed=seed, monitor=monitor)


def make_detailed(c: Connectome, seed: int = 0, dparams: DetailedParams | None = None, monitor=None, **params) -> Brain:
    """The "realistic" preset plus octopamine neuromodulation, dopamine-gated plasticity
    of the mushroom body's KC -> MBON synapses, and the Giant Fiber's electrical synapses."""
    from .data import modulatory
    p, edits = PRESETS["realistic"]
    fc = functional(c, **edits)
    return Brain(fc, LIFParams(**{**p, **params}), seed=seed, monitor=monitor, detailed=Detailed(fc, modulatory(c), dparams))
