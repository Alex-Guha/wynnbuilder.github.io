// ══════════════════════════════════════════════════════════════════════════════
// SOLVER WORKER SHIMS
// Pure-function copies for Web Worker use. These are extracted from source files
// that have DOM dependencies at load time and cannot be imported via importScripts.
// ══════════════════════════════════════════════════════════════════════════════

// ── From utils.js (blocked by window.location at line 1) ────────────────────

const zip2 = (a, b) => a.map((k, i) => [k, b[i]]);

function round_near(value) {
    let eps = 0.00000001;
    if (Math.abs(value - Math.round(value)) < eps) {
        return Math.round(value);
    }
    return value;
}

function clamp(num, low, high) {
    return Math.min(Math.max(num, low), high);
}

function rawToPct(raw, pct) {
    let final = 0;
    if (raw < 0) {
        final = (Math.min(0, raw - (raw * pct)));
    } else if (raw > 0) {
        final = raw + (raw * pct);
    }
    return final;
}

function rawToPctUncapped(raw, pct) {
    let final = 0;
    if (raw < 0) {
        final = raw - (raw * pct);
    } else if (raw > 0) {
        final = raw + (raw * pct);
    }
    return final;
}

// ── From builder/build.js (blocked by DOM write at line 37) ─────────────────

const classDefenseMultipliers = new Map([
    ["relik", 0.60], ["bow", 0.70], ["wand", 0.80], ["dagger", 1.0], ["spear", 1.0]
]);

// ── From solver_graph_stat.js (blocked by ComputeNode classes) ──────────────

const radiance_affected = [
    "fDef","wDef","aDef","tDef","eDef","hprPct","mr","sdPct","mdPct","ls","ms",
    "ref","thorns","expd","spd","atkTier","poison","hpBonus","spRegen","eSteal",
    "hprRaw","sdRaw","mdRaw","fDamPct","wDamPct","aDamPct","tDamPct","eDamPct",
    "fDefPct","wDefPct","aDefPct","tDefPct","eDefPct","fixID","category",
    "spPct1","spRaw1","spPct2","spRaw2","spPct3","spRaw3","spPct4","spRaw4",
    "rSdRaw","sprint","sprintReg","jh",
    "eMdPct","eMdRaw","eSdPct","eSdRaw","eDamRaw",
    "tMdPct","tMdRaw","tSdPct","tSdRaw","tDamRaw",
    "wMdPct","wMdRaw","wSdPct","wSdRaw","wDamRaw",
    "fMdPct","fMdRaw","fSdPct","fSdRaw","fDamRaw",
    "aMdPct","aMdRaw","aSdPct","aSdRaw","aDamRaw",
    "nMdPct","nMdRaw","nSdPct","nSdRaw","nDamPct","nDamRaw",
    "damPct","damRaw",
    "rMdPct","rMdRaw","rSdPct","rDamPct","rDamRaw",
    "critDamPct","healPct","kb","weakenEnemy","slowEnemy","rDefPct",
];

function getDefenseStats(stats) {
    let defenseStats = [];
    let def_pct = skillPointsToPercentage(stats.get('def')) * skillpoint_final_mult[3];
    let agi_pct = skillPointsToPercentage(stats.get('agi')) * skillpoint_final_mult[4];
    let totalHp = stats.get("hp") + stats.get("hpBonus");
    if (totalHp < 5) totalHp = 5;
    defenseStats.push(totalHp);
    let ehp = [totalHp, totalHp];
    let defMult = (2 - stats.get("classDef"));
    for (const [, v] of stats.get("defMult").entries()) {
        defMult *= (1 - v / 100);
    }
    let agi_reduction = (100 - stats.get("agiDef")) / 100;
    ehp[0] = ehp[0] / (agi_reduction * agi_pct + (1 - agi_pct) * (1 - def_pct));
    ehp[0] /= defMult;
    ehp[1] /= (1 - def_pct) * defMult;
    defenseStats.push(ehp);
    let totalHpr = rawToPct(stats.get("hprRaw"), stats.get("hprPct") / 100.);
    defenseStats.push(totalHpr);
    let ehpr = [totalHpr, totalHpr];
    ehpr[0] = ehpr[0] / (agi_reduction * agi_pct + (1 - agi_pct) * (1 - def_pct));
    ehpr[0] /= defMult;
    ehpr[1] /= (1 - def_pct) * defMult;
    defenseStats.push(ehpr);
    defenseStats.push([def_pct * 100, agi_pct * 100]);
    let eledefs = [0, 0, 0, 0, 0];
    for (const i in skp_elements) {
        eledefs[i] = rawToPctUncapped(stats.get(skp_elements[i] + "Def"), (stats.get(skp_elements[i] + "DefPct") + stats.get("rDefPct")) / 100.);
    }
    defenseStats.push(eledefs);
    return defenseStats;
}

