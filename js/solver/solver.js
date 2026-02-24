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
        list.style.top      = position.bottom + window.scrollY + "px";
        list.style.left     = position.x + "px";
        list.style.width    = position.width + "px";
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
    console.log("[solver] add_item_autocomplete:", item_type, "category:", category, "has list:", itemLists.has(category));
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
    console.log("[solver]   →", item_arr.length, "items for", item_type);
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
}

// ── Roll mode selection ───────────────────────────────────────────────────────

/**
 * Sets the active roll mode and syncs the dropdown UI.
 */
function setRollMode(mode) {
    current_roll_mode = mode;
    const sel = document.getElementById('roll-mode-select');
    if (sel) sel.value = mode;

    // Re-evaluate all item nodes so Build picks up the new rolled values.
    if (typeof solver_equip_input_nodes !== 'undefined') {
        for (const node of solver_equip_input_nodes) {
            node.mark_dirty().update();
        }
    }
}

// ── Exclusive panel toggle (Tomes / Ability Tree / Aspects) ──────────────────

const SOLVER_PANELS = ["tomes-dropdown", "atree-dropdown", "aspects-dropdown"];
const SOLVER_PANEL_BTNS = {
    "tomes-dropdown":   "toggle-tomes",
    "atree-dropdown":   "toggle-atree",
    "aspects-dropdown": "toggle-aspects",
};

/**
 * Shows the given panel and hides the others. Clicking the same panel's button
 * a second time collapses it (toggle behaviour).
 */
function showExclusivePanel(panelId) {
    const panel = document.getElementById(panelId);
    const isVisible = panel && panel.style.display !== "none";

    // Collapse all panels and deactivate all buttons
    for (const p of SOLVER_PANELS) {
        const el = document.getElementById(p);
        if (el) el.style.display = "none";
        const btn = document.getElementById(SOLVER_PANEL_BTNS[p]);
        if (btn) btn.classList.remove("toggleOn");
    }

    // Open requested panel (unless it was already open — toggle off)
    if (!isVisible) {
        if (panel) panel.style.display = "";
        const btn = document.getElementById(SOLVER_PANEL_BTNS[panelId]);
        if (btn) btn.classList.add("toggleOn");
    }
}

// ── Tooltip toggle ────────────────────────────────────────────────────────────

/**
 * Toggles the visibility of an item tooltip div.
 * Called when the user clicks on an equipment slot row.
 */
function toggleItemTooltip(tooltip_id) {
    const el = document.getElementById(tooltip_id);
    if (!el) return;
    // Only show if it has content (empty after slot cleared)
    if (!el.innerHTML) return;
    // Use 'flex' to preserve Bootstrap row layout inside the tooltip (col children need a flex parent).
    const was_visible = el.style.display !== 'none' && el.style.display !== '';
    el.style.display = was_visible ? 'none' : 'flex';
    // Persist the slot highlight while the tooltip is visible.
    const eq = tooltip_id.replace('-tooltip', '');
    const dropdown = document.getElementById(eq + '-dropdown');
    if (dropdown) {
        dropdown.classList.toggle('slot-selected', !was_visible);
    }
}

// ── Restrictions ──────────────────────────────────────────────────────────────

/**
 * Toggles a build-direction SP type on/off.
 * When off, items requiring that SP type will be excluded by the Phase 6 solver.
 */
function toggle_build_dir(sp) {
    const btn = document.getElementById('dir-' + sp);
    if (btn) btn.classList.toggle('toggleOn');
    _schedule_restrictions_url_update();
}

/**
 * Toggles the No-Major-ID filter button and schedules a URL update.
 */
function toggle_no_major_id() {
    const btn = document.getElementById('restr-no-major-id');
    if (btn) btn.classList.toggle('toggleOn');
    _schedule_restrictions_url_update();
}

let _restriction_row_counter = 0;

/**
 * Appends a new stat threshold row to the restrictions panel.
 */
