/**
 * The editor's PNG writer: the package's (src/png.js — indexed PNG-8 when the
 * picture has few colours, RGB when nothing is transparent, Paeth rows) with
 * gifenc's quantizer for palette 'force', which the package leaves to the caller.
 *
 *   const { blob, kind, colours, bits } = await encodePng({ width, height, data, palette: 'auto', colours: 256, dither: true });
 */
import * as G from 'gifenc';
import { encodePng as encode, colourCount, exactPalette } from '../src/png.js';

const { quantize, applyPalette } = G.quantize ? G : G.default;

export { colourCount, exactPalette };

/** As the package's encodePng, with quantizedPalette for palette 'force'. */
export const encodePng = (o) => encode({ quantize: quantizedPalette, ...o });

/** The picture reduced to `colours` colours (gifenc's quantizer), optionally Floyd–Steinberg dithered. */
export function quantizedPalette(data, colours, { dither = true, width = 0 } = {}) {
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

