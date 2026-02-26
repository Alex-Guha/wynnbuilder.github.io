# Solver Search — Logic Flow

This document describes the abstract logic of the WynnSolver search pipeline, from user click to ranked results. The code spans three files: `solver_search.js` (main thread orchestration), `solver_worker.js` (per-worker DFS), and `solver_worker_shims.js` (DOM-free utility copies).

---

## High-Level Picture

```
User clicks "Solve"
        │
        ▼
1. Collect snapshot (weapon, atree state, combo, boosts, restrictions)
2. Build item pools (filter by level, SP direction, major-IDs)
3. Partition search space across N web workers
4. Each worker runs a synchronous DFS over its slice
        │  (every 5 000 candidates)
        ├──── progress message → main thread aggregates interim top-5
        └──── done message     → work-stealing: send next partition or finish
        │
        ▼
5. Merge top-5 from all workers → fill best build into UI, show ranked list
```

---

## Step 1 — Snapshot (`_build_solver_snapshot`)

Before spawning any workers the main thread reads every piece of mutable state that influences scoring and freezes it into a plain-object snapshot. This avoids race conditions if the user edits fields during a search.

Key pieces captured:
- **Weapon** and **level** — from solver item input nodes.
- **Tomes** and **guild tome** — from solver tome input nodes; guild tome determines the SP budget (200 / 204 / 205).
- **Atree state** — `atree_raw` (raw stat bonuses from the tree), `atree_merged` (full ability tree), and serialized `button_states` / `slider_states` (toggle/slider DOM state flattened to plain Maps so workers can clone them).
- **Static boosts** — merged from the Active Boosts panel.
- **Radiance boost** — floating multiplier (1.0–1.3) based on Radiance / Divine Honor toggles.
- **Parsed combo** — the ordered list of `{qty, spell, boost_tokens}` rows that define what damage is optimised. Powder-special spells are synthesised and inserted here.
- **Boost registry** — built from `build_combo_boost_registry`; maps boost token names to their stat/prop contributions.
- **Restrictions** — from `get_restrictions()`: level range, build direction (which SP types are used), no-major-ID flag, stat thresholds.

---

## Step 2 — Item Pool Building (`_build_item_pools`)

For each free slot (helmet, chestplate, leggings, boots, ring, bracelet, necklace) the main thread filters `itemMap` to a candidate pool:

1. **Level range** — `lvl_min ≤ item.lvl ≤ lvl_max`.
2. **Major-ID filter** — if "No Major ID" is on, items with any major ID are excluded.
3. **Build direction** — if a SP type is disabled (e.g. Dexterity off), items that *require* that SP type are excluded.
4. **Roll mode** — each item's `maxRolls` are adjusted by the selected roll mode (Max / 75% / Avg / Min) before the Item object is created; the pool is thus pre-baked.
5. **Illegal sets** — sets whose 2-piece bonus has `illegal: true` (e.g. Morph) are tracked so the DFS can reject combinations containing two different items from the same such set.
6. A **NONE item** is prepended to every pool so "leave slot empty" is a valid candidate.

Locked slots (items the user pinned manually) are collected separately and removed from the pools — they do not vary during search.

---

## Step 3 — Work Partitioning (`_partition_work`)

The search space is split into fine-grained partitions (4× the worker count) to enable **work-stealing**: idle workers pick up partitions that slower workers haven't started yet.

Partition strategy (first applicable wins):

| Situation | Partition target | Balance method |
|-----------|-----------------|----------------|
| Both rings free | Outer ring index `i` (inner `j` iterates `i..N`) | Triangular load balancing (each outer step covers `N−i` inner steps) |
| One ring free | Ring pool sliced evenly | Equal-chunk slicing |
| No free rings | Largest free armor/accessory pool | Equal-chunk slicing |

Each partition descriptor is `{type, slot?, start, end}`.

---

## Step 4 — Worker Protocol

