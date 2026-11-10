/**
 * Runs a compiled filter (compileFilter()) on the CPU — no GPU, no WebGL —
 * with the same interface as createFilterRunner:
 *
 *   const runner = createCpuRunner(compileFilter(def));
 *   runner.setImage(imageData);                 // ImageData, { data, width, height }, or in a browser an <img>/<canvas>/<video>
 *   runner.setImage('mask', maskImage);
 *   const out = runner.draw({ t: 0 });          // { data: Uint8ClampedArray, width, height }
 *   runner.draw({ t: 0, canvas });              // …and put it on a canvas
 *   runner.passes[0].values.cutoff = 0.3;       // knobs change without recompiling
 *
 * Works in Node too (thumbnails, servers, tests without a browser).
 *
 * draw() runs on the calling thread. drawAsync() spreads each pass's rows
 * over a pool of workers when the picture is large enough to be worth it
 * (≥ options.parallelFrom pixels, 250k by default); with SharedArrayBuffer
 * (Node, or a cross-origin isolated page) the workers read and write the
 * pictures in place, otherwise each gets a copy of the input and sends its
 * rows back. Both give the same pixels. The worker is cpu-worker.js beside this
 * module (options.workerUrl to put it elsewhere); from another origin — a CDN —
 * it is started through a same-origin blob: module that imports it. When no
 * worker can start, drawAsync() draws on the calling thread instead.
 *
 * Between passes the picture is rounded to 8 bits, as the GPU runner's
 * textures are, so both give the same pixels; { precision: 'float' } keeps
 * full precision instead (like 'float' textures on the GPU).
 */

import { compileCpuPass } from './cpu.js';

export function createCpuRunner(compiled, options = {}) {
    const precision = options.precision === 'float' || options.precision === 'half' ? 'float' : 'byte';
    const programs = compiled.passes.map((pass) => compileCpuPass(pass));
    const pictures = {};
    let source = null;
    const parallelFrom = options.parallelFrom ?? 250000;
    const wanted = options.workers === undefined || options.workers === 'auto' ? defaultWorkers() : Number(options.workers);
    let pool = null;           // created on the first drawAsync() that needs it
    let sent = new Map();      // picture name → the object last sent to the pool

    const runner = {
        passes: compiled.passes,
        get precision() { return precision; },
        /** The generated JavaScript of each pass, for the curious (and the tests). */
        sources: programs.map((p) => p.source),

        setImage(name, image) {
            if (typeof name !== 'string') { image = name; name = null; }
            const picture = toPicture(image);
            if (!name || name === 'source') source = picture;
            else pictures[name] = picture;
            return runner;
        },

        /** Runs every pass; returns the result as 8-bit RGBA (and draws it on `canvas` when given). */
        draw({ t = 0, canvas = null } = {}) {
            if (!source) throw new Error('setImage() first');
            const { width, height } = source;
            const n = width * height * 4;
            let input = source.data;
            const kept = [];
            compiled.passes.forEach((pass, i) => {
                for (let k = 0; k < pass.keepInput; k++) kept.push(input);
                const output = new Float32Array(n);
                if (pass.blendKept) {
                    const base = kept.pop();
                    const o = pass.opacity;
                    for (let j = 0; j < n; j++) output[j] = base[j] + (input[j] - base[j]) * o;
                } else {
                    programs[i].run({
                        input, output, source: source.data, width, height, t,
                        params: Object.keys(pass.params ?? {}).map((name) => pass.values[name]),
                        opacity: pass.opacity, pictures, placements: pass.placements ?? {},
                    });
                }
                if (precision === 'byte') quantize(output);
                input = output;
            });
            const data = new Uint8ClampedArray(n);
            for (let j = 0; j < n; j++) {
                const v = input[j];
                data[j] = v > 0 ? (v < 1 ? Math.round(v * 255) : 255) : 0;   // NaN → 0, as a GPU writes it
            }
            const out = { data, width, height };
            if (canvas) {
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
            }
            return out;
        },

        /**
         * As draw(), with each pass's rows spread over workers when the picture is large;
         * smaller pictures (or no workers available) run here, as draw().
         */
        async drawAsync({ t = 0, canvas = null } = {}) {
            if (!source) throw new Error('setImage() first');
            const { width, height } = source;
            if (wanted < 2 || width * height < parallelFrom) return runner.draw({ t, canvas });
            if (pool === null) pool = await createPool(wanted, compiled.passes, options.workerUrl).catch(() => false);   // false: workers can't start here
            if (!pool) return runner.draw({ t, canvas });
            const n = width * height * 4;
            const alloc = () => (pool.shared ? new Float32Array(new SharedArrayBuffer(n * 4)) : new Float32Array(n));
            // pictures the workers haven't seen (as shared copies when we can share)
            for (const [name, picture] of [['source', source], ...Object.entries(pictures)]) {
                if (sent.get(name) === picture) continue;
                await pool.broadcast({ type: 'picture', name, picture: pool.shared ? sharedPicture(picture) : picture });
                sent.set(name, picture);
            }
            let input = pool.shared ? sharedPicture(source).data : source.data;
            const kept = [];
            for (let i = 0; i < compiled.passes.length; i++) {
                const pass = compiled.passes[i];
                for (let k = 0; k < pass.keepInput; k++) kept.push(input);
                const output = alloc();
                if (pass.blendKept) {
                    const base = kept.pop();
                    for (let j = 0; j < n; j++) output[j] = base[j] + (input[j] - base[j]) * pass.opacity;
                    if (precision === 'byte') quantize(output);
                } else {
                    const params = Object.keys(pass.params ?? {}).map((name) => pass.values[name]);
                    const bands = splitRows(height, pool.size);
                    const replies = await Promise.all(bands.map(([y0, y1], k) => pool.ask(k, {
                        type: 'run', pass: i, input, output: pool.shared ? output : null, width, height, t, params,
                        opacity: pass.opacity, placements: pass.placements ?? {}, y0, y1, quantize: precision === 'byte',
                    })));
                    if (!pool.shared) replies.forEach((r, k) => output.set(r.band, bands[k][0] * width * 4));
                }
                input = output;
            }
            const data = new Uint8ClampedArray(n);
            for (let j = 0; j < n; j++) { const v = input[j]; data[j] = v > 0 ? (v < 1 ? Math.round(v * 255) : 255) : 0; }
            const out = { data, width, height };
            if (canvas) {
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
            }
            return out;
        },

        /** How many workers drawAsync() uses (0 until it first needs them). */
        get workers() { return pool ? pool.size : 0; },

        dispose() {
            source = null;
            for (const k of Object.keys(pictures)) delete pictures[k];
            if (pool) pool.close();
            pool = null;
            sent = new Map();
        },
    };
    return runner;
}

