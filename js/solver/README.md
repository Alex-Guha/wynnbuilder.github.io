# WynnSolver

WynnSolver is a build optimizer for the Wynncraft MMO, built on top of the [WynnBuilder](https://wynnbuilder.github.io) codebase. Given a weapon, locked items, ability tree, tomes, boosts, and a damage combo, it searches all combinations of the remaining equipment slots to find the build that maximizes combo damage while satisfying configurable stat restrictions.

The solver lives at `/solver/index.html` and is a fully client-side static page — no build step, no server. It shares all game data, utility libraries, and the computation graph infrastructure with WynnBuilder.

---

## Running Locally

The page uses `fetch()` for JSON data files and requires an HTTP server (not `file://`):

```bash
python3 -m http.server 8000
# then open http://localhost:8000/solver/
```

---

## Codebase Overview

The solver is organized into several layers: page entry, UI logic, the reactive computation graph, the search orchestration, and the worker. Files are in `js/solver/` unless noted.

### Entry point

**`solver/index.html`** — page entry. Imports all shared WynnBuilder libraries (loaders, `computation_graph.js`, `damage_calc.js`, `skillpoints.js`, `build_utils.js`, `display.js`, `atree.js`, `aspects.js`, etc.) followed by all solver-specific scripts. Defines the full DOM layout: item slots, tomes, boosts, ability tree, aspect panel, combo, build stats, restrictions, and solver controls.

---

### Initialization & UI helpers

**`solver.js`** — page-level utilities: `copy_build_to_wynnbuilder()`, `copy_solver_url()`, `setRollMode()`, and `resetSolver()`. Also reads/writes solver-specific URL query params (combo, roll mode, guild tome, thread count, pruning toggle, etc.) on page load/save.

**`solver_autocomplete.js`** — sets up `create_autocomplete()` for each item and tome input field, using position callbacks that anchor the dropdown below its parent `{slot}-dropdown` wrapper div.

**`solver_constants.js`** — field name arrays (`equipment_fields`, `tome_fields`, `powderable_keys`), slot-index mappings (`_NONE_ITEM_IDX`, `_NONE_TOME_KEY`), roll mode constants, and SP attribute order.

---

### Computation graph

The solver uses the same push-based reactive DAG as WynnBuilder (`ComputeNode` in `computation_graph.js`). When any input changes, affected nodes recompute in topological order automatically. Node definitions are split across four files:

**`solver_graph_items.js`** — `ItemInputNode`, `PowderInputNode`, `ItemPowderingNode`, `SolverItemDisplayNode`, `SolverItemTooltipNode`, `SolverWeaponDisplayNode`. These cover reading item/powder fields, applying powders, rendering tier-colored slot displays, and hover tooltips.

**`solver_graph_build.js`** — `SolverBuildAssembleNode` (aggregates all item and tome nodes into a `Build` object, which internally runs `calculate_skillpoints`) and `SolverSKPNode` (reads the resulting SP arrays and renders the read-only skill point display).

**`solver_graph_stat.js`** — boost button data (`damageMultipliers`, static boost handlers), `AggregateStatsNode` (merges multiple StatMaps via `merge_stat`), `PlayerClassNode` (derives class from weapon type), `SolverBuildStatExtractNode` (extracts `build.statMap` + `classDef` into a plain Map), and `SolverBuildDisplayNode` (calls `displayBuildStats()` for summary/detailed views).

**`solver_graph.js`** — `solver_graph_init()`, the wiring function that instantiates all of the above nodes and links them into the full DAG: item nodes → build assembly → stat extraction → radiance scaling → stat aggregation → display nodes and combo base stats.

---

### Combo system

**`solver_combo_node.js`** — `SolverComboTotalNode`, which listens to the combo base stats, the parsed spell list, and the atree merge node, then computes and renders total combo damage. Also manages all selection-mode row UI: add/remove rows, drag-and-drop reordering, per-row spell picker, per-row boost dropdown, per-spell damage display with expandable breakdown tooltip, and mana tracking.

**`solver_combo_boost.js`** — the boost logic that operates per combo row:
- `build_combo_boost_registry(atree_merged, build)` — scans the active ability tree for raw-stat toggle nodes and stat-scaling slider nodes; appends weapon powder boost toggles (Curse, Courage, Wind Prison) and armor powder buff sliders (Rage, Kill Streak, Concentration, Endurance, Dodge).
- `apply_combo_row_boosts(base_stats, boost_tokens, registry)` — clones the stat map and applies per-row boost activations.
- `apply_spell_prop_overrides(spell, prop_overrides, atree_merged)` — clones a spell with hit-count overrides for ability-tree prop-type sliders.
- `find_all_matching_boosts(name, value, is_pct, registry)` — case-insensitive boost lookup with alias resolution.

---

### Restrictions

**`solver_restrictions.js`** — row-based restriction editor: add/remove rows, stat autocomplete, min/max selector, value field. `get_restrictions()` returns the full restrictions object (level range, SP direction, no-major-ID, guild tome, stat thresholds) consumed by the solver before search.

---

### Search orchestration (main thread)

**`solver_search.js`** — everything between "Solve" click and final result display:
- `_build_solver_snapshot()` — freezes all mutable state (weapon, atree, combo, boosts, restrictions) into a plain-object snapshot before spawning workers.
- `_build_item_pools()` — filters `itemMap` per free slot by level range, major-ID flag, SP direction, and roll mode. Prepends a NONE item to each pool. Tracks illegal-set pairs.
- `_partition_work()` — splits the search space into 4× worker-count fine-grained partitions using triangular balancing for the ring double-loop and equal-chunk slicing for armor slots.
- Worker management: spawn workers, send init + run messages, collect progress/done messages, do work-stealing from the partition queue, merge top-5 results across workers, update UI every 5 seconds, display final summary.

---

### Worker

**`solver_worker.js`** — the Web Worker that runs the synchronous DFS over its assigned partition. Key internals:
- Initializes running SP state (`running_sum_prov`, `running_max_req`) from locked items + weapon + guild tome.
- Builds a suffix best-provision table for mid-DFS SP pruning (currently known to produce false positives — see SOLVER.md).
- Maintains an incremental running `statMap` that is updated/reverted as items are placed/backtracked, avoiding a full rebuild at every leaf.
- Handles rings in a separate double-loop (same pool, unordered pairs) with partition slicing on the outer index.
- Evaluates each leaf: quick SP pre-filter → `calculate_skillpoints` → stat finalization → restriction threshold check → combo damage scoring → top-5 heap update.

**`solver_worker_shims.js`** — DOM-free copies of functions the worker needs but that normally read/write the DOM. Specifically: `worker_init_build_stats()` (replaces `Build` constructor) and `worker_atree_scaling()` (replaces the DOM-read atree scaling node by operating on serialized button/slider states).

---

### Styles

**`css/solver-wide.css`** — all WynnSolver page styles. The solver reuses the shared `css/shared.css` for common layout primitives and defines its own styles here for sections, slot displays, the combo rows, the restrictions panel, the results panel, and the progress bar.

---

### Documentation

**`SOLVER.md`** (this directory) — detailed description of the search pipeline: snapshot collection, item pool building, work partitioning, worker protocol, DFS logic, leaf evaluation, result aggregation, key optimizations, known weaknesses, and potential improvements.

---

## Examples

These links require the app running at `http://localhost:8000`. Open them in a browser after starting the server.

**Inferno Trick-Shade:**
```
http://localhost:8000/solver/?combo=c%3AvZRNboMwEEb3nOI7AAucluzz02WkSj6BMUM7wtjImC4qHz6KlKip1R-VAtvx6D09L0YgYq-6yrl3Q4jY6cBvKhDk6HvPA0EGzy3lHy8H4ywN6QBSac8Na8ohezIGB9czDdhmAhGycy1h77rqXvI76sm2bGtD9XWJcKRqbJoBZerJcVK-pfpq_LJqTmGZCGXPFrsQlG7XUi7e-Lh-Y6pcvPFh_cZUuXjjZv3GVPl94zS--EPSPIYjNUa9-At1suAGvFvDM3lNNkAURVYi4jSawK8c_m-Z72NuRESIbPPzQZ8GFZ_LEVFc5mc&ctime=6&gtome=1&dir=dex%2Cagi&lvlmin=75&restr=mr%3Age%3A65%7Cehp%3Age%3A50000%7Cspd%3Age%3A10&dtime=1&sfree=240#CN0O0VTy0+oH2qhJzaNdsLm11v9Sb3MDlSfVUNIrnTWa1
```

**Monster Riftwalker:**
```
http://localhost:8000/solver/?combo=c%3AM7RQqFHwTS1JzS9SqFEIz8xLSU1RMDNQqFEw5DJUqFFwKi3Ky8xLVwjOTM_MwVBhqVCjEJKak1qQX1SCLgkA&ctime=9&roll=75pct&lvlmin=75&gtome=1&sfree=224&dtime=1&dir=dex#CN0O0VTg0+w8Yxr9KpBdoR4G1v9i20PDlSjZbEWs-jzo+T0
```

---

## Todo

### Improve Solver
See SOLVER.md for details.

### UI polish

- **Level / roll mode / reset / copy row** - the controls in this row need visual refinement: consistent sizing, spacing, and alignment with the rest of the panel.
- **Solver restrictions panel** - the stat threshold rows would benefit from better layout (aligned columns, cleaner autocomplete styling) and clearer labeling of the min/max selector.
- **Tomes / Ability Tree / Aspects toggle buttons** - on page load, whichever section is shown by default does not receive the active hover highlight. The button hover/active state needs to be set programmatically at init to match the visible section.
- **General design** - various small inconsistencies across sections (font sizing, border radii, button heights) that could be unified in a polish pass.
- **UI Scaling** - Test different aspect ratios and improve css

### Future

- **Automatic combo sequencing** — tracking state-dependent effects across a combo sequence (clone counts consumed by Bamboozle after Vanish, etc.) would require a per-spell state machine for each ability interaction. This is a significant undertaking and was deferred from the initial design.
- **Damage-based branch-and-bound, item dominance pre-filtering, two-phase solve, weighted multi-objective scoring, tome optimization, GPU parallelization** — see SOLVER.md ("Potential Improvements") for details on each.

### Testing

The combo damage calculation has been tested against WynnBuilder output for some archetypes and bugs were found and fixed, but not all archetypes have been verified. Each archetype should be tested by loading the same build and buffs in both WynnSolver and WynnBuilder and comparing per-spell damage numbers. Archetypes that use prop-type sliders (e.g. Enkindled %), ability-name aliases (e.g. Mirror Image → Activate Clones), or powder special spells are the highest priority to verify.
