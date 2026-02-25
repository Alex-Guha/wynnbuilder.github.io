
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
        if (this.slot_elem)    this.slot_elem.classList.remove('slot-locked', 'slot-unlocked', 'slot-solver', 'slot-selected');

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
        // Use slot-solver styling when the solver filled this slot (not the user).
        const is_solver_filled = this.input_field.dataset.solverFilled === 'true';
        if (this.slot_elem) this.slot_elem.classList.add(is_solver_filled ? 'slot-solver' : 'slot-locked');
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
