
// ── Phase 4: Spell damage nodes ───────────────────────────────────────────────
// builder_graph.js is not loaded on the solver page, so these node classes must
// be defined here. AbilityTreeEnsureNodesNode (in atree.js) creates instances of
// SpellDamageCalcNode and SpellDisplayNode by name at runtime, so the names must
// match exactly.

/**
 * Compute spell damage of spell parts.
 * Mirrors SpellDamageCalcNode in builder_graph.js.
 *
 * Signature: SpellDamageCalcNode(build: Build, stats: StatMap) => List[SpellDamage]
 */
class SpellDamageCalcNode extends ComputeNode {
    constructor(spell) {
        super('solver-spell' + spell.base_spell + '-calc');
        this.spell = spell;
    }

    compute_func(input_map) {
        const weapon = input_map.get('build').weapon.statMap;
        const spell  = this.spell;
        const stats  = input_map.get('stats');
        const use_speed = ('use_atkspd' in spell) ? spell.use_atkspd : true;
        const use_spell = ('scaling'   in spell) ? spell.scaling === 'spell' : true;

        let display_spell_results = [];
        let spell_result_map = new Map();
        for (const part of spell.parts) {
            spell_result_map.set(part.name, { type: 'need_eval', store_part: part });
        }

        function eval_part(part_name) {
            let dat = spell_result_map.get(part_name);
            if (!dat) return dat;
            if (dat.type !== 'need_eval') return dat;

            const part = dat.store_part;
            const part_id = spell.base_spell + '.' + part.name;
            let spell_result;

            if ('multipliers' in part) {
                const use_str      = ('use_str'      in part) ? part.use_str      : true;
                const ignored_mults = ('ignored_mults' in part) ? part.ignored_mults : [];
                const results = calculateSpellDamage(
                    stats, weapon, part.multipliers, use_spell, !use_speed,
                    part_id, !use_str, ignored_mults);
                spell_result = {
                    type: 'damage',
                    normal_min:   results[2].map(x => x[0]),
                    normal_max:   results[2].map(x => x[1]),
                    normal_total: results[0],
                    crit_min:     results[2].map(x => x[2]),
                    crit_max:     results[2].map(x => x[3]),
                    crit_total:   results[1],
                    is_spell:     use_spell,
                    multipliers:  results[3],
                };
            } else if ('power' in part) {
                const mult_map = stats.get('healMult');
                let heal_mult = 1;
                for (const [k, v] of mult_map.entries()) {
                    if (k.includes(':') && k.split(':')[1] !== part_id) continue;
                    heal_mult *= (1 + v / 100);
                }
                spell_result = {
                    type: 'heal',
                    heal_amount: part.power * getDefenseStats(stats)[0] * heal_mult,
                };
            } else {
                spell_result = {
                    normal_min:   [0, 0, 0, 0, 0, 0],
                    normal_max:   [0, 0, 0, 0, 0, 0],
                    normal_total: [0, 0],
                    crit_min:     [0, 0, 0, 0, 0, 0],
                    crit_max:     [0, 0, 0, 0, 0, 0],
                    crit_total:   [0, 0],
                    heal_amount:  0,
                    multipliers:  [0, 0, 0, 0, 0, 0],
                };
                const dam_keys = ['normal_min', 'normal_max', 'normal_total',
                                  'crit_min', 'crit_max', 'crit_total', 'multipliers'];
                for (const [sub_name, hits] of Object.entries(part.hits)) {
                    const sub = eval_part(sub_name);
                    if (!sub) continue;
                    if (spell_result.type) {
                        if (sub.type !== spell_result.type) throw 'SpellCalc total subpart type mismatch';
                    } else {
                        spell_result.type = sub.type;
                    }
                    if (spell_result.type === 'damage') {
                        for (const key of dam_keys) {
                            for (let i in spell_result.normal_min) {
                                spell_result[key][i] += sub[key][i] * hits;
                            }
                        }
                    } else {
                        spell_result.heal_amount += sub.heal_amount * hits;
                    }
                }
            }
            const { name, display = true } = part;
            spell_result.name    = name;
            spell_result.display = display;
            spell_result_map.set(part_name, spell_result);
            return spell_result;
        }

        for (const part of spell.parts) {
            display_spell_results.push(eval_part(part.name));
        }
        return display_spell_results;
    }
}

