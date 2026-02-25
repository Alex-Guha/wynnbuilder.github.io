// ══════════════════════════════════════════════════════════════════════════════
// PHASE 6: SOLVER CORE
// ══════════════════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────────────────

let _solver_running = false;
let _solver_top5 = [];   // [{score, items:[Item×8], base_sp, total_sp, assigned_sp}]
let _solver_checked = 0;
let _solver_feasible = 0;
let _solver_start = 0;
let _solver_last_ui = 0;
let _solver_total = 0;    // total candidate count (product of pool sizes)
let _solver_last_eta = 0;    // timestamp of last ETA DOM update

// Bitmask tracking which equipment slots (0=helmet…7=necklace) were last filled by
// the solver (vs by the user). Persisted to URL as ?sfree=N so a page reload restores
// the same lock / free distinction.
let _solver_free_mask = 0;

// Set to true while _fill_build_into_ui is dispatching change events so that the
// per-input 'change' listeners below know not to clear the solverFilled flag.
let _solver_filling_ui = false;

// ── Stat-map helpers ──────────────────────────────────────────────────────────

/**
 * Deep-clone a StatMap, ensuring nested Maps (damMult, defMult, healMult) are
 * separate objects so mutation in one path doesn't bleed into another.
 */
function _deep_clone_statmap(sm) {
    const ret = new Map(sm);
    for (const k of ['damMult', 'defMult', 'healMult']) {
        const v = sm.get(k);
        if (v instanceof Map) ret.set(k, new Map(v));
    }
    return ret;
}

/**
 * Merge all entries from `source` StatMap into `target` using merge_stat().
 * Handles both flat dot-notation keys ('damMult.Potion') and nested Maps.
 */
function _merge_into(target, source) {
    if (!source) return;
    for (const [k, v] of source) {
        if (v instanceof Map) {
            for (const [mk, mv] of v) merge_stat(target, k + '.' + mk, mv);
        } else {
            merge_stat(target, k, v);
        }
    }
}

/**
 * Apply Radiance / Divine Honor scaling to a StatMap.
 * Mirrors solver_radiance_node.compute_func exactly, but reads boost factor
 * from a pre-snapshotted value rather than the DOM.
 */
function _apply_radiance_scale(statMap, boost) {
    if (boost === 1) return statMap;
    const ret = new Map(statMap);
    for (const id of radiance_affected) {
        const val = ret.get(id) || 0;
        if (reversedIDs.includes(id)) {
            if (val < 0) ret.set(id, Math.floor(val * boost));
        } else {
            if (val > 0) ret.set(id, Math.floor(val * boost));
        }
    }
    return ret;
}

/**
 * Quick SP feasibility upper-bound check.  O(1) per candidate.
 * Returns false if the total net SP demand clearly exceeds the budget.
 */
function _sp_prefilter(items_8_sms, wep_sm, sp_budget) {
    // The player only needs enough SP to satisfy the single highest per-attribute requirement
    // (once you can equip the most demanding item for an attribute, all others follow).
    // Using sum_req instead of max_req is wrong and over-rejects valid builds.
    const all = [...items_8_sms, wep_sm];
    let total_net = 0;
    for (let i = 0; i < 5; i++) {
        let max_req = 0, sum_prov = 0;
        for (const sm of all) {
            const req = sm.get('reqs')?.[i] ?? 0;
            if (req > max_req) max_req = req;
            sum_prov += sm.get('skillpoints')?.[i] ?? 0;
        }
        // Only need assigned SP if there's an actual requirement to meet.
        // When max_req=0, no SP needed regardless of negative provisions.
        const net = max_req > 0 ? Math.max(0, max_req - sum_prov) : 0;
        if (net > 100) return false;
        total_net += net;
    }
    return total_net <= sp_budget;
}

/**
 * Apply the active roll mode to an Item's maxRolls in-place.
 * Mirrors ItemInputNode.compute_func roll-mode logic.
 */
function _apply_roll_mode_to_item(item) {
    if (current_roll_mode === ROLL_MODES.MAX) return item;
    const minR = item.statMap.get('minRolls');
    const maxR = item.statMap.get('maxRolls');
    if (!minR || !maxR) return item;
    for (const [k, maxVal] of maxR) {
        const minVal = minR.get(k) ?? maxVal;
        maxR.set(k, getRolledValue(minVal, maxVal));
    }
    return item;
}

// ── Item pool building ────────────────────────────────────────────────────────