// ── From builder/atree.js (blocked by DOM-heavy atree code) ─────────────────

function atree_translate(atree_merged, v) {
    if (typeof v === 'string') {
        const [id_str, propname] = v.split('.');
        return atree_merged.get(parseInt(id_str)).properties[propname];
    }
    return v;
}

/**
 * Worker-safe version of atree_scaling.compute_func (atree.js:707-808).
 * Reads serialized button/slider state instead of DOM elements.
 *
 * @param {Map} atree_merged
 * @param {Map} pre_scale_stats
 * @param {Map<string, boolean>} button_states  - toggle name → on/off
 * @param {Map<string, number>}  slider_states  - slider name → integer value
 * @returns {[Map, Map]} [atree_edit, ret_effects]
 */
function worker_atree_scaling(atree_merged, pre_scale_stats, button_states, slider_states) {
    const atree_edit = new Map();
    for (const [abil_id, abil] of atree_merged.entries()) {
        atree_edit.set(abil_id, structuredClone(abil));
    }
    let ret_effects = new Map();

    function apply_bonus(bonus_info, value) {
        const { type, name, abil = null, mult = false } = bonus_info;
        if (type === 'stat') {
            merge_stat(ret_effects, name, atree_translate(atree_merged, value));
        } else if (type === 'prop') {
            const merge_abil = atree_edit.get(abil);
            if (merge_abil) {
                if (mult) merge_abil.properties[name] *= atree_translate(atree_edit, value);
                else      merge_abil.properties[name] += atree_translate(atree_edit, value);
            }
        }
    }

    for (const [abil_id, abil] of atree_merged.entries()) {
        if (abil.effects.length == 0) continue;

        for (const effect of abil.effects) {
            switch (effect.type) {
            case 'raw_stat':
                if (effect.toggle) {
                    if (!button_states.get(effect.toggle)) continue;
                    for (const bonus of effect.bonuses) apply_bonus(bonus, bonus.value);
                } else {
                    for (const bonus of effect.bonuses) {
                        if (bonus.type === 'stat') continue;
                        apply_bonus(bonus, bonus.value);
                    }
                }
                continue;
            case 'stat_scaling': {
                let total = 0;
                const { slider = false, scaling = [0], behavior = "merge" } = effect;
                let { positive = true, round = true } = effect;
                if (slider) {
                    if (behavior == "modify" && !slider_states.has(effect.slider_name)) continue;
                    const slider_val = slider_states.get(effect.slider_name) ?? 0;
                    if (effect.multiplicative) {
                        total = (((100 + atree_translate(atree_merged, scaling[0])) / 100) ** slider_val - 1) * 100;
                    } else {
                        total = slider_val * atree_translate(atree_merged, scaling[0]);
                    }
                    round = false;
                    positive = false;
                } else {
                    for (const [_scaling, input] of zip2(scaling, effect.inputs)) {
                        if (input.type === 'stat') {
                            total += (pre_scale_stats.get(input.name) || 0) * atree_translate(atree_merged, _scaling);
                        } else if (input.type === 'prop') {
                            const merge_abil = atree_edit.get(input.abil);
                            if (merge_abil) total += merge_abil.properties[input.name] * atree_translate(atree_merged, _scaling);
                        }
                    }
                }
                if ('output' in effect) {
                    if (round) total = Math.floor(round_near(total));
                    if (positive && total < 0) total = 0;
                    if ('max' in effect) {
                        let effect_max = atree_translate(atree_merged, effect.max);
                        if (effect_max > 0 && total > effect_max) total = effect.max;
                        if (effect_max < 0 && total < effect_max) total = effect.max;
                    }
                    if (Array.isArray(effect.output)) {
                        for (const output of effect.output) apply_bonus(output, total);
                    } else {
                        apply_bonus(effect.output, total);
                    }
                }
                continue;
            }
            }
        }
    }
    return [atree_edit, ret_effects];
}