/**
 * Display spell damage from spell parts.
 * Mirrors SpellDisplayNode in builder_graph.js.
 *
 * Signature: SpellDisplayNode(stats: StatMap, spell-damage: List[SpellDamage]) => null
 */
class SpellDisplayNode extends ComputeNode {
    constructor(spell) {
        super('solver-spell' + spell.base_spell + '-display');
        this.spell = spell;
    }

    compute_func(input_map) {
        const stats   = input_map.get('stats');
        const damages = input_map.get('spell-damage');
        const spell   = this.spell;
        const i = spell.base_spell;
        const parent_elem        = document.getElementById('spell' + i + '-info');
        const overallparent_elem = document.getElementById('spell' + i + '-infoAvg');
        displaySpellDamage(parent_elem, overallparent_elem, stats, spell, i, damages);
    }
}

/**
 * Computes the average damage per cast of a spell's primary display part,
 * weighted by crit chance. Returns 0 for non-damage spells.
 */
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
    // Find the display part: the one matching spell.display, or the last displayed damage part.
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

/**
 * Like computeSpellDisplayAvg but returns {avg, non_crit_avg, crit_avg} for
 * use in the per-spell damage breakdown popup.
 * Returns null when the spell has no damage parts.
 */
function computeSpellDisplayFull(stats, weapon, spell, crit_chance) {
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
            result = {
                type: 'damage',
                normal_total: raw[0],
                crit_total:   raw[1],
                damages_results:        raw[2], // per-element [norm_min, norm_max, crit_min, crit_max]
                multiplied_conversions: raw[3], // effective % per element after mults
            };
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
    if (!display_result || display_result.type !== 'damage') return null;

    const non_crit_avg = (display_result.normal_total[0] + display_result.normal_total[1]) / 2;
    const crit_avg     = (display_result.crit_total[0]   + display_result.crit_total[1])   / 2;
    const avg          = (1 - crit_chance) * non_crit_avg + crit_chance * crit_avg;

    // Collect all display parts for the detailed breakdown popup.
    const parts_data = all_results
        .filter(r => r?.display && r?.type === 'damage')
        .map(r => ({
            name:         r.name,
            multipliers:  r.multiplied_conversions ?? null, // [n,e,t,w,f,a] effective %
            normal_min:   r.damages_results ? r.damages_results.map(d => d[0]) : null,
            normal_max:   r.damages_results ? r.damages_results.map(d => d[1]) : null,
            crit_min:     r.damages_results ? r.damages_results.map(d => d[2]) : null,
            crit_max:     r.damages_results ? r.damages_results.map(d => d[3]) : null,
            normal_total: r.normal_total,
            crit_total:   r.crit_total,
            is_spell:     use_spell,
        }));

    return {
        avg, non_crit_avg, crit_avg,
        spell_name: spell.name,
        has_cost:   'cost' in spell,
        parts:      parts_data,
    };
}

/**
 * Builds the inner HTML for the per-spell damage breakdown popup.
 * Mirrors WynnBuilder's displaySpellDamage() output format:
 *   Spell name (mana cost)
 *   Per part: element-coloured multiplier %s, Average, Non-Crit ranges, Crit ranges
 *   Crit chance footer.
 *
 * @param {object} full   Return value of computeSpellDisplayFull (non-null)
 * @param {number} crit_chance  0–1
 * @param {number|null} spell_cost  Pre-computed mana cost (null = no cost to show)
 */
