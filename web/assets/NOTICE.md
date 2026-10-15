# Third-party assets

- `fly.json`, `fly.png`: 3D fruit fly from **FlyBody** (Vaxenburg, Siwanowicz et al. 2025,
  "Whole-body physics simulation of fruit fly locomotion", *Nature*),
  https://github.com/TuragaLab/flybody, Apache License 2.0. Rigged with
  **flygym / NeuroMechFly** (https://github.com/NeLy-EPFL/flygym, Apache License 2.0),
  whose recorded single-step leg trajectories (`single_steps_flybody.npz`, from a real
  fly walking on a ball) are included in `fly.json` under `steps`. Meshes are
  re-encoded (16-bit quantized positions) but otherwise unmodified.
- `brain*.png`, `brain.json` (generated, not committed): **MaleCNS v1.0**, HHMI Janelia FlyEM
  and Google Research, CC-BY 4.0, https://male-cns.janelia.org.
