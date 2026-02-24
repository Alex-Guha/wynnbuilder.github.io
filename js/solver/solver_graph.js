/**
 * Solver computation graph: node definitions and graph initialization.
 *
 * Phase 2: Item input, display, powder, tooltip, build assembly, SP display.
 * Phase 3: Active boosts, atree, aspects, stat aggregation pipeline.
 */

// ── Boost button data (mirrors builder_graph.js) ─────────────────────────────

const damageMultipliers = new Map([
    ["totem",          0.20],
    ["warscream",      0.00],
    ["emboldeningcry", 0.00],
    ["fortitude",      0.40],
    ["radiance",       0.00],
    ["eldritchcall",   0.00],
    ["divinehonor",    0.00],
]);

const specialNames = ["Quake", "Chain Lightning", "Curse", "Courage", "Wind Prison"];

// Stats scaled by Radiance / Divine Honor (mirrors builder_graph.js radiance_affected list).
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

// ── Defense stat utility (mirrors builder_graph.js; needed by display.js) ────
// display.js calls getDefenseStats() as a global but it is defined only in
// builder_graph.js, which the solver page does not import.

function getDefenseStats(stats) {
    let defenseStats = [];
    let def_pct = skillPointsToPercentage(stats.get('def')) * skillpoint_final_mult[3];
    let agi_pct = skillPointsToPercentage(stats.get('agi')) * skillpoint_final_mult[4];
    // total hp
    let totalHp = stats.get("hp") + stats.get("hpBonus");
    if (totalHp < 5) totalHp = 5;
    defenseStats.push(totalHp);
    // EHP
    let ehp = [totalHp, totalHp];
    let defMult = (2 - stats.get("classDef"));
    for (const [, v] of stats.get("defMult").entries()) {
        defMult *= (1 - v/100);
    }
    let agi_reduction = (100 - stats.get("agiDef")) / 100;
    ehp[0] = ehp[0] / (agi_reduction*agi_pct + (1-agi_pct) * (1-def_pct));
    ehp[0] /= defMult;
    ehp[1] /= (1-def_pct) * defMult;
    defenseStats.push(ehp);
    // HPR
    let totalHpr = rawToPct(stats.get("hprRaw"), stats.get("hprPct")/100.);
    defenseStats.push(totalHpr);
    // EHPR
    let ehpr = [totalHpr, totalHpr];
    ehpr[0] = ehpr[0] / (agi_reduction*agi_pct + (1-agi_pct) * (1-def_pct));
    ehpr[0] /= defMult;
    ehpr[1] /= (1-def_pct) * defMult;
    defenseStats.push(ehpr);
    // skp stats
    defenseStats.push([def_pct*100, agi_pct*100]);
    // elemental defenses
    let eledefs = [0, 0, 0, 0, 0];
    for (const i in skp_elements) {
        eledefs[i] = rawToPctUncapped(stats.get(skp_elements[i] + "Def"), (stats.get(skp_elements[i] + "DefPct") + stats.get("rDefPct"))/100.);
    }
    defenseStats.push(eledefs);
    // [totalHp, [ehp w/agi, ehp w/o agi], totalHpr, [ehpr w/agi, ehpr w/o agi], [def%, agi%], [edef, tdef, wdef, fdef, adef]]
    return defenseStats;
}

// ── Stat aggregation utility classes ─────────────────────────────────────────

/**
 * Merges multiple StatMap inputs into one StatMap.
 * Skips null inputs (fail_cb = true allows partial computation).
 *
 * Signature: AggregateStatsNode(...maps) => StatMap
 */
class AggregateStatsNode extends ComputeNode {
    constructor(name) { super(name); this.fail_cb = true; }

    compute_func(input_map) {
        const out = new Map();
        for (const v of input_map.values()) {
            if (!v) continue;
            for (const [k, v2] of v.entries()) {
                merge_stat(out, k, v2);
            }
        }
        return out;
    }
}

/**
 * Detects player class from weapon type.
 * Returns null when no weapon is selected.
 *
 * Signature: PlayerClassNode(build: Build) => string | null
 */
class PlayerClassNode extends ValueCheckComputeNode {
    constructor(name) { super(name); }

    compute_func(input_map) {
        const build = input_map.get('build');
        if (!build || build.weapon.statMap.has('NONE')) return null;
        return wep_to_class.get(build.weapon.statMap.get('type'));
    }
}

/**
 * Extracts build.statMap into a plain Map for the stat aggregation pipeline.
 * Returns an empty Map when no build exists.
 *
 * Signature: SolverBuildStatExtractNode(build: Build) => StatMap
 */
class SolverBuildStatExtractNode extends ComputeNode {
    constructor() { super('solver-build-stat-extract'); this.fail_cb = true; }

    compute_func(input_map) {
        const build = input_map.get('build');
        if (!build) return new Map();
        const stats = new Map(build.statMap);
        // Overwrite item-only skill-point values with the final totals
        // (items + assigned), mirroring AggregateEditableIDNode in builder_graph.js.
        // Without this, getSpellCost and skillPointsToPercentage use only item-
        // contributed int/str/dex/def/agi, producing incorrect damage and costs.
        for (const [idx, name] of skp_order.entries()) {
            stats.set(name, build.total_skillpoints[idx]);
        }
        const weaponType = build.weapon.statMap.get('type');
        if (weaponType) {
            stats.set('classDef', classDefenseMultipliers.get(weaponType) || 1.0);
        }
        return stats;
    }
}

/**
 * Renders a concise stat summary into a parent element: Total HP, Effective HP,
 * HP Regen, Mana Regen, Mana Steal / per hit, and Life Steal / per hit.
 * Elemental defenses and defense% are intentionally excluded.
 */
function displaySolverSummary(parent_id, stats) {
    const parent = document.getElementById(parent_id);
    if (!parent) return;
    parent.innerHTML = '';
    if (!stats || stats.size === 0) return;

    function row(label, value, labelCls) {
        const div = document.createElement('div');
        div.className = 'row';
        const l = document.createElement('div');
        l.className = 'col text-start' + (labelCls ? ' ' + labelCls : '');
        l.textContent = label;
        const v = document.createElement('div');
        v.className = 'col text-end';
        v.textContent = String(value);
        div.append(l, v);
        return div;
    }

    const defStats = getDefenseStats(stats);
    // defStats: [totalHp, [ehp_agi, ehp_noagi], totalHpr, [ehpr…], [def%, agi%], [eledefs…]]
    parent.append(
        row('Total HP:',         Math.round(parseFloat(defStats[0])), 'Health'),
        row('Effective HP:',     Math.round(parseFloat(defStats[1][0]))),
        row('HP Regen (Total):', Math.round(parseFloat(defStats[2])), 'Health'),
        Object.assign(document.createElement('hr'), { className: 'row my-2' }),
    );

    const mr = stats.get('mr') ?? 0;
    if (mr) parent.append(row('Mana Regen:', mr + '/5s', 'wDam'));

    const ms = stats.get('ms') ?? 0;
    if (ms) {
        parent.append(row('Mana Steal:', ms + '/3s', 'wDam'));
        const adjAtkSpd = Math.min(6, Math.max(0,
            attackSpeeds.indexOf(stats.get('atkSpd')) + (stats.get('atkTier') ?? 0)));
        const mph = Math.round(ms / 3.0 / baseDamageMultiplier[adjAtkSpd] * 10) / 10;
        parent.append(row('\u279C Mana per hit:', mph, 'wDam'));
    }

    const ls = stats.get('ls') ?? 0;
    if (ls) {
        parent.append(row('Life Steal:', ls + '/3s', 'Health'));
        const adjAtkSpd = Math.min(6, Math.max(0,
            attackSpeeds.indexOf(stats.get('atkSpd')) + (stats.get('atkTier') ?? 0)));
        const lph = Math.round(ls / 3.0 / baseDamageMultiplier[adjAtkSpd]);
        parent.append(row('\u279C Life per hit:', lph, 'Health'));
    }
}

/**
 * Calls displayBuildStats to populate the Summary and Detailed stat columns.
 * Clears the display when no build is present.
 *
 * Signature: SolverBuildDisplayNode(build: Build, stats: StatMap) => null
 */
class SolverBuildDisplayNode extends ComputeNode {
    constructor() { super('solver-build-display'); this.fail_cb = true; }

    compute_func(input_map) {
        const build = input_map.get('build');
        const stats = input_map.get('stats');
        if (!build) {
            setHTML('summary-stats', '');
            setHTML('detailed-stats', '');
            return null;
        }
        displaySolverSummary('summary-stats', stats || new Map());
        displayBuildStats('detailed-stats', build, build_detailed_display_commands, stats || new Map());
        return null;
    }
}