function renderSpellPopupHTML(full, crit_chance, spell_cost) {
    const fmtN = n => Math.round(n).toLocaleString();

    let html = '';

    // ── Header: spell name + optional mana cost ──────────────────────────────
    if (full.has_cost && spell_cost != null) {
        html += `<div class="fw-bold">${full.spell_name} <span class="Mana">(${spell_cost.toFixed(1)})</span></div>`;
    } else {
        html += `<div class="fw-bold">${full.spell_name}</div>`;
    }

    // ── Per-part breakdown ────────────────────────────────────────────────────
    for (const part of full.parts) {
        html += '<hr class="my-1">';
        html += `<div class="text-secondary" style="font-size:0.9em">${part.name}</div>`;

        // Multiplier percentages (element-coloured)
        if (part.multipliers) {
            let mult_bits = [];
            let total_mult = 0;
            for (let i = 0; i < 6; i++) {
                const m = part.multipliers[i];
                if (m > 0.01) {
                    mult_bits.push(`<span class="${damageClasses[i]}">${Math.round(m * 10) / 10}%</span>`);
                    total_mult += m;
                }
            }
            if (mult_bits.length > 0) {
                const type_label = part.is_spell ? 'Spell' : 'Melee';
                html += `<div>${mult_bits.join(' ')} <span class="text-secondary">(${Math.round(total_mult * 10) / 10}%) ${type_label}</span></div>`;
            }
        }

        const nc_avg = (part.normal_total[0] + part.normal_total[1]) / 2;
        const c_avg  = (part.crit_total[0]   + part.crit_total[1])   / 2;
        const p_avg  = (1 - crit_chance) * nc_avg + crit_chance * c_avg;
        html += `<div>Average: ${fmtN(p_avg)}</div>`;

        // Non-crit
        html += `<div>Non-Crit: ${fmtN(nc_avg)}</div>`;
        if (part.normal_min) {
            for (let i = 0; i < 6; i++) {
                if (part.normal_max[i] > 0.5) {
                    html += `<div class="${damageClasses[i]}">&nbsp;&nbsp;${fmtN(part.normal_min[i])} \u2013 ${fmtN(part.normal_max[i])}</div>`;
                }
            }
        }

        // Crit
        html += `<div>Crit: ${fmtN(c_avg)}</div>`;
        if (part.crit_min) {
            for (let i = 0; i < 6; i++) {
                if (part.crit_max[i] > 0.5) {
                    html += `<div class="${damageClasses[i]}">&nbsp;&nbsp;${fmtN(part.crit_min[i])} \u2013 ${fmtN(part.crit_max[i])}</div>`;
                }
            }
        }
    }

    // ── Footer: crit chance ───────────────────────────────────────────────────
    html += '<hr class="my-1">';
    html += `<div class="text-secondary">Crit chance: ${Math.round(crit_chance * 100)}%</div>`;

    return html;
}

// ── Powder special helpers ────────────────────────────────────────────────────

/**
 * Returns the powder special tier (1-5) for a given element on a set of powders,
 * or 0 if no powders of that element are present.
 * element_idx: 0=earth, 1=thunder, 2=water, 3=fire, 4=air  (same as powderSpecialStats order).
 */
function get_element_powder_tier(powders, element_idx) {
    const count = powders.filter(pid => ((pid / 6) | 0) === element_idx).length;
    return count > 0 ? Math.min(count, 5) : 0;
}

/**
 * Build a synthetic spell object for a damaging powder special.
 * ps_idx: 0=Quake(earth), 1=Chain Lightning(thunder), 3=Courage(fire)
 * Tier: 1-5.  The returned object is compatible with computeSpellDisplayAvg().
 */
function make_powder_special_spell(ps_idx, tier) {
    const ps          = powderSpecialStats[ps_idx];
    const element_num = ps_idx + 1;   // damage_keys index: 1=earth, 2=thunder, 4=fire
    const damage_pct  = ps.weaponSpecialEffects.get('Damage')[tier - 1];
    const conversions = [0, 0, 0, 0, 0, 0];
    conversions[element_num] = damage_pct;
    return {
        name:        ps.weaponSpecialName,
        base_spell:  0,
        cost:        undefined,   // powder specials don't have a regular mana cost
        scaling:     'melee',     // use_spell_damage = false (matches display.js call)
        use_atkspd:  false,       // ignore_speed = true
        parts: [{ name: 'hit', display: true, multipliers: conversions }],
        _is_powder_special: true,
    };
}

// ── Combo boost registry ──────────────────────────────────────────────────────

/**
 * Build a boost registry from the current ability tree (raw_stat toggles + stat_scaling sliders)
 * plus powder special buffs derived from the current build's weapon and armor powders.
 *
 * Each entry: { name, aliases[], type:'toggle'|'slider',
 *               max?, step?,
 *               stat_bonuses: [{key, value, mode}],
 *               prop_bonuses: [{ref:'abilId.propName', value_per_unit}] }
 *
 * Deduplication: toggles with the same name are skipped after the first.
 * Sliders with the same slider_name are merged: slider_max values are summed.
 */
