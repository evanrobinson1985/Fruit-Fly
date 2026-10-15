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

## In the browser

**Live page:** https://claude.ai/artifact/KsHLMrs8zWvsWUA4qxfG1G (private until you share it)

`web/` is a static site that runs the whole simulation client-side:

- **Brain:** a JavaScript port of the `realistic` preset (`web/src/brain-engine.js`) runs all
  165,122 neurons and 23.4M connections in a Web Worker. It updates a neuron only while it
  could reach threshold; quiet neurons are advanced in closed form when input arrives. It
  matches the Python engine (`node web/tools/check_engine.mjs`) and runs at about real time
  on a desktop CPU. The connectome is a one-time 46 MB download.
- **Body:** the [FlyBody](https://github.com/TuragaLab/flybody) model (Vaxenburg et al.
  2025, *Nature*; 272k triangles, 99 joints), rigged by
  [flygym](https://github.com/NeLy-EPFL/flygym). Legs replay single-step trajectories
  recorded from a real walking fly in a tripod gait. Stepping frequency follows walking
  speed, and stride length on each side follows turning. Wings, halteres, proboscis and
  antennae are posed from the same model and behavioral state.
- **World:** a 200 mm arena with a 50 mm glass wall. The floor switch picks the lab
  arena (filter paper, the default) or grass and small weeds (fine turf, clover, dandelion
  rosettes, seedlings) at true scale for a 2.5 mm fly. On grass the fly walks on top of
  leaves and the matted turf, tilted to the surface, and tastes food only when it is down
  on the ground. Click to place food drops and odor sources (vinegar, CO₂, geosmin), and
  launch looming threats. The panels show descending-neuron rates, sensory input, and a
  dorsal map of the whole CNS that flashes on every spike.

All assets are in the repository, so the site runs straight from a download or clone:
`python -m http.server -d web 8000`, then open http://localhost:8000.

To rebuild the assets:

```bash
PYTHONPATH=. python web/tools/export_brain.py          # connectome -> web/assets/brain*.png
pip install flygym                                     # only for re-exporting the body
python web/tools/export_body.py --flybody-repo ../flybody  # -> web/assets/fly.{json,png}
python -m http.server -d web 8000                      # open http://localhost:8000
```

Binary data is stored as grayscale PNGs (`web/tools/pngpack.py`) because static hosts that
only serve web media types still serve PNG. The browser inflates the pixel rows directly,
so the bytes are exact.

## On your wrist: Feed the Fly

[`watch/`](watch) is a Tamagotchi-style Wear OS game (built for the Galaxy Watch Ultra)
where a 15k-neuron subcircuit of the same connectome decides whether your fly eats and
when it flees. See [watch/README.md](watch/README.md) to install it.

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

## Credits

This project is built on other people's work. Full citations, licenses and details are in
[CREDITS.md](CREDITS.md); please cite those works, not this repository.

| What | Who | License |
|---|---|---|
| **Connectome** (neurons, connections, transmitter predictions, annotations) | MaleCNS v1.0: HHMI Janelia FlyEM, Google Research, Cambridge Connectomics Group / MRC LMB and consortium. Berg *et al.*, *Cell* (2026). [male-cns.janelia.org](https://male-cns.janelia.org) | CC-BY 4.0 |
| **Neuron model** (LIF equations and parameters) | Shiu, Sterne *et al.*, "A *Drosophila* computational brain model reveals sensorimotor processing", *Nature* 634 (2024) | paper / [code](https://github.com/philshiu/Drosophila_brain_model) |
| **3D fly model** (meshes, skeleton, materials) | FlyBody: Vaxenburg, Siwanowicz *et al.*, "Whole-body physics simulation of fruit fly locomotion", *Nature* 643 (2025). [TuragaLab/flybody](https://github.com/TuragaLab/flybody) | Apache 2.0 |
| **Rigging and recorded leg movements** | NeuroMechFly / flygym (NeLy lab, EPFL): Wang-Chen *et al.*, *Nature Methods* 21 (2024); Lobato-Rios *et al.*, *Nature Methods* 19 (2022). [NeLy-EPFL/flygym](https://github.com/NeLy-EPFL/flygym) | Apache 2.0 |
| **Sensory and motor neuron roles** | Studies cited in [CREDITS.md](CREDITS.md) and next to each entry in `flysim/interface.py` | — |
| **Rendering** | three.js authors | MIT |
| **Fonts** | Newsreader (Production Type), Hanken Grotesk (Hanken Design Co.), JetBrains Mono (JetBrains) | SIL OFL |

Copies of the upstream Apache 2.0 licenses are in [`licenses/`](licenses). The website
shows the same credits in its **Credits** panel.
