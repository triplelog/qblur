import { inflateSync } from 'node:zlib';
import { suite, test, eq } from './harness.js';
import { encodePng, colourCount, exactPalette, quantizedPalette } from '../demo/png.js';

// The harness is synchronous, so every PNG is written up here, then the tests look at them.

/** The chunks of a PNG, and its IDAT inflated to the filtered scanlines. */
async function parsePng(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunks = [];
    const idat = [];
    for (let at = 8; at < bytes.length;) {
        const view = new DataView(bytes.buffer, at);
        const length = view.getUint32(0);
        const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
        const data = bytes.subarray(at + 8, at + 8 + length);
        chunks.push({ type, data });
        if (type === 'IDAT') idat.push(data);
        at += 12 + length;
    }
    const ihdr = chunks[0].data;
    const view = new DataView(ihdr.buffer, ihdr.byteOffset);
    const header = { width: view.getUint32(0), height: view.getUint32(4), bits: ihdr[8], type: ihdr[9] };
    return { signature: [...bytes.subarray(0, 8)], chunks, header, rows: new Uint8Array(inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))))) };
}

const picture = (w, h, paint) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(paint(x, y), (y * w + x) * 4);
    return data;
};

const W = 37, H = 11;
const checker = await encodePng({ width: W, height: H, data: picture(W, H, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255])) });
const checkerPng = await parsePng(checker.blob);
const sixteen = await encodePng({ width: 20, height: 20, data: picture(20, 20, (x) => [Math.min(15, x) * 17, 0, 0, 255]) });
const manyData = picture(20, 20, (x, y) => [x * 12, y * 12, (x * y) % 256, 255]);
const many = await encodePng({ width: 20, height: 20, data: manyData });
const manyPng = await parsePng(many.blob);
const alpha = await encodePng({ width: 20, height: 20, data: picture(20, 20, (x, y) => [x * 12, y * 12, (x * y) % 256, x * 10]) });
const alphaPng = await parsePng(alpha.blob);
const holes = await parsePng((await encodePng({ width: 8, height: 8, data: picture(8, 8, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 0])) })).blob);
const gradient = picture(32, 32, (x, y) => [x * 8, y * 8, 128, 255]);
const plain = quantizedPalette(gradient, 16, { dither: false, width: 32 });
const dithered = quantizedPalette(gradient, 16, { dither: true, width: 32 });
const forced = await encodePng({ width: 32, height: 32, data: gradient, palette: 'force', colours: 16 });
const auto = await encodePng({ width: 32, height: 32, data: gradient, palette: 'auto' });

suite('PNG writer', () => {
    test('two colours become a 1-bit indexed PNG', () => {
        eq(checkerPng.signature, [137, 80, 78, 71, 13, 10, 26, 10]);
        eq([checker.kind, checker.colours, checker.bits], ['palette', 2, 1]);
        eq(checkerPng.chunks.map((c) => c.type), ['IHDR', 'PLTE', 'IDAT', 'IEND']);
        eq([checkerPng.header.width, checkerPng.header.height, checkerPng.header.bits, checkerPng.header.type], [W, H, 1, 3]);
        eq(checkerPng.rows.length, H * (1 + Math.ceil(W / 8)));
        eq(checkerPng.rows[0], 0);                                                  // filter: none
        if (checker.blob.size > 200) throw new Error(`${checker.blob.size} bytes for a 1-bit checkerboard`);
    });
    test('up to 16 colours is 4-bit; more than 256 is truecolour RGB; alpha makes it RGBA', () => {
        eq([sixteen.kind, sixteen.bits], ['palette', 4]);
        eq([many.kind, many.bits], ['rgb', 8]);
        eq([manyPng.header.type, manyPng.rows.length, manyPng.rows[0]], [2, 20 * (1 + 20 * 3), 4]);     // RGB, Paeth-filtered rows
        eq([alpha.kind, alphaPng.header.type], ['rgba', 6]);
    });
    test('a transparent palette entry writes tRNS', () => {
        eq(holes.chunks.map((c) => c.type), ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
    });
    test('forcing a palette quantizes, with or without dithering', () => {
        eq(colourCount(gradient) > 256, true);
        eq(exactPalette(gradient), null);
        eq(plain.palette.length <= 16 && dithered.palette.length <= 16, true);
        let differ = 0;
        for (let i = 0; i < plain.indices.length; i++) if (plain.indices[i] !== dithered.indices[i]) differ++;
        if (differ === 0) throw new Error('dithering changed nothing');
        eq([forced.kind, forced.bits, forced.colours <= 16], ['palette', 4, true]);
        eq(auto.kind, 'rgb');
    });
});