function build_combo_boost_registry(atree_merged, build = null) {
    const registry    = [];
    const toggle_seen = new Set();   // toggle name → already added
    const slider_idx  = new Map();   // slider_name → index in registry

    if (!atree_merged) return registry;

    // Pass 1: accumulate total slider_max per slider_name.
    // Only explicitly-set slider_max values are summed (undefined means "doesn't add to max").
    // behavior:'overwrite' effects replace the total rather than adding to it.
    const slider_total_max = new Map();
    const slider_overwrite_max = new Map();
    for (const [, abil] of atree_merged) {
        for (const effect of abil.effects) {
            if (effect.type === 'stat_scaling' && effect.slider === true && effect.slider_name) {
                const name = effect.slider_name;
                if (effect.behavior === 'overwrite') {
                    if (effect.slider_max != null) {
                        slider_overwrite_max.set(name, Math.max(slider_overwrite_max.get(name) ?? 0, effect.slider_max));
                    }
                } else if (effect.slider_max != null) {
                    // Only sum explicitly-set values; omitting slider_max means this effect
                    // does not extend the range (e.g. Breathless, Transonic Warp).
                    slider_total_max.set(name, (slider_total_max.get(name) ?? 0) + effect.slider_max);
                }
            }
        }
    }
    // Overwrite takes precedence over the accumulated sum.
    for (const [name, max] of slider_overwrite_max) {
        slider_total_max.set(name, max);
    }

    // Pass 2: build registry entries.
    // For toggles: first unique name wins.
    // For sliders: ALL effects with the same slider_name are merged into one entry so
    //              that moving the slider applies every ability's per-stack contribution
    //              (e.g. Windsweeper + Breathless + Thunderstorm all affect Winded at once).
    for (const [, abil] of atree_merged) {
        for (const effect of abil.effects) {
            if (effect.type === 'raw_stat' && effect.toggle) {
                const toggle_name = effect.toggle;
                if (toggle_seen.has(toggle_name)) continue;

                const stat_bonuses = [];
                for (const bonus of (effect.bonuses ?? [])) {
                    if (bonus.type !== 'stat') continue;
                    let val = bonus.value;
                    // Resolve "abilId.propName" string references.
                    if (typeof val === 'string') {
                        const [id_str, prop] = val.split('.');
                        val = atree_merged.get(parseInt(id_str))?.properties?.[prop] ?? 0;
                    }
                    if (typeof val === 'number') {
                        stat_bonuses.push({ key: bonus.name, value: val, mode: 'add' });
                    }
                }
                if (stat_bonuses.length > 0) {
                    toggle_seen.add(toggle_name);
                    registry.push({ name: toggle_name, aliases: [], type: 'toggle', stat_bonuses, prop_bonuses: [] });
                }
            } else if (effect.type === 'stat_scaling' && effect.slider === true) {
                const slider_name = effect.slider_name;

                const stat_bonuses = [];
                const prop_bonuses = [];
                const outputs = Array.isArray(effect.output) ? effect.output : (effect.output ? [effect.output] : []);
                const scaling = Array.isArray(effect.scaling) ? effect.scaling : [effect.scaling ?? 1];
                for (let i = 0; i < outputs.length; i++) {
                    const out   = outputs[i];
                    const scale = scaling[i] ?? scaling[0] ?? 1;
                    if (out.type === 'stat') {
                        stat_bonuses.push({ key: out.name, value: scale, mode: 'add' });
                    } else if (out.type === 'prop') {
                        prop_bonuses.push({ ref: String(out.abil) + '.' + out.name, value_per_unit: scale });
                    }
                }

                if (stat_bonuses.length === 0 && prop_bonuses.length === 0) continue;

                if (slider_idx.has(slider_name)) {
                    // Merge into the existing entry so all per-stack contributions are combined.
                    const existing = registry[slider_idx.get(slider_name)];
                    existing.stat_bonuses.push(...stat_bonuses);
                    existing.prop_bonuses.push(...prop_bonuses);
                } else {
                    slider_idx.set(slider_name, registry.length);
                    registry.push({
                        name: slider_name,
                        aliases: [],
                        type: 'slider',
                        max:  slider_total_max.get(slider_name) ?? (effect.slider_max ?? 10),
                        step: effect.slider_step ?? 1,
                        stat_bonuses,
                        prop_bonuses,
                    });
                }
            }
        }
    }

    // ── Powder buff entries (weapon + armor specials) ─────────────────────────
    if (build) {
        const weapon_powders = build.weapon.statMap.get('powders') ?? [];

        // Weapon specials that add a damage multiplier (Curse=water, Courage=fire, Wind Prison=air).
        // ps_idx 2=Curse, 3=Courage, 4=Wind Prison; their element_idx matches ps_idx.
        const weapon_buff_ps = [
            { ps_idx: 2, elem: 2 },   // Curse (water)
            { ps_idx: 3, elem: 3 },   // Courage (fire) — damage-boost part
            { ps_idx: 4, elem: 4 },   // Wind Prison (air)
        ];
        for (const { ps_idx, elem } of weapon_buff_ps) {
            const tier = get_element_powder_tier(weapon_powders, elem);
            if (tier === 0) continue;
            const ps    = powderSpecialStats[ps_idx];
            const boost = ps.weaponSpecialEffects.get('Damage Boost')[tier - 1];
            registry.push({
                name: ps.weaponSpecialName,
                aliases: [],
                type: 'toggle',
                stat_bonuses: [{ key: 'damMult.' + ps.weaponSpecialName, value: boost, mode: 'add' }],
                prop_bonuses: [],
            });
        }

        // Armor specials: collect element powder counts across all armor pieces (helm, chest, legs, boots).
        // ps_idx: 0=Rage(earth), 1=Kill Streak(thunder), 2=Concentration(water), 3=Endurance(fire), 4=Dodge(air)
        const armor_elem_counts = new Array(5).fill(0);
        for (let i = 0; i < 4; i++) {
            const armor_powders = build.equipment[i]?.statMap?.get('powders') ?? [];
            for (const pid of armor_powders) {
                const elem = (pid / 6) | 0;
                if (elem < 5) armor_elem_counts[elem]++;
            }
        }
        const armor_ps_defs = [
            { elem: 0, max: 75,  step: 1,  label: 'Rage (%HP missing)'        },   // Rage
            { elem: 1, max: 15,  step: 1,  label: 'Kill Streak (mobs killed)'  },   // Kill Streak
            { elem: 2, max: 100, step: 1,  label: 'Concentration (mana spent)' },   // Concentration
            { elem: 3, max: 30,  step: 1,  label: 'Endurance (hits taken)'     },   // Endurance
            { elem: 4, max: 10,  step: 1,  label: 'Dodge (near mobs)'          },   // Dodge
        ];
        for (const { elem, max, step, label } of armor_ps_defs) {
            const count = armor_elem_counts[elem];
            if (count === 0) continue;
            const tier      = Math.min(count, 5);
            const ps        = powderSpecialStats[elem];
            const per_unit  = ps.armorSpecialEffects.get('Damage')[tier - 1];
            registry.push({
                name: label,
                aliases: [ps.armorSpecialName],
                type: 'slider',
                max, step,
                stat_bonuses: [{ key: 'damMult.' + ps.armorSpecialName, value: per_unit, mode: 'add' }],
                prop_bonuses: [],
            });
        }
    }

    return registry;
}