// ── From solver_combo_boost.js (blocked by ComputeNode classes at file scope) ─

function computeSpellDisplayAvg(stats, weapon, spell, crit_chance) {
    const use_speed = spell.use_atkspd !== false;
    const use_spell = (spell.scaling ?? 'spell') === 'spell';
    const spell_result_map = new Map();
    for (const part of spell.parts) {
        spell_result_map.set(part.name, { type: 'need_eval', store_part: part });
    }

    function eval_part(part_name) {
        const dat = spell_result_map.get(part_name);
        if (!dat || dat.type !== 'need_eval') return dat;
        const part    = dat.store_part;
        const part_id = spell.base_spell + '.' + part.name;
        let result;

        if ('multipliers' in part) {
            const use_str       = part.use_str !== false;
            const ignored_mults = part.ignored_mults || [];
            const raw = calculateSpellDamage(
                stats, weapon, part.multipliers, use_spell, !use_speed,
                part_id, !use_str, ignored_mults);
            result = { type: 'damage', normal_total: raw[0], crit_total: raw[1] };
        } else if ('power' in part) {
            const mult_map = stats.get('healMult');
            let heal_mult = 1;
            for (const [k, v] of mult_map.entries()) {
                if (!k.includes(':') || k.split(':')[1] === part_id) heal_mult *= (1 + v / 100);
            }
            result = { type: 'heal', heal_amount: part.power * getDefenseStats(stats)[0] * heal_mult };
        } else {
            result = { type: null, normal_total: [0, 0], crit_total: [0, 0], heal_amount: 0 };
            for (const [sub_name, hits] of Object.entries(part.hits)) {
                const sub = eval_part(sub_name);
                if (!sub) continue;
                if (!result.type) result.type = sub.type;
                if (sub.type === 'damage') {
                    result.normal_total[0] += sub.normal_total[0] * hits;
                    result.normal_total[1] += sub.normal_total[1] * hits;
                    result.crit_total[0]   += sub.crit_total[0]   * hits;
                    result.crit_total[1]   += sub.crit_total[1]   * hits;
                } else if (sub.type === 'heal') {
                    result.heal_amount += sub.heal_amount * hits;
                }
            }
        }
        result.name    = part.name;
        result.display = part.display !== false;
        spell_result_map.set(part_name, result);
        return result;
    }

    const all_results = spell.parts.map(p => eval_part(p.name));
    let display_result = spell.display
        ? all_results.find(r => r?.name === spell.display)
        : null;
    if (!display_result) {
        display_result = [...all_results].reverse().find(r => r?.display && r?.type === 'damage');
    }
    if (!display_result || display_result.type !== 'damage') return 0;

    const non_crit_avg = (display_result.normal_total[0] + display_result.normal_total[1]) / 2;
    const crit_avg     = (display_result.crit_total[0]   + display_result.crit_total[1])   / 2;
    return (1 - crit_chance) * non_crit_avg + crit_chance * crit_avg;
}

function find_all_matching_boosts(token_name, token_value, is_pct, registry) {
    const name_lower = token_name.toLowerCase().trim();
    const results = [];
    for (const entry of registry) {
        const ename     = entry.name.toLowerCase();
        const aliases_l = (entry.aliases ?? []).map(a => a.toLowerCase());
        const exact_match = ename === name_lower
                         || ename === 'activate ' + name_lower
                         || aliases_l.includes(name_lower);
        if (entry.type === 'toggle') {
            if (exact_match) results.push({ entry, effective_value: 1 });
        } else {
            if (exact_match) {
                results.push({ entry, effective_value: token_value });
            } else if (is_pct && (ename.includes(name_lower) || ename.startsWith(name_lower))) {
                results.push({ entry, effective_value: token_value });
            }
        }
    }
    return results;
}