function restriction_add_row() {
    const container = document.getElementById('restriction-rows');
    if (!container) return null;
    const idx = ++_restriction_row_counter;
    const row = document.createElement('div');
    row.id = 'restr-row-' + idx;
    row.className = 'combo-row d-flex align-items-center gap-1';
    row.innerHTML = `
        <button class="btn btn-sm btn-outline-secondary px-1"
                style="min-width:1.6em; font-size:0.8em; flex-shrink:0;"
                onclick="restriction_remove_row(this)" title="Remove restriction">×</button>
        <input class="combo-row-input flex-grow-1 restr-stat-input"
               id="restr-stat-${idx}"
               placeholder="Stat..." autocomplete="off" style="min-width:0;">
        <select class="solver-select form-select form-select-sm"
                style="width:3.5em; flex-shrink:0; padding-left:0.3rem; padding-right:1.25rem;">
            <option value="ge">≥</option>
            <option value="le">≤</option>
        </select>
        <input type="number" class="combo-row-input"
               placeholder="0" style="width:4.5em; text-align:center; flex-shrink:0;">
    `;
    container.appendChild(row);
    _init_restriction_stat_autocomplete('restr-stat-' + idx);
    // Wire all inputs for URL persistence
    for (const inp of row.querySelectorAll('input, select')) {
        inp.addEventListener('change', _schedule_restrictions_url_update);
        inp.addEventListener('input',  _schedule_restrictions_url_update);
    }
    return row;
}

/**
 * Removes a restriction row when the × button is clicked.
 */
function restriction_remove_row(btn) {
    const row = btn.closest('[id^="restr-row-"]');
    if (row) row.remove();
    _schedule_restrictions_url_update();
}

/**
 * Sets up autoComplete.js on a stat restriction input field.
 * Searches by display label; stores the matching stat key in dataset.statKey.
 */
function _init_restriction_stat_autocomplete(input_id) {
    new autoComplete({
        data: { src: RESTRICTION_STATS.map(s => s.label) },
        selector: '#' + input_id,
        wrapper: false,
        resultsList: {
            maxResults: 60,
            tabSelect: true,
            noResults: true,
            class: 'search-box dark-7 rounded-bottom px-2 fw-bold dark-shadow-sm',
            element: (list, data) => {
                const inp = document.getElementById(input_id);
                if (!inp) return;
                const rect = inp.getBoundingClientRect();
                list.style.top   = (rect.bottom + window.scrollY) + 'px';
                list.style.left  = rect.x + 'px';
                list.style.width = Math.max(rect.width, 200) + 'px';
                if (!data.results.length) {
                    const msg = document.createElement('li');
                    msg.classList.add('scaled-font');
                    msg.textContent = 'No results found!';
                    list.prepend(msg);
                }
            },
        },
        resultItem: {
            class: 'scaled-font search-item',
            selected: 'dark-5',
        },
        events: {
            input: {
                selection: (event) => {
                    const val = event.detail.selection.value;
                    if (val) {
                        event.target.value = val;
                        const stat = RESTRICTION_STATS.find(s => s.label === val);
                        if (stat) event.target.dataset.statKey = stat.key;
                    }
                    event.target.dispatchEvent(new Event('change'));
                },
            },
        },
    });
}

/**
 * Returns the current restriction state as a plain object.
 * Called by the Phase 6 solver core when initiating a search.
 *
 * @returns {{
 *   build_dir: Object<string, boolean>,
 *   lvl_min: number,
 *   lvl_max: number,
 *   no_major_id: boolean,
 *   guild_tome: number,   // 0 = off, 1 = standard (+4 SP), 2 = rare (+5 SP)
 *   stat_thresholds: Array<{stat: string, op: string, value: number}>
 * }}
 */
function get_restrictions() {
    const build_dir = {};
    for (const sp of ['str', 'dex', 'int', 'def', 'agi']) {
        const btn = document.getElementById('dir-' + sp);
        build_dir[sp] = btn ? btn.classList.contains('toggleOn') : true;
    }

    const lvl_min    = parseInt(document.getElementById('restr-lvl-min')?.value) || 1;
    const lvl_max    = parseInt(document.getElementById('restr-lvl-max')?.value) || 106;
    const no_major_id = document.getElementById('restr-no-major-id')?.classList.contains('toggleOn') ?? false;
    const guild_tome  = parseInt(document.getElementById('restr-guild-tome')?.value) || 0;

    const stat_thresholds = [];
    for (const row of (document.getElementById('restriction-rows')?.children ?? [])) {
        if (!row.id?.startsWith('restr-row-')) continue;
        const stat_input = row.querySelector('.restr-stat-input');
        const op_select  = row.querySelector('select');
        const val_input  = row.querySelector('input[type="number"]');
        if (!stat_input || !op_select || !val_input) continue;
        const stat_key   = stat_input.dataset?.statKey || null;
        const stat_label = stat_input.value.trim();
        const value      = parseFloat(val_input.value);
        if ((!stat_key && !stat_label) || isNaN(value)) continue;
        stat_thresholds.push({
            stat:  stat_key || stat_label,
            op:    op_select.value,   // 'ge' (≥) or 'le' (≤)
            value,
        });
    }

    return { build_dir, lvl_min, lvl_max, no_major_id, guild_tome, stat_thresholds };
}

