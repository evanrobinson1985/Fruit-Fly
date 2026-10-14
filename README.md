# Fruit-Fly: a closed-loop whole-CNS fly simulation

A spiking simulation of the entire adult male *Drosophila* central nervous system
(brain, optic lobes and ventral nerve cord) wired from the
[MaleCNS v1.0 connectome](https://male-cns.janelia.org) (Janelia/Google, CC-BY).
It covers 165,122 proofread neurons and 24.9 million connections. The simulated
fly walks in a 2D arena: it smells odors, tastes food and sees looming threats,
and its descending neurons steer its body.

```
world ──► sensory neurons ──► 165k-neuron LIF network ──► descending/motor neurons ──► body
 ▲   (ORNs, taste GRNs, LC4/LPLC2)                     (P9, MDN, DNa01/02, Giant Fiber, MN9)  │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
```

| Escape from a looming threat | Taste → proboscis extension → feeding |
|---|---|
| ![escape](results/escape-realistic.gif) | ![feed](results/feed-realistic.gif) |

## Quick start

```bash
pip install -r requirements.txt
# Google Cloud CLI (gsutil) is needed once to fetch ~570 MB of connectome data into data/
python -m flysim download
python -m flysim escape --seconds 3 --gif     # looming disc -> Giant Fiber -> takeoff
python -m flysim feed --seconds 3 --gif       # standing on food -> MN9 -> feeding bout
python -m flysim forage --seconds 15          # vinegar plume + food patch
python -m flysim explore --seconds 5
python experiments/validate.py                # circuit checks -> results/validation.md
pytest tests
```

Each run writes `results/<scenario>-<preset>.{csv,png[,gif]}`: the trajectory,
sensory input, motor-neuron rates and a spike raster. The simulation runs about
5× slower than real time on 4 CPU cores. The first run compiles a cached matrix
in `data/`, which takes about 25 s.

## How it works

**Connectome** (`flysim/data.py`). The loader downloads the flat-connectome
feather files from `gs://flyem-male-cns/v1.0/connectome-data/flat-connectome/`
and keeps the `Traced` neurons. Each connection's synapse count is signed by
the presynaptic neuron's predicted transmitter: acetylcholine is excitatory;
GABA, glutamate (GluCl) and histamine are inhibitory; monoamines have no fast effect.

**Neurons** (`flysim/model.py`). The network uses the leaky integrate-and-fire
model and parameters of
[Shiu et al. 2024, *Nature* 634:210](https://www.nature.com/articles/s41586-024-07763-9).
That paper showed this model, wired only from a connectome, predicts real
sensorimotor circuits. The parameters are v_rest = −52 mV, threshold −45 mV,
τ_m = 20 ms, τ_syn = 5 ms, 0.275 mV per synapse, 1.8 ms delay and 2.2 ms
refractory period. The model is compiled with numba, with an event-driven
spike propagation step.

**Presets.** Running the published model unchanged on the full male CNS
(`--preset shiu2024`) fails: within ~300 ms of almost any olfactory or taste
input, 10–20k neurons lock into self-sustaining activity that never stops (see
`results/validation.md`). The default `realistic` preset adds four
biologically motivated changes:

1. **Short-term synaptic depression** (U = 0.2, τ_rec = 500 ms). Fly synapses
   depress strongly (e.g. ORN→PN, Kazama & Wilson 2008). The first spike after
   rest has the full Shiu weight, so onset responses are unchanged.
2. **No KC→KC synapses.** These ~1.15M axo-axonal synapses in the mushroom body
   lobes otherwise ignite all ~4,000 Kenyon cells.
3. **No synapses onto sensory neurons.** These sit on axon terminals, and sensory
   spikes start in the periphery.
4. **"Unclear" transmitter neurons get zero sign** instead of being assumed excitatory.

**Senses and motors** (`flysim/interface.py`). These are hand-built links,
each with a literature citation in the code:

| world | neurons driven |
|---|---|
| odor at each antenna (vinegar / CO₂ / geosmin) | ORNs of the matching glomeruli, by antenna of origin |
| standing on food | labellar/pharyngeal taste neurons that drive MN9 |
| looming disc, per eye | LC4 and LPLC2 |

| neurons read out | behavior |
|---|---|
| DNp09 (P9) | forward walking speed |
| MDN | backward walking |
| DNa02, DNa01 (left − right) | turning |
| DNp01 (Giant Fiber) | takeoff away from the threat |
| MN9 | proboscis extension → feeding bout |

**Body** (`flysim/body.py`). The body is kinematic, with realistic speeds. When
no descending commands arrive, the fly explores with a slow random walk. This
stands in for the VNC's own walking rhythm, which the model does not generate.

## What the model reproduces, and what it does not

Validated (`results/validation.md`, `realistic` preset):

- **Looming escape.** LC4 or LPLC2 input drives the Giant Fiber at 175–205 Hz,
  which in turn drives the flight motor neurons (DLMn). Proboscis and walking
  neurons stay silent. In closed loop the fly takes off 170–190 ms before a
  simulated collision.
- **Feeding.** A subset of taste-neuron types (LB3b–d, LB4a, PhG1a–c) drives MN9.
  The release does not label which taste types are sugar-sensing, so these
  types were selected because they drive MN9 in this model.
- **Stability.** For most inputs, activity stops within 300 ms of the stimulus
  ending. The exception is vinegar ORNs and two taste types, which leave about
  200 antennal-lobe neurons (mainly the excitatory local neurons lLN1_bc)
  firing.

Limits to keep in mind:

- **Odor tracking does not emerge.** Vinegar ORNs drive bursts in MDN, DNa01/02
  and other descending neurons, but nearly symmetrically. The fly does not reliably
  steer up a gradient. Real chemotaxis likely depends on things a connectome
  doesn't contain: graded (non-spiking) neurons, tonic background activity,
  neuromodulation and learned synaptic strengths.
- **MN9 responds on the left only.** In this release, MN9_R receives far fewer
  synapses from its main premotor input (GNG120: 25 vs 418). This is likely
  incomplete reconstruction, and the simulation inherits it.
- **No vision below LC4/LPLC2.** The photoreceptor-to-lamina path is
  histaminergic and graded, which a spiking model at rest cannot represent, so
  looming is injected at the visual projection neurons.
- **Fast synapses only.** The model has no gap junctions, neuromodulation or plasticity.

To change any mapping, edit the tables in `flysim/interface.py`. To change the
model, pass parameters to `make_brain`:

```python
from flysim import data, model
c = data.load()
brain = model.make_brain(c, "realistic", stp_u=0.3)
brain.set_rates(c.select(type="LC4"), 150.0)
counts = brain.run(200.0)                    # spikes per neuron in 200 ms
print(model.rate_hz(counts, c.select(type="DNp01"), 200.0))
```

## Data credit

MaleCNS v1.0, HHMI Janelia FlyEM and Google Research, released under CC-BY 4.0.
See https://male-cns.janelia.org for citation details.