/** Clamp to 0–1 and round to 1/255: what an 8-bit texture keeps. */
function quantize(a) {
    for (let j = 0; j < a.length; j++) {
        const v = a[j];
        a[j] = v > 0 ? (v < 1 ? Math.round(v * 255) / 255 : 1) : 0;
    }
}

/** ImageData, { data, width, height } (8-bit or float), or a drawable in a browser → { data: Float32Array 0–1, width, height }. */
export function toPicture(image) {
    if (image && image.data && image.width && image.height) {
        const src = image.data;
        const scale = src instanceof Float32Array || src instanceof Float64Array ? 1 : 1 / 255;
        const data = new Float32Array(image.width * image.height * 4);
        for (let j = 0; j < data.length; j++) data[j] = src[j] * scale;
        return { data, width: image.width, height: image.height };
    }
    if (typeof document !== 'undefined' || typeof OffscreenCanvas !== 'undefined') {
        const width = image.naturalWidth || image.videoWidth || image.width;
        const height = image.naturalHeight || image.videoHeight || image.height;
        if (!width || !height) throw new Error('setImage: the picture has no size yet (not loaded?)');
        const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, width, height);
        return toPicture(ctx.getImageData(0, 0, width, height));
    }
    throw new Error('setImage: give ImageData or { data, width, height }');
}

// ---- the worker pool -------------------------------------------------------------------

function defaultWorkers() {
    const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
    return Math.max(0, Math.min(8, cores - 1));
}

/** Row bands [y0, y1) of about equal size, one per worker. */
export function splitRows(height, parts) {
    const out = [];
    for (let k = 0; k < parts; k++) {
        const y0 = Math.floor((height * k) / parts);
        const y1 = Math.floor((height * (k + 1)) / parts);
        if (y1 > y0) out.push([y0, y1]);
    }
    return out;
}

const canShare = () => typeof SharedArrayBuffer !== 'undefined' && (typeof crossOriginIsolated === 'undefined' || crossOriginIsolated === true);

function sharedPicture(picture) {
    if (picture.data.buffer instanceof (globalThis.SharedArrayBuffer ?? Object)) return picture;
    const data = new Float32Array(new SharedArrayBuffer(picture.data.byteLength));
    data.set(picture.data);
    picture.shared ??= { data, width: picture.width, height: picture.height };
    return picture.shared;
}

/** Workers that each compiled the filter; null when this platform can't start them. */
async function createPool(size, passes, workerUrl) {
    const url = new URL(workerUrl ?? './cpu-worker.js', import.meta.url);
    let make;
    if (typeof Worker !== 'undefined' && typeof window !== 'undefined') {
        // a worker script must come from the page's own origin: from a CDN, a blob: module that imports it does
        const start = url.origin === location.origin ? url
            : URL.createObjectURL(new Blob([`import ${JSON.stringify(url.href)};`], { type: 'text/javascript' }));
        make = () => {
            const w = new Worker(start, { type: 'module' });
            return { send: (m) => w.postMessage(m), on: (fn) => { w.onmessage = (e) => fn(e.data); w.onerror = (e) => fn({ id: -1, ok: false, error: e.message }); }, close: () => w.terminate() };
        };
    } else {
        try {
            const { Worker: NodeWorker } = await import('node:worker_threads');
            make = () => {
                const w = new NodeWorker(url);
                return { send: (m) => w.postMessage(m), on: (fn) => { w.on('message', fn); w.on('error', (e) => fn({ id: -1, ok: false, error: e.message })); }, close: () => w.terminate() };
            };
        } catch {
            return null;
        }
    }
    const workers = Array.from({ length: size }, make);
    let next = 1;
    const waiting = workers.map(() => new Map());
    workers.forEach((w, k) => w.on((m) => {
        if (m.id === -1) { for (const [, cb] of waiting[k]) cb.reject(new Error(m.error)); waiting[k].clear(); return; }
        const cb = waiting[k].get(m.id);
        if (!cb) return;
        waiting[k].delete(m.id);
        if (m.ok) cb.resolve(m); else cb.reject(new Error(m.error));
    }));
    const ask = (k, message) => new Promise((resolve, reject) => {
        const id = next++;
        waiting[k].set(id, { resolve, reject });
        workers[k].send({ ...message, id });
    });
    const pool = {
        size, shared: canShare(), ask,
        broadcast: (message) => Promise.all(workers.map((_, k) => ask(k, message))),
        close: () => workers.forEach((w) => w.close()),
    };
    await pool.broadcast({ type: 'init', passes: passes.map(({ fragment, ...rest }) => rest) });
    return pool;
}
