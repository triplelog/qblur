/* qblur — Copyright (c) 2025-2026 Robert Wilcox — MIT licence; MathZetta loads from jsDelivr; other people's code in this file (gifenc) and on this site: THIRD-PARTY-NOTICES.txt */
import * as core from 'mathzetta';
import { parseTree } from 'mathzetta';
import { FILTER_NAMES, COLOUR_SPACES, PLACES, filterShader, filterVertexShader, REACH, FILTER_FUNCTIONS, FILTER_VALUES, filterPictureCalls } from 'mathzetta/glsl';
import { checkGeneratedJs } from 'mathzetta/formulas';
import { renderMarkdownInto, createVariables, markdownToHTML } from '@mathzetta/inlinemath/markdown';
import { calculate } from 'mathzetta/calculate';

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

const BRUSHES = ['round', 'soft', 'marker', 'chalk', 'spray'];
const TIMINGS = ['recorded', 'even', 'per-stroke'];
const WIDTH_FROM = ['pressure', 'speed', 'none'];
const CLIPS = ['none', 'inside', 'outside'];
const FPS = 30;                                  // t counts frames; recorded milliseconds become frames at this rate

const STROKES_DEFAULTS = {
    type: 'strokes', strokes: [], brush: 'round', size: 0.03, flow: 1, spacing: 0.2, taper: 0, buildUp: false, widthFrom: 'pressure',
    timing: 'recorded', speed: 1, gap: 6, start: 0, fit: 0, age: 30, clip: 'none', shadows: [],
};

const MAX_POINTS = 60000;

function fail(name, text) { throw new Error(`Graphic "${name}": ${text}`); }

function num$1(name, key, value, min, max) {
    const v = Number(value);
    if (!Number.isFinite(v) || v < min || v > max) fail(name, `"${key}" is a number from ${min} to ${max}`);
    return v;
}

/** The whole spec, defaults filled in. Points are rounded, so a drawing stays compact. */
function normalizeStrokes(name, spec) {
    for (const key of Object.keys(spec)) if (!(key in STROKES_DEFAULTS)) fail(name, `no such setting "${key}" for strokes`);
    const s = { ...STROKES_DEFAULTS, ...spec };
    const choose = (key, list) => { if (!list.includes(s[key])) fail(name, `"${key}" is ${list.join(', ')} — not "${s[key]}"`); return s[key]; };
    const out = {
        type: 'strokes',
        brush: choose('brush', BRUSHES), widthFrom: choose('widthFrom', WIDTH_FROM), timing: choose('timing', TIMINGS), clip: choose('clip', CLIPS),
        size: num$1(name, 'size', s.size, 0.001, 0.5), flow: num$1(name, 'flow', s.flow, 0.01, 1), spacing: num$1(name, 'spacing', s.spacing, 0.02, 2),
        taper: num$1(name, 'taper', s.taper, 0, 0.5), speed: num$1(name, 'speed', s.speed, 0.05, 20), gap: num$1(name, 'gap', s.gap, 0, 600),
        start: num$1(name, 'start', s.start, 0, 10000), fit: num$1(name, 'fit', s.fit, 0, 10000), age: num$1(name, 'age', s.age, 1, 10000),
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
function strokeTimeline(spec, aspect = 1) {
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
function scratch$1(n) {
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
function rasterizeStrokes(spec, w, h, t = Infinity, { mask = null } = {}) {
    const n = w * h;
    const { alpha, passes, latest, cov, when, touched } = scratch$1(n);
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
function traceContours(mask, w, h, { minArea = 40, tolerance = 0.8 } = {}) {
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
function simplifyLoop(points, tolerance) {
    if (points.length < 4) return [...points, points[0]];
    const [x, y] = points[0];
    let far = 0;
    points.forEach(([px, py], i) => { if (Math.hypot(px - x, py - y) > Math.hypot(points[far][0] - x, points[far][1] - y)) far = i; });
    return [...simplify(points.slice(0, far + 1), tolerance), ...simplify([...points.slice(far), points[0]], tolerance).slice(1)];
}

/** Ramer–Douglas–Peucker: fewer points, within `tolerance` pixels of the line. */
function simplify(points, tolerance) {
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

/**
 * Text and shapes as pictures.
 *
 * A filter's `graphics` names things to draw — text, rectangles, ovals —
 * each rasterized into a transparent picture the size of the frame under
 * its name. The maths then treats it like any picture: `title` is its
 * colour, `alpha(title)` where it is, so
 *
 *   mix(rgb, title, alpha(title))                      lays the text on
 *   mix(rgb, gaussian(6) * 0.8, alpha(panel))          frosts the picture behind a panel
 *   mix(rgb, shift(title, 3t, 0), alpha(shift(title, 3t, 0)))   scrolls it
 *
 * A graphic's `shadow` is drawn into it. Its `shadows` — a list, back to
 * front — are drawn each into a picture of its own, `title_shadow1`,
 * `title_shadow2`…, so every shadow layer can have its own maths:
 *
 *   mix(mix(rgb, gaussian(4), alpha(title_shadow1)), title, alpha(title))
 *   mix(mix(rgb, (1, 0.3, 0.6) , alpha(shift(title_shadow1, 2 sin(t / 9), 0))), title, alpha(title))
 *
 * Positions and sizes are fractions of the frame (x, y 0–1; sizes of its
 * height), so a graphic drawn again at export size is crisp and in the
 * same place. Angles are radians, like everything else here.
 *
 *   normalizeGraphic(name, spec)        the full spec, or an error naming what is wrong
 *   drawGraphic(ctx, spec, w, h)        onto any 2D context (canvas, OffscreenCanvas)
 *   await loadGraphicFonts(graphics)    web fonts named by fontUrl, before drawing
 *   await renderGraphics(compiled, w, h) → { key: canvas } for runner.setImage(key, canvas)
 *   (keys are the names, made unique across a chain: `title`, `title~2`…)
 */


const GRAPHIC_TYPES = ['text', 'rect', 'ellipse', 'strokes'];

/** What each kind of graphic is, unless said otherwise. */
const GRAPHIC_DEFAULTS = {
    text: {
        type: 'text', text: 'Text', font: 'sans-serif', weight: 'bold', style: 'normal', size: 0.08,
        x: 0.5, y: 0.85, align: 'center', angle: 0, lineHeight: 1.2, color: '#ffffff',
        outline: null, shadow: { color: 'rgba(0,0,0,0.6)', blur: 0.15, dx: 0.04, dy: 0.06 }, shadows: [],
    },
    rect: { type: 'rect', x: 0.5, y: 0.85, w: 0.8, h: 0.18, radius: 0.15, angle: 0, color: '#ffffff', outline: null, shadow: null, shadows: [] },
    ellipse: { type: 'ellipse', x: 0.5, y: 0.5, w: 0.4, h: 0.4, angle: 0, color: '#ffffff', outline: null, shadow: null, shadows: [] },
};

/** At most this many separate shadow layers per graphic. */
const MAX_SHADOW_LAYERS = 8;

/**
 * The picture names of a graphic's separate shadow layers, back to front:
 * title_shadow1, title_shadow2… Each is a picture of that shadow alone, so
 * the maths can treat it on its own (blur it, colour it, move it with t).
 */
const shadowLayerNames = (name, spec) => (spec.shadows ?? []).map((_, k) => `${name}_shadow${k + 1}`);

/** The maths that lays a graphic on with its shadow layers, back to front — what a new text step starts with. */
function layeredExpression(name, spec) {
    let base = 'rgb';
    for (const layer of shadowLayerNames(name, spec)) base = `mix(${base}, ${layer}, alpha(${layer}))`;
    return `mix(${base}, ${name}, alpha(${name}))`;
}

const COLOUR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d.,\s%deg/]+\)|[a-z]{3,20}|transparent)$/i;
const FAMILY = /^[\w\s,'"-]{1,80}$/;
const WEIGHTS = ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'];

function colour(name, key, value) {
    if (typeof value !== 'string' || !COLOUR.test(value.trim())) throw new Error(`Graphic "${name}": "${key}" is a colour like "#ffcc00", "rgba(0,0,0,0.5)" or "white"`);
    return value.trim();
}

function number(name, key, value, min = -Infinity, max = Infinity) {
    const v = Number(value);
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`Graphic "${name}": "${key}" is a number${Number.isFinite(min) ? ` from ${min} to ${max}` : ''}`);
    return v;
}

/** `{ color, width }` around the text or shape; width is a fraction of the text size (or of the frame height for shapes). */
function outline(name, value) {
    if (value === null || value === false) return null;
    if (typeof value !== 'object') throw new Error(`Graphic "${name}": "outline" is { "color", "width" } or null`);
    return { color: colour(name, 'outline.color', value.color ?? '#000000'), width: number(name, 'outline.width', value.width ?? 0.06, 0, 1) };
}

/** `{ color, blur, dx, dy }` behind it; blur and offsets are fractions of the text size (frame height for shapes). */
function shadow(name, value) {
    if (value === null || value === false) return null;
    if (typeof value !== 'object') throw new Error(`Graphic "${name}": "shadow" is { "color", "blur", "dx", "dy" } or null`);
    return {
        color: colour(name, 'shadow.color', value.color ?? 'rgba(0,0,0,0.6)'),
        blur: number(name, 'shadow.blur', value.blur ?? 0.15, 0, 2),
        dx: number(name, 'shadow.dx', value.dx ?? 0, -2, 2),
        dy: number(name, 'shadow.dy', value.dy ?? 0, -2, 2),
    };
}

/** The whole spec, defaults filled in; throws a message naming the graphic and the setting. */
function normalizeGraphic(name, spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`Graphic "${name}": give { "type": "text" | "rect" | "ellipse", … }`);
    const type = spec.type ?? 'text';
    if (!GRAPHIC_TYPES.includes(type)) throw new Error(`Graphic "${name}": "type" is text, rect, ellipse or strokes — not "${type}"`);
    if (type === 'strokes') return normalizeStrokes(name, spec);         // brush strokes: src/strokes.js
    const base = GRAPHIC_DEFAULTS[type];
    for (const key of Object.keys(spec)) if (!(key in base) && key !== 'fontUrl' && key !== 'onlyShadow') throw new Error(`Graphic "${name}": no such setting "${key}" for ${type}`);
    const out = { type };
    for (const [key, fallback] of Object.entries(base)) {
        if (key === 'type') continue;
        const value = key in spec && spec[key] !== undefined ? spec[key] : fallback;     // null is a value: "no shadow"
        if (key === 'color') out.color = colour(name, key, value);
        else if (key === 'outline') out.outline = outline(name, value);
        else if (key === 'shadow') out.shadow = shadow(name, value);
        else if (key === 'shadows') {
            if (!Array.isArray(value) || value.length > MAX_SHADOW_LAYERS) throw new Error(`Graphic "${name}": "shadows" is a list of up to ${MAX_SHADOW_LAYERS} { "color", "blur", "dx", "dy" }`);
            out.shadows = value.map((layer, k) => {
                if (!layer || typeof layer !== 'object') throw new Error(`Graphic "${name}": shadow layer ${k + 1} is { "color", "blur", "dx", "dy" }`);
                return shadow(name, layer);
            });
        }
        else if (key === 'text') {
            if (typeof value !== 'string' || value.length > 500) throw new Error(`Graphic "${name}": "text" is up to 500 characters`);
            out.text = value;
        } else if (key === 'font') {
            if (typeof value !== 'string' || !FAMILY.test(value)) throw new Error(`Graphic "${name}": "font" is a font family, like "Georgia" or "sans-serif"`);
            out.font = value;
        } else if (key === 'weight') {
            if (!WEIGHTS.includes(String(value))) throw new Error(`Graphic "${name}": "weight" is normal, bold or 100–900`);
            out.weight = String(value);
        } else if (key === 'style') {
            if (!['normal', 'italic'].includes(value)) throw new Error(`Graphic "${name}": "style" is normal or italic`);
            out.style = value;
        } else if (key === 'align') {
            if (!['left', 'center', 'right'].includes(value)) throw new Error(`Graphic "${name}": "align" is left, center or right`);
            out.align = value;
        } else if (key === 'size') out.size = number(name, key, value, 0.005, 2);
        else if (key === 'w' || key === 'h') out[key] = number(name, key, value, 0, 4);
        else if (key === 'radius') out.radius = number(name, key, value, 0, 0.5);
        else if (key === 'lineHeight') out.lineHeight = number(name, key, value, 0.5, 4);
        else out[key] = number(name, key, value);                       // x, y, angle
    }
    if (spec.fontUrl !== undefined && spec.fontUrl !== null && spec.fontUrl !== '') {
        if (type !== 'text') throw new Error(`Graphic "${name}": "fontUrl" is for text`);
        let url;
        try { url = new URL(spec.fontUrl); } catch { url = null; }
        if (!url || url.protocol !== 'https:') throw new Error(`Graphic "${name}": "fontUrl" is an https:// address of a font file (.woff2, .woff, .ttf, .otf) or of a Google Fonts stylesheet`);
        out.fontUrl = url.href;
    }
    if (spec.onlyShadow !== undefined) out.onlyShadow = number(name, 'onlyShadow', spec.onlyShadow, 0, MAX_SHADOW_LAYERS - 1);   // set by the compiler for a layer's picture
    return out;
}

/** A Google Fonts stylesheet address for a family name: "Lobster" → https://fonts.googleapis.com/css2?family=Lobster:… */
function googleFontUrl(family) {
    const name = String(family).trim().replace(/\s+/g, ' ');
    if (!/^[A-Za-z0-9 ]{1,60}$/.test(name)) throw new Error('A Google Fonts name is letters, digits and spaces, like "Lobster" or "Playfair Display"');
    return `https://fonts.googleapis.com/css2?family=${name.replace(/ /g, '+')}:ital,wght@0,400;0,700;1,400;1,700&display=swap`;
}

/** The family a Google Fonts address names ("Playfair Display"), or null. */
function googleFontFamily(url) {
    try {
        const u = new URL(url);
        if (u.hostname !== 'fonts.googleapis.com') return null;
        return (u.searchParams.get('family') ?? '').split(':')[0].replace(/\+/g, ' ') || null;
    } catch { return null; }
}

/**
 * The font file a stylesheet points at — for a Google Fonts css2 address, the
 * latin face of the weight and style wanted (its last block for that face).
 */
function fontFileFromCss(css, { weight = '400', style = 'normal' } = {}) {
    const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
    const prop = (block, key) => (new RegExp(`${key}\\s*:\\s*([^;]+);`).exec(block)?.[1] ?? '').trim();
    const want = String(weight === 'bold' ? 700 : weight === 'normal' ? 400 : weight);
    const pick = faces.filter((f) => prop(f, 'font-weight') === want && prop(f, 'font-style') === style);
    const block = (pick.length ? pick : faces).at(-1);
    return block ? (/url\(([^)]+)\)/.exec(block)?.[1] ?? '').replace(/^['"]|['"]$/g, '') || null : null;
}

/** The CSS font for a text graphic at frame height `h`. Fonts loaded from fontUrl are known by the url-derived family. */
function cssFont(spec, h) {
    const family = spec.fontUrl ? `"${familyFor(spec.fontUrl)}", ${spec.font}` : spec.font;
    return `${spec.style} ${spec.weight} ${Math.max(1, spec.size * h)}px ${family}`;
}

/** A stable, safe family name for a font loaded from a URL. */
function familyFor(url) {
    let hash = 0;
    for (const ch of url) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return `mz-font-${hash.toString(36)}`;
}

const loadedFonts = new Map();

/**
 * Loads every fontUrl among the graphics (once each per weight and style) and waits for
 * the families to be usable. A font file is used as it is; a stylesheet (Google Fonts)
 * is read for the file of the weight and style the text uses.
 * @returns {Promise<string[]>} the addresses that could not be loaded
 */
async function loadGraphicFonts(graphics, h = 100) {
    if (typeof document === 'undefined' && typeof self === 'undefined') return [];
    const fonts = typeof document !== 'undefined' ? document.fonts : self.fonts;
    if (!fonts) return [];
    const failed = [];
    for (const spec of Object.values(graphics ?? {})) {
        if (spec.type !== 'text') continue;
        if (spec.fontUrl && typeof FontFace !== 'undefined') {
            const key = `${spec.fontUrl} ${spec.weight} ${spec.style}`;
            if (!loadedFonts.has(key)) loadedFonts.set(key, loadFace(spec, fonts));
            if (!(await loadedFonts.get(key))) failed.push(spec.fontUrl);
        }
        try { await fonts.load(cssFont(spec, h), spec.text); } catch { /* an unknown family falls back, as CSS does */ }
    }
    return [...new Set(failed)];
}

async function loadFace(spec, fonts) {
    try {
        let file = spec.fontUrl;
        if (!/\.(woff2?|ttf|otf)(\?|$)/i.test(new URL(file).pathname) || googleFontFamily(file)) {
            const css = await (await fetch(file)).text();
            file = fontFileFromCss(css, spec);
            if (!file || !file.startsWith('https://')) return null;
        }
        const face = new FontFace(familyFor(spec.fontUrl), `url(${JSON.stringify(file)})`, { weight: spec.weight, style: spec.style });
        fonts.add(await face.load());
        return face;
    } catch { return null; }
}

/** Draws one graphic onto a w × h context (cleared first by the caller). */
function drawGraphic(ctx, spec, w, h) {
    ctx.save();
    const unit = spec.type === 'text' ? spec.size * h : h;            // shadow and outline sizes scale with this
    // A shadow layer alone: the shape is drawn far off to the left and only its shadow is thrown back onto the frame.
    const layer = spec.onlyShadow !== undefined ? spec.shadows[spec.onlyShadow] : null;
    const away = layer ? 2 * (w + h) + 1000 : 0;
    const cast = layer ?? spec.shadow;
    ctx.translate(spec.x * w - away, spec.y * h);
    if (spec.angle) ctx.rotate(spec.angle);
    if (cast) {
        ctx.shadowColor = cast.color;
        ctx.shadowBlur = cast.blur * unit;
        ctx.shadowOffsetX = cast.dx * unit + away;
        ctx.shadowOffsetY = cast.dy * unit;
    }
    ctx.fillStyle = layer ? '#000000' : spec.color;                    // an opaque body throws the full shadow
    if (spec.outline) {
        ctx.strokeStyle = spec.outline.color;
        ctx.lineWidth = spec.outline.width * unit;
        ctx.lineJoin = 'round';
    }
    if (spec.type === 'text') {
        ctx.font = cssFont(spec, h);
        ctx.textAlign = spec.align;
        ctx.textBaseline = 'middle';
        const lines = spec.text.split('\n');
        const step = spec.size * h * spec.lineHeight;
        lines.forEach((line, i) => {
            const y = (i - (lines.length - 1) / 2) * step;
            if (spec.outline) ctx.strokeText(line, 0, y);           // the outline under the fill, so the letters keep their shape
            if (spec.outline && cast && !layer) { ctx.shadowColor = 'transparent'; }
            ctx.fillText(line, 0, y);
            if (spec.outline && cast && !layer) ctx.shadowColor = cast.color;
        });
    } else {
        const W = spec.w * w, H = spec.h * h;
        ctx.beginPath();
        if (spec.type === 'ellipse') ctx.ellipse(0, 0, W / 2, H / 2, 0, 0, Math.PI * 2);
        else {
            const r = Math.min(W, H) * spec.radius;
            if (ctx.roundRect) ctx.roundRect(-W / 2, -H / 2, W, H, r);
            else ctx.rect(-W / 2, -H / 2, W, H);
        }
        ctx.fill();
        if (spec.outline) { if (!layer) ctx.shadowColor = 'transparent'; ctx.stroke(); }
    }
    ctx.restore();
}

/**
 * Every graphic of a compiled filter drawn at w × h, fonts loaded first: { name: canvas }.
 * Brush strokes are drawn as at frame `t` (all of them, by default), clipped by `mask`
 * (a w × h Float32Array, the selection) when they ask to be, as ImageData-like objects.
 */
async function renderGraphics(compiled, w, h, { t = Infinity, mask = null } = {}) {
    const graphics = compiled.graphics ?? {};
    const failed = await loadGraphicFonts(graphics, h);
    const out = {};
    for (const [name, spec] of Object.entries(graphics)) {
        if (spec.type === 'strokes') {
            const r = rasterizeStrokes(spec, w, h, t, { mask });
            out[name] = typeof ImageData !== 'undefined' ? new ImageData(r.data, w, h) : r;   // not via a canvas: it would premultiply the data channels away
            continue;
        }
        const canvas = typeof OffscreenCanvas !== 'undefined' && typeof document === 'undefined'
            ? new OffscreenCanvas(w, h)
            : Object.assign(document.createElement('canvas'), { width: w, height: h });
        drawGraphic(canvas.getContext('2d'), spec, w, h);
        out[name] = canvas;
    }
    Object.defineProperty(out, 'failedFonts', { value: failed });   // addresses that could not be loaded (the text fell back to its family)
    return out;
}

/**
 * Shareable image filters.
 *
 * A filter is a small JSON document anyone can publish — maths plus a
 * name, an author, the knobs it exposes and the pictures it needs:
 *
 *   { "format": "mathzetta-filter/1",
 *     "name": "Threshold", "author": "Ada",
 *     "description": "Black or white, at a cutoff you choose",
 *     "params": { "cutoff": { "default": 0.5, "min": 0, "max": 1 } },
 *     "color": "if gray > cutoff then 1 else 0" }
 *
 *   { "name": "Through a mask", "images": { "mask": { "description": "light where the effect shows" } },
 *     "color": "mix(source, rgb, luma(mask))" }
 *
 * A chain combines filters: each step is a filter (or just an expression)
 * with optional settings for its params and an opacity:
 *
 *   { "format": "mathzetta-filter/1", "name": "Old film", "author": "Bo",
 *     "steps": [
 *       { "filter": { …Ada's Threshold… }, "with": { "cutoff": 0.3 }, "opacity": 0.5 },
 *       "rgb * 0.9" ] }
 *
 * A chain is a filter too, so published chains nest inside new ones and
 * keep their authors' names (compileFilter() lists them as credits).
 * Because a filter is only maths, sharing one is safe: it can read the
 * picture and write colours, nothing else.
 *
 * normalizeFilter() fills in defaults and rejects bad shapes,
 * validateFilter() lists every problem, and compileFilter() flattens a
 * filter into the shader passes runtime.js draws. filterToJSON() /
 * filterFromJSON() and filterToLink() / filterFromLink() are the two ways
 * to pass one around; readFilter() accepts either, or a bare expression.
 */

const FILTER_FORMAT = 'mathzetta-filter/1';

const CHANNELS = ['r', 'g', 'b', 'a', 'rgb', 'rgba'];
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Names a parameter can't take: what every expression already has, and GLSL's own words. */
const RESERVED = new Set([
    ...FILTER_NAMES, 'r', 'g', 'b', 'a', 'x', 'y', 'w', 'h', 't', 'c', 'e', 'pi',
    'color', 'image', 'resolution', 'base', 'position', 'main',
    'in', 'out', 'inout', 'const', 'uniform', 'varying', 'attribute', 'void', 'float', 'int', 'bool',
    'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4', 'sampler2D', 'struct', 'precision', 'highp', 'mediump', 'lowp',
    'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'discard', 'true', 'false',
    'texture2D', 'texture', 'mix', 'clamp', 'step', 'smoothstep', 'abs', 'sign', 'floor', 'ceil', 'fract', 'mod',
    'min', 'max', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt',
    'inversesqrt', 'length', 'distance', 'dot', 'cross', 'normalize', 'radians', 'degrees',
]);

const isColor = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(Number(n)));
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
/** How a named picture sits over the frame unless the filter or the chain says otherwise. */
const PLACEMENT = { place: 'cover', zoom: 1, x: 0.5, y: 0.5, angle: 0 };

// ---- the shape ------------------------------------------------------------

/**
 * The full form of a filter: a string becomes `{ color }`, params get
 * their type and range, every step gets `with` and `opacity`. Throws on
 * anything that isn't a filter.
 */
function normalizeFilter(def) {
    if (typeof def === 'string') {
        if (!def.trim()) throw new Error('The filter is empty');
        return { format: FILTER_FORMAT, color: def.trim() };
    }
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw new Error('A filter is an expression, or an object with "color" or "steps"');
    if (def.format !== undefined && def.format !== FILTER_FORMAT) throw new Error(`Unknown filter format "${def.format}" (this is ${FILTER_FORMAT})`);
    const out = { format: FILTER_FORMAT };
    for (const key of ['name', 'author', 'description']) if (def[key] !== undefined && def[key] !== '') out[key] = String(def[key]);
    if (def.steps !== undefined) {
        if (def.color !== undefined) throw new Error('A filter has either "color" or "steps", not both');
        if (!Array.isArray(def.steps) || !def.steps.length) throw new Error('"steps" must be a list with at least one step');
        out.steps = def.steps.map(normalizeStep);
        if (def.notes !== undefined) out.notes = normalizeNotes(def.notes, filterParams(out));
        return out;
    }
    if (def.color === undefined) throw new Error('A filter needs "color" (an expression, or one per channel) or "steps"');
    const params = normalizeParams(def.params ?? {});
    if (Object.keys(params).length) out.params = params;
    if (def.notes !== undefined) out.notes = normalizeNotes(def.notes, params);
    const images = normalizeImages(def.images ?? {}, params);
    if (Object.keys(images).length) out.images = images;
    const graphics = normalizeGraphics(def.graphics ?? {}, params, images);
    if (Object.keys(graphics).length) out.graphics = graphics;
    const space = normalizeSpace(def.space);
    if (space) out.space = space;
    out.color = normalizeColor(def.color);
    return out;
}

/**
 * The filter's page: Markdown text (with maths: Inline Math draws it, and `{{k}}` is a knob's value)
 * and where each knob's input goes — `["Darker below the *cutoff*:", { "param": "cutoff" }]`.
 * Knobs it doesn't place come before it.
 */
function normalizeNotes(notes, params) {
    if (!Array.isArray(notes)) throw new Error('"notes" is a list of Markdown texts and { "param": name } entries');
    return notes.map((block) => {
        if (typeof block === 'string') return block;
        if (!isObject(block) || typeof block.param !== 'string' || Object.keys(block).length !== 1) throw new Error('"notes": each entry is a Markdown text or { "param": name }');
        if (!(block.param in params)) throw new Error(`"notes" places "${block.param}", but there is no parameter called that`);
        return { param: block.param };
    });
}

/** `"hsv"` or `{ "in": "hsv", "out": "srgb" }` → `{ in, out }`; nothing when both are sRGB. */
function normalizeSpace(space) {
    if (space === undefined || space === null) return null;
    const pair = typeof space === 'string' ? { in: space, out: space } : space;
    if (!isObject(pair)) throw new Error(`"space" is a colour space (${COLOUR_SPACES.join(', ')}) or { "in": …, "out": … }`);
    const out = { in: pair.in ?? 'srgb', out: pair.out ?? 'srgb' };
    for (const key of ['in', 'out']) {
        if (!COLOUR_SPACES.includes(out[key])) throw new Error(`"space": "${out[key]}" is not a colour space; they are ${COLOUR_SPACES.join(', ')}`);
    }
    return out.in === 'srgb' && out.out === 'srgb' ? null : out;
}

/** `{ "title": { "type": "text", "text": "Hello", … } }` → each spec in full (src/graphics.js). */
function normalizeGraphics(graphics, params, images) {
    if (!isObject(graphics)) throw new Error('"graphics" is an object of name → { "type": "text" | "rect" | "ellipse", … }');
    const out = {};
    for (const [name, spec] of Object.entries(graphics)) {
        if (!NAME.test(name) || name.startsWith('mz_')) throw new Error(`Graphic name "${name}" must be letters, digits and _, starting with a letter`);
        if (RESERVED.has(name) || name === 'source' || name === 'selection') throw new Error(`"${name}" is already defined in every filter; pick another graphic name`);
        if (name in params || name in images) throw new Error(`"${name}" is both a graphic and a parameter or picture`);
        out[name] = normalizeGraphic(name, spec);
    }
    // name_shadow1… are the pictures of its shadow layers: no other name may be one
    const layers = new Set(Object.keys(out).flatMap((name) => Array.from({ length: MAX_SHADOW_LAYERS }, (_, k) => `${name}_shadow${k + 1}`)));
    for (const name of [...Object.keys(out), ...Object.keys(params), ...Object.keys(images)]) {
        if (layers.has(name)) throw new Error(`"${name}" is the name of a shadow layer of another graphic; pick another name`);
    }
    return out;
}

/** Every graphic a filter draws, including those of the filters inside a chain (first one wins). */
function filterGraphics(filter) {
    if (filter.color) return { ...(filter.graphics ?? {}) };
    const out = {};
    for (const step of filter.steps) {
        for (const [name, g] of Object.entries(filterGraphics(step.filter))) if (!(name in out)) out[name] = g;
    }
    return out;
}

/** `["mask", "overlay"]` or `{ "mask": { "description": "…" } }` → the object form. */
function normalizeImages(images, params) {
    const list = Array.isArray(images) ? Object.fromEntries(images.map((name) => [name, {}])) : images;
    if (!list || typeof list !== 'object') throw new Error('"images" is a list of names, or an object of name → { description }');
    const out = {};
    for (const [name, spec] of Object.entries(list)) {
        if (!NAME.test(name) || name.startsWith('mz_')) throw new Error(`Image name "${name}" must be letters, digits and _, starting with a letter`);
        if (name === 'source') throw new Error('"source" is always available: the picture the chain started from');
        if (RESERVED.has(name)) throw new Error(`"${name}" is already defined in every filter; pick another image name`);
        if (name in params) throw new Error(`"${name}" is both a parameter and an image`);
        out[name] = normalizeImage(name, spec);
    }
    return out;
}

/** `{ description, place, zoom, x, y, angle }` — only what is given; the rest is PLACEMENT. */
function normalizeImage(name, spec) {
    if (!isObject(spec)) throw new Error(`Image "${name}": give { description, place, zoom, x, y, angle }`);
    const out = {};
    if (spec.description) out.description = String(spec.description);
    if (spec.place !== undefined) {
        if (!PLACES.includes(spec.place)) throw new Error(`Image "${name}": "place" is ${PLACES.join(', ')} — not "${spec.place}"`);
        out.place = spec.place;
    }
    for (const key of ['zoom', 'x', 'y', 'angle']) {
        if (spec[key] === undefined) continue;
        const value = Number(spec[key]);
        if (!Number.isFinite(value)) throw new Error(`Image "${name}": "${key}" is a number`);
        out[key] = value;
    }
    for (const key of Object.keys(spec)) if (!['description', 'place', 'zoom', 'x', 'y', 'angle'].includes(key)) throw new Error(`Image "${name}": no such setting "${key}"`);
    return out;
}

function normalizeStep(step) {
    if (typeof step === 'string') return { filter: normalizeFilter(step), with: {}, opacity: 1, skip: false };
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('A step is an expression, a filter, or { "filter": …, "with": { … }, "opacity": … }');
    const { filter, with: settings, opacity, skip, ...rest } = step;
    const out = { filter: normalizeFilter(filter !== undefined ? filter : rest), with: {}, opacity: 1, skip: Boolean(skip) };
    if (settings !== undefined) {
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('"with" is an object of parameter name → value');
        out.with = { ...settings };
    }
    if (opacity !== undefined) {
        const value = Number(opacity);
        if (!(value >= 0 && value <= 1)) throw new Error('"opacity" is a number from 0 to 1');
        out.opacity = value;
    }
    return out;
}

function normalizeParams(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('"params" is an object of name → { default, min, max }');
    const out = {};
    for (const [name, spec] of Object.entries(params)) {
        if (!NAME.test(name)) throw new Error(`Parameter name "${name}" must be letters, digits and _, starting with a letter`);
        if (RESERVED.has(name)) throw new Error(`"${name}" is already defined in every filter; pick another parameter name`);
        out[name] = normalizeParam(name, spec);
    }
    return out;
}

/** `0.5` → a number 0–1; `[1, 0, 0]` → a colour; or the full `{ type, default, min, max, step, label }`. */
function normalizeParam(name, spec) {
    if (typeof spec === 'number') spec = { default: spec };
    else if (Array.isArray(spec)) spec = { type: 'color', default: spec };
    else if (!spec || typeof spec !== 'object') throw new Error(`Parameter "${name}" needs a default value`);
    const type = spec.type ?? (Array.isArray(spec.default) ? 'color' : 'number');
    const out = { type };
    if (spec.label !== undefined) out.label = String(spec.label);
    if (type === 'color') {
        const value = spec.default ?? [1, 1, 1];
        if (!isColor(value)) throw new Error(`Colour parameter "${name}" needs a default of three numbers, 0–1`);
        out.default = value.map(Number);
        return out;
    }
    if (type !== 'number') throw new Error(`Parameter "${name}": the type is "number" or "color", not "${type}"`);
    // `options`: a choice of values (a menu); `input: "box"`: typed in, as maths; otherwise a slider
    let options = null;
    if (spec.options !== undefined) {
        if (!Array.isArray(spec.options) || !spec.options.length || !spec.options.every((n) => n !== '' && Number.isFinite(Number(n)))) throw new Error(`Parameter "${name}": "options" is a list of numbers`);
        options = spec.options.map(Number);
    }
    if (spec.input !== undefined && spec.input !== 'slider' && spec.input !== 'box') throw new Error(`Parameter "${name}": "input" is "slider" or "box", not "${spec.input}"`);
    const value = Number(spec.default ?? (options ? options[0] : 0));
    if (!Number.isFinite(value)) throw new Error(`Parameter "${name}" needs a numeric default`);
    out.default = value;
    out.min = spec.min !== undefined ? Number(spec.min) : options ? Math.min(...options, value) : Math.min(0, value * 2);
    out.max = spec.max !== undefined ? Number(spec.max) : options ? Math.max(...options, value) : Math.max(1, value * 2);
    if (spec.step !== undefined) out.step = Number(spec.step);
    if (options) out.options = options;
    if (spec.input === 'box' && !options) out.input = 'box';
    if (!(out.min <= value && value <= out.max)) throw new Error(`Parameter "${name}": the default ${value} is outside ${out.min} to ${out.max}`);
    return out;
}

function normalizeColor(color) {
    if (typeof color === 'string') {
        if (!color.trim()) throw new Error('"color" is empty');
        return color.trim();
    }
    if (!color || typeof color !== 'object' || Array.isArray(color)) throw new Error('"color" is an expression, or an object with r, g, b, a, rgb or rgba expressions');
    const out = {};
    for (const [channel, expression] of Object.entries(color)) {
        if (!CHANNELS.includes(channel)) throw new Error(`"color" can set r, g, b, a, rgb or rgba — not "${channel}"`);
        if (typeof expression !== 'string' || !expression.trim()) throw new Error(`"color.${channel}" must be an expression`);
        out[channel] = expression.trim();
    }
    if (!Object.keys(out).length) throw new Error('"color" sets no channels');
    return out;
}

/** Every picture a filter needs, including those of the filters inside a chain (first description wins). */
function filterImages(filter) {
    if (filter.color) return { ...(filter.images ?? {}) };
    const out = {};
    for (const step of filter.steps) {
        for (const [name, image] of Object.entries(filterImages(step.filter))) if (!(name in out)) out[name] = image;
    }
    return out;
}

/** Every parameter a filter exposes, including those of the filters inside a chain (first one wins). */
function filterParams(filter) {
    if (filter.color) return { ...(filter.params ?? {}) };
    const out = {};
    for (const step of filter.steps) {
        for (const [name, param] of Object.entries(filterParams(step.filter))) if (!(name in out)) out[name] = param;
    }
    return out;
}

// ---- checking -------------------------------------------------------------

/** Every problem with a filter, as messages; empty when it will compile. */
function validateFilter(def) {
    let filter;
    try { filter = normalizeFilter(def); } catch (e) { return [e.message]; }
    const problems = [];
    check({ filter, with: {}, opacity: 1 }, [], problems, true);
    return problems;
}

/** Settings problems, and — with `shaders` — whether each expression compiles (compileFilter() learns that as it builds). */
function check(step, path, problems, shaders) {
    const { filter } = step;
    const where = describe(filter, path);
    const params = filterParams(filter);
    const images = filterImages(filter);
    const graphics = filterGraphics(filter);
    for (const [name, value] of Object.entries(step.with)) {
        if (name in graphics) {                                 // changing a graphic: { text, x, color, … }
            if (!isObject(value)) problems.push(`${where}: "with" for the graphic "${name}" is an object of its settings`);
            else try { normalizeGraphic(name, { ...graphics[name], ...value }); } catch (e) { problems.push(`${where}: ${e.message}`); }
            continue;
        }
        if (name in images) {                                   // placing a picture: { place, zoom, x, y, angle }
            try { normalizeImage(name, value); } catch (e) { problems.push(`${where}: ${e.message}`); }
            continue;
        }
        const param = params[name];
        if (!param) problems.push(`${where}: "with" sets "${name}", but there is no parameter called that`);
        else if (param.type === 'color' ? !isColor(value) : !Number.isFinite(Number(value))) {
            problems.push(`${where}: "${name}" should be a ${param.type === 'color' ? 'colour: three numbers, 0–1' : 'number'}`);
        }
    }
    if (filter.steps) {
        filter.steps.forEach((inner, i) => check(inner, [...path, i], problems, shaders));
        return;
    }
    if (shaders) try { makePass(filter, Object.fromEntries(Object.entries(step.with).filter(([k]) => k in (filter.graphics ?? {}))), 1, path, 100); } catch (e) { problems.push(`${where}: ${e.message}`); }   // with its settings: a "with" may add shadow layers
}

function describe(filter, path) {
    if (filter.name) return `"${filter.name}"`;
    return path.length ? `step ${path.map((i) => i + 1).join('.')}` : 'the filter';
}

// ---- compiling ------------------------------------------------------------

/**
 * A filter flattened into shader passes, in order. Each pass has the
 * fragment shader, its `params` (declared as uniforms), the `values` to
 * set them to, the `images` it samples (`source` among them when used)
 * with how each is placed (`placements`: place, zoom, x, y, angle — live,
 * like `values`), and an `opacity` (how much of the result shows over the
 * pass's input). A chain used at partial opacity keeps its input
 * (`keepInput`) and ends with a blend pass (`blendKept`).
 *
 * @param {string|object} def
 * @param {{ version?: 100|300 }} [options]
 * @returns {{ name, author, description, version, passes, credits }}
 */
function compileFilter(def, options = {}) {
    const filter = normalizeFilter(def);
    const problems = [];
    check({ filter, with: {}, opacity: 1 }, [], problems, false);
    if (problems.length) throw new Error(problems.join('\n'));
    const context = { passes: [], credits: [], problems, version: options.version === 300 ? 300 : 100, top: filter, graphics: {} };
    flatten({ filter, with: {}, opacity: 1, skip: false }, [], {}, context);
    if (problems.length) throw new Error(problems.join('\n'));
    if (!context.passes.length) {                                // every step skipped: the picture as it is
        context.passes.push(makePass(normalizeFilter('pixel(px, py)'), {}, 1, [], context.version));
    }
    return {
        name: filter.name ?? '',
        author: filter.author ?? '',
        description: filter.description ?? '',
        version: context.version,
        passes: context.passes,
        credits: context.credits,
        images: filterImages(filter),
        graphics: context.graphics,              // key → spec as drawn (with the chain's settings); pass.bind maps a pass's names to keys
    };
}

function flatten(step, path, outer, context) {
    if (step.skip) return;                                       // switched off: no passes, no credit
    const rewritten = inColourSpace(step.filter) ?? separableBlur(step.filter);
    if (rewritten) {
        if (step.filter === context.top) context.top = rewritten;     // still the filter itself, not something it uses
        flatten({ ...step, filter: rewritten }, path, outer, context);
        return;
    }
    const { filter } = step;
    const settings = { ...step.with, ...outer };     // whoever combines decides: outer settings win
    for (const key of Object.keys(outer)) if (isObject(outer[key]) && isObject(step.with[key])) settings[key] = { ...step.with[key], ...outer[key] };
    if (filter.name && filter !== context.top && !context.credits.some((c) => c.name === filter.name && c.author === (filter.author ?? ''))) {
        context.credits.push({ name: filter.name, author: filter.author ?? '' });
    }
    if (filter.color) {
        try { context.passes.push(bindGraphics$1(makePass(filter, settings, step.opacity, path, context.version), context.graphics)); }
        catch (e) { context.problems.push(`${describe(filter, path)}: ${e.message}`); }
        return;
    }
    const start = context.passes.length;
    filter.steps.forEach((inner, i) => flatten(inner, [...path, i], settings, context));
    if (step.opacity < 1) {
        // mix(c, mix(c, f, a), b) is mix(c, f, ab): one pass can just fade more.
        if (context.passes.length - start === 1) context.passes[start].opacity *= step.opacity;
        else {
            context.passes[start].keepInput += 1;
            context.passes.push(blendPass(step.opacity, path, context.version));
        }
    }
}

/**
 * A step whose whole colour is just `gaussian(s)` or `blur(r)` is computed
 * separably — one pass along x, one along y: the same blur for 2n taps
 * instead of n², and reaching further (±24 pixels instead of ±8). The
 * step keeps its name, params, pictures and opacity; the two passes share
 * its settings.
 */
/**
 * A filter with a `space` becomes a chain: convert the frame into the
 * space (its values, kept 0–1, go through the texture between passes),
 * the filter itself — told the space, so pictures it samples are
 * converted too — then convert back. Opacity blends the result over
 * the input in sRGB, as any chain's does.
 */
function inColourSpace(filter) {
    if (!filter.space || typeof filter.color === 'undefined') return null;
    const { space, name, author, description, ...core } = filter;     // the chain carries the name; the middle step is nameless, so it is not a credit
    const step = (f) => ({ filter: f, with: {}, opacity: 1, skip: false });
    const steps = [];
    if (space.in !== 'srgb') steps.push(step({ format: FILTER_FORMAT, color: { rgb: `to${space.in}(rgb)` } }));
    steps.push(step({ ...core, _space: space.in }));
    if (space.out !== 'srgb') steps.push(step({ format: FILTER_FORMAT, color: { rgb: `from${space.out}(rgb)` } }));
    const chain = { format: FILTER_FORMAT, steps };
    for (const [key, value] of Object.entries({ name, author, description })) if (value) chain[key] = value;
    return chain;
}

function separableBlur(filter) {
    if (typeof filter.color !== 'string') return null;
    const m = /^(gaussian|blur)\((.*)\)$/s.exec(filter.color.trim());
    if (!m) return null;
    let depth = 0;
    for (const ch of m[2]) {                                     // the brackets must belong to this one call: not "gaussian(2) + blur(3)"
        if (ch === '(') depth++;
        else if (ch === ')' && --depth < 0) return null;
    }
    if (depth !== 0) return null;
    const { color, ...rest } = filter;
    const half = (axis) => {
        const inner = { format: FILTER_FORMAT, color: `${m[1]}${axis}(${m[2]})` };
        if (rest.params) inner.params = rest.params;
        if (rest.images) inner.images = rest.images;
        if (rest.graphics) inner.graphics = rest.graphics;
        return { filter: inner, with: {}, opacity: 1, skip: false };
    };
    return { ...rest, steps: [half('x'), half('y')] };
}

/**
 * Pictures are shared by name across a chain (every step asking for `mask` gets the
 * same one), but a graphic belongs to its step: two steps that both call their text
 * `title` draw two different texts. So each pass's graphic gets a key of its own —
 * `title`, then `title~2`… — the picture is drawn and bound under the key, and
 * `pass.bind` says which key a name in that pass means.
 */
function bindGraphics$1(pass, all) {
    pass.bind = {};
    for (const [name, spec] of Object.entries(pass.graphics ?? {})) {
        let key = name;
        for (let n = 2; key in all && JSON.stringify(all[key]) !== JSON.stringify(spec); n++) key = `${name}~${n}`;
        all[key] = spec;
        pass.bind[name] = key;
    }
    return pass;
}

function makePass(filter, settings, opacity, path, version) {
    const params = filter.params ?? {};
    const values = {};
    for (const [name, param] of Object.entries(params)) {
        if (!(name in settings)) values[name] = param.default;
        else values[name] = param.type === 'color' ? settings[name].map(Number) : Number(settings[name]);
    }
    const placements = {};
    for (const [name, spec] of Object.entries(filter.images ?? {})) {
        const { description, ...declared } = spec;
        placements[name] = { ...PLACEMENT, ...declared, ...(isObject(settings[name]) ? settings[name] : {}) };
    }
    // A graphic is a frame-sized picture the page (or renderGraphics) draws: stretched, so it lies exactly on the frame.
    const graphics = {};
    for (const [name, spec] of Object.entries(filter.graphics ?? {})) {
        graphics[name] = isObject(settings[name]) ? normalizeGraphic(name, { ...spec, ...settings[name] }) : spec;
        placements[name] = { ...PLACEMENT, place: 'stretch' };
        shadowLayerNames(name, graphics[name]).forEach((layer, k) => {             // each shadow layer: a picture of its own
            graphics[layer] = { ...graphics[name], onlyShadow: k };
            placements[layer] = { ...PLACEMENT, place: 'stretch' };
        });
    }
    const fragment = shaderFor(filter, version, placements);
    const images = Object.keys(placements);
    if (fragment.includes('uniform sampler2D mz_img_source;')) images.push('source');
    if (fragment.includes('uniform sampler2D mz_img_selection;')) images.push('selection');
    // `color` is the filter's own expression(s): the CPU runner compiles that, the GPU runner the fragment shader.
    return { name: filter.name ?? '', author: filter.author ?? '', path, color: filter.color, space: filter._space ?? 'srgb', fragment, params, values, opacity, images, placements, graphics, keepInput: 0, blendKept: false };
}

function shaderFor(filter, version, placements = null) {
    const params = filter.params ?? {};
    const uniforms = {};
    for (const [name, param] of Object.entries(params)) uniforms[name] = param.type === 'color' ? 'vec3' : 'float';
    const images = {};
    for (const [name, spec] of Object.entries(filter.images ?? {})) images[name] = { place: placements?.[name]?.place ?? spec.place ?? PLACEMENT.place };
    for (const [name, spec] of Object.entries(filter.graphics ?? {})) {
        images[name] = { place: 'stretch' };
        // its shadow layers: as compiled (a chain's "with" may add some), or as the filter has them when only checking
        const layers = placements ? Object.keys(placements).filter((k) => /_shadow\d+$/.test(k) && k.startsWith(`${name}_shadow`)) : shadowLayerNames(name, spec);
        for (const layer of layers) images[layer] = { place: 'stretch' };
    }
    return filterShader(filter.color, { version, uniforms, values: Object.keys(params), images, blend: true, space: filter._space ?? filter.space?.in ?? 'srgb' });
}

/** Mixes the pass before it (`image`) over the input a chain started from (`base`). */
function blendPass(opacity, path, version) {
    const es3 = version === 300;
    const sample = es3 ? 'texture' : 'texture2D';
    const fragment = [
        es3 ? '#version 300 es' : '',
        'precision highp float;',
        'uniform sampler2D image;',
        'uniform sampler2D base;',
        'uniform vec2 resolution;',
        'uniform float mz_opacity;',
        es3 ? 'out vec4 fragColor;' : '',
        'void main() {',
        '    vec2 uv = gl_FragCoord.xy / resolution;',
        `    ${es3 ? 'fragColor' : 'gl_FragColor'} = mix(${sample}(base, uv), ${sample}(image, uv), mz_opacity);`,
        '}',
    ].filter(Boolean).join('\n');
    return { name: 'blend', author: '', path, fragment, params: {}, values: {}, opacity, images: [], placements: {}, graphics: {}, keepInput: 0, blendKept: true };
}

// ---- passing filters around ----------------------------------------------

/** The filter as JSON to publish: normalized, with defaults left out. */
function filterToJSON(def) {
    return JSON.stringify(tidy(normalizeFilter(def), true), null, 2);
}

function filterFromJSON(text) {
    let raw;
    try { raw = JSON.parse(text); } catch { throw new Error('Not valid JSON'); }
    return normalizeFilter(raw);
}

/** `base + '#' + the filter`, URL-safe; `base` is the page that opens it. */
function filterToLink(def, base = '') {
    return `${base}#${toBase64Url(JSON.stringify(tidy(normalizeFilter(def), true)))}`;
}

function filterFromLink(text) {
    const hash = text.includes('#') ? text.slice(text.lastIndexOf('#') + 1) : text;
    let raw;
    try { raw = JSON.parse(fromBase64Url(hash.trim())); } catch { throw new Error('Not a filter link'); }
    return normalizeFilter(raw);
}

/** A filter from whatever someone pasted: JSON, a share link, or a bare expression. */
function readFilter(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) throw new Error('Nothing to read');
    if (trimmed.startsWith('{')) return filterFromJSON(trimmed);
    if (!/\s/.test(trimmed)) {
        const hash = trimmed.includes('#') ? trimmed.slice(trimmed.lastIndexOf('#') + 1) : trimmed;
        if (/^[A-Za-z0-9_-]{8,}$/.test(hash)) {
            try { return filterFromLink(hash); } catch (e) { if (trimmed.includes('#')) throw e; }
        }
    }
    return normalizeFilter(trimmed);
}

/** The normalized filter with defaults dropped: `with: {}`, `opacity: 1`, inner `format`s, and `{ color }` alone becomes its string. */
function tidy(filter, top) {
    const out = {};
    if (top) out.format = FILTER_FORMAT;
    for (const key of ['name', 'author', 'description']) if (filter[key]) out[key] = filter[key];
    if (filter.notes && filter.notes.length) out.notes = filter.notes;
    if (filter.steps) {
        out.steps = filter.steps.map((step) => {
            const inner = tidy(step.filter, false);
            const bare = Object.keys(inner).length === 1 && typeof inner.color === 'string' ? inner.color : inner;
            const extras = {};
            if (Object.keys(step.with).length) extras.with = step.with;
            if (step.opacity !== 1) extras.opacity = step.opacity;
            if (step.skip) extras.skip = true;
            return Object.keys(extras).length ? { filter: bare, ...extras } : bare;
        });
        return out;
    }
    if (filter.params) out.params = filter.params;
    if (filter.images) out.images = filter.images;
    if (filter.graphics) out.graphics = filter.graphics;
    if (filter.space) out.space = filter.space.in === filter.space.out ? filter.space.in : filter.space;
    out.color = filter.color;
    return out;
}

function toBase64Url(text) {
    let binary = '';
    for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/**
 * Runs a compiled filter (compileFilter()) in WebGL: uploads the picture,
 * draws each pass into a texture, and the last one onto the canvas.
 *
 *   const runner = createFilterRunner(gl, compileFilter(def));
 *   runner.setImage(imageOrVideoOrCanvas);
 *   runner.setImage('mask', maskImage);          // each picture the filter names (compiled.images)
 *   runner.draw({ t: frameIndex });
 *   runner.passes[0].values.cutoff = 0.3;    // knobs change without recompiling
 *   runner.dispose();
 *
 * Works with WebGL 1 and 2 (`compileFilter(def, { version: 300 })` for
 * the latter). The output is the size of the canvas; the picture is
 * stretched to it, so size the canvas to the picture.
 *
 * Between passes the picture lives in 8-bit textures, so values clamp
 * to 0–1 and round to 1/255 at each step. `{ precision: 'half' }` or
 * `'float'` keeps more (bloom's bright spill, edge strengths over 1)
 * where the GPU can render to such textures; `runner.precision` says
 * what was granted.
 */

function createFilterRunner(gl, compiled, options = {}) {
    if (gl.isContextLost()) throw new Error('The WebGL context is lost');
    const precision = texturePrecision(gl, options.precision);
    const vertex = filterVertexShader({ version: compiled.version });
    const programs = compiled.passes.map((pass) => link(gl, vertex, pass.fragment, pass.name));
    const locations = programs.map(() => new Map());
    const location = (i, name) => {
        if (!locations[i].has(name)) locations[i].set(name, gl.getUniformLocation(programs[i], name));
        return locations[i].get(name);
    };

    const triangle = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);   // one triangle covers the canvas

    const source = { texture: gl.createTexture(), framebuffer: null };
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    clampAndFilter(gl);
    const pictures = new Map();                                   // name → texture, for compiled.images
    const sizes = new Map();                                      // name → [width, height] of that picture
    const blank = gl.createTexture();                             // a picture not yet given: white, 1×1
    gl.bindTexture(gl.TEXTURE_2D, blank);
    clampAndFilter(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    const clear = gl.createTexture();                             // a graphic not yet drawn: transparent, 1×1
    gl.bindTexture(gl.TEXTURE_2D, clear);
    clampAndFilter(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    const pool = [];           // textures passes draw into, reused between frames
    let width = 0;
    let height = 0;

    function buffer(exclude) {
        let found = pool.find((b) => !exclude.includes(b));
        if (!found) {
            found = { texture: gl.createTexture(), framebuffer: gl.createFramebuffer() };
            gl.bindTexture(gl.TEXTURE_2D, found.texture);
            clampAndFilter(gl, precision.filter);
            gl.texImage2D(gl.TEXTURE_2D, 0, precision.internal, width, height, 0, gl.RGBA, precision.type, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, found.framebuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, found.texture, 0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE && precision.name !== 'byte') {
                Object.assign(precision, texturePrecision(gl, 'byte'));     // this GPU won't render to it after all
                gl.bindTexture(gl.TEXTURE_2D, found.texture);
                clampAndFilter(gl, precision.filter);
                gl.texImage2D(gl.TEXTURE_2D, 0, precision.internal, width, height, 0, gl.RGBA, precision.type, null);
            }
            pool.push(found);
        }
        return found;
    }

    const runner = {
        /** The passes with their live `values`; change one and the next draw uses it. */
        passes: compiled.passes,
        /** 'byte', 'half' or 'float': what the textures between passes hold. */
        get precision() { return precision.name; },

        /**
         * Uploads a picture: an <img>, <video>, <canvas> or ImageData. Call
         * again for each video frame. With a name first, it is one of the
         * pictures the filter asks for (`compiled.images`); `source` is the
         * main picture itself.
         */
        setImage(name, image) {
            if (typeof name !== 'string') { image = name; name = null; }
            if (name && name !== 'source' && image == null) {             // setImage(name, null): back to "not given" (white)
                if (pictures.has(name)) gl.deleteTexture(pictures.get(name));
                pictures.delete(name);
                sizes.delete(name);
                return runner;
            }
            let texture = source.texture;
            if (name && name !== 'source') {
                if (!pictures.has(name)) {
                    pictures.set(name, gl.createTexture());
                    gl.bindTexture(gl.TEXTURE_2D, pictures.get(name));
                    clampAndFilter(gl);
                }
                texture = pictures.get(name);
            }
            // a plain picture { data, width, height } (what the CPU runner and Node give; floats are 0–1): as ImageData
            if (image && image.data && image.width && image.height && typeof ImageData !== 'undefined' && !(image instanceof ImageData)) {
                const src = image.data, float = src instanceof Float32Array || src instanceof Float64Array;
                const bytes = src instanceof Uint8ClampedArray ? src : Uint8ClampedArray.from(src, float ? (v) => v * 255 : undefined);
                image = new ImageData(bytes, image.width, image.height);
            }
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);          // so y = 0 is the top, as in the picture
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            if (name) sizes.set(name, [image.naturalWidth || image.videoWidth || image.width || 1, image.naturalHeight || image.videoHeight || image.height || 1]);
            return runner;
        },

        /** Draws the filtered picture onto the canvas; `t` is the frame index. */
        draw({ t = 0 } = {}) {
            if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) {
                width = gl.drawingBufferWidth;
                height = gl.drawingBufferHeight;
                for (const b of pool) {
                    gl.bindTexture(gl.TEXTURE_2D, b.texture);
                    gl.texImage2D(gl.TEXTURE_2D, 0, precision.internal, width, height, 0, gl.RGBA, precision.type, null);
                }
            }
            let input = source;
            const kept = [];                   // inputs of chains still waiting for their blend pass
            compiled.passes.forEach((pass, i) => {
                for (let k = 0; k < pass.keepInput; k++) kept.push(input);
                const last = i === compiled.passes.length - 1;
                const target = last ? null : buffer([input, ...kept]);
                gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
                gl.viewport(0, 0, width, height);
                const program = programs[i];
                gl.useProgram(program);
                const position = gl.getAttribLocation(program, 'position');
                gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
                gl.enableVertexAttribArray(position);
                gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, input.texture);
                gl.uniform1i(location(i, 'image'), 0);
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, pass.blendKept ? kept[kept.length - 1].texture : null);
                if (pass.blendKept) gl.uniform1i(location(i, 'base'), 1);
                pass.images.forEach((name, k) => {
                    gl.activeTexture(gl.TEXTURE2 + k);
                    gl.bindTexture(gl.TEXTURE_2D, name === 'source' ? source.texture : (pictures.get(pass.bind?.[name] ?? name) ?? (pass.graphics?.[name] ? clear : blank)));
                    gl.uniform1i(location(i, `mz_img_${name}`), 2 + k);
                    if (!pass.placements[name]) return;                              // source, selection: the frame's size, no placement
                    const size = sizes.get(pass.bind?.[name] ?? name) ?? [1, 1];
                    const place = pass.placements[name];
                    gl.uniform2f(location(i, `mz_size_${name}`), size[0], size[1]);
                    gl.uniform4f(location(i, `mz_place_${name}`), Number(place.zoom), Number(place.x), Number(place.y), Number(place.angle));
                });
                gl.uniform2f(location(i, 'resolution'), width, height);
                gl.uniform1f(location(i, 't'), t);
                gl.uniform1f(location(i, 'mz_opacity'), pass.opacity);
                for (const [name, param] of Object.entries(pass.params)) {
                    const value = pass.values[name];
                    if (param.type === 'color') gl.uniform3fv(location(i, name), value.map(Number));
                    else gl.uniform1f(location(i, name), Number(value));
                }
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                if (pass.blendKept) kept.pop();
                input = target;
            });
            return runner;
        },

        dispose() {
            for (const program of programs) gl.deleteProgram(program);
            gl.deleteTexture(source.texture);
            gl.deleteTexture(blank);
            gl.deleteTexture(clear);
            for (const texture of pictures.values()) gl.deleteTexture(texture);
            for (const b of pool) { gl.deleteTexture(b.texture); gl.deleteFramebuffer(b.framebuffer); }
            gl.deleteBuffer(triangle);
        },
    };
    return runner;
}

function clampAndFilter(gl, filter = gl.LINEAR) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
}

/** The texture format for the pictures between passes: 8-bit unless asked for and available. */
function texturePrecision(gl, wanted = 'byte') {
    const byte = { name: 'byte', internal: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR };
    if (wanted !== 'half' && wanted !== 'float') return byte;
    const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    if (webgl2) {
        if (!gl.getExtension('EXT_color_buffer_float')) return byte;
        const linear = gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST;
        return wanted === 'float'
            ? { name: 'float', internal: gl.RGBA32F, type: gl.FLOAT, filter: linear }
            : { name: 'half', internal: gl.RGBA16F, type: gl.HALF_FLOAT, filter: gl.LINEAR };
    }
    if (wanted === 'float' && gl.getExtension('OES_texture_float') && gl.getExtension('WEBGL_color_buffer_float')) {
        return { name: 'float', internal: gl.RGBA, type: gl.FLOAT, filter: gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST };
    }
    const half = gl.getExtension('OES_texture_half_float');
    if (half && gl.getExtension('EXT_color_buffer_half_float')) {
        return { name: 'half', internal: gl.RGBA, type: half.HALF_FLOAT_OES, filter: gl.getExtension('OES_texture_half_float_linear') ? gl.LINEAR : gl.NEAREST };
    }
    return byte;
}

function link(gl, vertex, fragment, name) {
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(`${name || 'The filter'} does not compile: ${gl.getShaderInfoLog(shader).trim()}`);
        }
        gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`${name || 'The filter'} does not link: ${gl.getProgramInfoLog(program).trim()}`);
    return program;
}

/**
 * What the generated CPU filter code calls: sampling the picture the way a
 * WebGL texture does, and the neighbourhood functions as whole planes.
 *
 * Pictures are { data: Float32Array RGBA 0–1, width, height }, rows top
 * down. Positions are pixel centres in that frame: (px, py) is pixel px of
 * row py, so sampling there returns that pixel exactly and a fractional
 * position blends the four around it (bilinear, edges clamped) — what
 * texture2D does with LINEAR filtering and CLAMP_TO_EDGE.
 *
 * Every export that is a function is passed to the generated code as
 * $h_<name>; nothing else is reachable from it.
 */


const BLANK = { data: new Float32Array([1, 1, 1, 1]), width: 1, height: 1 };   // a picture not given yet: white
const CLEAR = { data: new Float32Array([0, 0, 0, 0]), width: 1, height: 1 };   // a graphic not drawn yet: transparent

const PLACE = { cover: 0, fit: 1, stretch: 2, tile: 3 };
function placeCode(place) { return PLACE[place ?? 'cover'] ?? 0; }

function scratch() { return new Float64Array(4); }
/** P[i][k], for colour params (the generated code may not index twice). */
function at$1(P, i, k) { return Number(P[i][k]); }

function fmod(a, b) { return a - b * Math.floor(a / b); }
function smoothstep(e0, e1, x) { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); }
function factorial(n) { let r = 1; for (let i = 2; i <= 170; i++) { if (i > n) break; r *= i; } return r; }
function perm(n, k) { let r = 1; for (let i = 0; i < 170; i++) { if (i >= k) break; r *= n - i; } return r; }
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); for (let i = 0; i < 64; i++) { if (b === 0) break; const t = fmod(a, b); a = b; b = t; } return a; }
function root(n, x) { return n === 2 ? Math.sqrt(x) : n === 3 ? Math.sign(x) * Math.pow(Math.abs(x), 1 / 3) : Math.pow(x, 1 / n); }
/** The shader's hash: a new value per pixel and per call, seeded with t. (A GPU's float sin differs, so the values do too.) */
function random(px, py, h, seed) {
    const v = Math.sin((px + 0.5) * 12.9898 + (h - py - 0.5) * 78.233 + seed * 37.719) * 43758.5453;
    return v - Math.floor(v);
}

// ---- sampling --------------------------------------------------------------------

const clampi = (v, max) => (v < 0 ? 0 : v > max ? max : v);

/** Bilinear sample of picture data at pixel-centre position (X, Y), edges clamped, into out[0..3]. */
function sample(D, w, h, X, Y, out) {
    const x0f = Math.floor(X);
    const y0f = Math.floor(Y);
    const fx = X - x0f;
    const fy = Y - y0f;
    const x0 = clampi(x0f, w - 1), x1 = clampi(x0f + 1, w - 1);
    const y0 = clampi(y0f, h - 1), y1 = clampi(y0f + 1, h - 1);
    const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
    for (let k = 0; k < 4; k++) {
        const top = D[i00 + k] + (D[i10 + k] - D[i00 + k]) * fx;
        const bottom = D[i01 + k] + (D[i11 + k] - D[i01 + k]) * fx;
        out[k] = top + (bottom - top) * fy;
    }
    return out;
}

/** As sample(), but transparent black outside the picture (the shader's mz_at_image). */
function sampleOrZero(D, w, h, X, Y, out) {
    const qx = X + 0.5;
    const qy = Y + 0.5;
    if (qx < 0 || qy < 0 || qx > w || qy > h) { out[0] = out[1] = out[2] = out[3] = 0; return out; }
    return sample(D, w, h, X, Y, out);
}

/**
 * A named picture laid over the frame (the shader's mz_sample_<name>): scaled by `place`
 * (0 cover, 1 fit, 2 stretch, 3 tile) times zoom, centred at (x, y) of the frame, turned by
 * angle; transparent outside unless tiled.
 */
function picture(Q, qw, qh, w, h, zoom, x, y, angle, mode, X, Y, out) {
    let sx;
    let sy;
    if (mode === 0) sx = sy = Math.max(w / qw, h / qh);
    else if (mode === 1) sx = sy = Math.min(w / qw, h / qh);
    else if (mode === 2) { sx = w / qw; sy = h / qh; } else sx = sy = 1;
    sx *= zoom;
    sy *= zoom;
    const dx = X + 0.5 - x * w;
    const dy = Y + 0.5 - y * h;
    const co = Math.cos(angle);
    const si = Math.sin(angle);
    let qx = (co * dx + si * dy) / sx + qw * 0.5;
    let qy = (co * dy - si * dx) / sy + qh * 0.5;
    if (mode === 3) { qx = fmod(qx, qw); qy = fmod(qy, qh); }
    else if (qx < 0 || qy < 0 || qx > qw || qy > qh) { out[0] = out[1] = out[2] = out[3] = 0; return out; }
    return sample(Q, qw, qh, qx - 0.5, qy - 0.5, out);
}

// ---- neighbourhoods: whole planes, computed once per pass ------------------------------
//
// Taps are whole-pixel offsets, edges clamped; dy runs downwards. Square windows are done as a
// horizontal pass then a vertical one — the same sums, maxima and weights as the shader's
// double loop, in another order.

/** Offsets -r..r kept by `keep(offset)`, with r = min(max(ceil(limit), 0), reach). */
function offsets(limit, reach, keep) {
    const r = Math.min(Math.max(Math.ceil(limit), 0), reach);
    const out = [];
    for (let i = -r; i <= r; i++) if (keep(i)) out.push(i);
    return out;
}

/**
 * One separable pass over rgb along x or y: a weighted sum over whole-pixel offsets `taps`
 * (edges clamped), divided by `norm`. Tight loops — no closures per tap — since this is where
 * a blur spends its time.
 */
function weighted1D(src, stride, w, h, axis, taps, weights, norm, y0 = 0, y1 = h) {
    const out = new Float32Array(w * h * 3);
    const n = taps.length;
    const T = Int32Array.from(taps);
    const W = Float64Array.from(weights ?? taps.map(() => 1));
    const along = axis === 'x' ? w : h;
    const idx = new Int32Array(n);
    for (let y = y0; y < y1; y++) {
        for (let x = 0; x < w; x++) {
            const pos = axis === 'x' ? x : y;
            for (let t = 0; t < n; t++) {
                let q = pos + T[t];
                q = q < 0 ? 0 : q >= along ? along - 1 : q;
                idx[t] = (axis === 'x' ? y * w + q : q * w + x) * stride;
            }
            let s0 = 0, s1 = 0, s2 = 0;
            for (let t = 0; t < n; t++) { const i = idx[t], wt = W[t]; s0 += src[i] * wt; s1 += src[i + 1] * wt; s2 += src[i + 2] * wt; }
            const o = (y * w + x) * 3;
            out[o] = s0 / norm; out[o + 1] = s1 / norm; out[o + 2] = s2 / norm;
        }
    }
    return out;
}

/** A box along x or y with running sums: the same average whatever the radius costs the same. */
function box1D(src, stride, w, h, axis, lo, hi, y0 = 0, y1 = h) {
    const out = new Float32Array(w * h * 3);
    const along = axis === 'x' ? w : h;
    const lines = axis === 'x' ? h : w;
    const count = hi - lo + 1;
    const at = (line, q) => (axis === 'x' ? line * w + q : q * w + line);
    const clampq = (q) => (q < 0 ? 0 : q >= along ? along - 1 : q);
    // along x: the rows y0..y1, all of each; along y: every column, only positions y0..y1
    const [l0, l1] = axis === 'x' ? [y0, y1] : [0, lines];
    const [p0, p1] = axis === 'x' ? [0, along] : [y0, y1];
    for (let line = l0; line < l1; line++) {
        let s0 = 0, s1 = 0, s2 = 0;
        for (let t = p0 + lo; t <= p0 + hi; t++) { const i = at(line, clampq(t)) * stride; s0 += src[i]; s1 += src[i + 1]; s2 += src[i + 2]; }
        for (let pos = p0; pos < p1; pos++) {
            const o = at(line, pos) * 3;
            out[o] = s0 / count; out[o + 1] = s1 / count; out[o + 2] = s2 / count;
            const drop = at(line, clampq(pos + lo)) * stride;
            const take = at(line, clampq(pos + hi + 1)) * stride;
            s0 += src[take] - src[drop]; s1 += src[take + 1] - src[drop + 1]; s2 += src[take + 2] - src[drop + 2];
        }
    }
    return out;
}

/** Max or min along x or y, edges clamped, starting from `init` (the shader starts dilate at 0, erode at 1). */
function extreme1D(src, stride, w, h, axis, taps, init, isMax, y0 = 0, y1 = h) {
    const out = new Float32Array(w * h * 3);
    const along = axis === 'x' ? w : h;
    for (let y = y0; y < y1; y++) {
        for (let x = 0; x < w; x++) {
            const pos = axis === 'x' ? x : y;
            let m0 = init, m1 = init, m2 = init;
            for (let t = 0; t < taps.length; t++) {
                let q = pos + taps[t];
                q = q < 0 ? 0 : q >= along ? along - 1 : q;
                const i = (axis === 'x' ? y * w + q : q * w + x) * stride;
                if (isMax) { if (src[i] > m0) m0 = src[i]; if (src[i + 1] > m1) m1 = src[i + 1]; if (src[i + 2] > m2) m2 = src[i + 2]; }
                else { if (src[i] < m0) m0 = src[i]; if (src[i + 1] < m1) m1 = src[i + 1]; if (src[i + 2] < m2) m2 = src[i + 2]; }
            }
            const o = (y * w + x) * 3;
            out[o] = m0; out[o + 1] = m1; out[o + 2] = m2;
        }
    }
    return out;
}

const add = (acc, v, wt) => acc + v * wt;
const maxOf = (acc, v) => (v > acc ? v : acc);
const minOf = (acc, v) => (v < acc ? v : acc);

function rgbOf(I, w, h, y0 = 0, y1 = h) {
    const out = new Float32Array(w * h * 3);
    for (let j = y0 * w; j < y1 * w; j++) { out[j * 3] = I[j * 4]; out[j * 3 + 1] = I[j * 4 + 1]; out[j * 3 + 2] = I[j * 4 + 2]; }
    return out;
}

/** Rows the first (horizontal) pass must cover so the vertical pass can read ±reach around y0..y1. */
const widen = (y0, y1, reach, h) => [Math.max(0, y0 - reach), Math.min(h, y1 + reach)];

function boxPlanes(I, w, h, y0, y1, radius, axes, reach) {
    const taps = offsets(radius, reach, (i) => Math.abs(i) <= radius);
    if (!taps.length) return rgbOf(I, w, h, y0, y1);
    const lo = taps[0];
    const hi = taps[taps.length - 1];
    if (axes.length === 1) return box1D(I, 4, w, h, axes[0], lo, hi, y0, y1);
    const [a0, a1] = widen(y0, y1, hi, h);
    return box1D(box1D(I, 4, w, h, 'x', lo, hi, a0, a1), 3, w, h, 'y', lo, hi, y0, y1);
}

function gaussPlanes(I, w, h, y0, y1, sigma, axes, reach) {
    if (!(sigma > 0)) return rgbOf(I, w, h, y0, y1);
    const limit = 3 * sigma;
    const taps = offsets(limit, reach, (i) => Math.abs(i) <= limit);
    const weights = taps.map((i) => Math.exp(-(i * i) / (2 * sigma * sigma)));
    const total = weights.reduce((a, b) => a + b, 0);
    if (axes.length === 1) return weighted1D(I, 4, w, h, axes[0], taps, weights, total, y0, y1);
    const [a0, a1] = widen(y0, y1, taps[taps.length - 1], h);
    return weighted1D(weighted1D(I, 4, w, h, 'x', taps, weights, total, a0, a1), 3, w, h, 'y', taps, weights, total, y0, y1);
}

function extremePlanes(I, w, h, y0, y1, radius, init, isMax) {
    const taps = offsets(radius, REACH.square, (i) => Math.abs(i) <= radius);
    if (!taps.length) return new Float32Array(w * h * 3).fill(init);
    const [a0, a1] = widen(y0, y1, taps[taps.length - 1], h);
    return extreme1D(extreme1D(I, 4, w, h, 'x', taps, init, isMax, a0, a1), 3, w, h, 'y', taps, init, isMax, y0, y1);
}

function plane_blur(I, w, h, y0, y1, radius) { return boxPlanes(I, w, h, y0, y1, radius, ['x', 'y'], REACH.square); }
function plane_blurx(I, w, h, y0, y1, radius) { return boxPlanes(I, w, h, y0, y1, radius, ['x'], REACH.line); }
function plane_blury(I, w, h, y0, y1, radius) { return boxPlanes(I, w, h, y0, y1, radius, ['y'], REACH.line); }
function plane_gaussian(I, w, h, y0, y1, sigma) { return gaussPlanes(I, w, h, y0, y1, sigma, ['x', 'y'], REACH.square); }
function plane_gaussianx(I, w, h, y0, y1, sigma) { return gaussPlanes(I, w, h, y0, y1, sigma, ['x'], REACH.line); }
function plane_gaussiany(I, w, h, y0, y1, sigma) { return gaussPlanes(I, w, h, y0, y1, sigma, ['y'], REACH.line); }
function plane_dilate(I, w, h, y0, y1, radius) { return extremePlanes(I, w, h, y0, y1, radius, 0, true); }
function plane_erode(I, w, h, y0, y1, radius) { return extremePlanes(I, w, h, y0, y1, radius, 1, false); }

function plane_sharpen(I, w, h, y0, y1, amount) {
    const out = new Float32Array(w * h * 3);
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) {
        const t = (xx, yy) => (clampi(yy, h - 1) * w + clampi(xx, w - 1)) * 4;
        const c = t(x, y), l = t(x - 1, y), r = t(x + 1, y), u = t(x, y - 1), d = t(x, y + 1);
        for (let k = 0; k < 3; k++) out[(y * w + x) * 3 + k] = I[c + k] + amount * (4 * I[c + k] - I[l + k] - I[r + k] - I[u + k] - I[d + k]);
    }
    return out;
}

function lumaPlane(I, w, h) {
    const L = new Float32Array(w * h);
    for (let j = 0; j < w * h; j++) L[j] = I[j * 4] * 0.299 + I[j * 4 + 1] * 0.587 + I[j * 4 + 2] * 0.114;
    return L;
}

function lumaOp(I, w, h, y0, y1, fn) {
    const L = lumaPlane(I, w, h);
    const out = new Float32Array(w * h);
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) {
        const at = (dx, dy) => L[clampi(y + dy, h - 1) * w + clampi(x + dx, w - 1)];
        out[y * w + x] = fn(at);
    }
    return out;
}

const SOBELX = (L) => (L(1, -1) + 2 * L(1, 0) + L(1, 1)) - (L(-1, -1) + 2 * L(-1, 0) + L(-1, 1));
const SOBELY = (L) => (L(-1, 1) + 2 * L(0, 1) + L(1, 1)) - (L(-1, -1) + 2 * L(0, -1) + L(1, -1));
const LAPLACIAN = (L) => 4 * L(0, 0) - L(-1, 0) - L(1, 0) - L(0, -1) - L(0, 1);
const EMBOSS = (L) => 0.5 + L(-1, -1) - L(1, 1);
const SOBEL = (L) => Math.hypot(SOBELX(L), SOBELY(L));

function plane_sobelx(I, w, h, y0, y1) { return lumaOp(I, w, h, y0, y1, SOBELX); }
function plane_sobely(I, w, h, y0, y1) { return lumaOp(I, w, h, y0, y1, SOBELY); }
function plane_sobel(I, w, h, y0, y1) { return lumaOp(I, w, h, y0, y1, SOBEL); }
function plane_laplacian(I, w, h, y0, y1) { return lumaOp(I, w, h, y0, y1, LAPLACIAN); }
function plane_emboss(I, w, h, y0, y1) { return lumaOp(I, w, h, y0, y1, EMBOSS); }

// ---- the same at one pixel, for an argument that changes from pixel to pixel ---------------

function window2D(I, w, h, px, py, taps, weightOf, init, combine, out, finish) {
    for (let k = 0; k < 3; k++) {
        let acc = init;
        let total = 0;
        for (const i of taps) for (const j of taps) {
            const wt = weightOf ? weightOf(i, j) : 1;
            acc = combine(acc, I[(clampi(py + j, h - 1) * w + clampi(px + i, w - 1)) * 4 + k], wt);
            total += wt;
        }
        out[k] = finish ? finish(acc, total) : acc;
    }
    return out;
}

function window1D(I, w, h, px, py, axis, taps, weightOf, out) {
    for (let k = 0; k < 3; k++) {
        let acc = 0;
        let total = 0;
        for (const i of taps) {
            const wt = weightOf ? weightOf(i) : 1;
            const xx = axis === 'x' ? clampi(px + i, w - 1) : px;
            const yy = axis === 'y' ? clampi(py + i, h - 1) : py;
            acc += I[(yy * w + xx) * 4 + k] * wt;
            total += wt;
        }
        out[k] = acc / total;
    }
    return out;
}

const here = (I, w, px, py, out) => { const c = (py * w + px) * 4; out[0] = I[c]; out[1] = I[c + 1]; out[2] = I[c + 2]; return out; };

function at_blur(I, w, h, px, py, radius, out) {
    return window2D(I, w, h, px, py, offsets(radius, REACH.square, (i) => Math.abs(i) <= radius), null, 0, add, out, (a, n) => a / n);
}
function at_blurx(I, w, h, px, py, radius, out) { return window1D(I, w, h, px, py, 'x', offsets(radius, REACH.line, (i) => Math.abs(i) <= radius), null, out); }
function at_blury(I, w, h, px, py, radius, out) { return window1D(I, w, h, px, py, 'y', offsets(radius, REACH.line, (i) => Math.abs(i) <= radius), null, out); }
function at_gaussian(I, w, h, px, py, sigma, out) {
    if (!(sigma > 0)) return here(I, w, px, py, out);
    const limit = 3 * sigma;
    const g = (i, j) => Math.exp(-(i * i + j * j) / (2 * sigma * sigma));
    return window2D(I, w, h, px, py, offsets(limit, REACH.square, (i) => Math.abs(i) <= limit), g, 0, add, out, (a, n) => a / n);
}
function at_gaussianx(I, w, h, px, py, sigma, out) {
    if (!(sigma > 0)) return here(I, w, px, py, out);
    const limit = 3 * sigma;
    return window1D(I, w, h, px, py, 'x', offsets(limit, REACH.line, (i) => Math.abs(i) <= limit), (i) => Math.exp(-(i * i) / (2 * sigma * sigma)), out);
}
function at_gaussiany(I, w, h, px, py, sigma, out) {
    if (!(sigma > 0)) return here(I, w, px, py, out);
    const limit = 3 * sigma;
    return window1D(I, w, h, px, py, 'y', offsets(limit, REACH.line, (i) => Math.abs(i) <= limit), (i) => Math.exp(-(i * i) / (2 * sigma * sigma)), out);
}
function at_dilate(I, w, h, px, py, radius, out) { return window2D(I, w, h, px, py, offsets(radius, REACH.square, (i) => Math.abs(i) <= radius), null, 0, maxOf, out); }
function at_erode(I, w, h, px, py, radius, out) { return window2D(I, w, h, px, py, offsets(radius, REACH.square, (i) => Math.abs(i) <= radius), null, 1, minOf, out); }
function at_sharpen(I, w, h, px, py, amount, out) {
    const t = (xx, yy) => (clampi(yy, h - 1) * w + clampi(xx, w - 1)) * 4;
    const c = t(px, py), l = t(px - 1, py), r = t(px + 1, py), u = t(px, py - 1), d = t(px, py + 1);
    for (let k = 0; k < 3; k++) out[k] = I[c + k] + amount * (4 * I[c + k] - I[l + k] - I[r + k] - I[u + k] - I[d + k]);
    return out;
}

/** 3×3 kernel, row by row from the top-left (k00 at dx = -1, dy = -1). */
function convolve(I, w, h, px, py, k00, k01, k02, k10, k11, k12, k20, k21, k22, out) {
    const t = (dx, dy) => (clampi(py + dy, h - 1) * w + clampi(px + dx, w - 1)) * 4;
    const taps = [[k00, -1, -1], [k01, 0, -1], [k02, 1, -1], [k10, -1, 0], [k11, 0, 0], [k12, 1, 0], [k20, -1, 1], [k21, 0, 1], [k22, 1, 1]];
    for (let k = 0; k < 3; k++) { let s = 0; for (const [wt, dx, dy] of taps) s += wt * I[t(dx, dy) + k]; out[k] = s; }
    return out;
}

// ---- colour spaces: the shader's to<space> / from<space> (mathzetta render/glsl.js colourGlsl), sRGB on the other side ----
const toLin = (c) => (c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const fromLin = (c) => { c = Math.max(c, 0); return c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };
const hue = (r, g, b, v, d) => { const h = v === r ? (g - b) / d : v === g ? 2 + (b - r) / d : 4 + (r - g) / d; return h / 6 - Math.floor(h / 6); };
const tri = (h, o) => { const k = Math.abs(((h + o) - Math.floor(h + o)) * 6 - 3); return Math.min(Math.max(k - 1, 0), 1); };
function col_tolinear(r, g, b, out) { out[0] = toLin(r); out[1] = toLin(g); out[2] = toLin(b); return out; }
function col_fromlinear(r, g, b, out) { out[0] = fromLin(r); out[1] = fromLin(g); out[2] = fromLin(b); return out; }
function col_tohsv(r, g, b, out) {
    const v = Math.max(r, g, b), d = v - Math.min(r, g, b);
    out[0] = d > 0 ? hue(r, g, b, v, d) : 0; out[1] = v > 0 ? d / v : 0; out[2] = v;
    return out;
}
function col_fromhsv(h, s, v, out) {
    out[0] = v * (1 + (tri(h, 0) - 1) * s); out[1] = v * (1 + (tri(h, 2 / 3) - 1) * s); out[2] = v * (1 + (tri(h, 1 / 3) - 1) * s);
    return out;
}
function col_tohsl(r, g, b, out) {
    const v = Math.max(r, g, b), m = Math.min(r, g, b), d = v - m, l = (v + m) * 0.5;
    out[0] = d > 0 ? hue(r, g, b, v, d) : 0; out[1] = d > 0 ? d / (1 - Math.abs(2 * l - 1)) : 0; out[2] = l;
    return out;
}
function col_fromhsl(h, s, l, out) {
    const C = (1 - Math.abs(2 * l - 1)) * s;
    out[0] = l - C * 0.5 + C * tri(h, 0); out[1] = l - C * 0.5 + C * tri(h, 2 / 3); out[2] = l - C * 0.5 + C * tri(h, 1 / 3);
    return out;
}
function col_toycbcr(r, g, b, out) {
    const y = r * 0.299 + g * 0.587 + b * 0.114;
    out[0] = y; out[1] = 0.5 + (b - y) * 0.5643; out[2] = 0.5 + (r - y) * 0.7132;
    return out;
}
function col_fromycbcr(y, cb, cr, out) {
    cb -= 0.5; cr -= 0.5;
    out[0] = y + 1.402 * cr; out[1] = y - 0.344136 * cb - 0.714136 * cr; out[2] = y + 1.772 * cb;
    return out;
}
const labF = (t) => (t < 0.008856 ? 7.787 * t + 16 / 116 : Math.cbrt(t));
const labFinv = (f) => (f < 0.206893 ? (f - 16 / 116) / 7.787 : f * f * f);
function col_tolab(r, g, b, out) {
    const R = toLin(r), G = toLin(g), B = toLin(b);
    const fx = labF((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
    const fy = labF(0.2126729 * R + 0.7151522 * G + 0.0721750 * B);
    const fz = labF((0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883);
    out[0] = (116 * fy - 16) / 100; out[1] = 0.5 + 500 * (fx - fy) / 256; out[2] = 0.5 + 200 * (fy - fz) / 256;
    return out;
}
function col_fromlab(L, A, B, out) {
    const fy = (L * 100 + 16) / 116, fx = fy + (A - 0.5) * 256 / 500, fz = fy - (B - 0.5) * 256 / 200;
    const X = labFinv(fx) * 0.95047, Y = labFinv(fy), Z = labFinv(fz) * 1.08883;
    const lr = Math.min(Math.max(3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, 0), 1);
    const lg = Math.min(Math.max(-0.969266 * X + 1.8760108 * Y + 0.0415560 * Z, 0), 1);
    const lb = Math.min(Math.max(0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z, 0), 1);
    out[0] = fromLin(lr); out[1] = fromLin(lg); out[2] = fromLin(lb);
    return out;
}
function col_tooklab(r, g, b, out) {
    const R = toLin(r), G = toLin(g), B = toLin(b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    out[0] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    out[1] = 0.5 + 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    out[2] = 0.5 + 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    return out;
}
function col_fromoklab(L, A, B, out) {
    A -= 0.5; B -= 0.5;
    let l = L + 0.3963377774 * A + 0.2158037573 * B, m = L - 0.1055613458 * A - 0.0638541728 * B, s = L - 0.0894841775 * A - 1.2914855480 * B;
    l = l * l * l; m = m * m * m; s = s * s * s;
    const lr = Math.min(Math.max(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, 0), 1);
    const lg = Math.min(Math.max(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, 0), 1);
    const lb = Math.min(Math.max(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s, 0), 1);
    out[0] = fromLin(lr); out[1] = fromLin(lg); out[2] = fromLin(lb);
    return out;
}

var H$1 = /*#__PURE__*/Object.freeze({
    __proto__: null,
    BLANK: BLANK,
    CLEAR: CLEAR,
    at: at$1,
    at_blur: at_blur,
    at_blurx: at_blurx,
    at_blury: at_blury,
    at_dilate: at_dilate,
    at_erode: at_erode,
    at_gaussian: at_gaussian,
    at_gaussianx: at_gaussianx,
    at_gaussiany: at_gaussiany,
    at_sharpen: at_sharpen,
    col_fromhsl: col_fromhsl,
    col_fromhsv: col_fromhsv,
    col_fromlab: col_fromlab,
    col_fromlinear: col_fromlinear,
    col_fromoklab: col_fromoklab,
    col_fromycbcr: col_fromycbcr,
    col_tohsl: col_tohsl,
    col_tohsv: col_tohsv,
    col_tolab: col_tolab,
    col_tolinear: col_tolinear,
    col_tooklab: col_tooklab,
    col_toycbcr: col_toycbcr,
    convolve: convolve,
    factorial: factorial,
    fmod: fmod,
    gcd: gcd,
    perm: perm,
    picture: picture,
    placeCode: placeCode,
    plane_blur: plane_blur,
    plane_blurx: plane_blurx,
    plane_blury: plane_blury,
    plane_dilate: plane_dilate,
    plane_emboss: plane_emboss,
    plane_erode: plane_erode,
    plane_gaussian: plane_gaussian,
    plane_gaussianx: plane_gaussianx,
    plane_gaussiany: plane_gaussiany,
    plane_laplacian: plane_laplacian,
    plane_sharpen: plane_sharpen,
    plane_sobel: plane_sobel,
    plane_sobelx: plane_sobelx,
    plane_sobely: plane_sobely,
    random: random,
    root: root,
    sample: sample,
    sampleOrZero: sampleOrZero,
    scratch: scratch,
    smoothstep: smoothstep
});

/**
 * Filter expressions → JavaScript, for running a filter without a GPU.
 *
 * The same language as the shaders (mathzetta/glsl's filterShader): the
 * same names (r g b a x y px py w h t gray rgb unchanged), the same
 * functions (pixel, blur, gaussian, sobel, zoom, the pictures a filter
 * names…), the same rules for turning a number or a colour into a pixel.
 * The GLSL is typed and so is this: every node of the expression gets a
 * type — float, bool, vec2, vec3 or vec4 — and becomes one local variable
 * per component inside a loop over the pixels. No vector objects exist at
 * run time; a filter is one straight-line loop body.
 *
 * Neighbourhood functions whose argument is the same for every pixel
 * (blur(radius) with radius a parameter) are worked out once per pass,
 * over the whole picture and separably — blur, gaussian, dilate and erode
 * over a square are a horizontal pass then a vertical one, the same sums
 * in a different order — then read per pixel. An argument that changes
 * per pixel falls back to computing that pixel's neighbourhood directly.
 *
 * The generated code is compiled with new Function only after mathzetta's
 * checkGeneratedJs has passed it: every name in it is one this file
 * generates ($-prefixed) or a Math member, it holds no strings, and only
 * the arrays made here can be indexed. A filter is user input — shared by
 * link, pasted as JSON — and can read the picture and write colours,
 * nothing else.
 */


const CUSTOM = '\\:';
const HELPERS = Object.keys(H$1).filter((k) => typeof H$1[k] === 'function');

/** Constants and leaves every expression has. */
const SCALARS = { r: '$r', g: '$g', b: '$b', a: '$a', x: '$x', y: '$y', px: '$px', py: '$py', w: '$w', h: '$h', t: '$t', gray: '$gray' };
const CONSTANTS = { pi: 'Math.PI', 'π': 'Math.PI', e: 'Math.E', tau: '(2 * Math.PI)', 'τ': '(2 * Math.PI)', '∞': 'Infinity', '-∞': '(-Infinity)' };

/** Functions applied to each component: name → (args as JS) => JS. */
const COMPONENTWISE = {
    sqrt: 1, abs: 1, floor: 1, ceil: 1, ln: 'log', sin: 1, cos: 1, tan: 1, arcsin: 'asin', arccos: 'acos', arctan: 'atan',
    sinh: 1, cosh: 1, tanh: 1, arcsinh: 'asinh', arccosh: 'acosh', arctanh: 'atanh', sign: 1, exp: 1, exp2: (x) => `Math.pow(2, ${x})`,
    log2: 1, expm1: (x) => `(Math.exp(${x}) - 1)`, loglog: (x) => `Math.log(Math.log(${x}))`, logloglog: (x) => `Math.log(Math.log(Math.log(${x})))`,
    csc: (x) => `(1 / Math.sin(${x}))`, sec: (x) => `(1 / Math.cos(${x}))`, cot: (x) => `(1 / Math.tan(${x}))`,
    fract: (x) => `(${x} - Math.floor(${x}))`, radians: (x) => `(${x} * 0.017453292519943295)`, degrees: (x) => `(${x} * 57.29577951308232)`,
    inversesqrt: (x) => `(1 / Math.sqrt(${x}))`,
    atan2: (y, x) => `Math.atan2(${y}, ${x})`, pow: (x, y) => `Math.pow(${x}, ${y})`,
    mod: (x, y) => `(${x} - ${y} * Math.floor(${x} / ${y}))`,
    step: (edge, x) => `(${x} < ${edge} ? 0 : 1)`,
    clamp: (x, lo, hi) => `Math.min(Math.max(${x}, ${lo}), ${hi})`,
    mix: (a, b, k) => `(${a} + (${b} - ${a}) * ${k})`,
    smoothstep: (e0, e1, x) => `$h_smoothstep(${e0}, ${e1}, ${x})`,
};
const FIXED_ARITY = { atan2: 2, pow: 2, mod: 2, step: 2, clamp: 3, mix: 3, smoothstep: 3 };

/** Neighbourhood functions: the result kind, and whether the per-pass plane is computed once for a constant argument. */
const PLANES = {
    blur: 3, blurx: 3, blury: 3, gaussian: 3, gaussianx: 3, gaussiany: 3, dilate: 3, erode: 3, sharpen: 3,
    sobel: 1, sobelx: 1, sobely: 1, laplacian: 1, emboss: 1,
};

/** A value: a kind ('f' number, 'b' true/false, 'v' vector) and one JS expression per component. */
const val = (kind, c) => ({ kind, c });
const f = (e) => val('f', [e]);
const bool = (e) => val('b', [e]);
const vec = (c) => (c.length === 1 ? f(c[0]) : val('v', c));
/** A component as a number: true/false count as 1/0, as when GLSL converts. */
const num = (v, k = 0) => (v.kind === 'b' ? `(${v.c[0]} ? 1 : 0)` : v.kind === 'f' ? v.c[0] : v.c[k] ?? v.c[0]);
const size = (v) => (v.kind === 'v' ? v.c.length : 1);

class CompileError extends Error {}

/**
 * Compile one pass of a compiled filter (compileFilter().passes[i]) for the CPU.
 * @returns {{ run: (ctx) => void, source: string }}
 */
function compileCpuPass(pass) {
    if (pass.blendKept) return { blend: true, source: '' };
    const params = pass.params ?? {};
    const pictures = new Set([...Object.keys(pass.placements ?? {}), 'source', 'selection']);
    const g = new Generator(params, pictures, pass.space ?? 'srgb');
    g.graphics = new Set(Object.keys(pass.graphics ?? {}));        // drawn by the caller; transparent until they are
    g.bind = pass.bind ?? {};                                         // a graphic's name here → the key its picture is bound under
    const channels = typeof pass.color === 'string' ? { rgba: pass.color } : pass.color;
    const parse = (text, whole) => {
        const names = [...FILTER_FUNCTIONS, ...Object.keys(pass.placements ?? {})];
        const values = [...FILTER_VALUES, ...Object.keys(params)];
        return filterPictureCalls(parseTree(text, { names, values, blocks: null }), pictures, { whole });
    };
    for (const ch of ['rgba', 'rgb', 'r', 'g', 'b', 'a']) {
        if (!channels[ch]) continue;
        let tree;
        try { tree = parse(channels[ch], ch === 'rgba'); } catch (e) { throw new CompileError(e.message); }
        g.channel(ch, tree);
    }
    const source = g.source();
    // the gate: only names made here, Math, operators and numbers; no strings; only our arrays indexed
    checkGeneratedJs(source, { variables: /^\$\w+$/, indexable: /^\$[A-Z]\w*$/, strings: false });
    const fn = new Function(...g.parameters(), source);
    return {
        source,
        uses: g.uses,
        pictures: [...g.pictureNames],
        run(ctx) { fn(...g.arguments(ctx)); },
    };
}

class Generator {
    constructor(params, pictures, space = 'srgb') {
        this.params = params;
        this.pictures = pictures;
        this.space = space === 'srgb' ? null : space;    // the frame holds this space: pictures are converted as read
        this.pre = [];               // before the loop: params, planes
        this.body = [];              // per pixel
        this.n = 0;
        this.uses = new Set();       // 'source', picture names, 'random' …
        this.pictureNames = new Set();
        this.perPixel = new Map();   // picture sample at this pixel: name → vec4 value (computed once)
        this.planes = new Map();     // key → plane variable
        this.scratch = 0;
    }

    temp(expr, into = this.body) {
        const name = `$v${this.n++}`;
        into.push(`let ${name} = ${expr};`);
        return name;
    }

    /** A value whose components are temps (so an expression used twice is computed once). */
    keep(v, into = this.body) {
        return val(v.kind, v.c.map((e) => (/^[\w$.]+$|^\(?-?[\d.e+]+\)?$/.test(e) ? e : this.temp(e, into))));
    }

    fail(why) { throw new CompileError(why); }

    // ---- leaves ------------------------------------------------------------------

    leaf(node) {
        if (node.type === 'number') return f(`(${node.value.replace(/\.+$/, '')})`);
        if (node.type === 'string') this.fail('a filter has no text: numbers and colours only');
        const v = node.value;
        if (v === 't') this.uses.add('t');           // the filter animates (the page hides time for a still one)
        if (SCALARS[v]) return f(SCALARS[v]);
        if (v === 'rgb') return vec(['$r', '$g', '$b']);
        if (v === 'unchanged') return f('$u');   // the kept value; as a whole if/else branch it takes the other branch's type (ternary)
        if (v === 'selected') return f(this.pictureHere('selection').c[0]);   // the selection mask: white = 1; white everywhere when none
        if (CONSTANTS[v]) return f(CONSTANTS[v]);
        if (v === 'true' || v === 'false') return bool(v);
        if (Object.prototype.hasOwnProperty.call(this.params, v)) {
            const name = `$p_${v}`;
            return this.params[v].type === 'color' ? vec([`${name}_0`, `${name}_1`, `${name}_2`]) : f(name);
        }
        if (this.pictures.has(v)) { const p = this.pictureHere(v); return vec(p.c.slice(0, 3)); }
        if (v.startsWith('mz_px_') && this.pictures.has(v.slice(6))) return this.pictureHere(v.slice(6));
        this.fail(`unknown name "${v}"`);
    }

    /** A named picture's colour at this pixel (vec4), sampled once per pixel. */
    pictureHere(name) {
        if (!this.perPixel.has(name)) {
            const s = this.sampler(name, '$px', '$py');
            this.perPixel.set(name, this.keep(s));
        }
        return this.perPixel.get(name);
    }

    /** vec4 of picture `name` at frame position (X, Y) — `source`, or a placed picture, transparent outside. */
    sampler(name, X, Y) {
        const out = this.scratchArray();
        if (name === 'source') {
            this.uses.add('source');
            this.body.push(`$h_sample($S, $w, $h, ${X}, ${Y}, ${out});`);
        } else {
            this.pictureNames.add(name);
            this.body.push(`$h_picture($Q_${name}, $qw_${name}, $qh_${name}, $w, $h, $qz_${name}, $qx_${name}, $qy_${name}, $qa_${name}, $qm_${name}, ${X}, ${Y}, ${out});`);
        }
        if (this.space && name !== 'selection') this.body.push(`$h_col_to${this.space}(${out}[0], ${out}[1], ${out}[2], ${out});`);   // a mask is not a colour
        return vec([0, 1, 2, 3].map((k) => `${out}[${k}]`));
    }

    scratchArray() {
        const name = `$T${this.scratch++}`;
        this.pre.push(`let ${name} = $h_scratch();`);
        return name;
    }

    // ---- operations -------------------------------------------------------------

    value(node) {
        return node.type === 'op' ? this.op(node) : this.leaf(node);
    }

    op(node) {
        const { op, args } = node;
        const custom = op.startsWith(CUSTOM) ? op.slice(CUSTOM.length) : null;
        if (custom !== null) return this.call(custom, args, node);
        const A = () => args.map((a) => this.value(a));
        switch (op) {
            case '+': case '-': case '*': case '/': {
                const [a, b] = A();
                return this.componentwise([a, b], (x, y) => `(${x} ${op} ${y})`);
            }
            case 'neg': return this.componentwise(A(), (x) => `(-${x})`);
            case '^': return this.power(args);
            case 'mod': return this.componentwise(A(), COMPONENTWISE.mod);
            case '<': case '>': case '≤': case '≥': {
                const [a, b] = A();
                const sym = { '≤': '<=', '≥': '>=' }[op] ?? op;
                return bool(`(${num(a)} ${sym} ${num(b)})`);
            }
            case '=': case '===': case '≠': case '≠=': case '≡': {
                const [a, b] = A();
                const n = Math.max(size(a), size(b));
                const all = Array.from({ length: n }, (_, k) => `${num(a, k)} === ${num(b, k)}`).join(' && ');
                return bool(op === '≠' || op === '≠=' ? `!(${all})` : `(${all})`);
            }
            case '≈': { const [a, b] = A(); return bool(`(Math.abs(${num(a)} - ${num(b)}) < 1e-5)`); }
            case '&': { const [a, b] = A(); return bool(`(${this.truth(a)} && ${this.truth(b)})`); }
            case '|': { const [a, b] = A(); return bool(`(${this.truth(a)} || ${this.truth(b)})`); }
            case '\\xor': { const [a, b] = A(); return bool(`(${this.truth(a)} !== ${this.truth(b)})`); }
            case '\\nand': { const [a, b] = A(); return bool(`!(${this.truth(a)} && ${this.truth(b)})`); }
            case '\\nor': { const [a, b] = A(); return bool(`!(${this.truth(a)} || ${this.truth(b)})`); }
            case '\\not': { const [a] = A(); return bool(`!${this.truth(a)}`); }
            case '?:': return this.ternary(args);
            case 'max': case 'min': return this.componentwise(A(), (...xs) => `Math.${op}(${xs.join(', ')})`);
            case 'sum': return this.componentwise(A(), (...xs) => `(${xs.join(' + ')})`);
            case 'prod': return this.componentwise(A(), (...xs) => `(${xs.join(' * ')})`);
            case 'mean': return this.componentwise(A(), (...xs) => `((${xs.join(' + ')}) / ${xs.length})`);
            case '()': case '[]': case '{}': case '(]': case '[)': {
                const parts = A().flatMap((v) => (v.kind === 'b' ? [num(v)] : v.c.map((_, k) => num(v, k))));
                if (parts.length > 4) this.fail('a colour has at most 4 values (r, g, b, a)');
                return vec(parts);
            }
            case '!': return this.componentwise(A(), (x) => `$h_factorial(${x})`);
            case 'perm': return this.componentwise(A(), (n, k) => `$h_perm(${n}, ${k})`);
            case 'comb': return this.componentwise(A(), (n, k) => `($h_perm(${n}, ${k}) / $h_factorial(${k}))`);
            case 'gcd': return this.componentwise(A(), (...xs) => xs.reduce((acc, x) => `$h_gcd(${acc}, ${x})`));
            case 'round': {
                const [v, d] = A();
                return this.componentwise([v, d], (x, digits) => `(Math.floor(${x} * Math.pow(10, ${digits}) + 0.5) / Math.pow(10, ${digits}))`);
            }
            case 'log': { const [base, x] = A(); return this.componentwise([base, x], (b, xx) => `(Math.log(${xx}) / Math.log(${b}))`); }
            case 'root': { const [n, x] = A(); return this.componentwise([n, x], (nn, xx) => `$h_root(${nn}, ${xx})`); }
            case '∈': case '∉': return this.membership(node);
            case 'random': return this.random();
            case '_': {
                const [a, b] = args;
                if (a.type === 'symbol' && (b.type === 'number' || b.type === 'symbol')) return this.leaf({ type: 'symbol', value: `${a.value}_${b.value}` });
                break;
            }
        }
        if (COMPONENTWISE[op]) return this.builtin(op, A());
        this.fail(`"${op}" isn't available in a filter`);
    }

    truth(v) { return v.kind === 'b' ? v.c[0] : `(${num(v)} !== 0)`; }

    /** Apply fn to each component; a number (or true/false) is used for every component of a vector. */
    componentwise(values, fn) {
        const sizes = values.map(size);
        const n = Math.max(...sizes);
        const vectors = new Set(sizes.filter((s) => s > 1));
        if (vectors.size > 1) this.fail(`can't combine vectors of ${[...vectors].join(' and ')} values`);
        const out = Array.from({ length: n }, (_, k) => fn(...values.map((v) => num(v, k))));
        return this.keep(vec(out));
    }

    builtin(name, values) {
        const spec = COMPONENTWISE[name];
        if (FIXED_ARITY[name] && values.length !== FIXED_ARITY[name]) this.fail(`${name}() takes ${FIXED_ARITY[name]} values`);
        if (typeof spec === 'function') return this.componentwise(values, spec);
        const fn = spec === 1 ? name : spec;
        return this.componentwise(values, (...xs) => `Math.${fn}(${xs.join(', ')})`);
    }

    /** x^n as the shader writes it: products for small whole powers, exp for e^x, pow otherwise. */
    power([base, exp]) {
        const n = exp.type === 'number' && /^-?\d+$/.test(exp.value) ? Number(exp.value) : null;
        const b = this.keep(this.value(base));
        const times = (k) => this.componentwise([b], (x) => Array(k).fill(x).join(' * '));
        if (n === 0) return this.componentwise([b], () => '1');
        if (n !== null && n >= 1 && n <= 4) return times(n);
        if (n !== null && n <= -1 && n >= -4) return this.componentwise([times(-n)], (x) => `(1 / ${x})`);
        if (base.type === 'symbol' && base.value === 'e') return this.componentwise([this.value(exp)], (x) => `Math.exp(${x})`);
        if (base.type === 'number' && base.value === '2') return this.componentwise([this.value(exp)], (x) => `Math.pow(2, ${x})`);
        return this.componentwise([b, this.value(exp)], (x, y) => `Math.pow(${x}, ${y})`);
    }

    ternary([c, yes, no]) {
        const cond = this.truth(this.value(c));
        const isU = (n) => n.type === 'symbol' && n.value === 'unchanged';
        let a = isU(yes) ? null : this.value(yes);
        let b = isU(no) ? null : this.value(no);
        // `unchanged` in a branch takes the other branch's type (mz_unchanged in the shader)
        const unchangedLike = (other) => (other.kind === 'b' ? bool('($u > 0.5)') : other.kind === 'f' ? f('$u')
            : vec(['$k0', '$k1', '$k2', '$k3'].slice(0, other.c.length === 4 ? 4 : 3)));
        if (!a && !b) return f('$u');
        if (!a) a = unchangedLike(b);
        if (!b) b = unchangedLike(a);
        if (a.kind === 'b' && b.kind === 'b') return bool(this.temp(`(${cond} ? ${a.c[0]} : ${b.c[0]})`));
        const n = Math.max(size(a), size(b));
        const out = Array.from({ length: n }, (_, k) => this.temp(`(${cond} ? ${num(a, k)} : ${num(b, k)})`));
        return vec(out);
    }

    membership(node) {
        const [x, set] = node.args;
        const v = num(this.value(x));
        const negate = node.op === '∉';
        let test;
        if (set.type === 'op' && ['()', '[]', '(]', '[)'].includes(set.op) && set.args.length === 2) {
            const [lo, hi] = set.args.map((a) => num(this.value(a)));
            test = `(${v} ${set.op[0] === '[' ? '>=' : '>'} ${lo} && ${v} ${set.op[1] === ']' ? '<=' : '<'} ${hi})`;
        } else if (set.type === 'op' && set.op === '{}') {
            test = `(${set.args.map((item) => `${v} === ${num(this.value(item))}`).join(' || ')})`;
        } else if (set.type === 'symbol' && ['ℝ', 'ℤ', 'ℕ'].includes(set.value)) {
            test = { 'ℝ': `Number.isFinite(${v})`, 'ℤ': `Number.isInteger(${v})`, 'ℕ': `(Number.isInteger(${v}) && ${v} > 0)` }[set.value];
        } else this.fail('∈ needs an interval [a, b], a set {…}, ℝ, ℤ or ℕ');
        return bool(negate ? `!${test}` : test);
    }

    random() {
        this.uses.add('random');
        return f(this.temp('$h_random($px, $py, $h, ++$seed)'));
    }

    // ---- functions: pictures, geometry, neighbourhoods, GLSL built-ins ------------

    call(name, args, node) {
        const A = () => args.map((a) => this.value(a));
        if (name.startsWith('mz_sample_')) {                      // a picture read with its alpha: 0 outside it
            const picture = name.slice(10);
            const [p0, p1] = A();
            const [X, Y] = p1 ? [num(p0), num(p1)] : [num(p0, 0), num(p0, 1)];
            if (picture === 'image') {
                const out = this.scratchArray();
                this.body.push(`$h_sampleOrZero($I, $w, $h, ${X}, ${Y}, ${out});`);
                return this.keep(vec([0, 1, 2, 3].map((k) => `${out}[${k}]`)));
            }
            if (!this.pictures.has(picture)) this.fail(`unknown picture "${picture}"`);
            return this.keep(this.sampler(picture, X, Y));
        }
        if (name.startsWith('mz_at_')) {
            const picture = name.slice(6);
            const [p0, p1] = A();
            const [X, Y] = p1 ? [num(p0), num(p1)] : [num(p0, 0), num(p0, 1)];
            if (picture === 'image') {
                const out = this.scratchArray();
                this.body.push(`$h_sampleOrZero($I, $w, $h, ${X}, ${Y}, ${out});`);
                return vec([0, 1, 2].map((k) => `${out}[${k}]`));
            }
            if (!this.pictures.has(picture)) this.fail(`unknown picture "${picture}"`);
            return this.keep(vec(this.sampler(picture, X, Y).c.slice(0, 3)));
        }
        if (name.startsWith('mz_width_') || name.startsWith('mz_height_')) {
            const picture = name.replace(/^mz_(width|height)_/, '');
            this.pictureNames.add(picture);
            return f(name.startsWith('mz_width_') ? `$qw_${picture}` : `$qh_${picture}`);
        }
        switch (name) {
            case 'pixel': {
                const [X, Y] = A().map((v) => num(v));
                const out = this.scratchArray();
                this.body.push(`$h_sample($I, $w, $h, ${X}, ${Y}, ${out});`);
                return this.keep(vec([0, 1, 2, 3].map((k) => `${out}[${k}]`)));
            }
            case 'red': case 'green': case 'blue': case 'alpha': case 'luma': {
                let v;
                if (args.length === 2) v = this.call('pixel', args);
                else if (args.length === 1) v = this.value(args[0]);
                else this.fail(`${name}() takes a colour, or a position px, py`);
                const k = { red: 0, green: 1, blue: 2, alpha: 3 }[name];
                if (name === 'luma') return f(`(${num(v, 0)} * 0.299 + ${num(v, 1)} * 0.587 + ${num(v, 2)} * 0.114)`);
                if (name === 'alpha' && size(v) === 3) return f('1');
                return f(num(v, k));
            }
            case 'length': { const [v] = A(); return f(`Math.sqrt(${v.c.map((_, k) => `${num(v, k)} * ${num(v, k)}`).join(' + ')})`); }
            case 'distance': {
                const [a, b] = A();
                const d = this.componentwise([a, b], (x, y) => `(${x} - ${y})`);
                return f(`Math.sqrt(${d.c.map((e) => `${e} * ${e}`).join(' + ')})`);
            }
            case 'dot': {
                const [a, b] = A();
                const n = Math.max(size(a), size(b));
                return f(`(${Array.from({ length: n }, (_, k) => `${num(a, k)} * ${num(b, k)}`).join(' + ')})`);
            }
            case 'normalize': {
                const [v] = A();
                const len = this.temp(`Math.sqrt(${v.c.map((_, k) => `${num(v, k)} * ${num(v, k)}`).join(' + ')})`);
                return this.componentwise([v], (x) => `(${x} / ${len})`);
            }
            case 'cross': {
                const [a, b] = A();
                if (size(a) !== 3 || size(b) !== 3) this.fail('cross() takes two colours (3 values each)');
                const [x1, y1, z1] = a.c; const [x2, y2, z2] = b.c;
                return this.keep(vec([`(${y1} * ${z2} - ${z1} * ${y2})`, `(${z1} * ${x2} - ${x1} * ${z2})`, `(${x1} * ${y2} - ${y1} * ${x2})`]));
            }
            case 'convolve': {
                const ks = A().map((v) => num(v));
                if (ks.length !== 9) this.fail('convolve() takes 9 numbers: the 3×3 kernel, row by row');
                const out = this.scratchArray();
                this.body.push(`$h_convolve($I, $w, $h, $px, $py, ${ks.join(', ')}, ${out});`);
                return vec([0, 1, 2].map((k) => `${out}[${k}]`));
            }
            case 'mz_zoom': case 'mz_shift': case 'mz_rotate': case 'mz_crop': case 'mz_tile': case 'mz_flipx': case 'mz_flipy':
                return this.geometry(name.slice(3), A().map((v) => num(v)));
            case 'tolinear': case 'fromlinear': case 'tohsv': case 'fromhsv': case 'tohsl': case 'fromhsl':
            case 'tolab': case 'fromlab': case 'tooklab': case 'fromoklab': case 'toycbcr': case 'fromycbcr': {
                const a = A();
                const c = a.length === 3 ? a.map((v) => num(v)) : [0, 1, 2].map((k) => num(a[0], k));   // a colour, or three numbers
                if (a.length !== 1 && a.length !== 3) this.fail(`${name}() takes a colour`);
                const out = this.scratchArray();
                this.body.push(`$h_col_${name}(${c.join(', ')}, ${out});`);
                return this.keep(vec([0, 1, 2].map((k) => `${out}[${k}]`)));
            }
            case 'random': return this.random();
            case 'exp': case 'exp2': case 'log2': case 'sign': case 'fract': case 'radians': case 'degrees': case 'inversesqrt':
            case 'pow': case 'mod': case 'step': case 'clamp': case 'mix': case 'smoothstep':
            case 'abs': case 'floor': case 'ceil': case 'sqrt': case 'sin': case 'cos': case 'tan':
                return this.builtin(name, A());
            case 'asin': return this.builtin('arcsin', A());
            case 'acos': return this.builtin('arccos', A());
            case 'atan': return args.length === 2 ? this.builtin('atan2', A()) : this.builtin('arctan', A());
            case 'log': return this.builtin('ln', A());
            case 'max': case 'min': return this.componentwise(A(), (...xs) => `Math.${name}(${xs.join(', ')})`);
        }
        if (PLANES[name]) return this.neighbourhood(name, args);
        this.fail(`unknown function "${name}"`);
    }

    /** Where to read the picture from (vec2, pixels): the shader's mz_zoom … mz_flipy. */
    geometry(kind, a) {
        const P = (x, y) => this.keep(vec([x, y]));
        switch (kind) {
            case 'zoom': {
                const [s, cx = '0.5', cy = '0.5'] = a;
                const c = P(`(${cx} * $w - 0.5)`, `(${cy} * $h - 0.5)`);
                return P(`(${c.c[0]} + ($px - ${c.c[0]}) / ${s})`, `(${c.c[1]} + ($py - ${c.c[1]}) / ${s})`);
            }
            case 'shift': {
                const [dx, dy] = a;
                return P(`($h_fmod($px - ${dx} + 0.5, $w) - 0.5)`, `($h_fmod($py - ${dy} + 0.5, $h) - 0.5)`);
            }
            case 'rotate': {
                const [ang, cx = '0.5', cy = '0.5'] = a;
                const c = P(`(${cx} * $w - 0.5)`, `(${cy} * $h - 0.5)`);
                const d = P(`($px - ${c.c[0]})`, `($py - ${c.c[1]})`);
                const cs = this.keep(vec([`Math.cos(${ang})`, `Math.sin(${ang})`]));
                return P(`(${c.c[0]} + ${cs.c[0]} * ${d.c[0]} + ${cs.c[1]} * ${d.c[1]})`, `(${c.c[1]} + ${cs.c[0]} * ${d.c[1]} - ${cs.c[1]} * ${d.c[0]})`);
            }
            case 'crop': {
                const [x0, y0, x1, y1] = a;
                return P(`((${x0} + (${x1} - ${x0}) * ($px + 0.5) / $w) * $w - 0.5)`, `((${y0} + (${y1} - ${y0}) * ($py + 0.5) / $h) * $h - 0.5)`);
            }
            case 'tile': {
                const [nx, ny = nx] = a;
                return P(`($h_fmod(($px + 0.5) * ${nx}, $w) - 0.5)`, `($h_fmod(($py + 0.5) * ${ny}, $h) - 0.5)`);
            }
            case 'flipx': return P('($w - 1 - $px)', '$py');
            case 'flipy': return P('$px', '($h - 1 - $py)');
        }
        this.fail(`unknown geometry ${kind}`);
    }

    /**
     * blur(radius) and friends. With an argument the same for every pixel (numbers, params, t),
     * the whole plane is computed once before the loop; otherwise this pixel's neighbourhood is.
     */
    neighbourhood(name, args) {
        const kind = PLANES[name];
        const constant = args.every((a) => this.isUniform(a));
        if (constant) {
            const argJs = args.map((a) => num(this.uniformValue(a)));
            const key = `${name}(${argJs.join(',')})`;
            if (!this.planes.has(key)) {
                const plane = `$N${this.planes.size}`;
                this.pre.push(`let ${plane} = $h_plane_${name}($I, $w, $h, $y0, $y1${argJs.map((x) => `, ${x}`).join('')});`);
                this.planes.set(key, plane);
            }
            const plane = this.planes.get(key);
            return kind === 3 ? vec([0, 1, 2].map((k) => `${plane}[$j3 + ${k}]`)) : f(`${plane}[$j]`);
        }
        const argJs = args.map((a) => num(this.value(a)));
        if (kind === 1) return f(this.temp(`$h_at_${name}($I, $w, $h, $px, $py${argJs.map((x) => `, ${x}`).join('')})`));
        const out = this.scratchArray();
        this.body.push(`$h_at_${name}($I, $w, $h, $px, $py${argJs.map((x) => `, ${x}`).join('')}, ${out});`);
        return vec([0, 1, 2].map((k) => `${out}[${k}]`));
    }

    /** Does this subtree read nothing that changes from pixel to pixel? */
    isUniform(node) {
        if (node.type === 'number') return true;
        if (node.type === 'symbol') {
            return ['w', 'h', 't'].includes(node.value) || Boolean(CONSTANTS[node.value])
                || (Object.prototype.hasOwnProperty.call(this.params, node.value) && this.params[node.value].type !== 'color');
        }
        if (node.type !== 'op' || node.op.startsWith(CUSTOM) || node.op === 'random') return false;
        return node.args.every((a) => this.isUniform(a));
    }

    /** A uniform subtree, generated before the loop. */
    uniformValue(node) {
        const saved = this.body;
        this.body = this.pre;
        try { return this.value(node); } finally { this.body = saved; }
    }

    // ---- assembling the pass ------------------------------------------------------

    /** One channel line of the colour, as filterShader writes it (mz_keep, then mz_rgba / mz_rgb / mz_ch_*). */
    channel(ch, tree) {
        const keepValue = ch === 'rgba' || ch === 'rgb' ? '$gray' : `$c${'rgba'.indexOf(ch)}`;
        this.body.push(`$u = ${keepValue}; $k0 = $c0; $k1 = $c1; $k2 = $c2; $k3 = $c3;`);
        const v = this.value(tree);
        const n = size(v);
        const comp = (k) => num(v, k);
        if (ch === 'rgba') {
            if (n === 2) this.fail('a colour is one number (grey), three (r, g, b) or four (r, g, b, a) — not two');
            const c = n === 1 ? [comp(0), comp(0), comp(0), '1'] : n === 3 ? [comp(0), comp(1), comp(2), '1'] : [0, 1, 2, 3].map(comp);
            this.body.push(`$c0 = ${c[0]}; $c1 = ${c[1]}; $c2 = ${c[2]}; $c3 = ${c[3]};`);
        } else if (ch === 'rgb') {
            if (n === 2) this.fail('a colour is one number (grey), three (r, g, b) or four — not two');
            const c = n === 1 ? [comp(0), comp(0), comp(0)] : [comp(0), comp(1), comp(2)];
            this.body.push(`$c0 = ${c[0]}; $c1 = ${c[1]}; $c2 = ${c[2]};`);
        } else {
            const k = 'rgba'.indexOf(ch);
            const x = n === 1 ? comp(0) : n === 3 ? (ch === 'a' ? '1' : comp(k)) : comp(k);
            this.body.push(`$c${k} = ${x};`);
        }
    }

    parameters() {
        const pictures = [...this.pictureNames];
        return ['$I', '$O', '$S', '$w', '$h', '$t', '$P', '$op', '$y0', '$y1',
            ...pictures.flatMap((p) => [`$Q_${p}`, `$qw_${p}`, `$qh_${p}`, `$qz_${p}`, `$qx_${p}`, `$qy_${p}`, `$qa_${p}`, `$qm_${p}`]),
            ...HELPERS.map((k) => `$h_${k}`)];
    }

    arguments(ctx) {
        const pictures = [...this.pictureNames];
        return [ctx.input, ctx.output, ctx.source, ctx.width, ctx.height, ctx.t, ctx.params, ctx.opacity, ctx.y0 ?? 0, ctx.y1 ?? ctx.height,
            ...pictures.flatMap((p) => {
                const pic = ctx.pictures[this.bind?.[p] ?? p] ?? (this.graphics?.has(p) ? CLEAR : BLANK);
                const pl = ctx.placements[p] ?? {};
                return [pic.data, pic.width, pic.height, Number(pl.zoom ?? 1), Number(pl.x ?? 0.5), Number(pl.y ?? 0.5), Number(pl.angle ?? 0), placeCode(pl.place)];
            }),
            ...HELPERS.map((k) => H$1[k])];
    }

    source() {
        const paramLines = Object.entries(this.params).map(([name, p], i) => (p.type === 'color'
            ? `let $p_${name}_0 = $P[${i}][0], $p_${name}_1 = $P[${i}][1], $p_${name}_2 = $P[${i}][2];`
            : `let $p_${name} = $P[${i}];`));
        return [
            ...paramLines.map((l) => l.replace(/\$P\[(\d+)\]\[(\d)\]/g, '$h_at($P, $1, $2)')),
            'let $u = 0, $k0 = 0, $k1 = 0, $k2 = 0, $k3 = 0, $seed = 0, $CS = $h_scratch();',
            ...this.pre,
            'for (let $py = $y0; $py < $y1; $py++) {',
            '  for (let $px = 0; $px < $w; $px++) {',
            '    let $j = $py * $w + $px, $j3 = $j * 3, $j4 = $j * 4;',
            '    let $r = $I[$j4], $g = $I[$j4 + 1], $b = $I[$j4 + 2], $a = $I[$j4 + 3];',
            '    let $c0 = $r, $c1 = $g, $c2 = $b, $c3 = $a;',
            '    let $x = ($px + 0.5) / $w, $y = ($py + 0.5) / $h;',
            this.space
                ? `    $h_col_from${this.space}($r, $g, $b, $CS); let $gray = $CS[0] * 0.299 + $CS[1] * 0.587 + $CS[2] * 0.114;`   // the brightness as seen
                : '    let $gray = $r * 0.299 + $g * 0.587 + $b * 0.114;',
            '    $seed = $t;',
            ...this.body.map((l) => `    ${l}`),
            '    $O[$j4] = $r + ($c0 - $r) * $op;',
            '    $O[$j4 + 1] = $g + ($c1 - $g) * $op;',
            '    $O[$j4 + 2] = $b + ($c2 - $b) * $op;',
            '    $O[$j4 + 3] = $a + ($c3 - $a) * $op;',
            '  }',
            '}',
        ].join('\n');
    }
}

/**
 * Runs a compiled filter (compileFilter()) on the CPU — no GPU, no WebGL —
 * with the same interface as createFilterRunner:
 *
 *   const runner = createCpuRunner(compileFilter(def));
 *   runner.setImage(imageData);                 // ImageData, { data, width, height }, or in a browser an <img>/<canvas>/<video>
 *   runner.setImage('mask', maskImage);
 *   const out = runner.draw({ t: 0 });          // { data: Uint8ClampedArray, width, height }
 *   runner.draw({ t: 0, canvas });              // …and put it on a canvas
 *   runner.passes[0].values.cutoff = 0.3;       // knobs change without recompiling
 *
 * Works in Node too (thumbnails, servers, tests without a browser).
 *
 * draw() runs on the calling thread. drawAsync() spreads each pass's rows
 * over a pool of workers when the picture is large enough to be worth it
 * (≥ options.parallelFrom pixels, 250k by default); with SharedArrayBuffer
 * (Node, or a cross-origin isolated page) the workers read and write the
 * pictures in place, otherwise each gets a copy of the input and sends its
 * rows back. Both give the same pixels. The worker is cpu-worker.js beside this
 * module (options.workerUrl to put it elsewhere); from another origin — a CDN —
 * it is started through a same-origin blob: module that imports it. When no
 * worker can start, drawAsync() draws on the calling thread instead.
 *
 * Between passes the picture is rounded to 8 bits, as the GPU runner's
 * textures are, so both give the same pixels; { precision: 'float' } keeps
 * full precision instead (like 'float' textures on the GPU).
 */


function createCpuRunner(compiled, options = {}) {
    const precision = options.precision === 'float' || options.precision === 'half' ? 'float' : 'byte';
    const programs = compiled.passes.map((pass) => compileCpuPass(pass));
    const pictures = {};
    let source = null;
    const parallelFrom = options.parallelFrom ?? 250000;
    const wanted = options.workers === undefined || options.workers === 'auto' ? defaultWorkers() : Number(options.workers);
    let pool = null;           // created on the first drawAsync() that needs it
    let sent = new Map();      // picture name → the object last sent to the pool

    const runner = {
        passes: compiled.passes,
        get precision() { return precision; },
        /** The generated JavaScript of each pass, for the curious (and the tests). */
        sources: programs.map((p) => p.source),

        setImage(name, image) {
            if (typeof name !== 'string') { image = name; name = null; }
            const picture = toPicture(image);
            if (!name || name === 'source') source = picture;
            else pictures[name] = picture;
            return runner;
        },

        /** Runs every pass; returns the result as 8-bit RGBA (and draws it on `canvas` when given). */
        draw({ t = 0, canvas = null } = {}) {
            if (!source) throw new Error('setImage() first');
            const { width, height } = source;
            const n = width * height * 4;
            let input = source.data;
            const kept = [];
            compiled.passes.forEach((pass, i) => {
                for (let k = 0; k < pass.keepInput; k++) kept.push(input);
                const output = new Float32Array(n);
                if (pass.blendKept) {
                    const base = kept.pop();
                    const o = pass.opacity;
                    for (let j = 0; j < n; j++) output[j] = base[j] + (input[j] - base[j]) * o;
                } else {
                    programs[i].run({
                        input, output, source: source.data, width, height, t,
                        params: Object.keys(pass.params ?? {}).map((name) => pass.values[name]),
                        opacity: pass.opacity, pictures, placements: pass.placements ?? {},
                    });
                }
                if (precision === 'byte') quantize$1(output);
                input = output;
            });
            const data = new Uint8ClampedArray(n);
            for (let j = 0; j < n; j++) {
                const v = input[j];
                data[j] = v > 0 ? (v < 1 ? Math.round(v * 255) : 255) : 0;   // NaN → 0, as a GPU writes it
            }
            const out = { data, width, height };
            if (canvas) {
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
            }
            return out;
        },

        /**
         * As draw(), with each pass's rows spread over workers when the picture is large;
         * smaller pictures (or no workers available) run here, as draw().
         */
        async drawAsync({ t = 0, canvas = null } = {}) {
            if (!source) throw new Error('setImage() first');
            const { width, height } = source;
            if (wanted < 2 || width * height < parallelFrom) return runner.draw({ t, canvas });
            if (pool === null) pool = await createPool(wanted, compiled.passes, options.workerUrl).catch(() => false);   // false: workers can't start here
            if (!pool) return runner.draw({ t, canvas });
            const n = width * height * 4;
            const alloc = () => (pool.shared ? new Float32Array(new SharedArrayBuffer(n * 4)) : new Float32Array(n));
            // pictures the workers haven't seen (as shared copies when we can share)
            for (const [name, picture] of [['source', source], ...Object.entries(pictures)]) {
                if (sent.get(name) === picture) continue;
                await pool.broadcast({ type: 'picture', name, picture: pool.shared ? sharedPicture(picture) : picture });
                sent.set(name, picture);
            }
            let input = pool.shared ? sharedPicture(source).data : source.data;
            const kept = [];
            for (let i = 0; i < compiled.passes.length; i++) {
                const pass = compiled.passes[i];
                for (let k = 0; k < pass.keepInput; k++) kept.push(input);
                const output = alloc();
                if (pass.blendKept) {
                    const base = kept.pop();
                    for (let j = 0; j < n; j++) output[j] = base[j] + (input[j] - base[j]) * pass.opacity;
                    if (precision === 'byte') quantize$1(output);
                } else {
                    const params = Object.keys(pass.params ?? {}).map((name) => pass.values[name]);
                    const bands = splitRows(height, pool.size);
                    const replies = await Promise.all(bands.map(([y0, y1], k) => pool.ask(k, {
                        type: 'run', pass: i, input, output: pool.shared ? output : null, width, height, t, params,
                        opacity: pass.opacity, placements: pass.placements ?? {}, y0, y1, quantize: precision === 'byte',
                    })));
                    if (!pool.shared) replies.forEach((r, k) => output.set(r.band, bands[k][0] * width * 4));
                }
                input = output;
            }
            const data = new Uint8ClampedArray(n);
            for (let j = 0; j < n; j++) { const v = input[j]; data[j] = v > 0 ? (v < 1 ? Math.round(v * 255) : 255) : 0; }
            const out = { data, width, height };
            if (canvas) {
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
            }
            return out;
        },

        /** How many workers drawAsync() uses (0 until it first needs them). */
        get workers() { return pool ? pool.size : 0; },

        dispose() {
            source = null;
            for (const k of Object.keys(pictures)) delete pictures[k];
            if (pool) pool.close();
            pool = null;
            sent = new Map();
        },
    };
    return runner;
}

/** Clamp to 0–1 and round to 1/255: what an 8-bit texture keeps. */
function quantize$1(a) {
    for (let j = 0; j < a.length; j++) {
        const v = a[j];
        a[j] = v > 0 ? (v < 1 ? Math.round(v * 255) / 255 : 1) : 0;
    }
}

/** ImageData, { data, width, height } (8-bit or float), or a drawable in a browser → { data: Float32Array 0–1, width, height }. */
function toPicture(image) {
    if (image && image.data && image.width && image.height) {
        const src = image.data;
        const scale = src instanceof Float32Array || src instanceof Float64Array ? 1 : 1 / 255;
        const data = new Float32Array(image.width * image.height * 4);
        for (let j = 0; j < data.length; j++) data[j] = src[j] * scale;
        return { data, width: image.width, height: image.height };
    }
    if (typeof document !== 'undefined' || typeof OffscreenCanvas !== 'undefined') {
        const width = image.naturalWidth || image.videoWidth || image.width;
        const height = image.naturalHeight || image.videoHeight || image.height;
        if (!width || !height) throw new Error('setImage: the picture has no size yet (not loaded?)');
        const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, width, height);
        return toPicture(ctx.getImageData(0, 0, width, height));
    }
    throw new Error('setImage: give ImageData or { data, width, height }');
}

// ---- the worker pool -------------------------------------------------------------------

function defaultWorkers() {
    const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
    return Math.max(0, Math.min(8, cores - 1));
}

/** Row bands [y0, y1) of about equal size, one per worker. */
function splitRows(height, parts) {
    const out = [];
    for (let k = 0; k < parts; k++) {
        const y0 = Math.floor((height * k) / parts);
        const y1 = Math.floor((height * (k + 1)) / parts);
        if (y1 > y0) out.push([y0, y1]);
    }
    return out;
}

const canShare = () => typeof SharedArrayBuffer !== 'undefined' && (typeof crossOriginIsolated === 'undefined' || crossOriginIsolated === true);

function sharedPicture(picture) {
    if (picture.data.buffer instanceof (globalThis.SharedArrayBuffer ?? Object)) return picture;
    const data = new Float32Array(new SharedArrayBuffer(picture.data.byteLength));
    data.set(picture.data);
    picture.shared ??= { data, width: picture.width, height: picture.height };
    return picture.shared;
}

/** Workers that each compiled the filter; null when this platform can't start them. */
async function createPool(size, passes, workerUrl) {
    const url = new URL(workerUrl ?? './cpu-worker.js', import.meta.url);
    let make;
    let revoke = () => {};                                      // the blob: address, once the workers no longer need it
    if (typeof Worker !== 'undefined' && typeof window !== 'undefined') {
        // a worker script must come from the page's own origin: from a CDN, a blob: module that imports it does
        const start = url.origin === location.origin ? url
            : URL.createObjectURL(new Blob([`import ${JSON.stringify(url.href)};`], { type: 'text/javascript' }));
        if (start !== url) revoke = () => URL.revokeObjectURL(start);
        make = () => {
            const w = new Worker(start, { type: 'module' });
            return { send: (m) => w.postMessage(m), on: (fn) => { w.onmessage = (e) => fn(e.data); w.onerror = (e) => fn({ id: -1, ok: false, error: e.message }); }, close: () => w.terminate() };
        };
    } else {
        try {
            const { Worker: NodeWorker } = await import('node:worker_threads');
            make = () => {
                const w = new NodeWorker(url);
                return { send: (m) => w.postMessage(m), on: (fn) => { w.on('message', fn); w.on('error', (e) => fn({ id: -1, ok: false, error: e.message })); }, close: () => w.terminate() };
            };
        } catch {
            return null;
        }
    }
    const workers = Array.from({ length: size }, make);
    let next = 1;
    const waiting = workers.map(() => new Map());
    workers.forEach((w, k) => w.on((m) => {
        if (m.id === -1) { for (const [, cb] of waiting[k]) cb.reject(new Error(m.error)); waiting[k].clear(); return; }
        const cb = waiting[k].get(m.id);
        if (!cb) return;
        waiting[k].delete(m.id);
        if (m.ok) cb.resolve(m); else cb.reject(new Error(m.error));
    }));
    const ask = (k, message) => new Promise((resolve, reject) => {
        const id = next++;
        waiting[k].set(id, { resolve, reject });
        workers[k].send({ ...message, id });
    });
    const pool = {
        size, shared: canShare(), ask,
        broadcast: (message) => Promise.all(workers.map((_, k) => ask(k, message))),
        close: () => workers.forEach((w) => w.close()),
    };
    try {
        await pool.broadcast({ type: 'init', passes: passes.map(({ fragment, ...rest }) => rest) });
    } catch (error) {
        pool.close();                                          // workers that couldn't start the filter don't stay running
        throw error;
    } finally {
        revoke();                                              // every worker has loaded its script (or failed to)
    }
    return pool;
}

/**
 * GPU or CPU? One call that picks, and says why.
 *
 *   const { runner, engine, reason } = createRunner(compileFilter(def), { gl });
 *   runner.setImage(img);  runner.draw({ t, canvas });   // canvas: where the CPU draws (the GPU draws on gl's)
 *
 * The GPU whenever WebGL is there: a filter's shaders are compiled once and
 * then reused for every picture and every frame, so the compile is paid once
 * per filter, and after that the GPU is the faster engine. The CPU when
 * there is no WebGL (some browsers, Node, servers), when the GPU refuses the
 * shader, or when asked for (prefer: 'cpu'). Both give the same pixels
 * (tools/check.mjs --cpu compares them on every library filter).
 */


/** @returns {{ engine: 'gpu' | 'cpu', reason: string }} */
function chooseEngine({ webgl = false, prefer = 'auto' } = {}) {
    if (prefer === 'cpu') return { engine: 'cpu', reason: 'asked for the CPU' };
    if (!webgl) return { engine: 'cpu', reason: 'no WebGL here' };
    return { engine: 'gpu', reason: prefer === 'gpu' ? 'asked for the GPU' : 'WebGL is here' };
}

/**
 * @param {object} compiled compileFilter() output
 * @param {object} [o] { gl, prefer: 'auto' | 'gpu' | 'cpu', precision, workers }
 * @returns {{ runner, engine: 'gpu' | 'cpu', reason: string }}
 */
function createRunner(compiled, o = {}) {
    const choice = chooseEngine({ webgl: Boolean(o.gl), prefer: o.prefer });
    if (choice.engine === 'gpu') {
        try {
            return { runner: createFilterRunner(o.gl, compiled, { precision: o.precision }), ...choice };
        } catch (e) {
            if (o.prefer === 'gpu') throw e;
            return { runner: createCpuRunner(compiled, o), engine: 'cpu', reason: `the GPU refused the shader (${e.message.split('\n')[0]})` };
        }
    }
    return { runner: createCpuRunner(compiled, o), ...choice };
}

/**
 * The built-in filters: what the editor offers, and a catalogue anyone
 * embedding the runner can show. Each is a filter document (docs/filters.md)
 * plus a `group` for display (not part of the format; sharing drops it);
 * `npm test` checks that every one validates, compiles and survives a link.
 */

const FILTERS = [
  { name: 'Wave', group: 'Shape & motion', description: 'Rows slide back and forth as t advances',
    params: { amplitude: { default: 8, min: 0, max: 40 }, wavelength: { default: 10, min: 1, max: 60 }, speed: { default: 5, min: 1, max: 30 } },
    color: 'pixel(px + amplitude sin(py / wavelength + t / speed), py)' },
  { name: 'Invert', group: 'Colour & tone', color: '(1 - r, 1 - g, 1 - b)' },
  { name: 'Grayscale', group: 'Colour & tone', color: 'gray' },
  { name: 'Threshold', group: 'Colour & tone', params: { cutoff: 0.5 }, color: 'if gray > cutoff then 1 else 0' },
  { name: 'Posterize', group: 'Colour & tone', params: { levels: { default: 4, min: 2, max: 16, step: 1 } }, color: 'min(floor(rgb * levels) / (levels - 1), 1)' },
  { name: 'Brightness & contrast', group: 'Colour & tone',
    params: { brightness: { default: 0, min: -0.5, max: 0.5 }, contrast: { default: 1, min: 0, max: 3 } },
    color: '(rgb - 0.5) contrast + 0.5 + brightness' },
  { name: 'Tint', group: 'Colour & tone', params: { tint: [1, 0.85, 0.7] }, color: 'rgb * tint' },
  { name: 'Sepia', group: 'Colour & tone', color: '(0.393r + 0.769g + 0.189b, 0.349r + 0.686g + 0.168b, 0.272r + 0.534g + 0.131b)' },
  { name: 'Colour circle', group: 'Colour & tone', description: 'Black and white, except a soft circle that keeps its colour',
    params: { across: { default: 0.5, min: 0, max: 1, label: 'where, across' }, down: { default: 0.5, min: 0, max: 1, label: 'where, down' },
      radius: { default: 0.3, min: 0, max: 1 }, softness: { default: 0.08, min: 0, max: 0.5 } },
    notes: ['The colour stays inside a circle and fades to grey over the softness. Sizes are parts of the picture\'s shorter side, so it stays round.',
      { param: 'across' }, { param: 'down' }, { param: 'radius' }, { param: 'softness' }],
    color: 'mix((gray, gray, gray), rgb, 1 - smoothstep(radius, radius + softness, distance((px, py), (across w, down h)) / min(w, h)))' },
  { name: 'Vignette', group: 'Colour & tone', params: { strength: { default: 1.6, min: 0, max: 4 } }, color: 'rgb * (1 - strength ((x - 0.5)^2 + (y - 0.5)^2))' },
  { name: 'Sobel edges', group: 'Blur & edges', description: 'How fast the brightness changes', params: { gain: { default: 2, min: 0.2, max: 10 } }, color: 'gain sobel()' },
  { name: 'Edge map', group: 'Blur & edges', description: 'White where an edge is stronger than the cutoff', params: { cutoff: { default: 0.3, min: 0, max: 2 } }, color: 'if sobel() > cutoff then 1 else 0' },
  { name: 'Outline', group: 'Blur & edges', description: 'Ink lines over the colour', params: { gain: { default: 3, min: 0, max: 10 } }, color: 'rgb (1 - gain sobel())' },
  { name: 'Box blur', group: 'Blur & edges', params: { radius: { default: 2, min: 0, max: 8, step: 1 } }, color: 'blur(radius)' },
  { name: 'Gaussian blur', group: 'Blur & edges', description: 'Computed in two passes, across then down, so it can be wide', params: { sigma: { default: 3, min: 0, max: 8 } }, color: 'gaussian(sigma)' },
  { name: 'Canny edges', group: 'Blur & edges', description: 'Thin, clean edge lines: smooth, gradient, thinning, two thresholds, hysteresis — a chain',
    steps: [
      { params: { sigma: { default: 1.4, min: 0.5, max: 4 } }, color: 'gaussian(sigma)' },
      // gradient strength (r) and its direction as one of four buckets (g: 0, ¼, ½, ¾ for 0°, 45°, 90°, 135°)
      { color: '(min(sobel() / 4, 1), floor(fract((atan2(sobely(), sobelx()) + π/8) / π) 4) / 4, 0)' },
      // non-maximum suppression: keep a pixel only if it is at least as strong as its two neighbours along the gradient
      { color: 'if green(px, py) < 0.125 then (if r >= red(px - 1, py) & r >= red(px + 1, py) then r else 0)'
        + ' else if green(px, py) < 0.375 then (if r >= red(px + 1, py + 1) & r >= red(px - 1, py - 1) then r else 0)'
        + ' else if green(px, py) < 0.625 then (if r >= red(px, py - 1) & r >= red(px, py + 1) then r else 0)'
        + ' else (if r >= red(px - 1, py + 1) & r >= red(px + 1, py - 1) then r else 0)' },
      { params: { low: { default: 0.08, min: 0, max: 0.5 }, high: { default: 0.2, min: 0, max: 1 } }, color: 'if r > high then 1 else if r > low then 0.5 else 0' },
      // hysteresis: a weak edge next to a strong one becomes strong (three rounds), the rest goes
      'if r > 0.9 then 1 else if r > 0.4 then (if red(dilate(1)) > 0.9 then 1 else 0.5) else 0',
      'if r > 0.9 then 1 else if r > 0.4 then (if red(dilate(1)) > 0.9 then 1 else 0.5) else 0',
      'if r > 0.9 then 1 else if r > 0.4 then (if red(dilate(1)) > 0.9 then 1 else 0.5) else 0',
      'if r > 0.9 then 1 else 0',
    ] },
  { name: 'Sharpen', group: 'Blur & edges', params: { amount: { default: 0.6, min: 0, max: 3 } }, color: 'sharpen(amount)' },
  { name: 'Unsharp mask', group: 'Blur & edges', description: 'The picture plus what a blur removes', params: { amount: { default: 1.5, min: 0, max: 5 }, sigma: { default: 2, min: 0.5, max: 4 } }, color: 'rgb + amount (rgb - gaussian(sigma))' },
  { name: 'Bloom', group: 'Blur & edges', description: 'Bright parts glow', params: { amount: { default: 0.8, min: 0, max: 3 }, sigma: { default: 3, min: 0.5, max: 4 }, cutoff: { default: 0.6, min: 0, max: 1 } },
    color: 'rgb + amount max(gaussian(sigma) - cutoff, 0)' },
  { name: 'Emboss', group: 'Blur & edges', color: 'emboss()' },
  { name: 'Dilate', group: 'Blur & edges', description: 'Light areas grow', params: { radius: { default: 2, min: 0, max: 8, step: 1 } }, color: 'dilate(radius)' },
  { name: 'Erode', group: 'Blur & edges', description: 'Dark areas grow', params: { radius: { default: 2, min: 0, max: 8, step: 1 } }, color: 'erode(radius)' },
  { name: '3×3 kernel', group: 'Blur & edges', description: 'Your own convolution; the default is a sharpen',
    params: { k1: { default: 0, min: -8, max: 8 }, k2: { default: -1, min: -8, max: 8 }, k3: { default: 0, min: -8, max: 8 }, k4: { default: -1, min: -8, max: 8 }, k5: { default: 5, min: -8, max: 8 }, k6: { default: -1, min: -8, max: 8 }, k7: { default: 0, min: -8, max: 8 }, k8: { default: -1, min: -8, max: 8 }, k9: { default: 0, min: -8, max: 8 } },
    color: 'convolve(k1, k2, k3, k4, k5, k6, k7, k8, k9)' },
  { name: 'Pixelate', group: 'Shape & motion', params: { size: { default: 8, min: 1, max: 32, step: 1 } }, color: 'pixel(floor(px / size) size, floor(py / size) size)' },
  { name: 'Mirror', group: 'Shape & motion', color: 'pixel(w - px, py)' },
  { name: 'Scanlines', group: 'Shape & motion', params: { period: { default: 4, min: 2, max: 16, step: 1 } }, color: 'if py mod period < period / 2 then rgb else rgb * 0.6' },
  { name: 'Pulse', group: 'Shape & motion', description: 'Brightness breathes with t', params: { speed: { default: 6, min: 1, max: 30 }, depth: { default: 0.25, min: 0, max: 1 } },
    color: 'rgb (1 - depth + depth sin(t / speed))' },
  { name: 'Chroma key', group: 'Colour & tone', description: 'Replaces one colour with another',
    params: { key: [0.22, 0.71, 0.29], tolerance: { default: 0.35, min: 0, max: 1 }, background: [0.1, 0.1, 0.4] },
    color: 'if distance(rgb, key) < tolerance then background else rgb' },
  { name: 'Through a mask', group: 'Other pictures', description: 'Put this last: the steps above show only where the mask is light',
    images: { mask: { description: 'light where the effect shows' } }, color: 'mix(source, rgb, luma(mask))' },
  { name: 'Mix', group: 'Other pictures', description: 'Fade towards another picture', images: ['overlay'], params: { amount: 0.5 }, color: 'mix(rgb, overlay, amount)' },
  { name: 'Masked mix', group: 'Other pictures', images: { overlay: {}, mask: { description: 'light where the overlay shows' } }, color: 'mix(rgb, overlay, luma(mask))' },
  { name: 'Multiply', group: 'Other pictures', images: ['overlay'], color: 'rgb * overlay' },
  { name: 'Screen', group: 'Other pictures', images: ['overlay'], color: '1 - (1 - rgb)(1 - overlay)' },
  { name: 'Overlay blend', group: 'Other pictures', images: ['overlay'], color: 'if gray < 0.5 then 2 rgb overlay else 1 - 2 (1 - rgb)(1 - overlay)' },
  { name: 'Difference', group: 'Other pictures', images: ['overlay'], color: 'abs(rgb - overlay)' },
  { name: 'Alpha over', group: 'Other pictures', description: 'A picture with transparency laid on top', images: ['overlay'], color: 'mix(rgb, overlay, alpha(overlay))' },
  { name: 'Chroma key onto a picture', group: 'Other pictures', images: { background: {} },
    params: { key: [0.22, 0.71, 0.29], tolerance: { default: 0.35, min: 0, max: 1 } }, color: 'if distance(rgb, key) < tolerance then background else rgb' },
  { name: 'Only inside the selection', group: 'Other pictures', description: 'Put this last: the steps above show only inside what you selected on the picture (everywhere, without a selection)',
    color: 'mix(source, rgb, selected)' },
  { name: 'Only outside the selection', group: 'Other pictures', description: 'Put this last: the steps above show only outside what you selected', color: 'mix(rgb, source, selected)' },
  { name: 'Caption', group: 'Text & shapes', description: 'Words along the bottom, with a soft shadow; change them under the step',
    graphics: { title: { text: 'Your caption here', y: 0.88 } }, color: 'mix(rgb, title, alpha(title))' },
  { name: 'Poster title', group: 'Text & shapes', description: 'Big outlined letters across the top',
    graphics: { title: { text: 'BIG TITLE', font: 'Impact, Haettenschweiler, sans-serif', weight: 'normal', size: 0.16, y: 0.14, outline: { color: '#000000', width: 0.08 }, shadow: null } },
    color: 'mix(rgb, title, alpha(title))' },
  { name: 'Gradient text', group: 'Text & shapes', description: 'The letters coloured by maths: a sunset from left to right',
    graphics: { title: { text: 'Golden hour', font: 'Georgia, serif', size: 0.13, y: 0.5, shadow: { color: 'rgba(0,0,0,0.5)', blur: 0.2, dx: 0, dy: 0.05 } } },
    color: 'mix(rgb, mix((1, 0.35, 0.3), (1, 0.85, 0.25), x), alpha(title))' },
  { name: 'Neon sign', group: 'Text & shapes', description: 'White letters with a coloured glow',
    graphics: { title: { text: 'OPEN', font: 'Trebuchet MS, sans-serif', size: 0.18, y: 0.5, shadow: { color: '#00e5ff', blur: 0.45, dx: 0, dy: 0 } } },
    color: 'mix(rgb * 0.6, title, alpha(title))' },
  { name: 'Layered shadow', group: 'Text & shapes', description: 'Two shadow layers, each with its own filter: a soft glow that darkens and breathes with t, and a hard offset coloured by a gradient',
    graphics: { title: { text: 'LAYERS', font: 'Impact, Haettenschweiler, sans-serif', weight: 'normal', size: 0.17, y: 0.5, shadow: null,
      shadows: [{ color: '#000000', blur: 0.7, dx: 0, dy: 0.08 }, { color: '#000000', blur: 0, dx: 0.07, dy: 0.07 }] } },
    color: 'mix(mix(mix(rgb, rgb * 0.25, alpha(title_shadow1) (0.7 + 0.3 sin(t / 10))), mix((1, 0.2, 0.6), (0.2, 0.6, 1), x), alpha(title_shadow2)), title, alpha(title))' },
  { name: 'Ink brush', group: 'Brushes', description: 'Paint in a colour; draw on the picture with "draw" under the step',
    graphics: { brush: { type: 'strokes', brush: 'round', size: 0.025 } }, params: { ink: [0.95, 0.2, 0.25] }, color: 'mix(rgb, ink, alpha(brush))' },
  { name: 'Blur brush', group: 'Brushes', description: 'Paint a blur in — stronger every time a stroke goes over the same place',
    graphics: { brush: { type: 'strokes', brush: 'soft', size: 0.08 } }, color: 'mix(rgb, gaussian(2 + 3 min(4 green(brush), 3)), alpha(brush))' },
  { name: 'Darken brush', group: 'Brushes', description: 'Each pass darkens a little more, like layers of a wash',
    graphics: { brush: { type: 'strokes', brush: 'soft', size: 0.07, flow: 0.7 } }, color: 'rgb (1 - 0.22 min(4 green(brush), 4))' },
  { name: 'Colour reveal brush', group: 'Brushes', description: 'The picture starts grey; the brush paints its colour back',
    graphics: { brush: { type: 'strokes', brush: 'soft', size: 0.1 } }, color: 'mix((gray, gray, gray), rgb, alpha(brush))' },
  { name: 'Fuse brush', group: 'Brushes', description: 'Paint glows as it goes down, then cools to charcoal (red(brush) is its age)',
    graphics: { brush: { type: 'strokes', brush: 'round', size: 0.02, age: 40 } },
    color: 'mix(rgb, mix((1, 0.9, 0.5), (0.1, 0.07, 0.06), red(brush)), alpha(brush)) + (1, 0.5, 0.1) alpha(brush) max(0, 1 - 3 red(brush)) 0.6' },
  { name: 'Rainbow brush', group: 'Brushes', description: 'The colour runs round the wheel along the drawing (blue(brush) is how far through it)',
    graphics: { brush: { type: 'strokes', brush: 'marker', size: 0.035 } }, color: 'mix(rgb, fromhsv(blue(brush), 0.85, 1), alpha(brush))' },
  { name: 'Chalk outline', group: 'Brushes', description: 'Chalk round an object: select it, then "outline the selection" under the step',
    graphics: { brush: { type: 'strokes', brush: 'chalk', size: 0.018, timing: 'even', speed: 2 } }, color: 'mix(rgb, (0.97, 0.97, 0.92), alpha(brush))' },
  { name: 'Frosted panel', group: 'Text & shapes', description: 'A rounded panel that blurs and darkens what is behind it — a shape with its own filter',
    graphics: { panel: { type: 'rect', y: 0.86, w: 0.9, h: 0.2, radius: 0.25 } }, color: 'mix(rgb, gaussian(5) * 0.7, alpha(panel))' },
  { name: 'Spotlight oval', group: 'Text & shapes', description: 'Darkens everything but a soft oval',
    graphics: { spot: { type: 'ellipse', x: 0.5, y: 0.45, w: 0.45, h: 0.55, shadow: { color: '#ffffff', blur: 0.12, dx: 0, dy: 0 } } }, color: 'mix(rgb * 0.3, rgb, alpha(spot))' },
  { name: 'Scrolling banner', group: 'Text & shapes', description: 'Text that slides across and wraps round (animated with t)',
    graphics: { title: { text: 'Breaking news · scrolling text · ', size: 0.07, y: 0.92 } }, params: { speed: { default: 3, min: -10, max: 10 } },
    color: 'mix(rgb, shift(title, -speed t, 0), alpha(shift(title, -speed t, 0)))' },
  { name: 'Pulsing title', group: 'Text & shapes', description: 'Text that grows and shrinks a little (animated with t)',
    graphics: { title: { text: 'Hello!', size: 0.14, y: 0.5 } }, params: { amount: { default: 0.06, min: 0, max: 0.3 } },
    color: 'mix(rgb, zoom(title, 1 + amount sin(t / 8)), alpha(zoom(title, 1 + amount sin(t / 8))))' },
  { name: 'Fade-in title', group: 'Text & shapes', description: 'Text that fades in over the first frames (animated with t)',
    graphics: { title: { text: 'Once upon a time', font: 'Georgia, serif', style: 'italic', weight: 'normal', size: 0.09, y: 0.5 } }, params: { frames: { default: 40, min: 1, max: 200 } },
    color: 'mix(rgb, title, alpha(title) clamp(t / frames, 0, 1))' },
  { name: 'Zoom', group: 'Shape & motion', params: { scale: { default: 1.5, min: 0.25, max: 4 }, cx: 0.5, cy: 0.5 }, color: 'zoom(scale, cx, cy)' },
  { name: 'Ken Burns', group: 'Shape & motion', description: 'A slow zoom that drifts across — a still picture that moves',
    params: { speed: { default: 0.002, min: 0, max: 0.01 }, drift: { default: 0.0003, min: -1e-3, max: 0.001 } }, color: 'zoom(1 + speed t, 0.5 + drift t, 0.45)' },
  { name: 'Scroll', group: 'Shape & motion', description: 'Slides and wraps around', params: { dx: { default: 1, min: -5, max: 5 }, dy: { default: 0, min: -5, max: 5 } }, color: 'shift(dx t, dy t)' },
  { name: 'Spin', group: 'Shape & motion', params: { speed: { default: 0.01, min: -0.05, max: 0.05 } }, color: 'rotate(speed t)' },
  { name: 'Tile', group: 'Shape & motion', params: { n: { default: 2, min: 1, max: 8, step: 1 } }, color: 'tile(n)' },
  { name: 'Crop', group: 'Shape & motion', description: 'A part of the picture, filling the frame', params: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 }, color: 'crop(left, top, right, bottom)' },
  { name: 'Flip', group: 'Shape & motion', color: 'flipx()' },
  { name: 'Picture in picture', group: 'Other pictures', description: 'Another picture, fitted small in a corner',
    images: { inset: { description: 'any size: it is fitted whole', place: 'fit', zoom: 0.35, x: 0.8, y: 0.78 } }, color: 'mix(rgb, inset, alpha(inset))' },
  { name: 'Moving overlay', group: 'Other pictures', description: 'Another picture scrolling across at half strength', images: ['overlay'], params: { speed: { default: 2, min: -10, max: 10 } },
    color: 'mix(rgb, shift(overlay, speed t, 0), 0.5)' },
  { name: 'Hue shift', group: 'Colour & tone', description: 'Turns every colour around the hue wheel (in HSV)', space: 'hsv',
    params: { amount: { default: 0.1, min: -0.5, max: 0.5 } }, color: '(fract(r + amount), g, b)' },
  { name: 'Saturation', group: 'Colour & tone', description: 'More or less colour (in HSV)', space: 'hsv',
    params: { amount: { default: 1.5, min: 0, max: 3 } }, color: '(r, clamp(g amount, 0, 1), b)' },
  { name: 'Lightness', group: 'Colour & tone', description: 'Lighter or darker without changing the colours (in Lab)', space: 'lab',
    params: { amount: { default: 1.15, min: 0.5, max: 2 } }, color: '(clamp(r amount, 0, 1), g, b)' },
  { name: 'Vivid', group: 'Colour & tone', description: 'Colourfulness, perceptually even (in OKLab)', space: 'oklab',
    params: { amount: { default: 1.6, min: 0, max: 3 } }, color: '(r, 0.5 + (g - 0.5) amount, 0.5 + (b - 0.5) amount)' },
  { name: 'Linear-light blur', group: 'Blur & edges', description: 'A Gaussian in linear light: bright spots stay bright, as a lens does', space: 'linear',
    params: { sigma: { default: 3, min: 0, max: 8 } }, color: 'gaussian(sigma)' },
  { name: 'Film grain', group: 'Colour & tone', description: 'Noise that changes every frame', params: { amount: { default: 0.15, min: 0, max: 0.6 } }, color: 'rgb + amount (random() - 0.5)' },
  { name: 'Swirl', group: 'Shape & motion', params: { strength: { default: 0.02, min: 0, max: 0.1 } },
    color: 'pixel(w/2 + (px - w/2) cos(strength t gray) - (py - h/2) sin(strength t gray), h/2 + (px - w/2) sin(strength t gray) + (py - h/2) cos(strength t gray))' },
];
const byName$1 = (name) => FILTERS.find((f) => f.name === name);
FILTERS.push(
  { name: 'Old film', group: 'Chains', description: 'Sepia, a vignette and faint scanlines — a chain of three',
    steps: [byName$1('Sepia'), { filter: byName$1('Vignette'), with: { strength: 1.2 } }, { filter: byName$1('Scanlines'), opacity: 0.5 }] },
  { name: 'Comic', group: 'Chains', description: 'Bold flat colours with ink lines: a small blur first, so a photo\'s fine texture isn\'t inked — a chain of four',
    steps: [{ filter: byName$1('Gaussian blur'), with: { sigma: 1.6 } }, { filter: byName$1('Vivid'), with: { amount: 1.5 } },
      { filter: byName$1('Posterize'), with: { levels: 4 } }, { filter: byName$1('Outline'), with: { gain: 1.2 } }] },
  { name: 'Cartoon', group: 'Chains', description: 'Blur, then flatten the colours, then outline — a chain of three',
    steps: [{ filter: byName$1('Gaussian blur'), with: { sigma: 1.5 } }, { filter: byName$1('Posterize'), with: { levels: 6 } }, { filter: byName$1('Outline'), with: { gain: 2 } }] },
  { name: 'Dreamy', group: 'Chains', description: 'A soft glow mixed over the picture',
    steps: [{ filter: byName$1('Bloom'), with: { amount: 1.2 } }, { filter: byName$1('Gaussian blur'), with: { sigma: 2 }, opacity: 0.4 }] },
  { name: 'Tilt shift', group: 'Chains', description: 'Blurred where the mask is light — a chain',
    steps: [{ filter: byName$1('Gaussian blur'), with: { sigma: 4 } }, byName$1('Through a mask')] },
  { name: 'Title card', group: 'Chains', description: 'A frosted panel with a caption on it — a chain of two',
    steps: [byName$1('Frosted panel'), { filter: byName$1('Caption'), with: { title: { text: 'A title on a panel', y: 0.86 } } }] },
  { name: 'Colour spotlight', group: 'Chains', description: 'Grey except where the mask is dark — a chain',
    steps: [byName$1('Grayscale'), byName$1('Through a mask')] },
);

const LIBRARY = FILTERS;

/** The groups the editor shows the library in, in this order; every filter names one. */
const GROUPS = ['Colour & tone', 'Blur & edges', 'Shape & motion', 'Text & shapes', 'Brushes', 'Other pictures', 'Chains'];

/** Shareable image filters: the JSON format (format.js), the GPU and CPU runners, the library, graphics and strokes. Two more entries:
 *  @mathzetta/qblur/apply (applyFilter and saving: apply.js) and @mathzetta/qblur/element (<qblur-image>: element.js). */

var filters = /*#__PURE__*/Object.freeze({
    __proto__: null,
    BRUSHES: BRUSHES,
    CLIPS: CLIPS,
    FILTER_FORMAT: FILTER_FORMAT,
    FPS: FPS,
    GRAPHIC_DEFAULTS: GRAPHIC_DEFAULTS,
    GRAPHIC_TYPES: GRAPHIC_TYPES,
    GROUPS: GROUPS,
    LIBRARY: LIBRARY,
    MAX_SHADOW_LAYERS: MAX_SHADOW_LAYERS,
    PLACEMENT: PLACEMENT,
    STROKES_DEFAULTS: STROKES_DEFAULTS,
    TIMINGS: TIMINGS,
    WIDTH_FROM: WIDTH_FROM,
    chooseEngine: chooseEngine,
    compileCpuPass: compileCpuPass,
    compileFilter: compileFilter,
    createCpuRunner: createCpuRunner,
    createFilterRunner: createFilterRunner,
    createRunner: createRunner,
    cssFont: cssFont,
    drawGraphic: drawGraphic,
    familyFor: familyFor,
    filterFromJSON: filterFromJSON,
    filterFromLink: filterFromLink,
    filterGraphics: filterGraphics,
    filterImages: filterImages,
    filterParams: filterParams,
    filterToJSON: filterToJSON,
    filterToLink: filterToLink,
    fontFileFromCss: fontFileFromCss,
    googleFontFamily: googleFontFamily,
    googleFontUrl: googleFontUrl,
    layeredExpression: layeredExpression,
    loadGraphicFonts: loadGraphicFonts,
    normalizeFilter: normalizeFilter,
    normalizeGraphic: normalizeGraphic,
    normalizeStrokes: normalizeStrokes,
    rasterizeStrokes: rasterizeStrokes,
    readFilter: readFilter,
    renderGraphics: renderGraphics,
    shadowLayerNames: shadowLayerNames,
    simplify: simplify,
    simplifyLoop: simplifyLoop,
    strokeTimeline: strokeTimeline,
    toPicture: toPicture,
    traceContours: traceContours,
    validateFilter: validateFilter
});

/**
 * The editor's cheat sheet, and the hints that go with error messages.
 *
 * Plain data and functions (no DOM), so the page renders HELP and the tests
 * read it: every section's `guide` must be a heading in docs/filters.md.
 * An example is a bare expression, or `{ def, show }` when it needs a
 * filter document (pictures, params); "Try" adds it to the chain.
 */

const HELP = [
    {
        id: 'pixel', title: 'The pixel', guide: 'what-an-expression-can-use',
        rows: [
            ['r g b a', 'its red, green, blue and alpha, 0–1'],
            ['rgb', 'all three as one colour'],
            ['gray', 'its brightness'],
            ['x y', 'where it is: 0–1 across and down'],
            ['px py', 'the same in pixels'],
            ['w h', 'the picture\'s width and height'],
            ['t', 'the frame number — put it in the maths and the picture moves'],
            ['random()', 'a new number 0–1 for every pixel, every frame'],
        ],
        examples: [
            ['1 - rgb', 'invert'],
            ['gray', 'black and white'],
            ['rgb * (1 - 1.6 ((x - 0.5)^2 + (y - 0.5)^2))', 'vignette'],
            ['rgb (0.75 + 0.25 sin(t / 6))', 'pulsing'],
        ],
    },
    {
        id: 'results', title: 'What a result can be', guide: 'results-numbers-colours-truefalse',
        rows: [
            ['a number', 'grey — or, for one channel, that channel'],
            ['(r, g, b)', 'a colour'],
            ['r > 0.5', 'a comparison: 1 where true, 0 where false — a mask to multiply by'],
            ['unchanged', 'what the step started with'],
        ],
        examples: [
            ['(g, r, b)', 'swap red and green'],
            ['(r > 0.5) rgb', 'keep only where red is strong'],
        ],
    },
    {
        id: 'if', title: 'Conditions', guide: 'conditionals',
        note: 'Both branches must be the same kind of thing: two numbers, or two colours.',
        rows: [
            ['if c then a else b', ''],
            ['if c then a', 'without an else the pixel keeps its value'],
            ['a & b   a | b   !a', 'and, or, not'],
            ['IF(c, a, b)   c ? a : b', 'the same, spreadsheet and C style'],
        ],
        examples: [
            ['if gray > 0.5 then 1 else 0', 'threshold'],
            ['if y < 0.5 then rgb else 1 - rgb', 'invert the bottom half'],
            ['if g > 0.5 & g > 1.3 r & g > 1.3 b then (0.1, 0.1, 0.4) else rgb', 'chroma key'],
        ],
    },
    {
        id: 'near', title: 'Nearby pixels', guide: 'blur-edges-and-other-neighbourhood-functions',
        rows: [
            ['pixel(px, py)', 'the pixel there'],
            ['red(px, py) … luma(px, py)', 'one of its channels'],
            ['blur(radius)   gaussian(sigma)', 'blurs — alone in a step, computed in two fast passes that reach ±24 px'],
            ['blurx blury gaussianx gaussiany', 'along one axis'],
            ['sharpen(amount)', ''],
            ['sobel()   laplacian()   emboss()', 'edge strength, relief — "Canny edges" in the library chains them into clean lines'],
            ['dilate(r)   erode(r)', 'light or dark areas grow'],
            ['convolve(k1, …, k9)', 'your own 3×3 kernel'],
        ],
        examples: [
            ['gaussian(3)', 'blur'],
            ['rgb + 1.5 (rgb - gaussian(2))', 'unsharp mask'],
            ['if sobel() > 0.3 then 1 else 0', 'edge map'],
            ['pixel(w - px, py)', 'mirror'],
        ],
    },
    {
        id: 'move', title: 'Moving the picture', guide: 'moving-the-picture-zoom-pan-rotate-crop-tile',
        rows: [
            ['zoom(s)   zoom(s, cx, cy)', 's times larger, about the centre or a point (0–1)'],
            ['shift(dx, dy)', 'moved by that many pixels, wrapping around'],
            ['rotate(a)', 'turned clockwise, radians — rotate(30°) works'],
            ['crop(x0, y0, x1, y1)', 'that part (0–1) filling the frame'],
            ['tile(n)', 'repeated n × n'],
            ['flipx()   flipy()', 'mirrored'],
            ['zoom(overlay, 2)', '…any of them on another picture'],
            ['alpha(zoom(0.5))', '1 inside the picture, 0 outside'],
        ],
        note: 'On its own, a moved picture is transparent where it leaves the frame (zoom out, rotate); inside a bigger expression it is black there, and alpha(zoom(…)) tells you where it is.',
        examples: [
            ['zoom(1 + 0.002 t, 0.5 + 0.0003 t, 0.45)', 'Ken Burns'],
            ['shift(2 t, 0)', 'scrolling'],
            ['rotate(t / 100)', 'spinning'],
            ['tile(2)', 'four copies'],
        ],
    },
    {
        id: 'pictures', title: 'Other pictures', guide: 'several-pictures-masks-and-blending',
        note: 'A filter names the pictures it needs — "images": ["mask"] in its JSON — and the editor shows a chooser and placement knobs for each.',
        rows: [
            ['source', 'the picture before any step'],
            ['mask   overlay   …', 'a named picture: its colour at this pixel'],
            ['overlay(px, py)', 'any pixel of it'],
            ['luma(mask)   alpha(overlay)   red(…)', 'one channel of it'],
            ['width(overlay)   height(overlay)', 'its size'],
            ['selected', '1 inside the object you selected on the picture (trace its edge — click past the picture to run along its border —, click its colours, or let the AI find it; the refine brush paints parts in or out and the edge settles), 0 outside — 1 everywhere without a selection. On a video or GIF, "Track an object" makes it follow the object frame by frame'],
        ],
        examples: [
            { def: { images: ['overlay'], color: 'mix(rgb, overlay, 0.5)' }, show: '{ "images": ["overlay"], "color": "mix(rgb, overlay, 0.5)" }', caption: 'fade to another picture' },
            { def: { images: ['overlay'], color: 'rgb * overlay' }, show: '{ "images": ["overlay"], "color": "rgb * overlay" }', caption: 'multiply' },
            { def: { images: { mask: { description: 'light where the effect shows' } }, color: 'mix(source, rgb, luma(mask))' }, show: '{ "images": ["mask"], "color": "mix(source, rgb, luma(mask))" }', caption: 'put last: the steps above show only where the mask is light' },
            ['mix(source, rgb, selected)', 'put last: the steps above show only inside your selection'],
        ],
    },
    {
        id: 'text', title: 'Text and shapes', guide: 'text-and-shapes',
        note: 'Add with "+ text", "+ rectangle" or "+ oval" under the picture, or from the library\'s Text & shapes. Each graphic is a picture under its name: its colour, and alpha(name) for where it is.',
        rows: [
            ['mix(rgb, title, alpha(title))', 'lay the text on'],
            ['mix(rgb, (1, 0.8, 0.2), alpha(title))', 'in a colour the maths chooses'],
            ['mix(rgb, gaussian(5) * 0.7, alpha(panel))', 'a shape with its own filter: frosted glass'],
            ['shift(title, -3 t, 0)   zoom(title, 1 + 0.06 sin(t / 8))', 'animated, like any picture'],
            ['title_shadow1   title_shadow2', 'its shadow layers ("+ shadow layer"), each a picture of its own: mix(rgb, gaussian(4), alpha(title_shadow1)) gives one its own filter'],
            ['font', 'pick from the list, type a Google Fonts name and press "use", or load a font file'],
            ['alpha(brush)   red(brush)   green(brush)   blue(brush)', 'a brush ("+ brush"): where the paint is, how long ago it was painted (0 → 1), passes ÷ 4, how far through the drawing'],
        ],
        examples: [
            { def: { graphics: { title: { text: 'Hello', y: 0.5, size: 0.12 } }, color: 'mix(rgb, title, alpha(title))' }, show: '{ "graphics": { "title": { "text": "Hello" } }, "color": "mix(rgb, title, alpha(title))" }', caption: 'a caption' },
            { def: { graphics: { title: { text: 'Golden', font: 'Georgia, serif', size: 0.14, y: 0.5 } }, color: 'mix(rgb, mix((1, 0.35, 0.3), (1, 0.85, 0.25), x), alpha(title))' }, show: 'mix(rgb, mix((1, 0.35, 0.3), (1, 0.85, 0.25), x), alpha(title))', caption: 'gradient letters' },
        ],
    },
    {
        id: 'spaces', title: 'Colour spaces', guide: 'colour-spaces',
        note: 'Pick a space next to the expression box (or "space": "hsv" in the JSON) and r g b are hue, saturation, value — every read of the picture is in that space, and the result is converted back. gray is still the brightness you see.',
        rows: [
            ['sRGB', 'what the picture holds; the default'],
            ['linear', 'light, not gamma: blurs and mixes behave like a lens'],
            ['HSV   HSL', 'r g b = hue (0–1 around the wheel), saturation, value / lightness'],
            ['Lab   OKLab', 'r = lightness 0–1, g b = colour axes centred on 0.5'],
            ['YCbCr', 'r = luma, g b = chroma centred on 0.5'],
            ['tohsv(c)   fromhsv(c)   tolab(c)   tooklab(c)   tolinear(c)   …', 'convert a colour yourself, inside any expression'],
        ],
        examples: [
            { def: { space: 'hsv', color: '(fract(r + 0.1), g, b)' }, show: 'HSV: (fract(r + 0.1), g, b)', caption: 'hue shift' },
            { def: { space: 'oklab', color: '(r, 0.5 + (g - 0.5) 1.6, 0.5 + (b - 0.5) 1.6)' }, show: 'OKLab: (r, 0.5 + (g - 0.5) 1.6, 0.5 + (b - 0.5) 1.6)', caption: 'more vivid' },
            ['fromhsv(fract(red(tohsv(rgb)) + t / 300), green(tohsv(rgb)), blue(tohsv(rgb)))', 'hue cycling, in sRGB with conversions'],
        ],
    },
    {
        id: 'params', title: 'Knobs, chains and sharing', guide: 'sharing-filters',
        note: 'Paste a filter\'s JSON into Import, or share yours with Copy link — the link holds the whole filter. Export (under the picture) saves the result at any size, cropped, as PNG, JPEG or WebP; "auto" estimates each and picks the smallest sensible one.',
        rows: [
            ['"params": { "amount": 0.5 }', 'a slider; use amount in the maths'],
            ['"params": { "tint": [1, 0.8, 0.6] }', 'a colour picker'],
            ['"with": { "amount": 0.3 }', 'what a chain sets a step to'],
            ['"opacity": 0.5', 'how much of a step shows'],
        ],
        examples: [
            { def: { name: 'My threshold', params: { cutoff: 0.5 }, color: 'if gray > cutoff then 1 else 0' }, show: '{ "name": "My threshold", "params": { "cutoff": 0.5 }, "color": "if gray > cutoff then 1 else 0" }', caption: 'a filter with a knob' },
        ],
    },
    {
        id: 'maths', title: 'Maths that works', guide: 'what-an-expression-can-use',
        note: 'Colours and numbers combine: rgb * 0.5, rgb + 0.1, 1 - rgb; two colours combine channel by channel. Not here: derivatives, integrals, sums over an index.',
        rows: [
            ['+ − × ÷ ^', 'and writing things next to each other: 2x, rgb overlay'],
            ['sin cos tan asin acos atan2 exp log sqrt abs floor ceil round min max', ''],
            ['a mod b', 'the remainder: py mod 4'],
            ['mix(a, b, k)   clamp(v, 0, 1)   smoothstep(0, 1, v)   step(e, v)   fract(v)   distance(a, b)   length(v)   dot(a, b)', 'from GLSL'],
            ['π   e   30°', 'constants, and degrees'],
        ],
        examples: [
            ['clamp(rgb * 1.4 - 0.2, 0, 1)', 'more contrast'],
            ['mix(rgb, gray, 0.6)', 'desaturate'],
        ],
    },
];

const SECTION = Object.fromEntries(HELP.map((s) => [s.id, s]));

/**
 * An error message, cleaned up and with a hint: which help section (and
 * guide heading) explains it. `{ text, hint?, id?, guide? }`.
 */
function explain(message) {
    const text = String(message ?? '').replace(/ERROR: \d+:\d+: /g, '').trim();
    const at = (id, hint) => ({ text, hint, id, guide: SECTION[id].guide });
    let m;
    if ((m = /'([^']+)' : undeclared identifier/.exec(text)) || (m = /unknown (?:name|function|picture) "([^"]+)"/.exec(text))) {
        return at('pixel', `"${m[1]}" isn't a name the filter knows. The pixel's names are r g b a rgb gray x y px py w h t; a knob needs "params", another picture needs "images".`);
    }
    if (/mismatching ternary|ternary operator/i.test(text)) return at('if', 'Both sides of an if must be the same kind of thing: two numbers, or two colours like (1, 0, 0) and rgb.');
    if (/no matching overloaded function|wrong operand types|operand types|cannot convert|dimension mismatch/i.test(text)) {
        return at('maths', 'Something got the wrong kind of argument — a colour where a number is needed, or the other way round: mix(colour, colour, number), gaussian(number).');
    }
    if (/Failed to parse|missing an operand|Unmatched|Unexpected|Empty expression|Empty brackets|syntax error/i.test(text)) {
        return at('maths', 'The maths doesn\'t parse: check brackets and operators. Multiply by writing things next to each other (2 rgb) or with *.');
    }
    if (/"with" sets|no parameter called|Parameter |"params"|should be a (?:number|colour)/i.test(text)) return at('params', 'Knobs are declared in "params" and set with "with"; a chain can only set knobs its filters have.');
    if (/Image |"images"|"place"|is both a parameter and an image|always available/i.test(text)) return at('pictures', 'Pictures are declared in "images"; each can be placed with place, zoom, x, y and angle.');
    if (/not allowed|refused|unsafe/i.test(text)) return at('maths', 'That isn\'t something a filter can do — only the maths listed here runs.');
    if (/context (?:was|is) lost/i.test(text)) return { text, hint: 'Waiting for the GPU. If it keeps happening, choose CPU under "runs on".' };
    if (/not a filter|Not valid JSON|Not a filter link|Unknown filter format/i.test(text)) return at('params', 'Paste a filter\'s JSON, a share link, or just an expression.');
    return { text };
}

/**
 * The examples: a guided tour of what filters can do, each on a picture
 * that suits it, with the features it shows and its maths explained in
 * steps. Plain data; the page renders it, test/examples.test.js checks
 * every one compiles, and tools/check.mjs runs every one in WebGL.
 *
 * `picture` is a photo's file name in demo/photos/index.json (or 'test' for
 * the drawn test picture); the page falls back to the first photo.
 * `filter` is an ordinary filter document — a single filter or a chain.
 * In `how`, `code` spans are written with backticks.
 */

const caption = (text, extra = {}) => ({
    graphics: { title: { text, y: 0.88, size: 0.075, ...extra } },
    color: 'mix(rgb, title, alpha(title))',
});

const EXAMPLES = [
    {
        id: 'first',
        title: 'Your first filter',
        picture: 'charleston.jpg',
        shows: ['maths on every pixel'],
        how: [
            'A filter is one line of maths run on every pixel. `rgb` is the pixel\'s colour, three numbers from 0 to 1.',
            '`1 - rgb` turns each number around: dark becomes light, red becomes cyan. That is the whole filter.',
            'Try changing it in the step below: `rgb * 1.3` brightens, `rgb ^ 2` deepens the shadows, `(g, r, b)` swaps red and green.',
        ],
        filter: { name: 'Negative', steps: ['1 - rgb'] },
    },
    {
        id: 'duotone',
        title: 'Duotone with two colour knobs',
        picture: 'mountains.jpg',
        shows: ['knobs (params)', 'mix'],
        how: [
            '`gray` is how bright the pixel looks. `mix(dark, light, gray)` paints black pixels in one colour, white in the other, and blends between.',
            '`dark` and `light` are knobs: declared in "params" with a colour each, they show up as colour pickers under the step — and travel in a share link with whatever you pick.',
        ],
        filter: {
            name: 'Duotone', params: { dark: [0.12, 0.09, 0.35], light: [1, 0.78, 0.45] },
            color: 'mix(dark, light, gray)',
        },
    },
    {
        id: 'splash',
        title: 'Colour splash: keep only the reds',
        picture: 'redumbrella.jpg',
        shows: ['colour spaces', 'conditions', 'knobs'],
        how: [
            '`tohsv(rgb)` gives hue, saturation and value; `red(…)` of it is the hue, 0–1 round the colour wheel, where red sits at both ends.',
            '`if … then rgb else (gray, gray, gray)` keeps the pixel\'s colour only when the condition holds; elsewhere it is grey. Both sides of an `if` must be the same kind of thing — `rgb` is a colour, so the grey is written as one too.',
            'The condition asks for a hue near red (the `band` knob) that is also strongly saturated (the `vivid` knob): the whole scene is warm, and without that the red-brown dome and coats would count too. Drag the knobs to see.',
        ],
        filter: {
            name: 'Colour splash', params: { band: { default: 0.035, min: 0.01, max: 0.2 }, vivid: { default: 0.62, min: 0, max: 1 } },
            color: 'if (red(tohsv(rgb)) < band | red(tohsv(rgb)) > 1 - band) & green(tohsv(rgb)) > vivid then rgb else (gray, gray, gray)',
        },
    },
    {
        id: 'tiltshift',
        title: 'Tilt-shift miniature',
        picture: 'cityabove.jpg',
        shows: ['neighbouring pixels', 'position (y)', 'chains', 'colour spaces'],
        how: [
            'Seen from above, a real city looks like a model when only a band of it is sharp — as with a close-up lens. Step 1: `gaussian(4)` is a blur — it looks at the pixels around this one. `smoothstep(0.06, 0.25, abs(y - focus))` is 0 near the line `y = focus` and rises to 1 away from it, so the picture is sharp in a band and blurred above and below.',
            'Step 2 works in HSV (the space chooser beside the step): `g` is the saturation there, so `g * 1.4` makes the colours toy-like.',
            'Steps run top to bottom, each on the result of the one before; drag them to reorder, untick to skip.',
        ],
        filter: {
            name: 'Tilt-shift',
            steps: [
                { params: { focus: { default: 0.55, min: 0, max: 1 } }, color: 'mix(rgb, gaussian(4), smoothstep(0.06, 0.25, abs(y - focus)))' },
                { space: 'hsv', color: '(r, clamp(g * 1.4, 0, 1), b)' },
            ],
        },
    },
    {
        id: 'neon',
        title: 'Neon edges',
        picture: 'cityabove.jpg',
        shows: ['edge detection', 'colour by position'],
        how: [
            '`sobel()` is how fast the brightness changes around the pixel — large on edges, near 0 on flat areas.',
            '`mix((1, 0.2, 0.7), (0.2, 0.9, 1), x)` is a colour that goes from pink on the left to cyan on the right.',
            'The picture is darkened to `rgb * 0.15` and the edges are added in that colour, brighter where they are stronger.',
        ],
        filter: { name: 'Neon edges', params: { glow: { default: 2.5, min: 0.5, max: 6 } }, color: 'rgb * 0.15 + mix((1, 0.2, 0.7), (0.2, 0.9, 1), x) * min(glow sobel(), 1)' },
    },
    {
        id: 'glitch',
        title: 'Animated glitch on a video',
        picture: 'citytraffic.mp4',
        shows: ['animation with t', 'reading other pixels'],
        how: [
            'On a video, `t` counts its frames; on a photo, it counts while "play" is ticked. Anything with `t` in it moves.',
            '`red(px + s, py)` reads the red of the pixel `s` to the right; taking red and blue from opposite sides splits the colours apart.',
            '`s = 8 sin(t / 6)` makes the split swing back and forth; `if py mod 4 < 2 …` darkens every other pair of rows into scanlines.',
        ],
        filter: {
            name: 'Glitch',
            steps: [
                '(red(px + 8 sin(t / 6), py), g, blue(px - 8 sin(t / 6), py))',
                'if py mod 4 < 2 then rgb else rgb * 0.75',
            ],
        },
    },
    {
        id: 'comic',
        title: 'Comic poster with a title',
        picture: 'charleston.jpg',
        shows: ['chains of other people\'s filters', 'text with an outline'],
        how: [
            'This chain reuses filters from the library: Comic (itself a chain of four: a small blur, bolder colours, the colours flattened to four levels with `floor(rgb * levels) / (levels - 1)`, then ink on the edges with `rgb (1 - gain sobel())`) and Poster title.',
            'The blur comes first so that only real edges get ink — on a photo, every leaf and crack would count as an edge otherwise.',
            'Each step keeps its own knobs, and a chain can set them: here the title\'s words are changed with "with", the way a share link would carry them.',
            'Click the words under the step to change them; drag them on the picture to move them.',
        ],
        filter: {
            name: 'Comic poster',
            steps: [
                { filter: 'library:Comic' },
                { filter: 'library:Poster title', with: { title: { text: 'RAINBOW ROW', size: 0.13 } } },
            ],
        },
    },
    {
        id: 'titlecard',
        title: 'Title card with a layered shadow',
        picture: 'minimaldesk.jpg',
        shows: ['shapes with their own filter', 'shadow layers', 'Google Fonts'],
        how: [
            'Step 1 draws a rounded rectangle called `panel` and uses it only as a place: `mix(rgb, gaussian(6) * 0.6, alpha(panel))` blurs and darkens what is behind it — frosted glass.',
            'Step 2 is text in the Google font Playfair Display with two shadow layers, each a picture of its own: `title_shadow1` is a wide soft shadow, `title_shadow2` a hard gold offset — the maths lays each on separately.',
            'Change the font under the step: pick one, type another Google Fonts name, or load a font file.',
        ],
        filter: {
            name: 'Title card',
            steps: [
                { graphics: { panel: { type: 'rect', x: 0.62, y: 0.32, w: 0.62, h: 0.26, radius: 0.2 } }, color: 'mix(rgb, gaussian(6) * 0.6, alpha(panel))' },
                {
                    graphics: { title: {
                        text: 'Less, but better', font: 'Georgia, serif', fontUrl: 'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&display=swap',
                        size: 0.085, x: 0.62, y: 0.32, shadow: null,
                        shadows: [{ color: '#000000', blur: 0.8, dx: 0, dy: 0.1 }, { color: '#000000', blur: 0, dx: 0.04, dy: 0.04 }],
                    } },
                    color: 'mix(mix(mix(rgb, rgb * 0.4, alpha(title_shadow1)), (0.95, 0.75, 0.3), alpha(title_shadow2)), title, alpha(title))',
                },
            ],
        },
    },
    {
        id: 'kenburns',
        title: 'Ken Burns with a caption fading in',
        picture: 'mountains.jpg',
        shows: ['animation with t', 'zoom', 'text'],
        how: [
            'Step 1: `zoom(1 + 0.0015 t, 0.45, 0.5)` reads the picture a little closer each frame — a still photo that moves, like a documentary.',
            'Step 2: the caption\'s visibility is `alpha(title)` times `clamp((t - 30) / 40, 0, 1)` — nothing for 30 frames, then fading in over 40.',
            'Save as GIF or Record writes the animation; "auto" in Export picks the smallest file for a still.',
        ],
        filter: {
            name: 'Ken Burns',
            steps: [
                'zoom(1 + 0.0015 t, 0.45, 0.5)',
                { ...caption('Somewhere in the hills', { font: 'Georgia, serif', style: 'italic', weight: 'normal' }), color: 'mix(rgb, title, alpha(title) clamp((t - 30) / 40, 0, 1))' },
            ],
        },
    },
    {
        id: 'hue',
        title: 'Hue cycle on a video',
        picture: 'waves.mp4',
        shows: ['colour spaces', 'animation with t'],
        how: [
            'The step works in HSV (the chooser beside it), where `r` is the hue — 0 to 1 round the colour wheel.',
            '`fract(r + t / 100)` adds a little more each frame and wraps round past 1, so the sea turns green, purple, red and back.',
            'Save as GIF or Record 5 s writes the result; the video loops, and so does the colour.',
        ],
        filter: { name: 'Hue cycle', steps: [{ space: 'hsv', color: '(fract(r + t / 100), g, b)' }] },
    },
    {
        id: 'brush',
        title: 'Brushes: paint that glows, then cools',
        picture: 'charleston.jpg',
        shows: ['brushes', 'animation with t', 'paint that changes with age'],
        how: [
            'A brush records what you paint, point by point with its timing and pressure, and draws it again for every frame — press play and the scribble draws itself at the speed it was drawn.',
            'Its picture carries data: `alpha(brush)` is where the paint is, `red(brush)` how long ago it was painted (0 just now, 1 after 40 frames). `mix((1, 0.9, 0.5), (0.1, 0.07, 0.06), red(brush))` is yellow-white when fresh and charcoal when old — so the line glows at its tip and cools behind it.',
            'Paint your own: in its step, click "draw" and paint on the picture (top left); "replay" plays it. "the paint" chooses other effects — a blur that grows with every pass, a rainbow along the drawing — and "outline the selection" draws round whatever is selected.',
        ],
        filter: {
            name: 'Fuse',
            steps: [{
                filter: 'library:Fuse brush',
                with: { brush: { size: 0.022, strokes: [{ points: Array.from({ length: 90 }, (_, k) => {
                    const u = k / 89;
                    return [+(0.08 + 0.84 * u).toFixed(4), +(0.5 + 0.07 * Math.sin(u * Math.PI * 7) * (1 - 0.5 * u)).toFixed(4), Math.round(u * 2400), +(0.45 + 0.55 * Math.sin(u * Math.PI)).toFixed(2)];
                }) }] } },
            }],
        },
    },
    {
        id: 'track',
        title: 'Track a person through a video',
        picture: 'personwalking.mp4',
        shows: ['tracking', 'selections', 'AI object finding'],
        how: [
            'The maths is `mix((gray, gray, gray), rgb, selected)`: grey everywhere except what is selected. Tracking makes the selection follow the man through every frame.',
            'Under the picture, in "Track an object": press "❚❚ pause" on the first frame. Select him — "find objects (AI)" and click inside his box, or "trace the edge" — then "use as keyframe", then "track".',
            'The timeline turns green where the tracker is sure and red where it is not. Click a red frame, fix the outline ("edit this frame", or select again), "use as keyframe", and "track" again — or "fix red frames with AI".',
        ],
        filter: { name: 'Colour on the person', steps: ['mix((gray, gray, gray), rgb, selected)'] },
    },
    {
        id: 'chroma',
        title: 'Green screen: a new background',
        picture: 'greenscreen.jpg',
        shows: ['colour spaces', 'conditions', 'colour by position'],
        how: [
            '`tohsv(rgb)` again: green is a hue of about 0.33. A pixel is "screen" when its hue is within `band` of that and it is saturated enough (the mannequin\'s skin is not).',
            'Where it is screen, `mix((0.95, 0.55, 0.45), (0.15, 0.2, 0.5), y)` paints a sunset, warm at the top and deep blue at the bottom; everywhere else the photo stays.',
            'To put another picture there instead, use "Chroma key onto a picture" from the library: it asks for a `background` picture.',
        ],
        filter: {
            name: 'New background', params: { band: { default: 0.09, min: 0.02, max: 0.2 } },
            color: 'if abs(red(tohsv(rgb)) - 0.33) < band & green(tohsv(rgb)) > 0.45 then mix((0.95, 0.55, 0.45), (0.15, 0.2, 0.5), y) else rgb',
        },
    },
    {
        id: 'canny',
        title: 'Canny edges: clean lines in nine passes',
        picture: 'contrastarchitecture.jpg',
        shows: ['multi-pass chains', 'neighbouring pixels'],
        how: [
            'Canny is the classic way to find thin, clean edges, and here it is just a chain of expressions — open each step to read them.',
            'Blur a little; measure how strongly and in which direction the brightness changes (`sobel()`, `atan2(sobely(), sobelx())`); keep only pixels stronger than their neighbours across the edge, so lines are one pixel thin.',
            'Then two thresholds (the `low` and `high` knobs): strong pixels are edges, weak ones only if they touch a strong one — three rounds of `red(dilate(1))` spread that along each line.',
        ],
        filter: { name: 'Canny', steps: [{ filter: 'library:Canny edges' }] },
    },
    {
        id: 'aiblur',
        title: 'Portrait: blur the background (select with AI)',
        picture: 'portrait.jpg',
        shows: ['selections', 'AI object finding', 'neighbouring pixels'],
        how: [
            'The maths is `mix(gaussian(5) * 0.85, rgb, selected)`: blurred and a little darker where `selected` is 0, the photo where it is 1.',
            'Nothing changes until something is selected (without a selection `selected` is 1 everywhere). Under the picture, click "find objects (AI)" and then click the man — the object model outlines him — and press Enter. Or use "trace the edge" and click around him.',
            'Tick "invert" to blur him instead; drag "feather" to soften the edge of the selection.',
        ],
        filter: { name: 'Background blur', steps: ['mix(gaussian(5) * 0.85, rgb, selected)'] },
    },
    {
        id: 'film',
        title: 'Old film look on a video, with a title',
        picture: 'personwalking.mp4',
        shows: ['chains', 'random()', 'text', 'animation with t'],
        how: [
            'Old film from the library (sepia, a vignette, faint scanlines), then Film grain: `rgb + amount (random() - 0.5)` — `random()` is new on every pixel and every frame, so the grain crawls like real film.',
            'Last, a caption that fades in after a second: `alpha(title) clamp((t - 30) / 30, 0, 1)`.',
            'Record 5 s of video, or Save as GIF, writes the filtered clip.',
        ],
        filter: {
            name: 'Old film',
            steps: [
                { filter: 'library:Old film' },
                { filter: 'library:Film grain', with: { amount: 0.12 } },
                { ...caption('Chicago, 1924', { font: 'Georgia, serif', style: 'italic', weight: 'normal', color: '#f3e6c8' }), color: 'mix(rgb, title, alpha(title) clamp((t - 30) / 30, 0, 1))' },
            ],
        },
    },
];

/** An example's filter with `library:Name` steps replaced by those library filters. */
function resolveExample(example, library) {
    const resolve = (step) => {
        if (step && typeof step === 'object' && typeof step.filter === 'string' && step.filter.startsWith('library:')) {
            const found = library.find((f) => f.name === step.filter.slice(8));
            if (!found) throw new Error(`Example "${example.title}": no "${step.filter.slice(8)}" in the library`);
            return { ...step, filter: found };
        }
        return step;
    };
    const f = example.filter;
    return f.steps ? { ...f, steps: f.steps.map(resolve) } : f;
}

/**
 * A GIF decoder: every frame of an animated GIF as full RGBA pixels, with
 * its delay — what a browser gives only for the first frame. About 150
 * lines, no dependencies, so it works wherever the editor does.
 *
 *   const { width, height, frames, loop } = decodeGif(arrayBuffer);
 *   frames[i].data   Uint8ClampedArray, width × height × 4, composited (disposal honoured)
 *   frames[i].delay  milliseconds (GIFs saying 0–10 ms are shown at 100 ms, as browsers do)
 *   loop             0 = for ever
 *
 * Encoding is gifenc's job (demo/app.js, "Save as GIF").
 */

/** Refuse what would not fit in memory: frames × pixels × 4 bytes. */
const MAX_BYTES = 400 * 1024 * 1024;

function decodeGif(buffer) {
    const bytes = new Uint8Array(buffer);
    if (String.fromCharCode(...bytes.subarray(0, 3)) !== 'GIF') throw new Error('Not a GIF');
    let pos = 6;
    const width = bytes[pos] | (bytes[pos + 1] << 8);
    const height = bytes[pos + 2] | (bytes[pos + 3] << 8);
    const packed = bytes[pos + 4];
    pos += 7;
    const globalPalette = packed & 0x80 ? readPalette(bytes, pos, 1 << ((packed & 7) + 1)) : null;
    if (globalPalette) pos += globalPalette.length;

    const frames = [];
    let loop = 0;
    const screen = new Uint8ClampedArray(width * height * 4);     // what is on screen, composited
    let control = { delay: 100, transparent: -1, disposal: 0 };
    let previous = null;                                           // the frame before, for disposal 3
    let lastRect = null;                                           // the last image's rectangle, for disposal 2

    while (pos < bytes.length) {
        const block = bytes[pos++];
        if (block === 0x3B) break;                                 // trailer
        if (block === 0x21) {                                      // extension
            const label = bytes[pos++];
            if (label === 0xF9) {                                  // graphic control: disposal, delay, transparency
                const size = bytes[pos];
                const flags = bytes[pos + 1];
                const delay = (bytes[pos + 2] | (bytes[pos + 3] << 8)) * 10;
                control = { delay: delay <= 10 ? 100 : delay, transparent: flags & 1 ? bytes[pos + 4] : -1, disposal: (flags >> 2) & 7 };
                pos += size + 1;
                while (bytes[pos] !== 0) pos += bytes[pos] + 1;
                pos++;
            } else if (label === 0xFF) {                           // application: NETSCAPE2.0 loop count
                const name = String.fromCharCode(...bytes.subarray(pos + 1, pos + 12));
                pos += bytes[pos] + 1;
                while (bytes[pos] !== 0) {
                    if (name.startsWith('NETSCAPE') && bytes[pos + 1] === 1) loop = bytes[pos + 2] | (bytes[pos + 3] << 8);
                    pos += bytes[pos] + 1;
                }
                pos++;
            } else {                                               // comment, plain text: skip
                while (bytes[pos] !== 0) pos += bytes[pos] + 1;
                pos++;
            }
            continue;
        }
        if (block !== 0x2C) throw new Error(`Unexpected block 0x${block.toString(16)} in the GIF`);

        // An image: where it goes, its own palette, then LZW pixels.
        const left = bytes[pos] | (bytes[pos + 1] << 8);
        const top = bytes[pos + 2] | (bytes[pos + 3] << 8);
        const w = bytes[pos + 4] | (bytes[pos + 5] << 8);
        const h = bytes[pos + 6] | (bytes[pos + 7] << 8);
        const flags = bytes[pos + 8];
        pos += 9;
        const palette = flags & 0x80 ? readPalette(bytes, pos, 1 << ((flags & 7) + 1)) : globalPalette;
        if (flags & 0x80) pos += palette.length;
        if (!palette) throw new Error('The GIF has no colour table');
        const minCodeSize = bytes[pos++];
        const chunks = [];
        let total = 0;
        while (bytes[pos] !== 0) { chunks.push(bytes.subarray(pos + 1, pos + 1 + bytes[pos])); total += bytes[pos]; pos += bytes[pos] + 1; }
        pos++;
        const data = new Uint8Array(total);
        for (let i = 0, at = 0; i < chunks.length; at += chunks[i].length, i++) data.set(chunks[i], at);
        const indices = lzwDecode(minCodeSize, data, w * h);

        // Dispose of the previous image first.
        if (lastRect && lastRect.disposal === 2) clearRect(screen, width, lastRect);
        else if (lastRect && lastRect.disposal === 3 && previous) screen.set(previous);
        previous = control.disposal === 3 ? screen.slice() : null;

        const interlaced = flags & 0x40;
        for (let row = 0; row < h; row++) {
            const y = top + (interlaced ? interlaceRow(row, h) : row);
            if (y >= height) continue;
            for (let col = 0; col < w; col++) {
                const x = left + col;
                if (x >= width) continue;
                const index = indices[row * w + col];
                if (index === control.transparent) continue;
                const at = (y * width + x) * 4;
                screen[at] = palette[index * 3];
                screen[at + 1] = palette[index * 3 + 1];
                screen[at + 2] = palette[index * 3 + 2];
                screen[at + 3] = 255;
            }
        }
        if ((frames.length + 1) * screen.length > MAX_BYTES) throw new Error(`The GIF is too big to hold in memory (${frames.length + 1} frames of ${width} × ${height})`);
        frames.push({ data: screen.slice(), delay: control.delay });
        lastRect = { left, top, w, h, disposal: control.disposal };
        control = { delay: 100, transparent: -1, disposal: 0 };
    }
    if (!frames.length) throw new Error('The GIF has no frames');
    return { width, height, frames, loop };
}

function readPalette(bytes, at, entries) {
    return bytes.subarray(at, at + entries * 3);
}

function clearRect(screen, width, { left, top, w, h }) {
    for (let y = top; y < top + h; y++) screen.fill(0, (y * width + left) * 4, (y * width + left + w) * 4);
}

/** Interlaced GIFs store rows in four passes: every 8th from 0, every 8th from 4, every 4th from 2, every 2nd from 1. */
function interlaceRow(row, height) {
    const passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
    for (const [start, step] of passes) {
        const count = Math.ceil(Math.max(0, height - start) / step);
        if (row < count) return start + row * step;
        row -= count;
    }
    return row;
}

/** GIF's LZW: variable code size from minCodeSize + 1 up to 12 bits, a clear code, an end code. */
function lzwDecode(minCodeSize, data, pixelCount) {
    const out = new Uint8Array(pixelCount);
    const clear = 1 << minCodeSize;
    const end = clear + 1;
    const prefix = new Int32Array(4096);
    const suffix = new Uint8Array(4096);
    const stack = new Uint8Array(4097);
    let codeSize = minCodeSize + 1;
    let next = clear + 2;
    let previous = -1;
    let bits = 0;
    let bitCount = 0;
    let pos = 0;
    let outPos = 0;
    for (let i = 0; i < clear; i++) { prefix[i] = -1; suffix[i] = i; }

    while (outPos < pixelCount) {
        while (bitCount < codeSize) {
            if (pos >= data.length) return out;                    // truncated: what we have
            bits |= data[pos++] << bitCount;
            bitCount += 8;
        }
        const code = bits & ((1 << codeSize) - 1);
        bits >>>= codeSize;
        bitCount -= codeSize;
        if (code === clear) { codeSize = minCodeSize + 1; next = clear + 2; previous = -1; continue; }
        if (code === end) break;
        if (code > next || (code === next && previous === -1)) return out;   // corrupt

        // The string for this code — or, for a code not yet in the table, the previous string plus its first pixel.
        let length = 0;
        for (let c = code === next ? previous : code; c !== -1; c = prefix[c]) stack[length++] = suffix[c];
        const first = stack[length - 1];
        for (let i = length - 1; i >= 0 && outPos < pixelCount; i--) out[outPos++] = stack[i];
        if (code === next && outPos < pixelCount) out[outPos++] = first;

        if (previous !== -1 && next < 4096) {
            prefix[next] = previous;
            suffix[next] = first;
            next++;
            if (next === (1 << codeSize) && codeSize < 12) codeSize++;
        }
        previous = code;
    }
    return out;
}

var X={trailer:59};function F(t=256){let e=0,s=new Uint8Array(t);return {get buffer(){return s.buffer},reset(){e=0;},bytesView(){return s.subarray(0,e)},bytes(){return s.slice(0,e)},writeByte(r){n(e+1),s[e]=r,e++;},writeBytes(r,o=0,i=r.length){n(e+i);for(let c=0;c<i;c++)s[e++]=r[c+o];},writeBytesView(r,o=0,i=r.byteLength){n(e+i),s.set(r.subarray(o,o+i),e),e+=i;}};function n(r){var o=s.length;if(o>=r)return;var i=1024*1024;r=Math.max(r,o*(o<i?2:1.125)>>>0),o!=0&&(r=Math.max(r,256));let c=s;s=new Uint8Array(r),e>0&&s.set(c.subarray(0,e),0);}}var O=12,J=5003,lt=[0,1,3,7,15,31,63,127,255,511,1023,2047,4095,8191,16383,32767,65535];function at(t,e,s,n,r=F(512),o=new Uint8Array(256),i=new Int32Array(J),c=new Int32Array(J)){let x=i.length,a=Math.max(2,n);o.fill(0),c.fill(0),i.fill(-1);let l=0,f=0,g=a+1,h=g,b=false,w=h,_=(1<<w)-1,u=1<<g-1,k=u+1,B=u+2,p=0,A=s[0],z=0;for(let y=x;y<65536;y*=2)++z;z=8-z,r.writeByte(a),I(u);let d=s.length;for(let y=1;y<d;y++){t:{let m=s[y],v=(m<<O)+A,M=m<<z^A;if(i[M]===v){A=c[M];break t}let V=M===0?1:x-M;for(;i[M]>=0;)if(M-=V,M<0&&(M+=x),i[M]===v){A=c[M];break t}I(A),A=m,B<1<<O?(c[M]=B++,i[M]=v):(i.fill(-1),B=u+2,b=true,I(u));}}return I(A),I(k),r.writeByte(0),r.bytesView();function I(y){for(l&=lt[f],f>0?l|=y<<f:l=y,f+=w;f>=8;)o[p++]=l&255,p>=254&&(r.writeByte(p),r.writeBytesView(o,0,p),p=0),l>>=8,f-=8;if((B>_||b)&&(b?(w=h,_=(1<<w)-1,b=false):(++w,_=w===O?1<<w:(1<<w)-1)),y==k){for(;f>0;)o[p++]=l&255,p>=254&&(r.writeByte(p),r.writeBytesView(o,0,p),p=0),l>>=8,f-=8;p>0&&(r.writeByte(p),r.writeBytesView(o,0,p),p=0);}}}var $$1=at;function D(t,e,s){return t<<8&63488|e<<2&992|s>>3}function G(t,e,s,n){return t>>4|e&240|(s&240)<<4|(n&240)<<8}function j(t,e,s){return t>>4<<8|e&240|s>>4}function R(t,e,s){return t<e?e:t>s?s:t}function T(t){return t*t}function tt(t,e,s){var n=0,r=1e100;let o=t[e],i=o.cnt;o.ac;let x=o.rc,a=o.gc,l=o.bc;for(var f=o.fw;f!=0;f=t[f].fw){let h=t[f],b=h.cnt,w=i*b/(i+b);if(!(w>=r)){var g=0;(g+=w*T(h.rc-x),!(g>=r)&&(g+=w*T(h.gc-a),!(g>=r)&&(g+=w*T(h.bc-l),!(g>=r)&&(r=g,n=f))));}}o.err=r,o.nn=n;}function Q(){return {ac:0,rc:0,gc:0,bc:0,cnt:0,nn:0,fw:0,bk:0,tm:0,mtm:0,err:0}}function ut(t,e){let s=e==="rgb444"?4096:65536,n=new Array(s),r=t.length;if(e==="rgba4444")for(let o=0;o<r;++o){let i=t[o],c=i>>24&255,x=i>>16&255,a=i>>8&255,l=i&255,f=G(l,a,x,c),g=f in n?n[f]:n[f]=Q();g.rc+=l,g.gc+=a,g.bc+=x,g.ac+=c,g.cnt++;}else if(e==="rgb444")for(let o=0;o<r;++o){let i=t[o],c=i>>16&255,x=i>>8&255,a=i&255,l=j(a,x,c),f=l in n?n[l]:n[l]=Q();f.rc+=a,f.gc+=x,f.bc+=c,f.cnt++;}else for(let o=0;o<r;++o){let i=t[o],c=i>>16&255,x=i>>8&255,a=i&255,l=D(a,x,c),f=l in n?n[l]:n[l]=Q();f.rc+=a,f.gc+=x,f.bc+=c,f.cnt++;}return n}function H(t,e,s={}){let{format:n="rgb565",clearAlpha:r=true,clearAlphaColor:o=0,clearAlphaThreshold:i=0,oneBitAlpha:c=false}=s;if(!t||!t.buffer)throw new Error("quantize() expected RGBA Uint8Array data");if(!(t instanceof Uint8Array)&&!(t instanceof Uint8ClampedArray))throw new Error("quantize() expected RGBA Uint8Array data");let x=new Uint32Array(t.buffer),a=s.useSqrt!==false,l=n==="rgba4444",f=ut(x,n),g=f.length,h=g-1,b=new Uint32Array(g+1);for(var w=0,u=0;u<g;++u){let C=f[u];if(C!=null){var _=1/C.cnt;l&&(C.ac*=_),C.rc*=_,C.gc*=_,C.bc*=_,f[w++]=C;}}T(e)/w<.022&&(a=false);for(var u=0;u<w-1;++u)f[u].fw=u+1,f[u+1].bk=u,a&&(f[u].cnt=Math.sqrt(f[u].cnt));a&&(f[u].cnt=Math.sqrt(f[u].cnt));var k,B,p;for(u=0;u<w;++u){tt(f,u);var A=f[u].err;for(B=++b[0];B>1&&(p=B>>1,!(f[k=b[p]].err<=A));B=p)b[B]=k;b[B]=u;}var z=w-e;for(u=0;u<z;){for(var d;;){var I=b[1];if(d=f[I],d.tm>=d.mtm&&f[d.nn].mtm<=d.tm)break;d.mtm==h?I=b[1]=b[b[0]--]:(tt(f,I),d.tm=u);var A=f[I].err;for(B=1;(p=B+B)<=b[0]&&(p<b[0]&&f[b[p]].err>f[b[p+1]].err&&p++,!(A<=f[k=b[p]].err));B=p)b[B]=k;b[B]=I;}var y=f[d.nn],m=d.cnt,v=y.cnt,_=1/(m+v);l&&(d.ac=_*(m*d.ac+v*y.ac)),d.rc=_*(m*d.rc+v*y.rc),d.gc=_*(m*d.gc+v*y.gc),d.bc=_*(m*d.bc+v*y.bc),d.cnt+=y.cnt,d.mtm=++u,f[y.bk].fw=y.fw,f[y.fw].bk=y.bk,y.mtm=h;}let M=[];var V=0;for(u=0;;++V){let L=R(Math.round(f[u].rc),0,255),C=R(Math.round(f[u].gc),0,255),Y=R(Math.round(f[u].bc),0,255),E=255;if(l){if(E=R(Math.round(f[u].ac),0,255),c){let st=typeof c=="number"?c:127;E=E<=st?0:255;}r&&E<=i&&(L=C=Y=o,E=0);}let K=l?[L,C,Y,E]:[L,C,Y];if(xt(M,K)||M.push(K),(u=f[u].fw)==0)break}return M}function xt(t,e){for(let s=0;s<t.length;s++){let n=t[s],r=n[0]===e[0]&&n[1]===e[1]&&n[2]===e[2],o=n.length>=4&&e.length>=4?n[3]===e[3]:true;if(r&&o)return  true}return  false}function nt(t,e,s="rgb565"){if(!t||!t.buffer)throw new Error("quantize() expected RGBA Uint8Array data");if(!(t instanceof Uint8Array)&&!(t instanceof Uint8ClampedArray))throw new Error("quantize() expected RGBA Uint8Array data");if(e.length>256)throw new Error("applyPalette() only works with 256 colors or less");let n=new Uint32Array(t.buffer),r=n.length,o=s==="rgb444"?4096:65536,i=new Uint8Array(r),c=new Array(o);if(s==="rgba4444")for(let a=0;a<r;a++){let l=n[a],f=l>>24&255,g=l>>16&255,h=l>>8&255,b=l&255,w=G(b,h,g,f),_=w in c?c[w]:c[w]=gt(b,h,g,f,e);i[a]=_;}else {let a=s==="rgb444"?j:D;for(let l=0;l<r;l++){let f=n[l],g=f>>16&255,h=f>>8&255,b=f&255,w=a(b,h,g),_=w in c?c[w]:c[w]=bt(b,h,g,e);i[l]=_;}}return i}function gt(t,e,s,n,r){let o=0,i=1e100;for(let c=0;c<r.length;c++){let x=r[c],a=x[3],l=q(a-n);if(l>i)continue;let f=x[0];if(l+=q(f-t),l>i)continue;let g=x[1];if(l+=q(g-e),l>i)continue;let h=x[2];l+=q(h-s),!(l>i)&&(i=l,o=c);}return o}function bt(t,e,s,n){let r=0,o=1e100;for(let i=0;i<n.length;i++){let c=n[i],x=c[0],a=q(x-t);if(a>o)continue;let l=c[1];if(a+=q(l-e),a>o)continue;let f=c[2];a+=q(f-s),!(a>o)&&(o=a,r=i);}return r}function q(t){return t*t}function ct(t={}){let{initialCapacity:e=4096,auto:s=true}=t,n=F(e),r=5003,o=new Uint8Array(256),i=new Int32Array(r),c=new Int32Array(r),x=false;return {reset(){n.reset(),x=false;},finish(){n.writeByte(X.trailer);},bytes(){return n.bytes()},bytesView(){return n.bytesView()},get buffer(){return n.buffer},get stream(){return n},writeHeader:a,writeFrame(l,f,g,h={}){let{transparent:b=false,transparentIndex:w=0,delay:_=0,palette:u=null,repeat:k=0,colorDepth:B=8,dispose:p=-1}=h,A=false;if(s?x||(A=true,a(),x=true):A=Boolean(h.first),f=Math.max(0,Math.floor(f)),g=Math.max(0,Math.floor(g)),A){if(!u)throw new Error("First frame must include a { palette } option");pt(n,f,g,u,B),it(n,u),k>=0&&dt(n,k);}let z=Math.round(_/10);wt(n,p,z,b,w);let d=Boolean(u)&&!A;ht(n,f,g,d?u:null),d&&it(n,u),yt(n,l,f,g,B,o,i,c);}};function a(){ft(n,"GIF89a");}}function wt(t,e,s,n,r){t.writeByte(33),t.writeByte(249),t.writeByte(4),r<0&&(r=0,n=false);var o,i;n?(o=1,i=2):(o=0,i=0),e>=0&&(i=e&7),i<<=2;let c=0;t.writeByte(0|i|c|o),S(t,s),t.writeByte(r||0),t.writeByte(0);}function pt(t,e,s,n,r=8){let o=1,i=0,c=Z(n.length)-1,x=o<<7|r-1<<4|i<<3|c,a=0,l=0;S(t,e),S(t,s),t.writeBytes([x,a,l]);}function dt(t,e){t.writeByte(33),t.writeByte(255),t.writeByte(11),ft(t,"NETSCAPE2.0"),t.writeByte(3),t.writeByte(1),S(t,e),t.writeByte(0);}function it(t,e){let s=1<<Z(e.length);for(let n=0;n<s;n++){let r=[0,0,0];n<e.length&&(r=e[n]),t.writeByte(r[0]),t.writeByte(r[1]),t.writeByte(r[2]);}}function ht(t,e,s,n){if(t.writeByte(44),S(t,0),S(t,0),S(t,e),S(t,s),n){let r=0,o=0,i=Z(n.length)-1;t.writeByte(128|r|o|0|i);}else t.writeByte(0);}function yt(t,e,s,n,r=8,o,i,c){$$1(s,n,e,r,t,o,i,c);}function S(t,e){t.writeByte(e&255),t.writeByte(e>>8&255);}function ft(t,e){for(var s=0;s<e.length;s++)t.writeByte(e.charCodeAt(s));}function Z(t){return Math.max(Math.ceil(Math.log2(t)),1)}var Bt=ct;

var G$1 = /*#__PURE__*/Object.freeze({
    __proto__: null,
    GIFEncoder: ct,
    applyPalette: nt,
    default: Bt,
    quantize: H
});

/**
 * A PNG writer that can do what the browser's cannot: an indexed picture
 * (PNG-8) at 1, 2, 4 or 8 bits a pixel when the picture has few colours —
 * a threshold or posterize result is 5–20× smaller that way — and RGB
 * rather than RGBA when nothing is transparent. Truecolour rows use the
 * Paeth filter, which deflate likes for photos.
 *
 *   const { blob, kind, colours, bits } = await encodePng({ width, height, data, palette: 'auto', colours: 256, dither: true });
 *
 * `palette`: 'auto' (indexed if the picture has ≤ 256 colours, else
 * truecolour), 'none', or 'force' (reduce to `colours` colours, with
 * optional dithering — that needs a `quantize(data, colours, { dither, width })`
 * returning { palette, indices }: the package has no quantizer of its own,
 * so it stays dependency-free; the editor passes one built on gifenc).
 * Deflate comes from CompressionStream (every current browser, and Node
 * ≥ 18); without it encodePng() returns null and the caller falls back to
 * canvas.toBlob.
 */
const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    CRC[n] = c;
}

function crc32(bytes) {
    let c = -1;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

async function deflate(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    const stream = new CompressionStream('deflate');          // zlib framing, as PNG wants
    const writer = stream.writable.getWriter();
    writer.write(bytes);
    writer.close();
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/** How many distinct RGBA colours, counting up to `limit`. */
function colourCount(data, limit = 257) {
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4) {
        seen.add(((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0);
        if (seen.size >= limit) return seen.size;
    }
    return seen.size;
}

/** Every colour as it is, when there are at most 256: { palette: [[r, g, b, a]…], indices }. */
function exactPalette(data) {
    const index = new Map();
    const palette = [];
    const indices = new Uint8Array(data.length / 4);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        const key = ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0;
        let k = index.get(key);
        if (k === undefined) {
            if (palette.length === 256) return null;
            k = palette.length;
            index.set(key, k);
            palette.push([data[i], data[i + 1], data[i + 2], data[i + 3]]);
        }
        indices[p] = k;
    }
    return { palette, indices };
}

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * @param {object} o { width, height, data: RGBA bytes, palette: 'auto' | 'none' | 'force', colours, dither, quantize }
 * @returns {Promise<{ blob: Blob, kind: 'palette' | 'rgb' | 'rgba', colours: number, bits: number } | null>}
 */
async function encodePng$1({ width, height, data, palette = 'auto', colours = 256, dither = true, quantize = null }) {
    if (typeof CompressionStream === 'undefined') return null;
    let indexed = null;
    if (palette === 'auto' || palette === 'force') {
        indexed = exactPalette(data);
        if (indexed && indexed.palette.length > colours) indexed = null;
        if (!indexed && palette === 'force') {
            if (!quantize) throw new Error('encodePng: palette "force" needs a quantize function (the picture has more than `colours` colours)');
            indexed = quantize(data, Math.min(256, Math.max(2, colours)), { dither, width });
        }
    }
    const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    let rows, kind, bits;
    if (indexed) {
        const n = indexed.palette.length;
        bits = n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8;
        kind = 'palette';
        ihdr[8] = bits; ihdr[9] = 3;                                     // colour type 3: indexed
        const stride = Math.ceil(width * bits / 8);
        rows = new Uint8Array(height * (1 + stride));
        for (let y = 0; y < height; y++) {
            const at = y * (1 + stride) + 1;                              // filter byte 0: none
            for (let x = 0; x < width; x++) {
                const k = indexed.indices[y * width + x];
                if (bits === 8) rows[at + x] = k;
                else rows[at + ((x * bits) >> 3)] |= k << (8 - bits - (x * bits) % 8);
            }
        }
        const plte = new Uint8Array(n * 3);
        const trns = new Uint8Array(n);
        let transparent = false;
        indexed.palette.forEach(([r, g, b, a], i) => { plte.set([r, g, b], i * 3); trns[i] = a; if (a < 255) transparent = true; });
        chunks.push(chunk('IHDR', ihdr), chunk('PLTE', plte));
        if (transparent) chunks.push(chunk('tRNS', trns));
    } else {
        let opaque = true;
        for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { opaque = false; break; }
        const bpp = opaque ? 3 : 4;
        kind = opaque ? 'rgb' : 'rgba';
        bits = 8;
        ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6;
        const stride = width * bpp;
        rows = new Uint8Array(height * (1 + stride));
        const raw = new Uint8Array(stride);
        const prev = new Uint8Array(stride);
        for (let y = 0; y < height; y++) {
            for (let x = 0, i = y * width * 4, j = 0; x < width; x++, i += 4, j += bpp) {
                raw[j] = data[i]; raw[j + 1] = data[i + 1]; raw[j + 2] = data[i + 2];
                if (!opaque) raw[j + 3] = data[i + 3];
            }
            const at = y * (1 + stride);
            rows[at] = 4;                                                 // Paeth
            for (let j = 0; j < stride; j++) {
                rows[at + 1 + j] = raw[j] - paeth(j >= bpp ? raw[j - bpp] : 0, prev[j], j >= bpp ? prev[j - bpp] : 0);
            }
            prev.set(raw);
        }
        chunks.push(chunk('IHDR', ihdr));
    }
    chunks.push(chunk('IDAT', await deflate(rows)), chunk('IEND', new Uint8Array(0)));
    return { blob: new Blob(chunks, { type: 'image/png' }), kind, colours: indexed ? indexed.palette.length : colourCount(data), bits };
}

/**
 * The editor's PNG writer: the package's (src/png.js — indexed PNG-8 when the
 * picture has few colours, RGB when nothing is transparent, Paeth rows) with
 * gifenc's quantizer for palette 'force', which the package leaves to the caller.
 *
 *   const { blob, kind, colours, bits } = await encodePng({ width, height, data, palette: 'auto', colours: 256, dither: true });
 */

const { quantize, applyPalette } = H ? G$1 : Bt;

/** As the package's encodePng, with quantizedPalette for palette 'force'. */
const encodePng = (o) => encodePng$1({ quantize: quantizedPalette, ...o });

/** The picture reduced to `colours` colours (gifenc's quantizer), optionally Floyd–Steinberg dithered. */
function quantizedPalette(data, colours, { dither = true, width = 0 } = {}) {
    let transparent = false;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { transparent = true; break; }
    const format = transparent ? 'rgba4444' : 'rgb565';
    const palette = quantize(data, colours, { format }).map((c) => [c[0], c[1], c[2], c.length > 3 ? c[3] : 255]);
    if (!dither || !width) return { palette, indices: applyPalette(data, palette, format) };

    // Floyd–Steinberg: push each pixel's rounding error onto the pixels to its right and below.
    const height = data.length / 4 / width;
    const indices = new Uint8Array(width * height);
    const rgb = new Float32Array(data.length / 4 * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) { rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2]; }
    const cache = new Map();
    const nearest = (r, g, b) => {
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        let k = cache.get(key);
        if (k !== undefined) return k;
        let best = 0, bestD = Infinity;
        for (let i = 0; i < palette.length; i++) {
            const d = (palette[i][0] - r) ** 2 + (palette[i][1] - g) ** 2 + (palette[i][2] - b) ** 2;
            if (d < bestD) { bestD = d; best = i; }
        }
        cache.set(key, best);
        return best;
    };
    const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = y * width + x, j = p * 3;
            const r = clamp(rgb[j]), g = clamp(rgb[j + 1]), b = clamp(rgb[j + 2]);
            const k = transparent && data[p * 4 + 3] < 128 ? applyPalette(data.subarray(p * 4, p * 4 + 4), palette, format)[0] : nearest(r, g, b);
            indices[p] = k;
            const er = r - palette[k][0], eg = g - palette[k][1], eb = b - palette[k][2];
            const spread = (dx, dy, f) => {
                if (x + dx < 0 || x + dx >= width || y + dy >= height) return;
                const q = ((y + dy) * width + x + dx) * 3;
                rgb[q] += er * f; rgb[q + 1] += eg * f; rgb[q + 2] += eb * f;
            };
            spread(1, 0, 7 / 16); spread(-1, 1, 3 / 16); spread(0, 1, 5 / 16); spread(1, 1, 1 / 16);
        }
    }
    return { palette, indices };
}

/**
 * The Export panel: format (with each one's size estimated), quality or
 * colours, output size, a crop dragged on the picture, a background for
 * JPEG, and Download.
 *
 *   const exporter = setupExport({ $, renderFrame, media, download, outputCanvas, canCrop });   // canCrop: may a drag on the result crop now?
 *   exporter.produce('png8')  → { blob, width, height, note }
 *
 * `renderFrame(width, height)` draws the filter on the picture at that size
 * and returns a 2D canvas; everything here works on that canvas.
 */

const LIMIT = 4096;
const ASPECTS = { free: 0, '1:1': 1, '4:3': 4 / 3, '3:2': 3 / 2, '16:9': 16 / 9, '9:16': 9 / 16 };

function setupExport({ $, renderFrame, media, download, outputCanvas, noDownload, canCrop = () => true }) {
    const state = { crop: null, aspect: 0 };          // crop: { x, y, w, h } as fractions of the frame
    let webp = null;                                   // does canvas.toBlob know WebP? found out once
    let estimates = null;                              // { key, sizes }

    // ---- size ------------------------------------------------------------------
    function frameSize() {
        const m = media();
        const scale = Math.min(1, LIMIT / m.width, LIMIT / m.height);
        return [Math.round(m.width * scale), Math.round(m.height * scale)];
    }
    function sizeFromPreset() {
        const [fw, fh] = frameSize();
        const preset = $('export-preset').value;
        const m = media();
        const long = Math.max(m.width, m.height);
        const byLong = (n) => Math.min(1, n / long);
        const scale = preset === 'preview' ? Math.min(1, 480 / m.width, 360 / m.height) : preset === 'half' ? 0.5 : preset === 'quarter' ? 0.25
            : /^\d+$/.test(preset) ? byLong(Number(preset)) : 1;
        if (preset !== 'custom') {
            $('export-width').value = Math.max(1, Math.round(fw * scale));
            $('export-height').value = Math.max(1, Math.round(fh * scale));
        }
        showOutput();
    }
    function outputSize() {
        const w = Math.min(LIMIT, Math.max(1, Math.round(Number($('export-width').value) || frameSize()[0])));
        const h = Math.min(LIMIT, Math.max(1, Math.round(Number($('export-height').value) || frameSize()[1])));
        return [w, h];
    }
    function keepShape(changed) {
        if (!$('export-lock').checked) return;
        const m = media();
        if (changed === 'width') $('export-height').value = Math.max(1, Math.round(Number($('export-width').value) * m.height / m.width));
        else $('export-width').value = Math.max(1, Math.round(Number($('export-height').value) * m.width / m.height));
    }
    function showOutput() {
        const [w, h] = outputSize();
        const c = state.crop;
        const out = c ? [Math.max(1, Math.round(c.w * w)), Math.max(1, Math.round(c.h * h))] : [w, h];
        $('export-out').textContent = `${out[0]} × ${out[1]} px${c ? ' (cropped)' : ''}`;
        for (const [key, v] of Object.entries(c ? { x: c.x * w, y: c.y * h, w: c.w * w, h: c.h * h } : { x: 0, y: 0, w, h })) $(`crop-${key}`).value = Math.round(v);
        estimates = null;
        $('export-sizes').textContent = '';
    }

    // ---- crop: drag on the picture ----------------------------------------------
    const box = $('crop-box');
    function showCrop() {
        const c = state.crop;
        box.hidden = !c;
        if (c) Object.assign(box.style, { left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` });
    }
    function setCrop(crop) {
        state.crop = crop && crop.w > 0.005 && crop.h > 0.005 ? crop : null;
        showCrop();
        showOutput();
    }
    function cropFromNumbers() {
        const [w, h] = outputSize();
        const v = (k) => Number($(`crop-${k}`).value) || 0;
        const crop = { x: v('x') / w, y: v('y') / h, w: v('w') / w, h: v('h') / h };
        if (crop.x <= 0 && crop.y <= 0 && crop.w >= 1 && crop.h >= 1) setCrop(null);
        else setCrop({ x: Math.max(0, crop.x), y: Math.max(0, crop.y), w: Math.min(1 - Math.max(0, crop.x), crop.w), h: Math.min(1 - Math.max(0, crop.y), crop.h) });
    }
    let dragFrom = null;
    const frame = $('output');
    const fraction = (e) => {
        const r = outputCanvas().getBoundingClientRect();
        return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
    };
    frame.addEventListener('pointerdown', (e) => { if (e.button !== 0 || !canCrop()) return; dragFrom = fraction(e); frame.setPointerCapture(e.pointerId); e.preventDefault(); });
    frame.addEventListener('pointermove', (e) => {
        if (!dragFrom) return;
        const [x, y] = fraction(e);
        let w = Math.abs(x - dragFrom[0]), h = Math.abs(y - dragFrom[1]);
        if (state.aspect) {                                                // the picture's own pixels, not the fractions, keep the shape
            const m = media();
            h = (w * m.width) / state.aspect / m.height;
            if (dragFrom[1] + h > 1 && y >= dragFrom[1]) { h = 1 - dragFrom[1]; w = (h * m.height * state.aspect) / m.width; }
        }
        const left = Math.min(x, dragFrom[0]), top = y >= dragFrom[1] ? dragFrom[1] : Math.max(0, dragFrom[1] - h);
        state.crop = { x: left, y: top, w: Math.min(w, 1 - left), h: Math.min(h, 1 - top) };
        showCrop();
    });
    frame.addEventListener('pointerup', (e) => { if (!dragFrom) return; dragFrom = null; frame.releasePointerCapture(e.pointerId); setCrop(state.crop); });
    $('crop-aspect').addEventListener('change', () => { state.aspect = ASPECTS[$('crop-aspect').value] ?? 0; });
    $('crop-clear').onclick = () => setCrop(null);
    for (const k of ['x', 'y', 'w', 'h']) $(`crop-${k}`).addEventListener('change', cropFromNumbers);

    // ---- producing the file ------------------------------------------------------
    const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    async function webpWorks() {
        if (webp !== null) return webp;
        const c = document.createElement('canvas');
        c.width = c.height = 2;
        const blob = await toBlob(c, 'image/webp', 0.8);
        webp = Boolean(blob && blob.type === 'image/webp');
        return webp;
    }

    /** The filtered, cropped picture at the output size, as a 2D canvas (rendered once per settings). */
    let rendered = null;
    async function picture() {
        const [w, h] = outputSize();
        const key = JSON.stringify([w, h, state.crop, media().kind, media().width, $('export-t')?.value]);
        if (rendered && rendered.key === key) return rendered.canvas;
        const full = await renderFrame(w, h);
        let canvas = full;
        if (state.crop) {
            const c = state.crop;
            canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(c.w * w));
            canvas.height = Math.max(1, Math.round(c.h * h));
            canvas.getContext('2d').drawImage(full, Math.round(c.x * w), Math.round(c.y * h), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
        }
        rendered = { key, canvas };
        return canvas;
    }

    async function encode(canvas, format) {
        const quality = Number($('export-quality').value);
        if (format === 'jpeg') {
            const flat = document.createElement('canvas');
            flat.width = canvas.width; flat.height = canvas.height;
            const ctx = flat.getContext('2d');
            ctx.fillStyle = $('export-bg').value;
            ctx.fillRect(0, 0, flat.width, flat.height);
            ctx.drawImage(canvas, 0, 0);
            return { blob: await toBlob(flat, 'image/jpeg', quality), ext: 'jpg', note: `JPEG, quality ${Math.round(quality * 100)}` };
        }
        if (format === 'webp') {
            if (!(await webpWorks())) throw new Error('This browser cannot write WebP');
            return { blob: await toBlob(canvas, 'image/webp', quality), ext: 'webp', note: `WebP, quality ${Math.round(quality * 100)}` };
        }
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        if (format === 'png8') {
            const png = await encodePng({ width: canvas.width, height: canvas.height, data, palette: 'force', colours: Number($('export-colours').value) || 256, dither: $('export-dither').checked });
            if (png) return { blob: png.blob, ext: 'png', note: `PNG, ${png.colours} colours at ${png.bits} bit${png.bits > 1 ? 's' : ''} a pixel` };
            return { blob: await toBlob(canvas, 'image/png'), ext: 'png', note: 'PNG (this browser cannot write a palette PNG)' };
        }
        const png = await encodePng({ width: canvas.width, height: canvas.height, data, palette: 'auto' });   // few colours → indexed, else RGB/RGBA
        if (png) return { blob: png.blob, ext: 'png', note: png.kind === 'palette' ? `PNG, ${png.colours} colours at ${png.bits} bit${png.bits > 1 ? 's' : ''} a pixel` : `PNG, ${png.kind.toUpperCase()}` };
        return { blob: await toBlob(canvas, 'image/png'), ext: 'png', note: 'PNG' };
    }

    /** Every format's size, for the panel; the picture is rendered once. */
    async function estimate() {
        const canvas = await picture();
        const key = JSON.stringify([rendered.key, $('export-quality').value, $('export-colours').value, $('export-dither').checked, $('export-bg').value]);
        if (estimates && estimates.key === key) return estimates.sizes;
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const sizes = { colours: colourCount(data) };
        for (const format of ['png', 'png8', 'jpeg', 'webp']) {
            try { const r = await encode(canvas, format); sizes[format] = { bytes: r.blob.size, note: r.note }; } catch { sizes[format] = null; }
            await new Promise((r) => setTimeout(r, 0));
        }
        estimates = { key, sizes };
        return sizes;
    }

    /** Auto: lossless when the picture has few colours or transparency, otherwise the smaller of JPEG and WebP. */
    async function chooseAuto() {
        const sizes = await estimate();
        if (sizes.colours <= 256) return 'png';                               // encodePng('auto') indexes it
        const canvas = await picture();
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let transparent = false;
        for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { transparent = true; break; }
        if (transparent) return sizes.webp ? 'webp' : 'png';
        if (sizes.webp && sizes.jpeg) return sizes.webp.bytes < sizes.jpeg.bytes ? 'webp' : 'jpeg';
        return sizes.jpeg ? 'jpeg' : 'png';
    }

    async function produce(format = $('export-format').value) {
        const chosen = format === 'auto' ? await chooseAuto() : format;
        const canvas = await picture();
        const r = await encode(canvas, chosen);
        return { ...r, format: chosen, width: canvas.width, height: canvas.height };
    }

    const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
    async function showEstimates() {
        $('export-sizes').textContent = 'Estimating…';
        try {
            const sizes = await estimate();
            const auto = await chooseAuto();
            const parts = [];
            for (const [format, label] of [['png', 'PNG'], ['png8', 'PNG palette'], ['jpeg', 'JPEG'], ['webp', 'WebP']]) {
                if (sizes[format]) parts.push(`${label} ${kb(sizes[format].bytes)}${format === auto ? ' ←' : ''}`);
            }
            $('export-sizes').textContent = `${parts.join(' · ')}${sizes.colours <= 256 ? ` · ${sizes.colours} colours` : ''}`;
        } catch (e) {
            $('export-sizes').textContent = e.message;
        }
    }

    async function save() {
        $('export-msg').textContent = 'Drawing…';
        try {
            const r = await produce();
            if (!noDownload()) download(r.blob, `filter.${r.ext}`);
            $('export-msg').textContent = `Saved ${r.width} × ${r.height}: ${r.note}, ${kb(r.blob.size)}`;
        } catch (e) {
            $('export-msg').textContent = e.message;
        }
    }

    // ---- wiring ------------------------------------------------------------------
    function showControls() {
        const f = $('export-format').value;
        $('export-quality-row').hidden = !(f === 'jpeg' || f === 'webp' || f === 'auto');
        $('export-colours-row').hidden = f !== 'png8';
        $('export-bg-row').hidden = !(f === 'jpeg' || f === 'auto');
    }
    $('export-format').addEventListener('change', showControls);
    $('export-quality').addEventListener('input', () => { $('export-quality-val').textContent = Math.round($('export-quality').value * 100); estimates = null; $('export-sizes').textContent = ''; });
    for (const id of ['export-colours', 'export-dither', 'export-bg']) $(id).addEventListener('change', () => { estimates = null; $('export-sizes').textContent = ''; });
    $('export-preset').addEventListener('change', sizeFromPreset);
    $('export-width').addEventListener('change', () => { $('export-preset').value = 'custom'; keepShape('width'); showOutput(); });
    $('export-height').addEventListener('change', () => { $('export-preset').value = 'custom'; keepShape('height'); showOutput(); });
    $('export-estimate').onclick = showEstimates;
    $('export-download').onclick = save;
    showControls();

    return {
        state, produce, estimate, setCrop, outputSize, save,
        /** The picture changed (a new file, a frame): sizes follow it. */
        pictureChanged() { rendered = null; estimates = null; sizeFromPreset(); showCrop(); },
    };
}

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
function costMap(rgba, w, h) {
    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < rgba.length; i += 4, p++) gray[p] = rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114;
    return costFromGray(gray, w, h);
}

/** The same cost map from a brightness picture (0–255), as the tracker has frames. */
function costFromGray(gray, w, h) {
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
function shortestPaths(cost, w, h, seed) {
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
function pathTo(tree, to) {
    const out = [];
    for (let p = to; p !== -1; p = tree.prev[p]) {
        out.push(p);
        if (p === tree.seed) { out.reverse(); return Int32Array.from(out); }
        if (out.length > tree.prev.length) break;
    }
    return null;
}

/** The strongest edge within `radius` of (x, y) — the nearest one when equal. */
function snap(cost, w, h, x, y, radius = 6) {
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
function floodFill(rgba, w, h, seeds, tolerance = 0.15, { colours = null, contiguous = true } = {}) {
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
function coolPath(previous, path, now, { ms = 600, moves = 12, margin = 40, min = 25 } = {}) {
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
function refineMask(rgba, w, h, mask, stroke, inside, reach = 16) {
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
function setupSelection({ $, source, overlay, surface = overlay, onChange }) {   // surface: takes the pointer, and may reach past the picture
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

/**
 * RF-DETR segmentation (Roboflow's RF-DETR-Seg, Apache-2.0: Small exported
 * to ONNX at 576 × 576, Nano at 312 × 312, both int8 — tools/export-model.py):
 * every object of the 80 COCO kinds in a picture, with its box, label,
 * score and outline, in one pass.
 *
 *   const model = await loadDetector(ort, url, { size }); // ort: onnxruntime-web (browser) or onnxruntime-node; size: the export's
 *   const found = await model.find(rgba, w, h);          // [{ label, score, box: [x0, y0, x1, y1], mask: Uint8Array(w × h) }]
 *
 * In: `input` [1, 3, size, size], the picture stretched to the square (no
 * letterbox), ImageNet-normalized. Out: `dets` [1, 100, 4] boxes as centre
 * x, y, width, height in 0…1 of the picture; `labels` [1, 100, 91] class
 * logits (COCO's own ids, 1…90 with gaps); `masks` [1, 100, size/4, size/4]
 * mask logits over the whole picture (> 0 is inside). A DETR needs no NMS: each of
 * the 100 queries is one object or nothing.
 */

/** COCO's category ids (as the model numbers them) → names. */
const COCO = {
    1: 'person', 2: 'bicycle', 3: 'car', 4: 'motorcycle', 5: 'airplane', 6: 'bus', 7: 'train', 8: 'truck', 9: 'boat',
    10: 'traffic light', 11: 'fire hydrant', 13: 'stop sign', 14: 'parking meter', 15: 'bench', 16: 'bird', 17: 'cat',
    18: 'dog', 19: 'horse', 20: 'sheep', 21: 'cow', 22: 'elephant', 23: 'bear', 24: 'zebra', 25: 'giraffe', 27: 'backpack',
    28: 'umbrella', 31: 'handbag', 32: 'tie', 33: 'suitcase', 34: 'frisbee', 35: 'skis', 36: 'snowboard', 37: 'sports ball',
    38: 'kite', 39: 'baseball bat', 40: 'baseball glove', 41: 'skateboard', 42: 'surfboard', 43: 'tennis racket',
    44: 'bottle', 46: 'wine glass', 47: 'cup', 48: 'fork', 49: 'knife', 50: 'spoon', 51: 'bowl', 52: 'banana', 53: 'apple',
    54: 'sandwich', 55: 'orange', 56: 'broccoli', 57: 'carrot', 58: 'hot dog', 59: 'pizza', 60: 'donut', 61: 'cake',
    62: 'chair', 63: 'couch', 64: 'potted plant', 65: 'bed', 67: 'dining table', 70: 'toilet', 72: 'tv', 73: 'laptop',
    74: 'mouse', 75: 'remote', 76: 'keyboard', 77: 'cell phone', 78: 'microwave', 79: 'oven', 80: 'toaster', 81: 'sink',
    82: 'refrigerator', 84: 'book', 85: 'clock', 86: 'vase', 87: 'scissors', 88: 'teddy bear', 89: 'hair drier', 90: 'toothbrush',
};

const SIZE = 576;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

/** The picture stretched to size × size (bilinear), normalized, as planes R G B. */
function prepare(rgba, w, h, size = SIZE) {
    const plane = size * size;
    const data = new Float32Array(3 * plane);
    for (let y = 0; y < size; y++) {
        const fy = Math.max(0, Math.min(h - 1, ((y + 0.5) * h) / size - 0.5));
        const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ay = fy - y0;
        for (let x = 0; x < size; x++) {
            const fx = Math.max(0, Math.min(w - 1, ((x + 0.5) * w) / size - 0.5));
            const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), ax = fx - x0;
            const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
            for (let k = 0; k < 3; k++) {
                const v = ((rgba[a + k] * (1 - ax) + rgba[b + k] * ax) * (1 - ay) + (rgba[c + k] * (1 - ax) + rgba[d + k] * ax) * ay) / 255;
                data[k * plane + y * size + x] = (v - MEAN[k]) / STD[k];
            }
        }
    }
    return data;
}

/**
 * Objects from the model's three outputs, in the picture's own pixels.
 * @param {Float32Array} dets 100 × 4   @param {Float32Array} logits 100 × classes   @param {Float32Array} masks 100 × m × m
 */
function decode(dets, logits, masks, w, h, { threshold = 0.4, classes = logits.length / 100, maskSize = Math.sqrt(masks.length / 100) } = {}) {
    const found = [];
    for (let q = 0; q < 100; q++) {
        let best = -Infinity, id = 0;
        for (let c = 0; c < classes; c++) if (logits[q * classes + c] > best) { best = logits[q * classes + c]; id = c; }
        const score = 1 / (1 + Math.exp(-best));
        if (score < threshold || !COCO[id]) continue;
        const [cx, cy, bw, bh] = dets.subarray(q * 4, q * 4 + 4);
        const clamp = (v, max) => Math.min(max, Math.max(0, v));
        const box = [clamp((cx - bw / 2) * w, w), clamp((cy - bh / 2) * h, h), clamp((cx + bw / 2) * w, w), clamp((cy + bh / 2) * h, h)];
        if (box[2] - box[0] < 2 || box[3] - box[1] < 2) continue;
        const mask = maskFor(masks.subarray(q * maskSize * maskSize, (q + 1) * maskSize * maskSize), maskSize, w, h);
        if (!mask.some(Boolean)) continue;
        found.push({ label: COCO[id], score, box, mask });
    }
    return found.sort((a, b) => b.score - a.score);
}

/** One object's outline: its m × m logits, bilinear at the picture's size (so the outline isn't blocky), > 0 inside. */
function maskFor(logits, m, w, h) {
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const fy = Math.max(0, Math.min(m - 1, ((y + 0.5) * m) / h - 0.5));
        const y0 = Math.min(m - 2, Math.floor(fy)), ay = fy - y0;
        for (let x = 0; x < w; x++) {
            const fx = Math.max(0, Math.min(m - 1, ((x + 0.5) * m) / w - 0.5));
            const x0 = Math.min(m - 2, Math.floor(fx)), ax = fx - x0;
            const i = y0 * m + x0;
            const v = (logits[i] * (1 - ax) + logits[i + 1] * ax) * (1 - ay) + (logits[i + m] * (1 - ax) + logits[i + m + 1] * ax) * ay;
            if (v > 0) mask[y * w + x] = 1;
        }
    }
    return mask;
}

/** @param ort onnxruntime-web or onnxruntime-node   @param source a URL, a path, or the model's bytes   size: the side it was exported at */
async function loadDetector(ort, source, { size = SIZE, ...options } = {}) {
    const session = await ort.InferenceSession.create(source, options);
    return {
        session,
        async find(rgba, w, h, opts = {}) {
            const out = await session.run({ input: new ort.Tensor('float32', prepare(rgba, w, h, size), [1, 3, size, size]) });
            return decode(out.dets.data, out.labels.data, out.masks.data, w, h, opts);
        },
    };
}

/**
 * MobileSAM (Segment Anything with a small image encoder; Apache-2.0, ONNX
 * from Acly/MobileSAM, int8 — tools/export-model.py): outlines whatever is
 * under a click, label or not.
 *
 *   const sam = await loadSam(ort, encoderUrl, decoderUrl);   // ort: onnxruntime-web or onnxruntime-node
 *   await sam.look(rgba, w, h);                                // the heavy part, once per picture
 *   const mask = await sam.mask({ points: [[x, y]], labels: [1], box });   // Uint8Array(w × h), fast
 *
 * The encoder takes the picture scaled so its longer side is 1024, as
 * [h, w, 3] RGB 0…255 (it normalizes and pads itself) and gives a 256 × 64 ×
 * 64 embedding. The decoder is Segment Anything's: points in that scaled
 * picture (label 1 in, 0 out; a box is two points labelled 2 and 3; without
 * a box a padding point labelled -1), and it returns four masks at the
 * picture's size with a predicted quality for each: one click is ambiguous
 * (a shirt or the person?), so masks 1–3 are the guesses and the surest is
 * taken; with more to go on, mask 0.
 */

const LONG = 1024;

/** The picture scaled (bilinear) so its longer side is 1024: [h, w, 3] floats 0…255. */
function scaled(rgba, w, h) {
    const s = LONG / Math.max(w, h);
    const nw = Math.round(w * s), nh = Math.round(h * s);
    const data = new Float32Array(nw * nh * 3);
    for (let y = 0; y < nh; y++) {
        const fy = Math.max(0, Math.min(h - 1, (y + 0.5) / s - 0.5));
        const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ay = fy - y0;
        for (let x = 0; x < nw; x++) {
            const fx = Math.max(0, Math.min(w - 1, (x + 0.5) / s - 0.5));
            const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), ax = fx - x0;
            const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
            for (let k = 0; k < 3; k++) data[(y * nw + x) * 3 + k] = (rgba[a + k] * (1 - ax) + rgba[b + k] * ax) * (1 - ay) + (rgba[c + k] * (1 - ax) + rgba[d + k] * ax) * ay;
        }
    }
    return { data, nw, nh, s };
}

/** The decoder's prompt: points (and a box) in the scaled picture. */
function prompt({ points = [], labels = [], box = null }, s) {
    const coords = points.map(([x, y]) => [x * s, y * s]);
    const kinds = [...labels];
    if (box) { coords.push([box[0] * s, box[1] * s], [box[2] * s, box[3] * s]); kinds.push(2, 3); }
    else { coords.push([0, 0]); kinds.push(-1); }
    return { coords: Float32Array.from(coords.flat()), labels: Float32Array.from(kinds), n: kinds.length };
}

/** @param ort onnxruntime-web or onnxruntime-node   @param encoder, decoder URLs, paths or bytes */
async function loadSam(ort, encoder, decoder, options = {}) {
    const enc = await ort.InferenceSession.create(encoder, options);
    const dec = await ort.InferenceSession.create(decoder, options);
    let picture = null;                    // { embedding, w, h, s }
    return {
        async look(rgba, w, h) {
            const { data, nw, nh, s } = scaled(rgba, w, h);
            const out = await enc.run({ input_image: new ort.Tensor('float32', data, [nh, nw, 3]) });
            picture = { embedding: out.image_embeddings, w, h, s };
        },
        async mask(ask) {
            const { embedding, w, h, s } = picture;
            const p = prompt(ask, s);
            const out = await dec.run({
                image_embeddings: embedding,
                point_coords: new ort.Tensor('float32', p.coords, [1, p.n, 2]),
                point_labels: new ort.Tensor('float32', p.labels, [1, p.n]),
                mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
                has_mask_input: new ort.Tensor('float32', new Float32Array(1), [1]),
                orig_im_size: new ort.Tensor('float32', Float32Array.from([h, w]), [2]),
            });
            const quality = out.iou_predictions.data;
            const single = (ask.points ?? []).length === 1 && !ask.box;
            let k = 0;
            if (single) { k = 1; for (let j = 2; j < 4; j++) if (quality[j] > quality[k]) k = j; }
            const logits = out.masks.data.subarray(k * w * h, (k + 1) * w * h);
            const mask = new Uint8Array(w * h);
            for (let i = 0; i < mask.length; i++) if (logits[i] > 0) mask[i] = 1;
            return mask;
        },
    };
}

/**
 * Finding objects with a neural network, in the browser — served by this
 * site itself: no Hugging Face, no CDN. Several models, to compare (all
 * Apache-2.0, demo/models/NOTICE):
 *
 *   rfdetr-small   RF-DETR-Seg Small: every object of 80 common kinds (people, cars, dogs, cups…),
 *                  labelled and outlined, in one pass; click one to take it
 *   rfdetr-nano    the same, smaller input: faster, a little less sure, finer things missed
 *   mobilesam      MobileSAM (Segment Anything): no list — click anything and it is outlined
 *   magictouch     MediaPipe's MagicTouch: click anything (small)
 *   magictouch2    MagicTouch 2: looks at the picture once, then clicks are quick
 *
 * The ONNX models run in ONNX Runtime Web (its WebAssembly build: ort/ on
 * the site), MagicTouch in MediaPipe's runtime (mediapipe/). Nothing loads
 * until "find objects" is used; then the browser caches it.
 *
 *   const ai = setupAI({ source: () => canvas, onProgress });
 *   ai.setModel('mobilesam');
 *   const boxes = await ai.detect();                                   // [{ label, score, box }] — [] for the click-anything models
 *   await ai.embed(otherFrame);                                         // look at another picture (a frame of a video)
 *   const mask = await ai.mask({ points: [[x, y]], labels: [1], box }); // Uint8Array, 1 inside, at the picture's size
 *
 * mask(): points labelled 1 are in the object, 0 are not; a box says
 * roughly where it is (the tracker's "fix red frames" uses that).
 */

const AI_MODELS = {
    'rfdetr-small': { name: 'RF-DETR Small', kind: 'objects', about: 'finds 80 kinds of thing, labelled — 41 MB', files: ['models/rfdetr-seg-small.onnx'], size: 576 },
    'rfdetr-nano': { name: 'RF-DETR Nano', kind: 'objects', about: 'the same, faster, less detail — 37 MB', files: ['models/rfdetr-seg-nano.onnx'], size: 312 },
    mobilesam: { name: 'MobileSAM', kind: 'anything', about: 'click anything — 19 MB', files: ['models/mobilesam-encoder.onnx', 'models/mobilesam-decoder.onnx'] },
    magictouch: { name: 'MagicTouch', kind: 'anything', about: 'click anything, small — 6 MB', files: ['models/magic_touch.tflite'] },
    magictouch2: { name: 'MagicTouch 2', kind: 'anything', about: 'click anything — 31 MB', files: ['models/magic_touch_2.task'] },
};
/**
 * What the built site carries (tools/build.mjs copies only these models; the first is the default): MobileSAM, as every
 * file must stay under 25 MiB to be hosted on Cloudflare Pages (RF-DETR Small is 39 MB). The others stay in demo/models/
 * to compare in development.
 */
const SHIPPED_MODELS = ['mobilesam'];
const DEFAULT_MODEL = SHIPPED_MODELS[0];
/** Where the runtimes are, relative to the page (node_modules in development, beside the page on the site). */
const ORT_URL = 'ort/';
const MEDIAPIPE_URL = 'mediapipe/';

function setupAI({ source, onProgress = () => {}, model = DEFAULT_MODEL, ortUrl = ORT_URL, mediapipeUrl = MEDIAPIPE_URL, base = location.href }) {   // base: where models/ is (the small apps live a folder down)
    let key = AI_MODELS[model] ? model : DEFAULT_MODEL;
    const backends = {};                // key → Promise<backend>
    const ready = {};                   // key → backend, once loaded
    let looked = false;                 // the current backend has looked at the picture
    let lookMs = 0;

    async function fetchWithProgress(url, what) {
        url = new URL(url, base).href;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${what} is not on this site (${url}: ${response.status}).`);
        const total = Number(response.headers.get('content-length')) || 0;
        if (!total || !response.body) return new Uint8Array(await response.arrayBuffer());
        const reader = response.body.getReader();
        const bytes = new Uint8Array(total);
        let got = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes.set(value, got);
            got += value.length;
            onProgress(`${what}: ${Math.round((got / total) * 100)}%`);
        }
        return bytes;
    }

    let ortPromise = null;
    const onnx = () => (ortPromise ??= import('onnxruntime-web').then((ort) => {   // the import map: node_modules in development, ort/ on the site
        ort.env.wasm.wasmPaths = new URL(ortUrl, location.href).href;
        // threads need a cross-origin-isolated page; elsewhere one thread, which still works
        ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
        return ort;
    }));
    let visionPromise = null;
    const mediapipe = () => (visionPromise ??= import('@mediapipe/tasks-vision').then(async (mp) => ({
        mp, fileset: await mp.FilesetResolver.forVisionTasks(new URL(mediapipeUrl, location.href).href.replace(/\/$/, '')),
    })));

    const pixels = (canvas) => canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;

    /** Two outlines that mostly agree are the same object found twice: keep the surer. */
    function merge(list) {
        const kept = [];
        for (const o of list) {
            const area = o.mask.reduce((a, b) => a + b, 0);
            const same = kept.some((k) => {
                let both = 0;
                for (let i = 0; i < o.mask.length; i++) if (o.mask[i] && k.mask[i]) both++;
                return both / Math.max(1, Math.min(area, k.area)) > 0.8;
            });
            if (!same) kept.push({ ...o, area });
        }
        return kept;
    }

    /** Each backend: look(canvas) once per picture, objects() (labelled, if it finds any), mask(prompt). */
    const makers = {
        async objects(spec, what) {
            const ort = await onnx();
            const model = await loadDetector(ort, await fetchWithProgress(spec.files[0], what), { size: spec.size, executionProviders: ['wasm'] });
            let found = [], w = 0, h = 0;
            return {
                async look(c) { w = c.width; h = c.height; found = merge(await model.find(pixels(c), w, h, { threshold: 0.4 })); },
                objects: () => found.map(({ label, score, box }) => ({ label, score, box })),
                async mask({ points = [], labels = [], box = null }) {
                    const result = new Uint8Array(w * h);
                    const add = (o, on) => { for (let i = 0; i < o.mask.length; i++) if (o.mask[i]) result[i] = on ? 1 : 0; };
                    if (box) {
                        // the object whose box overlaps this one most
                        const iou = (b) => {
                            const ix = Math.max(0, Math.min(b[2], box[2]) - Math.max(b[0], box[0])), iy = Math.max(0, Math.min(b[3], box[3]) - Math.max(b[1], box[1]));
                            const inter = ix * iy;
                            return inter / ((b[2] - b[0]) * (b[3] - b[1]) + (box[2] - box[0]) * (box[3] - box[1]) - inter);
                        };
                        const best = [...found].sort((a, b) => iou(b.box) - iou(a.box))[0];
                        if (best && iou(best.box) > 0.1) add(best, true);
                    }
                    const under = ([x, y]) => found
                        .filter((o) => o.mask[Math.round(y) * w + Math.round(x)])
                        .sort((a, b) => a.area - b.area)[0];                      // the smallest object there: a cup on a table, not the table
                    points.forEach((p, k) => { if (labels[k] === 1) { const o = under(p); if (o) add(o, true); } });
                    points.forEach((p, k) => { if (labels[k] === 0) { const o = under(p); if (o) add(o, false); } });
                    if (!result.some(Boolean) && points.some((_, k) => labels[k] === 1)) throw new Error('Nothing this model knows is there — try a click-anything model (MobileSAM, MagicTouch), or "trace the edge" or "fill a colour".');
                    return result;
                },
            };
        },
        async mobilesam(spec, what) {
            const ort = await onnx();
            const encoder = await fetchWithProgress(spec.files[0], what + ' (1 of 2)');
            const decoder = await fetchWithProgress(spec.files[1], what + ' (2 of 2)');
            const sam = await loadSam(ort, encoder, decoder, { executionProviders: ['wasm'] });
            return { look: (c) => sam.look(pixels(c), c.width, c.height), objects: () => [], mask: (p) => sam.mask(p) };
        },
        async magictouch(spec, what) {
            // the first MagicTouch: one keypoint per run of the whole model — each click is a run
            const { mp, fileset } = await mediapipe();
            const bytes = await fetchWithProgress(spec.files[0], what);
            const seg = await mp.InteractiveSegmenterLegacy.createFromOptions(fileset, { baseOptions: { modelAssetBuffer: bytes, delegate: 'CPU' }, outputCategoryMask: false, outputConfidenceMasks: true });
            let picture = null;
            const one = ([x, y]) => {
                const { width: w, height: h } = picture;
                const result = seg.segment(picture, { keypoint: { x: (x + 0.5) / w, y: (y + 0.5) / h } });
                const conf = result.confidenceMasks[0];
                const mask = resample$1(conf.getAsFloat32Array(), conf.width, conf.height, w, h, 0.5);
                result.close();
                return mask;
            };
            return {
                async look(c) { picture = copy$1(c); },
                objects: () => [],
                async mask({ points = [], labels = [], box = null }) {
                    const result = new Uint8Array(picture.width * picture.height);
                    const asks = points.map((p, k) => [p, labels[k]]);
                    if (box) asks.unshift([[(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], 1]);   // a box: its middle
                    for (const [p] of asks.filter(([, l]) => l === 1)) one(p).forEach((v, i) => { if (v) result[i] = 1; });
                    for (const [p] of asks.filter(([, l]) => l === 0)) one(p).forEach((v, i) => { if (v) result[i] = 0; });
                    return result;
                },
            };
        },
        async magictouch2(spec, what) {
            // MagicTouch 2: setImage runs its encoder once; each set of strokes runs only the decoder
            const { mp, fileset } = await mediapipe();
            const bytes = await fetchWithProgress(spec.files[0], what);
            const seg = await mp.InteractiveSegmenter.createFromOptions(fileset, { baseOptions: { modelAssetBuffer: bytes } });
            const POSITIVE = 1, NEGATIVE = 2, LASSO = 3;            // its BrushMode (a type only: the bundle doesn't export it)
            let w = 0, h = 0;
            return {
                async look(c) { w = c.width; h = c.height; seg.setImage(copy$1(c)); },
                objects: () => [],
                async mask({ points = [], labels = [], box = null }) {
                    const at = ([x, y]) => ({ x: (x + 0.5) / w, y: (y + 0.5) / h });
                    const strokes = points.map((p, k) => ({ brushMode: labels[k] ? POSITIVE : NEGATIVE, point: [at(p)], isCompleted: true }));
                    if (box) strokes.unshift({ brushMode: LASSO, point: [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]], [box[0], box[1]]].map(at), isCompleted: true });
                    const m = seg.segment(strokes);
                    const values = m.hasFloat32Array() ? m.getAsFloat32Array() : Float32Array.from(m.getAsUint8Array(), (v) => v / 255);
                    const mask = resample$1(values, m.width, m.height, w, h, 0.5);
                    m.close();
                    return mask;
                },
            };
        },
    };

    async function load() {
        const k = key;
        if (ready[k]) return ready[k];
        const spec = AI_MODELS[k];
        backends[k] ??= (async () => {
            onProgress(`Loading ${spec.name}…`);
            const backend = await (spec.kind === 'objects' ? makers.objects : makers[k])(spec, spec.name);
            onProgress('');
            return backend;
        })().catch((e) => { delete backends[k]; throw new Error(`Finding objects with ${spec.name} is not available: ${e.message}`); });
        ready[k] = await backends[k];
        return ready[k];
    }

    return {
        get loaded() { return Boolean(ready[key]); },
        get device() { return ready[key] ? 'wasm' : null; },
        get model() { return key; },
        get spec() { return AI_MODELS[key]; },
        /** How long the last look at a picture took, in ms. */
        get lookMs() { return lookMs; },
        setModel(k) { if (AI_MODELS[k] && k !== key) { key = k; looked = false; } },
        load,

        /** Look at the picture (or `canvas`). */
        async embed(canvas) {
            const backend = await load();
            const c = canvas ?? source();
            onProgress('Looking…');
            const t0 = performance.now();
            await backend.look(c);
            lookMs = performance.now() - t0;
            looked = true;
            onProgress('');
        },
        invalidate() { looked = false; },

        /** What is in the picture: labels and boxes ([] for the click-anything models). */
        async detect() {
            if (!looked) await this.embed();
            return ready[key].objects();
        },

        /** An outline from a box and/or points (1: this object, 0: not this one), at the picture's size. */
        async mask(prompt = {}) {
            if (!looked) await this.embed();
            return ready[key].mask(prompt);
        },
    };
}

/** A copy of a canvas (MediaPipe may keep it; the source canvas changes as a video plays). */
function copy$1(c) {
    const out = document.createElement('canvas');
    out.width = c.width; out.height = c.height;
    out.getContext('2d').drawImage(c, 0, 0);
    return out;
}

/** values (sw × sh) → a 0/1 mask (w × h), bilinear, above `cut`. */
function resample$1(values, sw, sh, w, h, cut) {
    const mask = new Uint8Array(w * h);
    if (sw === w && sh === h) { for (let i = 0; i < mask.length; i++) mask[i] = values[i] > cut ? 1 : 0; return mask; }
    for (let y = 0; y < h; y++) {
        const fy = Math.max(0, Math.min(sh - 1, ((y + 0.5) * sh) / h - 0.5));
        const y0 = Math.min(sh - 2, Math.floor(fy)), ay = fy - y0;
        for (let x = 0; x < w; x++) {
            const fx = Math.max(0, Math.min(sw - 1, ((x + 0.5) * sw) / w - 0.5));
            const x0 = Math.min(sw - 2, Math.floor(fx)), ax = fx - x0;
            const i = y0 * sw + x0;
            const v = (values[i] * (1 - ax) + values[i + 1] * ax) * (1 - ay) + (values[i + sw] * (1 - ax) + values[i + sw + 1] * ax) * ay;
            if (v > cut) mask[y * w + x] = 1;
        }
    }
    return mask;
}

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

// ---- the object's colours ----------------------------------------------------------
const BINS = 12;                                       // per channel: 1728 colours
/** Each pixel's colour bin, and its brightness 0–255. */
function frameData(rgba, w, h) {
    const gray = new Uint8Array(w * h), bins = new Uint16Array(w * h);
    for (let i = 0, p = 0; p < w * h; i += 4, p++) {
        gray[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
        bins[p] = ((rgba[i] * BINS) >> 8) * BINS * BINS + ((rgba[i + 1] * BINS) >> 8) * BINS + ((rgba[i + 2] * BINS) >> 8);
    }
    return { gray, bins };
}

/** The pixels inside a closed outline (even–odd scanlines). */
function fillPolygon(loop, w, h) {
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
function colourModel(bins, loop, w, h) {
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
function probabilityMap(bins, model, w, h) {
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
function objectCost(gray, prob, w, h) {
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
function contrast(prob, loop, w, h) {
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
function resample(loop, n) {
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
function boundedPath(cost, w, h, from, to, pad = 10) {
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
function area(loop) {
    let a = 0;
    for (let i = 0; i < loop.length; i++) { const p = loop[i], q = loop[(i + 1) % loop.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return Math.abs(a) / 2;
}

/** How strong the edges under an outline are, 0–1 (1: every pixel on a strong edge). */
function edgeScore(loop, cost, w, h) {
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
function trackStep(loop, grayA, grayB, costB, w, h, { points = 0, prob = null, reference = 0 } = {}) {
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
function createTracker({ frames, w, h, getFrame, onProgress = () => {} }) {
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
            keys.reduce((s, k, i) => s + ((keys[i + 1] ?? frames) - k - 1) + (k - (keys[i - 1] ?? -1) - 1), 0);
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

/**
 * A filter's knobs written as Inline Math variables, and the page each filter has in the editor.
 * No DOM: test/knobs.test.js.
 *
 *   cutoff := [[0..1 step 0.01 = 0.5]]    a slider (min..max, its step, where it starts)
 *   radius := [[3]]                        a box: any maths that works out to a number
 *   levels := [[2 | 4 | 8]]                a menu of values
 *   tint := #ff8800                        a colour
 *
 * Each line is what the editor shows in a knob's box; Inline Math draws the same line (but for a
 * colour) as `cutoff ≔` and its input. A filter's page (`notes` in the format) is Markdown text and
 * `{ param }` entries for where each knob goes; knobs it doesn't place come first.
 */

const NUMBER = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)';
const SLIDER = new RegExp(`^(${NUMBER})\\s*\\.\\.\\s*(${NUMBER})(?:\\s+step\\s+(${NUMBER}))?(?:\\s*=\\s*(${NUMBER}))?$`);
const DEFINITION = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:=\s*(.*?)\s*$/;
const HOW = 'Write a knob as name := [[0..1 step 0.01 = 0.5]] (a slider), [[0.5]] (a box), [[2 | 4 | 8]] (a menu) or #ff8800 (a colour)';

/** A number as the editor writes it: at most 4 decimals. */
const trim = (n) => String(Math.round(Number(n) * 1e4) / 1e4);
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/** The step a slider moves by when the knob doesn't say: about 200 steps, rounded to 1, 2 or 5 of a power of ten. */
function sliderStep(param) {
    if (param.step) return param.step;
    const raw = (param.max - param.min) / 200;
    if (!(raw > 0)) return 0.01;
    const power = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw * 0.999);
}

/** The knob as a line: `cutoff := [[0..1 step 0.005 = 0.5]]`. */
function definitionOf(name, param) {
    if (param.type === 'color') return `${name} := ${toHex(param.default)}`;
    if (param.options) return `${name} := [[${param.options.map(trim).join(' | ')}]]`;
    if (param.input === 'box') return `${name} := [[${trim(param.default)}]]`;
    return `${name} := [[${trim(param.min)}..${trim(param.max)} step ${trim(sliderStep(param))} = ${trim(param.default)}]]`;
}

/** What Inline Math is given for a knob's input: its line with the value it starts at (a menu starts on its first option). */
function inlineDefinition(name, param) {
    if (param.options) return `${name} := [[${[param.default, ...param.options.filter((o) => o !== param.default)].map(trim).join(' | ')}]]`;
    return definitionOf(name, param);
}

/** A number from what an input holds: `0.5`, or maths such as `1/3` or `2 pi`; null when it isn't one. */
function numberOf(text) {
    const plain = Number(text);
    if (String(text).trim() !== '' && Number.isFinite(plain)) return plain;
    try {
        const { value } = calculate(String(text), {});
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * A knob's line → `{ name, spec }`, the spec as the format has it (params). Throws, saying how to
 * write one, when it isn't. `label` carries over the knob's label, if it had one.
 */
function parseDefinition(text, label) {
    const m = DEFINITION.exec(String(text));
    if (!m || !m[2]) throw new Error(HOW);
    const [, name, rhs] = m;
    const keep = label ? { label } : {};
    if (/^#[0-9a-f]{6}$/i.test(rhs)) return { name, spec: { type: 'color', ...keep, default: fromHex(rhs) } };
    const boxed = /^\[\[([\s\S]*)\]\]$/.exec(rhs);
    const inner = (boxed ? boxed[1] : rhs).trim();
    const range = SLIDER.exec(inner);
    if (range) {
        const [min, max] = [Number(range[1]), Number(range[2])];
        if (!(max > min)) throw new Error(`A slider goes from a smaller number to a larger one: ${inner}`);
        const step = range[3] !== undefined ? Number(range[3]) : undefined;
        if (step !== undefined && !(step > 0)) throw new Error('A slider\'s step is more than 0');
        const start = range[4] !== undefined ? Number(range[4]) : min;
        if (!(start >= min && start <= max)) throw new Error(`The slider starts at ${start}, outside ${min} to ${max}`);
        return { name, spec: { type: 'number', ...keep, default: start, min, max, ...(step !== undefined ? { step } : {}) } };
    }
    if (inner.includes('|')) {
        const options = inner.split('|').map((o) => o.trim()).filter(Boolean).map(numberOf);
        if (!options.length || options.some((o) => o === null)) throw new Error(`A menu is numbers between | marks: [[2 | 4 | 8]]`);
        return { name, spec: { type: 'number', ...keep, default: options[0], options } };
    }
    const value = numberOf(inner);
    if (value === null) throw new Error(`${inner} is not a number. ${HOW}`);
    return { name, spec: { type: 'number', ...keep, default: value, input: 'box' } };
}

/** The filter's page in order: every knob ({ param }) and every text (a string). */
function blocksOf(params, notes = []) {
    const names = Object.keys(params);
    const placed = new Set(notes.filter((b) => typeof b === 'object').map((b) => b.param));
    return [...names.filter((n) => !placed.has(n)).map((param) => ({ param })), ...notes.filter((b) => typeof b === 'string' || names.includes(b.param))];
}

/** The page as the format keeps it: nothing when it is only the knobs in their own order. */
function notesOf(blocks) {
    return blocks.some((b) => typeof b === 'string') ? blocks.map((b) => (typeof b === 'string' ? b : { param: b.param })) : undefined;
}

/** A name for a new knob: k1, k2 … one not taken. */
function freeName(taken, prefix = 'k') {
    for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

/** `old` renamed to `name` everywhere it is a whole word in the maths (not inside other names, nor after a dot). */
function renameInMaths(color, old, name) {
    const swap = (text) => text.replace(new RegExp(`(?<![\\w.])${old}(?![\\w])`, 'g'), name);
    if (typeof color === 'string') return swap(color);
    return Object.fromEntries(Object.entries(color).map(([k, v]) => [k, swap(v)]));
}

/**
 * A step as a filter of its own, to save or share: a filter's knobs start where the step has
 * them, its pictures and graphics as the step places them; a chain keeps the step's settings in
 * a step of its own.
 */
function bakeStep(step) {
    const f = JSON.parse(JSON.stringify(step.filter));
    const settings = step.with ?? {};
    if (f.steps) {
        if (!Object.keys(settings).length) return f;
        const { name, author, description, notes, ...inner } = f;
        const out = { name, author, description, notes, steps: [{ filter: inner, with: settings }] };
        for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
        return out;
    }
    for (const [key, value] of Object.entries(settings)) {
        const param = f.params?.[key];
        if (param) {
            if (param.type === 'color') param.default = value.map(Number);
            else {
                const v = Number(value);
                param.default = v;
                if (param.options && !param.options.includes(v)) param.options = [...param.options, v];
                if (v < param.min) param.min = v;
                if (v > param.max) param.max = v;
            }
        } else if (f.graphics?.[key]) f.graphics[key] = { ...f.graphics[key], ...value };
        else if (f.images?.[key]) f.images[key] = { ...f.images[key], ...value };
    }
    return f;
}

const MZ = { ...core, ...filters };
window.MathZetta = MZ;   // for tools/check.mjs
const $ = (id) => document.getElementById(id);

// ---- built-in library ------------------------------------------------------
const BUILTIN = MZ.LIBRARY;
const byName = (name) => BUILTIN.find((f) => f.name === name);

// Saved filters: a list of filters (the format's JSON) in localStorage, under "qblur".
const STORE = 'qblur';
const saved = () => { try { const list = JSON.parse(localStorage.getItem(STORE)); return Array.isArray(list) ? list : []; } catch { return []; } };
const store = (list) => localStorage.setItem(STORE, JSON.stringify(list));

// ---- state -----------------------------------------------------------------
let chain = { format: MZ.FILTER_FORMAT, steps: [] };
let compiled = null;
let runner = null;
let currentT = 0;
let video = null;
let media = { kind: 'test', source: null, width: 320, height: 240 };   // the picture, at its own size
const toStep = (stepLike) => MZ.normalizeFilter({ steps: [stepLike] }).steps[0];
const base = () => location.href.split('#')[0];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const GUIDE = $('guide-link').getAttribute('href');   // ../docs/filters.md here, guide.html on the site

// ---- help, and errors that say where to look ------------------------------
function renderHelp() {
  const box = $('help-body');
  for (const section of HELP) {
    const div = document.createElement('section');
    div.id = `help-${section.id}`;
    div.innerHTML = `<h3>${esc(section.title)}<a class="hint" href="${esc(GUIDE)}#${section.guide}">more in the guide</a></h3>`
      + (section.note ? `<div class="hint">${esc(section.note)}</div>` : '')
      + `<table>${section.rows.map(([code, meaning]) => `<tr><td><code>${esc(code)}</code></td><td>${esc(meaning)}</td></tr>`).join('')}</table>`;
    for (const example of section.examples) {
      const def = Array.isArray(example) ? example[0] : example.def;
      const show = Array.isArray(example) ? example[0] : example.show;
      const caption = Array.isArray(example) ? example[1] : example.caption;
      const row = document.createElement('div');
      row.className = 'example';
      row.append(button('Try', () => addStep(def)), Object.assign(document.createElement('code'), { textContent: show }), Object.assign(document.createElement('span'), { className: 'hint', textContent: caption }));
      div.append(row);
    }
    box.append(div);
  }
}

function showHelp(id) {
  $('help').open = true;
  const section = document.getElementById(`help-${id}`) ?? $('help');
  section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** The error, plus — when it is one we recognise — what to do and where to read. */
function showError(message) {
  const box = $('error');
  box.textContent = '';
  if (!message) return;
  const { text, hint, id, guide } = explain(message);
  box.textContent = text;
  if (!hint) return;
  const line = document.createElement('div');
  line.className = 'hint';
  line.append(hint + ' ');
  if (id) {
    const a = Object.assign(document.createElement('a'), { href: '#help', textContent: 'help' });
    a.onclick = (e) => { e.preventDefault(); showHelp(id); };
    line.append(a, ' · ');
  }
  if (guide) line.append(Object.assign(document.createElement('a'), { href: `${GUIDE}#${guide}`, textContent: 'guide' }));
  box.append(line);
}

// ?webgl2 runs the GLSL ES 3.0 output on WebGL 2; ?precision=half|float keeps more between passes.
const QUERY = new URLSearchParams(location.search);
const WEBGL2 = QUERY.has('webgl2');
QUERY.get('precision') || 'byte';
const gl = $('out').getContext(WEBGL2 ? 'webgl2' : 'webgl', { preserveDrawingBuffer: true });
// The GPU can take the context away (a reset, the laptop sleeping, too much memory). Say so,
// come back when it is restored, and after repeated losses stay on the CPU.
let contextLosses = 0;
$('out').addEventListener('webglcontextlost', (e) => {
  e.preventDefault();                                      // ask for it back
  contextLosses += 1;
  runner = null;                                           // its programs and textures are gone
  $('error').textContent = 'The graphics context was lost (the GPU reset). Waiting for it to come back…';
});
$('out').addEventListener('webglcontextrestored', () => {
  $('error').textContent = '';
  if (contextLosses >= 2 && $('engine').value === 'auto') {
    $('engine').value = 'cpu';
    $('engineNote').textContent = 'switched to the CPU after repeated GPU resets';
  }
  recompile();
});
// Without WebGL the filters still run, on the CPU (createCpuRunner); ?engine=gpu|cpu forces one.
let engine = 'gpu';
let engineReason = '';
const outCanvas = () => (engine === 'cpu' ? $('outCpu') : $('out'));

function recompile() {
  if (runner) { runner.dispose(); runner = null; }
  compiled = null;
  showError('');
  try {
    compiled = MZ.compileFilter(chain.steps.length ? chain : 'rgb', { version: WEBGL2 ? 300 : 100 });
    // A colour space between passes wants more than 8 bits (Lab's dark corners lose ~20/255 in bytes): half floats where the GPU has them.
    const precision = QUERY.get('precision') || (compiled.passes.some((p) => p.space && p.space !== 'srgb') ? 'half' : 'byte');
    const made = MZ.createRunner(compiled, { gl, prefer: QUERY.get('engine') || $('engine').value, precision });
    runner = made.runner.setImage($('source'));
    engine = made.engine;
    engineReason = made.reason;
    $('out').hidden = engine === 'cpu';
    $('outCpu').hidden = engine !== 'cpu';
    bindPictures();
    if (typeof selection !== 'undefined') bindSelection(false);
    bindGraphics();
  } catch (e) {
    showError(e.message);
  }
  $('shaders').textContent = compiled ? compiled.passes.map((p) => `// ${p.name || 'step'} ${p.path.map((i) => i + 1).join('.')}\n${p.fragment}`).join('\n\n') : '';
  $('credits').textContent = compiled && compiled.credits.length
    ? 'Uses ' + compiled.credits.map((c) => c.name + (c.author ? ' by ' + c.author : '')).join(', ')
    : '';
  $('steps-empty').hidden = chain.steps.length > 0;
  updateMoving();
  draw();
}

// ---- still or moving: time is shown only when something moves ---------------
// A still picture under a filter that doesn't use t (or random, or brush strokes, which play out) never changes,
// so it isn't redrawn every frame and the time slider, play, "record" and "save as GIF" are put away.
let moving = true;
function filterMoves() {
  if (!compiled) return false;
  if (Object.values(compiled.graphics ?? {}).some((g) => g.type === 'strokes')) return true;
  return compiled.passes.some((p) => {
    if (p.blendKept) return false;
    try { const uses = MZ.compileCpuPass(p).uses; return uses.has('t') || uses.has('random'); } catch { return true; }
  });
}
function updateMoving() {
  moving = media.kind === 'video' || media.kind === 'gif' || filterMoves();
  document.body.classList.toggle('still', !moving);
}

function draw() {
  if (!runner || (engine === 'gpu' && gl && gl.isContextLost())) return;
  updateStrokes();
  drawStrokeOverlay();
  const t0 = performance.now();
  runner.draw({ t: currentT, canvas: engine === 'cpu' ? $('outCpu') : undefined });
  const textures = runner.precision && runner.precision !== 'byte' ? ` · ${runner.precision} textures` : '';
  $('engineNote').textContent = engine === 'cpu' ? `CPU — ${engineReason} · ${(performance.now() - t0).toFixed(1)} ms a frame${textures}` : `GPU — ${engineReason}${textures}`;
}
$('engine').addEventListener('change', recompile);

function rebuild() { recompile(); renderSteps(); renderPictures(); updateShare(); }

// ---- other pictures: masks and overlays ------------------------------------
const slots = new Map();   // image name → { canvas, kind, file }
const KINDS = {
  'radial mask': (ctx, w, h) => { const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.15, w / 2, h / 2, h * 0.7); g.addColorStop(0, '#000'); g.addColorStop(1, '#fff'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); },
  'portrait photo': (ctx, w, h) => {              // a different size, to show placement
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#0b3d91'); g.addColorStop(1, '#f28c28');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(w * 0.5, h * 0.3, w * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1e7f3a'; ctx.fillRect(0, h * 0.7, w, h * 0.3);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 24px sans-serif'; ctx.fillText('portrait', 20, h - 20);
  },
  'left-right mask': (ctx, w, h) => { const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#000'); g.addColorStop(1, '#fff'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); },
  stripes: (ctx, w, h) => {
    ctx.fillStyle = '#f7b733'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fc4a1a';
    for (let i = -h; i < w; i += 40) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 20, 0); ctx.lineTo(i + 20 + h, h); ctx.lineTo(i + h, h); ctx.fill(); }
    ctx.fillStyle = 'rgba(40, 90, 220, 0.9)'; ctx.beginPath(); ctx.arc(w * 0.65, h * 0.45, h * 0.3, 0, Math.PI * 2); ctx.fill();
  },
  checkerboard: (ctx, w, h) => { for (let i = 0; i < w / 32; i++) for (let j = 0; j < h / 32; j++) { ctx.fillStyle = (i + j) % 2 ? '#fff' : '#333'; ctx.fillRect(i * 32, j * 32, 32, 32); } },
  'the picture': (ctx, w, h) => ctx.drawImage($('source'), 0, 0, w, h),
};

const SIZES = { 'portrait photo': [200, 300] };    // other kinds are 320 × 240

function paintSlot(slot) {
  const [w, h] = slot.file ? [slot.file.naturalWidth, slot.file.naturalHeight].map((v, i) => Math.round(v * Math.min(1, 640 / slot.file.naturalWidth, 640 / slot.file.naturalHeight))) : (SIZES[slot.kind] ?? [320, 240]);
  slot.canvas.width = w; slot.canvas.height = h;
  const ctx = slot.canvas.getContext('2d');
  if (slot.file) ctx.drawImage(slot.file, 0, 0, w, h); else KINDS[slot.kind](ctx, w, h);
}

function slotFor(name) {
  if (!slots.has(name)) {
    const kind = /mask/i.test(name) ? 'radial mask' : /inset|photo|picture/i.test(name) ? 'portrait photo' : 'stripes';
    const slot = { canvas: document.createElement('canvas'), kind, file: null };
    slots.set(name, slot);
    paintSlot(slot);
  }
  return slots.get(name);
}

function bindPictures() {
  if (!runner || !compiled) return;
  for (const name of Object.keys(compiled.images)) runner.setImage(name, slotFor(name).canvas);
}

function repaintCopies() {           // slots showing "the picture" follow the main picture
  for (const slot of slots.values()) if (slot.kind === 'the picture' && !slot.file) paintSlot(slot);
  bindPictures();
}

function renderPictures() {
  const names = compiled ? Object.keys(compiled.images) : [];
  const box = $('pictures');
  box.innerHTML = '';
  $('pictures-section').hidden = !names.length;
  for (const name of names) {
    const slot = slotFor(name);
    const row = document.createElement('div');
    row.className = 'slot';
    const info = document.createElement('div');
    const description = compiled.images[name].description;
    info.innerHTML = `<b>${esc(name)}</b>${description ? ` <span class="hint">${esc(description)}</span>` : ''}<br>`;
    const pick = document.createElement('select');
    for (const kind of Object.keys(KINDS)) pick.append(Object.assign(document.createElement('option'), { value: kind, textContent: kind, selected: kind === slot.kind && !slot.file }));
    if (slot.file) pick.append(Object.assign(document.createElement('option'), { value: 'file', textContent: 'your file', selected: true }));
    pick.onchange = () => { if (pick.value === 'file') return; slot.kind = pick.value; slot.file = null; paintSlot(slot); bindPictures(); draw(); renderPictures(); };
    const file = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    file.onchange = async () => {
      if (!file.files[0]) return;
      const img = new Image();
      img.src = URL.createObjectURL(file.files[0]);
      await img.decode();
      slot.file = img; paintSlot(slot); bindPictures(); draw(); renderPictures();
    };
    info.append(pick, ' ', file);
    // Placement: how this picture sits over the frame. Set on every step that uses it.
    const current = placementOf(name);
    const steps = chain.steps.filter((step) => name in MZ.filterImages(step.filter));
    const setPlacement = (key, value, recompileNeeded) => {
      for (const step of steps) step.with[name] = { ...(step.with[name] ?? {}), [key]: value };
      if (recompileNeeded) { recompile(); updateShareSoon(); return; }
      if (compiled) for (const pass of compiled.passes) if (pass.placements[name]) pass.placements[name][key] = value;
      draw(); updateShareSoon();
    };
    const place = document.createElement('select');
    for (const mode of ['cover', 'fit', 'stretch', 'tile']) place.append(Object.assign(document.createElement('option'), { value: mode, textContent: mode, selected: mode === current.place }));
    place.onchange = () => setPlacement('place', place.value, true);
    const placing = document.createElement('div');
    placing.append('place: ', place);
    placing.append(knob('zoom', current.zoom, 0.1, 4, 0.01, (v) => setPlacement('zoom', v)));
    placing.append(knob('x', current.x, -0.5, 1.5, 0.01, (v) => setPlacement('x', v)));
    placing.append(knob('y', current.y, -0.5, 1.5, 0.01, (v) => setPlacement('y', v)));
    placing.append(knob('angle', current.angle, -3.14, 3.14, 0.01, (v) => setPlacement('angle', v)));
    info.append(placing);
    row.append(slot.canvas, info);
    box.append(row);
  }
}

function placementOf(name) {
  const pass = compiled && compiled.passes.find((p) => p.placements[name]);
  return pass ? pass.placements[name] : MZ.PLACEMENT;
}

// ---- the chain -------------------------------------------------------------
function addStep(def) { chain.steps.push(toStep(def)); rebuild(); }

function liveValue(stepIndex, name, fallback) {
  const pass = compiled && compiled.passes.find((p) => p.path[0] === stepIndex && name in p.params);
  return pass ? pass.values[name] : fallback;
}

function setLive(stepIndex, name, value) {
  if (compiled) for (const pass of compiled.passes) if (pass.path[0] === stepIndex && name in pass.params) pass.values[name] = value;
  draw();
  updateShareSoon();
}

// Each step is a filter that folds away: its name, its maths, and its page — the knobs, each a line
// written as an Inline Math variable (`cutoff := [[0..1 step 0.01 = 0.5]]`) and drawn by Inline Math
// as its input, and notes in Markdown, whose maths sees the knobs ({{cutoff}} is the value now).
const folded = new WeakSet();            // steps the user folded away
const editing = new WeakSet();           // steps showing their editing parts: name and author, each knob's line, the add buttons
let openNote = null;                     // { step, k }: a text just added, opened for writing

function stepTitle(f) {
  const drawn = Object.values(MZ.filterGraphics(f)).map((g) => ({ text: 'Text', rect: 'Rectangle', ellipse: 'Oval', strokes: 'Brush strokes' }[g.type] ?? 'Shape'));
  if (f.name) return `<b>${esc(f.name)}</b>${f.author ? ` <span class="hint">by ${esc(f.author)}</span>` : ''}${f.steps ? ' <span class="hint">· chain</span>' : ''}`;
  if (drawn.length) return `<b>${esc([...new Set(drawn)].join(' and '))}</b>`;
  return typeof f.color === 'string' ? `<code>${esc(f.color)}</code>` : '<span class="hint">expression</span>';
}

function renderSteps() {
  const list = $('steps');
  // Inline Math keeps a drawing live until it is drawn again: let the old ones go
  for (const el of list.querySelectorAll('.md-live')) renderMarkdownInto(el, '', { variables: false });
  list.innerHTML = '';
  chain.steps.forEach((step, i) => list.append(stepItem(step, i)));
}

function stepItem(step, i) {
  const f = step.filter;
  const li = document.createElement('li');
  li.className = 'step';
  const open = !folded.has(step);
  li.innerHTML = `<div class="head"><button class="fold" aria-expanded="${open}" aria-controls="step-${i}" aria-label="fold or unfold this step" title="fold / unfold">▸</button>`
    + `<span class="grip" draggable="true" title="drag to reorder">⠿</span><input type="checkbox" class="on" title="on / off" aria-label="use this step"${step.skip ? '' : ' checked'}>`
    + `<span class="title">${stepTitle(f)}</span><button class="edit" aria-pressed="${editing.has(step)}" title="show or hide the step's name, its knobs' lines and the add buttons">Edit</button><button data-act="up" title="move up" aria-label="move up">↑</button><button data-act="down" title="move down" aria-label="move down">↓</button><button data-act="remove" title="remove" aria-label="remove this step">✕</button></div>`;
  li.classList.toggle('skipped', Boolean(step.skip));
  li.classList.toggle('editing', editing.has(step));
  const setEditing = (on) => {
    if (on) editing.add(step); else editing.delete(step);
    li.classList.toggle('editing', on);
    li.querySelector('.edit').setAttribute('aria-pressed', String(on));
  };
  li.querySelector('.edit').onclick = () => {
    setEditing(!editing.has(step));
    if (body.hidden) fold();                                         // editing a folded step: open it
  };
  const body = Object.assign(document.createElement('div'), { className: 'body', id: `step-${i}`, hidden: !open });
  const fold = () => {
    const now = body.hidden;
    body.hidden = !now;
    li.querySelector('.fold').setAttribute('aria-expanded', String(now));
    if (now) folded.delete(step); else folded.add(step);
  };
  li.querySelector('.fold').onclick = fold;
  li.querySelector('.title').onclick = fold;
  li.querySelector('.on').addEventListener('change', (e) => { step.skip = !e.target.checked; li.classList.toggle('skipped', step.skip); recompile(); updateShareSoon(); });
  // Drag the grip onto another step to move this one there (the ↑ ↓ buttons do the same one place at a time).
  li.querySelector('.grip').addEventListener('dragstart', (e) => { dragging = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
  li.addEventListener('dragover', (e) => { if (dragging === null) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; li.classList.add('over'); });
  li.addEventListener('dragleave', () => li.classList.remove('over'));
  li.addEventListener('drop', (e) => { e.preventDefault(); li.classList.remove('over'); if (dragging !== null && dragging !== i) moveStep(dragging, i); dragging = null; });
  li.addEventListener('dragend', () => { dragging = null; for (const el of $('steps').querySelectorAll('.over')) el.classList.remove('over'); });
  for (const b of li.querySelectorAll('.head button[data-act]')) b.onclick = () => act(b.dataset.act, i);

  // its name and author: a filter from the library or a link, renamed, is your fork of it
  const who = Object.assign(document.createElement('div'), { className: 'meta' });
  for (const [key, placeholder] of [['name', 'name this filter'], ['author', 'author']]) {
    const input = Object.assign(document.createElement('input'), { type: 'text', value: f[key] ?? '', placeholder });
    input.setAttribute('aria-label', `this step's ${key}`);
    input.addEventListener('input', () => {
      if (input.value.trim()) f[key] = input.value.trim(); else delete f[key];
      li.querySelector('.title').innerHTML = stepTitle(f);
      updateShareSoon();
    });
    input.addEventListener('change', recompile);                       // the credits line
    who.append(input);
  }
  body.append(who);
  if (!f.steps && typeof f.color === 'string') {                       // a filter's maths stays editable, and so does its colour space
    // the maths wraps and grows with what is written (Enter applies it; shift+Enter is a new line)
    const input = Object.assign(document.createElement('textarea'), { className: 'expr', value: f.color, spellcheck: false, rows: 1 });
    input.setAttribute('aria-label', 'the maths');
    const fit = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight + 2}px`; };
    input.addEventListener('input', fit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); input.dispatchEvent(new Event('change')); } });
    input.addEventListener('change', () => { f.color = input.value; li.querySelector('.title').innerHTML = stepTitle(f); recompile(); updateShare(); });
    requestAnimationFrame(fit);
    const space = $('expr-space').cloneNode(true);
    space.id = '';
    space.value = f.space ? f.space.in : 'srgb';
    space.addEventListener('change', () => { if (space.value === 'srgb') delete f.space; else f.space = { in: space.value, out: space.value }; recompile(); updateShare(); });
    const row = document.createElement('div');
    row.className = 'add';
    row.append(input, space);
    input.style.flex = '1'; input.style.width = 'auto';
    body.append(row);
  } else if (f.space) {
    body.append(Object.assign(document.createElement('div'), { className: 'hint', textContent: `in ${f.space.in === f.space.out ? f.space.in : `${f.space.in} → ${f.space.out}`}` }));
  }
  body.append(stepPage(step, i));
  body.append(knob('opacity', step.opacity, 0, 1, 0.01, (v) => setOpacity(step, v)));
  for (const [name, base] of Object.entries(MZ.filterGraphics(f))) body.append(graphicControls(i, name, base));
  const actions = Object.assign(document.createElement('div'), { className: 'step-actions' });
  actions.append(button('Save this step', () => { if (!f.name) setEditing(true); saveFilter(MZ.normalizeFilter(bakeStep(step)), who.querySelector('input')); }),
    button('Copy its link', () => copy(MZ.filterToLink(bakeStep(step), base()), 'Link to this step copied — whoever opens it can change it and keep their own')));
  body.append(actions);
  li.append(body);
  return li;
}

/** Can Inline Math take this name as one variable? (`cx` reads as c times x: those knobs get a plain slider.) */
const readable = new Map();
function inlineName(name) {
  if (!readable.has(name)) {
    let ok = false;
    try { ok = markdownToHTML(`$${name} := [[0..1 step 1 = 0]]$`, { variables: false }).includes(`data-mv-var="${name}"`); } catch { /* not a name */ }
    readable.set(name, ok);
  }
  return readable.get(name);
}

/**
 * The step's page: its knobs and its notes, in order. A filter of its own defines its knobs here
 * (each line edits it) and can have more; a chain's knobs belong to its steps, so here they are only set.
 */
function stepPage(step, i) {
  const f = step.filter;
  const own = !f.steps;
  const params = own ? (f.params ?? {}) : MZ.filterParams(f);
  const store = createVariables();                                   // the step's variables: its knobs, seen by its notes
  const box = Object.assign(document.createElement('div'), { className: 'blocks' });
  const blocks = blocksOf(params, f.notes);
  const draws = [];                                                   // Inline Math draws the knobs first, so the notes see them
  const notes = [];
  const setBlocks = (next) => {
    const kept = notesOf(next);
    if (kept) f.notes = kept;
    else {
      delete f.notes;
      if (own && f.params) f.params = Object.fromEntries(next.filter((b) => typeof b === 'object').map((b) => [b.param, f.params[b.param]]));   // knobs alone: their order is the params'
    }
  };
  const tools = (k) => {
    const span = Object.assign(document.createElement('span'), { className: 'tools' });
    const up = button('↑', () => { const next = [...blocks]; [next[k - 1], next[k]] = [next[k], next[k - 1]]; setBlocks(next); rebuild(); });
    up.disabled = k === 0;
    up.title = 'move up'; up.setAttribute('aria-label', 'move up');
    span.append(up);
    return span;
  };
  blocks.forEach((block, k) => {
    if (typeof block === 'string') {
      box.append(noteBlock(step, block, k, blocks, setBlocks, store, tools(k), notes));
      return;
    }
    const name = block.param;
    const param = params[name];
    const row = Object.assign(document.createElement('div'), { className: 'block knob-block' });
    const live = Object.assign(document.createElement('div'), { className: 'live' });
    const current = liveValue(i, name, name in step.with ? step.with[name] : param.default);
    const set = (v) => { step.with[name] = v; setLive(i, name, v); };
    if (param.label) live.append(Object.assign(document.createElement('span'), { className: 'hint', textContent: param.label }));
    if (param.type === 'color') live.append(colorKnob(name, current, set));
    else if (!inlineName(name)) live.append(knob(name, current, param.min, param.max, sliderStep(param), set));
    else {
      const at = Object.assign(document.createElement('div'), { className: 'md-live' });
      live.append(at);
      draws.push(() => renderMarkdownInto(at, `$${inlineDefinition(name, { ...param, default: current })}$`, { variables: store }));
    }
    row.append(live);
    if (own) {
      const line = Object.assign(document.createElement('input'), { type: 'text', className: 'def', value: definitionOf(name, param), spellcheck: false, title: HOW });
      line.setAttribute('aria-label', `the knob ${name}, as a line`);
      const msg = Object.assign(document.createElement('div'), { className: 'block-msg', role: 'alert' });
      line.addEventListener('change', () => {
        const problem = setKnob(step, name, line.value);
        if (problem) line.setAttribute('aria-invalid', 'true'); else line.removeAttribute('aria-invalid');
        msg.textContent = problem ?? '';
      });
      const remove = button('✕', () => {
        delete f.params[name];
        if (!Object.keys(f.params).length) delete f.params;
        delete step.with[name];
        setBlocks(blocks.filter((b) => b !== block));
        rebuild();
        updateShareSoon();
      });
      remove.title = `remove the knob ${name}`; remove.setAttribute('aria-label', remove.title);
      const t = tools(k);
      t.append(remove);
      row.append(line, t, msg);
    } else {
      row.append(tools(k));
    }
    box.append(row);
  });
  for (const d of [...draws, ...notes]) d();
  store.subscribe((owner, name) => {                                  // an Inline Math input moved: the knob follows
    if (!name || !(name in params) || params[name].type === 'color') return;
    const v = numberOf(store.get(name));
    if (v !== null) { step.with[name] = v; setLive(i, name, v); }
  });

  const add = Object.assign(document.createElement('div'), { className: 'block-add' });
  add.append(Object.assign(document.createElement('span'), { className: 'hint', textContent: 'add' }));
  if (own) {
    const knobs = [['slider', { default: 0.5, min: 0, max: 1, step: 0.01 }], ['box', { default: 1, input: 'box' }],
      ['menu', { options: [1, 2, 4] }], ['colour', { type: 'color', default: [1, 0.5, 0] }]];
    for (const [label, spec] of knobs) {
      const b = button(`+ ${label}`, () => addKnob(step, spec));
      b.title = `a new knob: ${definitionOf('k', MZ.normalizeFilter({ params: { k: spec }, color: 'k' }).params.k)}`;
      add.append(b);
    }
  }
  const text = button('+ text', () => {
    const next = [...blocks, 'Write about it here: *Markdown*, with maths such as $x^2$' + (Object.keys(params).some(inlineName) ? ", and a knob's value: $" + '{{' + Object.keys(params).find(inlineName) + '}}$' : '') + '.'];
    setBlocks(next);
    openNote = { step, k: next.length - 1 };
    rebuild();
    updateShareSoon();
  });
  text.title = 'a note in Markdown, with maths drawn by Inline Math';
  add.append(text);
  box.append(add);
  return box;
}

/** A text on the step's page: drawn by Inline Math; Edit shows the Markdown. */
function noteBlock(step, text, k, blocks, setBlocks, store, tools, draws) {
  const row = Object.assign(document.createElement('div'), { className: 'block note' });
  const view = Object.assign(document.createElement('div'), { className: 'md md-live' });
  const shown = (t) => (t.trim() ? t : '*Empty: Edit to write something.*');
  draws.push(() => renderMarkdownInto(view, shown(text), { variables: store }));
  const area = Object.assign(document.createElement('textarea'), { value: text, rows: 3, spellcheck: true, hidden: true });
  area.setAttribute('aria-label', 'the note, in Markdown');
  const edit = button('Edit', () => {
    area.hidden = !area.hidden;
    edit.textContent = area.hidden ? 'Edit' : 'Done';
    if (!area.hidden) area.focus();
  });
  area.addEventListener('input', () => {
    blocks[k] = area.value;
    setBlocks(blocks);
    renderMarkdownInto(view, shown(area.value), { variables: store });
    updateShareSoon();
  });
  const remove = button('✕', () => { setBlocks(blocks.filter((_, j) => j !== k)); rebuild(); updateShareSoon(); });
  remove.title = 'remove this note'; remove.setAttribute('aria-label', remove.title);
  tools.prepend(edit);
  tools.append(remove);
  row.append(view, tools, area);
  if (openNote && openNote.step === step && openNote.k === k) {
    openNote = null;
    area.hidden = false;
    edit.textContent = 'Done';
    setTimeout(() => { area.focus(); area.select(); });
  }
  return row;
}

/** A knob's line changed: the knob is defined again (renamed in the maths too); the problem, if there is one. */
function setKnob(step, old, text) {
  const f = step.filter;
  let parsed;
  try { parsed = parseDefinition(text, f.params[old].label); } catch (e) { return e.message; }
  const { name, spec } = parsed;
  if (name !== old && (name in f.params || name in (f.images ?? {}) || name in (f.graphics ?? {}))) return `There is already something called ${name} in this filter`;
  const params = Object.fromEntries(Object.entries(f.params).map(([k, v]) => (k === old ? [name, spec] : [k, v])));
  const next = { ...f, params };
  if (f.notes) next.notes = f.notes.map((b) => (typeof b === 'object' && b.param === old ? { param: name } : b));
  if (name !== old) next.color = renameInMaths(f.color, old, name);
  try { step.filter = MZ.normalizeFilter(next); } catch (e) { return e.message; }
  delete step.with[old];                                            // the line says where it starts now
  rebuild();
  updateShareSoon();
  return null;
}

function addKnob(step, spec) {
  const f = step.filter;
  const name = freeName(new Set([...Object.keys(f.params ?? {}), ...Object.keys(f.images ?? {}), ...Object.keys(MZ.filterGraphics(f))]));
  const next = { ...f, params: { ...(f.params ?? {}), [name]: spec } };
  if (f.notes) next.notes = [...f.notes, { param: name }];
  step.filter = MZ.normalizeFilter(next);
  rebuild();
  updateShareSoon();
  toast(`${name} is a new knob: use it in the maths, e.g. ${spec.type === 'color' ? `mix(rgb, ${name}, 0.5)` : `rgb * ${name}`}`);
}

// Opacity is a uniform, so unless the chain's shape changes (a chain step crossing 1 → less
// than 1 needs a blend pass) the new values go straight to the live passes.
function setOpacity(step, value) {
  step.opacity = value;
  let fresh = null;
  try { fresh = MZ.compileFilter(chain, { version: WEBGL2 ? 300 : 100 }); } catch { /* recompile reports it */ }
  const same = fresh && compiled && fresh.passes.length === compiled.passes.length && fresh.passes.every((p, k) => p.fragment === compiled.passes[k].fragment);
  if (!same) { recompile(); updateShareSoon(); return; }
  fresh.passes.forEach((p, k) => { compiled.passes[k].opacity = p.opacity; });
  draw();
  updateShareSoon();
}

let dragging = null;     // the index of the step being dragged
function moveStep(from, to) {
  const [step] = chain.steps.splice(from, 1);
  chain.steps.splice(to, 0, step);
  rebuild();
}

function act(kind, i) {
  const steps = chain.steps;
  if (kind === 'remove') steps.splice(i, 1);
  if (kind === 'up' && i > 0) [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
  if (kind === 'down' && i < steps.length - 1) [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]];
  rebuild();
}

function knob(label, value, min, max, step, onInput) {
  const div = document.createElement('div');
  div.className = 'knob';
  div.innerHTML = `<label>${esc(label)}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${esc(label)}"><output>${trim(value)}</output>`;
  const input = div.querySelector('input');
  input.addEventListener('input', () => { div.querySelector('output').textContent = trim(input.value); onInput(Number(input.value)); });
  return div;
}

function colorKnob(label, value, onInput) {
  const div = document.createElement('div');
  div.className = 'knob';
  div.innerHTML = `<label>${esc(label)}</label><input type="color" value="${toHex(value)}" aria-label="${esc(label)}"><output>${toHex(value)}</output>`;
  const input = div.querySelector('input');
  input.addEventListener('input', () => { div.querySelector('output').textContent = input.value; onInput(fromHex(input.value)); });
  return div;
}

// ---- sharing and saving ------------------------------------------------------
// A link carries the whole filter (in the address after #): whoever opens it gets every step to
// change, and Save keeps their version — a fork — in their browser.
function shareable() {
  const def = { ...chain, name: $('name').value.trim(), author: $('author').value.trim() };
  if (!def.name) delete def.name;
  if (!def.author) delete def.author;
  return def;
}

function updateShare() {
  if (!chain.steps.length) { $('json').value = ''; history.replaceState(null, '', location.pathname + location.search); return; }
  const def = shareable();
  $('json').value = MZ.filterToJSON(def);
  history.replaceState(null, '', MZ.filterToLink(def, base()));
}
let shareTimer = null;
function updateShareSoon() { clearTimeout(shareTimer); shareTimer = setTimeout(updateShare, 150); }

// a confirmation is a toast (shioh.js); the message line keeps what needs the user's hand
const toast = (text) => (window.ssToast ? window.ssToast(text) : ($('share-msg').textContent = text, setTimeout(() => { $('share-msg').textContent = ''; }, 2500)));
const ask = (message, opts) => (window.ssConfirm ? window.ssConfirm(message, opts) : Promise.resolve(confirm(message)));
async function copy(text, message = 'Copied') {
  try { await navigator.clipboard.writeText(text); $('share-msg').textContent = ''; toast(message); }
  catch { $('share-section').open = true; $('json').value = text; $('json').select(); $('share-msg').textContent = 'Select and copy the text below'; }
}

function loadChain(def) {
  const f = MZ.normalizeFilter(def);
  chain = f.steps ? f : { format: MZ.FILTER_FORMAT, steps: [{ filter: f, with: {}, opacity: 1 }] };
  $('name').value = chain.name || '';
  $('author').value = chain.author || '';
  $('fork-note').hidden = true;
  rebuild();
}

/** Keep a filter in this browser (localStorage): one of the same name and author is replaced. `nameBox` is where to ask for a name. */
function saveFilter(def, nameBox) {
  if (!def.name) { $('share-msg').textContent = 'Give it a name first'; nameBox.focus(); return; }
  const list = saved();
  const kept = JSON.parse(MZ.filterToJSON(def));
  const at = list.findIndex((d) => d.name === kept.name && (d.author ?? '') === (kept.author ?? ''));
  if (at >= 0) list[at] = kept; else list.push(kept);
  try { store(list); } catch (e) { $('share-msg').textContent = `Could not save: ${e.message}`; return; }
  renderSaved();
  $('share-msg').textContent = '';
  toast(`${at >= 0 ? 'Updated' : 'Saved'} "${kept.name}" — it is under Your saved filters`);
}

/** One line: a filter's name and what it does, and its buttons. */
function filterRow(def, extra, buttons) {
  const li = document.createElement('li');
  const what = Object.assign(document.createElement('span'), { className: 'what' });
  what.innerHTML = `<b>${esc(def.name ?? 'unnamed')}</b>${extra ? `<span class="hint">${esc(extra)}</span>` : ''}`;
  if (def.description) what.title = def.description;
  li.append(what, ...buttons);
  return li;
}

/** The filters saved in this browser: open one (in place of what is here), add it as a step, share it, or delete it. */
function renderSaved() {
  const box = $('saved');
  box.textContent = '';
  const list = saved();
  if (!list.length) {
    box.append(Object.assign(document.createElement('li'), { className: 'hint', textContent: 'Nothing saved yet. Name your filter (or one step) and press Save: it stays in this browser.' }));
    return;
  }
  list.forEach((def, index) => {
    const steps = Array.isArray(def.steps) ? `${def.steps.length} step${def.steps.length > 1 ? 's' : ''}` : '';
    const extra = [def.author ? `by ${def.author}` : '', steps, def.description ?? ''].filter(Boolean).join(' · ');
    box.append(filterRow(def, extra, [
      button('Open', async () => {
        if (chain.steps.length && !(await ask(`Open "${def.name}" in place of the filter you have? (Save that first to keep it.)`, { title: 'Open a saved filter', ok: 'Open' }))) return;
        try { loadChain(def); } catch (e) { showError(e.message); }
      }),
      button('Add', () => { try { addStep(def); } catch (e) { showError(e.message); } }),
      button('Copy link', () => copy(MZ.filterToLink(def, base()), `Link to "${def.name}" copied`)),
      button('Delete', async () => {
        if (!(await ask(`Delete "${def.name}" from this browser?`, { title: 'Delete a saved filter', ok: 'Delete' }))) return;
        const now = saved();
        now.splice(index, 1);
        store(now);
        renderSaved();
      }),
    ]));
  });
}

/** Opened from a link: say whose it is, and that it is the user's to change. */
function showForkNote(def) {
  const box = $('fork-note');
  const whose = def.name ? `“${def.name}”${def.author ? ` by ${def.author}` : ''}` : 'This filter';
  box.textContent = `${whose} came from a link. It is yours to change: edit any step, then Save to keep your version here, or Copy link to share it.`;
  box.hidden = false;
}

// The library: a group per fold, a line per filter, narrowed by the search box (name, description,
// group, or the maths itself). A search opens every group with something in it.
const openGroups = new Set();
function renderLibrary() {
  const box = $('library');
  box.textContent = '';
  const query = $('search').value.trim().toLowerCase();
  const text = (def) => [def.name, def.description, def.group, JSON.stringify(def.color ?? def.steps ?? '')].join(' ').toLowerCase();
  $('library-count').textContent = `— ${BUILTIN.length} filters`;
  let count = 0;
  for (const group of MZ.GROUPS) {
    const members = BUILTIN.filter((def) => def.group === group && (!query || text(def).includes(query)));
    if (!members.length) continue;
    const fold = Object.assign(document.createElement('details'), { className: 'lib-group', open: Boolean(query) || openGroups.has(group) });
    fold.dataset.group = group;
    fold.innerHTML = `<summary>${esc(group)}<span class="hint">${members.length}</span></summary>`;
    fold.addEventListener('toggle', () => { if (!query) { if (fold.open) openGroups.add(group); else openGroups.delete(group); } });
    const list = Object.assign(document.createElement('ul'), { className: 'rows' });
    for (const def of members) {
      count++;
      list.append(filterRow(def, `${def.steps ? 'chain · ' : ''}${def.description ?? ''}`, [
        button('Add', () => addStep(def)),
        button('Copy link', () => copy(MZ.filterToLink(def, base()), `Link to "${def.name}" copied`)),
      ]));
    }
    fold.append(list);
    box.append(fold);
  }
  if (!count) box.append(Object.assign(document.createElement('div'), { className: 'hint', textContent: `Nothing in the library matches "${query}"` }));
}
$('search').addEventListener('input', renderLibrary);
const button = (text, onClick) => Object.assign(document.createElement('button'), { textContent: text, onclick: onClick });

$('add-expr').onclick = () => {
  if (!$('expr').value.trim()) return;
  const space = $('expr-space').value;
  try { addStep(space === 'srgb' ? $('expr').value : { color: $('expr').value, space }); editing.add(chain.steps.at(-1)); renderSteps(); } catch (e) { showError(e.message); return; }
  $('expr').value = '';
  $('steps').lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};
$('expr').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('add-expr').onclick(); });
$('copy-link').onclick = () => copy(MZ.filterToLink(shareable(), base()), 'Link copied — whoever opens it can change it and keep their own');
$('copy-json').onclick = () => copy(MZ.filterToJSON(shareable()), 'JSON copied');
$('save').onclick = () => { if (chain.steps.length) saveFilter(shareable(), $('name')); };
for (const id of ['name', 'author']) $(id).addEventListener('input', updateShareSoon);
$('do-import').onclick = () => {
  try {
    const def = MZ.readFilter($('import').value);
    const problems = MZ.validateFilter(def);
    if (problems.length) throw new Error(problems.join('\n'));
    addStep(def);
    $('import-msg').textContent = def.name ? `Added "${def.name}"${def.author ? ' by ' + def.author : ''} as a step` : 'Added as a step';
    $('import').value = '';
  } catch (e) {
    const { text, hint } = explain(e.message);
    $('import-msg').textContent = hint ? `${text} — ${hint}` : text;
  }
};

// ---- the picture, and t ----------------------------------------------------
function drawTestPicture(ctx, w, h) {
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#2a6fdb'); grad.addColorStop(0.5, '#f5d547'); grad.addColorStop(1, '#8e3bbf');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#39b54a'; ctx.fillRect(w * 0.55, h * 0.1, w * 0.35, h * 0.35);
  ctx.fillStyle = '#e03a3a'; ctx.beginPath(); ctx.arc(w * 0.3, h * 0.6, h * 0.25, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#222';
  for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) if ((i + j) % 2 === 0) ctx.fillRect(w * 0.6 + i * 16, h * 0.65 + j * 16, 16, 16);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 28px sans-serif'; ctx.fillText('MathZetta', 12, 36);
}

function fit(w, h) {
  const scale = Math.min(1, 480 / w, 360 / h);
  for (const id of ['source', 'out', 'outCpu']) { $(id).width = Math.round(w * scale); $(id).height = Math.round(h * scale); }
  if (typeof selection !== 'undefined') { selection.reset($('source').width, $('source').height); bindSelection(); }
  if (typeof ai !== 'undefined') { ai.invalidate(); aiBoxes = []; }
  if (typeof resetTrack !== 'undefined') resetTrack();
}

/** The picture drawn at any size: the preview, or the full size for export. */
function drawMedia(ctx, w, h) {
  if (media.kind === 'test') {
    ctx.save();
    ctx.scale(w / 320, h / 240);
    drawTestPicture(ctx, 320, 240);
    ctx.restore();
  } else {
    ctx.drawImage(media.source, 0, 0, w, h);
  }
}

function showPicture() {
  if (typeof updateMoving !== 'undefined') updateMoving();
  const src = $('source');
  drawMedia(src.getContext('2d'), src.width, src.height);
  if (runner) runner.setImage(src);
  repaintCopies();
  draw();
  if (typeof exporter !== 'undefined') exporter.pictureChanged();
  if (typeof selection !== 'undefined') selection.pictureChanged();
  if (typeof trackFrameShown !== 'undefined') trackFrameShown();
}

let gifTimer = null;
function stopMedia() {
  if (video) { video.pause(); video = null; }
  clearTimeout(gifTimer);
  gifTimer = null;
}
const stopVideo = stopMedia;

/** An animated GIF plays frame by frame at its own delays; t is the frame index. */
function playGif(gif, from = 0) {
  stopMedia();
  $('file').value = '';
  const frame = document.createElement('canvas');
  frame.width = gif.width;
  frame.height = gif.height;
  const ctx = frame.getContext('2d');
  media = { kind: 'gif', source: frame, width: gif.width, height: gif.height, gif, index: from };
  fit(gif.width, gif.height);
  $('credit').textContent = `GIF: ${gif.frames.length} frames`;
  const step = () => {
    if (media.gif !== gif) return;
    ctx.putImageData(new ImageData(gif.frames[media.index].data, gif.width, gif.height), 0, 0);
    showPicture();
    syncT(media.index);
    gifTimer = setTimeout(() => { media.index = (media.index + 1) % gif.frames.length; step(); }, gif.frames[media.index].delay);
  };
  step();
}

function testPicture() {
  stopVideo();
  media = { kind: 'test', source: null, width: 320, height: 240 };
  fit(320, 240);
  showPicture();
  $('photo').value = 'test';
  $('credit').textContent = '';
}

// Photos listed in photos/index.json (see demo/photos/README.md) go in the chooser; the first is
// what the page opens on. ?picture=test (or a number) chooses; the checkers use the test picture.
let photos = [];
async function loadPhotos() {
  try {
    const response = await fetch('photos/index.json', { cache: 'no-store' });
    if (response.ok) photos = await response.json();
  } catch { photos = []; }
  if (!Array.isArray(photos) || !photos.length) { photos = []; return; }
  const chooser = $('photo');
  chooser.hidden = false;
  chooser.append(new Option('test picture', 'test'), ...photos.map((p, i) => new Option((p.title || p.file) + (/\.(mp4|webm|mov)$/i.test(p.file) ? ' (video)' : ''), String(i))));
  chooser.onchange = () => (chooser.value === 'test' ? testPicture() : showPhoto(Number(chooser.value)));
  const wanted = QUERY.get('picture');
  if (wanted !== 'test') await showPhoto(Math.min(photos.length - 1, Math.max(0, Number(wanted) || 0)));
}

/** A video plays muted and looped; t counts its frames. */
async function playVideo(url) {
  stopVideo();
  const v = Object.assign(document.createElement('video'), { src: url, muted: true, loop: true, playsInline: true, crossOrigin: 'anonymous' });
  await new Promise((resolve, reject) => { v.onloadedmetadata = resolve; v.onerror = () => reject(new Error(`Could not play ${url}`)); });
  video = v;
  media = { kind: 'video', source: v, width: v.videoWidth, height: v.videoHeight };
  fit(v.videoWidth, v.videoHeight);
  currentT = 0;
  const onFrame = () => {                        // t counts the video's frames
    if (video !== v) return;
    showPicture();
    syncT(currentT + 1);
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame); else requestAnimationFrame(onFrame);
  };
  await v.play();
  onFrame();
}

async function showPhoto(index) {
  const photo = photos[index];
  if (/\.(mp4|webm|mov)$/i.test(photo.file)) {
    // Held in memory (they are small): then seeking works whatever the server — tracking and pausing on a frame need it.
    try {
      const response = await fetch(`photos/${photo.file}`);
      if (!response.ok) throw new Error(`Could not load photos/${photo.file}`);
      await playVideo(URL.createObjectURL(await response.blob()));
    } catch (e) { showError(e.message); return; }
    $('file').value = '';
    $('photo').value = String(index);
    showCredit(photo.credit || '');
    return;
  }
  const img = new Image();
  img.src = `photos/${photo.file}`;
  try { await img.decode(); } catch { showError(`Could not load photos/${photo.file}`); return; }
  stopVideo();
  $('file').value = '';
  media = { kind: 'image', source: img, width: img.naturalWidth, height: img.naturalHeight };
  fit(img.naturalWidth, img.naturalHeight);
  showPicture();
  $('photo').value = String(index);
  showCredit(photo.credit || '');
}

/** A credit line with [text](https://…) links — Unsplash and Pexels ask for them — rendered safely. */
function showCredit(credit) {
  const box = $('credit');
  box.textContent = '';
  for (const part of String(credit).split(/(\[[^\]]+\]\(https?:\/\/[^)\s]+\))/)) {
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
    if (link) box.append(Object.assign(document.createElement('a'), { textContent: link[1], href: link[2], target: '_blank', rel: 'noopener' }));
    else if (part) box.append(part);
  }
}

$('test-picture').onclick = testPicture;
$('file').onchange = async () => {
  const file = $('file').files[0];
  if (!file) return;
  stopVideo();
  if (file.type === 'image/gif' || /\.gif$/i.test(file.name)) {
    try { playGif(decodeGif(await file.arrayBuffer())); } catch (e) { showError(`Could not read the GIF: ${e.message}`); }
    return;
  }
  const url = URL.createObjectURL(file);
  if (file.type.startsWith('video/')) {
    await playVideo(url);
  } else {
    const img = new Image();
    img.src = url;
    await img.decode();
    media = { kind: 'image', source: img, width: img.naturalWidth, height: img.naturalHeight };
    fit(img.naturalWidth, img.naturalHeight);
    showPicture();
    $('credit').textContent = '';
  }
};

function syncT(value) {
  currentT = value;
  $('t').value = value % 241;
  $('tval').textContent = value;
  draw();
}
$('t').addEventListener('input', () => syncT(Number($('t').value)));

// ---- export ------------------------------------------------------------------
function download(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
/**
 * The filter on the picture at any size (the preview is at most 480 × 360),
 * within what the GPU can draw, as a 2D canvas. Effects measured in pixels —
 * blur radii, px — are the same number of pixels, so they look finer on a
 * big picture.
 */
async function renderFrame(width, height) {
  if (!runner) throw new Error('Nothing to draw yet');
  const limit = engine === 'gpu' ? Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), 4096) : 4096;
  const w = Math.min(limit, width), h = Math.min(limit, height);
  await new Promise((r) => setTimeout(r, 0));
  const full = document.createElement('canvas');
  full.width = w; full.height = h;
  drawMedia(full.getContext('2d'), w, h);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  if (selectionActive()) runner.setImage('selection', currentSelectionCanvas(w, h));
  await bindGraphics(w, h, false);                              // text and shapes drawn again at this size: crisp
  updateStrokes(w, h);                                           // and brush strokes, as at this frame
  try {
    if (engine === 'cpu') {
      runner.setImage(full);
      await runner.drawAsync({ t: currentT, canvas: out });
    } else {
      const canvas = $('out');
      const preview = [canvas.width, canvas.height];
      canvas.width = w; canvas.height = h;                       // the runner draws at the canvas's size
      runner.setImage(full);
      runner.draw({ t: currentT });
      out.getContext('2d').drawImage(canvas, 0, 0);
      [canvas.width, canvas.height] = preview;
    }
  } finally {
    runner.setImage($('source'));
    if (selectionActive()) runner.setImage('selection', currentSelectionCanvas($('source').width, $('source').height));
    await bindGraphics(undefined, undefined, false);
    draw();
  }
  return out;
}

// ---- text and shapes ---------------------------------------------------------
/** Draws every graphic of the filter at w × h (the preview by default) and gives them to the runner. */
let graphicsTurn = 0;
async function bindGraphics(w = $('source').width, h = $('source').height, redraw = true) {
  if (!runner || !compiled || !Object.keys(compiled.graphics ?? {}).length) return;
  const turn = ++graphicsTurn;
  const canvases = await MZ.renderGraphics(compiled, w, h);
  if (turn !== graphicsTurn && redraw) return;                  // a newer edit is already drawing
  for (const el of document.querySelectorAll('.font-status')) {
    const url = el.dataset.url;
    if (!url) continue;
    el.textContent = canvases.failedFonts.includes(url)
      ? `Could not load that font — check the name or address; the text uses ${el.dataset.fallback} meanwhile.`
      : `Using ${MZ.googleFontFamily(url) ? `"${MZ.googleFontFamily(url)}" from Google Fonts` : 'the font from that address'}.`;
  }
  for (const [name, canvas] of Object.entries(canvases)) runner.setImage(name, canvas);
  if (redraw) draw();
}

/** The graphic as drawn now: as compiled (with the settings of any chain inside the step), else its spec with this step's settings. */
function graphicNow(i, name, base) {
  const pass = compiled?.passes.find((p) => p.path[0] === i && p.graphics?.[name]);
  return pass ? pass.graphics[name] : MZ.normalizeGraphic(name, { ...base, ...(chain.steps[i].with[name] ?? {}) });
}

/** Change a graphic: kept in the step's `with`, so it is shared; no recompiling — only its picture is drawn again. */
function setGraphic(i, name, base, changes) {
  const step = chain.steps[i];
  const next = { ...(step.with[name] ?? {}), ...changes };            // the step's own settings win over any inside it, so this is what gets shared
  let spec;
  try { spec = MZ.normalizeGraphic(name, { ...graphicNow(i, name, base), ...changes }); } catch (e) { showError(e.message); return; }
  showError('');
  const before = graphicNow(i, name, base);
  step.with[name] = next;
  if (spec.shadows.length !== before.shadows.length) {
    // More or fewer shadow layers: new pictures, so the shaders change. Maths still laying the graphic on
    // the default way is kept in step with them; maths of one's own is left alone (the panel says what to add).
    const f = step.filter;
    if (typeof f.color === 'string' && f.color.replace(/\s+/g, '') === MZ.layeredExpression(name, before).replace(/\s+/g, '')) f.color = MZ.layeredExpression(name, spec);
    rebuild();
    updateShareSoon();
    return;
  }
  if (compiled) {
    for (const pass of compiled.passes) {
      if (pass.path[0] !== i || !pass.graphics?.[name]) continue;
      pass.graphics[name] = spec;
      compiled.graphics[pass.bind[name]] = spec;                 // its own picture: other steps' `title`s are untouched
      MZ.shadowLayerNames(name, spec).forEach((layer, k) => {    // and each shadow layer's picture
        pass.graphics[layer] = { ...spec, onlyShadow: k };
        compiled.graphics[pass.bind[layer]] = pass.graphics[layer];
      });
    }
  }
  bindGraphics();
  updateShareSoon();
}

const FAMILIES = ['sans-serif', 'serif', 'monospace', 'system-ui', 'Georgia, serif', 'Impact, Haettenschweiler, sans-serif', 'Trebuchet MS, sans-serif',
  'Courier New, monospace', 'Palatino, serif', 'Comic Sans MS, cursive', 'Brush Script MT, cursive'];
const localFonts = [];                                           // families loaded from files: on this computer only

function graphicControls(i, name, base) {
  const g = graphicNow(i, name, base);
  const box = document.createElement('div');
  box.className = 'graphic';
  const set = (changes) => setGraphic(i, name, base, changes);
  const row = () => Object.assign(document.createElement('div'), { className: 'row2' });
  const head = row();
  head.append(Object.assign(document.createElement('b'), { textContent: name }), ` ${{ text: 'text', rect: 'rectangle', ellipse: 'oval', strokes: 'brush' }[g.type] ?? 'shape'}`);
  box.append(head);
  if (g.type === 'strokes') return brushControls(i, name, base, g, set, box);
  if (g.type === 'text') {
    const words = Object.assign(document.createElement('textarea'), { value: g.text, rows: 1 });
    words.addEventListener('input', () => set({ text: words.value }));
    box.append(words);
    box.append(fontControls(g, set));
    const style = row();
    const bold = Object.assign(document.createElement('input'), { type: 'checkbox', checked: g.weight === 'bold' || Number(g.weight) >= 600 });
    bold.onchange = () => set({ weight: bold.checked ? 'bold' : 'normal' });
    const italic = Object.assign(document.createElement('input'), { type: 'checkbox', checked: g.style === 'italic' });
    italic.onchange = () => set({ style: italic.checked ? 'italic' : 'normal' });
    const align = document.createElement('select');
    for (const a of ['left', 'center', 'right']) align.append(new Option(a, a, false, a === g.align));
    align.onchange = () => set({ align: align.value });
    const label = (input, text) => { const l = document.createElement('label'); l.append(input, ` ${text}`); return l; };
    style.append(label(bold, 'bold'), label(italic, 'italic'), label(align, 'align'));
    box.append(style);
    box.append(knob('size', g.size, 0.01, 0.4, 0.002, (v) => set({ size: v })));
  } else {
    box.append(knob('width', g.w, 0, 1.5, 0.005, (v) => set({ w: v })));
    box.append(knob('height', g.h, 0, 1.5, 0.005, (v) => set({ h: v })));
    if (g.type === 'rect') box.append(knob('corners', g.radius, 0, 0.5, 0.01, (v) => set({ radius: v })));
  }
  box.append(knob('x', g.x, -0.2, 1.2, 0.002, (v) => set({ x: v })));
  box.append(knob('y', g.y, -0.2, 1.2, 0.002, (v) => set({ y: v })));
  box.append(knob('angle', g.angle, -3.14, 3.14, 0.01, (v) => set({ angle: v })));
  const looks = row();
  const colour = Object.assign(document.createElement('input'), { type: 'color', value: cssToHex(g.color) });
  colour.oninput = () => set({ color: colour.value });
  const shadowOn = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(g.shadow) });
  const shadowColour = Object.assign(document.createElement('input'), { type: 'color', value: cssToHex(g.shadow?.color ?? '#000000') });
  const shadow = () => (shadowOn.checked ? { ...(g.shadow ?? { blur: 0.15, dx: 0.04, dy: 0.06 }), color: hexAlpha(shadowColour.value, 0.7) } : null);
  shadowOn.onchange = () => set({ shadow: shadow() });
  shadowColour.oninput = () => { shadowOn.checked = true; set({ shadow: shadow() }); };
  const outlineOn = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(g.outline) });
  const outlineColour = Object.assign(document.createElement('input'), { type: 'color', value: cssToHex(g.outline?.color ?? '#000000') });
  const outline = () => (outlineOn.checked ? { width: g.outline?.width ?? 0.06, color: outlineColour.value } : null);
  outlineOn.onchange = () => set({ outline: outline() });
  outlineColour.oninput = () => { outlineOn.checked = true; set({ outline: outline() }); };
  looks.append('colour', colour, outlineOn, 'outline', outlineColour, shadowOn, 'shadow, drawn in', shadowColour);
  box.append(looks);
  if (g.shadow) box.append(knob('shadow blur', g.shadow.blur, 0, 1, 0.01, (v) => set({ shadow: { ...graphicNow(i, name, base).shadow, blur: v } })));
  box.append(shadowLayerControls(i, name, base, g, set));
  return box;
}

/**
 * Shadow layers: each a picture of its own (title_shadow1, title_shadow2… back to front),
 * so the maths can give each its own filter. The controls set how each is cast.
 */
function shadowLayerControls(i, name, base, g, set) {
  const box = document.createElement('div');
  const head = Object.assign(document.createElement('div'), { className: 'row2' });
  const add = button('+ shadow layer', () => set({ shadows: [...g.shadows, { color: 'rgba(0,0,0,0.7)', blur: 0.3, dx: 0.05, dy: 0.08 }] }));
  add.disabled = g.shadows.length >= MZ.MAX_SHADOW_LAYERS;
  head.append(Object.assign(document.createElement('b'), { textContent: 'shadow layers' }), add);
  box.append(head);
  const names = MZ.shadowLayerNames(name, g);
  const maths = String(chain.steps[i].filter.color ?? '');
  g.shadows.forEach((layer, k) => {
    const change = (changes) => set({ shadows: g.shadows.map((l, j) => (j === k ? { ...l, ...changes } : l)) });
    const line = Object.assign(document.createElement('div'), { className: 'row2' });
    const c = Object.assign(document.createElement('input'), { type: 'color', value: cssToHex(layer.color) });
    c.oninput = () => change({ color: hexAlpha(c.value, 0.8) });
    line.append(Object.assign(document.createElement('code'), { textContent: names[k] }), c,
      button('remove', () => set({ shadows: g.shadows.filter((_, j) => j !== k) })));
    if (!new RegExp(`\\b${names[k]}\\b`).test(maths)) line.append(Object.assign(document.createElement('span'), { className: 'hint', textContent: ` — not in the maths yet: add mix(…, ${names[k]}, alpha(${names[k]}))` }));
    box.append(line);
    box.append(knob('blur', layer.blur, 0, 2, 0.01, (v) => change({ blur: v })));
    box.append(knob('across', layer.dx, -1, 1, 0.005, (v) => change({ dx: v })));
    box.append(knob('down', layer.dy, -1, 1, 0.005, (v) => change({ dy: v })));
  });
  if (g.shadows.length) {
    box.append(Object.assign(document.createElement('div'), { className: 'hint',
      textContent: `Each layer is a picture of that shadow alone, back to front, so the maths can treat it on its own — e.g. mix(rgb, gaussian(4), alpha(${names[0]})) blurs the picture under it, mix(rgb, (1, 0.2, 0.6), alpha(${names[0]})) colours it, shift(${names[0]}, 2 sin(t / 9), 0) moves it.` }));
  }
  return box;
}

/**
 * The font: one on every computer, a Google Fonts name, a font file from this computer
 * (here only), or the web address of a font file — and whether it loaded.
 */
function fontControls(g, set) {
  const box = document.createElement('div');
  const line = Object.assign(document.createElement('div'), { className: 'row2' });
  line.append(Object.assign(document.createElement('b'), { textContent: 'font' }));
  const family = document.createElement('select');
  const group = (label, list) => {
    if (!list.length) return;
    const og = Object.assign(document.createElement('optgroup'), { label });
    for (const f of list) {
      const o = new Option(f.split(',')[0].replace(/"/g, ''), f, false, !g.fontUrl && f === g.font);
      o.style.fontFamily = f;
      og.append(o);
    }
    family.append(og);
  };
  const google = g.fontUrl ? MZ.googleFontFamily(g.fontUrl) : null;
  if (g.fontUrl) family.append(new Option(google ? `${google} (Google Fonts)` : 'from a web address', '', false, true));
  group('On every computer', FAMILIES.filter((f) => f !== g.font || !g.fontUrl));
  group('Loaded from a file (this computer only)', localFonts);
  if (!g.fontUrl && !FAMILIES.includes(g.font) && !localFonts.includes(g.font)) family.append(new Option(g.font, g.font, false, true));
  family.onchange = () => { if (family.value) set({ font: family.value, fontUrl: null }); };
  line.append(family);
  box.append(line);

  const more = Object.assign(document.createElement('div'), { className: 'row2' });
  const googleName = Object.assign(document.createElement('input'), { type: 'text', placeholder: 'a Google Fonts name, e.g. Lobster', value: google ?? '', size: 22 });
  const useGoogle = () => {
    if (!googleName.value.trim()) return;
    try { set({ fontUrl: MZ.googleFontUrl(googleName.value) }); } catch (e) { showError(e.message); }
  };
  googleName.addEventListener('keydown', (e) => { if (e.key === 'Enter') useGoogle(); });
  const file = Object.assign(document.createElement('input'), { type: 'file', accept: '.woff2,.woff,.ttf,.otf', hidden: true });
  file.onchange = async () => { const family = await loadFontFile(file.files[0]); if (family) set({ font: family, fontUrl: null }); };
  more.append(googleName, button('use', useGoogle), 'or', button('a font file…', () => file.click()), file);
  box.append(more);

  const address = Object.assign(document.createElement('details'));
  address.append(Object.assign(document.createElement('summary'), { className: 'hint', textContent: 'or a font file\'s web address' }));
  const url = Object.assign(document.createElement('input'), { type: 'text', placeholder: 'https://…/font.woff2', value: g.fontUrl && !google ? g.fontUrl : '', size: 34 });
  url.onchange = () => set({ fontUrl: url.value.trim() || null });
  address.append(url);
  if (g.fontUrl && !google) address.open = true;
  box.append(address);

  const status = Object.assign(document.createElement('div'), { className: 'hint font-status' });
  status.dataset.url = g.fontUrl ?? '';
  status.dataset.fallback = g.font.split(',')[0];
  status.textContent = g.fontUrl ? 'Loading the font…' : localFonts.includes(g.font) ? 'A font from a file on this computer: a share link will show another font instead (use a Google Fonts name or a web address to share it).' : '';
  box.append(status);
  return box;
}

/** CSS colour → #rrggbb for <input type=color> (the browser does the parsing). */
function cssToHex(css) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = '#000';
  c.fillStyle = css;
  const v = c.fillStyle;
  if (v.startsWith('#')) return v.slice(0, 7);
  const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(v);
  return m ? '#' + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('') : '#000000';
}
const hexAlpha = (hex, a) => `rgba(${[1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)).join(',')},${a})`;

/** New text or shapes: a step of their own, whose maths lays them on (and can be edited like any expression). */
function newName(prefix) {
  const taken = new Set(Object.keys(compiled?.graphics ?? {}));
  for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
}
$('add-text').onclick = () => { const n = newName('text'); addStep({ graphics: { [n]: { type: 'text', text: 'Your words', y: 0.5 } }, color: `mix(rgb, ${n}, alpha(${n}))` }); };
$('add-rect').onclick = () => { const n = newName('box'); addStep({ graphics: { [n]: { type: 'rect', y: 0.5, w: 0.5, h: 0.25, color: '#ffffff' } }, color: `mix(rgb, mix(rgb, ${n}, 0.6), alpha(${n}))` }); };
$('add-oval').onclick = () => { const n = newName('oval'); addStep({ graphics: { [n]: { type: 'ellipse', y: 0.5, w: 0.35, h: 0.35, color: '#ffffff' } }, color: `mix(rgb, mix(rgb, ${n}, 0.6), alpha(${n}))` }); };

// A font file from this computer: usable straight away, but a share link can't carry it (use a font URL for that).
async function loadFontFile(file) {
  if (!file) return null;
  const family = file.name.replace(/\.[^.]+$/, '').replace(/[^\w\s-]/g, ' ').trim() || 'My font';
  try {
    const face = new FontFace(family, await file.arrayBuffer());
    document.fonts.add(await face.load());
    if (!localFonts.includes(family)) localFonts.push(family);
    $('font-msg').textContent = `"${family}" is in every font list now — on this computer only; to share a font, use a Google Fonts name or a web address.`;
    renderSteps();
    return family;
  } catch (e) {
    $('font-msg').textContent = `Could not read that font file: ${e.message}`;
    return null;
  }
}
$('font-file').onchange = () => loadFontFile($('font-file').files[0]);

// Drag a graphic on the picture to move it: the one whose centre is nearest the pointer.
{
  let moving = null;
  const frac = (e) => { const r = $('source').getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  const nearest = ([x, y]) => {
    let best = null, bestD = 0.2;
    chain.steps.forEach((step, i) => {
      for (const [name, base] of Object.entries(MZ.filterGraphics(step.filter))) {
        const g = graphicNow(i, name, base);
        const d = Math.hypot(g.x - x, g.y - y);
        if (d < bestD) { bestD = d; best = { i, name, base, dx: g.x - x, dy: g.y - y }; }
      }
    });
    return best;
  };
  $('input').addEventListener('pointerdown', (e) => {
    if (selection.state.mode !== 'off' || e.button !== 0 || brushTarget) return;   // painting takes the picture when a brush is drawing
    moving = nearest(frac(e));
    if (!moving) return;
    $('input').setPointerCapture(e.pointerId);
    $('input').classList.add('moving');
    e.preventDefault();
  });
  $('input').addEventListener('pointermove', (e) => {
    if (!moving) return;
    const [x, y] = frac(e);
    setGraphic(moving.i, moving.name, moving.base, { x: +(x + moving.dx).toFixed(4), y: +(y + moving.dy).toFixed(4) });
  });
  $('input').addEventListener('pointerup', () => { if (moving) { moving = null; $('input').classList.remove('moving'); renderSteps(); } });
}

// ---- examples: a guided tour --------------------------------------------------
/** `code` in an explanation becomes <code>; everything else is text. */
function withCode(text) {
  const span = document.createElement('span');
  text.split(/`([^`]+)`/).forEach((part, k) => span.append(k % 2 ? Object.assign(document.createElement('code'), { textContent: part }) : part));
  return span;
}
function renderExamples() {
  const list = $('example-list');
  list.textContent = '';
  for (const example of EXAMPLES) {
    const b = button(example.title, () => showExample(example));
    b.dataset.id = example.id;
    list.append(b);
  }
}
async function showExample(example) {
  for (const b of $('example-list').children) b.classList.toggle('on', b.dataset.id === example.id);
  const index = photos.findIndex((p) => p.file === example.picture);
  if (example.picture === 'test' || !photos.length) testPicture();
  else await showPhoto(Math.max(0, index));
  loadChain(resolveExample(example, BUILTIN));
  currentT = 0;
  const box = $('example-how');
  box.hidden = false;
  box.textContent = '';
  box.append(Object.assign(document.createElement('h3'), { textContent: example.title }));
  const tags = document.createElement('div');
  for (const s of example.shows) tags.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: s }));
  box.append(tags);
  const steps = document.createElement('ol');
  for (const line of example.how) { const li = document.createElement('li'); li.append(withCode(line)); steps.append(li); }
  box.append(steps);
  box.append(Object.assign(document.createElement('div'), { className: 'hint', textContent: 'The maths is in the steps below — change any of it and the picture follows. "How to write a filter" lists everything you can use.' }));
  await bindGraphics();
}

// ---- brushes: strokes painted on the picture ----------------------------------
let brushTarget = null;                  // { i, name } of the brush that paints when the picture is dragged
let liveStroke = null;                   // the stroke being drawn: { key, points, t0 }
let selectionVersion = 0;
const maskCache = { key: '', mask: null };

/** The selection as a w × h Float32Array 0–1, for brushes that stay inside (or outside) it. */
function selectionMask(w, h) {
  if (!selectionActive()) return null;
  const key = `${w}x${h}:${selectionVersion}`;
  if (maskCache.key !== key) {
    const d = currentSelectionCanvas(w, h).getContext('2d').getImageData(0, 0, w, h).data;
    const m = new Float32Array(w * h);
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4] / 255;
    maskCache.key = key;
    maskCache.mask = m;
  }
  return maskCache.mask;
}

/**
 * Brush strokes are drawn again for every frame: only the paint laid down by frame t shows.
 * While a brush is drawing, they are shown finished, so the painter sees what they paint.
 */
function updateStrokes(w = $('source').width, h = $('source').height, t = brushTarget ? Infinity : currentT) {
  if (!runner || !compiled) return;
  for (const [key, spec] of Object.entries(compiled.graphics ?? {})) {
    if (spec.type !== 'strokes') continue;
    const drawn = liveStroke && liveStroke.key === key ? { ...spec, strokes: [...spec.strokes, { points: liveStroke.points }] } : spec;
    const r = MZ.rasterizeStrokes(drawn, w, h, t, { mask: spec.clip === 'none' ? null : selectionMask(w, h) });
    runner.setImage(key, new ImageData(r.data, w, h));
  }
}

/**
 * The brush strokes drawn as lines over the original, so it is easy to see what has been painted
 * (the result may show little of them yet, or nothing: the paint is maths). Until "hide strokes".
 */
let showStrokes = true;
function drawStrokeOverlay() {
  const c = $('strokes-overlay'), w = $('source').width, h = $('source').height;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!showStrokes) return;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  chain.steps.forEach((step, i) => {
    if (step.skip) return;
    for (const [name, base] of Object.entries(MZ.filterGraphics(step.filter))) {
      if (base.type !== 'strokes') continue;
      const spec = graphicNow(i, name, base);
      const drawing = brushTarget && brushTarget.i === i && brushTarget.name === name;
      const strokes = drawing && liveStroke ? [...spec.strokes, { points: liveStroke.points }] : spec.strokes;
      for (const { points } of strokes) {
        if (!points.length) continue;
        const path = () => { g.beginPath(); points.forEach(([x, y], k) => (k ? g.lineTo(x * w, y * h) : g.moveTo(x * w, y * h))); if (points.length === 1) g.lineTo(points[0][0] * w + 0.01, points[0][1] * h); };
        path();
        g.strokeStyle = 'rgba(255, 40, 150, 0.45)';
        g.lineWidth = Math.max(2, spec.size * h);
        g.stroke();
        path();
        g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        g.lineWidth = 1;
        g.stroke();
      }
    }
  });
}

/** What each brush effect does: the step's maths (and any knob it needs). */
const BRUSH_EFFECTS = {
  'ink': { label: 'ink in a colour', color: (n) => `mix(rgb, ink, alpha(${n}))`, params: { ink: { type: 'color', default: [0.95, 0.2, 0.25] } } },
  'blur': { label: 'blur, stronger each pass', color: (n) => `mix(rgb, gaussian(2 + 3 min(4 green(${n}), 3)), alpha(${n}))` },
  'darken': { label: 'darken, building up', color: (n) => `rgb (1 - 0.22 min(4 green(${n}), 4) alpha(${n}))` },
  'reveal': { label: 'reveal the colour (picture starts grey)', color: (n) => `mix((gray, gray, gray), rgb, alpha(${n}))` },
  'fuse': { label: 'glow, then cool to charcoal', color: (n) => `mix(rgb, mix((1, 0.9, 0.5), (0.1, 0.07, 0.06), red(${n})), alpha(${n})) + (1, 0.5, 0.1) alpha(${n}) max(0, 1 - 3 red(${n})) 0.6` },
  'rainbow': { label: 'rainbow along the drawing', color: (n) => `mix(rgb, fromhsv(blue(${n}), 0.85, 1), alpha(${n}))` },
  'invert': { label: 'invert', color: (n) => `mix(rgb, 1 - rgb, alpha(${n}))` },
};

function brushControls(i, name, base, g, set, box) {
  const step = chain.steps[i];
  const f = step.filter;
  const row = () => Object.assign(document.createElement('div'), { className: 'row2' });
  const timeline = MZ.strokeTimeline(g, $('source').width / $('source').height);
  const drawing = brushTarget && brushTarget.i === i && brushTarget.name === name;

  const actions = row();
  const drawButton = button(drawing ? 'drawing — click to stop' : 'draw', () => { brushTarget = drawing ? null : { i, name, base }; $('input').classList.toggle('painting', Boolean(brushTarget)); renderSteps(); draw(); });
  if (drawing) drawButton.classList.add('brush-on');
  actions.append(drawButton,
    button('undo stroke', () => { set({ strokes: graphicNow(i, name, base).strokes.slice(0, -1) }); renderSteps(); }),   // the strokes as they are now, not as this panel was drawn
    button('clear', () => { set({ strokes: [] }); renderSteps(); }),
    button('outline the selection', () => { outlineSelection(graphicNow(i, name, base), set); renderSteps(); }),
    button('replay', () => { brushTarget = null; $('input').classList.remove('painting'); currentT = 0; $('play').checked = true; renderSteps(); }),
    button(showStrokes ? 'hide strokes' : 'show strokes', () => { showStrokes = !showStrokes; renderSteps(); draw(); }));
  box.append(actions);
  box.append(Object.assign(document.createElement('div'), { className: 'brush-info',
    textContent: g.strokes.length
      ? `${g.strokes.length} stroke${g.strokes.length > 1 ? 's' : ''} · drawn over ${Math.round(timeline.total)} frames (${(timeline.total / MZ.FPS).toFixed(1)} s)${drawing ? ' · shown finished while drawing' : ''}`
      : 'Click "draw", then paint on the picture (top left). A pen or touch screen gives pressure.' }));

  // what the paint does: the step's maths
  const effect = row();
  const pick = document.createElement('select');
  const current = Object.entries(BRUSH_EFFECTS).find(([, e]) => String(f.color).replace(/\s+/g, '') === e.color(name).replace(/\s+/g, ''))?.[0];
  if (!current) pick.append(new Option('your own maths (in the step above)', '', false, true));
  for (const [key, e] of Object.entries(BRUSH_EFFECTS)) pick.append(new Option(e.label, key, false, key === current));
  pick.onchange = () => {
    const e = BRUSH_EFFECTS[pick.value];
    if (!e) return;
    f.color = e.color(name);
    if (e.params) f.params = { ...(f.params ?? {}), ...e.params };
    rebuild();
    updateShareSoon();
  };
  effect.append(Object.assign(document.createElement('b'), { textContent: 'the paint' }), pick);
  box.append(effect);

  // the brush
  const brush = row();
  const kind = document.createElement('select');
  for (const b of MZ.BRUSHES) kind.append(new Option(b, b, false, b === g.brush));
  kind.onchange = () => set({ brush: kind.value });
  const from = document.createElement('select');
  for (const [v, l] of [['pressure', 'width from pressure'], ['speed', 'width from speed'], ['none', 'even width']]) from.append(new Option(l, v, false, v === g.widthFrom));
  from.onchange = () => set({ widthFrom: from.value });
  const build = Object.assign(document.createElement('input'), { type: 'checkbox', checked: g.buildUp });
  build.onchange = () => set({ buildUp: build.checked });
  const buildLabel = document.createElement('label');
  buildLabel.append(build, ' build up where strokes overlap');
  brush.append(Object.assign(document.createElement('b'), { textContent: 'brush' }), kind, from, buildLabel);
  box.append(brush);
  box.append(knob('size', g.size, 0.003, 0.25, 0.001, (v) => set({ size: v })));
  box.append(knob('flow', g.flow, 0.05, 1, 0.01, (v) => set({ flow: v })));
  box.append(knob('spacing', g.spacing, 0.05, 1, 0.01, (v) => set({ spacing: v })));
  box.append(knob('taper', g.taper, 0, 0.5, 0.01, (v) => set({ taper: v })));

  // timing
  const timing = row();
  const mode = document.createElement('select');
  for (const [v, l] of [['recorded', 'as I drew it'], ['even', 'by length (even speed)'], ['per-stroke', 'same time per stroke']]) mode.append(new Option(l, v, false, v === g.timing));
  mode.onchange = () => set({ timing: mode.value });
  timing.append(Object.assign(document.createElement('b'), { textContent: 'timing' }), mode);
  box.append(timing);
  box.append(knob('speed', g.speed, 0.1, 5, 0.05, (v) => set({ speed: v })));
  box.append(knob('gap (frames)', g.gap, 0, 60, 1, (v) => set({ gap: v })));
  box.append(knob('start (frames)', g.start, 0, 120, 1, (v) => set({ start: v })));
  box.append(knob('fit to frames (0: off)', g.fit, 0, 600, 1, (v) => set({ fit: v })));
  box.append(knob('age span (frames)', g.age, 1, 200, 1, (v) => set({ age: v })));

  // where it may paint
  const where = row();
  const clip = document.createElement('select');
  for (const [v, l] of [['none', 'anywhere'], ['inside', 'only inside the selection'], ['outside', 'only outside the selection']]) clip.append(new Option(l, v, false, v === g.clip));
  clip.onchange = () => set({ clip: clip.value });
  where.append(Object.assign(document.createElement('b'), { textContent: 'paint' }), clip);
  if (g.clip !== 'none' && !selection.hasSelection()) where.append(Object.assign(document.createElement('span'), { className: 'hint', textContent: ' — select something under the picture first' }));
  box.append(where);

  box.append(Object.assign(document.createElement('div'), { className: 'hint',
    textContent: `In the maths, ${name} is the paint: alpha(${name}) where it is; red(${name}) how long ago it was painted (0 just now, 1 after "age span" frames); green(${name}) × 4 how many strokes went over it; blue(${name}) how far through the drawing it was painted. So the paint can change as it is drawn — and with t, after.` }));
  return box;
}

/** The selection's outline (or outlines) as strokes, drawn round at an even pace. */
function outlineSelection(g, set) {
  if (!selection.hasSelection()) { showError('Select something first (under the picture: trace the edge, fill a colour, or find objects), then outline it.'); return; }
  const w = $('source').width, h = $('source').height;
  const loops = MZ.traceContours(selectionMask(w, h), w, h);
  if (!loops.length) { showError('The selection is too small to outline.'); return; }
  const strokes = loops.map((loop) => {
    let ms = 0;
    return { points: loop.map(([x, y], k) => {
      if (k) ms += Math.hypot(x - loop[k - 1][0], y - loop[k - 1][1]) / h * 1500;     // 1.5 s per frame height, as if drawn by hand
      return [(x + 0.5) / w, (y + 0.5) / h, Math.round(ms), 1];
    }) };
  });
  set({ strokes: [...g.strokes, ...strokes] });
}

// Painting: the brush in "draw" takes the picture.
{
  const at = (e) => { const r = $('source').getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  const pressure = (e) => (e.pointerType === 'mouse' ? 1 : e.pressure || 0.5);
  $('input').addEventListener('pointerdown', (e) => {
    if (!brushTarget || selection.state.mode !== 'off' || e.button !== 0) return;
    const pass = compiled?.passes.find((p) => p.path[0] === brushTarget.i && p.graphics?.[brushTarget.name]);
    if (!pass) return;
    const [x, y] = at(e);
    liveStroke = { key: pass.bind[brushTarget.name], t0: e.timeStamp, points: [[x, y, 0, pressure(e)]] };
    $('input').setPointerCapture(e.pointerId);
    e.preventDefault();
    draw();
  });
  $('input').addEventListener('pointermove', (e) => {
    if (!liveStroke) return;
    const aspect = $('source').width / $('source').height;
    for (const ev of e.getCoalescedEvents ? e.getCoalescedEvents() : [e]) {           // every sample the pointer gave, for smooth lines
      const [x, y] = at(ev);
      const last = liveStroke.points[liveStroke.points.length - 1];
      if (Math.hypot((x - last[0]) * aspect, y - last[1]) < 0.002) continue;
      liveStroke.points.push([x, y, Math.max(0, Math.round(ev.timeStamp - liveStroke.t0)), pressure(ev)]);   // the user's own timing
    }
    draw();
  });
  $('input').addEventListener('pointerup', () => {
    if (!liveStroke || !brushTarget) return;
    const { points } = liveStroke;
    liveStroke = null;
    const { i, name, base } = brushTarget;
    setGraphic(i, name, base, { strokes: [...graphicNow(i, name, base).strokes, { points }] });
    renderSteps();
  });
}

$('add-brush').onclick = () => {
  const n = newName('brush');
  addStep({ graphics: { [n]: { type: 'strokes', brush: 'round', size: 0.025 } }, params: { ink: [0.95, 0.2, 0.25] }, color: `mix(rgb, ink, alpha(${n}))` });
  brushTarget = { i: chain.steps.length - 1, name: n, base: MZ.normalizeGraphic(n, { type: 'strokes', brush: 'round', size: 0.025 }) };
  $('input').classList.add('painting');
  renderSteps();
};

// ---- tracking an object through a video or GIF ---------------------------------
let track = null;                        // { tracker, frames, w, h, analysis } for the clip on screen
let tracking = false, stopTracking = false, paused = false;

function clipFrames() {
  if (media.kind === 'gif') return media.gif.frames.length;
  if (media.kind === 'video') return Math.max(1, Math.floor(media.source.duration * MZ.FPS));
  return 0;
}
/** The frame on screen, as the tracker numbers them (t counts frames at MZ.FPS for a video). */
function currentFrame() {
  if (media.kind === 'gif') return media.index;
  if (media.kind === 'video') return Math.min(clipFrames() - 1, Math.max(0, Math.floor(media.source.currentTime * MZ.FPS + 0.01)));
  return 0;
}
function trackedOutline() {
  if (!track || !$('track-follow').checked) return null;
  return track.tracker.results[currentFrame()]?.loop ?? null;
}
/** Is anything selected for this frame: the user's selection, or the tracked outline? */
function selectionActive() { return Boolean(trackedOutline()) || selection.hasSelection(); }
function currentSelectionCanvas(w, h) {
  const outline = trackedOutline();
  return outline ? selection.maskCanvas(w, h, { outline }) : selection.maskCanvas(w, h);
}

function resetTrack() {
  stopTracking = true;
  track = null;
  paused = false;
  $('track-section').hidden = !(media.kind === 'video' || media.kind === 'gif');
  $('track-msg').textContent = '';
  drawTimeline();
  drawTrackOverlay();
}

/** A frame of the clip at preview size, as a canvas: from a second copy of the video (seeking it), or the GIF's frames. */
async function clipFrame(k) {
  const w = $('source').width, h = $('source').height;
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (media.kind === 'gif') {
    const g = media.gif, frame = Object.assign(document.createElement('canvas'), { width: g.width, height: g.height });
    frame.getContext('2d').putImageData(new ImageData(g.frames[k].data, g.width, g.height), 0, 0);
    ctx.drawImage(frame, 0, 0, w, h);
  } else {
    const v = track.analysis;
    await seekTo(v, k);
    ctx.drawImage(v, 0, 0, w, h);
  }
  return canvas;
}

async function ensureTrack() {
  if (track) return track;
  const w = $('source').width, h = $('source').height;
  let analysis = null;
  if (media.kind === 'video') {
    analysis = Object.assign(document.createElement('video'), { src: media.source.currentSrc || media.source.src, muted: true, preload: 'auto' });
    await new Promise((resolve, reject) => { analysis.onloadeddata = resolve; analysis.onerror = () => reject(new Error('Could not read the video for tracking')); });
  }
  track = { frames: clipFrames(), w, h, analysis };
  track.tracker = createTracker({
    frames: track.frames, w, h,
    getFrame: async (k) => (await clipFrame(k)).getContext('2d').getImageData(0, 0, w, h).data,
    onProgress: (done, total) => { if (done !== undefined) $('track-msg').textContent = `Tracking… ${done} of ${total} frames`; drawTimeline(); },
  });
  return track;
}

/** Seek a video to frame k, and make sure it got there (a server without byte ranges leaves it on frame 0). */
async function seekTo(v, k) {
  const target = Math.min(v.duration - 0.001, (k + 0.5) / MZ.FPS);
  await new Promise((resolve) => { v.onseeked = resolve; v.currentTime = target; });
  if (Math.abs(v.currentTime - target) > 1 / MZ.FPS) throw new Error('This video cannot be stepped through frame by frame here (the server does not allow seeking). Load it with "picture or video" instead.');
}

/** Pause the clip on frame k (and show it). */
async function pauseAt(k) {
  paused = true;
  if (media.kind === 'gif') {
    clearTimeout(gifTimer);
    gifTimer = null;
    media.index = k;
    media.source.getContext('2d').putImageData(new ImageData(media.gif.frames[k].data, media.gif.width, media.gif.height), 0, 0);
    showPicture();
    syncT(k);
  } else if (media.kind === 'video') {
    const v = media.source;
    v.pause();
    await seekTo(v, k);
    showPicture();
  }
  $('track-play').textContent = '▶ play';
  describeFrame();
}
function resumeClip() {
  paused = false;
  if (media.kind === 'gif') playGif(media.gif, media.index);
  else if (media.kind === 'video') media.source.play();
  $('track-play').textContent = '❚❚ pause';
}

function drawTimeline() {
  const c = $('track-timeline'), g = c.getContext('2d');
  c.width = c.clientWidth || 480;
  g.fillStyle = '#eee';
  g.fillRect(0, 0, c.width, c.height);
  if (!track) return;
  const n = track.frames, rs = track.tracker.results, keys = track.tracker.keyframes;
  const ref = keys.size ? [...keys.keys()].reduce((s, k) => s + (rs[k]?.score ?? 0), 0) / keys.size : 1;
  for (let k = 0; k < n; k++) {
    const r = rs[k];
    if (!r) continue;
    const sure = Math.max(0, Math.min(1, r.score / Math.max(1e-6, ref) / 0.9));
    g.fillStyle = `hsl(${Math.round(sure * 120)}, 70%, 48%)`;
    g.fillRect((k / n) * c.width, 6, Math.ceil(c.width / n), c.height - 12);
  }
  g.fillStyle = '#111';
  for (const k of keys.keys()) g.fillRect((k / n) * c.width, 0, Math.max(2, c.width / n), c.height);
  g.fillStyle = '#e03a3a';
  g.fillRect((currentFrame() / n) * c.width, 0, 2, c.height);
}

function drawTrackOverlay() {
  const c = $('track-overlay');
  c.width = $('source').width; c.height = $('source').height;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const outline = track && track.tracker.results[currentFrame()]?.loop;
  if (!outline || !$('track-follow').checked) return;
  const key = track.tracker.keyframes.has(currentFrame());
  g.beginPath();
  outline.forEach(([x, y], i) => (i ? g.lineTo(x + 0.5, y + 0.5) : g.moveTo(x + 0.5, y + 0.5)));
  g.closePath();
  g.lineWidth = 2; g.strokeStyle = key ? '#111' : '#00e5ff'; g.setLineDash(key ? [] : [5, 3]); g.stroke();
}

function describeFrame() {
  if (!track) return;
  const k = currentFrame(), r = track.tracker.results[k];
  $('track-msg').textContent = `Frame ${k + 1} of ${track.frames}` + (!r ? ' · not tracked yet'
    : r.from === 'key' ? ' · a keyframe' : ` · tracked ${r.from}, confidence ${(r.score).toFixed(2)}${track.tracker.flagged().includes(k) ? ' — unsure: fix it ("edit this frame" or select again) and use it as a keyframe' : ''}`);
}

/** Every new frame on screen: the selection follows the track, the overlay and timeline too. */
function trackFrameShown() {
  if (!track) return;
  if (track.tracker.results.some(Boolean)) bindSelection(false);
  drawTrackOverlay();
  drawTimeline();
}

/** The largest outline of the current selection, in preview pixels. */
function selectionOutline() {
  if (!selection.hasSelection()) return null;
  const w = $('source').width, h = $('source').height;
  const d = selection.maskCanvas(w, h, { raw: true }).getContext('2d').getImageData(0, 0, w, h).data;
  const m = new Float32Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4] / 255;
  return largestLoop(MZ.traceContours(m, w, h));
}
function largestLoop(loops) {
  if (!loops.length) return null;
  const size = (l) => Math.abs(l.reduce((s, p, i) => s + p[0] * l[(i + 1) % l.length][1] - l[(i + 1) % l.length][0] * p[1], 0));
  return [...loops].sort((a, b) => size(b) - size(a))[0].slice(0, -1);
}

$('track-play').onclick = () => (paused ? resumeClip() : pauseAt(currentFrame()));
$('track-key').onclick = async () => {
  const loop = selectionOutline();
  if (!loop) { $('track-msg').textContent = 'Select the object first, under the picture: trace the edge, fill a colour or find objects.'; return; }
  if (!paused) await pauseAt(currentFrame());
  await ensureTrack();
  await track.tracker.setKeyframe(currentFrame(), loop);
  selection.clear();
  trackFrameShown();
  $('track-msg').textContent = `Frame ${currentFrame() + 1} is a keyframe. Press "track" to follow the object from here.`;
};
$('track-run').onclick = async () => {
  if (!track || !track.tracker.keyframes.size) { $('track-msg').textContent = 'Use a selection as a keyframe first.'; return; }
  if (tracking) return;
  tracking = true; stopTracking = false;
  $('track-stop').hidden = false;
  const t0 = performance.now();
  try {
    await track.tracker.track({ stop: () => stopTracking });
    const flagged = track.tracker.flagged();
    $('track-msg').textContent = `Tracked ${track.frames} frames in ${((performance.now() - t0) / 1000).toFixed(1)} s` +
      (flagged.length ? ` · ${flagged.length} unsure (red): click one to fix it, or "fix red frames with AI"` : ' · all sure');
  } catch (e) { $('track-msg').textContent = e.message; }
  tracking = false;
  $('track-stop').hidden = true;
  trackFrameShown();
};
$('track-stop').onclick = () => { stopTracking = true; };
$('track-clear').onclick = () => { resetTrack(); bindSelection(); };
$('track-follow').onchange = () => { bindSelection(); drawTrackOverlay(); };
$('track-timeline').onclick = (e) => {
  if (!track) return;
  const r = $('track-timeline').getBoundingClientRect();
  pauseAt(Math.min(track.frames - 1, Math.max(0, Math.floor((e.clientX - r.left) / r.width * track.frames))));
};
$('track-edit').onclick = async () => {
  const loop = track?.tracker.results[currentFrame()]?.loop;
  if (!loop) { $('track-msg').textContent = 'No tracked outline on this frame.'; return; }
  if (!paused) await pauseAt(currentFrame());
  selectMode('trace');
  selection.trace(resample(loop, Math.max(8, Math.min(24, Math.round(loop.length / 2)))).map(([x, y]) => [Math.round(x), Math.round(y)]));
  $('track-msg').textContent = 'Drag the points onto the edge, then "use as keyframe".';
};
$('track-ai').onclick = async () => {
  if (!track || tracking) return;
  const flagged = track.tracker.flagged();
  if (!flagged.length) { $('track-msg').textContent = 'No unsure frames to fix.'; return; }
  tracking = true;
  try {
    for (const [n, k] of flagged.entries()) {
      $('track-msg').textContent = `AI: frame ${k + 1} (${n + 1} of ${flagged.length})…`;
      const loop = track.tracker.results[k].loop;
      const xs = loop.map((p) => p[0]), ys = loop.map((p) => p[1]);
      const padX = (Math.max(...xs) - Math.min(...xs)) * 0.06, padY = (Math.max(...ys) - Math.min(...ys)) * 0.06;
      const box = [Math.min(...xs) - padX, Math.min(...ys) - padY, Math.max(...xs) + padX, Math.max(...ys) + padY];
      await ai.embed(await clipFrame(k));
      const m = await ai.mask({ box });
      const better = largestLoop(MZ.traceContours(Float32Array.from(m), track.w, track.h));
      if (better) await track.tracker.setKeyframe(k, better);
      drawTimeline();
    }
    ai.invalidate();
    tracking = false;
    $('track-run').onclick();
  } catch (e) {
    $('track-msg').textContent = e.message;
    tracking = false;
  }
};
new ResizeObserver(() => drawTimeline()).observe($('track-timeline'));

const exporter = setupExport({ $, renderFrame, media: () => media, download, outputCanvas: outCanvas, noDownload: () => Boolean(window.mzDemoNoDownload), canCrop: () => $('export').open });

// ---- selecting an object: `selected` in the maths ---------------------------
const NO_SELECTION = Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
NO_SELECTION.getContext('2d').fillStyle = '#fff';
NO_SELECTION.getContext('2d').fillRect(0, 0, 1, 1);
const selection = setupSelection({ $, source: () => $('source'), overlay: $('overlay'), surface: $('select-surface'), onChange: () => { bindSelection(); showSwatches(); } });
function showSwatches() {                                      // the wand's colours; click one to drop it
  const box = $('select-colours');
  box.textContent = '';
  selection.state.colours.forEach((c, i) => {
    const swatch = Object.assign(document.createElement('span'), { className: 'swatch', title: 'click to remove this colour' });
    swatch.style.background = `rgb(${c.join(',')})`;
    swatch.onclick = () => selection.removeColour(i);
    box.append(swatch);
  });
}
function bindSelection(redraw = true) {
  selectionVersion++;
  if (!runner) return;
  runner.setImage('selection', selectionActive() ? currentSelectionCanvas($('source').width, $('source').height) : NO_SELECTION);
  if (redraw) draw();
  exporter.pictureChanged();
}
// ---- find objects with the AI -----------------------------------------------
// In development the runtimes are in node_modules and the models in demo/models; the built site has them beside the page.
// The model: ?ai=… in the address, else the last one chosen here (the choice is to compare them; see ai.js).
const dev = location.pathname.includes('/demo/');
// in development every model in demo/models/ can be tried; the built site has only the shipped ones
const aiOffered = dev ? Object.keys(AI_MODELS) : SHIPPED_MODELS;
const aiChoice = [new URLSearchParams(location.search).get('ai'), localStorage.getItem('mz-ai-model')].find((k) => aiOffered.includes(k)) ?? DEFAULT_MODEL;
const ai = setupAI({
  source: () => $('source'), model: aiChoice,
  ortUrl: dev ? '/node_modules/onnxruntime-web/dist/' : 'ort/',
  mediapipeUrl: dev ? '/node_modules/@mediapipe/tasks-vision/wasm/' : 'mediapipe/',
  onProgress: (text) => { if (selection.state.mode === 'ai') $('select-msg').textContent = text || aiHint(); },
});
for (const key of aiOffered) $('select-ai-model').append(new Option(`${AI_MODELS[key].name} — ${AI_MODELS[key].about}`, key));
$('select-ai-model').value = ai.model;
$('select-ai-model').onchange = () => {
  ai.setModel($('select-ai-model').value);
  try { localStorage.setItem('mz-ai-model', ai.model); } catch { /* private mode */ }
  selection.setPreview(null);
  if (selection.state.mode === 'ai') aiStart();
};
let aiBoxes = [];
let aiPrompt = { points: [], labels: [], box: null };
let aiClickMs = 0;
const aiTiming = () => `${ai.spec.name} looked in ${(ai.lookMs / 1000).toFixed(1)} s${aiClickMs ? `, the last click took ${Math.round(aiClickMs)} ms` : ''}.`;
const aiHint = () => (ai.spec.kind === 'objects'
  ? (aiBoxes.length ? `Found ${aiBoxes.map((b) => b.label).join(', ')}. ` : 'Found nothing it knows (people, animals, vehicles, furniture… 80 kinds). ') + 'Click an object to outline it in yellow; shift-click one to take it away; '
  : 'Click anything to outline it in yellow; click again to add to it, shift-click where it went too far; ')
  + 'Enter or "keep" adds it to the selection. For anything else, use "trace the edge", "fill a colour" or "refine with a brush". Then use "Only inside the selection". ' + aiTiming();
async function aiStart() {
  aiBoxes = [];
  aiPrompt = { points: [], labels: [], box: null };
  aiClickMs = 0;
  ai.invalidate();
  try {
    await ai.embed();
    aiBoxes = await ai.detect();
    $('select-msg').textContent = aiHint();
  } catch (e) {
    $('select-msg').textContent = e.message;
  }
  selection.draw();
}
async function aiClick(x, y, negative) {
  $('source').width; $('source').height;
  if (!aiPrompt.points.length && !negative) {
    const hit = aiBoxes.find((b) => x >= b.box[0] && x <= b.box[2] && y >= b.box[1] && y <= b.box[3]);
    if (hit) aiPrompt.box = hit.box;
  }
  aiPrompt.points.push([x, y]);
  aiPrompt.labels.push(negative ? 0 : 1);
  $('select-msg').textContent = 'Thinking…';
  try {
    const t0 = performance.now();
    selection.setPreview(await ai.mask({ points: aiPrompt.points, labels: aiPrompt.labels, box: aiPrompt.box }));
    aiClickMs = performance.now() - t0;
    $('select-msg').textContent = aiHint();
  } catch (e) {
    $('select-msg').textContent = e.message;
  }
}
function aiKeep() {
  if (selection.state.preview) selection.addRaster(selection.state.preview);
  selection.setPreview(null);
  aiPrompt = { points: [], labels: [], box: null };
}
function aiKey(key) {
  if (key === 'Enter') aiKeep();
  else if (key === 'Escape') { selection.setPreview(null); aiPrompt = { points: [], labels: [], box: null }; }
  else if (aiPrompt.points.length) { aiPrompt.points.pop(); aiPrompt.labels.pop(); if (aiPrompt.points.length) aiClick(...aiPrompt.points.pop(), aiPrompt.labels.pop() === 0); else { selection.setPreview(null); aiPrompt.box = null; } }
}
function aiDraw(ctx) {
  if (selection.state.mode !== 'ai') return;
  ctx.font = '11px system-ui, sans-serif';
  for (const { label, box } of aiBoxes) {
    const [x0, y0, x1, y1] = box;
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.5; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    const width = ctx.measureText(label).width + 6;
    ctx.fillStyle = 'rgba(42,111,219,.9)'; ctx.fillRect(x0, y0, width, 14);
    ctx.fillStyle = '#fff'; ctx.fillText(label, x0 + 3, y0 + 11);
  }
  aiPrompt.points.forEach(([x, y], i) => {
    ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, 4, 0, Math.PI * 2);
    ctx.fillStyle = aiPrompt.labels[i] ? '#ffd54f' : '#e03a3a'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
  });
}
selection.setAiHandlers(aiClick, aiKey, aiDraw);
$('select-keep').onclick = aiKeep;

function selectMode(mode) {
  selection.setMode(selection.state.mode === mode ? 'off' : mode);
  const on = selection.state.mode;
  $('select-trace').classList.toggle('on', on === 'trace');
  $('select-fill').classList.toggle('on', on === 'fill');
  $('select-ai').classList.toggle('on', on === 'ai');
  $('select-refine').classList.toggle('on', on === 'refine');
  $('select-refine-row').hidden = on !== 'refine';
  $('select-keep').hidden = on !== 'ai';
  $('select-ai-row').hidden = on !== 'ai' || aiOffered.length < 2;   // one model: nothing to choose
  if (on !== 'off') $('select-panel').open = true;
  if (on === 'ai') aiStart(); else { selection.setPreview(null); aiPrompt = { points: [], labels: [], box: null }; }
  $('select-tol-row').hidden = on !== 'fill';
  $('select-contiguous-row').hidden = on !== 'fill';
  $('select-cool-row').hidden = on !== 'trace';
  $('select-msg').textContent = on === 'trace'
    ? 'Click past the picture\'s edge to run the outline along it. Click a point on the edge of the object, then move along it — the line follows the edge, and the part that stays put behind you is fixed for you (the small blue points). Click where it needs help. Click the first point (or press Enter) to close; drag a point to move it; Backspace removes the last; Esc stops. Then use "Only inside the selection" from the library, or `selected` in your maths.'
    : on === 'fill' ? 'Click a colour to select everything of that colour that touches it; click more colours to add them to the set (the fill grows through any of them). Untick "connected only" to take that colour anywhere. Click a swatch to drop a colour.'
    : on === 'ai' ? 'Loading…'
    : on === 'refine' ? 'Paint over the picture: "inside" where the selection should reach, "outside" where it should not. When you let go, the edge settles on the picture\'s own edges near the stroke; the rest stays. With nothing selected, inside strokes make a selection.' : '';
}
$('select-trace').onclick = () => selectMode('trace');
$('select-fill').onclick = () => selectMode('fill');
$('select-ai').onclick = () => selectMode('ai');
$('select-refine').onclick = () => selectMode('refine');
$('refine-in').onchange = $('refine-out').onchange = () => selection.setRefine({ inside: $('refine-in').checked });
$('refine-size').oninput = () => selection.setRefine({ size: Number($('refine-size').value) });
$('select-clear').onclick = () => { selection.clear(); };
$('select-feather').addEventListener('input', () => selection.setFeather(Number($('select-feather').value)));
$('select-invert').addEventListener('change', () => selection.setInvert($('select-invert').checked));
$('select-tol').addEventListener('input', () => selection.setTolerance(Number($('select-tol').value)));
$('select-contiguous').addEventListener('change', () => selection.setContiguous($('select-contiguous').checked));
$('select-cool').addEventListener('change', () => selection.setCooling($('select-cool').checked));
/** The old one-click export: a PNG at the picture's size (the checker uses it). */
async function exportPng() {
  const r = await exporter.produce('png');
  if (!window.mzDemoNoDownload) download(r.blob, 'filter.png');
  $('export-msg').textContent = `Saved ${r.width} × ${r.height}: ${r.note}`;
}
$('record').onclick = () => {
  if (!window.MediaRecorder || !outCanvas().captureStream) { $('export-msg').textContent = 'This browser cannot record a canvas'; return; }
  const type = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(outCanvas().captureStream(30), { mimeType: type });
  const chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = () => { download(new Blob(chunks, { type }), type.includes('mp4') ? 'filter.mp4' : 'filter.webm'); $('export-msg').textContent = 'Saved'; };
  $('play').checked = true;
  recorder.start();
  $('export-msg').textContent = `Recording 5 s at ${outCanvas().width} × ${outCanvas().height}…`;
  setTimeout(() => recorder.stop(), 5000);
};
(function tick() {
  if (moving && $('play').checked && !video && media.kind !== 'gif') syncT((currentT + 1) % 241);
  requestAnimationFrame(tick);
})();

/**
 * The filtered animation as a GIF, at the preview size (GIF files grow fast).
 * A GIF plays through once with its own frame delays; anything else gets
 * 3 seconds at 15 frames a second, with t moving as it does on screen.
 */
async function saveGif() {
  if (!runner) return;
  const out = outCanvas();
  const w = out.width, h = out.height;
  const scratch = document.createElement('canvas');
  scratch.width = w; scratch.height = h;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  const grab = () => {
    if (track) bindSelection(false);                             // the tracked selection for this frame
    updateStrokes();                                             // the strokes as at this frame
    if (engine === 'cpu') runner.draw({ t: currentT, canvas: scratch });
    else { runner.draw({ t: currentT }); sctx.drawImage($('out'), 0, 0); }
    return sctx.getImageData(0, 0, w, h).data;
  };
  const playing = $('play').checked;
  const wasT = currentT;
  const gif = media.kind === 'gif' ? media.gif : null;
  const wasIndex = media.index;
  const frames = gif
    ? gif.frames.map((f, i) => ({ t: i, delay: f.delay, index: i }))
    : Array.from({ length: 45 }, (_, i) => ({ t: wasT + i * 4, delay: 67 }));     // 60 t a second on screen, 15 frames a second here
  $('play').checked = false;
  clearTimeout(gifTimer);
  gifTimer = null;
  const encoder = ct();
  try {
    for (const [n, f] of frames.entries()) {
      $('export-msg').textContent = `Saving GIF… frame ${n + 1} of ${frames.length}`;
      if (gif) {
        media.index = f.index;
        media.source.getContext('2d').putImageData(new ImageData(gif.frames[f.index].data, gif.width, gif.height), 0, 0);
        drawMedia($('source').getContext('2d'), $('source').width, $('source').height);
        runner.setImage($('source'));
      }
      currentT = f.t;
      const rgba = grab();
      const palette = H(rgba, 256);
      encoder.writeFrame(nt(rgba, palette), w, h, { palette, delay: f.delay });
      await new Promise((r) => setTimeout(r, 0));
    }
    encoder.finish();
    if (!window.mzDemoNoDownload) download(new Blob([encoder.bytes()], { type: 'image/gif' }), 'filter.gif');
    $('export-msg').textContent = `Saved a ${w} × ${h} GIF, ${frames.length} frames`;
  } finally {
    currentT = wasT;
    $('play').checked = playing;
    if (gif) playGif(gif, wasIndex); else draw();
  }
}
$('gif').onclick = () => saveGif().catch((e) => { $('export-msg').textContent = e.message; });

// ---- the page's panels -------------------------------------------------------
// A folded panel stays as the user left it.
for (const panel of document.querySelectorAll('details[data-remember]')) {
  const key = 'mz-open-' + panel.id;
  try { if (localStorage.getItem(key) !== null) panel.open = localStorage.getItem(key) === '1'; } catch { /* private mode */ }
  panel.addEventListener('toggle', () => { try { localStorage.setItem(key, panel.open ? '1' : '0'); } catch { /* private mode */ } });
}
// Cropping is part of the download options: a drag on the result crops only while they are open.
$('export').addEventListener('toggle', () => document.body.classList.toggle('cropping', $('export').open));
// On a phone the original is hidden until asked for (the result is what matters, and both stacked push the filter far down);
// the panels that draw on the original show it.
{
  const show = (on) => { document.body.classList.toggle('hide-original', !on); $('show-original').setAttribute('aria-pressed', String(on)); $('show-original').textContent = on ? 'hide original' : 'show original'; };
  const drawsOnOriginal = ['select-panel', 'text-section', 'track-section'];
  show(drawsOnOriginal.some((id) => $(id).open));
  $('show-original').onclick = () => show(document.body.classList.contains('hide-original'));
  for (const id of drawsOnOriginal) $(id).addEventListener('toggle', () => { if ($(id).open) show(true); });
}
$('quick-download').onclick = () => exporter.save();
$('quick-link').onclick = async () => {
  try { await navigator.clipboard.writeText(MZ.filterToLink(shareable(), base())); $('export-msg').textContent = ''; toast('Link copied — it carries the filter, not the picture.'); }
  catch { $('export-msg').textContent = 'Copy the address bar: it carries the filter.'; }
};
$('start-over').onclick = async () => {
  if (chain.steps.length && !(await ask('Remove every step? (Save first to keep this filter.)', { title: 'Clear the filter', ok: 'Clear' }))) return;
  chain.steps = [];
  rebuild();
};
$('play-toggle').onclick = () => { $('play').checked = !$('play').checked; playLabel(); if (video) (($('play').checked) ? video.play() : video.pause()); };
const playLabel = () => { $('play-toggle').textContent = $('play').checked ? '❚❚' : '▶'; };

// ---- go --------------------------------------------------------------------
renderLibrary();
renderSaved();
testPicture();
try {
  if (location.hash.length > 1) {
    const shared = MZ.filterFromLink(location.hash);
    loadChain(shared);
    showForkNote(shared);
  } else loadChain({ steps: [byName('Colour circle')] });
} catch (e) {
  showError('The link is not a filter: ' + e.message);
  loadChain({ steps: [byName('Colour circle')] });
}
renderHelp();
renderExamples();
$('help-link').onclick = (e) => { e.preventDefault(); showHelp('pixel'); };
await loadPhotos();

// For scripts driving the page (tests).
window.mzDemo = {
  BUILTIN, loadChain, addStep, draw, slots, gl, exportPng, saveGif, explain, HELP, testPicture, moveStep, rebuild, exporter, selection,
  setGraphic, bindGraphics, showExample, EXAMPLES, updateStrokes, BRUSH_EFFECTS,
  setBrushTarget(target) { brushTarget = target; },
  get track() { return track; }, pauseAt, currentFrame, ensureTrack,
  setT(value) { currentT = value; },
  bindSelection,
  ai: { start: aiStart, click: aiClick, keep: aiKeep, key: aiKey, get boxes() { return aiBoxes; }, model: ai, models: AI_MODELS },
  loadGif: (buffer) => playGif(decodeGif(buffer)),
  gifenc: { GIFEncoder: ct, quantize: H, applyPalette: nt },
  get media() { return media; },
  get chain() { return chain; }, get compiled() { return compiled; }, get runner() { return runner; }, setOpacity,
  get t() { return currentT; },
  get engine() { return engine; },
  get engineReason() { return engineReason; },
  slotCanvas: (name) => slotFor(name).canvas,
  /** What the GPU drew, rows top down, as RGBA bytes. */
  readOut() {
    const w = $('out').width, h = $('out').height, px = new Uint8Array(4 * w * h), out = new Uint8Array(4 * w * h);
    if (engine === 'cpu') return { data: new Uint8Array($('outCpu').getContext('2d').getImageData(0, 0, w, h).data.buffer), width: w, height: h };
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return { data: out, width: w, height: h };
  },
  stats() {
    const w = $('out').width, h = $('out').height;
    const px = engine === 'cpu' ? $('outCpu').getContext('2d').getImageData(0, 0, w, h).data : new Uint8Array(4 * w * h);
    if (engine !== 'cpu') gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0, lit = 0;
    for (let i = 0; i < px.length; i += 4) { sum += px[i] + px[i + 1] + px[i + 2]; if (px[i] + px[i + 1] + px[i + 2]) lit++; }
    return { mean: +(sum / (w * h * 3)).toFixed(1), lit: +(lit / (w * h)).toFixed(2) };
  },
};