/**
 * Returns locked items (non-NONE) for each of the 8 equipment slots.
 * Result keys: 'helmet', 'chestplate', 'leggings', 'boots',
 *              'ring1', 'ring2', 'bracelet', 'necklace'
 */
function _collect_locked_items() {
    const locked = {};
    for (let i = 0; i < 8; i++) {
        const slot = equipment_fields[i];   // helmet…necklace (no weapon)
        const node = solver_item_final_nodes[i];
        const item = node?.value;
        if (!item || item.statMap.has('NONE')) continue;
        // Slots filled by the solver (not by the user) remain free targets.
        const input = document.getElementById(slot + '-choice');
        if (input?.dataset.solverFilled === 'true') continue;
        locked[slot] = item;
    }
    return locked;
}

/**
 * Build per-slot candidate item pools filtered by restrictions.
 * Returns { helmet:[Item…], chestplate:[Item…], … ring:[Item…], … }
 * Note: ring1 and ring2 share the same 'ring' pool.
 * Locked slots are not present in the result (caller should skip them).
 */
function _build_item_pools(restrictions, illegal_at_2 = new Set()) {
    const slot_types = {
        helmet: 'helmet',
        chestplate: 'chestplate',
        leggings: 'leggings',
        boots: 'boots',
        ring: 'ring',
        bracelet: 'bracelet',
        necklace: 'necklace',
    };
    const sp_keys = skp_order;   // ['str','dex','int','def','agi']
    const pools = {};

    for (const [slot, type] of Object.entries(slot_types)) {
        const pool = [];
        const names = itemLists.get(type) ?? [];
        for (const name of names) {
            const item_obj = itemMap.get(name);
            if (!item_obj) continue;
            // Skip the "No Helmet / No Ring 1" none items
            if (item_obj.name?.startsWith('No ')) continue;
            // Level filter
            const lvl = item_obj.lvl ?? 0;
            if (lvl < restrictions.lvl_min || lvl > restrictions.lvl_max) continue;
            // Major ID filter
            if (restrictions.no_major_id && item_obj.majorIds?.length > 0) continue;
            // Build direction filter
            let skip = false;
            for (let i = 0; i < 5; i++) {
                if (!restrictions.build_dir[sp_keys[i]]) {
                    if ((item_obj.reqs?.[i] ?? 0) > 0) { skip = true; break; }
                }
            }
            if (skip) continue;
            // Create Item and apply roll mode
            const item = _apply_roll_mode_to_item(new Item(item_obj));
            // Tag with illegal set name + item name for duplicate-equip detection
            const sn = item_obj.set ?? null;
            item._illegalSet = (sn && illegal_at_2.has(sn)) ? sn : null;
            item._illegalSetName = item._illegalSet ? (item_obj.displayName ?? item_obj.name ?? '') : null;
            pool.push(item);
        }
        // Add the NONE item first (allows leaving slot empty when beneficial).
        // Must wrap in Item so .statMap is available in the search hot path.
        const none_idx = _NONE_ITEM_IDX[slot === 'ring' ? 'ring1' : slot];
        pool.unshift(new Item(none_items[none_idx]));
        pools[slot] = pool;
    }
    return pools;
}

// ── Solver snapshot ───────────────────────────────────────────────────────────

/**
 * Parse current combo rows into reusable objects for the search hot path.
 * Returns [{qty, spell, boost_tokens, dmg_excl}] — filtered to spells with damage.
 */
function _parse_combo_for_search(spell_map, weapon) {
    // Augment spell_map with powder specials (mirrors SolverComboTotalNode logic)
    const weapon_powders = weapon?.statMap?.get('powders') ?? [];
    const aug = new Map(spell_map);
    for (const ps_idx of [0, 1, 3]) {
        const tier = get_element_powder_tier(weapon_powders, ps_idx);
        if (tier > 0) aug.set(-1000 - ps_idx, make_powder_special_spell(ps_idx, tier));
    }
    const rows = solver_combo_total_node._read_combo_rows(aug);
    return rows
        .map(r => ({
            qty: r.qty,
            spell: r.spell,
            boost_tokens: r.boost_tokens,
            dmg_excl: r.dom_row?.querySelector('.combo-dmg-toggle')
                ?.classList.contains('dmg-excluded') ?? false,
        }))
        .filter(r => r.qty > 0 && r.spell && spell_has_damage(r.spell) && !r.dmg_excl);
}

/**
 * Snapshot all fixed-during-search state from the live computation graph.
 * Must be called after the graph has settled (all nodes up to date).
 */
