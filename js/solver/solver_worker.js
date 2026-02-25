// ══════════════════════════════════════════════════════════════════════════════
// SOLVER WEB WORKER
// Runs a synchronous DFS search over item combinations.
// No DOM access — all state is received via postMessage.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

importScripts(
    '../build_utils.js',
    '../powders.js',
    '../skillpoints.js',
    '../damage_calc.js',
    './solver_worker_shims.js'
);

// ── Globals set during init ─────────────────────────────────────────────────

let sets = new Map();   // needed by calculate_skillpoints → apply_skillpoints
let _cfg = null;        // full config from init message
let _cancelled = false;

// ── Search state ────────────────────────────────────────────────────────────

const PROGRESS_INTERVAL = 5000;
let _checked = 0;
let _feasible = 0;
let _top5 = [];

function _insert_top5(candidate) {
    _top5.push(candidate);
    _top5.sort((a, b) => b.score - a.score);
    if (_top5.length > 5) _top5.length = 5;
}

// ── Per-candidate stat assembly ─────────────────────────────────────────────

function _assemble_combo_stats(build_sm, total_sp, weapon_sm) {
    const pre_scale = _deep_clone_statmap(build_sm);
    for (let i = 0; i < skp_order.length; i++) {
        pre_scale.set(skp_order[i], total_sp[i]);
    }
    const weaponType = weapon_sm.get('type');
    if (weaponType) pre_scale.set('classDef', classDefenseMultipliers.get(weaponType) || 1.0);
    _merge_into(pre_scale, _cfg.atree_raw);
    const radiance_scaled = _apply_radiance_scale(pre_scale, _cfg.radiance_boost);
    const [, atree_scaled_stats] = worker_atree_scaling(
        _cfg.atree_merged, radiance_scaled, _cfg.button_states, _cfg.slider_states);
    const combo_base = _deep_clone_statmap(radiance_scaled);
    _merge_into(combo_base, atree_scaled_stats);
    return combo_base;
}

function _assemble_threshold_stats(combo_base) {
    const s = _deep_clone_statmap(combo_base);
    _merge_into(s, _cfg.static_boosts);
    return s;
}

function _check_thresholds(stats, thresholds) {
    for (const { stat, op, value } of thresholds) {
        let v;
        if (stat === 'ehp') {
            const def = getDefenseStats(stats);
            v = def?.[1]?.[0] ?? 0;
        } else {
            v = stats.get(stat) ?? 0;
        }
        if (op === 'ge' && v < value) return false;
        if (op === 'le' && v > value) return false;
    }
    return true;
}

function _eval_combo_damage(combo_base) {
    const wep_sm = _cfg.weapon_sm;
    const crit = skillPointsToPercentage(combo_base.get('dex') || 0);
    let total = 0;
    for (const { qty, spell, boost_tokens } of _cfg.parsed_combo) {
        const { stats, prop_overrides } =
            apply_combo_row_boosts(combo_base, boost_tokens, _cfg.boost_registry);
        const mod_spell = apply_spell_prop_overrides(spell, prop_overrides, _cfg.atree_merged);
        total += computeSpellDisplayAvg(stats, wep_sm, mod_spell, crit) * qty;
    }
    return total;
}

// ── Helper: get item display name from a statMap ────────────────────────────

function _get_item_name(sm) {
    if (sm.has('NONE')) return '';
    return sm.get('displayName') ?? sm.get('name') ?? '';
}

// ── Illegal-set tracking ────────────────────────────────────────────────────

function _make_illegal_tracker() {
    const occupants = new Map();
    return {
        add(setName, itemName) {
            if (!occupants.has(setName)) occupants.set(setName, new Map());
            const m = occupants.get(setName);
            m.set(itemName, (m.get(itemName) ?? 0) + 1);
        },
        remove(setName, itemName) {
            const m = occupants.get(setName);
            if (!m) return;
            const c = m.get(itemName) ?? 1;
            if (c <= 1) m.delete(itemName); else m.set(itemName, c - 1);
        },
        blocks(is, iname) {
            if (!is) return false;
            const m = occupants.get(is);
            return !!(m && m.size > 0 && !m.has(iname));
        }
    };
}

