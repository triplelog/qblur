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

import { REACH } from 'mathzetta/glsl';

export const BLANK = { data: new Float32Array([1, 1, 1, 1]), width: 1, height: 1 };   // a picture not given yet: white
export const CLEAR = { data: new Float32Array([0, 0, 0, 0]), width: 1, height: 1 };   // a graphic not drawn yet: transparent

const PLACE = { cover: 0, fit: 1, stretch: 2, tile: 3 };
export function placeCode(place) { return PLACE[place ?? 'cover'] ?? 0; }

export function scratch() { return new Float64Array(4); }
/** P[i][k], for colour params (the generated code may not index twice). */
export function at(P, i, k) { return Number(P[i][k]); }

export function fmod(a, b) { return a - b * Math.floor(a / b); }
export function smoothstep(e0, e1, x) { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); }
export function factorial(n) { let r = 1; for (let i = 2; i <= 170; i++) { if (i > n) break; r *= i; } return r; }
export function perm(n, k) { let r = 1; for (let i = 0; i < 170; i++) { if (i >= k) break; r *= n - i; } return r; }
export function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); for (let i = 0; i < 64; i++) { if (b === 0) break; const t = fmod(a, b); a = b; b = t; } return a; }
export function root(n, x) { return n === 2 ? Math.sqrt(x) : n === 3 ? Math.sign(x) * Math.pow(Math.abs(x), 1 / 3) : Math.pow(x, 1 / n); }
/** The shader's hash: a new value per pixel and per call, seeded with t. (A GPU's float sin differs, so the values do too.) */
export function random(px, py, h, seed) {
    const v = Math.sin((px + 0.5) * 12.9898 + (h - py - 0.5) * 78.233 + seed * 37.719) * 43758.5453;
    return v - Math.floor(v);
}

// ---- sampling --------------------------------------------------------------------

const clampi = (v, max) => (v < 0 ? 0 : v > max ? max : v);

