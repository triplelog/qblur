/**
 * Saving a result: a canvas or a picture ({ data, width, height }, what the
 * CPU runner and applyFilter() in Node return) as a file.
 *
 *   const blob = await toBlob(canvas, { type: 'image/jpeg', quality: 0.9 });
 *   const png = await toBlob(picture);                        // PNG in Node too: no canvas needed
 *   const gif = await encodeGif(frames, { gifenc, delay: 40 });   // bring your own gifenc
 *
 * PNG is written by the package itself (src/png.js: indexed when the picture
 * has at most 256 colours, RGB when nothing is transparent), so it works
 * anywhere CompressionStream does — every current browser and Node ≥ 18.
 * JPEG and WebP need the browser's encoder (a canvas). GIF needs a colour
 * quantizer and an LZW encoder; the package has no dependencies, so
 * encodeGif() takes gifenc (npm i gifenc) as an option rather than bundling it.
 */

import { encodePng } from './png.js';

const isPicture = (v) => v && v.data && Number.isFinite(v.width) && Number.isFinite(v.height) && typeof v.getContext !== 'function';

/** The RGBA bytes of a canvas or a picture (8-bit, or 0–1 floats as the CPU runner keeps them). */
export function pictureData(what) {
    if (isPicture(what)) {
        const { data, width, height } = what;
        if (data instanceof Uint8ClampedArray || data instanceof Uint8Array) return { data, width, height };
        const out = new Uint8ClampedArray(width * height * 4);
        const scale = data instanceof Float32Array || data instanceof Float64Array ? 255 : 1;
        for (let j = 0; j < out.length; j++) out[j] = Math.round(data[j] * scale);
        return { data: out, width, height };
    }
    if (what && typeof what.getContext === 'function') {
        const ctx = what.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('This canvas has a WebGL context: pass the 2D canvas applyFilter() returned, or copy it onto one first');
        return ctx.getImageData(0, 0, what.width, what.height);
    }
    throw new Error('Give a canvas or a picture ({ data, width, height })');
}

/** A canvas (HTMLCanvasElement or OffscreenCanvas) holding the picture; null where there is none (Node). */
function canvasOf(picture) {
    const { width, height } = picture;
    let canvas = null;
    if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(width, height);
    else if (typeof document !== 'undefined') canvas = Object.assign(document.createElement('canvas'), { width, height });
    if (!canvas) return null;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(picture.data), width, height), 0, 0);
    return canvas;
}

/**
 * The picture as a file.
 * @param {HTMLCanvasElement|OffscreenCanvas|{ data, width, height }} what
 * @param {{ type?: string, quality?: number, palette?: 'auto' | 'none' }} [options]
 *   type: 'image/png' (the default), 'image/jpeg' or 'image/webp' (browser only); quality 0–1 for the last two.
 *   palette (PNG): 'auto' writes an indexed PNG when there are at most 256 colours, 'none' never does.
 * @returns {Promise<Blob>}
 */
export async function toBlob(what, { type = 'image/png', quality, palette = 'auto' } = {}) {
    if (type === 'image/png') {
        const png = await encodePng({ ...pictureData(what), palette });
        if (png) return png.blob;
    }
    const canvas = isPicture(what) ? canvasOf(pictureData(what)) : what;
    if (!canvas) throw new Error(`Saving as ${type} needs a browser (a canvas encodes it); in Node, save as image/png`);
    if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
    return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(`The browser could not encode ${type}`))), type, quality));
}

/**
 * An animated GIF from frames (canvases or pictures, all one size), each `delay` ms.
 * Needs gifenc: `import * as gifenc from 'gifenc'` and pass it as `{ gifenc }`.
 * Each frame gets its own palette of up to `colours` colours.
 * @param {Iterable|AsyncIterable} frames
 * @param {{ gifenc: object, delay?: number, repeat?: number, colours?: number }} options
 * @returns {Promise<Blob>}
 */
export async function encodeGif(frames, { gifenc, delay = 1000 / 30, repeat = 0, colours = 256 } = {}) {
    const G = gifenc && (gifenc.GIFEncoder ? gifenc : gifenc.default);
    if (!G || typeof G.GIFEncoder !== 'function') throw new Error('encodeGif needs gifenc: import * as gifenc from \'gifenc\' and pass { gifenc }');
    const encoder = G.GIFEncoder();
    let size = null;
    let count = 0;
    for await (const frame of frames) {
        let { data, width, height } = pictureData(frame);
        if (data.byteOffset || data.byteLength !== data.buffer.byteLength) data = data.slice();   // gifenc reads the whole buffer
        if (size && (size[0] !== width || size[1] !== height)) throw new Error(`Frame ${count + 1} is ${width} × ${height}; the first was ${size[0]} × ${size[1]}`);
        size = [width, height];
        const transparent = hasTransparency(data);
        const format = transparent ? 'rgba4444' : 'rgb565';
        const palette = G.quantize(data, Math.max(2, Math.min(256, colours)), { format, oneBitAlpha: transparent });
        const index = G.applyPalette(data, palette, format);
        const options = { palette, delay: Math.round(delay), repeat };
        if (transparent) {
            const k = palette.findIndex((c) => c.length > 3 && c[3] === 0);
            if (k >= 0) Object.assign(options, { transparent: true, transparentIndex: k });
        }
        encoder.writeFrame(index, width, height, options);
        count++;
    }
    if (!count) throw new Error('encodeGif: no frames');
    encoder.finish();
    return new Blob([encoder.bytes()], { type: 'image/gif' });
}

function hasTransparency(data) {
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
    return false;
}
