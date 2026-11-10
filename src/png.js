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
export function colourCount(data, limit = 257) {
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4) {
        seen.add(((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0);
        if (seen.size >= limit) return seen.size;
    }
    return seen.size;
}

/** Every colour as it is, when there are at most 256: { palette: [[r, g, b, a]…], indices }. */
export function exactPalette(data) {
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
export async function encodePng({ width, height, data, palette = 'auto', colours = 256, dither = true, quantize = null }) {
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