/** Bilinear sample of picture data at pixel-centre position (X, Y), edges clamped, into out[0..3]. */
export function sample(D, w, h, X, Y, out) {
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
export function sampleOrZero(D, w, h, X, Y, out) {
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
export function picture(Q, qw, qh, w, h, zoom, x, y, angle, mode, X, Y, out) {
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

export function plane_blur(I, w, h, y0, y1, radius) { return boxPlanes(I, w, h, y0, y1, radius, ['x', 'y'], REACH.square); }
export function plane_blurx(I, w, h, y0, y1, radius) { return boxPlanes(I, w, h, y0, y1, radius, ['x'], REACH.line); }
export function plane_blury(I, w, h, y0, y1, radius) { return boxPlanes(I, w, h, y0, y1, radius, ['y'], REACH.line); }
export function plane_gaussian(I, w, h, y0, y1, sigma) { return gaussPlanes(I, w, h, y0, y1, sigma, ['x', 'y'], REACH.square); }
export function plane_gaussianx(I, w, h, y0, y1, sigma) { return gaussPlanes(I, w, h, y0, y1, sigma, ['x'], REACH.line); }
export function plane_gaussiany(I, w, h, y0, y1, sigma) { return gaussPlanes(I, w, h, y0, y1, sigma, ['y'], REACH.line); }
export function plane_dilate(I, w, h, y0, y1, radius) { return extremePlanes(I, w, h, y0, y1, radius, 0, true); }
export function plane_erode(I, w, h, y0, y1, radius) { return extremePlanes(I, w, h, y0, y1, radius, 1, false); }

export function plane_sharpen(I, w, h, y0, y1, amount) {
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

export function plane_sobelx(I, w, h, y0, y1) { return lumaOp(I, w, h, y0, y1, SOBELX); }
export function plane_sobely(I, w, h, y0, y1) { return lumaOp(I, w, h, y0, y1, SOBELY); }
export function plane_sobel(I, w, h, y0, y1) { return lumaOp(I, w, h, y0, y1, SOBEL); }
export function plane_laplacian(I, w, h, y0, y1) { return lumaOp(I, w, h, y0, y1, LAPLACIAN); }
export function plane_emboss(I, w, h, y0, y1) { return lumaOp(I, w, h, y0, y1, EMBOSS); }

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

export function at_blur(I, w, h, px, py, radius, out) {
    return window2D(I, w, h, px, py, offsets(radius, REACH.square, (i) => Math.abs(i) <= radius), null, 0, add, out, (a, n) => a / n);
}
export function at_blurx(I, w, h, px, py, radius, out) { return window1D(I, w, h, px, py, 'x', offsets(radius, REACH.line, (i) => Math.abs(i) <= radius), null, out); }
export function at_blury(I, w, h, px, py, radius, out) { return window1D(I, w, h, px, py, 'y', offsets(radius, REACH.line, (i) => Math.abs(i) <= radius), null, out); }
export function at_gaussian(I, w, h, px, py, sigma, out) {
    if (!(sigma > 0)) return here(I, w, px, py, out);
    const limit = 3 * sigma;
    const g = (i, j) => Math.exp(-(i * i + j * j) / (2 * sigma * sigma));
    return window2D(I, w, h, px, py, offsets(limit, REACH.square, (i) => Math.abs(i) <= limit), g, 0, add, out, (a, n) => a / n);
}
export function at_gaussianx(I, w, h, px, py, sigma, out) {
    if (!(sigma > 0)) return here(I, w, px, py, out);
    const limit = 3 * sigma;
    return window1D(I, w, h, px, py, 'x', offsets(limit, REACH.line, (i) => Math.abs(i) <= limit), (i) => Math.exp(-(i * i) / (2 * sigma * sigma)), out);
}
export function at_gaussiany(I, w, h, px, py, sigma, out) {
    if (!(sigma > 0)) return here(I, w, px, py, out);
    const limit = 3 * sigma;
    return window1D(I, w, h, px, py, 'y', offsets(limit, REACH.line, (i) => Math.abs(i) <= limit), (i) => Math.exp(-(i * i) / (2 * sigma * sigma)), out);
}
export function at_dilate(I, w, h, px, py, radius, out) { return window2D(I, w, h, px, py, offsets(radius, REACH.square, (i) => Math.abs(i) <= radius), null, 0, maxOf, out); }
export function at_erode(I, w, h, px, py, radius, out) { return window2D(I, w, h, px, py, offsets(radius, REACH.square, (i) => Math.abs(i) <= radius), null, 1, minOf, out); }
export function at_sharpen(I, w, h, px, py, amount, out) {
    const t = (xx, yy) => (clampi(yy, h - 1) * w + clampi(xx, w - 1)) * 4;
    const c = t(px, py), l = t(px - 1, py), r = t(px + 1, py), u = t(px, py - 1), d = t(px, py + 1);
    for (let k = 0; k < 3; k++) out[k] = I[c + k] + amount * (4 * I[c + k] - I[l + k] - I[r + k] - I[u + k] - I[d + k]);
    return out;
}

/** 3×3 kernel, row by row from the top-left (k00 at dx = -1, dy = -1). */
export function convolve(I, w, h, px, py, k00, k01, k02, k10, k11, k12, k20, k21, k22, out) {
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
export function col_tolinear(r, g, b, out) { out[0] = toLin(r); out[1] = toLin(g); out[2] = toLin(b); return out; }
export function col_fromlinear(r, g, b, out) { out[0] = fromLin(r); out[1] = fromLin(g); out[2] = fromLin(b); return out; }
export function col_tohsv(r, g, b, out) {
    const v = Math.max(r, g, b), d = v - Math.min(r, g, b);
    out[0] = d > 0 ? hue(r, g, b, v, d) : 0; out[1] = v > 0 ? d / v : 0; out[2] = v;
    return out;
}
export function col_fromhsv(h, s, v, out) {
    out[0] = v * (1 + (tri(h, 0) - 1) * s); out[1] = v * (1 + (tri(h, 2 / 3) - 1) * s); out[2] = v * (1 + (tri(h, 1 / 3) - 1) * s);
    return out;
}
export function col_tohsl(r, g, b, out) {
    const v = Math.max(r, g, b), m = Math.min(r, g, b), d = v - m, l = (v + m) * 0.5;
    out[0] = d > 0 ? hue(r, g, b, v, d) : 0; out[1] = d > 0 ? d / (1 - Math.abs(2 * l - 1)) : 0; out[2] = l;
    return out;
}
export function col_fromhsl(h, s, l, out) {
    const C = (1 - Math.abs(2 * l - 1)) * s;
    out[0] = l - C * 0.5 + C * tri(h, 0); out[1] = l - C * 0.5 + C * tri(h, 2 / 3); out[2] = l - C * 0.5 + C * tri(h, 1 / 3);
    return out;
}
export function col_toycbcr(r, g, b, out) {
    const y = r * 0.299 + g * 0.587 + b * 0.114;
    out[0] = y; out[1] = 0.5 + (b - y) * 0.5643; out[2] = 0.5 + (r - y) * 0.7132;
    return out;
}
export function col_fromycbcr(y, cb, cr, out) {
    cb -= 0.5; cr -= 0.5;
    out[0] = y + 1.402 * cr; out[1] = y - 0.344136 * cb - 0.714136 * cr; out[2] = y + 1.772 * cb;
    return out;
}
const labF = (t) => (t < 0.008856 ? 7.787 * t + 16 / 116 : Math.cbrt(t));
const labFinv = (f) => (f < 0.206893 ? (f - 16 / 116) / 7.787 : f * f * f);
export function col_tolab(r, g, b, out) {
    const R = toLin(r), G = toLin(g), B = toLin(b);
    const fx = labF((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
    const fy = labF(0.2126729 * R + 0.7151522 * G + 0.0721750 * B);
    const fz = labF((0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883);
    out[0] = (116 * fy - 16) / 100; out[1] = 0.5 + 500 * (fx - fy) / 256; out[2] = 0.5 + 200 * (fy - fz) / 256;
    return out;
}
export function col_fromlab(L, A, B, out) {
    const fy = (L * 100 + 16) / 116, fx = fy + (A - 0.5) * 256 / 500, fz = fy - (B - 0.5) * 256 / 200;
    const X = labFinv(fx) * 0.95047, Y = labFinv(fy), Z = labFinv(fz) * 1.08883;
    const lr = Math.min(Math.max(3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, 0), 1);
    const lg = Math.min(Math.max(-0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z, 0), 1);
    const lb = Math.min(Math.max(0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z, 0), 1);
    out[0] = fromLin(lr); out[1] = fromLin(lg); out[2] = fromLin(lb);
    return out;
}
export function col_tooklab(r, g, b, out) {
    const R = toLin(r), G = toLin(g), B = toLin(b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    out[0] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    out[1] = 0.5 + 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    out[2] = 0.5 + 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    return out;
}
export function col_fromoklab(L, A, B, out) {
    A -= 0.5; B -= 0.5;
    let l = L + 0.3963377774 * A + 0.2158037573 * B, m = L - 0.1055613458 * A - 0.0638541728 * B, s = L - 0.0894841775 * A - 1.2914855480 * B;
    l = l * l * l; m = m * m * m; s = s * s * s;
    const lr = Math.min(Math.max(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, 0), 1);
    const lg = Math.min(Math.max(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, 0), 1);
    const lb = Math.min(Math.max(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s, 0), 1);
    out[0] = fromLin(lr); out[1] = fromLin(lg); out[2] = fromLin(lb);
    return out;
}