function apply_combo_row_boosts(base_stats, boost_tokens, registry) {
    const stats   = new Map(base_stats);
    const damMult = new Map(base_stats.get('damMult') ?? []);
    const defMult = new Map(base_stats.get('defMult') ?? []);
    stats.set('damMult', damMult);
    stats.set('defMult', defMult);
    const prop_overrides = new Map();

    for (const { name, value, is_pct } of boost_tokens) {
        const matches = find_all_matching_boosts(name, value, !!is_pct, registry);
        for (const { entry, effective_value } of matches) {
            for (const b of entry.stat_bonuses) {
                const contrib = b.value * effective_value;
                if (b.key.startsWith('damMult.')) {
                    const key = b.key.substring(8);
                    if (b.mode === 'max') damMult.set(key, Math.max(damMult.get(key) ?? 0, contrib));
                    else                  damMult.set(key, (damMult.get(key) ?? 0) + contrib);
                } else if (b.key.startsWith('defMult.')) {
                    const key = b.key.substring(8);
                    if (b.mode === 'max') defMult.set(key, Math.max(defMult.get(key) ?? 0, contrib));
                    else                  defMult.set(key, (defMult.get(key) ?? 0) + contrib);
                } else {
                    if (b.mode === 'max') stats.set(b.key, Math.max(stats.get(b.key) ?? 0, contrib));
                    else                  stats.set(b.key, (stats.get(b.key) ?? 0) + contrib);
                }
            }
            for (const p of entry.prop_bonuses) {
                prop_overrides.set(p.ref, (p.value_per_unit ?? 1) * effective_value);
            }
        }
    }
    return { stats, prop_overrides };
}

function apply_spell_prop_overrides(spell, prop_overrides, atree_merged) {
    if (!prop_overrides || prop_overrides.size === 0) return spell;
    if (!atree_merged) return spell;
    const orig_part_hits = new Map();
    for (const [, abil] of atree_merged) {
        for (const effect of abil.effects) {
            if (effect.type !== 'replace_spell' || effect.base_spell !== spell.base_spell) continue;
            for (const part of (effect.parts ?? [])) {
                if ('hits' in part) orig_part_hits.set(part.name, part.hits);
            }
        }
    }
    if (orig_part_hits.size === 0) return spell;
    let needs_clone = false;
    outer: for (const [, orig_hits] of orig_part_hits) {
        for (const orig_val of Object.values(orig_hits)) {
            if (typeof orig_val === 'string' && prop_overrides.has(orig_val)) {
                needs_clone = true;
                break outer;
            }
        }
    }
    if (!needs_clone) return spell;
    const clone = structuredClone(spell);
    for (const part of clone.parts) {
        if (!('hits' in part)) continue;
        const orig_hits = orig_part_hits.get(part.name);
        if (!orig_hits) continue;
        for (const sub_name of Object.keys(part.hits)) {
            const orig_val = orig_hits[sub_name];
            if (typeof orig_val === 'string' && prop_overrides.has(orig_val)) {
                part.hits[sub_name] = prop_overrides.get(orig_val);
            }
        }
    }
    return clone;
}

// ── From solver_search.js (reused in both main thread and worker) ───────────

function _deep_clone_statmap(sm) {
    const ret = new Map(sm);
    for (const k of ['damMult', 'defMult', 'healMult']) {
        const v = sm.get(k);
        if (v instanceof Map) ret.set(k, new Map(v));
    }
    return ret;
}

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

function _sp_prefilter(items_8_sms, wep_sm, sp_budget) {
    const all = [...items_8_sms, wep_sm];
    let total_net = 0;
    for (let i = 0; i < 5; i++) {
        let max_req = 0, sum_prov = 0;
        for (const sm of all) {
            const req = sm.get('reqs')?.[i] ?? 0;
            if (req > max_req) max_req = req;
            sum_prov += sm.get('skillpoints')?.[i] ?? 0;
        }
        const net = max_req > 0 ? Math.max(0, max_req - sum_prov) : 0;
        if (net > 100) return false;
        total_net += net;
    }
    return total_net <= sp_budget;
}

// ── Build stat assembly (replaces Build.initBuildStats without DOM) ─────────

/**
 * Worker-safe version of Build.initBuildStats().
 * Assembles a statMap from equipment, tomes, and weapon statMaps.
 *
 * @param {number} level
 * @param {Map[]} equip_8_sms   - 8 equipment statMaps (helm…neck)
 * @param {Map[]} tome_sms      - tome statMaps
 * @param {Map}   weapon_sm     - weapon statMap
 * @param {number[]} total_skillpoints - [5] from calculate_skillpoints
 * @param {Map} activeSetCounts - from calculate_skillpoints
 * @param {Map} sets_map        - global sets data
 * @returns {Map} statMap
 */
