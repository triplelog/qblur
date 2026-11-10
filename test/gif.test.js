import { suite, test, eq } from './harness.js';
import { decodeGif } from '../demo/gif.js';
import { GIFEncoder, quantize, applyPalette } from 'gifenc/dist/gifenc.esm.js';

// A GIF made by the encoder the editor uses, read back by the decoder it uses.
function makeGif(frames, w, h, delays) {
    const gif = GIFEncoder();
    frames.forEach((rgba, i) => {
        const palette = quantize(rgba, 256);
        gif.writeFrame(applyPalette(rgba, palette), w, h, { palette, delay: delays[i] });
    });
    gif.finish();
    return gif.bytes().buffer;
}

function picture(w, h, paint) {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = paint(x, y); rgba.set([r, g, b, 255], (y * w + x) * 4); }
    return rgba;
}

suite('GIF decoding', () => {
    test('frames, sizes and delays come back', () => {
        const w = 37, h = 23;      // not multiples of anything, to catch stride mistakes
        const a = picture(w, h, (x, y) => [x * 6, y * 10, 40]);
        const b = picture(w, h, (x, y) => [200, (x + y) * 3, 90]);
        const gif = decodeGif(makeGif([a, b], w, h, [100, 250]));
        eq([gif.width, gif.height, gif.frames.length, gif.loop], [w, h, 2, 0]);
        eq(gif.frames.map((f) => f.delay), [100, 250]);
        let maxDiff = 0;
        for (const [frame, source] of [[gif.frames[0], a], [gif.frames[1], b]]) {
            for (let i = 0; i < source.length; i++) maxDiff = Math.max(maxDiff, Math.abs(frame.data[i] - source[i]));
        }
        if (maxDiff > 12) throw new Error(`pixels off by up to ${maxDiff} after quantizing to 256 colours`);   // 256 colours of a smooth gradient
    });
    test('a GIF with few colours decodes exactly', () => {
        const w = 64, h = 64;
        const a = picture(w, h, (x, y) => ((x >> 3) + (y >> 3)) % 2 ? [255, 0, 0] : [0, 0, 255]);
        const { frames } = decodeGif(makeGif([a], w, h, [50]));
        for (let i = 0; i < a.length; i++) if (frames[0].data[i] !== a[i]) throw new Error(`pixel ${i >> 2} differs`);
        eq(frames[0].delay, 50);
    });
    test('not a GIF, and a tiny delay', () => {
        let threw = false;
        try { decodeGif(new Uint8Array([1, 2, 3]).buffer); } catch { threw = true; }
        eq(threw, true);
        const w = 2, h = 2;
        const { frames } = decodeGif(makeGif([picture(w, h, () => [1, 2, 3])], w, h, [0]));
        eq(frames[0].delay, 100);          // 0 means "as fast as possible"; browsers show 100 ms
    });
});