// ── Module-level boost / radiance / armor-powder nodes ────────────────────────
// These read DOM state directly; created here so the update_* handlers can
// reference them before solver_graph_init() runs.

/**
 * Reads the active boost buttons and produces a damMult / defMult StatMap.
 * Mirrors builder_graph.js boosts_node.
 */
let solver_boosts_node = new (class extends ComputeNode {
    constructor() { super('solver-boost-input'); }

    compute_func(_input_map) {
        let damage_boost = 0;
        let str_boost    = 0;
        let vuln_boost   = 0;
        let def_boost    = 0;
        for (const [key, value] of damageMultipliers) {
            const elem = document.getElementById(key + '-boost');
            if (elem && elem.classList.contains('toggleOn')) {
                if (value > damage_boost) { damage_boost = value; }
                if (key === 'warscream')       { def_boost  += 0.20; }
                else if (key === 'emboldeningcry') { def_boost += 0.05; str_boost += 0.08; }
                else if (key === 'eldritchcall')   { vuln_boost += 0.15; }
            }
        }
        const res = new Map();
        res.set('damMult.Potion',        100 * damage_boost);
        res.set('damMult.Strength',      100 * str_boost);
        res.set('damMult.Vulnerability', 100 * vuln_boost);
        res.set('defMult.Potion',        100 * def_boost);
        return res;
    }
})().update();

/**
 * Scales the pre-scale StatMap by Radiance (+20%) and/or Divine Honor (+10%).
 * When neither is active, passes the input through unchanged.
 * fail_cb = true so it still runs when pre_scale_agg has null inputs.
 */
let solver_radiance_node = new (class extends ComputeNode {
    constructor() { super('solver-radiance-node'); this.fail_cb = true; }

    compute_func(input_map) {
        const statmap = input_map.get('stats');
        if (!statmap) return new Map();

        let boost = 1;
        if (document.getElementById('radiance-boost')?.classList.contains('toggleOn'))    { boost += 0.2; }
        if (document.getElementById('divinehonor-boost')?.classList.contains('toggleOn')) { boost += 0.1; }

        if (boost === 1) return statmap;

        const ret = new Map(statmap);
        for (const id of radiance_affected) {
            const val = ret.get(id) || 0;
            if (reversedIDs.includes(id)) {
                if (val < 0) { ret.set(id, Math.floor(val * boost)); }
            } else {
                if (val > 0) { ret.set(id, Math.floor(val * boost)); }
            }
        }
        return ret;
    }
})();


// ── Boost button handlers ─────────────────────────────────────────────────────

function update_boosts(buttonId) {
    toggleButton(buttonId);
    solver_boosts_node.mark_dirty().update();
}

function update_radiance(input) {
    toggleButton(input + '-boost');
    solver_radiance_node.mark_dirty().update();
}

function updatePowderSpecials(buttonId) {
    const prefix = buttonId.split("-")[0].replace(' ', '_') + '-';
    const elem = document.getElementById(buttonId);
    if (!elem) return;
    if (elem.classList.contains("toggleOn")) {
        elem.classList.remove("toggleOn");
    } else {
        for (let i = 1; i < 6; i++) {
            const other = document.getElementById(prefix + i);
            if (other && other.classList.contains("toggleOn")) {
                other.classList.remove("toggleOn");
            }
        }
        elem.classList.add("toggleOn");
    }
}

// ── Node class definitions ────────────────────────────────────────────────────

/**
 * Reads an item name from an input field and returns an Item object (or NONE item).
 * Signature: ItemInputNode() => Item | null
 */
class ItemInputNode extends InputNode {
    constructor(name, input_field, none_item) {
        super(name, input_field);
        this.none_item = new Item(none_item);
        const cat = this.none_item.statMap.get('category');
        if (cat === 'armor' || cat === 'weapon') {
            this.none_item.statMap.set('powders', []);
            apply_weapon_powders(this.none_item.statMap);
        }
        this.none_item.statMap.set('NONE', true);
    }

    compute_func(_input_map) {
        const item_text = this.input_field.value;
        if (!item_text) return this.none_item;

        let item;
        if (item_text.slice(0, 3) === 'CI-') {
            item = decodeCustom({hash: item_text.substring(3)});
        } else if (item_text.slice(0, 3) === 'CR-') {
            item = decodeCraft({hash: item_text.substring(3)});
        } else if (itemMap.has(item_text)) {
            item = new Item(itemMap.get(item_text));
        } else if (tomeMap.has(item_text)) {
            item = new Item(tomeMap.get(item_text));
        }

        if (item) {
            const category = this.none_item.statMap.get('category');
            let type_match;
            if (category === 'weapon') {
                type_match = item.statMap.get('category') === 'weapon';
            } else if (item.statMap.get('crafted')) {
                // For crafteds, match by skill group
                type_match = item.statMap.get('type') === this.none_item.statMap.get('type');
            } else {
                type_match = item.statMap.get('type') === this.none_item.statMap.get('type');
            }
            if (type_match) {
                // Apply roll mode: Build.initBuildStats() always reads maxRolls, so we
                // replace maxRolls with getRolledValue(min, max) for each rolled stat.
                if (current_roll_mode !== ROLL_MODES.MAX) {
                    const minR = item.statMap.get('minRolls');
                    const maxR = item.statMap.get('maxRolls');
                    if (minR && maxR) {
                        const rolledMap = new Map();
                        for (const [id, maxVal] of maxR.entries()) {
                            rolledMap.set(id, getRolledValue(minR.get(id) ?? 0, maxVal));
                        }
                        item.statMap.set('maxRolls', rolledMap);
                    }
                }
                return item;
            }
        }
        return null;
    }
}

/**
 * Reads a powder string from an input field and returns a powder array.
 * Requires the associated item as input (for slot count).
 * Signature: PowderInputNode(item: Item) => List[powder]
 */
class PowderInputNode extends InputNode {
    constructor(name, input_field) {
        super(name, input_field);
        this.fail_cb = true;
    }

    compute_func(input_map) {
        const [item] = input_map.values();
        if (item === null) {
            this.input_field.placeholder = 'powders';
            return [];
        }
        if (item.statMap.has('slots')) {
            this.input_field.placeholder = item.statMap.get('slots') + ' slots';
        }

        let input = this.input_field.value.trim();
        let powdering = [];
        let errors = [];
        while (input) {
            const first = input.slice(0, 2).toLowerCase();
            const powder = powderIDs.get(first);
            if (powder === undefined) {
                if (first.length > 0) errors.push(first);
                else break;
            } else {
                powdering.push(powder);
            }
            input = input.slice(2);
        }

        if (errors.length || (item.statMap.get('slots') < powdering.length)) {
            this.input_field.classList.add('is-invalid');
        } else {
            this.input_field.classList.remove('is-invalid');
        }
        return powdering;
    }
}

/**
 * Applies powders to a copy of an item.
 * Signature: ItemPowderingNode(item: Item, powdering: List[powder]) => Item
 */
class ItemPowderingNode extends ComputeNode {
    constructor(name) { super(name); }

    compute_func(input_map) {
        const powdering   = input_map.get('powdering');
        const input_item  = input_map.get('item');
        const item        = input_item.copy();
        const max_slots   = item.statMap.get('slots');
        item.statMap.set('powders', powdering.slice(0, max_slots));
        if (item.statMap.get('category') === 'armor') {
            applyArmorPowders(item.statMap);
        } else if (item.statMap.get('category') === 'weapon') {
            apply_weapon_powders(item.statMap);
        }
        return item;
    }
}

const _TIER_CLASSES        = ['Normal','Unique','Rare','Legendary','Fabled','Mythic','Set','Crafted','Custom'];
const _TIER_SHADOW_CLASSES = _TIER_CLASSES.map(t => t + '-shadow');

/**
 * Updates the item slot UI: tier colour, health, level, and lock indicator.
 * Signature: SolverItemDisplayNode(item: Item) => null
 */
class SolverItemDisplayNode extends ComputeNode {
    constructor(name, eq) {
        super(name);
        this.input_field  = document.getElementById(eq + '-choice');
        this.health_field = document.getElementById(eq + '-health') || null;
        this.level_field  = document.getElementById(eq + '-lv')     || null;
        this.slot_elem    = document.getElementById(eq + '-dropdown') || null;
        this.item_image   = document.getElementById(eq + '-img')    || null;
        this.fail_cb      = true;
    }

