/**
 * Solver page constants.
 * Mirrors builder_constants.js but WITHOUT any DOM manipulation at load time,
 * so this file is safe to load on the solver page.
 */

const SOLVER_VERSION = "0.1.0";

// ── Item slot definitions ────────────────────────────────────────────────────

let equipment_fields = [
    "helmet",
    "chestplate",
    "leggings",
    "boots",
    "ring1",
    "ring2",
    "bracelet",
    "necklace",
    "weapon"
];

let equipment_names = [
    "Helmet",
    "Chestplate",
    "Leggings",
    "Boots",
    "Ring 1",
    "Ring 2",
    "Bracelet",
    "Necklace",
    "Weapon"
];

let tome_fields = [
    "weaponTome1",
    "weaponTome2",
    "armorTome1",
    "armorTome2",
    "armorTome3",
    "armorTome4",
    "guildTome1",
    "lootrunTome1",
    "gatherXpTome1",
    "gatherXpTome2",
    "dungeonXpTome1",
    "dungeonXpTome2",
    "mobXpTome1",
    "mobXpTome2"
];

let aspect_fields = [
    "aspect1",
    "aspect2",
    "aspect3",
    "aspect4",
    "aspect5",
];

// Derived input element ID arrays
let equipment_inputs    = equipment_fields.map(x => x + "-choice");
let tomeInputs          = tome_fields.map(x => x + "-choice");
let aspectInputs        = aspect_fields.map(x => x + "-choice");
let aspectTierInputs    = aspect_fields.map(x => x + "-tier-choice");

// Powder-accepting slots
let powder_inputs = [
    "helmet-powder",
    "chestplate-powder",
    "leggings-powder",
    "boots-powder",
    "weapon-powder",
];

// Slot category groupings (mirrors build_utils.js globals)
let weapon_keys      = ['dagger', 'wand', 'bow', 'relik', 'spear'];
let armor_keys       = ['helmet', 'chestplate', 'leggings', 'boots'];
let accessory_keys   = ['ring1', 'ring2', 'bracelet', 'necklace'];
let powderable_keys  = ['helmet', 'chestplate', 'leggings', 'boots', 'weapon'];
let equipment_keys   = ['helmet', 'chestplate', 'leggings', 'boots', 'ring1', 'ring2', 'bracelet', 'necklace', 'weapon'];
let tome_keys        = ['weaponTome1', 'weaponTome2', 'armorTome1', 'armorTome2', 'armorTome3', 'armorTome4',
                        'guildTome1', 'lootrunTome1', 'gatherXpTome1', 'gatherXpTome2',
                        'dungeonXpTome1', 'dungeonXpTome2', 'mobXpTome1', 'mobXpTome2'];

// ── Solver-specific constants ────────────────────────────────────────────────

/**
 * Roll modes control which value in the rolled ID range is used when evaluating
 * items during the solve. The existing expandItem() gives minRolls/maxRolls.
 *
 *   MAX  → use maxRolls  (matches WynnBuilder default)
 *   PCT75 → minRolls + 0.75 * (maxRolls - minRolls)
 *   AVG  → (minRolls + maxRolls) / 2
 *   MIN  → use minRolls
 */
const ROLL_MODES = Object.freeze({
    MAX:   "max",
    PCT75: "75pct",
    AVG:   "avg",
    MIN:   "min",
});

let current_roll_mode = ROLL_MODES.MAX;

/**
 * Stats available for use in restriction threshold rows.
 * Each entry: { key: <statMap key>, label: <display name> }
 * Ordered by category for readability in the autocomplete list.
 */
