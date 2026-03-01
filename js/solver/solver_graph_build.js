// Set by solver_search.js when filling a solver result into the UI.
// SolverSKPNode reads this to show "Assign: X (+Y)" with greedy extra SP.
// Cleared when the user manually edits items (non-solver change).
let _solver_sp_override = null;

// BuildAssembleNode is defined in shared_graph_nodes.js

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

        // When solver has filled this build, use its greedy SP allocation data.
        const ov = _solver_sp_override;
        const has_override = ov && ov.base_sp && ov.total_sp;

        for (const [i, skp] of skp_order.entries()) {
            const totalEl  = document.getElementById(skp + '-skp-total');
            const assignEl = document.getElementById(skp + '-skp-assign');
            if (has_override) {
                if (totalEl)  totalEl.textContent = ov.total_sp[i];
                const req   = build.base_skillpoints[i];
                const extra = ov.base_sp[i] - req;
                if (assignEl) assignEl.textContent = extra > 0
                    ? `Assign: ${req} (+${extra})`
                    : `Assign: ${req}`;
            } else {
                if (totalEl)  totalEl.textContent  = build.total_skillpoints[i];
                if (assignEl) assignEl.textContent = 'Assign: ' + build.base_skillpoints[i];
            }
        }

        if (summaryBox) {
            const total  = has_override ? ov.assigned_sp : build.assigned_skillpoints;
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
 * Greedy-allocated SP are obtained from the build-stats graph input (which reads
 * _solver_sp_override in SolverBuildStatExtractNode), ensuring the encode node
 * always uses the same SP values as the stats display pipeline.
 *
 * Signature: SolverBuildEncodeNode(build, build-stats, atree, atree-state, aspects,
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

        // Read SP from the build-stats pipeline (SolverBuildStatExtractNode),
        // which already applies _solver_sp_override when greedy SP were allocated.
        // This keeps encoding in sync with the displayed stats — no separate
        // global variable read needed here.
        const build_stats = input_map.get('build-stats');
        const skillpoints = build_stats
            ? skp_order.map(name => build_stats.get(name))
            : build.total_skillpoints.slice();

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