    compute_func(input_map) {
        const [item] = input_map.values();

        // Reset styling
        this.input_field.classList.remove('text-light', 'is-invalid', ..._TIER_CLASSES);
        this.input_field.classList.add('text-light');
        if (this.item_image) this.item_image.classList.remove(..._TIER_SHADOW_CLASSES);
        if (this.health_field) this.health_field.textContent = '0';
        if (this.level_field)  this.level_field.textContent  = '0';
        if (this.slot_elem)    this.slot_elem.classList.remove('slot-locked', 'slot-unlocked');

        if (!item) {
            this.input_field.classList.add('is-invalid');
            if (this.slot_elem) this.slot_elem.classList.add('slot-unlocked');
            return null;
        }
        if (item.statMap.has('NONE')) {
            if (this.slot_elem) this.slot_elem.classList.add('slot-unlocked');
            return null;
        }

        const tier = item.statMap.get('tier');
        this.input_field.classList.add(tier);
        if (this.health_field) this.health_field.textContent = item.statMap.get('hp') || '0';
        if (this.level_field)  this.level_field.textContent  = item.statMap.get('lvl') || '0';
        if (this.item_image)   this.item_image.classList.add(tier + '-shadow');
        if (this.slot_elem)    this.slot_elem.classList.add('slot-locked');
        return null;
    }
}

/**
 * Renders the item tooltip when the item changes. Clears tooltip for empty slots.
 * Signature: SolverItemTooltipNode(item: Item) => null
 */
class SolverItemTooltipNode extends ComputeNode {
    constructor(name, tooltip_id) {
        super(name);
        this.tooltip_id = tooltip_id;
        this.fail_cb = true;
    }

    compute_func(input_map) {
        const [item] = input_map.values();
        const tooltip = document.getElementById(this.tooltip_id);
        if (!tooltip) return null;

        if (!item || item.statMap.has('NONE')) {
            tooltip.style.display = 'none';
            setHTML(this.tooltip_id, '');
            return null;
        }
        displayExpandedItem(item.statMap, this.tooltip_id);
        // Keep tooltip hidden until user clicks; displayExpandedItem may make it visible.
        tooltip.style.display = 'none';
        return null;
    }
}

/**
 * Updates the weapon image background-position and DPS display.
 * Signature: SolverWeaponDisplayNode(item: Item) => null
 */
class SolverWeaponDisplayNode extends ComputeNode {
    constructor(name) {
        super(name);
        this.image     = document.getElementById('weapon-img');
        this.dps_field = document.getElementById('weapon-dps');
        this.fail_cb   = true;
    }

    compute_func(input_map) {
        const [item] = input_map.values();
        if (!item || item.statMap.has('NONE')) return null;

        const type = item.statMap.get('type');
        if (type && itemBGPositions[type]) {
            this.image.style.backgroundPosition = itemBGPositions[type];
        }
        let dps = get_base_dps(item.statMap);
        if (isNaN(dps)) { dps = (Array.isArray(dps) ? dps[1] : 0); if (isNaN(dps)) dps = 0; }
        this.dps_field.textContent = Math.round(dps);
        return null;
    }
}

/**
 * Assembles a Build from all item inputs and the level field.
 * Returns null when all slots are empty (no build to display).
 *
 * Signature: SolverBuildAssembleNode(...) => Build | null
 */
class SolverBuildAssembleNode extends ComputeNode {
    constructor() { super('solver-make-build'); }

    compute_func(input_map) {
        const equipments = [
            input_map.get('helmet'),
            input_map.get('chestplate'),
            input_map.get('leggings'),
            input_map.get('boots'),
            input_map.get('ring1'),
            input_map.get('ring2'),
            input_map.get('bracelet'),
            input_map.get('necklace'),
        ];
        const tomes = [
            input_map.get('weaponTome1'),
            input_map.get('weaponTome2'),
            input_map.get('armorTome1'),
            input_map.get('armorTome2'),
            input_map.get('armorTome3'),
            input_map.get('armorTome4'),
            input_map.get('guildTome1'),
            input_map.get('lootrunTome1'),
            input_map.get('gatherXpTome1'),
            input_map.get('gatherXpTome2'),
            input_map.get('dungeonXpTome1'),
            input_map.get('dungeonXpTome2'),
            input_map.get('mobXpTome1'),
            input_map.get('mobXpTome2'),
        ];
        // Wynncraft skill-point equipping order: boots→helmet, ring1→neck, guildTome
        const wynn_equip = [
            input_map.get('boots'),
            input_map.get('leggings'),
            input_map.get('chestplate'),
            input_map.get('helmet'),
            input_map.get('ring1'),
            input_map.get('ring2'),
            input_map.get('bracelet'),
            input_map.get('necklace'),
            input_map.get('guildTome1'),
        ];
        const weapon = input_map.get('weapon');

        let level = parseInt(input_map.get('level-input'));
        if (isNaN(level)) level = 106;

        const all_none = equipments.concat([...tomes, weapon]).every(x => x.statMap.has('NONE'));
        if (all_none) return null;

        return new Build(level, equipments, tomes, weapon, wynn_equip);
    }
}

/**
 * Reads SP assignment results from the assembled Build and updates the read-only
 * skill-point display in the solver page.
 *
 * Signature: SolverSKPNode(build: Build) => null
 */
class SolverSKPNode extends ComputeNode {
    constructor() { super('solver-skillpoints'); this.fail_cb = true; }

    compute_func(input_map) {
        const build = input_map.get('build');

        // Clear display
        for (const skp of skp_order) {
            const totalEl  = document.getElementById(skp + '-skp-total');
            const assignEl = document.getElementById(skp + '-skp-assign');
            if (totalEl)  totalEl.textContent  = '—';
            if (assignEl) assignEl.textContent = 'Assign: 0';
        }
        const summaryBox = document.getElementById('summary-box');
        const errBox     = document.getElementById('err-box');
        if (summaryBox) summaryBox.textContent = '';
        if (errBox)     errBox.textContent     = '';

        if (!build) return null;

        // build.total_skillpoints = total after items + assigned
        // build.base_skillpoints  = how many points the player must manually assign
        for (const [i, skp] of skp_order.entries()) {
            const totalEl  = document.getElementById(skp + '-skp-total');
            const assignEl = document.getElementById(skp + '-skp-assign');
            if (totalEl)  totalEl.textContent  = build.total_skillpoints[i];
            if (assignEl) assignEl.textContent = 'Assign: ' + build.base_skillpoints[i];
        }

        if (summaryBox) {
            const total  = build.assigned_skillpoints;
            const budget = levelToSkillPoints(build.level);
            const rem    = budget - total;
            const p = document.createElement('p');
            p.classList.add('scaled-font', 'my-0');
            const span = document.createElement('b');
            span.classList.add(rem < 0 ? 'negative' : 'positive');
            span.textContent = String(rem);
            p.append('Assigned ', Object.assign(document.createElement('b'), {textContent: String(total)}),
                      ' skill points. Remaining: ', span);
            summaryBox.appendChild(p);
        }

        return null;
    }
}

// ── Graph initialisation ──────────────────────────────────────────────────────

// none_items indices (from load_item.js, populated during item loading):
//   0: helmet  1: chestplate  2: leggings  3: boots
//   4: ring1   5: ring2       6: bracelet  7: necklace  8: weapon (dagger)
const _NONE_ITEM_IDX = {
    helmet: 0, chestplate: 1, leggings: 2, boots: 3,
    ring1: 4, ring2: 5, bracelet: 6, necklace: 7, weapon: 8,
};

// none_tomes indices (from load_tome.js):
//   0: weaponTome  1: armorTome  2: guildTome  3: lootrunTome
//   4: gatherXpTome  5: dungeonXpTome  6: mobXpTome
const _NONE_TOME_KEY = {
    weaponTome1: 0, weaponTome2: 0,
    armorTome1:  1, armorTome2:  1, armorTome3:  1, armorTome4: 1,
    guildTome1:  2,
    lootrunTome1:  3,
    gatherXpTome1: 4, gatherXpTome2: 4,
    dungeonXpTome1: 5, dungeonXpTome2: 5,
    mobXpTome1: 6, mobXpTome2: 6,
};

/**
 * Encodes the current build state into the compact binary format used by WynnBuilder.
 * Powders are read from each PowderInputNode; skillpoints come from build.base_skillpoints.
 *
 * Signature: SolverBuildEncodeNode(build, atree, atree-state, aspects,
 *                                   helmet-powder…weapon-powder) => EncodingBitVector | null
 */
class SolverBuildEncodeNode extends ComputeNode {
    constructor() { super('solver-encode'); this.fail_cb = true; }