const RESTRICTION_STATS = [
    // ── Health / Sustain ────────────────────────────────────────────────
    { key: 'ehp',        label: 'Effective HP' },   // derived — computed during solver eval
    { key: 'hpBonus',    label: 'HP Bonus' },
    { key: 'hprRaw',     label: 'Health Regen' },
    { key: 'hprPct',     label: 'Health Regen %' },
    { key: 'healPct',    label: 'Heal Effectiveness %' },
    { key: 'ls',         label: 'Life Steal' },
    // ── Mana ────────────────────────────────────────────────────────────
    { key: 'mr',         label: 'Mana Regen' },
    { key: 'ms',         label: 'Mana Steal' },
    // ── Skill Points ────────────────────────────────────────────────────
    { key: 'str',        label: 'Strength' },
    { key: 'dex',        label: 'Dexterity' },
    { key: 'int',        label: 'Intelligence' },
    { key: 'def',        label: 'Defense' },
    { key: 'agi',        label: 'Agility' },
    // ── Damage (generic) ────────────────────────────────────────────────
    { key: 'sdRaw',      label: 'Spell Damage Raw' },
    { key: 'sdPct',      label: 'Spell Damage %' },
    { key: 'mdRaw',      label: 'Melee Damage Raw' },
    { key: 'mdPct',      label: 'Melee Damage %' },
    { key: 'damRaw',     label: 'Damage Raw' },
    { key: 'damPct',     label: 'Damage %' },
    { key: 'critDamPct', label: 'Crit Damage %' },
    // ── Elemental Damage % ──────────────────────────────────────────────
    { key: 'eDamPct',    label: 'Earth Damage %' },
    { key: 'tDamPct',    label: 'Thunder Damage %' },
    { key: 'wDamPct',    label: 'Water Damage %' },
    { key: 'fDamPct',    label: 'Fire Damage %' },
    { key: 'aDamPct',    label: 'Air Damage %' },
    // ── Elemental Damage Raw ────────────────────────────────────────────
    { key: 'eDamRaw',    label: 'Earth Damage Raw' },
    { key: 'tDamRaw',    label: 'Thunder Damage Raw' },
    { key: 'wDamRaw',    label: 'Water Damage Raw' },
    { key: 'fDamRaw',    label: 'Fire Damage Raw' },
    { key: 'aDamRaw',    label: 'Air Damage Raw' },
    // ── Elemental Spell Damage ──────────────────────────────────────────
    { key: 'eSdPct',     label: 'Earth Spell Damage %' },
    { key: 'tSdPct',     label: 'Thunder Spell Damage %' },
    { key: 'wSdPct',     label: 'Water Spell Damage %' },
    { key: 'fSdPct',     label: 'Fire Spell Damage %' },
    { key: 'aSdPct',     label: 'Air Spell Damage %' },
    { key: 'eSdRaw',     label: 'Earth Spell Damage Raw' },
    { key: 'tSdRaw',     label: 'Thunder Spell Damage Raw' },
    { key: 'wSdRaw',     label: 'Water Spell Damage Raw' },
    { key: 'fSdRaw',     label: 'Fire Spell Damage Raw' },
    { key: 'aSdRaw',     label: 'Air Spell Damage Raw' },
    // ── Elemental Melee Damage ──────────────────────────────────────────
    { key: 'eMdPct',     label: 'Earth Melee Damage %' },
    { key: 'tMdPct',     label: 'Thunder Melee Damage %' },
    { key: 'wMdPct',     label: 'Water Melee Damage %' },
    { key: 'fMdPct',     label: 'Fire Melee Damage %' },
    { key: 'aMdPct',     label: 'Air Melee Damage %' },
    { key: 'eMdRaw',     label: 'Earth Melee Damage Raw' },
    { key: 'tMdRaw',     label: 'Thunder Melee Damage Raw' },
    { key: 'wMdRaw',     label: 'Water Melee Damage Raw' },
    { key: 'fMdRaw',     label: 'Fire Melee Damage Raw' },
    { key: 'aMdRaw',     label: 'Air Melee Damage Raw' },
    // ── Rainbow Damage ──────────────────────────────────────────────────
    { key: 'rDamPct',    label: 'Elemental Damage %' },
    { key: 'rDamRaw',    label: 'Elemental Damage Raw' },
    { key: 'rSdRaw',     label: 'Elemental Spell Damage Raw' },
    { key: 'rSdPct',     label: 'Elemental Spell Damage %' },
    { key: 'rMdPct',     label: 'Elemental Melee Damage %' },
    { key: 'rMdRaw',     label: 'Elemental Melee Damage Raw' },
    // ── Spell Costs ─────────────────────────────────────────────────────
    { key: 'spRaw1',     label: '1st Spell Cost Raw' },
    { key: 'spRaw2',     label: '2nd Spell Cost Raw' },
    { key: 'spRaw3',     label: '3rd Spell Cost Raw' },
    { key: 'spRaw4',     label: '4th Spell Cost Raw' },
    { key: 'spPct1',     label: '1st Spell Cost %' },
    { key: 'spPct2',     label: '2nd Spell Cost %' },
    { key: 'spPct3',     label: '3rd Spell Cost %' },
    { key: 'spPct4',     label: '4th Spell Cost %' },
    // ── Movement ────────────────────────────────────────────────────────
    { key: 'spd',        label: 'Walk Speed Bonus' },
    { key: 'atkTier',    label: 'Attack Speed Bonus' },
    // ── Other Combat ────────────────────────────────────────────────────
    { key: 'poison',     label: 'Poison' },
    { key: 'thorns',     label: 'Thorns' },
    { key: 'expd',       label: 'Exploding' },
    { key: 'ref',        label: 'Reflection' },
    { key: 'spRegen',    label: 'Soul Point Regen' },
    { key: 'eSteal',     label: 'Stealing' },
    { key: 'sprint',     label: 'Sprint Bonus' },
    { key: 'sprintReg',  label: 'Sprint Regen Bonus' },
    { key: 'jh',         label: 'Jump Height' },
    { key: 'kb',         label: 'Knockback' },
];

/**
 * Returns the effective rolled value for a stat given the current roll mode.
 * @param {number} minVal
 * @param {number} maxVal
 * @returns {number}
 */
function getRolledValue(minVal, maxVal) {
    switch (current_roll_mode) {
        case ROLL_MODES.MAX:   return maxVal;
        case ROLL_MODES.PCT75: return Math.round(minVal + 0.75 * (maxVal - minVal));
        case ROLL_MODES.AVG:   return Math.round((minVal + maxVal) / 2);
        case ROLL_MODES.MIN:   return minVal;
        default:               return maxVal;
    }
}
