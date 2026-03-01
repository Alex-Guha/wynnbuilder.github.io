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

// ── Clipboard export / import ─────────────────────────────────────────────────

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
