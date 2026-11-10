/**
 * Following an object through a video or GIF.
 *
 * The user marks the object on a frame or two (keyframes, from any
 * selection tool). From each keyframe the outline is carried to the next
 * frame and the one after, forward and backward:
 *
 *   1. points spaced round the outline are found again in the next frame
 *      by matching the patch of picture around each (coarse, then fine),
 *      and points that disagree with the rest are pulled back to the
 *      group's movement;
 *   2. each moved point snaps to the strongest edge a pixel or two away;
 *   3. the outline between neighbouring points is redrawn along the
 *      cheapest edge path (the scissors' cost map), searched only in a
 *      small box round the two points, so it hugs the real edge.
 *
 * At each keyframe the tracker also learns the object's colours — inside
 * the outline against a band just outside — so every frame has a map of how
 * object-like each pixel is. The outline follows the boundary of that map
 * (plus some of the plain brightness edges), not every texture edge behind
 * the object, and the points may only stray a few pixels from the overall
 * move, scale and turn of the group, so the outline can't wander off.
 *
 * Every frame gets a confidence score — how much more object-like the
 * inside is than the band just outside, against the keyframe, and whether
 * the area jumped — and between two keyframes each frame keeps whichever
 * direction scored higher. Frames that score much lower than their keyframes are flagged
 * for the user (or the AI) to fix; a fix is a new keyframe.
 *
 * No DOM: the page supplies frames as brightness pictures (getGray).
 * test/tracker.test.js tracks a moving disc.
 */
import { costFromGray, snap } from './livewire.js';
import { simplifyLoop } from '../src/strokes.js';

// ---- the object's colours ----------------------------------------------------------
const BINS = 12;                                       // per channel: 1728 colours
/** Each pixel's colour bin, and its brightness 0–255. */
export function frameData(rgba, w, h) {
    const gray = new Uint8Array(w * h), bins = new Uint16Array(w * h);
    for (let i = 0, p = 0; p < w * h; i += 4, p++) {
        gray[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
        bins[p] = ((rgba[i] * BINS) >> 8) * BINS * BINS + ((rgba[i + 1] * BINS) >> 8) * BINS + ((rgba[i + 2] * BINS) >> 8);
    }
    return { gray, bins };
}

/** The pixels inside a closed outline (even–odd scanlines). */
export function fillPolygon(loop, w, h) {
    const mask = new Uint8Array(w * h);
    const ys = loop.map((p) => p[1]);
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
    for (let y = y0; y <= y1; y++) {
        const cy = y + 0.5, xs = [];
        for (let i = 0; i < loop.length; i++) {
            const [ax, ay] = loop[i], [bx, by] = loop[(i + 1) % loop.length];
            if ((ay <= cy) !== (by <= cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
            for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(w - 1, Math.floor(xs[k + 1] - 0.5)); x++) mask[y * w + x] = 1;
        }
    }
    return mask;
}

/** A band of pixels just outside an outline, `width` pixels deep, within the frame. */
function ring(inside, loop, w, h, width = 10) {
    const out = new Uint8Array(w * h);
    for (const [x, y] of loop) {
        for (let dy = -width; dy <= width; dy++) for (let dx = -width; dx <= width; dx++) {
            const px = Math.round(x) + dx, py = Math.round(y) + dy;
            if (px >= 0 && py >= 0 && px < w && py < h && !inside[py * w + px] && dx * dx + dy * dy <= width * width) out[py * w + px] = 1;
        }
    }
    return out;
}

/** The object's colours against its surroundings, learnt from a frame and the outline that is right on it. */
export function colourModel(bins, loop, w, h) {
    const inside = fillPolygon(loop, w, h), around = ring(inside, loop, w, h, 14);
    const fg = new Float32Array(BINS ** 3), bg = new Float32Array(BINS ** 3);
    let nf = 0, nb = 0;
    for (let i = 0; i < w * h; i++) { if (inside[i]) { fg[bins[i]]++; nf++; } else if (around[i]) { bg[bins[i]]++; nb++; } }
    const prob = new Float32Array(BINS ** 3);
    for (let b = 0; b < prob.length; b++) {
        const f = (fg[b] + 0.5) / (nf + 1), g = (bg[b] + 0.5) / (nb + 1);
        prob[b] = f / (f + g);
    }
    return { prob };
}

/** How object-like each pixel is, 0–1, by its colour. */
export function probabilityMap(bins, model, w, h) {
    const p = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) p[i] = model.prob[bins[i]];
    // a little smoothing, so single pixels of the wrong colour don't make edges
    const q = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const px = x + dx, py = y + dy;
            if (px >= 0 && py >= 0 && px < w && py < h) { s += p[py * w + px]; n++; }
        }
        q[y * w + x] = s / n;
    }
    return q;
}