// ── Synchronous DFS ─────────────────────────────────────────────────────────
//
// Items in pools/locked are wrapper objects: { statMap: Map, _illegalSet, _illegalSetName }
// none_item_sms are raw statMaps (no illegal set info needed for NONE items).
// We wrap NONE items too for uniform handling in partial[].

function _run_dfs() {
    const { locked, weapon_sm, level, tome_sms, guild_tome_sm,
            sp_budget, restrictions, partition, none_item_sms,
            ring_pool, ring1_locked, ring2_locked, pruning } = _cfg;

    // Shallow-copy pools so partition slicing doesn't mutate _cfg.pools.
    // Without this, subsequent work-stealing partitions on the same worker
    // would see already-sliced (effectively empty) pools.
    const pools = { ..._cfg.pools };

    const tracker = _make_illegal_tracker();

    // Wrap NONE statMaps into the same {statMap, _illegalSet, _illegalSetName} format
    const none_items_wrapped = none_item_sms.map(sm => ({ statMap: sm, _illegalSet: null, _illegalSetName: null }));

    // Determine free armor/accessory slots, sorted by pool size ascending (smallest first)
    const free_armor_slots = [];
    for (const slot of ['helmet', 'chestplate', 'leggings', 'boots', 'bracelet', 'necklace']) {
        if (!locked[slot]) free_armor_slots.push(slot);
    }
    free_armor_slots.sort((a, b) => (pools[a]?.length ?? 0) - (pools[b]?.length ?? 0));

    const rings_free = !ring1_locked || !ring2_locked;

    // partial: holds item wrapper objects for each of the 8 equipment positions
    const partial = {
        helmet:     locked.helmet     ?? none_items_wrapped[0],
        chestplate: locked.chestplate ?? none_items_wrapped[1],
        leggings:   locked.leggings   ?? none_items_wrapped[2],
        boots:      locked.boots      ?? none_items_wrapped[3],
        ring1:      ring1_locked      ?? none_items_wrapped[4],
        ring2:      ring2_locked      ?? none_items_wrapped[5],
        bracelet:   locked.bracelet   ?? none_items_wrapped[6],
        necklace:   locked.necklace   ?? none_items_wrapped[7],
    };

    // Track illegal sets for locked items
    for (const item of Object.values(partial)) {
        if (!item || !item.statMap || item.statMap.has('NONE')) continue;
        const name = _get_item_name(item.statMap);
        const is = item._illegalSet;
        if (is && name) tracker.add(is, name);
    }

    // If this worker has a partition, apply it: restrict one slot's pool to [start, end)
    if (partition && partition.type === 'slot' && pools[partition.slot]) {
        pools[partition.slot] = pools[partition.slot].slice(partition.start, partition.end);
    }

    // ── Incremental SP state ────────────────────────────────────────────────
    // Tracks running skill point provisions and max requirements as items are placed.

    const running_sum_prov = new Float64Array(5);
    const running_max_req = [0, 0, 0, 0, 0];

    // Initialize from locked items + weapon + guild tome
    function _init_sp_state(item_sm) {
        const sp = item_sm.get('skillpoints');
        const reqs = item_sm.get('reqs');
        if (sp) for (let i = 0; i < 5; i++) running_sum_prov[i] += sp[i];
        if (reqs) for (let i = 0; i < 5; i++) { if (reqs[i] > running_max_req[i]) running_max_req[i] = reqs[i]; }
    }

    // Include weapon and guild tome
    _init_sp_state(weapon_sm);
    _init_sp_state(guild_tome_sm);
    // Include locked equipment
    for (const item of Object.values(partial)) {
        if (!item || !item.statMap || item.statMap.has('NONE')) continue;
        _init_sp_state(item.statMap);
    }

    // Precompute best provision per attribute for each free armor pool (for pruning bound)
    const best_prov_per_pool = [];
    for (let d = 0; d < free_armor_slots.length; d++) {
        const pool = pools[free_armor_slots[d]];
        const best = [0, 0, 0, 0, 0];
        if (pool) {
            for (const item of pool) {
                const sp = item.statMap.get('skillpoints');
                if (sp) for (let i = 0; i < 5; i++) { if (sp[i] > best[i]) best[i] = sp[i]; }
            }
        }
        best_prov_per_pool.push(best);
    }

    // Suffix sums: suffix_best_prov[d][i] = sum of best_prov[k][i] for k = d..N-1
    const N_free = free_armor_slots.length;
    const suffix_best_prov = [];
    for (let d = 0; d <= N_free; d++) suffix_best_prov.push(new Float64Array(5));
    for (let d = N_free - 1; d >= 0; d--) {
        for (let i = 0; i < 5; i++) {
            suffix_best_prov[d][i] = suffix_best_prov[d + 1][i] + best_prov_per_pool[d][i];
        }
    }

    // Pre-allocate stack for saving max_req at each DFS depth (max isn't reversible)
    const saved_max_req = [];
    for (let d = 0; d < N_free; d++) saved_max_req.push([0, 0, 0, 0, 0]);

    // ── Incremental stat accumulation ───────────────────────────────────────
    // Build base statMap from locked items + tomes + weapon. Free items are added/removed during DFS.

    const fixed_item_sms = [];
    // Locked equipment
    for (const item of Object.values(partial)) {
        if (item && item.statMap && !item.statMap.has('NONE')) fixed_item_sms.push(item.statMap);
    }
    // Tomes and weapon
    for (const t of tome_sms) fixed_item_sms.push(t);
    fixed_item_sms.push(weapon_sm);

    const running_sm = _init_running_statmap(level, fixed_item_sms);

    // ── SP pruning check ────────────────────────────────────────────────────

    function _sp_prune_check(next_depth) {
        let total_net = 0;
        const sfx = suffix_best_prov[next_depth];
        for (let i = 0; i < 5; i++) {
            const optimistic_prov = running_sum_prov[i] + sfx[i];
            const net = running_max_req[i] > optimistic_prov
                ? running_max_req[i] - optimistic_prov : 0;
            if (net > 100) return true;
            total_net += net;
        }
        return total_net > sp_budget;
    }

    // ── Progress reporting ──────────────────────────────────────────────────

    function _maybe_progress() {
        if (_checked % PROGRESS_INTERVAL === 0) {
            postMessage({
                type: 'progress',
                worker_id: _cfg.worker_id,
                checked: _checked,
                feasible: _feasible,
                top5_names: _top5.map(r => ({ score: r.score, item_names: r.item_names })),
            });
        }
    }

    // ── Leaf evaluation ─────────────────────────────────────────────────────

    function _evaluate_leaf() {
        _checked++;

        const equip_8_sms = [
            partial.helmet.statMap, partial.chestplate.statMap,
            partial.leggings.statMap, partial.boots.statMap,
            partial.ring1.statMap, partial.ring2.statMap,
            partial.bracelet.statMap, partial.necklace.statMap,
        ];

        // Leaf-level SP pre-filter (quick reject before full solver)
        if (!_sp_prefilter(equip_8_sms, weapon_sm, sp_budget)) {
            _maybe_progress();
            return;
        }

        // Full SP feasibility via calculate_skillpoints
        const wynn_order_sms = [
            partial.boots.statMap, partial.leggings.statMap,
            partial.chestplate.statMap, partial.helmet.statMap,
            partial.ring1.statMap, partial.ring2.statMap,
            partial.bracelet.statMap, partial.necklace.statMap,
            guild_tome_sm,
        ];
        const result = calculate_skillpoints(wynn_order_sms, weapon_sm);
        const assigned_sp = result[3];
        if (assigned_sp > sp_budget) {
            _maybe_progress();
            return;
        }
        _feasible++;

        const total_sp = result[2];
        const base_sp = result[1];
        const activeSetCounts = result[4];

        // Build stat assembly from running statMap (incremental accumulation)
        const all_equip_sms = [...equip_8_sms, ...tome_sms, weapon_sm];
        const build_sm = _finalize_leaf_statmap(running_sm, weapon_sm, activeSetCounts, sets, all_equip_sms);

        // Stat assembly + atree scaling
        const combo_base = _assemble_combo_stats(build_sm, total_sp, weapon_sm);

        // Threshold check
        if (restrictions.stat_thresholds.length > 0) {
            const thresh_stats = _assemble_threshold_stats(combo_base);
            if (!_check_thresholds(thresh_stats, restrictions.stat_thresholds)) {
                _maybe_progress();
                return;
            }
        }

        // Combo damage
        const score = _eval_combo_damage(combo_base);
        const item_names = equip_8_sms.map(sm => _get_item_name(sm));
        _insert_top5({ score, item_names, base_sp, total_sp, assigned_sp });
        _maybe_progress();
    }

    // ── Inner DFS helpers for SP + stat tracking ────────────────────────────

    function _place_item(item_sm) {
        const sp = item_sm.get('skillpoints');
        if (sp) for (let i = 0; i < 5; i++) running_sum_prov[i] += sp[i];
        const reqs = item_sm.get('reqs');
        if (reqs) for (let i = 0; i < 5; i++) { if (reqs[i] > running_max_req[i]) running_max_req[i] = reqs[i]; }
        _incr_add_item(running_sm, item_sm);
    }

    function _unplace_item(item_sm, saved_req) {
        const sp = item_sm.get('skillpoints');
        if (sp) for (let i = 0; i < 5; i++) running_sum_prov[i] -= sp[i];
        for (let i = 0; i < 5; i++) running_max_req[i] = saved_req[i];
        _incr_remove_item(running_sm, item_sm);
    }

    // ── DFS over free armor/accessory slots ─────────────────────────────────

    function dfs(slot_idx) {
        if (_cancelled) return;

        if (slot_idx === N_free) {
            _evaluate_leaf();
            return;
        }

        const slot = free_armor_slots[slot_idx];
        const pool = pools[slot];
        if (!pool) { dfs(slot_idx + 1); return; }

        const save = saved_max_req[slot_idx];

        for (const item of pool) {
            if (_cancelled) return;
            const is = item._illegalSet;
            const iname = item._illegalSetName;
            if (tracker.blocks(is, iname)) continue;
            if (is) tracker.add(is, iname);

            // Save max_req and place item
            for (let i = 0; i < 5; i++) save[i] = running_max_req[i];
            partial[slot] = item;
            _place_item(item.statMap);

            // Incremental SP prune check (pruning mode only)
            if (!pruning || !_sp_prune_check(slot_idx + 1)) {
                dfs(slot_idx + 1);
            }

            // Backtrack
            _unplace_item(item.statMap, save);
            if (is) tracker.remove(is, iname);
        }
        partial[slot] = locked[slot] ?? none_items_wrapped[_cfg.none_idx_map[slot]];
    }

    // ── Ring iteration (outermost loop) with SP + stat tracking ─────────────

    // saved_ring_max_req holds max_req snapshots for ring backtracking
    const saved_ring1_req = [0, 0, 0, 0, 0];
    const saved_ring2_req = [0, 0, 0, 0, 0];

    if (!rings_free) {
        dfs(0);
    } else if (ring1_locked) {
        const rp = ring_pool;
        const rp_start = (partition?.type === 'ring_single') ? partition.start : 0;
        const rp_end   = (partition?.type === 'ring_single') ? partition.end : rp.length;
        for (let j = rp_start; j < rp_end; j++) {
            if (_cancelled) break;
            const r2 = rp[j];
            const is = r2._illegalSet;
            if (tracker.blocks(is, r2._illegalSetName)) continue;
            if (is) tracker.add(is, r2._illegalSetName);
            for (let i = 0; i < 5; i++) saved_ring2_req[i] = running_max_req[i];
            partial.ring2 = r2;
            _place_item(r2.statMap);
            dfs(0);
            _unplace_item(r2.statMap, saved_ring2_req);
            if (is) tracker.remove(is, r2._illegalSetName);
        }
    } else if (ring2_locked) {
        const rp = ring_pool;
        const rp_start = (partition?.type === 'ring_single') ? partition.start : 0;
        const rp_end   = (partition?.type === 'ring_single') ? partition.end : rp.length;
        for (let j = rp_start; j < rp_end; j++) {
            if (_cancelled) break;
            const r1 = rp[j];
            const is = r1._illegalSet;
            if (tracker.blocks(is, r1._illegalSetName)) continue;
            if (is) tracker.add(is, r1._illegalSetName);
            for (let i = 0; i < 5; i++) saved_ring1_req[i] = running_max_req[i];
            partial.ring1 = r1;
            _place_item(r1.statMap);
            dfs(0);
            _unplace_item(r1.statMap, saved_ring1_req);
            if (is) tracker.remove(is, r1._illegalSetName);
        }
    } else {
        // Both rings free — enumerate (i, j) with i <= j
        const rp = ring_pool;
        const rp_start = (partition?.type === 'ring') ? partition.start : 0;
        const rp_end   = (partition?.type === 'ring') ? partition.end : rp.length;
        for (let i = rp_start; i < rp_end; i++) {
            if (_cancelled) break;
            const r1 = rp[i];
            const is1 = r1._illegalSet;
            if (tracker.blocks(is1, r1._illegalSetName)) continue;
            if (is1) tracker.add(is1, r1._illegalSetName);
            for (let k = 0; k < 5; k++) saved_ring1_req[k] = running_max_req[k];
            partial.ring1 = r1;
            _place_item(r1.statMap);
            for (let j = i; j < rp.length; j++) {
                if (_cancelled) break;
                const r2 = rp[j];
                const is2 = r2._illegalSet;
                if (tracker.blocks(is2, r2._illegalSetName)) continue;
                if (is2) tracker.add(is2, r2._illegalSetName);
                for (let k = 0; k < 5; k++) saved_ring2_req[k] = running_max_req[k];
                partial.ring2 = r2;
                _place_item(r2.statMap);
                dfs(0);
                _unplace_item(r2.statMap, saved_ring2_req);
                if (is2) tracker.remove(is2, r2._illegalSetName);
            }
            _unplace_item(r1.statMap, saved_ring1_req);
            if (is1) tracker.remove(is1, r1._illegalSetName);
        }
    }
}

// ── Message handler ─────────────────────────────────────────────────────────

self.onmessage = function(e) {
    const msg = e.data;
    if (msg.type === 'init') {
        // Heavy one-time initialization: store all shared data
        sets = new Map(msg.sets_data);
        _cfg = msg;
        _cancelled = false;

        // If partition is included, run immediately (single-message mode)
        if (msg.partition) {
            _checked = 0;
            _feasible = 0;
            _top5 = [];
            _run_dfs();
            postMessage({
                type: 'done',
                worker_id: msg.worker_id,
                checked: _checked,
                feasible: _feasible,
                top5: _top5,
            });
        }
    } else if (msg.type === 'run') {
        // Lightweight partition assignment — reuse stored _cfg data
        _cfg.partition = msg.partition;
        _cfg.worker_id = msg.worker_id;
        _checked = 0;
        _feasible = 0;
        _top5 = [];
        _cancelled = false;

        _run_dfs();

        postMessage({
            type: 'done',
            worker_id: msg.worker_id,
            checked: _checked,
            feasible: _feasible,
            top5: _top5,
        });
    } else if (msg.type === 'cancel') {
        _cancelled = true;
    }
};