// ── Restrictions URL persistence ──────────────────────────────────────────────

let _restrictions_url_timer = null;

/** Debounced: schedules a restriction URL update 300 ms from now. */
function _schedule_restrictions_url_update() {
    clearTimeout(_restrictions_url_timer);
    _restrictions_url_timer = setTimeout(_do_restrictions_url_update, 300);
}

/**
 * Encodes the current restriction panel state into URL query params and calls
 * replaceState so the browser URL reflects the full solver configuration.
 *
 * Encoding:
 *   dir    = comma-separated disabled SP types  (omitted when all enabled)
 *   lvlmin = min item level                     (omitted when 1 / empty)
 *   lvlmax = max item level                     (omitted when 106 / empty)
 *   nomaj  = '1' when No-Major-ID is active     (omitted otherwise)
 *   gtome  = '1' or '2'                         (omitted when Off / 0)
 *   restr  = pipe-separated key:op:value rows   (omitted when none)
 */
function _do_restrictions_url_update() {
    const url = new URL(window.location.href);

    // Build direction — store only disabled types
    const disabled_dirs = [];
    for (const sp of ['str', 'dex', 'int', 'def', 'agi']) {
        const btn = document.getElementById('dir-' + sp);
        if (btn && !btn.classList.contains('toggleOn')) disabled_dirs.push(sp);
    }
    if (disabled_dirs.length > 0) {
        url.searchParams.set('dir', disabled_dirs.join(','));
    } else {
        url.searchParams.delete('dir');
    }

    // Level range
    const lvl_min_raw = document.getElementById('restr-lvl-min')?.value?.trim() ?? '';
    const lvl_max_raw = document.getElementById('restr-lvl-max')?.value?.trim() ?? '';
    if (lvl_min_raw && lvl_min_raw !== '1') {
        url.searchParams.set('lvlmin', lvl_min_raw);
    } else {
        url.searchParams.delete('lvlmin');
    }
    if (lvl_max_raw && lvl_max_raw !== '106') {
        url.searchParams.set('lvlmax', lvl_max_raw);
    } else {
        url.searchParams.delete('lvlmax');
    }

    // No Major ID toggle
    const no_maj = document.getElementById('restr-no-major-id')?.classList.contains('toggleOn') ?? false;
    if (no_maj) {
        url.searchParams.set('nomaj', '1');
    } else {
        url.searchParams.delete('nomaj');
    }

    // Guild tome
    const gtome_val = document.getElementById('restr-guild-tome')?.value ?? '0';
    if (gtome_val !== '0') {
        url.searchParams.set('gtome', gtome_val);
    } else {
        url.searchParams.delete('gtome');
    }

    // Stat threshold rows
    const entries = [];
    for (const row of (document.getElementById('restriction-rows')?.children ?? [])) {
        if (!row.id?.startsWith('restr-row-')) continue;
        const stat_input = row.querySelector('.restr-stat-input');
        const op_select  = row.querySelector('select');
        const val_input  = row.querySelector('input[type="number"]');
        if (!stat_input || !op_select || !val_input) continue;
        const stat_key = stat_input.dataset?.statKey;
        const value    = val_input.value.trim();
        if (!stat_key || !value) continue;
        entries.push(stat_key + ':' + op_select.value + ':' + value);
    }
    if (entries.length > 0) {
        url.searchParams.set('restr', entries.join('|'));
    } else {
        url.searchParams.delete('restr');
    }

    window.history.replaceState(null, '', url.toString());
}

// ── Reset ─────────────────────────────────────────────────────────────────────

