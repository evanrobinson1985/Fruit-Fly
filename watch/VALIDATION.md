# Watch circuit validation

The watch game runs the connectome subcircuit on paths of at most 4 synapses from its sensory inputs to its motor outputs, using connections of 8+ synapses to choose neurons and keeping every connection among them: 15,154 of 165,122 neurons and 2,419,232 of 24,931,930 connections. Same neuron model and parameters as the `realistic` preset.

## Motor responses (peak group mean rate, Hz, 500 ms of input, mean of 3 seeds)

| input                      | network       |   forward |   backward |   turn |   escape |   feed |
|:---------------------------|:--------------|----------:|-----------:|-------:|---------:|-------:|
| Looming (LC4+LPLC2) 100 Hz | full brain    |         0 |          0 |      0 |      285 |      0 |
| Looming (LC4+LPLC2) 100 Hz | watch circuit |         0 |          1 |      0 |      285 |      0 |
| Taste neurons 80 Hz        | full brain    |         0 |          0 |      2 |        0 |     21 |
| Taste neurons 80 Hz        | watch circuit |         0 |          0 |      0 |        0 |     20 |
| Vinegar ORNs 60 Hz         | full brain    |         0 |          1 |      0 |        0 |      9 |
| Vinegar ORNs 60 Hz         | watch circuit |         1 |         11 |      6 |        4 |      1 |

## Hunger: feeding responses vs. taste neurons recruited

Fraction of 8 trials (random taste neurons, 40 Hz, 1 s) in which MN9 crossed the game's 20 Hz feeding threshold. In the game a hungry fly recruits many sugar-sensing neurons and a satiated one few (starvation raises sugar-neuron sensitivity; Inagaki et al. 2012).

|   taste neurons responding |   full brain |   watch circuit |
|---------------------------:|-------------:|----------------:|
|                          1 |        0.125 |           0     |
|                          2 |        0.25  |           0.125 |
|                          4 |        0.375 |           0.125 |
|                          8 |        0.5   |           0.625 |
|                         12 |        0.75  |           0.75  |
|                         20 |        0.625 |           0.625 |
|                         40 |        1     |           1     |
