/**
 * Selecting an object by tracing its edge — intelligent scissors
 * (Mortensen & Barrett's "livewire"), plus a colour fill for flat objects.
 *
 * Every pixel gets a cost: low on an edge (a strong gradient of the
 * brightness), high on flat colour. Clicking a point runs Dijkstra from
 * it once, which yields the cheapest path to *every* pixel (a tree of
 * predecessors); the wire to the cursor is then just a walk back along
 * that tree, so it follows the mouse in real time, and the next click
 * freezes it. Adding or dragging a point recomputes only the one or two
 * segments it touches. A clicked point snaps to the strongest edge within
 * a few pixels, so it need not be placed exactly.
 *
 * The algorithm (costMap, shortestPaths, pathTo, snap, floodFill) has no
 * DOM and is tested in Node; setupSelection() is the editor's controller.
 */

// ---- the algorithm ---------------------------------------------------------------

/** Per-pixel cost, 1 (a strong edge) … 256 (flat), from the Sobel gradient of the brightness. */
export function costMap(rgba, w, h) {
    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < rgba.length; i += 4, p++) gray[p] = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114;
    return costFromGray(gray, w, h);
}

/** The same cost map from a brightness picture (0–255), as the tracker has frames. */
export function costFromGray(gray, w, h) {
    const mag = new Float32Array(w * h);
    let max = 1e-6;
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const p = y * w + x;
            const gx = (gray[p - w + 1] + 2 * gray[p + 1] + gray[p + w + 1]) - (gray[p - w - 1] + 2 * gray[p - 1] + gray[p + w - 1]);
            const gy = (gray[p + w - 1] + 2 * gray[p + w] + gray[p + w + 1]) - (gray[p - w - 1] + 2 * gray[p - w] + gray[p - w + 1]);
            const m = Math.sqrt(gx * gx + gy * gy);
            mag[p] = m;
            if (m > max) max = m;
        }
    }
    // Normalise by the 98th percentile — so one very strong edge does not make every other edge
    // look flat — but never below 30% of the strongest, so noise in flat areas stays expensive.
    const hist = new Uint32Array(256);
    for (let p = 0; p < mag.length; p++) hist[Math.min(255, (mag[p] / max * 255) | 0)]++;
    let acc = 0, cut = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= 0.98 * w * h) { cut = i; break; } }
    const scale = max * Math.max(cut, 77) / 255;
    const cost = new Uint16Array(w * h);
    for (let p = 0; p < mag.length; p++) cost[p] = 1 + Math.round(255 * (1 - Math.min(1, mag[p] / scale)));
    return cost;
}

/**
 * Dijkstra from `seed` over the 8-connected grid: the cheapest path to every pixel,
 * as predecessors. A binary heap on typed arrays; ~20–40 ms for 480 × 360.
 * @returns {{ prev: Int32Array, dist: Float64Array, seed: number }}
 */
export function shortestPaths(cost, w, h, seed) {
    const n = w * h;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    let heapNodes = new Int32Array(n * 2);
    let heapKeys = new Float64Array(n * 2);
    let size = 0;
    const push = (node, key) => {
        if (size === heapNodes.length) {                                  // lazy deletion can outgrow 2n: grow
            const bn = new Int32Array(size * 2); bn.set(heapNodes); heapNodes = bn;
            const bk = new Float64Array(size * 2); bk.set(heapKeys); heapKeys = bk;
        }
        let i = size++;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (heapKeys[parent] <= key) break;
            heapNodes[i] = heapNodes[parent]; heapKeys[i] = heapKeys[parent];
            i = parent;
        }
        heapNodes[i] = node; heapKeys[i] = key;
    };
    const pop = () => {
        const node = heapNodes[0];
        const lastNode = heapNodes[--size], lastKey = heapKeys[size];
        let i = 0;
        for (;;) {
            let child = 2 * i + 1;
            if (child >= size) break;
            if (child + 1 < size && heapKeys[child + 1] < heapKeys[child]) child++;
            if (heapKeys[child] >= lastKey) break;
            heapNodes[i] = heapNodes[child]; heapKeys[i] = heapKeys[child];
            i = child;
        }
        if (size > 0) { heapNodes[i] = lastNode; heapKeys[i] = lastKey; }
        return node;
    };
    dist[seed] = 0;
    push(seed, 0);
    while (size > 0) {
        const p = pop();
        if (done[p]) continue;
        done[p] = 1;
        const d = dist[p];
        const x = p % w, y = (p - x) / w;
        for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const nx = x + dx;
                if (nx < 0 || nx >= w) continue;
                const q = ny * w + nx;
                if (done[q]) continue;
                const nd = d + cost[q] * (dx && dy ? 1.4142135 : 1);
                if (nd < dist[q]) { dist[q] = nd; prev[q] = p; push(q, nd); }
            }
        }
    }
    return { prev, dist, seed };
}