/**
 * Clears all solver inputs back to defaults and triggers a graph update.
 */
function resetSolverFields() {
    for (const i of equipment_inputs) setValue(i, "");
    for (const i of powder_inputs) setValue(i, "");
    for (const i of tomeInputs) setValue(i, "");
    for (const i of aspectInputs) setValue(i, "");
    for (const i of aspectTierInputs) setValue(i, "");

    // Reset boost buttons
    for (const [key] of damageMultipliers) {
        const btn = document.getElementById(key + "-boost");
        if (btn) btn.classList.remove("toggleOn");
    }

    // Reset Allow Downtime toggle
    const downtime_btn = document.getElementById('combo-downtime-btn');
    if (downtime_btn) downtime_btn.classList.remove('toggleOn');

    setValue("level-choice", "106");
    setRollMode(ROLL_MODES.MAX);

    // Re-propagate graph to clear displays
    if (solver_equip_input_nodes.length) {
        for (const node of solver_equip_input_nodes) {
            node.mark_dirty().update();
        }
    }
    if (typeof solver_boosts_node !== 'undefined') {
        solver_boosts_node.mark_dirty().update();
    }

    // Reset restriction panel to defaults
    for (const sp of ['str', 'dex', 'int', 'def', 'agi']) {
        const btn = document.getElementById('dir-' + sp);
        if (btn) btn.classList.add('toggleOn');
    }
    const lvl_min_inp = document.getElementById('restr-lvl-min');
    if (lvl_min_inp) lvl_min_inp.value = '';
    const lvl_max_inp = document.getElementById('restr-lvl-max');
    if (lvl_max_inp) lvl_max_inp.value = '106';
    const no_maj_btn = document.getElementById('restr-no-major-id');
    if (no_maj_btn) no_maj_btn.classList.remove('toggleOn');
    const guild_sel = document.getElementById('restr-guild-tome');
    if (guild_sel) guild_sel.value = '0';
    const restr_container = document.getElementById('restriction-rows');
    if (restr_container) restr_container.innerHTML = '';

    // Flush restriction URL params immediately (synchronous, no debounce)
    _do_restrictions_url_update();

    location.hash = "";
}

// ── Initialisation ────────────────────────────────────────────────────────────

