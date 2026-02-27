/**
 * WynnSolver main page logic.
 * Handles autocomplete setup, reset, and page initialization.
 */

// ── Autocomplete helpers (adapted from builder.js) ───────────────────────────

/**
 * Returns a callback that positions the autocomplete dropdown beneath its
 * input field and appends a "No results" message when needed.
 * Expects a wrapper div with id = `{equipment_type}-dropdown`.
 */
function autocomplete_msg(equipment_type) {
    return (list, data) => {
        let position = document.getElementById(equipment_type + '-dropdown').getBoundingClientRect();
        list.style.top = position.bottom + window.scrollY + "px";
        list.style.left = position.x + "px";
        list.style.width = position.width + "px";
        list.style.maxHeight = position.height * 2 + "px";

        if (!data.results.length) {
            let message = document.createElement('li');
            message.classList.add('scaled-font');
            message.textContent = "No results found!";
            list.prepend(message);
        }
    };
}

/**
 * Creates an autoComplete.js instance for a given item/tome input field.
 * @param {string[]} data       List of valid names/aliases.
 * @param {Map}      data_map   Map of name → item/tome object (must have .tier).
 * @param {string}   item_type  Base ID used for the input field (`{item_type}-choice`).
 * @param {Function} translator Maps the selected autocomplete value to the canonical name.
 */
function create_autocomplete(data, data_map, item_type, translator) {
    return new autoComplete({
        data: { src: data },
        selector: "#" + item_type + "-choice",
        wrapper: false,
        resultsList: {
            maxResults: 1000,
            tabSelect: true,
            noResults: true,
            class: "search-box dark-7 rounded-bottom px-2 fw-bold dark-shadow-sm",
            element: autocomplete_msg(item_type),
        },
        resultItem: {
            class: "scaled-font search-item",
            selected: "dark-5",
            element: (item, data) => {
                let val = translator(data.value);
                item.classList.add(data_map.get(val).tier);
            },
        },
        events: {
            input: {
                selection: (event) => {
                    if (event.detail.selection.value) {
                        event.target.value = translator(event.detail.selection.value);
                    }
                    event.target.dispatchEvent(new Event('change'));
                },
            },
        },
    });
}

/**
 * Sets up autocomplete for a single tome input slot.
 */
function add_tome_autocomplete(tome_type) {
    let tome_arr = [];
    let tome_aliases = new Map();
    const category = tome_type.replace(/[0-9]/g, '');
    for (const tome_name of tomeLists.get(category)) {
        let tome_obj = tomeMap.get(tome_name);
        if (tome_obj["restrict"] && tome_obj["restrict"] === "DEPRECATED") continue;
        if (tome_obj["name"].includes('No ' + tome_type.charAt(0).toUpperCase())) continue;
        let tome_alias = tome_obj['alias'];
        tome_arr.push(tome_name);
        if (tome_alias && tome_alias !== "NO_ALIAS") {
            tome_arr.push(tome_alias);
            tome_aliases.set(tome_alias, tome_name);
        }
    }
    create_autocomplete(tome_arr, tomeMap, tome_type, (v) => {
        if (tome_aliases.has(v)) v = tome_aliases.get(v);
        return v;
    });
}

/**
 * Sets up autocomplete for a single equipment input slot.
 */
function add_item_autocomplete(item_type) {
    let item_arr = [];
    const category = item_type.replace(/[0-9]/g, '');
    if (item_type === 'weapon') {
        for (const weaponType of weapon_keys) {
            for (const weapon of itemLists.get(weaponType)) {
                let item_obj = itemMap.get(weapon);
                if (item_obj["restrict"] && item_obj["restrict"] === "DEPRECATED") continue;
                if (item_obj["name"] === 'No Weapon') continue;
                item_arr.push(weapon);
            }
        }
    } else {
        for (const item of itemLists.get(category)) {
            let item_obj = itemMap.get(item);
            if (item_obj["restrict"] && item_obj["restrict"] === "DEPRECATED") continue;
            if (item_obj["name"] === 'No ' + item_type.charAt(0).toUpperCase() + item_type.slice(1)) continue;
            item_arr.push(item);
        }
    }
    create_autocomplete(item_arr, itemMap, item_type, (v) => v);
}

/**
 * Initialises autocomplete for all equipment and tome slots.
 */
function init_autocomplete() {
    for (const eq of equipment_keys) {
        add_item_autocomplete(eq);
    }
    for (const eq of tome_keys) {
        add_tome_autocomplete(eq);
    }
    // Clear solver-filled flag on user-initiated changes so the slot
    // reverts to locked styling when the user manually sets an item.
    for (const eq of equipment_keys) {
        const input = document.getElementById(eq + '-choice');
        if (input) {
            input.addEventListener('change', (e) => {
                if (e.isTrusted) delete input.dataset.solverFilled;
            });
        }
    }
}