/** Edges to follow: mostly where object-likeness changes, partly plain brightness edges. Lower is better, 1–256. */
export function objectCost(gray, prob, w, h) {
    const plain = costFromGray(Float32Array.from(gray), w, h);
    const cost = new Uint16Array(w * h).fill(256);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = prob[i + 1] - prob[i - 1], gy = prob[i + w] - prob[i - w];
        const object = Math.min(1, Math.hypot(gx, gy) * 2.2);
        const e = 0.75 * object + 0.25 * (256 - plain[i]) / 255;
        cost[i] = 1 + Math.round(255 * (1 - e));
    }
    return cost;
}

/** How much more object-like the inside of an outline is than the band just outside it. */
export function contrast(prob, loop, w, h) {
    const inside = fillPolygon(loop, w, h), around = ring(inside, loop, w, h, 8);
    let si = 0, ni = 0, so = 0, no = 0;
    for (let i = 0; i < w * h; i++) { if (inside[i]) { si += prob[i]; ni++; } else if (around[i]) { so += prob[i]; no++; } }
    return ni && no ? si / ni - so / no : 0;
}

/** The move, scale and turn that best take points `a` to points `b` (least squares). */
function similarity(a, b) {
    const n = a.length;
    let ax = 0, ay = 0, bx = 0, by = 0;
    for (let i = 0; i < n; i++) { ax += a[i][0]; ay += a[i][1]; bx += b[i][0]; by += b[i][1]; }
    ax /= n; ay /= n; bx /= n; by /= n;
    let sxx = 0, sxy = 0, norm = 0;
    for (let i = 0; i < n; i++) {
        const px = a[i][0] - ax, py = a[i][1] - ay, qx = b[i][0] - bx, qy = b[i][1] - by;
        sxx += px * qx + py * qy; sxy += px * qy - py * qx; norm += px * px + py * py;
    }
    const c = norm ? sxx / norm : 1, s = norm ? sxy / norm : 0;          // scale × cos, scale × sin
    return ([x, y]) => [bx + c * (x - ax) - s * (y - ay), by + s * (x - ax) + c * (y - ay)];
}

/** Brightness 0–255 of an RGBA picture. */
export function toGray(rgba, w, h) {
    const g = new Uint8Array(w * h);
    for (let i = 0, p = 0; p < w * h; i += 4, p++) g[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    return g;
}

function half(g, w, h) {
    const W = w >> 1, H = h >> 1, out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = 2 * y * w + 2 * x;
        out[y * W + x] = (g[i] + g[i + 1] + g[i + w] + g[i + w + 1]) / 4;
    }
    return { g: out, w: W, h: H };
}

