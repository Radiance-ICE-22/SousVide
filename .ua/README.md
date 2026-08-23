# Understand Anything data — how to use it

This `.ua/` directory holds the knowledge graph that `/understand` built for this
repository (SOUS VIDE). Everything below works off the files already here — none
of it re-runs the full 7-phase analysis.

## What's in here

| File | Contents |
| --- | --- |
| `knowledge-graph.json` | The graph itself: `project` metadata, `nodes` (files/functions/classes/configs/docs), `edges` (imports, calls, contains, ...), `layers` (architectural groupings), and `tour` (guided walkthrough steps). |
| `meta.json` | `lastAnalyzedAt`, the `gitCommitHash` the graph was built from, and `analyzedFiles` count. Used to detect whether the repo has drifted since the last analysis. |
| `fingerprints.json` | Per-file structural fingerprints, used by incremental updates to tell which files actually changed structurally vs. just cosmetically. |
| `.understandignore` | Glob patterns excluded from analysis (gitignore syntax). Edit this and pass `--full` to `/understand` to have it take effect. |

Current snapshot: 65 files analyzed, 138 nodes, 302 edges, 8 layers, 13 tour steps,
built from commit `a2400aa`.

## Ways to use the existing graph (no full rebuild)

All of these read `knowledge-graph.json` directly — they do not re-scan or
re-analyze the codebase:

- **`/understand-dashboard`** — launches the interactive visual explorer
  (dependency graph, layers, tour) against this project's `.ua/knowledge-graph.json`.
- **`/understand-chat`** — ask free-form questions about the codebase
  ("what calls `deploy_roster`?", "how does training data get generated?") using
  the graph as context.
- **`/understand-explain`** — deep-dive on one file, function, class, or module
  (e.g. `src/sousvide/control/pilot.py` or the `Policy` class).
- **`/understand-diff`** — point at a git diff or a PR to see which graph nodes
  (files/functions) it touches and what else in the graph depends on them.
- **`/understand-onboard`** — generate an onboarding guide for a new contributor,
  built from the layers and tour already in the graph.
- **`/understand-domain`** — extract business/process-flow knowledge; when a
  knowledge graph already exists (it does, here) it derives from it instead of
  doing its own lightweight scan.

Each of these is a slash command — just invoke it and Claude Code loads the
matching skill.

### Launching the dashboard directly (bash shortcut)

Once the dashboard's dependencies and its `core` package have been built once
(the `/understand-dashboard` skill does this the first time), you don't need
to go through the skill again to relaunch it — just start the dev server
directly:

```bash
cd ~/.claude/plugins/cache/understand-anything/understand-anything/<version>/packages/dashboard
GRAPH_DIR=/home/yutharsan/FYP/SousVide npx vite --host 127.0.0.1
```

Replace `<version>` with the installed plugin version (check
`~/.claude/plugins/cache/understand-anything/understand-anything/`). This
prints a `🔑 Dashboard URL: http://127.0.0.1:<PORT>?token=<TOKEN>` line — open
that URL (token included) in a browser. Works as long as
`.ua/knowledge-graph.json` still exists in the project; no rebuild needed
unless the plugin itself is updated.

## Recommended learning path (for a student aiming to replicate this work)

Understanding the graph and actually being able to reproduce SOUS VIDE's results
are different milestones. Go in this order:

1. **Dashboard tour first, not deep-dive first.** Open `/understand-dashboard`
   and read the 13-step tour in order before opening any single file. It already
   sequences the pipeline the way this codebase actually flows: README →
   example notebook → configs → data synthesis → network foundation →
   architectures → policy/pilot → observation generation → training →
   deployment → utilities → build env. Jumping straight to a deep-dive on, say,
   `pilot.py` risks understanding one node in isolation without knowing where
   it sits in the data/control flow.

2. **Then `/understand-explain` per node, in tour order.** The tour's per-step
   description is one paragraph — enough to orient, not enough to replicate.
   For the files that actually matter for replication (the network
   architectures under `control/networks/`, `Policy`/`Pilot`, `train_policy.py`,
   `rollout_generator.py`/`observation_generator.py`), a deep-dive gives the
   actual mechanics: tensor shapes, the ORCA control loop, checkpoint/eval logic.

3. **`/understand-chat` alongside both**, for "why" questions neither the tour
   nor a single-file explain answers well — e.g. why history buffers are
   structured the way they are, or how a pilot config's architecture choice
   propagates through `network_factory`.

4. **The graph doesn't replace running the thing.** Since replication is the
   goal, the student still has to leave the dashboard: build the conda
   environment, get FiGS/ACADOS built, run `figs_examples.ipynb` then
   `sous_vide_examples.ipynb`, and eventually rerun `train_policy.py`
   themselves. The knowledge graph gets them to "I understand what this code
   does and why," not to "I've reproduced the paper's results" — that last
   step is hands-on regardless of tooling.

If they'd rather read than click through the dashboard UI, `/understand-onboard`
can flatten steps 1–2 into a single onboarding document — same content,
different medium.

## Querying the graph directly

`knowledge-graph.json` is plain JSON, so `jq` works well for quick lookups
without invoking any skill:

```bash
# List all layers
jq '.layers[] | {id, name}' .ua/knowledge-graph.json

# List the guided tour in order
jq '.tour[] | {order, title}' .ua/knowledge-graph.json

# Find a node by file path
jq '.nodes[] | select(.filePath == "src/sousvide/control/pilot.py")' .ua/knowledge-graph.json

# Everything that imports a given file
jq '.edges[] | select(.type == "imports" and .target == "file:src/sousvide/control/policy.py")' \
  .ua/knowledge-graph.json

# Everything a given file calls
jq '.edges[] | select(.type == "calls" and .source | startswith("function:src/sousvide/control/pilot.py"))' \
  .ua/knowledge-graph.json
```

Node IDs are prefixed by type: `file:<path>`, `config:<path>`, `document:<path>`,
`function:<path>:<name>`, `class:<path>:<name>`.

## Keeping the graph fresh (cheap — still not a full rebuild)

If you've committed changes since `meta.json`'s `gitCommitHash`, just run
`/understand` again with no flags. It compares the current commit against
`meta.json`/`fingerprints.json`, re-analyzes only the changed files, and merges
the result — it does **not** redo the full scan/batch/analyze/architecture/tour
pipeline from scratch. Use `--full` only if you want to force a complete rebuild
(e.g. after editing `.understandignore`, or if the graph looks structurally off).

## When you actually need a full rerun

- You changed `.understandignore` or want new `--exclude` patterns applied.
- You want a different `--language` for generated summaries.
- The graph looks stale/wrong in a way incremental update won't fix (rare —
  use `/understand --review` first to get a full LLM validation pass before
  reaching for `--full`).