/** The pixels from the tree's seed to `to`, seed first; null if unreachable. */
export function pathTo(tree, to) {
    const out = [];
    for (let p = to; p !== -1; p = tree.prev[p]) {
        out.push(p);
        if (p === tree.seed) { out.reverse(); return Int32Array.from(out); }
        if (out.length > tree.prev.length) break;
    }
    return null;
}

/** The strongest edge within `radius` of (x, y) — the nearest one when equal. */
export function snap(cost, w, h, x, y, radius = 6) {
    let best = [Math.round(x), Math.round(y)], bestCost = Infinity, bestD = Infinity;
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            const nx = Math.round(x) + dx, ny = Math.round(y) + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const d = dx * dx + dy * dy;
            if (d > radius * radius) continue;
            const c = cost[ny * w + nx];
            if (c < bestCost || (c === bestCost && d < bestD)) { bestCost = c; bestD = d; best = [nx, ny]; }
        }
    }
    return best;
}

/**
 * A magic wand that knows several colours: every pixel within `tolerance`
 * (0–1) of any of `colours` counts, and the fill grows from every seed
 * through such pixels — so a striped shirt is two clicks. `colours` is the
 * seeds' own colours unless given. With `contiguous` off, every matching
 * pixel anywhere is taken.
 */
export function floodFill(rgba, w, h, seeds, tolerance = 0.15, { colours = null, contiguous = true } = {}) {
    const mask = new Uint8Array(w * h);
    const at = ([x, y]) => Math.round(y) * w + Math.round(x);
    const set = colours ?? seeds.map((s) => { const i = at(s) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2]]; });
    const limit = (tolerance * 255) ** 2 * 3;
    const matches = (q) => {
        const i = q * 4;
        for (const [r, g, b] of set) if ((rgba[i] - r) ** 2 + (rgba[i + 1] - g) ** 2 + (rgba[i + 2] - b) ** 2 <= limit) return true;
        return false;
    };
    if (!contiguous) {
        for (let q = 0; q < w * h; q++) if (matches(q)) mask[q] = 1;
        return mask;
    }
    const stack = [];
    for (const s of seeds) { const p = at(s); if (!mask[p] && matches(p)) { mask[p] = 1; stack.push(p); } }
    while (stack.length) {
        const p = stack.pop();
        const px = p % w, py = (p - px) / w;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const q = ny * w + nx;
            if (!mask[q] && matches(q)) { mask[q] = 1; stack.push(q); }
        }
    }
    return mask;
}

/**
 * Path cooling (Mortensen & Barrett): as the cursor moves on, the start of
 * the live wire rarely changes; once a stretch has stayed the same for
 * `ms` and `moves` pointer moves, it is frozen as if clicked — the user
 * only steers. Never within `margin` pixels of the cursor, and only once
 * `min` pixels are stable.
 *
 * `previous` is what this returned last time (or null); `path` is the
 * current live wire from the last point. Returns the record to keep and
 * `freeze`: the index on the path to freeze up to, or -1.
 */
export function coolPath(previous, path, now, { ms = 600, moves = 12, margin = 40, min = 25 } = {}) {
    const n = path.length;
    const first = new Float64Array(n);              // when each pixel joined the (stable part of the) wire
    const count = new Uint32Array(n);               // over how many pointer moves it has stayed
    let k = 0;
    if (previous) {
        const m = Math.min(previous.path.length, n);
        while (k < m && previous.path[k] === path[k]) k++;
    }
    for (let i = 0; i < n; i++) {
        if (i < k) { first[i] = previous.first[i]; count[i] = previous.count[i] + 1; } else { first[i] = now; count[i] = 1; }
    }
    let freeze = -1;
    for (let i = min; i < n - margin; i++) {         // first[] grows along the path, so stop at the first pixel too young
        if (now - first[i] >= ms && count[i] >= moves) freeze = i;
        else break;
    }
    return { record: { path, first, count }, freeze };
}