/** Where the patch round (x, y) in a went to in b, searching ±search from (x, y) + guess. */
function matchPatch(a, b, w, h, x, y, r, search, gx = 0, gy = 0) {
    x = Math.round(x); y = Math.round(y);
    if (x - r < 0 || y - r < 0 || x + r >= w || y + r >= h) return { dx: gx, dy: gy, err: 255 };
    let mean = 0;
    const n = (2 * r + 1) ** 2;
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) mean += a[(y + j) * w + x + i];
    mean /= n;
    let best = Infinity, bx = gx, by = gy;
    for (let sy = -search; sy <= search; sy++) {
        for (let sx = -search; sx <= search; sx++) {
            const cx = x + Math.round(gx) + sx, cy = y + Math.round(gy) + sy;
            if (cx - r < 0 || cy - r < 0 || cx + r >= w || cy + r >= h) continue;
            let m = 0;
            for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) m += b[(cy + j) * w + cx + i];
            m /= n;
            let ssd = 0;
            for (let j = -r; j <= r && ssd < best; j++) {        // stop early once it can't win
                for (let i = -r; i <= r; i++) {
                    const d = (a[(y + j) * w + x + i] - mean) - (b[(cy + j) * w + cx + i] - m);   // the means take out a change of light
                    ssd += d * d;
                }
            }
            if (ssd < best) { best = ssd; bx = cx - x; by = cy - y; }
        }
    }
    return { dx: bx, dy: by, err: Math.sqrt(best / n) };
}