/**
 * Find all registry entries that apply for a given boost token name.
 * Rules:
 *  - Exact name match (case-insensitive, stripping leading "Activate ").
 *  - Alias match.
 *  - If is_pct=true, ALSO find sliders that CONTAIN the name (for "Enkindled 100%" → "Enkindled Percent").
 *
 * Returns [{entry, effective_value}] where effective_value is 1 for toggles
 * and token.value for sliders.
 */
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
            // slider
            if (exact_match) {
                results.push({ entry, effective_value: token_value });
            } else if (is_pct && (ename.includes(name_lower) || ename.startsWith(name_lower))) {
                // "Enkindled 100%" also activates "Enkindled Percent" slider.
                results.push({ entry, effective_value: token_value });
            }
        }
    }
    return results;
}

/**
 * Apply per-row boost tokens to a clone of base_stats.
 * Returns { stats: modified_stats, prop_overrides: Map<'abilId.prop', value> }.
 */
function apply_combo_row_boosts(base_stats, boost_tokens, registry) {
    // Shallow-clone outer map; deep-clone the nested damMult / defMult Maps.
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
                    if (b.mode === 'max') {
                        damMult.set(key, Math.max(damMult.get(key) ?? 0, contrib));
                    } else {
                        damMult.set(key, (damMult.get(key) ?? 0) + contrib);
                    }
                } else if (b.key.startsWith('defMult.')) {
                    const key = b.key.substring(8);
                    if (b.mode === 'max') {
                        defMult.set(key, Math.max(defMult.get(key) ?? 0, contrib));
                    } else {
                        defMult.set(key, (defMult.get(key) ?? 0) + contrib);
                    }
                } else {
                    // Direct stats Map entry (e.g. "nConvBase:4.Winded Damage", "sdPct", …)
                    if (b.mode === 'max') {
                        stats.set(b.key, Math.max(stats.get(b.key) ?? 0, contrib));
                    } else {
                        stats.set(b.key, (stats.get(b.key) ?? 0) + contrib);
                    }
                }
            }
            for (const p of entry.prop_bonuses) {
                prop_overrides.set(p.ref, (p.value_per_unit ?? 1) * effective_value);
            }
        }
    }
    return { stats, prop_overrides };
}