/** How different two pixels' colours are, 0…1. */
const colourDiff = (rgba, p, q) => {
    const a = p * 4, b = q * 4;
    return Math.hypot(rgba[a] - rgba[b], rgba[a + 1] - rgba[b + 1], rgba[a + 2] - rgba[b + 2]) / 441.7;
};

/**
 * The refine brush: strokes painted as "inside" or "outside" adjust a
 * selection, and the edge settles where the picture's own edge is.
 *
 * Only a band round the stroke (`reach` pixels) is reconsidered. Its pixels
 * go to whichever side reaches them more easily: the stroke (its side), or
 * the band's rim (keeping what the selection was there). Stepping between
 * neighbours costs more the more their colours differ, so each side spreads
 * through even colour and stops at edges — the new boundary lands on the
 * nearest real edge, and nothing outside the band moves. With an empty
 * selection, inside strokes make one from scratch.
 *
 * @param {Uint8ClampedArray} rgba the picture   @param {Uint8Array} mask the selection (1 in)
 * @param {Uint8Array} stroke the painted pixels  @param {boolean} inside what the stroke says they are
 * @returns {Uint8Array} the new selection
 */
export function refineMask(rgba, w, h, mask, stroke, inside, reach = 16) {
    // the band: the stroke grown by `reach` (a square grow, separable)
    const grow = (src, r) => {
        const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            let last = -Infinity;
            for (let x = 0; x < w; x++) { if (src[y * w + x]) last = x; if (x - last <= r) tmp[y * w + x] = 1; }
            last = Infinity;
            for (let x = w - 1; x >= 0; x--) { if (src[y * w + x]) last = x; if (last - x <= r) tmp[y * w + x] = 1; }
        }
        for (let x = 0; x < w; x++) {
            let last = -Infinity;
            for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 1; }
            last = Infinity;
            for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 1; }
        }
        return out;
    };
    // Nothing selected yet and an inside stroke: the whole picture is in play, its border is "outside" —
    // the stroke grows to the object's edges, like a wand that respects edges.
    const fresh = inside && !mask.some(Boolean);
    const band = fresh ? new Uint8Array(w * h).fill(1) : grow(stroke, reach);
    const n = w * h;
    const dist = new Float64Array(n).fill(Infinity);
    const label = new Int8Array(n).fill(-1);
    const heapN = [], heapK = [];
    const push = (node, key) => {
        let i = heapN.length;
        heapN.push(node); heapK.push(key);
        while (i > 0) { const p = (i - 1) >> 1; if (heapK[p] <= key) break; heapN[i] = heapN[p]; heapK[i] = heapK[p]; i = p; }
        heapN[i] = node; heapK[i] = key;
    };
    const pop = () => {
        const top = heapN[0], lastN = heapN.pop(), lastK = heapK.pop();
        if (heapN.length) {
            let i = 0;
            for (;;) {
                let c = 2 * i + 1;
                if (c >= heapN.length) break;
                if (c + 1 < heapN.length && heapK[c + 1] < heapK[c]) c++;
                if (heapK[c] >= lastK) break;
                heapN[i] = heapN[c]; heapK[i] = heapK[c]; i = c;
            }
            heapN[i] = lastN; heapK[i] = lastK;
        }
        return top;
    };
    const seed = (i, side, start = 0) => { dist[i] = start; label[i] = side; push(i, start); };
    const step = fresh ? 0.005 : 0.1;                 // across the whole picture, how far the border is must not matter
    const rimStart = fresh ? 0 : 2;                               // the old selection has a little less say than the user's stroke
    for (let i = 0; i < n; i++) {
        if (!band[i]) continue;
        if (stroke[i]) { seed(i, inside ? 1 : 0); continue; }
        const x = i % w, y = (i - x) / w;
        // the rim: a band pixel next to one outside the band keeps its old side
        const rim = fresh ? x === 0 || y === 0 || x === w - 1 || y === h - 1
            : (x > 0 && !band[i - 1]) || (x < w - 1 && !band[i + 1]) || (y > 0 && !band[i - w]) || (y < h - 1 && !band[i + w]);
        if (rim) seed(i, mask[i] ? 1 : 0, rimStart);
    }
    while (heapN.length) {
        const p = pop();
        const d = dist[p];
        const px = p % w, py = (p - px) / w;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const qx = px + dx, qy = py + dy;
            if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
            const q = qy * w + qx;
            if (!band[q]) continue;
            // the step's edge strength, also measured across three pixels so a soft (antialiased) edge counts in full
            const pb = qx - 2 * dx >= 0 && qx - 2 * dx < w && qy - 2 * dy >= 0 && qy - 2 * dy < h ? q - 2 * (dy * w + dx) : p;
            const qf = qx + dx >= 0 && qx + dx < w && qy + dy >= 0 && qy + dy < h ? q + dy * w + dx : q;
            const diff = Math.max(colourDiff(rgba, p, q), colourDiff(rgba, pb, qf) / 1.5);
            const nd = d + step + 200 * Math.max(0, diff - 0.07);   // distance nearly free, noise-sized differences free, an edge dear
            if (nd < dist[q]) { dist[q] = nd; label[q] = label[p]; push(q, nd); }
        }
    }
    const out = mask.slice();
    for (let i = 0; i < n; i++) if (band[i] && label[i] >= 0) out[i] = label[i];
    // tidy: a pixel in the band takes the side most of its neighbours are on
    const tidy = out.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!band[i] || stroke[i]) continue;
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += out[i + dy * w + dx];
        tidy[i] = s >= 5 ? 1 : 0;
    }
    return tidy;
}