    compute_func(input_map) {
        const build = input_map.get('build');
        const atree = input_map.get('atree');
        if (!build || !atree) return null;

        const atree_state = input_map.get('atree-state');
        const aspects     = input_map.get('aspects') || [];
        const powders = [
            input_map.get('helmet-powder')    || [],
            input_map.get('chestplate-powder') || [],
            input_map.get('leggings-powder')   || [],
            input_map.get('boots-powder')      || [],
            input_map.get('weapon-powder')     || [],
        ];

        // Solver auto-computes SP — pass base_skillpoints so WynnBuilder can restore them.
        const skillpoints = build.base_skillpoints.slice();

        // Ensure version is set (may be absent when page loaded without a hash).
        if (typeof wynn_version_id === 'undefined' || wynn_version_id === null) {
            wynn_version_id = WYNN_VERSION_LATEST;
        }

        try {
            return encodeBuild(build, powders, skillpoints, atree, atree_state, aspects);
        } catch (e) {
            console.warn('[solver] encodeBuild failed:', e);
            return null;
        }
    }
}

/**
 * Pushes the encoded build to the browser history.
 * Roll mode is stored as a query param (?roll=X) since it is solver-specific.
 * The combo= param is written asynchronously by SolverComboTotalNode and
 * preserved here via the URL API.
 *
 * Signature: SolverURLUpdateNode(build-str: EncodingBitVector | null) => null
 */
class SolverURLUpdateNode extends ComputeNode {
    constructor() { super('solver-url-update'); this.fail_cb = true; }

