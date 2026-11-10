/**
 * A worker for createCpuRunner's drawAsync(): it compiles the filter's
 * passes itself (through the same whitelist gate), keeps the pictures it
 * is sent, and runs one pass over a band of rows when asked.
 *
 * Works as a browser module worker and as a Node worker_thread.
 */

import { compileCpuPass } from './cpu.js';

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
