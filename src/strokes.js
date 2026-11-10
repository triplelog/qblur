/**
 * Brush strokes: a graphic painted by hand, drawn again for every frame.
 *
 * A strokes graphic records each stroke's points as the user drew them —
 * [x, y, ms, pressure], x and y as fractions of the frame — and a brush.
 * For frame t it becomes a picture whose channels are data, not colour:
 *
 *   alpha   coverage: how much paint is here so far, 0–1
 *   red     age: how long ago this pixel was last painted, 0 (just now) → 1 (`age` frames or more)
 *   green   passes ÷ 4: how many strokes have gone over it (soft brushes count partly)
 *   blue    progress: how far through the whole drawing it was painted, 0 → 1
 *
 * so the maths decides what the paint does:
 *
 *   mix(rgb, ink, alpha(brush))                                        ink
 *   mix(rgb, gaussian(2 + 3 min(4 green(brush), 3)), alpha(brush))     a blur that grows with every pass
 *   mix(rgb, mix((1, 0.85, 0.35), (0.12, 0.08, 0.06), red(brush)), alpha(brush))   glowing, then cooling
 *   mix(rgb, fromhsv(blue(brush), 0.85, 1), alpha(brush))              a rainbow along the drawing
 *
 * Only paint laid down by frame t is there, so the drawing animates.
 * Timing: `recorded` (the user's own speed; pauses between strokes become
 * `gap` frames), `even` (time follows the length drawn), or `per-stroke`
 * (every stroke takes the same time); `speed` scales it, `start` delays it,
 * `fit` stretches the whole drawing to that many frames. `clip` keeps the
 * paint inside (or outside) a mask — the editor passes the selection.
 *
 *   normalizeStrokes(name, spec)                  the spec in full, or an error naming what is wrong
 *   strokeTimeline(spec, aspect)                  every point's frame and width; .total frames
 *   rasterizeStrokes(spec, w, h, t, { mask })     → ImageData-like { data, width, height }
 *   traceContours(mask, w, h)                     the outlines of a mask, as polylines (for "outline the selection")
 */

export const BRUSHES = ['round', 'soft', 'marker', 'chalk', 'spray'];
export const TIMINGS = ['recorded', 'even', 'per-stroke'];
export const WIDTH_FROM = ['pressure', 'speed', 'none'];
export const CLIPS = ['none', 'inside', 'outside'];
export const FPS = 30;                                  // t counts frames; recorded milliseconds become frames at this rate

export const STROKES_DEFAULTS = {
    type: 'strokes', strokes: [], brush: 'round', size: 0.03, flow: 1, spacing: 0.2, taper: 0, buildUp: false, widthFrom: 'pressure',
    timing: 'recorded', speed: 1, gap: 6, start: 0, fit: 0, age: 30, clip: 'none', shadows: [],
};

const MAX_POINTS = 60000;

function fail(name, text) { throw new Error(`Graphic "${name}": ${text}`); }

function num(name, key, value, min, max) {
    const v = Number(value);
    if (!Number.isFinite(v) || v < min || v > max) fail(name, `"${key}" is a number from ${min} to ${max}`);
    return v;
}

/** The whole spec, defaults filled in. Points are rounded, so a drawing stays compact. */
export function normalizeStrokes(name, spec) {
    for (const key of Object.keys(spec)) if (!(key in STROKES_DEFAULTS)) fail(name, `no such setting "${key}" for strokes`);
    const s = { ...STROKES_DEFAULTS, ...spec };
    const choose = (key, list) => { if (!list.includes(s[key])) fail(name, `"${key}" is ${list.join(', ')} — not "${s[key]}"`); return s[key]; };
    const out = {
        type: 'strokes',
        brush: choose('brush', BRUSHES), widthFrom: choose('widthFrom', WIDTH_FROM), timing: choose('timing', TIMINGS), clip: choose('clip', CLIPS),
        size: num(name, 'size', s.size, 0.001, 0.5), flow: num(name, 'flow', s.flow, 0.01, 1), spacing: num(name, 'spacing', s.spacing, 0.02, 2),
        taper: num(name, 'taper', s.taper, 0, 0.5), speed: num(name, 'speed', s.speed, 0.05, 20), gap: num(name, 'gap', s.gap, 0, 600),
        start: num(name, 'start', s.start, 0, 10000), fit: num(name, 'fit', s.fit, 0, 10000), age: num(name, 'age', s.age, 1, 10000),
        buildUp: Boolean(s.buildUp), shadows: [],
    };
    if (!Array.isArray(s.strokes)) fail(name, '"strokes" is a list of { "points": [[x, y, ms, pressure], …] }');
    let count = 0;
    out.strokes = s.strokes.map((stroke, k) => {
        const points = Array.isArray(stroke) ? stroke : stroke?.points;
        if (!Array.isArray(points)) fail(name, `stroke ${k + 1} is { "points": [[x, y, ms, pressure], …] }`);
        count += points.length;
        if (count > MAX_POINTS) fail(name, `a drawing has at most ${MAX_POINTS} points`);
        return {
            points: points.map((p, j) => {
                if (!Array.isArray(p) || p.length < 2 || !p.every((v) => Number.isFinite(Number(v)))) fail(name, `stroke ${k + 1}, point ${j + 1} is [x, y, ms, pressure]`);
                return [+Number(p[0]).toFixed(4), +Number(p[1]).toFixed(4), Math.round(Number(p[2] ?? j * 16)), +Math.min(1, Math.max(0, Number(p[3] ?? 1))).toFixed(2)];
            }),
        };
    });
    return out;
}