function _build_solver_snapshot(restrictions) {
    const weapon = solver_item_final_nodes[8]?.value;
    const level = parseInt(document.getElementById('level-choice').value) || 106;

    // Tome items: solver_item_final_nodes[9..22]
    const tomes = solver_item_final_nodes.slice(9).map(n => n?.value).filter(Boolean);

    // Fixed atree stats (non-toggled raw_stat effects — independent of items)
    const atree_raw = atree_raw_stats.value ?? new Map();

    // atree_make_interactives output: [slider_map, button_map] — needed to call
    // atree_scaling.compute_func() per candidate
    const atree_interactive_val = atree_make_interactives.value;

    // Merged abilities (for boost registry + prop overrides)
    const atree_mgd = atree_merge.value;

    // Static boosts from Active Boosts panel (War Scream, Fortitude, etc.)
    // These are used for stat threshold checks but NOT for combo base (matches live graph).
    const static_boosts = solver_boosts_node.value ?? new Map();

    // Radiance boost factor (read from DOM once, fixed for entire search)
    let radiance_boost = 1;
    if (document.getElementById('radiance-boost')?.classList.contains('toggleOn')) radiance_boost += 0.2;
    if (document.getElementById('divinehonor-boost')?.classList.contains('toggleOn')) radiance_boost += 0.1;

    // SP budget based on guild tome setting
    const sp_budget = restrictions.guild_tome === 2 ? 205 :
        restrictions.guild_tome === 1 ? 204 : 200;

    // Guild tome Item for wynn_order passed to calculate_skillpoints.
    // Must always be an Item instance (with .statMap), not a raw none_tomes object.
    // restrictions.guild_tome only affects sp_budget; the actual item in the field is
    // always used regardless of the toggle so SP calculation receives valid statMaps.
    const guild_tome_idx = tome_fields.indexOf('guildTome1');
    const guild_tome_item = (guild_tome_idx >= 0 && solver_item_final_nodes[9 + guild_tome_idx]?.value)
        ? solver_item_final_nodes[9 + guild_tome_idx].value
        : new Item(none_tomes[2]);

    // Snapshotted spell map (approximation: stat-scaling prop effects use current build)
    const spell_map = atree_collect_spells.value ?? new Map();

    // Pre-build boost registry (fixed for entire search — uses current Build for powder entries)
    const boost_registry = build_combo_boost_registry(atree_mgd, solver_build_node.value);

    // Pre-parse combo rows
    const parsed_combo = _parse_combo_for_search(spell_map, weapon);

    return {
        weapon, level, tomes, atree_raw, atree_interactive_val,
        atree_mgd, static_boosts, radiance_boost, sp_budget,
        guild_tome_item, spell_map, boost_registry, parsed_combo,
        restrictions,
    };
}

// ── Per-candidate stat assembly ───────────────────────────────────────────────

/**
 * Assemble the combo_base StatMap for a single candidate Build.
 * Mirrors the live graph pipeline:
 *   build.statMap + atree_raw  →  pre_scale_agg
 *   → radiance scaling
 *   → atree_scaling.compute_func(radiance_scaled)
 *   → combo_base = radiance_scaled + atree_scaled_stats
 *
 * Returns { combo_base }.
 */
function _assemble_combo_stats(build, snap) {
    // 1. Start from build.statMap and deep-clone nested Maps to prevent mutation
    const pre_scale = _deep_clone_statmap(build.statMap);
    // Mirror SolverBuildStatExtractNode: overwrite per-item SP with final totals
    // and inject classDef — neither is stored in build.statMap itself.
    // Without this, crit%, spell scaling, and EHP are all wrong.
    for (let i = 0; i < skp_order.length; i++) {
        pre_scale.set(skp_order[i], build.total_skillpoints[i]);
    }
    const weaponType = build.weapon.statMap.get('type');
    if (weaponType) pre_scale.set('classDef', classDefenseMultipliers.get(weaponType) || 1.0);
    // 2. Merge fixed atree raw stats
    _merge_into(pre_scale, snap.atree_raw);
    // 3. Apply radiance / divine honor scaling
    const radiance_scaled = _apply_radiance_scale(pre_scale, snap.radiance_boost);
    // 4. Compute per-candidate atree scaling (depends on radiance_scaled stats)
    const fake_input = new Map([
        ['atree-merged', snap.atree_mgd],
        ['scale-stats', radiance_scaled],
        ['atree-interactive', snap.atree_interactive_val],
    ]);
    const [, atree_scaled_stats] = atree_scaling.compute_func(fake_input);
    // 5. combo_base = radiance_scaled + atree_scaled_stats
    const combo_base = _deep_clone_statmap(radiance_scaled);
    _merge_into(combo_base, atree_scaled_stats);
    return combo_base;
}

