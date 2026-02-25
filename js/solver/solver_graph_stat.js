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
