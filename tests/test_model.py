"""Engine tests on tiny hand-built networks (no connectome download needed)."""
import numpy as np
import pandas as pd

from flysim.data import Connectome, functional
from flysim.model import Brain, LIFParams


def net(edges, n, types=None, nt=None, superclass=None):
    """Connectome from (pre, post, signed weight) triples."""
    edges = sorted(edges)
    pre = np.array([e[0] for e in edges], int)
    indptr = np.zeros(n + 1, np.int64)
    np.cumsum(np.bincount(pre, minlength=n), out=indptr[1:])
    neurons = pd.DataFrame({
        "bodyId": np.arange(n) + 100, "type": types or [f"t{i}" for i in range(n)],
        "side": ["L"] * n, "nt": nt or ["acetylcholine"] * n,
        "superclass": superclass or ["cb_intrinsic"] * n,
    })
    return Connectome(neurons, indptr, np.array([e[1] for e in edges], np.int32),
                      np.array([e[2] for e in edges], np.float32))


def test_silent_without_input():
    b = Brain(net([(0, 1, 50)], 2))
    assert b.run(200).sum() == 0


def test_poisson_drive_sets_rate():
    b = Brain(net([], 1))
    b.set_rates([0], 100.0)
    hz = b.run(2000)[0] / 2.0
    # A Poisson kick is strong enough to occasionally cause two spikes.
    assert 90 < hz < 140


def test_excitation_inhibition_and_delay():
    # 0 excites 1 strongly; 2 inhibits 1.
    c = net([(0, 1, 60), (2, 1, -200)], 3)
    b = Brain(c, monitor=[0, 1])
    b.set_rates([0], 100.0)
    assert b.run(500)[1] > 10
    t, i = b.spike_events()
    first_pre, first_post = t[i == 0][0], t[i == 1][0]
    assert first_post - first_pre >= LIFParams().delay - 1e-9
    b.reset()
    b.set_rates([0, 2], 100.0)
    assert b.run(500)[1] < 3


def test_weak_input_stays_subthreshold():
    # 3 synapses * 0.275 mV cannot reach the 7 mV threshold.
    b = Brain(net([(0, 1, 3)], 2))
    b.set_rates([0], 100.0)
    assert b.run(500)[1] == 0


def test_short_term_depression_weakens_sustained_drive():
    c = net([(0, 1, 40)], 2)
    plain, stp = Brain(c), Brain(c, LIFParams(stp_u=0.3, tau_rec=500))
    for b in (plain, stp):
        b.set_rates([0], 150.0)
        b.run(500)  # let depression reach steady state
    assert stp.run(1000)[1] < 0.5 * plain.run(1000)[1]


def test_functional_edits():
    c = net([(0, 1, 5), (1, 2, 5), (2, 3, 5), (3, 0, 5)], 4,
            types=["KCg", "KCab", "PN", "ORN_DM1"], nt=["acetylcholine"] * 3 + ["unclear"],
            superclass=["cb_intrinsic"] * 3 + ["cb_sensory"])
    f = functional(c)
    w = dict(zip(zip(np.repeat(np.arange(4), np.diff(c.indptr)), f.post), f.w))
    assert w[(0, 1)] == 0      # KC -> KC
    assert w[(1, 2)] == 5      # KC -> PN kept
    assert w[(2, 3)] == 0      # onto a sensory neuron
    assert w[(3, 0)] == 0      # from an "unclear" transmitter neuron
    assert c.w.min() == 5      # original untouched


def _detailed(c, mod_edges=(), **kw):
    """Detailed-model wiring for a tiny net; mod_edges are (pre, post, count) from monoamine neurons."""
    from flysim.data import Modulatory
    from flysim.model import Detailed, DetailedParams
    n = c.n
    mod_edges = sorted(mod_edges)
    pre = np.array([e[0] for e in mod_edges], int)
    indptr = np.zeros(n + 1, np.int64)
    np.cumsum(np.bincount(pre, minlength=n), out=indptr[1:])
    m = Modulatory(indptr, np.array([e[1] for e in mod_edges], np.int32), np.array([e[2] for e in mod_edges], np.int32))
    return Detailed(c, m, DetailedParams(**kw))


def test_giant_fiber_gap_junction_drives_ttmn():
    # A weak chemical synapse alone cannot fire TTMn; the electrical one does, ~0.8 ms after each GF spike.
    c = net([(0, 1, 1)], 2, types=["DNp01", "TTMn"])
    std = Brain(c, monitor=[0, 1])
    std.set_rates([0], 100.0)
    assert std.run(500)[1] == 0
    det = Brain(c, monitor=[0, 1], detailed=_detailed(c))
    det.set_rates([0], 100.0)
    counts = det.run(500)
    assert counts[1] >= 0.8 * counts[0] > 0
    t, i = det.spike_events()
    first_gf = t[i == 0][0]
    assert 0.7 <= t[(i == 1) & (t > first_gf)][0] - first_gf <= 1.0


def test_dopamine_depresses_kc_to_mbon_only_when_paired():
    types = ["KC", "MBON01", "PAM01"]
    c = net([(0, 1, 40)], 3, types=types, nt=["acetylcholine", "acetylcholine", "dopamine"])
    d = _detailed(c, [(2, 1, 10)])
    # KC alone: no dopamine, no change.
    b = Brain(c, detailed=d)
    b.set_rates([0], 20.0)
    b.run(3000)
    assert b.f_kc.min() > 0.999
    # KC with its compartment's dopamine neuron: the synapse weakens.
    b = Brain(c, detailed=d)
    b.set_rates([0], 20.0)
    b.set_rates([2], 30.0)
    b.run(3000)
    assert b.f_kc[0] < 0.5


def test_octopamine_raises_excitability_with_a_cap():
    # 0 (octopamine) onto 1 with 100 synapses: the slow drive builds up to the cap.
    c = net([], 2, types=["OA-VUMa1", "t1"], nt=["octopamine", "acetylcholine"])
    b = Brain(c, detailed=_detailed(c, [(0, 1, 100)]))
    b.set_rates([0], 50.0)
    b.run(2000)
    assert 0.95 < b.mod[1] <= 1.0 + 1e-6  # saturates at mod_max (decaying a little between spikes)