/** `n` points evenly spaced round a closed outline. */
export function resample(loop, n) {
    const pts = loop.length > 1 && loop[0][0] === loop.at(-1)[0] && loop[0][1] === loop.at(-1)[1] ? loop.slice(0, -1) : loop;
    const lengths = [0];
    for (let i = 1; i <= pts.length; i++) {
        const a = pts[i - 1], b = pts[i % pts.length];
        lengths.push(lengths[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const total = lengths.at(-1) || 1;
    const out = [];
    let j = 0;
    for (let k = 0; k < n; k++) {
        const target = (k / n) * total;
        while (j < pts.length - 1 && lengths[j + 1] < target) j++;
        const a = pts[j], b = pts[(j + 1) % pts.length];
        const u = (target - lengths[j]) / Math.max(1e-9, lengths[j + 1] - lengths[j]);
        out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
    }
    return out;
}

/** The cheapest edge path from pixel `from` to pixel `to`, searched only in their box padded by `pad`. */
export function boundedPath(cost, w, h, from, to, pad = 10) {
    const fx = from % w, fy = (from - fx) / w, tx = to % w, ty = (to - tx) / w;
    const x0 = Math.max(0, Math.min(fx, tx) - pad), x1 = Math.min(w - 1, Math.max(fx, tx) + pad);
    const y0 = Math.max(0, Math.min(fy, ty) - pad), y1 = Math.min(h - 1, Math.max(fy, ty) + pad);
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, n = bw * bh;
    const local = (x, y) => (y - y0) * bw + (x - x0);
    const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
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
    const s = local(fx, fy), t = local(tx, ty);
    dist[s] = 0;
    push(s, 0);
    while (heapN.length) {
        const p = pop();
        if (done[p]) continue;
        done[p] = 1;
        if (p === t) break;
        const px = p % bw, py = (p - px) / bw;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
            const q = ny * bw + nx;
            if (done[q]) continue;
            const nd = dist[p] + cost[(ny + y0) * w + nx + x0] * (dx && dy ? 1.4142135 : 1);
            if (nd < dist[q]) { dist[q] = nd; prev[q] = p; push(q, nd); }
        }
    }
    const path = [];
    for (let p = t; p !== -1; p = prev[p]) { const px = p % bw; path.push([px + x0, (p - px) / bw + y0]); if (p === s) break; }
    return path.reverse();
}

/** The area of a closed outline (shoelace), in pixels. */
export function area(loop) {
    let a = 0;
    for (let i = 0; i < loop.length; i++) { const p = loop[i], q = loop[(i + 1) % loop.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return Math.abs(a) / 2;
}

/** How strong the edges under an outline are, 0–1 (1: every pixel on a strong edge). */
export function edgeScore(loop, cost, w, h) {
    let sum = 0, n = 0;
    for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
        for (let k = 0; k < steps; k++) {
            const x = Math.round(a[0] + (b[0] - a[0]) * k / steps), y = Math.round(a[1] + (b[1] - a[1]) * k / steps);
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            sum += (256 - cost[y * w + x]) / 255;
            n++;
        }
    }
    return n ? sum / n : 0;
}

/**
 * One step: the outline on frame a, carried to frame b.
 * @returns {{ loop, score, edge, match }}
 */
export function trackStep(loop, grayA, grayB, costB, w, h, { points = 0, prob = null, reference = 0 } = {}) {
    const perimeter = loop.reduce((s, p, i) => s + Math.hypot(p[0] - loop[(i + 1) % loop.length][0], p[1] - loop[(i + 1) % loop.length][1]), 0);
    const n = points || Math.max(8, Math.min(48, Math.round(perimeter / 18)));
    const anchors = resample(loop, n);
    // coarse (half size, ±16 px) then fine (±3 px)
    const A = half(grayA, w, h), B = half(grayB, w, h);
    const moves = anchors.map(([x, y]) => {
        const c = matchPatch(A.g, B.g, A.w, A.h, x / 2, y / 2, 4, 8);
        const f = matchPatch(grayA, grayB, w, h, x, y, 6, 3, c.dx * 2, c.dy * 2);
        return f;
    });
    // points that disagree with the rest have most likely latched onto something else
    const median = (v) => { const s = [...v].sort((p, q) => p - q); return s[s.length >> 1]; };
    const mx = median(moves.map((m) => m.dx)), my = median(moves.map((m) => m.dy));
    const spread = median(moves.map((m) => Math.hypot(m.dx - mx, m.dy - my)));
    const limit = Math.max(4, 3 * spread);
    const target = anchors.map(([x, y], i) => {
        let { dx, dy } = moves[i];
        if (Math.hypot(dx - mx, dy - my) > limit) { dx = mx; dy = my; }
        return [x + dx, y + dy];
    });
    // the group's move, scale and turn; each point may stray only a little from it
    const fit = similarity(anchors, target);
    const STRAY = 3;
    const moved = anchors.map((p, i) => {
        const [fx, fy] = fit(p);
        let ex = target[i][0] - fx, ey = target[i][1] - fy;
        const e = Math.hypot(ex, ey);
        if (e > STRAY) { ex *= STRAY / e; ey *= STRAY / e; }
        return snap(costB, w, h, Math.min(w - 1, Math.max(0, fx + ex)), Math.min(h - 1, Math.max(0, fy + ey)), 2);
    });
    // the outline between neighbours, along the edge
    const out = [];
    for (let i = 0; i < moved.length; i++) {
        const a = moved[i], b = moved[(i + 1) % moved.length];
        const seg = boundedPath(costB, w, h, a[1] * w + a[0], b[1] * w + b[0], 6);
        out.push(...seg.slice(0, -1));
    }
    const next = out.length > 2 ? simplifyLoop(out, 0.8).slice(0, -1) : [];
    if (next.length < 3) {                                       // the outline collapsed (the object vanished?): keep its shape, moved with the rest
        return { loop: loop.map(([x, y]) => [x + mx, y + my]), score: 0, edge: 0, match: 0 };
    }
    const edge = edgeScore(next, costB, w, h);
    const match = moves.reduce((s, m) => s + Math.exp(-m.err / 25), 0) / moves.length;
    const ratio = area(next) / Math.max(1, area(loop));
    const shape = Math.exp(-3 * Math.abs(Math.log(Math.max(1e-6, ratio))));
    // with a colour model: is the inside still as much more object-like than the outside as on the keyframe?
    const likeness = prob && reference > 0 ? Math.max(0, Math.min(1, contrast(prob, next, w, h) / reference)) : edge;
    return { loop: next, score: likeness * (0.6 + 0.4 * match) * shape, edge, match, likeness };
}

/**
 * The tracker for one clip: keyframes in, an outline and a confidence for every frame out.
 * @param {{ frames: number, w: number, h: number, getGray: (k) => Promise<Uint8Array>, onProgress?: (done, total) => void }} o
 */
export function createTracker({ frames, w, h, getFrame, onProgress = () => {} }) {
    const keyframes = new Map();          // frame → outline
    const models = new Map();             // keyframe → { model, reference }: its colours, and how much the inside stood out
    const results = new Array(frames).fill(null);   // frame → { loop, score, from: 'key' | 'forward' | 'backward' }
    const cache = new Map();              // frame → { gray, bins }, the most recent 48
    let version = 0;
    const data = async (k) => {
        if (!cache.has(k)) {
            if (cache.size >= 48) cache.delete(cache.keys().next().value);
            cache.set(k, frameData(await getFrame(k), w, h));
        }
        return cache.get(k);
    };
    const gray = async (k) => (await data(k)).gray;
    /** Frame k as the keyframe `key` sees it: object-likeness by its colours, and the edges to follow. */
    const seen = async (k, key) => {
        const d = await data(k);
        const { model } = models.get(key);
        const prob = probabilityMap(d.bins, model, w, h);
        return { prob, cost: objectCost(d.gray, prob, w, h) };
    };
    async function learn(k) {
        const d = await data(k);
        const model = colourModel(d.bins, keyframes.get(k), w, h);
        const prob = probabilityMap(d.bins, model, w, h);
        models.set(k, { model, reference: Math.max(0.05, contrast(prob, keyframes.get(k), w, h)) });
        return { prob, cost: objectCost(d.gray, prob, w, h) };
    }

    async function run(key, to, step, into, stop) {
        let current = keyframes.get(key);
        const { reference } = models.get(key);
        for (let k = key + step; step > 0 ? k <= to : k >= to; k += step) {
            if (stop()) return;
            const { prob, cost } = await seen(k, key);
            const r = trackStep(current, await gray(k - step), await gray(k), cost, w, h, { prob, reference });
            into[k] = r;
            current = r.loop;
            onProgress();
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }

    return {
        keyframes, results, frames,
        get version() { return version; },
        /** A keyframe: the outline (pixel points at the tracker's size) is right on this frame. */
        async setKeyframe(k, loop) {
            keyframes.set(k, loop);
            await learn(k);
            results[k] = { loop, score: 1, from: 'key' };
            version++;
        },
        removeKeyframe(k) { keyframes.delete(k); models.delete(k); version++; },
        /** Frame k as the first keyframe sees it (object-likeness 0–1), for showing what the tracker sees. */
        async probability(k) { const key = [...keyframes.keys()][0]; return key === undefined ? null : (await seen(k, key)).prob; },
        /** Carry every keyframe forward and backward to its neighbours; each frame keeps the better direction. */
        async track({ stop = () => false } = {}) {
            const keys = [...keyframes.keys()].sort((a, b) => a - b);
            if (!keys.length) throw new Error('Mark the object on a frame first: select it, then "use as keyframe".');
            let done = 0;
            const total = keys.reduce((s, k, i) => s + ((keys[i + 1] ?? frames) - k - 1) + (k - (keys[i - 1] ?? -1) - 1), 0);
            const progress = () => onProgress(++done, total);
            for (const k of keys) results[k] = { loop: keyframes.get(k), score: 1, from: 'key' };
            for (let i = 0; i < keys.length; i++) {
                const k = keys[i], next = keys[i + 1] ?? frames, prev = keys[i - 1] ?? -1;
                const forward = [], backward = [];
                await run(k, next - 1, 1, forward, stop);
                if (i === 0) await run(k, prev + 1, -1, backward, stop);       // before the first keyframe: only backward
                if (i + 1 < keys.length) await run(next, k + 1, -1, backward, stop);
                for (let f = prev + 1; f < next; f++) {
                    if (f === k) continue;
                    const a = forward[f], b = backward[f];
                    const best = !a ? b : !b ? a : a.score >= b.score ? a : b;
                    if (best) results[f] = { loop: best.loop, score: best.score, from: best === a ? 'forward' : 'backward' };
                    else if (f > k) results[f] = results[f] ?? null;
                }
                if (stop()) break;
            }
            version++;
        },
        /** Frames that look much less sure than the keyframes they came from. */
        flagged(threshold = 0.55) {                    // scores are against the keyframes', which are 1
            return results.map((r, k) => (r && r.from !== 'key' && r.score < threshold ? k : -1)).filter((k) => k >= 0);
        },
        reset() { keyframes.clear(); models.clear(); results.fill(null); cache.clear(); version++; },
    };
}