/**
 * When each point is painted (frame) and how wide (a factor of the brush size).
 * `aspect` is the frame's width ÷ height, so lengths are measured in frame heights.
 */
export function strokeTimeline(spec, aspect = 1) {
    const strokes = [];
    let clock = spec.start;
    const evenPace = FPS / spec.speed;                        // `even`: one frame height of path a second at speed 1
    const perStroke = 20 / spec.speed;                        // `per-stroke`: frames each
    for (const stroke of spec.strokes) {
        const pts = stroke.points;
        if (!pts.length) continue;
        const lengths = [0];
        for (let j = 1; j < pts.length; j++) lengths.push(lengths[j - 1] + Math.hypot((pts[j][0] - pts[j - 1][0]) * aspect, pts[j][1] - pts[j - 1][1]));
        const length = lengths[lengths.length - 1] || 1e-9;
        const t0 = pts[0][2];
        const out = pts.map((p, j) => {
            let f;
            if (spec.timing === 'recorded') f = ((p[2] - t0) / 1000) * FPS / spec.speed;
            else if (spec.timing === 'even') f = lengths[j] * evenPace;
            else f = (lengths[j] / length) * perStroke;
            // width: pressure, or speed (fast is thin, as with a pen), then the taper at both ends
            let wf = 1;
            if (spec.widthFrom === 'pressure') wf = 0.3 + 0.7 * p[3];
            else if (spec.widthFrom === 'speed' && j > 0) {
                const dt = Math.max(1, p[2] - pts[j - 1][2]);
                const v = ((lengths[j] - lengths[j - 1]) / dt) * 1000;          // frame heights a second
                wf = Math.min(1.3, Math.max(0.35, 1.3 - v * 0.6));
            }
            if (spec.taper > 0) wf *= Math.max(0.15, Math.min(1, lengths[j] / length / spec.taper, (1 - lengths[j] / length) / spec.taper));
            return { x: p[0], y: p[1], f, wf };
        });
        if (spec.widthFrom === 'speed' && out.length > 1) out[0].wf = out[1].wf;
        const duration = out[out.length - 1].f;
        for (const p of out) p.f += clock;
        strokes.push({ points: out, start: clock, end: clock + duration });
        clock += duration + spec.gap;
    }
    let total = strokes.length ? strokes[strokes.length - 1].end : spec.start;
    if (spec.fit > 0 && total > spec.start) {                  // stretch the drawing to `fit` frames after the start
        const k = spec.fit / (total - spec.start);
        for (const s of strokes) {
            for (const p of s.points) p.f = spec.start + (p.f - spec.start) * k;
            s.start = spec.start + (s.start - spec.start) * k;
            s.end = spec.start + (s.end - spec.start) * k;
        }
        total = spec.start + spec.fit;
    }
    return { strokes, total };
}

/** A repeatable random number 0–1 for two integers. */
function hash(a, b) {
    let x = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) | 0;
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

const buffers = new Map();
function scratch(n) {
    let b = buffers.get(n);
    if (!b) {
        b = { alpha: new Float32Array(n), passes: new Float32Array(n), latest: new Float32Array(n), cov: new Float32Array(n), when: new Float32Array(n), touched: new Int32Array(n) };
        buffers.clear();                                       // one size at a time: the preview, or an export
        buffers.set(n, b);
    }
    b.alpha.fill(0); b.passes.fill(0); b.latest.fill(-1);
    return b;
}

