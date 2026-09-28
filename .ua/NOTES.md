## SIFU Net

SIFU Net is an RMA inspired history network used in `iceman.json`
- Good to read : RMA, where the idea comes from.
- Kumar, Fu, Pathak, Malik, RMA: Rapid Motor Adaptation for Legged Robots, RSS 2021, arXiv:2107.04034.
- Its core idea is that a robot can't measure its own physical properties (mass, friction and so on) directly. A network can still infer them from recent states and actions, and the policy is then conditioned on that estimate.

How the config maps to the code

┌───────────────────────────────────────────────────────────────────┬──────────────────────────────────────────────┐
│                       Iceman.json (histNet)                       │          What sifu.py does with it           │
├───────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────┤
│ inputs.dynamics: [0..4] × dt, qx..qw, nf, wx, wy, wz (lines 7-13) │ Flattened into one vector (forward, line 62) │
├───────────────────────
│ hidden_sizes: [64, 32], dropout: 0.1 (25-26)                      │ Linear → ReLU → Dropout blocks (lines 35-40) │
├───────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────┤
│ deployment.feature_vector: [8] (21)                               │ Penultimate layer ydp (line 65)              │
├───────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────┤
│ prediction.parameters: ["m", "kt"] (18)                           │ Final linear head ypd (lines 42, 66)         │
├───────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────┤
│ commNet's feature_vector: [8] input (45)                          │ The 8-D ydp is what gets passed into SVNet   │
└───────────────────────────────────────────────────────────────────┴──────────────────────────────────────────────┘

Notice that nf, wx, wy, wz in the history input are the same fields commNet outputs as its command (Iceman.json:49). So histNet looks at recent orientation together with recent commands.

**How this differs from the original RMA** (my reading of the two papers, so check it): in RMA, the thing the history module learns to predict is a learned latent vector. SIFU instead trains against the actual physical parameters (m, kt), which the simulator knows. It then uses the layer just before that output as the latent vector. That's probably why the authors call it a "variant".

## Configs
There are different types of configurations. These `.json` consist differnt types of configs.
Like
- Frame config : mass and physical aspects
- Timed config(courses) : keyfromes aspects


**Currently at 4th point of Tour**