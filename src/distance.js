/**
 * `away`: how far each pixel is from the selection, in pixels — 0 inside it, and 0 everywhere when nothing is selected.
 *
 * The runners make it themselves from the picture given as `selection`, and only for a filter that uses `away`
 * (runner.setImage('away', …) gives one made elsewhere instead). The distance is the exact Euclidean distance transform
 * of Felzenszwalb & Huttenlocher: a pass down each column, then one across each row, each linear in the pixels. A
 * selection is measured at most AWAY_SIZE pixels on its long side (about 12 ms for 512 × 512), the distances scaled
 * back to the selection's own pixels — the frame's, normally.
 *
 * The picture holds it in 8-bit channels, white where it is 0 (so a picture not given — white — means "0 everywhere"):
 *   red   = 1 − min(d, 255) / 255     near: whole pixels up to 255 away
 *   green = 1 − min(d, 1020) / 1020   far: 4-pixel steps up to 1020 away
 *   blue  = 1 − min(d_in, 255) / 255  inside the selection: how far from its edge
 * and the shader reads `away` = red > 0 ? 255 (1 − red) : 1020 (1 − green) (mathzetta/glsl's filterShader; src/cpu.js).
 */

const INF = 1e20;
/** The largest side a selection is measured at (the distances are scaled back up). */
export const AWAY_SIZE = 512;

/** 1-D squared distance transform of f (n values) into d, with scratch v (Int32Array n) and z (Float64Array n + 1). */
function edt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
        const fq = f[q] + q * q;
        let p = v[k], s = (fq - (f[p] + p * p)) / (2 * (q - p));
        while (s <= z[k]) { k--; p = v[k]; s = (fq - (f[p] + p * p)) / (2 * (q - p)); }   // never below 0: INF is finite, so s > -INF
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++;
        const p = v[k];
        d[q] = (q - p) * (q - p) + f[p];
    }
}

/**
 * Distance (in pixels) from every pixel to the nearest pixel where `inside(i)` is true; 0 on the shape.
 * `inside` is a function of the pixel index, or a typed array (non-zero = on the shape). Infinity when there is no shape.
 */
export function distanceTo(inside, width, height) {
    const on = typeof inside === 'function' ? inside : (i) => inside[i] !== 0;
    const n = Math.max(width, height);
    const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    const grid = new Float64Array(width * height);
    for (let i = 0; i < grid.length; i++) grid[i] = on(i) ? 0 : INF;
    for (let x = 0; x < width; x++) {                    // down each column
        for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
        edt1d(f, height, d, v, z);
        for (let y = 0; y < height; y++) grid[y * width + x] = d[y];
    }
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {                   // then across each row
        const row = y * width;
        for (let x = 0; x < width; x++) f[x] = grid[row + x];
        edt1d(f, width, d, v, z);
        for (let x = 0; x < width; x++) out[row + x] = d[x] >= INF / 2 ? Infinity : Math.sqrt(d[x]);
    }
    return out;
}

/**
 * The `away` picture from a mask's pixels (`data`: 4 per pixel, bytes 0–255 or floats 0–1; on the shape where `channel` —
 * 0, red, as `selected` reads it — is at least half). `scale` multiplies the distances (a mask measured at half size: 2).
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
export function encodeAway(data, width, height, { channel = 0, scale = 1 } = {}) {
    const half = data instanceof Float32Array || data instanceof Float64Array ? 0.5 : 128;
    const at = (i) => data[i * 4 + channel] >= half;
    const out = distanceTo(at, width, height);
    const inn = distanceTo((i) => !at(i), width, height);
    const px = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
        const d = out[i] * scale, e = inn[i] * scale;
        px[j] = 255 - Math.min(d, 255);
        px[j + 1] = 255 - Math.min(d, 1020) / 4;
        px[j + 2] = 255 - Math.min(e, 255);
        px[j + 3] = 255;
    }
    return { data: px, width, height };
}

/** `away` (in pixels) back from the picture's channels, 0–1 — what the shader and the CPU runner compute. */
export const awayFromChannels = (red, green) => (red > 0 ? 255 * (1 - red) : 1020 * (1 - green));

/**
 * The `away` picture for a selection: ImageData, { data, width, height } (bytes or floats), or in a browser an
 * <img>/<canvas>/<video>/ImageBitmap; null for none (then `away` is 0 everywhere). Measured at most `size` on the long side.
 */
export function awayPicture(selection, { size = AWAY_SIZE } = {}) {
    if (!selection) return null;
    const W = selection.naturalWidth || selection.videoWidth || selection.width, H = selection.naturalHeight || selection.videoHeight || selection.height;
    if (!W || !H) return null;
    const k = Math.min(1, size / Math.max(W, H)), w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
    let data;
    if (selection.data && !(typeof HTMLElement !== 'undefined' && selection instanceof HTMLElement)) {
        data = selection.data;
        if (w !== W || h !== H) {                                       // nearest pixel: a mask, so no need to average
            const small = new (data.constructor)(w * h * 4);
            for (let y = 0; y < h; y++) {
                const sy = Math.min(H - 1, Math.floor(((y + 0.5) * H) / h));
                for (let x = 0; x < w; x++) {
                    const sx = Math.min(W - 1, Math.floor(((x + 0.5) * W) / w)), from = (sy * W + sx) * 4, to = (y * w + x) * 4;
                    for (let c = 0; c < 4; c++) small[to + c] = data[from + c];
                }
            }
            data = small;
        }
    } else {
        const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
        const g = canvas.getContext('2d', { willReadFrequently: true });
        g.drawImage(selection, 0, 0, w, h);
        data = g.getImageData(0, 0, w, h).data;
    }
    return encodeAway(data, w, h, { scale: W / w });
}

/** Whether a compiled filter (compileFilter()) reads `away`. */
export const usesAway = (compiled) => compiled.passes.some((pass) => pass.images?.includes('away'));

/**
 * For a filter that reads `away`: the runner makes its picture from each `selection` it is given (and drops it with the
 * selection), unless the page gives one itself — runner.setImage('away', picture); setImage('away', null) goes back to
 * making it. Other runners are returned untouched.
 */
export function deriveAway(runner, compiled) {
    if (!usesAway(compiled)) return runner;
    const set = runner.setImage.bind(runner);
    let given = false, selection = null;
    runner.setImage = (name, image) => {
        if (name === 'away') {
            given = image != null;
            return set('away', given ? image : awayPicture(selection));
        }
        set(name, image);
        if (name === 'selection') {
            selection = image ?? null;
            if (!given) set('away', awayPicture(selection));
        }
        return runner;
    };
    return runner;
}
