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

export function decodeGif(buffer) {
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