function worker_init_build_stats(level, equip_8_sms, tome_sms, weapon_sm, total_skillpoints, activeSetCounts, sets_map) {
    const staticIDs = ["hp", "eDef", "tDef", "wDef", "fDef", "aDef", "str", "dex", "int", "def", "agi", "damMobs", "defMobs"];
    const must_ids = [
        "eMdPct","eMdRaw","eSdPct","eSdRaw","eDamPct","eDamRaw","eDamAddMin","eDamAddMax",
        "tMdPct","tMdRaw","tSdPct","tSdRaw","tDamPct","tDamRaw","tDamAddMin","tDamAddMax",
        "wMdPct","wMdRaw","wSdPct","wSdRaw","wDamPct","wDamRaw","wDamAddMin","wDamAddMax",
        "fMdPct","fMdRaw","fSdPct","fSdRaw","fDamPct","fDamRaw","fDamAddMin","fDamAddMax",
        "aMdPct","aMdRaw","aSdPct","aSdRaw","aDamPct","aDamRaw","aDamAddMin","aDamAddMax",
        "nMdPct","nMdRaw","nSdPct","nSdRaw","nDamPct","nDamRaw","nDamAddMin","nDamAddMax",
        "mdPct","mdRaw","sdPct","sdRaw","damPct","damRaw","damAddMin","damAddMax",
        "rMdPct","rMdRaw","rSdPct","rSdRaw","rDamPct","rDamRaw","rDamAddMin","rDamAddMax",
        "healPct","critDamPct"
    ];

    const statMap = new Map();
    for (const id of staticIDs) statMap.set(id, 0);
    for (const id of must_ids) statMap.set(id, 0);
    statMap.set("hp", levelToHPBase(level));
    statMap.set("agiDef", 90);

    const all_item_sms = [...equip_8_sms, ...tome_sms, weapon_sm];
    const major_ids = new Set();

    for (const item_stats of all_item_sms) {
        const maxRolls = item_stats.get("maxRolls");
        if (maxRolls) {
            for (let [id, value] of maxRolls) {
                if (staticIDs.includes(id)) continue;
                statMap.set(id, (statMap.get(id) || 0) + value);
            }
        }
        for (const staticID of staticIDs) {
            if (item_stats.get(staticID)) {
                statMap.set(staticID, statMap.get(staticID) + item_stats.get(staticID));
            }
        }
        if (item_stats.get("majorIds")) {
            for (const major_id of item_stats.get("majorIds")) major_ids.add(major_id);
        }
    }

    statMap.set('damMult', new Map());
    statMap.set('defMult', new Map());
    statMap.get('damMult').set('tome', statMap.get('damMobs'));
    statMap.get('defMult').set('tome', statMap.get('defMobs'));
    statMap.set("activeMajorIDs", major_ids);

    for (const [setName, count] of activeSetCounts) {
        const setData = sets_map.get(setName);
        if (!setData) continue;
        const bonus = setData.bonuses[count - 1];
        if (!bonus) continue;
        for (const id in bonus) {
            if (skp_order.includes(id)) continue;
            statMap.set(id, (statMap.get(id) || 0) + bonus[id]);
        }
    }

    statMap.set("poisonPct", 0);
    statMap.set("healMult", new Map());
    statMap.get('healMult').set('item', statMap.get('healPct'));
    statMap.set("atkSpd", weapon_sm.get("atkSpd"));

    return statMap;
}

// ── Incremental stat accumulation helpers (Phase 7.5) ───────────────────────

const _INCR_STATIC_IDS = ["hp", "eDef", "tDef", "wDef", "fDef", "aDef", "str", "dex", "int", "def", "agi", "damMobs", "defMobs"];
const _INCR_STATIC_ID_SET = new Set(_INCR_STATIC_IDS);

/**
 * Add an item's stats to a running statMap (incremental accumulation).
 * Only handles additive stats (staticIDs + maxRolls). damMult/defMult/healMult
 * are set up at the leaf, not during DFS.
 */
function _incr_add_item(running_sm, item_sm) {
    const maxRolls = item_sm.get('maxRolls');
    if (maxRolls) {
        for (const [id, value] of maxRolls) {
            if (_INCR_STATIC_ID_SET.has(id)) continue;
            running_sm.set(id, (running_sm.get(id) || 0) + value);
        }
    }
    for (let i = 0; i < _INCR_STATIC_IDS.length; i++) {
        const id = _INCR_STATIC_IDS[i];
        const v = item_sm.get(id);
        if (v) running_sm.set(id, (running_sm.get(id) || 0) + v);
    }
}