### Init message (main → worker, once per worker)
Heavy structured-clone payload: serialized pools, locked items, weapon statMap, tome statMaps, guild tome statMap, atree state, combo rows, boost registry, sets data, etc. The first partition is embedded directly so the worker starts immediately on receipt.

### Run message (main → worker, subsequent partitions)
Lightweight: just `{type:'run', partition, worker_id}`. The worker reuses the already-stored `_cfg` for all heavy data, only updating which slice of a pool to search.

### Progress message (worker → main)
Sent every 5 000 candidates. Contains `checked`, `feasible`, and the worker's current top-5 item name lists (not full objects, to minimise clone cost).

### Done message (worker → main)
Sent when a partition finishes. Contains final `checked`, `feasible`, and `top5`. The main thread calls `_on_partition_done`, which accumulates the results and dispatches the next partition from the queue (work-stealing).

---

## Step 5 — DFS in the Worker (`_run_dfs`)

### Setup (one-time per partition)

1. **Running SP state** — `running_sum_prov[5]` and `running_max_req[5]` are initialised from locked items, weapon, and guild tome. These scalars track, per SP attribute, how much the current partial build provides and what the highest requirement seen so far is. They are updated incrementally as items are placed/removed.

2. **Suffix best-provision table** — for each free armor slot (sorted smallest pool first) the maximum SP provision any single item offers is recorded. Suffix sums of these maximums give an *optimistic upper bound* on how much SP the remaining slots could still provide. This feeds the mid-DFS SP prune check described below; that check is **known to produce false positives** (see Key Weaknesses).

3. **Running statMap** — a `Map` pre-loaded with level base HP and the fixed items (locked equips + tomes + weapon). Free items are added and subtracted from this Map in-place during DFS, avoiding a full rebuild at every leaf.

4. **Illegal-set tracker** — a lightweight counter that detects when two different items from the same illegal set are simultaneously in the partial build.

### Ring iteration (outermost)

Rings are handled outside the main `dfs()` recursion because both rings draw from the **same pool** and the pair must be unordered (item at ring1 ≤ item at ring2 by pool index, to avoid counting `(A,B)` and `(B,A)` separately). Three cases:

- **Both free** — double loop `i ≤ j`; ring1 = `pool[i]`, ring2 = `pool[j]`. Partition applies to the outer index.
- **One locked** — single loop over the free ring.
- **Both locked** — skip ring iteration entirely, fall straight to `dfs(0)`.

Each ring is placed via `_place_item` (updates SP state and running statMap) and removed via `_unplace_item` on backtrack.

### Armor/accessory DFS (`dfs(slot_idx)`)

Slots are iterated in ascending pool-size order (smallest first) so the tree is widest at the bottom — this maximises the usefulness of early pruning.

For each item candidate in the current slot:

1. **Illegal-set check** — if the tracker says this item conflicts with an already-placed item from the same illegal set, skip.
2. **Place** — `running_sum_prov`, `running_max_req`, and `running_sm` are updated.
3. **SP prune check** (if pruning is enabled) — computes `net_i = running_max_req[i] − (running_sum_prov[i] + suffix_best_prov[next_depth][i])` for each attribute. If any `net_i > 100` or `Σ net_i > sp_budget`, the subtree is skipped. In theory this is a sound upper-bound argument: the suffix table gives the best possible additional provision from every remaining slot, so if even that cannot cover requirements, no descendant can be feasible. **In practice the check fires incorrectly and prunes many valid combinations, including the optimal build.** The root cause has not yet been isolated; see Key Weaknesses. The pruning toggle in the UI (on by default) must be turned off to guarantee a correct exhaustive search.
4. **Recurse** — `dfs(slot_idx + 1)`.
5. **Backtrack** — `_unplace_item` restores `running_sum_prov` and `running_sm`. `running_max_req` is restored from a saved snapshot (max-of-maximums is not directly reversible).

---

## Step 6 — Leaf Evaluation (`_evaluate_leaf`)

Reached when all free armor/accessory slots have been filled. Three gates before scoring:

