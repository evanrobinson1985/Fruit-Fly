# Watch circuit validation

The watch game runs the connectome subcircuit on paths of at most 4 synapses from its sensory inputs to its motor outputs (at most 3 from the head bristles to the DNg12 grooming neurons), using connections of 8+ synapses to choose neurons and keeping every connection among them: 16,540 of 165,122 neurons and 2,533,716 of 24,931,930 connections. Same neuron model and parameters as the `realistic` preset.

## Motor responses (peak group mean rate, Hz, 500 ms of input, mean of 3 seeds)

| input                      | network       |   forward |   backward |   turn |   escape |   feed |   groom |
|:---------------------------|:--------------|----------:|-----------:|-------:|---------:|-------:|--------:|
| Looming (LC4+LPLC2) 100 Hz | full brain    |         0 |          0 |      1 |      227 |      0 |       0 |
| Looming (LC4+LPLC2) 100 Hz | watch circuit |         1 |          5 |      4 |      222 |      0 |       0 |
| Taste neurons 80 Hz        | full brain    |         0 |          0 |      1 |        0 |     16 |       0 |
| Taste neurons 80 Hz        | watch circuit |         0 |          0 |      1 |        0 |     17 |       0 |
| Vinegar ORNs 60 Hz         | full brain    |         0 |          1 |      0 |        0 |      8 |       0 |
| Vinegar ORNs 60 Hz         | watch circuit |         1 |         10 |      3 |        0 |      3 |       0 |
| Head bristles 120 Hz       | full brain    |         0 |         12 |      1 |        0 |     12 |      11 |
| Head bristles 120 Hz       | watch circuit |         0 |         15 |      0 |        0 |      9 |      10 |

## Hunger: feeding responses vs. taste neurons recruited

Fraction of 8 trials (random taste neurons, 40 Hz, 1 s) in which MN9 crossed the game's 20 Hz feeding threshold. In the game a hungry fly recruits many sugar-sensing neurons and a satiated one few (starvation raises sugar-neuron sensitivity; Inagaki et al. 2012).

|   taste neurons responding |   full brain |   watch circuit |
|---------------------------:|-------------:|----------------:|
|                          1 |        0.125 |           0     |
|                          2 |        0.25  |           0.125 |
|                          4 |        0.375 |           0.125 |
|                          8 |        0.5   |           0.5   |
|                         12 |        0.625 |           0.75  |
|                         20 |        0.875 |           0.625 |
|                         40 |        1     |           1     |
