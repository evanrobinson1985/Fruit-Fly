# Third-party assets

Full citations and credits: [CREDITS.md](../../CREDITS.md). License texts: [licenses/](../../licenses).

- `fly.json`, `fly.png`: 3D fruit fly from **FlyBody** (Vaxenburg, Siwanowicz et al. 2025,
  "Whole-body physics simulation of fruit fly locomotion", *Nature*),
  by Roman Vaxenburg, Igor Siwanowicz and colleagues (Turaga lab, HHMI Janelia, with Google DeepMind),
  https://github.com/TuragaLab/flybody, Apache License 2.0. Rigged with
  **flygym / NeuroMechFly** (Pavan Ramdya's Neuroengineering Laboratory, EPFL;
  https://github.com/NeLy-EPFL/flygym, Apache License 2.0),
  whose recorded single-step leg trajectories (`single_steps_flybody.npz`, from a real
  fly walking on a ball) are included in `fly.json` under `steps`. Meshes are
  re-encoded (16-bit quantized positions) but otherwise unmodified.
- `brain*.png`, `brain.json` (generated, not committed): **MaleCNS v1.0**, HHMI Janelia FlyEM,
  Google Research, Cambridge Connectomics Group / MRC LMB and consortium, CC-BY 4.0,
  https://male-cns.janelia.org. Simulated with the neuron model of Shiu et al. 2024, *Nature*.