/**
 * The strokes as painted by frame `t` (Infinity: all of them, as at the end), w × h.
 * `mask` (Float32Array of w × h, 0–1) is the selection for `clip`.
 * @returns {{ data: Uint8ClampedArray, width: number, height: number, total: number }}
 */
export function rasterizeStrokes(spec, w, h, t = Infinity, { mask = null } = {}) {
    const n = w * h;
    const { alpha, passes, latest, cov, when, touched } = scratch(n);
    const { strokes, total } = strokeTimeline(spec, w / h);
    const now = Number.isFinite(t) ? t : total;
    const base = Math.max(0.5, (spec.size * h) / 2);           // brush radius in pixels
    let dabCount = 0;

    strokes.forEach((stroke) => {
        if (stroke.start > now) return;
        let used = 0;
        const stamp = (x, y, r, f) => {
            const k = dabCount++;
            if (spec.brush === 'spray') {                      // a few dots scattered in the brush's circle
                const dots = Math.max(3, Math.round(r * 0.6));
                const dr = Math.max(0.6, r * 0.07);
                for (let d = 0; d < dots; d++) {
                    const a = hash(k, d * 2) * Math.PI * 2, rr = Math.sqrt(hash(k, d * 2 + 1)) * r;
                    dab(x + Math.cos(a) * rr, y + Math.sin(a) * rr, dr, f, 'round');
                }
            } else dab(x, y, r, f, spec.brush);
        };
        const dab = (cx, cy, r, f, kind) => {
            const reach = kind === 'marker' ? r : r + 1;
            const x0 = Math.max(0, Math.floor(cx - reach)), x1 = Math.min(w - 1, Math.ceil(cx + reach));
            const y0 = Math.max(0, Math.floor(cy - reach)), y1 = Math.min(h - 1, Math.ceil(cy + reach));
            for (let py = y0; py <= y1; py++) {
                for (let px = x0; px <= x1; px++) {
                    const dx = px + 0.5 - cx, dy = py + 0.5 - cy;
                    let c;
                    if (kind === 'soft') { const d = Math.hypot(dx, dy) / r; if (d >= 1) continue; const u = 1 - d; c = u * u * (3 - 2 * u); }
                    else if (kind === 'marker') {                // a flat nib, 45°, a third as thick as it is wide
                        const u = (dx + dy) * Math.SQRT1_2, v = (dy - dx) * Math.SQRT1_2;
                        const e = Math.hypot(u / r, v / (r * 0.33));
                        c = Math.min(1, Math.max(0, (1 - e) * r * 0.33 + 0.5));
                    } else {
                        c = Math.min(1, Math.max(0, r - Math.hypot(dx, dy) + 0.5));
                        if (kind === 'chalk') c *= hash(px, py * 7919) > 0.42 ? 1 : 0.12;   // grain fixed to the paper, so it stays put
                    }
                    if (c <= 0) continue;
                    c *= spec.flow;
                    const i = py * w + px;
                    if (c > cov[i]) { if (cov[i] === 0) touched[used++] = i; cov[i] = c; }
                    if (c > 0.02) when[i] = f;
                }
            }
        };
        // dabs along each segment painted by `now`, `spacing` brush widths apart
        const pts = stroke.points;
        let carry = 0;
        const P = (p) => [p.x * w, p.y * h];
        if (pts.length === 1 || pts.every((p) => p.x === pts[0].x && p.y === pts[0].y)) {
            const [x, y] = P(pts[0]);
            stamp(x, y, base * pts[0].wf, pts[0].f);
        }
        for (let j = 1; j < pts.length; j++) {
            const a = pts[j - 1], b = pts[j];
            if (a.f > now) break;
            const [ax, ay] = P(a), [bx, by] = P(b);
            let u1 = 1;
            if (b.f > now) u1 = (now - a.f) / Math.max(1e-9, b.f - a.f);
            const len = Math.hypot(bx - ax, by - ay);
            let s = j === 1 ? 0 : carry;
            while (s <= len * u1) {
                const u = len ? s / len : 0;
                const r = base * (a.wf + (b.wf - a.wf) * u);
                stamp(ax + (bx - ax) * u, ay + (by - ay) * u, r, a.f + (b.f - a.f) * u);
                s += Math.max(0.5, spec.spacing * 2 * r);
            }
            carry = s - len;
            if (u1 < 1) break;
        }
        // this stroke counts once wherever it went, however often it crossed itself
        for (let k = 0; k < used; k++) {
            const i = touched[k], c = cov[i];
            alpha[i] = spec.buildUp ? 1 - (1 - alpha[i]) * (1 - c) : Math.max(alpha[i], c);
            passes[i] += c;
            if (c > 0.02 && when[i] > latest[i]) latest[i] = when[i];
            cov[i] = 0;
        }
    });

    const data = new Uint8ClampedArray(n * 4);
    const inside = spec.clip === 'inside', outside = spec.clip === 'outside';
    for (let i = 0; i < n; i++) {
        let a = alpha[i];
        if (a === 0) continue;
        let m = 1;
        if (mask && (inside || outside)) m = inside ? mask[i] : 1 - mask[i];
        a *= m;
        const j = i * 4;
        data[j] = Math.round(Math.min(1, Math.max(0, (now - latest[i]) / spec.age)) * 255);
        data[j + 1] = Math.round(Math.min(1, (passes[i] * m) / 4) * 255);
        data[j + 2] = Math.round(Math.min(1, Math.max(0, latest[i] / Math.max(1e-9, total))) * 255);
        data[j + 3] = Math.round(a * 255);
    }
    return { data, width: w, height: h, total };
}