### Gate 1: Quick SP pre-filter (`_sp_prefilter`)
An O(1) sanity check (no `calculate_skillpoints` call yet). For each attribute, computes `max_req − sum_prov` across all 9 items. If any attribute's net deficit > 100 or the total > `sp_budget`, reject immediately.

### Gate 2: Full SP feasibility (`calculate_skillpoints`)
Calls the recursive backtracking solver that respects Wynncraft's SP assignment rules. Returns `[base_sp, total_sp, assigned_sp, activeSetCounts]`. If `assigned_sp > sp_budget`, reject.

### Stat assembly (`_finalize_leaf_statmap`)
Finalises the running statMap by:
1. Applying set bonuses for active sets (non-SP bonuses only).
2. Setting up `damMult`, `defMult`, `healMult` maps.
3. Collecting `majorIds` from all items.

Then `_assemble_combo_stats` layers on top:
1. Inject `total_sp` values and `classDef` multiplier.
2. Merge `atree_raw` stats.
3. Apply radiance scaling (multiplies positive values of ~70 affected stat IDs).
4. Run `worker_atree_scaling` to apply conditional/slider-driven atree bonuses.
5. Merge atree-scaling stats and static boosts (for threshold checking).

### Gate 3: Stat thresholds
If the user set any restrictions (e.g. "EHP ≥ 50000", "hprRaw ≥ 200"), the assembled stats are checked. EHP is computed via `getDefenseStats`. Any violation rejects the candidate.

### Scoring (`_eval_combo_damage`)
For each combo row:
1. Apply per-row boost tokens via `apply_combo_row_boosts` → cloned stats with updated `damMult` / `defMult`.
2. Apply spell property overrides (e.g. slider-driven hit-count changes) via `apply_spell_prop_overrides`.
3. Compute average damage via `computeSpellDisplayAvg` (calls `calculateSpellDamage` internally, blends normal and crit damage by dexterity crit chance).
4. Multiply by quantity.

The total is the candidate's **score**.

### Top-5 heap
If the score beats the current 5th-best, the candidate is inserted and the list is re-sorted. Only item names are stored (not full statMaps) to minimise memory.

---

## Step 7 — Result Aggregation (main thread)

### Interim updates (every 5 seconds)
The main thread's progress timer checks each worker's latest `_cur_top5` (from the most recent progress message) and each worker's cumulative `top5` (from completed partitions). These are merged into a global top-5, the best build is loaded into the UI via `_fill_build_into_ui`, and the results panel is refreshed.

### Final merge (`_on_all_workers_done`)
When `active_count` drops to zero (all partitions finished):
1. Aggregate `checked` and `feasible` counts from all workers.
2. Merge top-5 from all workers' cumulative lists.
3. Reconstruct full `Item` objects from stored names (via `itemMap`).
4. Load the best build into the UI; display the ranked results panel.
5. Show a summary line (count, feasible, elapsed time).

### Result panel
Each of the top-5 results is shown as a clickable row. Clicking calls `_fill_build_into_ui` with that result. A new-tab link opens a URL whose hash encodes the full item set.

---

## Key Optimisations

| Technique | Where | Effect |
|-----------|-------|--------|
| Incremental SP state | `_place_item` / `_unplace_item` | Tracks running provision/requirement totals; used correctly at the leaf and as input to the (currently broken) mid-DFS prune |
| Suffix best-provision table | Built once before DFS | Feeds mid-DFS SP pruning — **currently produces false positives; see Key Weaknesses** |
| Incremental statMap | `_init_running_statmap` + `_incr_add/remove_item` | Avoids full stat rebuild at every leaf |
| Leaf SP pre-filter | `_sp_prefilter` before `calculate_skillpoints` | Rejects infeasible combos before expensive solver call |
| Pool sort (smallest first) | `free_armor_slots.sort(...)` | Maximises pruning effectiveness |
| Work-stealing partitions | 4× worker count | Keeps all cores busy even when partition sizes are unequal |
| Illegal-set tracker | `_make_illegal_tracker()` | O(1) check per item for set-conflict rejection |
| Triangular ring partitioning | `_partition_work` | Equal work distribution for the (i,j) ring double-loop |