    compute_func(input_map) {
        const build_str = input_map.get('build-str');
        if (!build_str) {
            window.history.replaceState(null, '', location.pathname);
            return null;
        }
        // Use the URL API so we can preserve any combo= param already in the URL.
        const url = new URL(window.location.href);
        if (current_roll_mode !== ROLL_MODES.MAX) {
            url.searchParams.set('roll', current_roll_mode);
        } else {
            url.searchParams.delete('roll');
        }
        // Replace path+query+hash while keeping any existing combo= entry.
        url.hash = build_str.toB64();
        window.history.replaceState(null, '', url.toString());
        return null;
    }
}

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

    // Pass 1: accumulate total slider_max per slider_name across ALL slider effects.
    // "overwrite" behavior replaces the property value rather than extending range,
    // so skip those to avoid inflating the max.
    const slider_total_max = new Map();
    for (const [, abil] of atree_merged) {
        for (const effect of abil.effects) {
            if (effect.type === 'stat_scaling' && effect.slider === true && effect.slider_name) {
                if (effect.behavior === 'overwrite') continue;
                const name = effect.slider_name;
                slider_total_max.set(name, (slider_total_max.get(name) ?? 0) + (effect.slider_max ?? 10));
            }
        }
    }

    // Pass 2: build registry entries.
    // For toggles: first unique name wins.
    // For sliders: first effect that has output creates the entry (using the pre-accumulated max);
    //              later effects with the same name are skipped.
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

                // Already registered by an earlier effect — skip.
                if (slider_idx.has(slider_name)) continue;

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
                // Only create a UI slider if there is actual output to apply.
                // Effects with behavior:"modify" and no output (e.g. Duplicity) only
                // contribute to slider_max, which is already handled by the pre-scan.
                if (stat_bonuses.length > 0 || prop_bonuses.length > 0) {
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
                const dot_idx  = b.key.indexOf('.');
                const map_name = b.key.substring(0, dot_idx);   // 'damMult' or 'defMult'
                const key      = b.key.substring(dot_idx + 1);  // e.g. 'SurpriseStrike'
                const target   = map_name === 'defMult' ? defMult : damMult;
                const contrib  = b.value * effective_value;
                if (b.mode === 'max') {
                    target.set(key, Math.max(target.get(key) ?? 0, contrib));
                } else {
                    target.set(key, (target.get(key) ?? 0) + contrib);
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
class SolverComboTotalNode extends ComputeNode {
    constructor() {
        super('solver-combo-total');
        this.fail_cb = true;
        this._last_registry_sig  = '';
        this._spell_map_cache    = null;
        this._registry_cache     = null;
        this._url_update_timer   = null;
    }

    /** Schedule an async URL update (debounced 400 ms). */
    _schedule_combo_url_update() {
        if (this._url_update_timer) clearTimeout(this._url_update_timer);
        this._url_update_timer = setTimeout(() => this._do_combo_url_update(), 400);
    }

    /** Async: compress combo rows and write the combo= query param. */
    async _do_combo_url_update() {
        const data = this._read_rows_as_data();
        const combo_param = data.length > 0
            ? await combo_encode_for_url(combo_data_to_text(data))
            : '';
        const url = new URL(window.location.href);
        if (combo_param) {
            // combo_param is 'combo=VALUE' — extract just the value
            url.searchParams.set('combo', combo_param.slice('combo='.length));
        } else {
            url.searchParams.delete('combo');
        }
        // Also persist the combo time field.
        const time_val = document.getElementById('combo-time')?.value?.trim() ?? '';
        if (time_val) {
            url.searchParams.set('ctime', time_val);
        } else {
            url.searchParams.delete('ctime');
        }
        // Also persist the Allow Downtime toggle.
        const downtime_on = document.getElementById('combo-downtime-btn')?.classList.contains('toggleOn') ?? false;
        if (downtime_on) {
            url.searchParams.set('dtime', '1');
        } else {
            url.searchParams.delete('dtime');
        }
        window.history.replaceState(null, '', url.toString());
    }

    compute_func(input_map) {
        const build      = input_map.get('build');
        const base_stats = input_map.get('base-stats');
        const spell_map  = input_map.get('spells');
        const atree_mg   = input_map.get('atree-merged');
        const total_elem = document.getElementById('combo-total-avg');

        // Refresh selection-mode spell dropdowns with the raw spell map initially.
        this._spell_map_cache = spell_map;
        if (spell_map) this._refresh_selection_spells(spell_map);

        if (!build || !base_stats || !spell_map || build.weapon.statMap.has('NONE')) {
            if (total_elem) total_elem.textContent = '—';
            return null;
        }

        const weapon = build.weapon.statMap;

        // Augment spell map with damaging powder specials (Quake, Chain Lightning, Courage)
        // based on the weapon's element powder counts.
        const weapon_powders = weapon.get('powders') ?? [];
        const aug_spell_map  = new Map(spell_map);
        for (const ps_idx of [0, 1, 3]) {  // Quake(earth), Chain Lightning(thunder), Courage(fire)
            const tier = get_element_powder_tier(weapon_powders, ps_idx);
            if (tier === 0) continue;
            aug_spell_map.set(-1000 - ps_idx, make_powder_special_spell(ps_idx, tier));
        }
        this._spell_map_cache = aug_spell_map;
        this._refresh_selection_spells(aug_spell_map);

        const registry = build_combo_boost_registry(atree_mg ?? new Map(), build);
        this._registry_cache = registry;
        this._refresh_selection_boosts(registry);
        this._apply_pending_selection_data();

        const crit_chance = skillPointsToPercentage(base_stats.get('dex'));

        const rows = this._read_combo_rows(aug_spell_map);
        let total      = 0;
        let mana_cost  = 0;
        const spell_costs = []; // [{name, qty, cost_per_cast}] for tooltip breakdown
        for (const { qty, spell, boost_tokens, dom_row } of rows) {
            const dmg_wrap  = dom_row?.querySelector('.combo-row-damage-wrap');
            const dmg_span  = dmg_wrap?.querySelector('.combo-row-damage')
                           ?? dom_row?.querySelector('.combo-row-damage');
            const dmg_popup = dmg_wrap?.querySelector('.combo-dmg-popup');
            if (qty <= 0 || !spell) {
                if (dmg_span)  dmg_span.textContent  = '';
                if (dmg_popup) dmg_popup.textContent = '';
                continue;
            }
            const { stats, prop_overrides } =
                apply_combo_row_boosts(base_stats, boost_tokens, registry);
            const mod_spell =
                apply_spell_prop_overrides(spell, prop_overrides, atree_mg);
            const full = computeSpellDisplayFull(stats, weapon, mod_spell, crit_chance);
            const per_cast = full ? full.avg : 0;
            const dmg_excluded = dom_row?.querySelector('.combo-dmg-toggle')
                                         ?.classList.contains('dmg-excluded') ?? false;
            if (!dmg_excluded) total += per_cast * qty;
            if (dmg_span) dmg_span.textContent = Math.round(per_cast).toLocaleString();
            // Populate the breakdown popup (shown on hover/click of the damage number).
            if (dmg_popup && full && full.avg > 0) {
                const spell_cost = full.has_cost && mod_spell.cost != null
                    ? getSpellCost(base_stats, mod_spell) : null;
                dmg_popup.innerHTML = renderSpellPopupHTML(full, crit_chance, spell_cost);
            } else if (dmg_popup) {
                dmg_popup.textContent = '';
            }
            // Mana cost: use base_stats (not row-boosted) for consistent cost calculation.
            // spell.cost may be null (e.g. Bamboozle) — skip those.
            // Skip if the row's mana toggle is excluded.
            const mana_excluded = dom_row?.querySelector('.combo-mana-toggle')
                                         ?.classList.contains('mana-excluded') ?? false;
            if (spell.cost != null && !mana_excluded) {
                const cost_per = getSpellCost(base_stats, spell);
                mana_cost += cost_per * qty;
                spell_costs.push({ name: spell.name, qty, cost: cost_per });
            }
        }

        if (total_elem) total_elem.textContent = Math.round(total).toLocaleString();

        // Transcendence (ARCANES major ID): 30% chance spell costs no mana → ×0.70 for expected value.
        const has_transcendence = (weapon.get('majorIds') ?? []).includes('ARCANES');
        if (has_transcendence) mana_cost *= 0.70;

        // Mana display.
        this._update_mana_display(base_stats, mana_cost, spell_costs, has_transcendence);

        // Schedule an async URL update; decoupled from the sync graph pipeline.
        this._schedule_combo_url_update();
        return null;
    }

    /** Read rows for calculation — returns [{qty, spell, boost_tokens, dom_row}]. */
    _read_combo_rows(spell_map) {
        const result = [];
        for (const row of document.querySelectorAll('#combo-selection-rows .combo-row')) {
            const qty = parseInt(row.querySelector('.combo-row-qty')?.value) || 0;
            const spell_id = parseInt(row.querySelector('.combo-row-spell')?.value);
            const spell = spell_map.get(spell_id) ?? null;
            const boost_tokens = [];
            for (const btn of row.querySelectorAll('.combo-row-boost-toggle.toggleOn')) {
                boost_tokens.push({ name: btn.dataset.boostName, value: 1, is_pct: false });
            }
            for (const inp of row.querySelectorAll('.combo-row-boost-slider')) {
                const val = parseFloat(inp.value) || 0;
                if (val > 0) boost_tokens.push({ name: inp.dataset.boostName, value: val, is_pct: false });
            }
            result.push({ qty, spell, boost_tokens, dom_row: row });
        }
        return result;
    }

    // ── Model read / write (cross-mode sync, URL, clipboard) ─────────────────

    /** Read rows as plain data [{qty, spell_name, boost_tokens_text, mana_excl, dmg_excl}]. */
    _read_rows_as_data() {
        return this._read_selection_rows_as_data();
    }

    _read_selection_rows_as_data() {
        const result = [];
        for (const row of document.querySelectorAll('#combo-selection-rows .combo-row')) {
            const qty      = parseInt(row.querySelector('.combo-row-qty')?.value) || 0;
            const spell_id = parseInt(row.querySelector('.combo-row-spell')?.value);
            const spell    = this._spell_map_cache?.get(spell_id);
            const spell_name = spell?.name ?? '';
            const boost_parts = [];
            for (const btn of row.querySelectorAll('.combo-row-boost-toggle.toggleOn')) {
                boost_parts.push(btn.dataset.boostName);
            }
            for (const inp of row.querySelectorAll('.combo-row-boost-slider')) {
                const val = parseFloat(inp.value) || 0;
                if (val > 0) boost_parts.push(inp.dataset.boostName + ' ' + val);
            }
            const mana_excl = row.querySelector('.combo-mana-toggle')
                                  ?.classList.contains('mana-excluded') ?? false;
            const dmg_excl  = row.querySelector('.combo-dmg-toggle')
                                  ?.classList.contains('dmg-excluded') ?? false;
            result.push({ qty, spell_name, boost_tokens_text: boost_parts.join(', '), mana_excl, dmg_excl });
        }
        return result;
    }

    /** Replace rows from data (import, URL restore). */
    _write_rows_from_data(data) {
        const container = document.getElementById('combo-selection-rows');
        if (!container) return;
        container.innerHTML = '';
        for (const { qty, spell_name, boost_tokens_text, mana_excl, dmg_excl } of data) {
            container.appendChild(
                _build_selection_row(qty, spell_name, boost_tokens_text, mana_excl, dmg_excl)
            );
        }
    }

    /**
     * After _refresh_selection_spells/_boosts run, apply any data-pending-*
     * attributes set on rows by _build_selection_row (from mode switch / URL restore).
     */
    _apply_pending_selection_data() {
        for (const row of document.querySelectorAll('#combo-selection-rows .combo-row')) {
            const ps = row.dataset.pendingSpell;
            const pb = row.dataset.pendingBoosts;
            const pm = row.dataset.pendingManaExcl;
            const pd = row.dataset.pendingDmgExcl;
            if (ps === undefined && pb === undefined && pm === undefined && pd === undefined) continue;

            if (ps !== undefined) {
                delete row.dataset.pendingSpell;
                const sel = row.querySelector('.combo-row-spell');
                if (sel && ps) {
                    const name_l = ps.toLowerCase();
                    for (const opt of sel.options) {
                        // Strip " (Powder Special)" suffix for comparison so powder specials restore correctly.
                        const opt_name = opt.textContent.toLowerCase().replace(/\s*\(powder special\)$/, '');
                        if (opt_name === name_l) { sel.value = opt.value; break; }
                    }
                }
            }
            if (pb !== undefined) {
                delete row.dataset.pendingBoosts;
                if (pb) {
                    const area = row.querySelector('.combo-row-boosts');
                    if (area) {
                        for (const { name, value } of parse_combo_boost_tokens(pb)) {
                            const nl = name.toLowerCase();
                            for (const btn of area.querySelectorAll('.combo-row-boost-toggle')) {
                                const bn = btn.dataset.boostName.toLowerCase();
                                if (bn === nl || bn === 'activate ' + nl) btn.classList.add('toggleOn');
                            }
                            for (const inp of area.querySelectorAll('.combo-row-boost-slider')) {
                                const bn = inp.dataset.boostName.toLowerCase();
                                if (bn === nl || bn === 'activate ' + nl) inp.value = String(value);
                            }
                        }
                    }
                }
                // Re-evaluate highlight now that boost state has been restored.
                _update_boost_btn_highlight(row);
            }
            if (pm !== undefined) {
                delete row.dataset.pendingManaExcl;
                if (pm === '1') {
                    row.querySelector('.combo-mana-toggle')?.classList.add('mana-excluded');
                }
            }
            if (pd !== undefined) {
                delete row.dataset.pendingDmgExcl;
                if (pd === '1') {
                    row.querySelector('.combo-dmg-toggle')?.classList.add('dmg-excluded');
                }
            }
        }
    }

    /** Repopulate spell <select> options in selection-mode rows. */
    _refresh_selection_spells(spell_map) {
        const container = document.getElementById('combo-selection-rows');
        if (!container) return;

        const all_damaging = [...spell_map.entries()].filter(([, s]) => spell_has_damage(s));
        // Regular spells (positive IDs) sorted ascending; powder specials (negative IDs) last.
        const regular = all_damaging.filter(([id]) => id >= 0).sort((a, b) => a[0] - b[0]);
        const powder  = all_damaging.filter(([id]) => id <  0).sort((a, b) => b[0] - a[0]);
        const damaging = [...regular, ...powder];

        for (const row of container.querySelectorAll('.combo-row')) {
            const sel = row.querySelector('.combo-row-spell');
            if (!sel) continue;
            const cur = sel.value;
            sel.innerHTML = '<option value="">— Select Attack —</option>';
            for (const [id, s] of damaging) {
                const opt = document.createElement('option');
                opt.value       = String(id);
                opt.textContent = s._is_powder_special ? s.name + ' (Powder Special)' : s.name;
                sel.appendChild(opt);
            }
            if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
        }
    }

    /** Repopulate boost toggle/slider controls in selection-mode rows. */
    _refresh_selection_boosts(registry) {
        const container = document.getElementById('combo-selection-rows');
        if (!container) return;

        const sig = registry.map(e => e.name + ':' + e.type).join(',');
        const registry_changed = sig !== this._last_registry_sig;
        if (registry_changed) this._last_registry_sig = sig;

        for (const row of container.querySelectorAll('.combo-row')) {
            const area = row.querySelector('.combo-row-boosts');
            if (!area) continue;

            // Skip rows that already have controls and the registry hasn't changed.
            // Always populate rows with empty boost areas (newly added or from mode switch).
            if (!registry_changed && area.children.length > 0) continue;

            // Save existing values.
            const old_toggle = new Map();
            const old_slider = new Map();
            for (const b of area.querySelectorAll('.combo-row-boost-toggle')) {
                old_toggle.set(b.dataset.boostName, b.classList.contains('toggleOn'));
            }
            for (const i of area.querySelectorAll('.combo-row-boost-slider')) {
                old_slider.set(i.dataset.boostName, i.value);
            }

            area.innerHTML = '';

            // Render toggles first, then sliders, with a separator between them.
            const toggles = registry.filter(e => e.type === 'toggle');
            const sliders = registry.filter(e => e.type !== 'toggle');

            for (const entry of toggles) {
                const btn = document.createElement('button');
                btn.className = 'btn btn-sm button-boost border-0 text-white dark-8u dark-shadow-sm m-1 combo-row-boost-toggle';
                btn.dataset.boostName = entry.name;
                btn.textContent = entry.name;
                if (old_toggle.get(entry.name)) btn.classList.add('toggleOn');
                btn.addEventListener('click', () => {
                    btn.classList.toggle('toggleOn');
                    _update_boost_btn_highlight(row);
                    if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
                });
                area.appendChild(btn);
            }

            if (toggles.length > 0 && sliders.length > 0) {
                const sep = document.createElement('hr');
                sep.className = 'my-1';
                area.appendChild(sep);
            }

            for (const entry of sliders) {
                const wrap  = document.createElement('div');
                wrap.className = 'd-inline-flex align-items-center gap-1 m-1';
                const lbl   = document.createElement('span');
                lbl.className   = 'text-secondary small text-nowrap';
                lbl.textContent = entry.name + ':';
                const inp   = document.createElement('input');
                inp.type    = 'number';
                inp.className   = 'combo-row-input combo-row-boost-slider';
                inp.style.cssText = 'width:4em; text-align:center;';
                inp.dataset.boostName = entry.name;
                inp.min     = '0';
                inp.max     = String(entry.max ?? 100);
                inp.step    = String(entry.step ?? 1);
                inp.value   = old_slider.get(entry.name) ?? '0';
                const max_lbl = document.createElement('span');
                max_lbl.className   = 'text-secondary small';
                max_lbl.textContent = '/' + (entry.max ?? 100);
                inp.addEventListener('input', () => {
                    _update_boost_btn_highlight(row);
                    if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
                });
                wrap.append(lbl, inp, max_lbl);
                area.appendChild(wrap);
            }
            _update_boost_btn_highlight(row);
        }
    }

    /** Update the mana display below the combo total. */
    _update_mana_display(base_stats, mana_cost, spell_costs = [], has_transcendence = false) {
        const mana_row     = document.getElementById('combo-mana-row');
        const mana_elem    = document.getElementById('combo-mana-display');
        const mana_tooltip = document.getElementById('combo-mana-tooltip');
        const time_inp     = document.getElementById('combo-time');
        const downtime_btn = document.getElementById('combo-downtime-btn');
        if (!mana_elem) return;

        const time_str = time_inp?.value?.trim() ?? '';
        if (!time_str) {
            if (mana_row) mana_row.style.display = 'none';
            mana_elem.textContent = '';
            return;
        }

        const combo_time = parseFloat(time_str) || 0;
        const allow_down = downtime_btn?.classList.contains('toggleOn') ?? false;
        const mr         = base_stats.get('mr') ?? 0;
        // Mana pool: 100 base + item maxMana bonus + int scaling (same mult=1 as str/dex, up to +80 at 150 int).
        const item_mana  = base_stats.get('maxMana') ?? 0;
        const int_mana   = Math.floor(skillPointsToPercentage(base_stats.get('int') ?? 0) * 100);
        const start_mana = 100 + item_mana + int_mana;
        // mr is per 5 seconds; divide by 5 to get per-second rate.
        const mana_regen = (mr / 5) * combo_time;
        const end_mana   = start_mana - mana_cost + mana_regen;
        const deficit    = start_mana - end_mana; // positive = net loss per combo

        let text = `Mana: ${Math.round(end_mana)}/${start_mana}`;
        if (!allow_down && deficit > 5) {
            text += ' \u26a0 not sustainable (\u2212' + Math.round(deficit) + ')';
            mana_elem.className = 'small text-warning';
        } else {
            mana_elem.className = 'small text-secondary';
        }
        mana_elem.textContent = text;
        if (mana_row) mana_row.style.display = '';

        if (mana_tooltip) {
            const fmt = n => (n >= 0 ? '+' : '\u2212') + Math.abs(Math.round(n));
            let html = '';
            // Per-spell cost breakdown — group rows with the same spell name.
            if (spell_costs.length) {
                const grouped = [];
                const seen = new Map(); // name → index in grouped
                for (const { name, qty, cost } of spell_costs) {
                    if (seen.has(name)) {
                        grouped[seen.get(name)].qty += qty;
                    } else {
                        seen.set(name, grouped.length);
                        grouped.push({ name, qty, cost });
                    }
                }
                for (const { name, qty, cost } of grouped) {
                    const total = cost * qty;
                    html += qty > 1
                        ? `<div>${qty}\u00d7 ${name}: ${Math.round(cost)} (\u2192 ${Math.round(total)})</div>`
                        : `<div>${name}: ${Math.round(cost)}</div>`;
                }
                html += '<hr class="my-1 border-secondary">';
            }
            let start_str = '100';
            if (item_mana || int_mana) {
                if (item_mana) start_str += ` + ${item_mana} item`;
                if (int_mana)  start_str += ` + ${int_mana} int`;
                start_str += ` = ${start_mana}`;
            }
            let cost_str = fmt(-mana_cost);
            if (has_transcendence) cost_str += ' (\u00d70.70 Transcendence)';
            html +=
                `<div>Starting mana: ${start_str}</div>` +
                `<div>Spell costs: ${cost_str}</div>` +
                `<div>Regen \u00d7${combo_time}s: ${fmt(mana_regen)} (${mr}/5s)</div>` +
                `<hr class="my-1 border-secondary">` +
                `<div>Ending mana: ${Math.round(end_mana)} / ${start_mana}</div>`;
            mana_tooltip.innerHTML = html;
        }
    }
}

/** Reflect whether any boost is active on a combo row's Boosts button. */
function _update_boost_btn_highlight(row) {
    const btn = row.querySelector('.combo-boost-menu-btn');
    if (!btn) return;
    const any_toggle = row.querySelector('.combo-row-boost-toggle.toggleOn') !== null;
    const any_slider = [...row.querySelectorAll('.combo-row-boost-slider')]
        .some(inp => (parseFloat(inp.value) || 0) > 0);
    btn.classList.toggle('toggleOn', any_toggle || any_slider);
}

let solver_combo_total_node = null;

// ── Combo row builder ─────────────────────────────────────────────────────────

function _build_selection_row(qty_val, pending_spell, pending_boosts, pending_mana_excl, pending_dmg_excl) {
    const row = document.createElement('div');
    row.className = 'combo-row d-flex gap-2 align-items-center';
    if (pending_spell     !== undefined) row.dataset.pendingSpell    = pending_spell;
    if (pending_boosts    !== undefined) row.dataset.pendingBoosts   = pending_boosts;
    if (pending_mana_excl)               row.dataset.pendingManaExcl = '1';
    if (pending_dmg_excl)                row.dataset.pendingDmgExcl  = '1';

    const rm_btn = document.createElement('button');
    rm_btn.className   = 'btn btn-sm btn-outline-danger flex-shrink-0';
    rm_btn.textContent = '×';
    rm_btn.title       = 'Remove row';
    rm_btn.addEventListener('click', () => combo_remove_row(rm_btn));

    const qty_inp = document.createElement('input');
    qty_inp.type      = 'number';
    qty_inp.className = 'combo-row-input combo-row-qty flex-shrink-0';
    qty_inp.value     = String(qty_val);
    qty_inp.min       = '0';
    qty_inp.max       = '999';
    qty_inp.style.cssText = 'width:3em; text-align:center;';
    qty_inp.addEventListener('input', () => {
        if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    });

    const spell_sel = document.createElement('select');
    spell_sel.className = 'form-select form-select-sm text-light bg-dark combo-row-spell';
    spell_sel.innerHTML = '<option value="">— Select Attack —</option>';
    spell_sel.addEventListener('change', () => {
        if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    });

    const boost_wrap = document.createElement('div');
    boost_wrap.className = 'combo-boost-btn-wrap position-relative';

    const boost_btn = document.createElement('button');
    boost_btn.className   = 'btn btn-sm btn-outline-secondary combo-boost-menu-btn';
    boost_btn.textContent = 'Boosts \u25be';
    boost_btn.addEventListener('click', (e) => {
        e.stopPropagation();
        combo_toggle_boost_popup(boost_btn);
    });

    const popup = document.createElement('div');
    // NOTE: Do NOT add Bootstrap's position-absolute class here — its `!important`
    // would prevent JS from upgrading to position:fixed for full-column-width display.
    // Absolute positioning defaults come from .boost-popup in solver-wide.css.
    popup.className   = 'boost-popup combo-row-boosts bg-dark border border-secondary rounded p-2';
    popup.style.display = 'none';

    boost_wrap.append(boost_btn, popup);

    const mana_btn = document.createElement('button');
    mana_btn.type      = 'button';
    mana_btn.className = 'combo-mana-toggle flex-shrink-0';
    mana_btn.title     = 'Include ability in mana calculation';
    mana_btn.addEventListener('click', () => {
        mana_btn.classList.toggle('mana-excluded');
        if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    });

    const dmg_btn = document.createElement('button');
    dmg_btn.type      = 'button';
    dmg_btn.className = 'combo-dmg-toggle flex-shrink-0';
    dmg_btn.title     = 'Include ability in damage total';
    dmg_btn.addEventListener('click', () => {
        dmg_btn.classList.toggle('dmg-excluded');
        if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    });

    // Damage display with hoverable/clickable breakdown popup.
    const dmg_wrap = document.createElement('div');
    dmg_wrap.className = 'combo-row-damage-wrap';
    const dmg_span = document.createElement('span');
    dmg_span.className   = 'combo-row-damage Damage text-nowrap small ms-1';
    dmg_span.textContent = '';
    const dmg_popup = document.createElement('div');
    dmg_popup.className = 'combo-dmg-popup text-light';
    dmg_wrap.append(dmg_span, dmg_popup);
    dmg_wrap.addEventListener('click', (e) => {
        e.stopPropagation();
        dmg_wrap.classList.toggle('popup-locked');
    });

    // Drag-and-drop reordering within the selection-mode rows container.
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', ''); // Firefox requires this
        row.classList.add('dragging');
        row._drag_source = true;
    });
    row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        row._drag_source = false;
        document.querySelectorAll('.combo-row.drag-over-top')
            .forEach(r => r.classList.remove('drag-over-top'));
    });
    row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const dragging = document.querySelector('.combo-row.dragging');
        if (!dragging || dragging === row) return;
        document.querySelectorAll('.combo-row.drag-over-top')
            .forEach(r => r.classList.remove('drag-over-top'));
        row.classList.add('drag-over-top');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over-top'));
    row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over-top');
        const dragging = document.querySelector('.combo-row.dragging');
        if (!dragging || dragging === row) return;
        const container = row.parentElement;
        if (container) container.insertBefore(dragging, row);
        if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    });

    row.append(rm_btn, qty_inp, spell_sel, boost_wrap, mana_btn, dmg_btn, dmg_wrap);
    return row;
}