// ---- the editor's selection tool ------------------------------------------------

/**
 * @param {object} o { $, source: () => HTMLCanvasElement (the picture at preview size), overlay: HTMLCanvasElement over it, onChange }
 */
export function setupSelection({ $, source, overlay, surface = overlay, onChange }) {   // surface: takes the pointer, and may reach past the picture
    const state = { mode: 'off', points: [], segments: [], closed: false, live: null, wand: null, extra: null, preview: null, feather: 0, invert: false, tolerance: 0.15, seeds: [], colours: [], contiguous: true, cooling: true, refine: { inside: true, size: 0.04 } };
    let painting = null;             // the refine brush's stroke: { mask, canvas }
    let aiClick = null;              // (x, y, negative) → the AI tool, when its mode is on
    let aiKey = null;                // (key) → the AI tool
    let extraDraw = null;            // (ctx) → more to draw on the overlay (the AI tool's boxes)
    let cost = null;
    let tree = null;                 // shortest paths from the last point
    let cooled = null;               // coolPath()'s record for the current live wire
    let w = 0, h = 0;
    let dragging = -1;
    let dragAt = null;
    const ctx = overlay.getContext('2d');

    function reset(width, height) {
        w = width; h = height;
        overlay.width = w; overlay.height = h;
        state.points = []; state.segments = []; state.closed = false; state.live = null; state.wand = null; state.seeds = []; state.colours = []; state.extra = null; state.preview = null;
        cost = null; tree = null;
        draw();
    }
    const pixels = () => source().getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const refreshCost = () => { cost = costMap(pixels(), w, h); };

    /** Between two points put past the picture's edge, the outline runs along the border — the shorter way round. */
    function borderPath([ax, ay], [bx, by]) {
        const P = 2 * (w - 1) + 2 * (h - 1);
        const along = (x, y) => (y === 0 ? x : x === w - 1 ? (w - 1) + y : y === h - 1 ? (w - 1) + (h - 1) + (w - 1 - x) : 2 * (w - 1) + (h - 1) + (h - 1 - y));
        const at = (s) => {
            s = ((s % P) + P) % P;
            if (s <= w - 1) return [s, 0];
            if (s <= (w - 1) + (h - 1)) return [w - 1, s - (w - 1)];
            if (s <= 2 * (w - 1) + (h - 1)) return [w - 1 - (s - (w - 1) - (h - 1)), h - 1];
            return [0, h - 1 - (s - 2 * (w - 1) - (h - 1))];
        };
        const sa = along(ax, ay), sb = along(bx, by);
        let d = ((sb - sa) % P + P) % P;
        const step = d <= P / 2 ? 1 : -1;
        if (step < 0) d = P - d;
        const out = [];
        for (let k = 0; k <= d; k++) { const [x, y] = at(sa + step * k); out.push(y * w + x); }
        return Int32Array.from(out);
    }
    const onBorder = (p) => p[2] === 'edge';
    /** The outline from point i to point j: along the border if both were put past the edge, else along the picture's edges. */
    function segmentFrom(i, j, from = null) {
        const a = state.points[i], b = state.points[j];
        if (onBorder(a) && onBorder(b)) return borderPath(a, b);
        const t = from ?? shortestPaths(cost, w, h, index(a[0], a[1]));
        return pathTo(t, index(b[0], b[1])) ?? Int32Array.of(index(b[0], b[1]));
    }
    const index = (x, y) => y * w + x;
    // a point clicked past the picture's edge stays on the edge, where it was put: no snapping inwards
    const snapped = (x, y, outside = false) => { if (!cost) refreshCost(); return outside ? [x, y] : snap(cost, w, h, x, y); };

    function addPoint(x, y, outside = false) {
        const [sx, sy] = snapped(x, y, outside);
        state.points.push(outside ? [sx, sy, 'edge'] : [sx, sy]);
        const n = state.points.length;
        if (n > 1) state.segments.push(segmentFrom(n - 2, n - 1, tree));
        tree = shortestPaths(cost, w, h, index(sx, sy));
        state.live = null;
        cooled = null;
        draw();
    }

    /** The live wire up to its `i`th pixel has cooled: it becomes a segment and a point, as if clicked. */
    function freezeAt(i) {
        const p = state.live[i];
        state.segments.push(state.live.slice(0, i + 1));
        state.points.push([p % w, (p - p % w) / w, 'auto']);
        tree = shortestPaths(cost, w, h, p);
        cooled = null;
    }

    /** The cursor is at (x, y): the live wire follows, and cools behind it. */
    function moveTo(x, y, now = performance.now(), outside = false) {
        if (!state.points.length || state.closed || !tree) return;
        const last = state.points[state.points.length - 1];
        if (outside && onBorder(last)) { state.live = borderPath(last, [x, y]); draw(); return; }   // along the border, as a click there would go
        state.live = pathTo(tree, index(...snapped(x, y, outside)));
        if (state.cooling && state.live) {
            const { record, freeze } = coolPath(cooled, state.live, now);
            cooled = record;
            if (freeze >= 0) { freezeAt(freeze); state.live = pathTo(tree, index(...snapped(x, y, outside))); }
        }
        draw();
    }
    function close() {
        if (state.points.length < 3 || state.closed) return;
        state.segments.push(segmentFrom(state.points.length - 1, 0, tree));
        state.closed = true;
        state.live = null;
        cooled = null;
        changed();
    }
    function movePoint(i, x, y, outside = false) {
        const [sx, sy] = snapped(x, y, outside);
        state.points[i] = outside ? [sx, sy, 'edge'] : [sx, sy];             // placed by hand now, whatever it was
        const n = state.points.length;
        const recompute = (from, to) => segmentFrom(from, to);               // the segment from point `from` to point `to`
        if (i > 0) state.segments[i - 1] = recompute(i - 1, i);
        else if (state.closed) state.segments[n - 1] = recompute(n - 1, 0);
        if (i < n - 1) state.segments[i] = recompute(i, i + 1);
        else if (state.closed) state.segments[n - 1] = recompute(n - 1, 0);
        tree = shortestPaths(cost, w, h, index(...state.points[n - 1]));
        cooled = null;
        changed();
    }
    function removeLast() {
        if (state.closed) { state.segments.pop(); state.closed = false; }
        else if (state.points.length) { state.points.pop(); state.segments.pop(); }
        tree = state.points.length ? shortestPaths(cost, w, h, index(...state.points[state.points.length - 1])) : null;
        state.live = null;
        cooled = null;
        changed();
    }
    /** Another click adds that pixel's colour to the set; the fill is redone from every click with every colour. */
    function wandAt(x, y) {
        const data = pixels();
        const i = (y * w + x) * 4;
        state.seeds.push([x, y]);
        state.colours.push([data[i], data[i + 1], data[i + 2]]);
        refill(data);
    }
    function refill(data = pixels()) {
        state.wand = state.seeds.length ? floodFill(data, w, h, state.seeds, state.tolerance, { colours: state.colours, contiguous: state.contiguous }) : null;
        changed();
    }
    function removeColour(i) {
        state.seeds.splice(i, 1);
        state.colours.splice(i, 1);
        refill();
    }
    /** A mask from another tool (the AI) joins the selection. */
    function addRaster(mask) {
        if (!state.extra) state.extra = mask.slice();
        else for (let i = 0; i < mask.length; i++) if (mask[i]) state.extra[i] = 1;
        changed();
    }
    /** A mask being considered, shown but not yet part of the selection. */
    function setPreview(mask) { state.preview = mask; draw(); }
    function clear() {
        state.points = []; state.segments = []; state.closed = false; state.live = null; state.wand = null; state.seeds = []; state.colours = []; state.extra = null; state.preview = null;
        tree = null;
        changed();
    }
    const hasSelection = () => state.closed || Boolean(state.wand) || Boolean(state.extra);

    /** The mask at any size: white inside, black outside, feathered and inverted as asked. */
    /**
     * `outline`: draw that closed outline (preview pixels) instead of the selection — the tracker's,
     * for this frame. `raw`: without feather and invert, for tracing the shape itself.
     */
    function maskCanvas(W, H, { outline = null, raw = false } = {}) {
        const out = document.createElement('canvas');
        out.width = W; out.height = H;
        const c = out.getContext('2d');
        c.fillStyle = '#000';
        c.fillRect(0, 0, W, H);
        const shape = document.createElement('canvas');
        shape.width = W; shape.height = H;
        const s = shape.getContext('2d');
        const sx = W / w, sy = H / h;
        if (outline) {
            const path = new Path2D();
            outline.forEach(([x, y], k) => (k ? path.lineTo((x + 0.5) * sx, (y + 0.5) * sy) : path.moveTo((x + 0.5) * sx, (y + 0.5) * sy)));
            path.closePath();
            s.fillStyle = '#fff';
            s.fill(path);
        }
        if (state.closed && !outline) {
            const path = new Path2D();
            let first = true;
            for (const segment of state.segments) {
                for (const p of segment) {
                    const x = (p % w + 0.5) * sx, y = (((p - p % w) / w) + 0.5) * sy;
                    if (first) { path.moveTo(x, y); first = false; } else path.lineTo(x, y);
                }
            }
            path.closePath();
            s.fillStyle = '#fff';
            s.fill(path);
        }
        for (const mask of outline ? [] : [state.wand, state.extra]) {
            if (!mask) continue;
            const raster = document.createElement('canvas');
            raster.width = w; raster.height = h;
            const image = raster.getContext('2d').createImageData(w, h);
            for (let i = 0; i < mask.length; i++) if (mask[i]) image.data.set([255, 255, 255, 255], i * 4);
            raster.getContext('2d').putImageData(image, 0, 0);
            s.imageSmoothingEnabled = true;
            s.drawImage(raster, 0, 0, W, H);
        }
        if (state.feather > 0 && !raw && 'filter' in c) c.filter = `blur(${state.feather * sx}px)`;
        c.drawImage(shape, 0, 0);
        c.filter = 'none';
        if (state.invert && !raw) {
            c.globalCompositeOperation = 'difference';
            c.fillStyle = '#fff';
            c.fillRect(0, 0, W, H);
            c.globalCompositeOperation = 'source-over';
        }
        return out;
    }

    function draw() {
        ctx.clearRect(0, 0, w, h);
        if (state.mode === 'off' && !hasSelection()) return;
        if (hasSelection()) {
            ctx.globalAlpha = 0.3;
            ctx.drawImage(maskCanvas(w, h), 0, 0);
            ctx.globalAlpha = 1;
        }
        if (state.preview) {                                               // what the AI proposes, in yellow
            const image = ctx.createImageData(w, h);
            for (let i = 0; i < state.preview.length; i++) if (state.preview[i]) image.data.set([255, 213, 79, 110], i * 4);
            const layer = document.createElement('canvas');
            layer.width = w; layer.height = h;
            layer.getContext('2d').putImageData(image, 0, 0);
            ctx.drawImage(layer, 0, 0);
        }
        const line = (pixels, colour, width) => {
            if (!pixels || !pixels.length) return;
            ctx.beginPath();
            pixels.forEach((p, i) => { const x = p % w + 0.5, y = (p - p % w) / w + 0.5; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
            ctx.lineWidth = width; ctx.strokeStyle = colour; ctx.stroke();
        };
        for (const segment of state.segments) { line(segment, '#000', 3); line(segment, '#fff', 1.5); }
        if (state.live) { line(state.live, '#000', 3); line(state.live, '#ffd54f', 1.5); }
        state.points.forEach(([x, y, kind], i) => {
            const auto = kind === 'auto';
            ctx.beginPath();
            if (kind === 'edge') ctx.rect(x - 3.5, y - 3.5, 8, 8);                // put past the picture's edge: a square
            else ctx.arc(x + 0.5, y + 0.5, i === 0 && state.points.length >= 3 && !state.closed ? 6 : auto ? 3 : 4, 0, Math.PI * 2);
            ctx.fillStyle = i === dragging ? '#ffd54f' : auto ? '#9ecbff' : '#fff'; ctx.fill();    // cooled points in blue
            ctx.lineWidth = 1.5; ctx.strokeStyle = '#000'; ctx.stroke();
        });
        state.seeds.forEach(([x, y], i) => {                              // where the wand was clicked, in that colour
            ctx.beginPath();
            ctx.arc(x + 0.5, y + 0.5, 5, 0, Math.PI * 2);
            ctx.fillStyle = `rgb(${state.colours[i].join(',')})`; ctx.fill();
            ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
        });
        if (painting) ctx.drawImage(painting.canvas, 0, 0);
        if (extraDraw) extraDraw(ctx);
    }

    function changed() { draw(); onChange(); }

    // ---- events ---------------------------------------------------------------------
    /** The pixel under the pointer, clamped to the picture — and whether the pointer was past its edge. */
    const at = (e) => {
        const r = overlay.getBoundingClientRect();
        const fx = (e.clientX - r.left) / r.width * w, fy = (e.clientY - r.top) / r.height * h;
        const x = Math.min(w - 1, Math.max(0, Math.round(fx))), y = Math.min(h - 1, Math.max(0, Math.round(fy)));
        return [x, y, fx < 0 || fy < 0 || fx > w - 1 || fy > h - 1];
    };
    const nearPoint = (x, y) => state.points.findIndex(([px, py]) => (px - x) ** 2 + (py - y) ** 2 <= 49);
    surface.addEventListener('pointerdown', (e) => {
        if (state.mode === 'off' || e.button !== 0) return;
        e.preventDefault();
        const [x, y, outside] = at(e);
        if (state.mode === 'refine') { startPaint(x, y); surface.setPointerCapture(e.pointerId); return; }
        if (outside && state.mode !== 'trace') return;
        if (state.mode === 'fill') { wandAt(x, y); return; }
        if (state.mode === 'ai') { if (aiClick) aiClick(x, y, e.shiftKey || e.altKey); return; }
        const hit = nearPoint(x, y);
        if (hit >= 0 && (state.closed || hit !== 0 || state.points.length < 3)) { dragging = hit; dragAt = [x, y, outside]; surface.setPointerCapture(e.pointerId); draw(); return; }
        if (hit === 0 && state.points.length >= 3 && !state.closed) { close(); return; }
        if (!state.closed) addPoint(x, y, outside);
    });
    surface.addEventListener('pointermove', (e) => {
        const [x, y, outside] = at(e);
        if (state.mode === 'refine') { if (painting) paintTo(x, y); return; }
        if (state.mode !== 'trace') return;
        if (dragging >= 0) { dragAt = [x, y, outside]; state.points[dragging] = [x, y]; draw(); return; }
        moveTo(x, y, performance.now(), outside);
    });
    surface.addEventListener('pointerup', (e) => {
        if (state.mode === 'refine' && painting) { surface.releasePointerCapture(e.pointerId); finishPaint(); return; }
        if (dragging < 0) return;
        const i = dragging;
        dragging = -1;
        surface.releasePointerCapture(e.pointerId);
        movePoint(i, dragAt[0], dragAt[1], dragAt[2]);
    });

    // ---- the refine brush: paint "inside" or "outside"; the edge settles on the picture's edges ----
    const brushRadius = () => Math.max(2, state.refine.size * h / 2);
    function stamp(x, y) {
        const r = brushRadius();
        for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
            const px = Math.round(x + dx), py = Math.round(y + dy);
            if (px >= 0 && py >= 0 && px < w && py < h && dx * dx + dy * dy <= r * r) painting.mask[py * w + px] = 1;
        }
        const g = painting.canvas.getContext('2d');
        g.fillStyle = state.refine.inside ? 'rgba(40, 200, 90, 0.55)' : 'rgba(230, 50, 50, 0.55)';
        g.beginPath(); g.arc(x + 0.5, y + 0.5, r, 0, Math.PI * 2); g.fill();
    }
    function startPaint(x, y) {
        painting = { mask: new Uint8Array(w * h), canvas: Object.assign(document.createElement('canvas'), { width: w, height: h }), last: [x, y] };
        stamp(x, y);
        draw();
    }
    function paintTo(x, y) {
        const [lx, ly] = painting.last;
        const steps = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / Math.max(1, brushRadius() / 2)));
        for (let k = 1; k <= steps; k++) stamp(lx + (x - lx) * k / steps, ly + (y - ly) * k / steps);
        painting.last = [x, y];
        draw();
    }
    function finishPaint() {
        const stroke = painting.mask;
        painting = null;
        // the selection as it is now, without feather or invert, then adjusted round the stroke
        const d = maskCanvas(w, h, { raw: true }).getContext('2d').getImageData(0, 0, w, h).data;
        const now = new Uint8Array(w * h);
        for (let i = 0; i < now.length; i++) now[i] = d[i * 4] > 127 ? 1 : 0;
        const next = refineMask(pixels(), w, h, now, stroke, state.refine.inside, Math.round(Math.max(16, brushRadius() * 4)));
        // it is a painted selection now: the traced points and the wand's colours give way to it
        state.points = []; state.segments = []; state.closed = false; state.live = null; state.wand = null; state.seeds = []; state.colours = [];
        state.extra = next.some(Boolean) ? next : null;
        tree = null;
        changed();
    }

    surface.addEventListener('dblclick', (e) => { e.preventDefault(); if (state.mode === 'trace') close(); });
    document.addEventListener('keydown', (e) => {
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
        if (state.mode === 'ai') { if (aiKey && ['Enter', 'Backspace', 'Delete', 'Escape'].includes(e.key)) { e.preventDefault(); aiKey(e.key); } return; }
        if (state.mode !== 'trace') return;
        if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); removeLast(); }
        else if (e.key === 'Enter') { e.preventDefault(); close(); }
        else if (e.key === 'Escape') { setMode('off'); }
    });

    function setMode(mode) {
        state.mode = mode;
        surface.style.pointerEvents = mode === 'off' ? 'none' : 'auto';
        surface.style.cursor = mode === 'off' ? '' : 'crosshair';
        if (mode === 'trace' && !cost) refreshCost();
        state.live = null;
        cooled = null;
        draw();
    }

    return {
        state, reset, setMode, close, clear, removeLast, wandAt, hasSelection, maskCanvas, draw, addRaster, setPreview,
        setAiHandlers(onClick, onKey, onDraw) { aiClick = onClick; aiKey = onKey; extraDraw = onDraw; },
        setFeather(px) { state.feather = px; changed(); },
        setInvert(on) { state.invert = on; changed(); },
        setTolerance(t) { state.tolerance = t; if (state.seeds.length) refill(); },
        setRefine(changes) { Object.assign(state.refine, changes); },
        /** For scripts: a refine stroke through these points (preview pixels). */
        refine(points, inside) {
            const was = state.refine.inside;
            state.refine.inside = inside;
            startPaint(...points[0]);
            for (const p of points.slice(1)) paintTo(...p);
            finishPaint();
            state.refine.inside = was;
        },
        /** For scripts: a click, possibly past the picture's edge. */
        clickAt(x, y, outside = false) { if (!cost) refreshCost(); addPoint(x, y, outside); },
        setCooling(on) { state.cooling = on; cooled = null; },
        /** For scripts: a click, and the cursor moving (with its own clock). */
        click(x, y) { if (!cost) refreshCost(); addPoint(x, y); },
        moveTo,
        setContiguous(on) { state.contiguous = on; if (state.seeds.length) refill(); },
        removeColour,
        /** The picture changed: the costs are stale (the selection stays if the size did). */
        pictureChanged() { cost = null; },
        /** For scripts: trace these points (preview pixels) and close. */
        trace(points) { refreshCost(); clear(); for (const [x, y] of points) addPoint(x, y); close(); },
    };
}