---

## Key Weaknesses

### SP pruning produces false positives (active bug)
The mid-DFS SP prune check (`_sp_prune_check`) eliminates many valid item combinations, including the optimal build. It is enabled by default, meaning the solver currently cannot be trusted to find the best build without first toggling pruning off.

The check is intended to be a sound upper-bound argument: for each SP attribute, compute the maximum provision the remaining free slots could possibly contribute (sum of per-slot maxima, precomputed in `suffix_best_prov`). If even this optimistic total cannot cover the maximum requirement seen so far, no descendant build can be SP-feasible, so prune. Theoretically this should only ever prune branches that are genuinely infeasible.

In practice the check fires on feasible branches. The root cause is not yet pinned down; leading theories:

- **Wynncraft SP is order-dependent.** `calculate_skillpoints` uses recursive backtracking because the order in which items are equipped matters — bonus SP from one item may enable another item's requirement to be met. The prune check models SP as a simple scalar budget, ignoring this sequencing. In some configurations the minimum *assignable* SP is higher than the `max_req − sum_prov` estimate predicts, causing the estimate to be too optimistic. It is not yet clear how this creates false prunes (the wrong direction of error) rather than missed prunes.
- **Items with negative `skillpoints` values** (items that subtract SP from an attribute) make `running_sum_prov[i]` smaller, which inflates the apparent deficit. If the suffix table simultaneously underestimates remaining provision for that attribute (e.g. only the NONE item offers non-negative provision), the check can compute a deficit large enough to trigger pruning even when `calculate_skillpoints` would find a valid assignment.
- **Guild tome omission in the leaf pre-filter.** `_sp_prefilter` sums `skillpoints` for the 8 equipment statMaps and the weapon but not the guild tome, whose bonuses ARE counted by `calculate_skillpoints`. Builds right at the edge of feasibility may be incorrectly rejected at the leaf. This doesn't explain DFS-level false prunes but compounds the issue.

**Workaround:** turn off the Pruning toggle in the solver UI. This forces an exhaustive search and is the only way to guarantee the optimal build is found.

### Score-blind DFS
The DFS has no awareness of damage potential while traversing the tree. It prunes only on SP feasibility, never on whether remaining slots could possibly beat the current best score. This means the search does full work even when an entire subtree is provably suboptimal — slow for large pools once a good build has already been found.

### No item dominance pre-filtering
Pool items are not compared against each other before search. If item A has equal-or-better damage-relevant stats and equal-or-lower SP requirements than item B, B can never be part of an optimal solution, but it still occupies a pool slot and receives full DFS visits. Pools could be 20–40% smaller without losing optimality.

