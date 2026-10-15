# Credits

This project builds directly on the work of the people and teams below. If you use it in
research, please cite the original works, not this repository.

## Wiring diagram: MaleCNS v1.0 connectome

The neurons, their connections, neurotransmitter predictions, cell-type annotations and
soma positions all come from the **Male CNS connectome**: the complete central nervous
system (brain, optic lobes and ventral nerve cord) of an adult male *Drosophila
melanogaster*.

- Produced by the **HHMI Janelia FlyEM** project team with **Google Research**, the
  **Cambridge Connectomics Group** and the **MRC Laboratory of Molecular Biology**
  (Gregory Jefferis's group), and a large international proofreading and annotation
  consortium.
- Paper: Berg, S. *et al.* "Sexual dimorphism in the complete *Drosophila* male central
  nervous system connectome." *Cell* (2026). See the project page for the full author list
  and current citation: https://male-cns.janelia.org
- Data: `gs://flyem-male-cns/v1.0/connectome-data/flat-connectome/`, released under
  **CC-BY 4.0**. This repository uses the traced-neuron weights (`minconf 0.5`), body
  annotations and neurotransmitter predictions. They are reformatted, and
  `flysim/data.py` describes the edits made for simulation.

## Neuron model

The leaky integrate-and-fire model and its parameters come from:

- Shiu, P. K., Sterne, G. R., Spiller, N., Franconville, R., Sandoval, A., Zhou, J., Simha, N.,
  Kang, C. H., Yu, S., Kim, J. S., Dorkenwald, S., Matsliah, A., Schlegel, P., Yu, S.-c.,
  McKellar, C. E., Sterling, A., Costa, M., Eichler, K., Bates, A. S., Eckstein, N., Funke, J.,
  Jefferis, G. S. X. E., Murthy, M., Bidaye, S. S., Hampel, S., Seeds, A. M. & Scott, K.
  "A *Drosophila* computational brain model reveals sensorimotor processing."
  *Nature* 634, 210–219 (2024). https://doi.org/10.1038/s41586-024-07763-9
  (code: https://github.com/philshiu/Drosophila_brain_model)

The short-term synaptic depression, the connectome edits in the `realistic` preset, and the
event-driven browser engine were added in this repository. Any errors in them are ours.

## 3D fly body: FlyBody

The 3D fly on the website (meshes, skeleton and materials) is **FlyBody**:

- Vaxenburg, R., Siwanowicz, I., Merel, J., Robie, A. A., Morrow, C., Novati, G., Stefanidi, Z.,
  Both, G.-J., Card, G. M., Reiser, M. B., Botvinick, M. M., Branson, K. M., Tassa, Y. &
  Turaga, S. C. "Whole-body physics simulation of fruit fly locomotion."
  *Nature* 643, 1312–1320 (2025). https://doi.org/10.1038/s41586-025-09029-4
- Code and assets: https://github.com/TuragaLab/flybody, **Apache License 2.0**
  (copy in [`licenses/flybody-Apache-2.0.txt`](licenses/flybody-Apache-2.0.txt)).
- The meshes are re-encoded for the web (positions quantized to 16 bits, packed into a PNG)
  but their geometry is otherwise unchanged.

## Rigging and recorded leg movements: NeuroMechFly / flygym

The FlyBody rigging (joint frames and the neutral and flight poses) and the recorded
single-step leg trajectories the walking animation replays come from **flygym**, by the
Neuroengineering Laboratory (Pavan Ramdya) at EPFL:

- Wang-Chen, S., Stimpfling, V. A., Lam, T. K. C., Özdil, P. G., Genoud, L., Hurtak, F. &
  Ramdya, P. "NeuroMechFly v2: simulating embodied sensorimotor control in adult
  *Drosophila*." *Nature Methods* 21, 2353–2362 (2024).
  https://doi.org/10.1038/s41592-024-02497-y
- Lobato-Rios, V., Ramalingasetty, S. T., Özdil, P. G., Arreguit, J., Ijspeert, A. J. &
  Ramdya, P. "NeuroMechFly, a neuromechanical model of adult *Drosophila melanogaster*."
  *Nature Methods* 19, 620–627 (2022). https://doi.org/10.1038/s41592-022-01466-7
- Code and data: https://github.com/NeLy-EPFL/flygym, **Apache License 2.0**
  (copy in [`licenses/flygym-Apache-2.0.txt`](licenses/flygym-Apache-2.0.txt)). The step
  data is `flygym_demo/complex_terrain/assets/single_steps_flybody.npz`, extracted from a
  recording of a real fly walking on an air-supported ball.

## Sensory and motor neuron identities

The links between the simulated world and specific neurons follow these studies (also
cited next to each entry in `flysim/interface.py`):

- Vinegar glomeruli: Semmelhack, J. L. & Wang, J. W. *Nature* 459, 218–223 (2009).
- CO₂ (V glomerulus): Suh, G. S. B. *et al.* *Nature* 431, 854–859 (2004).
- Geosmin (DA2): Stensmyr, M. C. *et al.* *Cell* 151, 1345–1357 (2012).
- Looming detectors LC4 and LPLC2: von Reyn, C. R. *et al.* *Nature Neuroscience* 20 (2017);
  Ache, J. M. *et al.* *Current Biology* 29 (2019).
- Giant Fiber escape: von Reyn, C. R. *et al.* *Nature Neuroscience* 17, 962–970 (2014);
  Card, G. & Dickinson, M. H. *Current Biology* 18 (2008).
- P9 forward walking: Bidaye, S. S. *et al.* *Neuron* 108, 469–485 (2020).
- Moonwalker (MDN) backward walking: Bidaye, S. S. *et al.* *Science* 344, 97–101 (2014).
- DNa01/DNa02 steering: Rayshubskiy, A. *et al.* bioRxiv (2020); Yang, H. H. *et al.* *Cell* (2024).
- MN9 proboscis extension: Gordon, M. D. & Scott, K. *Neuron* 61, 373–384 (2009).
- Hunger raises sugar-neuron sensitivity (Feed the Fly's hunger mechanic): Inagaki, H. K.
  *et al.* *Neuron* (2012).
- Spontaneous smell-receptor firing rates: de Bruyne, M., Foster, K. & Carlson, J. R.
  *Neuron* 30, 537–552 (2001).
- Giant Fiber to jump motor neuron as a mainly electrical synapse: discussed in
  von Reyn, C. R. *et al.* *Nature Neuroscience* 17 (2014) and earlier work.
- Synaptic depression in the antennal lobe: Kazama, H. & Wilson, R. I. *Neuron* 58,
  401–413 (2008).

## Feed the Fly (watch game)

Uses the same connectome, neuron model, FlyBody fly and NeuroMechFly leg recordings as above;
see [watch/README.md](watch/README.md). Built with Jetpack Compose for Wear OS (Apache 2.0).

## Software and fonts

- [three.js](https://threejs.org) (MIT License, © three.js authors) renders the website.
- [MuJoCo](https://mujoco.org) (Apache 2.0, Google DeepMind) is used offline to check the
  browser's forward kinematics.
- NumPy, pandas, PyArrow, Numba, SciPy and Matplotlib run the Python simulator.
- Website fonts from Google Fonts, all under the SIL Open Font License:
  Newsreader (Production Type), Hanken Grotesk (Hanken Design Co.) and
  JetBrains Mono (JetBrains).