/**
 * Clone a spell and override already-resolved hit-count values using prop_overrides.
 * Looks up the original (unresolved) string references inside atree_merged's
 * replace_spell effects to know WHICH hits to patch.
 */
function apply_spell_prop_overrides(spell, prop_overrides, atree_merged) {
    if (!prop_overrides || prop_overrides.size === 0) return spell;
    if (!atree_merged) return spell;

    // Build map of original (unresolved) hit string refs from the atree.
    const orig_part_hits = new Map();  // partName → {subName → original_string_or_num}
    for (const [, abil] of atree_merged) {
        for (const effect of abil.effects) {
            if (effect.type !== 'replace_spell' || effect.base_spell !== spell.base_spell) continue;
            for (const part of (effect.parts ?? [])) {
                if ('hits' in part) orig_part_hits.set(part.name, part.hits);
            }
        }
    }
    if (orig_part_hits.size === 0) return spell;

    // Check if any string reference is in our overrides.
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

/**
 * Return true if a spell has at least one damage-type part (directly or via hits).
 */
function spell_has_damage(spell) {
    const by_name = new Map((spell.parts ?? []).map(p => [p.name, p]));
    function part_dmg(p) {
        if ('multipliers' in p) return true;
        if ('hits' in p) return Object.keys(p.hits).some(n => { const s = by_name.get(n); return s && part_dmg(s); });
        return false;
    }
    return (spell.parts ?? []).some(part_dmg);
}

/**
 * Parse the boost column of a combo row (comma-separated boost tokens).
 * Returns [{name, value, is_pct}].
 *   - "Boost N%"  → {name:'Boost', value:N, is_pct:true}
 *   - "Boost N"   → {name:'Boost', value:N, is_pct:false}
 *   - "Boost"     → {name:'Boost', value:1, is_pct:false}
 */
function parse_combo_boost_tokens(boost_str) {
    const boost_tokens = [];
    for (const raw_tok of boost_str.split(',')) {
        const tok = raw_tok.trim();
        if (!tok) continue;
        const m = tok.match(/^(.*?)\s+(\d+(?:\.\d+)?)(%?)$/);
        if (m) {
            boost_tokens.push({ name: m[1].trim(), value: parseFloat(m[2]), is_pct: m[3] === '%' });
        } else {
            boost_tokens.push({ name: tok, value: 1, is_pct: false });
        }
    }
    return boost_tokens;
}

// ── SolverComboTotalNode ──────────────────────────────────────────────────────

/**
 * Computes per-row combo damage total using per-row boost specifications.
 *
 * Inputs: build, base-stats (StatMap without potion boosts),
 *         spells (Map[id,Spell]), atree-merged (Map[id,Ability]).
 * Output: null (always). URL is updated asynchronously via _schedule_combo_url_update.
 * Also updates #combo-total-avg DOM element directly.
 *
 * Also manages selection-mode row UI (spell dropdowns + boost controls).
 */