### `calculate_skillpoints` called at every feasible leaf
Even when the running incremental SP state already shows `sum_prov[i] ≥ max_req[i]` for every attribute — meaning no manual SP assignment is needed — the full recursive backtracking solver is still invoked. This is the most expensive single call per leaf. A fast-path that skips it when provably unnecessary was designed but deferred because `sum_prov ≥ max_req` is necessary but not sufficient for zero-assignment (Wynncraft's equipping order adds further constraints).

### Ring slots are special-cased throughout
Because both rings draw from the same pool and the pair is unordered, rings are handled with a separate double-loop outside the generic `dfs()` function. This creates three code paths (both free, one free, both locked) and complicates partitioning. Armor slots benefit from the generic slot-ordering optimisation; rings cannot be trivially slotted into it.

### Worker count is user-controlled without hardware validation
The thread-count selector allows up to 16 workers regardless of the machine's actual core count. Over-provisioning creates OS-level context-switch overhead that can make search slower, not faster. `navigator.hardwareConcurrency` is used for the "Auto" setting but manual selection has no cap enforcement.

### Single-target, single-combo objective only
Scoring is defined as the sum of average damage over one fixed combo sequence. Builds that are strong on AoE, sustained damage over time, or defensive value (EHP) are evaluated only through stat thresholds, not as first-class objectives. Multi-target or weighted multi-objective scoring is not supported.

---

## Potential Improvements

### Correct mid-DFS SP pruning
Design and verify a pruning predicate that is provably sound — i.e. one that never prunes a SP-feasible combination. The core challenge is that Wynncraft's SP system is order-dependent: the minimum assigned SP required by a set of items can be higher than `max(reqs) − Σ(bonuses)` due to equipping-order constraints. Any correct predicate must either (a) account for ordering by running a lightweight feasibility check mid-DFS rather than the full backtracking solver, or (b) derive a provably conservative lower bound on assigned SP that is still tight enough to prune meaningfully. Once a correct predicate exists, the `suffix_best_prov` table can be reintroduced to compute the complementary upper bound on remaining provision.

### Damage-based branch-and-bound
Precompute per pool the maximum damage any single item could contribute (e.g., by running the combo calc against each item independently). During DFS, sum the optimistic per-slot maxima for remaining slots. If `current_partial_damage + optimistic_remaining < best_score_so_far`, prune the subtree. Even a loose upper bound becomes highly effective once a good initial solution seeds `best_score_so_far`.

### Two-phase solve
Phase 1: run a fast heuristic (greedy best-item-per-slot, beam search, or random sampling) to quickly find a strong build. Phase 2: run the full DFS with branch-and-bound seeded by Phase 1's score. A tight initial bound can prune the majority of the search space on the very first pass.

### Item dominance pruning (pre-search)
Before spawning workers, scan each pool for dominated items. Item B is dominated by item A if A has equal-or-better values for every damage-relevant stat and equal-or-lower SP requirements. Remove B from the pool permanently. Since stat interactions are nonlinear (e.g., elemental damage is multiplicative), this is approximate — but removing obvious dominatees shrinks pool sizes without affecting result quality in practice.

### Fast-path for zero-assignment SP
When the incremental state shows `sum_prov[i] ≥ max_req[i]` for all attributes, skip `calculate_skillpoints` and set `assigned_sp = 0`, `total_sp = base_sp` directly. The blocker is that Wynncraft's equipping order can cause the SP solver to fail even when aggregate provision exceeds aggregate requirement (order-dependent SP propagation). A correct fast-path requires either a greedy order-check or a proof that the SP state is order-independent.

### Integrate rings into generic slot ordering
Move ring iteration into the main `dfs()` loop (treating rings as a single "ring pair" slot with a pool of `(i, j)` pairs). This would unify the three ring-case code paths, allow rings to participate in the smallest-first slot ordering, and simplify partitioning. The `i ≤ j` constraint and pool-level duplicate filtering would need to be encoded in the pair pool.

### Weighted multi-objective scoring
Replace the single combo-damage score with a weighted sum of multiple objectives: `w₁ × damage + w₂ × EHP + w₃ × mana_sustain + ...`. Users specify weights. This makes the solver useful for tank, support, or hybrid builds without changing the search algorithm — only the leaf scoring function changes.

### Tome optimisation
Tomes are currently fixed inputs (user-specified). Including tomes in the search space would require expanding the pool to ~7 additional slots (each with their own item pool), multiplying the search space significantly. A separate inner loop or a post-pass heuristic (swap tomes given a fixed armor build) would be more tractable than a full joint search.

### GPU parallelisation
Each leaf evaluation is independent and the scoring function (combo damage calc) is a fixed arithmetic pipeline. This is structurally suited to GPU compute (WebGPU). The main blocker is that the SP feasibility check (`calculate_skillpoints`) is a recursive backtracking solver that is hard to vectorise; it would need to be replaced with a parallel-friendly formulation (e.g., an LP relaxation or a lookup table) before GPU acceleration is practical.
