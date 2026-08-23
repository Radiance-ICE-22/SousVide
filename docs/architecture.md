# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

SOUS VIDE (Scene Understanding via Synthesized Visual Inertial Data from Experts) is a Stanford MSL
research codebase for training and deploying learned drone flight-control policies. An expert MPC
controller flies trajectories inside a Gaussian-splat simulator (the `FiGS` submodule) to synthesize
training data; a visuomotor policy network is trained on that data; the trained policy ("pilot") is
then deployed back into FiGS simulation or, eventually, onto a real drone.

There is no test suite, linter, or CI configured in this repository — do not assume `pytest`/`ruff`/etc.
exist here.

## Setup

This project depends on a git submodule (`FiGS`) and native builds (ACADOS), so it cannot be pip-installed
standalone:

```bash
git submodule update --recursive --init      # pulls in FiGS (github.com/StanfordMSL/FiGS.git)

# Build ACADOS (MPC solver used by the expert controller), from FiGS/acados/:
mkdir -p build && cd build
cmake -DACADOS_WITH_QPOASES=ON ..
make install -j4
export LD_LIBRARY_PATH=$LD_LIBRARY_PATH:"<acados_root>/lib"
export ACADOS_SOURCE_DIR="<acados_root>"

# Create the conda environment (from the repo root):
conda env create -f environment_x86.yml
conda activate kitchen
```

`environment_x86.yml` pins Python 3.10 / PyTorch 2.1.2+cu118, and pip-installs `sousvide` itself plus
`FiGS`, `FiGS/acados/interfaces/acados_template`, and `FiGS/Hierarchical-Localization` in editable mode —
so `FiGS` and `sousvide` are both live-imported from source once the env is active.

Example GSplat scene data must be downloaded separately and unpacked into `gsplats/` (see README.md for
the link) before any simulation code will run.

## Running the pipeline

There's no CLI or entry-point script — the workflow is driven interactively from the example notebooks
(`notebooks/figs_examples.ipynb`, `notebooks/sous_vide_examples.ipynb`), which call directly into the
`sousvide` package. The end-to-end sequence, per `sous_vide_examples.ipynb`:

```python
import sousvide.synthesize.rollout_generator as rg
import sousvide.synthesize.observation_generator as og
import sousvide.instruct.train_policy as tp
import sousvide.flight.deploy_figs as df

rg.generate_rollout_data(cohort, courses, scene, data_method)   # fly the expert MPC controller in FiGS, save rollouts
og.generate_observation_data(cohort, roster)                    # extract each pilot's declared inputs from the rollouts
tp.train_roster(cohort, roster, "histNet", n_epochs)             # train the history/RMA network first
tp.train_roster(cohort, roster, "commNet", n_epochs, regen=True) # then the command network (regen=True: histNet outputs changed)
df.deploy_roster(cohort, course, scene, method, roster, mode="visualize")  # evaluate/visualize in FiGS
```

`cohort` is just a name — it becomes a directory under `cohorts/<cohort_name>/` holding all generated
rollout data, observation data, and per-pilot trained networks (`cohorts/<cohort>/roster/<pilot>/*.pt`).
Re-running `train_roster` resumes training from the saved checkpoint; delete the corresponding `.pt` file
to retrain from scratch.

## Architecture

**Everything is config-driven, not hardcoded.** `configs/` holds named JSON definitions across six
categories (`pilots/`, `courses/`, `methods/`, `nnio/`, `captures/`, `frames/`), and code loads them by
name+category through `figs.utilities.config_helper.get_config(name, category)` (from the FiGS submodule)
rather than importing them directly. A pilot's entire network architecture — which sub-networks it has,
their types, and their input/output wiring — is declared in its `configs/pilots/<Name>.json` file; adding
a new pilot variant is a config change, not a code change (see `configs/pilots/Iceman.json` vs
`Maverick.json` for an example of this).

**`FiGS` (the submodule) does simulation; `src/sousvide/` does learning.** Code under `src/sousvide/`
imports the `figs` package extensively (`figs.simulator.Simulator`, `figs.control.vehicle_rate_mpc.VehicleRateMPC`,
`figs.control.base_controller.BaseController`, `figs.utilities.config_helper`, etc.). `Pilot`
(`control/pilot.py`) subclasses FiGS's `BaseController` so it can be dropped directly into `Simulator.simulate()`
the same way the expert MPC controller is.

**Network layer (`control/`)**: `network_factory.generate_network()` dispatches on a `network_type` string
(`simple`/`dino`/`sifu`/`svnet`/`dnnet`/`pave`) from config to instantiate one of the classes in
`control/networks/`, all subclassing `BaseNet`. `Policy` (`control/policy.py`) is an `nn.ModuleDict` of
these named sub-networks (e.g. `featNet` → `histNet`/`commNet`) chained together in one forward pass, with
each network's inputs/outputs threaded through by name via `network_helper.extract_io`. `Pilot`
(`control/pilot.py`) wraps a `Policy` in an **ORCA loop** — `observe()` → `retain()` (push into rolling
history buffers) → `collate()` (assemble network inputs) → `act()` (forward pass) — implemented as the
literal `ORCA()` method, which is what both training-time replay and live/simulated flight call.

**Data flow across layers**: `synthesize/` (rollout + observation generation) produces training tensors →
`instruct/train_policy.py` trains the network(s) inside a `Pilot` → `flight/deploy_figs.py` re-simulates
the trained `Pilot` in FiGS for evaluation, also invoked mid-training when `train_roster(..., deployment=...)`
is set. `visualize/` and `utilities/sousvide_utilities.py` are cross-cutting support (console
progress/reporting, plotting, flight recording/video) consumed by all three layers above; they contain no
pipeline logic of their own.

**`cohorts/` and `gsplats/`** are generated/downloaded data workspaces, not source — both are gitignored
and empty in a fresh checkout.