// ── Combo data serialization ──────────────────────────────────────────────────

/** Serialize [{qty, spell_name, boost_tokens_text, mana_excl, dmg_excl}] to multi-line text. */
function combo_data_to_text(data) {
    return data.map(({ qty, spell_name, boost_tokens_text, mana_excl, dmg_excl }) => {
        let line = qty + ' | ' + spell_name + ' | ' + boost_tokens_text;
        if (mana_excl || dmg_excl) line += ' | ' + (mana_excl ? '1' : '0');
        if (dmg_excl) line += ' | 1';
        return line;
    }).join('\n');
}

/** Parse multi-line text to [{qty, spell_name, boost_tokens_text, mana_excl, dmg_excl}]. */
function combo_text_to_data(text) {
    const result = [];
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split('|');
        const qty             = Math.max(0, parseInt(parts[0]?.trim()) || 1);
        const spell_name      = (parts[1] ?? '').trim();
        if (!spell_name) continue;
        const boost_tokens_text = (parts[2] ?? '').trim();
        const mana_excl = (parts[3] ?? '').trim() === '1';
        const dmg_excl  = (parts[4] ?? '').trim() === '1';
        result.push({ qty, spell_name, boost_tokens_text, mana_excl, dmg_excl });
    }
    return result;
}

// ── URL codec helpers ─────────────────────────────────────────────────────────

