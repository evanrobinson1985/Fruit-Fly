# Transmitter confidence model

## Purpose

The standard `realistic` model continues to use the MaleCNS v1.0 recommended
neuron-level transmitter consensus and its existing fast-transmitter sign
approximation. This experimental variant tests whether uncertainty in those
assignments should reduce the modeled output of a presynaptic neuron.

## What the source data actually says

The MaleCNS v1.0 neuron table contains:

- `consensus_nt`: the recommended label; it copies the cell-type prediction
  except where curated experimental ground truth overrides that prediction.
- `celltype_predicted_nt_confidence`: confidence for the cell-type prediction.
- `predicted_nt` and `predicted_nt_confidence`: the neuron-specific prediction
  and its confidence.
- `ground_truth`: an experimentally curated label when available.

Resolution order is consensus, then cell-type prediction, then neuron-specific
prediction. Unresolved labels remain `unclear` with confidence 0. Each neuron
also retains `nt_source` so downstream analysis can distinguish ground truth,
consensus, cell-type prediction, neuron prediction and unresolved assignments.

The MaleCNS paper states that `consensusNt` is the recommended property and
describes the confidence thresholds used to label predictions unclear. See
[Berg et al., 2026, Cell](https://pmc.ncbi.nlm.nih.gov/articles/PMC12636603/).

## Experimental weighting

Run the optional preset:

```bash
python -m flysim forage --seconds 15 --preset realistic_confidence
```

For a presynaptic neuron with confidence (c\), each outgoing chemical synaptic
weight is multiplied by (c\). This is deliberately an experimental shrinkage
rule: the published confidence is not asserted to be a calibrated posterior
probability of synaptic efficacy. It is used as a transparent sensitivity
analysis. The original `realistic` preset remains the default and is unchanged.

## Important biological boundary

This is not yet a receptor-specific model. The official MaleCNS download page
lists a 2.7 GB table of transmitter prediction probabilities for each presynaptic
T-bar, but that is still presynaptic transmitter evidence, not the identity or
functional sign of the postsynaptic receptor. The paper discusses transmitter
predictions and their confidence; it does not make the neuron annotation's
`receptorType` field a synaptic receptor map. See the
[official MaleCNS data inventory](https://male-cns.janelia.org/download/).

Consequently this upgrade does not invent receptor assignments or claim that
acetylcholine, glutamate or any other transmitter has one universal effect at
every postsynaptic cell. A future receptor-resolved implementation needs a
separately sourced, validated postsynaptic receptor dataset and evidence for
the receptor's ionotropic or metabotropic action in that cell type.

## Validation

The tests cover resolution precedence, confidence provenance, unresolved
labels, confidence bounds, and presynaptic scaling without mutating the original
connectome. Full repository CI also runs the browser-engine regression suite.


## Audit the source evidence

Before comparing simulations, inspect how the loaded neurons are distributed across
transmitter labels and evidence sources:

```bash
python -m flysim audit-transmitters
```

The command writes `results/transmitter-audit.csv` with neuron counts, population
fractions, and mean/median confidence for each transmitter/provenance group. It
does not change model weights. The report helps distinguish curated ground truth
from consensus and prediction-based labels before interpreting the experimental
confidence-weighted preset.