/**
 * Remove an item's stats from a running statMap (backtrack).
 * Exact inverse of _incr_add_item.
 */
function _incr_remove_item(running_sm, item_sm) {
    const maxRolls = item_sm.get('maxRolls');
    if (maxRolls) {
        for (const [id, value] of maxRolls) {
            if (_INCR_STATIC_ID_SET.has(id)) continue;
            running_sm.set(id, (running_sm.get(id) || 0) - value);
        }
    }
    for (let i = 0; i < _INCR_STATIC_IDS.length; i++) {
        const id = _INCR_STATIC_IDS[i];
        const v = item_sm.get(id);
        if (v) running_sm.set(id, (running_sm.get(id) || 0) - v);
    }
}

/**
 * Initialize a running statMap from level + fixed items (locked equips, tomes, weapon).
 * This is the base that free items are incrementally added to/removed from during DFS.
 */
function _init_running_statmap(level, fixed_item_sms) {
    const must_ids = [
        "eMdPct","eMdRaw","eSdPct","eSdRaw","eDamPct","eDamRaw","eDamAddMin","eDamAddMax",
        "tMdPct","tMdRaw","tSdPct","tSdRaw","tDamPct","tDamRaw","tDamAddMin","tDamAddMax",
        "wMdPct","wMdRaw","wSdPct","wSdRaw","wDamPct","wDamRaw","wDamAddMin","wDamAddMax",
        "fMdPct","fMdRaw","fSdPct","fSdRaw","fDamPct","fDamRaw","fDamAddMin","fDamAddMax",
        "aMdPct","aMdRaw","aSdPct","aSdRaw","aDamPct","aDamRaw","aDamAddMin","aDamAddMax",
        "nMdPct","nMdRaw","nSdPct","nSdRaw","nDamPct","nDamRaw","nDamAddMin","nDamAddMax",
        "mdPct","mdRaw","sdPct","sdRaw","damPct","damRaw","damAddMin","damAddMax",
        "rMdPct","rMdRaw","rSdPct","rSdRaw","rDamPct","rDamRaw","rDamAddMin","rDamAddMax",
        "healPct","critDamPct"
    ];
    const sm = new Map();
    for (const id of _INCR_STATIC_IDS) sm.set(id, 0);
    for (const id of must_ids) sm.set(id, 0);
    sm.set("hp", levelToHPBase(level));
    sm.set("agiDef", 90);
    for (const item_sm of fixed_item_sms) {
        _incr_add_item(sm, item_sm);
    }
    return sm;
}

/**
 * Finalize a leaf statMap from the running accumulated stats.
 * Applies set bonuses, sets up damMult/defMult/healMult/majorIDs.
 * Replaces worker_init_build_stats at the leaf.
 */
function _finalize_leaf_statmap(running_sm, weapon_sm, activeSetCounts, sets_map, all_equip_sms) {
    const sm = new Map(running_sm);

    // Apply set bonuses (non-SP bonuses only; SP bonuses are in total_sp)
    for (const [setName, count] of activeSetCounts) {
        const setData = sets_map.get(setName);
        if (!setData) continue;
        const bonus = setData.bonuses[count - 1];
        if (!bonus) continue;
        for (const id in bonus) {
            if (skp_order.includes(id)) continue;
            sm.set(id, (sm.get(id) || 0) + bonus[id]);
        }
    }

    // Multiplier maps
    sm.set('damMult', new Map());
    sm.set('defMult', new Map());
    sm.get('damMult').set('tome', sm.get('damMobs') || 0);
    sm.get('defMult').set('tome', sm.get('defMobs') || 0);

    // Major IDs (rebuilt at leaf — rare, so not tracked incrementally)
    const major_ids = new Set();
    for (const item_sm of all_equip_sms) {
        const mids = item_sm.get("majorIds");
        if (mids) for (const mid of mids) major_ids.add(mid);
    }
    sm.set("activeMajorIDs", major_ids);

    sm.set("poisonPct", 0);
    sm.set("healMult", new Map());
    sm.get('healMult').set('item', sm.get('healPct') || 0);
    sm.set("atkSpd", weapon_sm.get("atkSpd"));

    return sm;
}