/** Drain a ReadableStream into a single Uint8Array. */
async function _read_stream_bytes(stream) {
    const reader = stream.getReader();
    const chunks = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
}

/** URL-safe base64 (replaces +→-, /→_, strips =). */
function _bytes_to_b64url(bytes) {
    return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Reverse URL-safe base64 back to Uint8Array. */
function _b64url_to_bytes(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/**
 * Async: deflate-compress combo text and return 'combo=c:BASE64URL'.
 * Falls back to uncompressed 'combo=BASE64URL' if CompressionStream is unavailable.
 * Returns '' when text is empty.
 */
async function combo_encode_for_url(text) {
    if (!text.trim()) return '';
    try {
        const input_bytes = new TextEncoder().encode(text);
        const cs = new CompressionStream('deflate-raw');
        const writer = cs.writable.getWriter();
        writer.write(input_bytes);
        writer.close();
        const compressed = await _read_stream_bytes(cs.readable);
        return 'combo=c:' + _bytes_to_b64url(compressed);
    } catch (_) {
        // Fallback: uncompressed (no 'c:' prefix so decoder knows it's plain)
        try {
            return 'combo=' + _bytes_to_b64url(new TextEncoder().encode(text));
        } catch (e2) { return ''; }
    }
}

/**
 * Async: decode a combo URL parameter value back to text.
 * Handles 'c:BASE64URL' (deflate-raw compressed) and plain 'BASE64URL' (legacy).
 */
async function combo_decode_from_url(encoded) {
    try {
        if (encoded.startsWith('c:')) {
            const bytes = _b64url_to_bytes(encoded.slice(2));
            const ds = new DecompressionStream('deflate-raw');
            const writer = ds.writable.getWriter();
            writer.write(bytes);
            writer.close();
            const decompressed = await _read_stream_bytes(ds.readable);
            return new TextDecoder().decode(decompressed);
        } else {
            // Legacy uncompressed path
            const bytes = _b64url_to_bytes(encoded);
            return new TextDecoder().decode(bytes);
        }
    } catch(e) { return ''; }
}

/** Copy combo to clipboard as text. */
function combo_export() {
    if (!solver_combo_total_node) return;
    const text = combo_data_to_text(solver_combo_total_node._read_rows_as_data());
    if (!text.trim()) return;
    navigator.clipboard.writeText(text).catch(e => console.warn('[solver] combo export failed:', e));
}

/** Paste combo from clipboard into the current mode. */
async function combo_import() {
    try {
        const text = await navigator.clipboard.readText();
        const data = combo_text_to_data(text);
        if (!data.length || !solver_combo_total_node) return;
        solver_combo_total_node._write_rows_from_data(data);
        solver_combo_total_node.mark_dirty().update();
    } catch(e) { console.warn('[solver] combo import failed:', e); }
}

// ── Combo UI helpers (called from inline onclick in index.html) ───────────────

function combo_add_row() {
    const container = document.getElementById('combo-selection-rows');
    if (!container) return;
    container.appendChild(_build_selection_row(1));
    if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
}

function combo_toggle_boost_popup(btn) {
    const popup = btn.parentElement.querySelector('.boost-popup');
    if (!popup) return;
    const showing = popup.style.display !== 'none';
    // Hide all popups and clear any fixed-position inline overrides.
    document.querySelectorAll('.boost-popup').forEach(p => {
        p.style.display  = 'none';
        p.style.position = '';
        p.style.top      = '';
        p.style.right    = '';
        p.style.left     = '';
        p.style.width    = '';
        p.style.maxWidth = '';
    });
    if (!showing) {
        // Try to span the full combo column using fixed positioning.
        // Use right-anchor so the popup never extends past the column's right edge.
        const btn_rect  = btn.getBoundingClientRect();
        const combo_col = btn.closest('.col-xl-4');
        if (combo_col) {
            const col_rect = combo_col.getBoundingClientRect();
            const vw = document.documentElement.clientWidth;
            popup.style.position = 'fixed';
            popup.style.top      = (btn_rect.bottom + 4) + 'px';
            popup.style.right    = (vw - col_rect.right) + 'px';
            popup.style.left     = 'auto';
            popup.style.width    = col_rect.width + 'px';
        }
        popup.style.display = 'block';
    }
}

function combo_remove_row(btn) {
    btn.closest('.combo-row')?.remove();
    if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
}

function combo_toggle_downtime() {
    const btn = document.getElementById('combo-downtime-btn');
    if (!btn) return;
    btn.classList.toggle('toggleOn');
    if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
}

// Module-level refs for use by reset / future phases
let solver_equip_input_nodes   = [];  // ItemInputNode (pre-powder) for each equipment slot
let solver_item_final_nodes    = [];  // ItemPowderingNode (or ItemInputNode for accessories/tomes)
let solver_build_node          = null;
let solver_aspect_input_nodes  = [];  // AspectInputNode instances (Phase 3)
let solver_powder_nodes        = {};  // eq → PowderInputNode (helmet/chest/legs/boots/weapon)

function solver_graph_init() {
    console.log("solver_graph_init: Phase 4");

    // ── Level ────────────────────────────────────────────────────────────────
    const level_input = new InputNode('level-input', document.getElementById('level-choice'));

    // ── Build assembly (collects all item/tome nodes + level) ────────────────
    solver_build_node = new SolverBuildAssembleNode();
    solver_build_node.link_to(level_input);  // keyed as 'level-input' (node.name)

    // ── Equipment slots ──────────────────────────────────────────────────────
    for (const eq of equipment_fields) {
        const none_item     = none_items[_NONE_ITEM_IDX[eq]];
        const input_field   = document.getElementById(eq + '-choice');
        const raw_item_node = new ItemInputNode('solver-' + eq + '-input', input_field, none_item);
        solver_equip_input_nodes.push(raw_item_node);

        let item_node = raw_item_node;

        if (powderable_keys.includes(eq)) {
            const powder_field = document.getElementById(eq + '-powder');
            const powder_node  = new PowderInputNode('solver-' + eq + '-powder', powder_field)
                                     .link_to(raw_item_node, 'item');
            solver_powder_nodes[eq] = powder_node;
            const powder_apply = new ItemPowderingNode('solver-' + eq + '-powder-apply')
                                     .link_to(powder_node,   'powdering')
                                     .link_to(raw_item_node, 'item');
            item_node = powder_apply;
        }

        solver_item_final_nodes.push(item_node);

        new SolverItemDisplayNode('solver-' + eq + '-display', eq).link_to(item_node);
        new SolverItemTooltipNode('solver-' + eq + '-tooltip', eq + '-tooltip').link_to(item_node);
        solver_build_node.link_to(item_node, eq);
    }

    // Weapon image + DPS (weapon is the last entry in equipment_fields at index 8)
    new SolverWeaponDisplayNode('solver-weapon-type-display').link_to(solver_item_final_nodes[8]);

    // ── Tome slots ───────────────────────────────────────────────────────────
    for (const eq of tome_fields) {
        const none_tome   = none_tomes[_NONE_TOME_KEY[eq]];
        const input_field = document.getElementById(eq + '-choice');
        const item_node   = new ItemInputNode('solver-' + eq + '-input', input_field, none_tome);

        solver_equip_input_nodes.push(item_node);
        solver_item_final_nodes.push(item_node);

        new SolverItemDisplayNode('solver-' + eq + '-display', eq).link_to(item_node);
        solver_build_node.link_to(item_node, eq);
    }

    // ── Skill-point display ──────────────────────────────────────────────────
    new SolverSKPNode().link_to(solver_build_node, 'build');

    // ── Phase 3: Class detection ─────────────────────────────────────────────
    const class_node = new PlayerClassNode('solver-class').link_to(solver_build_node, 'build');

    // ── Phase 3: Aspects ─────────────────────────────────────────────────────
    aspect_agg_node = new AspectAggregateNode('final-aspects');
    const aspects_dropdown = document.getElementById('aspects-dropdown');
    for (const field of aspect_fields) {
        const aspect_input_field   = document.getElementById(field + '-choice');
        const aspect_tier_field    = document.getElementById(field + '-tier-choice');
        const aspect_image_div     = document.getElementById(field + '-img');
        const aspect_image_loc_div = document.getElementById(field + '-img-loc');

        new AspectAutocompleteInitNode(field + '-autocomplete', field)
            .link_to(class_node, 'player-class');

        const aspect_input = new AspectInputNode(field + '-input', aspect_input_field)
            .link_to(class_node, 'player-class');
        solver_aspect_input_nodes.push(aspect_input);

        new AspectInputDisplayNode(field + '-input-display', aspect_input_field, aspect_image_div)
            .link_to(aspect_input, 'aspect-spec');

        const aspect_tier_input = new AspectTierInputNode(field + '-tier-input', aspect_tier_field)
            .link_to(aspect_input, 'aspect-spec');

        new AspectRenderNode(field + '-render', aspect_image_loc_div, aspects_dropdown)
            .link_to(aspect_tier_input, 'tooltip-args');

        aspect_agg_node.link_to(aspect_tier_input, field + '-tiered');
    }

    // ── Phase 3: Ability tree ────────────────────────────────────────────────
    atree_node.link_to(class_node, 'player-class');
    atree_merge.link_to(solver_build_node, 'build');
    atree_merge.link_to(class_node, 'player-class');
    atree_merge.link_to(aspect_agg_node);
    atree_validate.link_to(level_input, 'level');

    // ── Phase 3: Stat aggregation pipeline ───────────────────────────────────

    // Extract build.statMap into a plain StatMap for aggregation
    const build_stat_node = new SolverBuildStatExtractNode()
        .link_to(solver_build_node, 'build');

    // Pre-scale aggregation: build stats + atree raw stat bonuses
    const pre_scale_agg = new AggregateStatsNode('solver-pre-scale-stats');
    pre_scale_agg.link_to(build_stat_node, 'build-stats');
    pre_scale_agg.link_to(atree_raw_stats, 'atree-raw-stats');

    // Radiance / Divine Honor scaling of the pre-scale stat total
    solver_radiance_node.link_to(pre_scale_agg, 'stats');

    // Atree scaling nodes need the radiance-scaled stats as their "scale-stats" input
    atree_scaling.link_to(solver_radiance_node, 'scale-stats');

    // Final stat aggregation: radiance-scaled stats + atree scaling deltas + boosts
    const stat_agg = new AggregateStatsNode('solver-final-stats');
    stat_agg.link_to(solver_radiance_node, 'pre-scaling');
    stat_agg.link_to(atree_scaling_stats,  'atree-scaling');
    stat_agg.link_to(solver_boosts_node,   'potion-boost');

    // Build stats display (populates Summary and Detailed tabs in the middle column)
    new SolverBuildDisplayNode()
        .link_to(solver_build_node, 'build')
        .link_to(stat_agg, 'stats');

    // ── Phase 4: Per-row combo ────────────────────────────────────────────────
    // combo_base_stats is stat_agg without solver_boosts_node so that per-row
    // boosts specified in the combo text/selection override them individually.
    const combo_base_stats = new AggregateStatsNode('solver-combo-base-stats');
    combo_base_stats.link_to(solver_radiance_node, 'pre-scaling');
    combo_base_stats.link_to(atree_scaling_stats,  'atree-scaling');

    solver_combo_total_node = new SolverComboTotalNode()
        .link_to(solver_build_node,    'build')
        .link_to(combo_base_stats,     'base-stats')
        .link_to(atree_collect_spells, 'spells')
        .link_to(atree_merge,          'atree-merged');

    // Close boost popups and locked damage popups when clicking outside them.
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.combo-boost-btn-wrap')) {
            document.querySelectorAll('.boost-popup').forEach(p => {
                p.style.display = 'none';
                p.style.position = '';
                p.style.top = '';
                p.style.left = '';
                p.style.width = '';
                p.style.maxWidth = '';
                p.style.right = '0';
            });
        }
        if (!e.target.closest('.combo-row-damage-wrap')) {
            document.querySelectorAll('.combo-row-damage-wrap.popup-locked')
                .forEach(w => w.classList.remove('popup-locked'));
        }
    });

    // ── URL encoding ─────────────────────────────────────────────────────────
    const encode_node = new SolverBuildEncodeNode()
        .link_to(solver_build_node, 'build')
        .link_to(atree_node,        'atree')
        .link_to(atree_state_node,  'atree-state')
        .link_to(aspect_agg_node,   'aspects');
    for (const eq of powderable_keys) {
        encode_node.link_to(solver_powder_nodes[eq], eq + '-powder');
    }
    new SolverURLUpdateNode()
        .link_to(encode_node, 'build-str');

    // ── Fire initial update cascade ──────────────────────────────────────────
    for (const node of solver_equip_input_nodes) {
        node.update();
    }
    level_input.update();

    for (const node of solver_aspect_input_nodes) {
        node.update();
    }

    graph_live_update = true;
    console.log("solver_graph_init: Phase 4 complete");
}
