# Watch circuit validation

The watch game runs the connectome subcircuit on paths of at most 4 synapses from its sensory inputs to its motor outputs, using connections of 8+ synapses to choose neurons and keeping every connection among them: 15,154 of 165,122 neurons and 2,419,232 of 24,931,930 connections. Same neuron model and parameters as the `realistic` preset.

## Motor responses (peak group mean rate, Hz, 500 ms of input, mean of 3 seeds)

| input                      | network       |   forward |   backward |   turn |   escape |   feed |
|:---------------------------|:--------------|----------:|-----------:|-------:|---------:|-------:|
| Looming (LC4+LPLC2) 100 Hz | full brain    |         0 |          0 |      1 |      227 |      0 |
| Looming (LC4+LPLC2) 100 Hz | watch circuit |         1 |          3 |      3 |      227 |      2 |
| Taste neurons 80 Hz        | full brain    |         0 |          0 |      1 |        0 |     16 |
| Taste neurons 80 Hz        | watch circuit |         0 |          0 |      0 |        3 |     14 |
| Vinegar ORNs 60 Hz         | full brain    |         0 |          1 |      0 |        0 |      8 |
| Vinegar ORNs 60 Hz         | watch circuit |         0 |         11 |      6 |        0 |      2 |

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