async function init() {
    console.log("solver.js init");

    // decodeHash() loads all game data (items, tomes, aspects, atree, encoding constants)
    // and, when a URL hash is present, populates all input fields from the encoded build.
    try {
        await decodeHash();
    } catch (e) {
        console.error("[solver] decodeHash failed:", e);
        return;
    }
    console.log("[solver] data loaded — itemMap:", itemMap?.size);

    // Restore roll mode and combo from URL query params (solver-specific; not in the binary hash).
    const urlParams = new URLSearchParams(window.location.search);
    const urlRoll = urlParams.get('roll');
    if (urlRoll && Object.values(ROLL_MODES).includes(urlRoll)) {
        current_roll_mode = urlRoll;
        const sel = document.getElementById('roll-mode-select');
        if (sel) sel.value = urlRoll;
    }

    // ── Restore restriction panel state from URL params ───────────────────────

    // Build direction: re-disable any SP types listed in 'dir'
    const urlDir = urlParams.get('dir');
    if (urlDir) {
        for (const sp of urlDir.split(',')) {
            const btn = document.getElementById('dir-' + sp.trim());
            if (btn) btn.classList.remove('toggleOn');
        }
    }

    // Level range
    const urlLvlMin = urlParams.get('lvlmin');
    if (urlLvlMin) {
        const inp = document.getElementById('restr-lvl-min');
        if (inp) inp.value = urlLvlMin;
    }
    const urlLvlMax = urlParams.get('lvlmax');
    if (urlLvlMax) {
        const inp = document.getElementById('restr-lvl-max');
        if (inp) inp.value = urlLvlMax;
    }

    // No Major ID
    if (urlParams.get('nomaj') === '1') {
        const btn = document.getElementById('restr-no-major-id');
        if (btn) btn.classList.add('toggleOn');
    }

    // Guild tome
    const urlGtome = urlParams.get('gtome');
    if (urlGtome) {
        const sel = document.getElementById('restr-guild-tome');
        if (sel) sel.value = urlGtome;
    }

    // Stat threshold rows
    const urlRestr = urlParams.get('restr');
    if (urlRestr) {
        for (const entry of urlRestr.split('|')) {
            const parts = entry.split(':');
            if (parts.length < 3) continue;
            const stat_key = parts[0];
            const op       = parts[1];
            const value    = parts.slice(2).join(':');
            const stat_obj = RESTRICTION_STATS.find(s => s.key === stat_key);
            if (!stat_obj) continue;
            const row = restriction_add_row();
            if (!row) continue;
            const stat_input = row.querySelector('.restr-stat-input');
            const op_select  = row.querySelector('select');
            const val_input  = row.querySelector('input[type="number"]');
            if (stat_input) {
                stat_input.value = stat_obj.label;
                stat_input.dataset.statKey = stat_key;
            }
            if (op_select && (op === 'ge' || op === 'le')) op_select.value = op;
            if (val_input) val_input.value = value;
        }
    }

    // Wire static restriction inputs so URL stays in sync as user edits them
    const restr_lvl_min = document.getElementById('restr-lvl-min');
    if (restr_lvl_min) restr_lvl_min.addEventListener('input', _schedule_restrictions_url_update);
    const restr_lvl_max = document.getElementById('restr-lvl-max');
    if (restr_lvl_max) restr_lvl_max.addEventListener('input', _schedule_restrictions_url_update);
    const restr_guild_tome = document.getElementById('restr-guild-tome');
    if (restr_guild_tome) restr_guild_tome.addEventListener('change', _schedule_restrictions_url_update);

    // Wire tooltip click listeners on each equipment slot row
    for (const eq of equipment_keys) {
        const dropdown = document.getElementById(eq + '-dropdown');
        if (dropdown) {
            dropdown.addEventListener('click', () => toggleItemTooltip(eq + '-tooltip'));
        }
    }

    try {
        console.log("[solver] calling init_autocomplete...");
        init_autocomplete();
        console.log("[solver] init_autocomplete done");
    } catch (e) {
        console.error("[solver] init_autocomplete failed:", e, e.stack);
    }

    console.log("[solver] calling solver_graph_init...");
    solver_graph_init();
    console.log("[solver] solver_graph_init done");

    // Restore ability tree from URL hash (mirrors builder_graph.js post-decode logic).
    // atree_data is set by decodeHash(); atree_node.value is set once the weapon populates
    // the class, which happens synchronously during solver_graph_init()'s update() cascade.
    if (atree_data !== null && atree_node.value !== null) {
        if (atree_data.length > 0) {
            try {
                const active_nodes = decodeAtree(atree_node.value, atree_data);
                const state = atree_state_node.value;
                for (const node of active_nodes) {
                    atree_set_state(state.get(node.ability.id), true);
                }
                atree_state_node.mark_dirty().update();
            } catch (e) {
                console.error("[solver] Failed to decode atree:", e);
            }
        }
    }

    // Restore combo time field from URL (must be before combo node update so mana display is correct).
    const urlCtime = urlParams.get('ctime');
    if (urlCtime) {
        const time_inp = document.getElementById('combo-time');
        if (time_inp) time_inp.value = urlCtime;
    }

    // Restore Allow Downtime toggle.
    if (urlParams.get('dtime') === '1') {
        const btn = document.getElementById('combo-downtime-btn');
        if (btn) btn.classList.add('toggleOn');
    }

    // Restore combo rows from URL query param (async: may be compressed).
    const urlCombo = urlParams.get('combo');
    if (urlCombo && typeof combo_decode_from_url !== 'undefined' && solver_combo_total_node) {
        try {
            const text = await combo_decode_from_url(urlCombo);
            const data = combo_text_to_data(text);
            if (data.length > 0) {
                solver_combo_total_node._write_rows_from_data(data);
                solver_combo_total_node.mark_dirty().update();
            }
        } catch(e) { console.warn('[solver] combo URL restore failed:', e); }
    }
}

window.onerror = function(message, source, lineno, colno, error) {
    const errBox = document.getElementById('err-box');
    const stackBox = document.getElementById('stack-box');
    if (errBox)   errBox.textContent   = message;
    if (stackBox) stackBox.textContent = error ? error.stack : "";
};

// Entry point — runs after all loaders complete
window.addEventListener('load', init);