/**
 * The outlines of a mask (values > 0.5 are in), each a closed polyline of pixel
 * centres, simplified; parts smaller than `minArea` pixels are left out.
 * Moore-neighbour tracing, one outline per connected part.
 */
export function traceContours(mask, w, h, { minArea = 40, tolerance = 0.8 } = {}) {
    const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] > 0.5;
    const label = new Int32Array(w * h).fill(-1);
    const outlines = [];
    const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];   // clockwise on screen
    let parts = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!inside(x, y) || label[y * w + x] >= 0) continue;
            // the whole part, so its outline is traced once
            const id = parts++;
            const stack = [y * w + x];
            label[y * w + x] = id;
            let area = 0;
            while (stack.length) {
                const p = stack.pop();
                area++;
                const px = p % w, py = (p - px) / w;
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const qx = px + dx, qy = py + dy;
                    if (inside(qx, qy) && label[qy * w + qx] < 0) { label[qy * w + qx] = id; stack.push(qy * w + qx); }
                }
            }
            if (area < minArea) continue;
            // (x, y) is its top-left pixel: the one to its left is outside
            const path = [[x, y]];
            let cx = x, cy = y, back = 4;                         // we came from the west
            for (let steps = 0; steps < 4 * area + 16; steps++) {
                let found = false;
                for (let k = 1; k <= 8; k++) {
                    const d = (back + k) % 8;
                    const nx = cx + dirs[d][0], ny = cy + dirs[d][1];
                    if (inside(nx, ny) && label[ny * w + nx] === id) {
                        back = (d + 4) % 8;                        // where we came from: the next search starts just past it, clockwise
                        cx = nx; cy = ny;
                        found = true;
                        break;
                    }
                }
                if (!found || (cx === x && cy === y)) break;
                path.push([cx, cy]);
            }
            outlines.push(simplifyLoop(path, tolerance));
        }
    }
    return outlines;
}

/**
 * A closed loop (first point not repeated) simplified, and closed again: as two
 * halves split at the point farthest from the start — simplify() alone would measure
 * everything against a line from a point to itself, and keep nothing.
 */
export function simplifyLoop(points, tolerance) {
    if (points.length < 4) return [...points, points[0]];
    const [x, y] = points[0];
    let far = 0;
    points.forEach(([px, py], i) => { if (Math.hypot(px - x, py - y) > Math.hypot(points[far][0] - x, points[far][1] - y)) far = i; });
    return [...simplify(points.slice(0, far + 1), tolerance), ...simplify([...points.slice(far), points[0]], tolerance).slice(1)];
}

/** Ramer–Douglas–Peucker: fewer points, within `tolerance` pixels of the line. */
export function simplify(points, tolerance) {
    if (points.length < 3) return points;
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        const [ax, ay] = points[a], [bx, by] = points[b];
        const len = Math.hypot(bx - ax, by - ay) || 1e-9;
        let worst = -1, at = -1;
        for (let i = a + 1; i < b; i++) {
            const d = Math.abs((bx - ax) * (ay - points[i][1]) - (ax - points[i][0]) * (by - ay)) / len;
            if (d > worst) { worst = d; at = i; }
        }
        if (worst > tolerance) { keep[at] = 1; stack.push([a, at], [at, b]); }
    }
    return points.filter((_, i) => keep[i]);
}