/**
 * Add static boosts on top of combo_base for stat threshold evaluation.
 * (Mirrors stat_agg in the live graph.)
 */
function _assemble_threshold_stats(combo_base, snap) {
    const s = _deep_clone_statmap(combo_base);
    _merge_into(s, snap.static_boosts);
    return s;
}

// ── Stat threshold check ──────────────────────────────────────────────────────

function _check_thresholds(stats, thresholds) {
    for (const { stat, op, value } of thresholds) {
        let v;
        if (stat === 'ehp') {
            // getDefenseStats() returns [defenses_list, [ehp_agi, ehp_none]]
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

// ── Combo damage evaluation ───────────────────────────────────────────────────

/**
 * Compute total combo damage for a candidate build given its combo_base stats.
 * Mirrors SolverComboTotalNode._compute() but without DOM writes.
 */
function _eval_combo_damage(combo_base, snap) {
    const wep_sm = snap.weapon.statMap;
    const crit = skillPointsToPercentage(combo_base.get('dex') || 0);
    let total = 0;
    for (const { qty, spell, boost_tokens } of snap.parsed_combo) {
        const { stats, prop_overrides } =
            apply_combo_row_boosts(combo_base, boost_tokens, snap.boost_registry);
        const mod_spell = apply_spell_prop_overrides(spell, prop_overrides, snap.atree_mgd);
        total += computeSpellDisplayAvg(stats, wep_sm, mod_spell, crit) * qty;
    }
    return total;
}

// ── Top-5 heap ────────────────────────────────────────────────────────────────

function _insert_top5(candidate) {
    _solver_top5.push(candidate);
    _solver_top5.sort((a, b) => b.score - a.score);
    if (_solver_top5.length > 5) _solver_top5.length = 5;
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function _update_solver_progress_ui() {
    const el_checked = document.getElementById('solver-checked-count');
    const el_feasible = document.getElementById('solver-feasible-count');
    const el_elapsed = document.getElementById('solver-elapsed-text');
    const el_total = document.getElementById('solver-total-count');
    const el_remaining = document.getElementById('solver-remaining-text');
    if (el_checked) el_checked.textContent = _solver_checked.toLocaleString();
    if (el_feasible) el_feasible.textContent = _solver_feasible.toLocaleString();
    if (el_total) el_total.textContent = _solver_total.toLocaleString();
    const now = Date.now();
    const elapsed_ms = now - _solver_start;
    if (el_elapsed) {
        const s = Math.floor(elapsed_ms / 1000);
        el_elapsed.textContent = s + 's';
    }
    // Update ETA at most once per second
    if (el_remaining && now - _solver_last_eta >= 1000) {
        _solver_last_eta = now;
        if (_solver_checked > 0 && _solver_total > _solver_checked) {
            const rate = elapsed_ms / _solver_checked;  // ms per candidate
            const remaining_s = Math.ceil(rate * (_solver_total - _solver_checked) / 1000);
            el_remaining.textContent = remaining_s >= 60
                ? Math.floor(remaining_s / 60) + 'm ' + (remaining_s % 60) + 's left'
                : remaining_s + 's left';
        } else {
            el_remaining.textContent = '';
        }
    }
    // Every 5 s: refresh result panel and fill best build
    if (now - _solver_last_ui >= 5000 && _solver_top5.length > 0) {
        _solver_last_ui = now;
        _fill_build_into_ui(_solver_top5[0]);
        _display_solver_results(_solver_top5);
    }
}

/**
 * Write the current _solver_free_mask to the URL as ?sfree=N.
 * A value of 0 removes the param entirely to keep URLs clean.
 */
function _write_sfree_url() {
    const url = new URL(window.location.href);
    if (_solver_free_mask !== 0) {
        url.searchParams.set('sfree', _solver_free_mask);
    } else {
        url.searchParams.delete('sfree');
    }
    window.history.replaceState(null, '', url.toString());
}

/**
 * Fill the 8 equipment slots with the items from a solver result.
 * Dispatches 'change' events so the computation graph updates normally.
 */
function _fill_build_into_ui(result) {
    _solver_filling_ui = true;
    _solver_free_mask = 0;
    for (let i = 0; i < 8; i++) {
        const slot = equipment_fields[i];   // helmet…necklace
        const item = result.items[i];
        const name = item.statMap.has('NONE') ? '' :
            (item.statMap.get('displayName') ?? item.statMap.get('name') ?? '');
        const input = document.getElementById(slot + '-choice');
        if (input) {
            if (input.value !== name) {
                // Value is changing — this slot was solver-chosen.
                input.dataset.solverFilled = 'true';
                _solver_free_mask |= (1 << i);
                input.value = name;
                input.dispatchEvent(new Event('change'));
            } else if (input.dataset.solverFilled === 'true') {
                // Value unchanged and was already solver-filled — keep it in the free mask.
                _solver_free_mask |= (1 << i);
            }
            // If value unchanged and solverFilled !== 'true', the slot is user-locked —
            // leave it alone so it keeps its slot-locked (green) styling.
        }
    }
    _solver_filling_ui = false;
    _write_sfree_url();
}

/**
 * Render the top-5 result cards into #solver-results-panel.
 * Each card loads the build into the current page on click, and has a ↗ link
 * that opens a new solver tab pre-filled with that build.
 */
function _display_solver_results(top5) {
    const panel = document.getElementById('solver-results-panel');
    if (!panel) return;
    if (!top5.length) { panel.innerHTML = ''; return; }
    const rows = top5.map((r, i) => {
        const score_str = Math.round(r.score).toLocaleString();
        const item_names = r.items.map(item => {
            if (item.statMap.has('NONE')) return '—';
            return item.statMap.get('displayName') ?? item.statMap.get('name') ?? '?';
        });
        const non_none = item_names.filter(n => n !== '—');
        const names_str = non_none.length ? non_none.join(', ') : '(all empty)';
        // Compute URL for opening this build in a new tab.
        // Reuses all current query params (roll, combo, restrictions) but swaps the hash.
        const result_hash = solver_compute_result_hash(r);
        let new_tab_link = '';
        if (result_hash) {
            const url = new URL(window.location.href);
            url.hash = result_hash;
            url.searchParams.delete('sfree');  // new tab = all slots user-chosen
            new_tab_link = `<a class="solver-result-newtab" href="${url.toString()}" ` +
                `target="_blank" title="Open in new tab" onclick="event.stopPropagation()">↗</a>`;
        }
        return `<div class="solver-result-row" title="${item_names.join(' | ')}" onclick="_fill_build_into_ui(_solver_top5[${i}])">` +
            `<span class="solver-result-rank">#${i + 1}</span>` +
            `<span class="solver-result-score">${score_str}</span>` +
            `<span class="solver-result-items small">${names_str}</span>` +
            new_tab_link +
            `</div>`;
    }).join('');
    panel.innerHTML =
        `<div class="text-secondary small mb-1">Top builds — click to load:</div>` + rows;
}

// ── The search ────────────────────────────────────────────────────────────────

/**
 * Async DFS over free equipment slots.
 * Yields to the event loop every YIELD_INTERVAL candidates to keep UI responsive.
 */
async function _run_solver_search(pools, locked, snap, illegal_at_2 = new Set()) {
    const YIELD_INTERVAL = 200;
    let yield_counter = 0;

    const { level, tomes, weapon, guild_tome_item, sp_budget } = snap;
    const wep_sm = weapon.statMap;

    // Determine which slots are free vs locked.
    // For ring: split based on which ring slots are locked.
    const ring1_locked = locked.ring1 ?? null;
    const ring2_locked = locked.ring2 ?? null;
    const ring_pool = pools.ring ?? [];

    // Free slot iteration order (excluding weapon which is always locked).
    // Rings are handled specially inside the DFS.
    const free_armor_slots = [];
    for (const slot of ['helmet', 'chestplate', 'leggings', 'boots', 'bracelet', 'necklace']) {
        if (!locked[slot]) free_armor_slots.push(slot);
    }
    const rings_free = !ring1_locked || !ring2_locked;  // at least one ring is free

    console.log('[solver] _run_solver_search — free_armor_slots:', free_armor_slots,
        '| rings_free:', rings_free, '| ring_pool.length:', ring_pool.length);

    // Pre-build Item instances for NONE slots (none_items are raw objects, not Item instances).
    const none_item_insts = none_items.slice(0, 8).map(ni => new Item(ni));

    // partial: holds Item for each of the 8 equipment positions
    const partial = {
        helmet: locked.helmet ?? none_item_insts[0],
        chestplate: locked.chestplate ?? none_item_insts[1],
        leggings: locked.leggings ?? none_item_insts[2],
        boots: locked.boots ?? none_item_insts[3],
        ring1: locked.ring1 ?? none_item_insts[4],
        ring2: locked.ring2 ?? none_item_insts[5],
        bracelet: locked.bracelet ?? none_item_insts[6],
        necklace: locked.necklace ?? none_item_insts[7],
    };

    // Tracks which distinct item names from each illegal-at-2 set are in the partial.
    // setName → Map<itemName, refCount>. A candidate is blocked only when a DIFFERENT item
    // from the same illegal set is already present. Equipping the same item in both ring
    // slots is valid (the game counts it as 1 unique set member, not 2).
    const illegal_set_occupants = new Map();
    const _occ_add = (setName, itemName) => {
        if (!illegal_set_occupants.has(setName)) illegal_set_occupants.set(setName, new Map());
        const m = illegal_set_occupants.get(setName);
        m.set(itemName, (m.get(itemName) ?? 0) + 1);
    };
    const _occ_remove = (setName, itemName) => {
        const m = illegal_set_occupants.get(setName);
        if (!m) return;
        const c = m.get(itemName) ?? 1;
        if (c <= 1) m.delete(itemName); else m.set(itemName, c - 1);
    };
    // Returns true if adding this item would create an illegal combo (a different item
    // from the same set is already present).
    const _occ_blocks = (is, iname) => {
        if (!is) return false;
        const m = illegal_set_occupants.get(is);
        return !!(m && m.size > 0 && !m.has(iname));
    };
    for (const item of Object.values(partial)) {
        if (!item || item.statMap.has('NONE')) continue;
        const name = item.statMap.get('displayName') ?? item.statMap.get('name') ?? '';
        const iobj = name ? itemMap.get(name) : null;
        const sname = iobj?.set ?? null;
        if (sname && illegal_at_2.has(sname) && name) _occ_add(sname, name);
    }

    // Inner synchronous DFS over free armor/accessory slots (excluding rings).
    // Ring iteration is handled by an outer ring loop below.
    async function dfs(slot_idx) {
        if (!_solver_running) return;

        if (slot_idx === free_armor_slots.length) {
            // Leaf: evaluate this candidate
            _solver_checked++;
            yield_counter++;
            if (_solver_checked === 1) console.log('[solver] first leaf reached — partial:', Object.fromEntries(
                Object.entries(partial).map(([k, v]) => [k, v.statMap?.get('displayName') ?? '?'])
            ));

            const equip_8_sms = [
                partial.helmet.statMap, partial.chestplate.statMap,
                partial.leggings.statMap, partial.boots.statMap,
                partial.ring1.statMap, partial.ring2.statMap,
                partial.bracelet.statMap, partial.necklace.statMap,
            ];
            // Tier 1: SP pre-filter (O(1))
            const _pre_ok = _sp_prefilter(equip_8_sms, wep_sm, sp_budget);
            if (_solver_checked <= 3) console.log('[solver] prefilter', _solver_checked,
                _pre_ok ? 'PASS' : 'FAIL',
                '| chest:', partial.chestplate.statMap?.get('displayName'));
            if (!_pre_ok) {
                if (yield_counter % YIELD_INTERVAL === 0) {
                    _update_solver_progress_ui();
                    await new Promise(r => setTimeout(r, 0));
                }
                return;
            }
            // Tier 2: Full SP feasibility via calculate_skillpoints
            const equip_8 = [
                partial.helmet, partial.chestplate,
                partial.leggings, partial.boots,
                partial.ring1, partial.ring2,
                partial.bracelet, partial.necklace,
            ];
            // wynn_order: [boots, legs, chest, helm, ring1, ring2, brace, neck, guildTome]
            const wynn_order = [
                partial.boots, partial.leggings, partial.chestplate, partial.helmet,
                partial.ring1, partial.ring2, partial.bracelet, partial.necklace,
                guild_tome_item,
            ];
            const build = new Build(level, equip_8, tomes, weapon, wynn_order);
            if (build.assigned_skillpoints > sp_budget) {
                if (_solver_feasible === 0 && _solver_checked <= 5) console.log(
                    '[solver] SP fail — assigned:', build.assigned_skillpoints, '> budget:', sp_budget,
                    '| chest:', partial.chestplate.statMap?.get('displayName'));
                if (yield_counter % YIELD_INTERVAL === 0) {
                    _update_solver_progress_ui();
                    await new Promise(r => setTimeout(r, 0));
                }
                return;
            }
            _solver_feasible++;

            // Tier 3: Stat assembly + threshold check
            const combo_base = _assemble_combo_stats(build, snap);
            if (snap.restrictions.stat_thresholds.length > 0) {
                const thresh_stats = _assemble_threshold_stats(combo_base, snap);
                if (!_check_thresholds(thresh_stats, snap.restrictions.stat_thresholds)) {
                    if (yield_counter % YIELD_INTERVAL === 0) {
                        _update_solver_progress_ui();
                        await new Promise(r => setTimeout(r, 0));
                    }
                    return;
                }
            }

            // Tier 4: Combo damage
            const score = _eval_combo_damage(combo_base, snap);
            _insert_top5({
                score,
                items: [...equip_8],
                base_sp: build.base_skillpoints,
                total_sp: build.total_skillpoints,
                assigned_sp: build.assigned_skillpoints,
            });

            if (yield_counter % YIELD_INTERVAL === 0) {
                _update_solver_progress_ui();
                await new Promise(r => setTimeout(r, 0));
            }
            return;
        }

        const slot = free_armor_slots[slot_idx];
        const pool = pools[slot];
        if (!pool) { await dfs(slot_idx + 1); return; }
        for (const item of pool) {
            if (!_solver_running) return;
            const is = item._illegalSet;
            if (_occ_blocks(is, item._illegalSetName)) continue;
            if (is) _occ_add(is, item._illegalSetName);
            partial[slot] = item;
            await dfs(slot_idx + 1);
            if (is) _occ_remove(is, item._illegalSetName);
        }
        // Restore to NONE / locked value after exhausting this slot's pool
        partial[slot] = locked[slot] ?? none_item_insts[_NONE_ITEM_IDX[slot]];
    }

    if (!rings_free) {
        // Both rings locked — just run the armor DFS directly
        await dfs(0);
    } else if (ring1_locked) {
        // ring1 fixed, ring2 free
        for (const r2 of ring_pool) {
            if (!_solver_running) break;
            const is = r2._illegalSet;
            if (_occ_blocks(is, r2._illegalSetName)) continue;
            if (is) _occ_add(is, r2._illegalSetName);
            partial.ring2 = r2;
            await dfs(0);
            if (is) _occ_remove(is, r2._illegalSetName);
        }
    } else if (ring2_locked) {
        // ring2 fixed, ring1 free
        for (const r1 of ring_pool) {
            if (!_solver_running) break;
            const is = r1._illegalSet;
            if (_occ_blocks(is, r1._illegalSetName)) continue;
            if (is) _occ_add(is, r1._illegalSetName);
            partial.ring1 = r1;
            await dfs(0);
            if (is) _occ_remove(is, r1._illegalSetName);
        }
    } else {
        // Both rings free — enumerate (ring_pool[i], ring_pool[j]) with i <= j
        // (avoids checking both (A,B) and (B,A) as separate combinations)
        for (let i = 0; i < ring_pool.length; i++) {
            if (!_solver_running) break;
            const r1 = ring_pool[i];
            const is1 = r1._illegalSet;
            if (_occ_blocks(is1, r1._illegalSetName)) continue;
            if (is1) _occ_add(is1, r1._illegalSetName);
            partial.ring1 = r1;
            for (let j = i; j < ring_pool.length; j++) {
                if (!_solver_running) break;
                const r2 = ring_pool[j];
                const is2 = r2._illegalSet;
                if (_occ_blocks(is2, r2._illegalSetName)) continue;
                if (is2) _occ_add(is2, r2._illegalSetName);
                partial.ring2 = r2;
                await dfs(0);
                if (is2) _occ_remove(is2, r2._illegalSetName);
            }
            if (is1) _occ_remove(is1, r1._illegalSetName);
        }
    }
    console.log('[solver] _run_solver_search done — checked:', _solver_checked, '| feasible:', _solver_feasible, '| top5:', _solver_top5.length);
}

// ── Top-level orchestrator ────────────────────────────────────────────────────

/** Called by the Solve/Stop button. */
function toggle_solver() {
    if (_solver_running) {
        _solver_running = false;
        const btn = document.getElementById('solver-run-btn');
        btn.textContent = 'Solve';
        btn.className = 'btn btn-sm btn-outline-success w-100';
        document.getElementById('solver-progress-text').style.display = 'none';
        return;
    }
    start_solver_search();
}

async function start_solver_search() {
    console.log('[solver] start_solver_search called');
    const restrictions = get_restrictions();
    console.log('[solver] restrictions:', restrictions);
    const snap = _build_solver_snapshot(restrictions);
    console.log('[solver] snapshot — weapon:', snap.weapon?.statMap?.get('displayName'),
        '| combo rows:', snap.parsed_combo.length,
        '| sp_budget:', snap.sp_budget,
        '| radiance_boost:', snap.radiance_boost);

    // Validate pre-conditions
    const err_el = document.getElementById('solver-error-text');
    if (err_el) err_el.textContent = '';

    if (!snap.weapon || snap.weapon.statMap.has('NONE')) {
        console.warn('[solver] no weapon set');
        if (err_el) err_el.textContent = 'Set a weapon before solving.';
        return;
    }
    if (snap.parsed_combo.length === 0) {
        console.warn('[solver] no combo rows with damage spells');
        if (err_el) err_el.textContent = 'Add combo rows with spells before solving.';
        return;
    }

    // Sets that are illegal when 2 or more of their items are equipped simultaneously.
    // bonuses[1] (count=2 bonus) having illegal:true is the marker used by the builder.
    const illegal_at_2 = new Set();
    for (const [setName, setData] of sets) {
        if (setData.bonuses?.length >= 2 && setData.bonuses[1]?.illegal) {
            illegal_at_2.add(setName);
        }
    }

    const locked = _collect_locked_items();
    console.log('[solver] locked slots:', Object.keys(locked));
    const pools = _build_item_pools(restrictions, illegal_at_2);
    console.log('[solver] pool sizes (before locking):', Object.fromEntries(
        Object.entries(pools).map(([k, v]) => [k, v.length])
    ));

    // Remove ring pool entries for locked ring slots
    if (locked.ring1 && locked.ring2) {
        delete pools.ring;
    } else if (locked.ring1) {
        // ring1 locked; pool used for ring2 only — keep pools.ring
    } else if (locked.ring2) {
        // ring2 locked; pool used for ring1 only — keep pools.ring
    }
    // Remove armor/accessory pools for locked slots
    for (const slot of ['helmet', 'chestplate', 'leggings', 'boots', 'bracelet', 'necklace']) {
        if (locked[slot]) delete pools[slot];
    }
    console.log('[solver] free pool sizes (after locking):', Object.fromEntries(
        Object.entries(pools).map(([k, v]) => [k, v.length])
    ));

    // Compute total candidate count (multiplicative product of free pool sizes).
    // Rings use n*(n+1)/2 when both are free (we enumerate i≤j pairs), or n when one is free.
    {
        let total = 1;
        for (const slot of ['helmet', 'chestplate', 'leggings', 'boots', 'bracelet', 'necklace']) {
            if (pools[slot]) total *= pools[slot].length;
        }
        if (pools.ring) {
            const n = pools.ring.length;
            if (!locked.ring1 && !locked.ring2) {
                total *= n * (n + 1) / 2;
            } else {
                total *= n;
            }
        }
        _solver_total = Math.round(total);
    }

    _solver_running = true;
    _solver_top5 = [];
    _solver_checked = 0;
    _solver_feasible = 0;
    _solver_start = Date.now();
    _solver_last_ui = Date.now();
    _solver_last_eta = Date.now();

    const _run_btn = document.getElementById('solver-run-btn');
    _run_btn.textContent = 'Stop';
    _run_btn.className = 'btn btn-sm btn-outline-danger';
    document.getElementById('solver-progress-text').style.display = '';  // progress appears inline alongside button

    await _run_solver_search(pools, locked, snap, illegal_at_2);
    const _search_completed = _solver_running;  // still true only if search finished naturally

    _solver_running = false;
    _run_btn.textContent = 'Solve';
    _run_btn.className = 'btn btn-sm btn-outline-success w-100';
    document.getElementById('solver-progress-text').style.display = 'none';

    // Final UI update
    _update_solver_progress_ui();
    _display_solver_results(_solver_top5);
    if (_solver_top5.length > 0) {
        _fill_build_into_ui(_solver_top5[0]);
    } else if (_search_completed) {
        // Search finished naturally with no valid builds — tell the user why
        const panel = document.getElementById('solver-results-panel');
        if (panel) {
            const reason = _solver_feasible === 0
                ? 'No builds satisfied the skill point requirements. Try relaxing restrictions or enabling guild tomes.'
                : 'No builds met the stat thresholds. Try lowering the restriction values.';
            panel.innerHTML = `<div class="text-warning small">${reason}</div>`;
        }
    }
}
