/* qblur — Copyright (c) 2025-2026 Robert Wilcox — MIT licence; MathZetta loads from jsDelivr; other people's code on this site: THIRD-PARTY-NOTICES.txt */
import { parseTree } from 'https://cdn.jsdelivr.net/npm/mathzetta@1.1.0/build/esm/core.js';
import { checkGeneratedJs } from 'https://cdn.jsdelivr.net/npm/mathzetta@1.1.0/build/esm/formulas.js';
import { REACH, FILTER_FUNCTIONS, FILTER_VALUES, filterPictureCalls } from 'https://cdn.jsdelivr.net/npm/mathzetta@1.1.0/build/esm/glsl.js';

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

function scratch$1() { return new Float64Array(4); }
/** P[i][k], for colour params (the generated code may not index twice). */
function at(P, i, k) { return Number(P[i][k]); }

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

var H = /*#__PURE__*/Object.freeze({
    __proto__: null,
    BLANK: BLANK,
    CLEAR: CLEAR,
    at: at,
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
    scratch: scratch$1,
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
const HELPERS = Object.keys(H).filter((k) => typeof H[k] === 'function');

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
            ...HELPERS.map((k) => H[k])];
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
 * A worker for createCpuRunner's drawAsync(): it compiles the filter's
 * passes itself (through the same whitelist gate), keeps the pictures it
 * is sent, and runs one pass over a band of rows when asked.
 *
 * Works as a browser module worker and as a Node worker_thread.
 */


const port = typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined'
    ? { on: (fn) => { self.onmessage = (e) => fn(e.data); }, post: (m, t) => self.postMessage(m, t) }
    : await (async () => {
        const { parentPort } = await import('node:worker_threads');
        return { on: (fn) => parentPort.on('message', fn), post: (m, t) => parentPort.postMessage(m, t) };
    })();

let programs = [];
const pictures = {};
let source = null;
let scratch = null;

port.on((m) => {
    try {
        if (m.type === 'init') {
            programs = m.passes.map((pass) => compileCpuPass(pass));
            port.post({ id: m.id, ok: true });
        } else if (m.type === 'picture') {
            if (m.name === 'source') source = m.picture;
            else pictures[m.name] = m.picture;
            port.post({ id: m.id, ok: true });
        } else if (m.type === 'run') {
            const { width, height, y0, y1 } = m;
            const n = width * height * 4;
            // shared memory: write straight into the shared output; otherwise into our own, then send our rows back
            const output = m.output ?? (scratch && scratch.length === n ? scratch : (scratch = new Float32Array(n)));
            programs[m.pass].run({
                input: m.input, output, source: source.data, width, height, t: m.t, params: m.params,
                opacity: m.opacity, pictures, placements: m.placements, y0, y1,
            });
            const a = y0 * width * 4;
            const b = y1 * width * 4;
            if (m.quantize) {
                for (let j = a; j < b; j++) {
                    const v = output[j];
                    output[j] = v > 0 ? (v < 1 ? Math.round(v * 255) / 255 : 1) : 0;
                }
            }
            if (m.output) port.post({ id: m.id, ok: true });
            else {
                const band = output.slice(a, b);
                port.post({ id: m.id, ok: true, band }, [band.buffer]);
            }
        }
    } catch (e) {
        port.post({ id: m.id, ok: false, error: e.message });
    }
});
