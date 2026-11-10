/**
 * One call: a picture and a filter in, the filtered picture out.
 *
 *   const canvas = await applyFilter(img, '1 - rgb');                       // maths
 *   const canvas = await applyFilter(img, 'Sepia');                         // a built-in filter, by name
 *   const canvas = await applyFilter(img, 'Threshold', { params: { cutoff: 0.3 } });
 *   const picture = await applyFilter(imageData, filterDoc);                // in Node: { data, width, height }
 *
 * `filter` is maths, a filter document, JSON or a share link (readFilter), a
 * compiled filter (compileFilter), or the name of a filter in LIBRARY. The
 * result is the picture's size — up to a limit: a picture longer than
 * `maxSize` on its long side (MAX_SIZE, 4096 px, on the GPU; MAX_SIZE_CPU,
 * 2048 px, on the CPU, which is far slower and holds four floats a pixel) is
 * scaled down to it first, keeping its shape, and so are the other pictures
 * in `images`. A bigger `maxSize` keeps more, up to what the GPU can hold. In
 * a page the result is a 2D canvas (`canvas`, or a new one); in a worker an
 * OffscreenCanvas; in Node, where there is no canvas, a picture
 * { data: Uint8ClampedArray, width, height }.
 *
 * The GPU draws when WebGL is there (engine 'auto'), the CPU otherwise — the
 * same pixels either way. The GPU work happens on one hidden WebGL canvas the
 * module keeps (browsers allow only a few contexts), and a filter's shaders
 * are compiled once and kept for the next call with the same filter (the
 * same maths or document — by what it says, so a changed document is a new
 * filter — or the same compiled filter, whose knob values are read again on
 * every call). Calls run one at a time, in the order they were made.
 */

import { compileFilter, readFilter, filterToJSON } from './format.js';
import { createRunner } from './auto.js';
import { renderGraphics } from './graphics.js';
import { LIBRARY } from './library.js';

const hasCanvas = () => typeof document !== 'undefined' || typeof OffscreenCanvas !== 'undefined';
const newCanvas = (width, height) => (typeof document !== 'undefined'
    ? Object.assign(document.createElement('canvas'), { width, height })
    : new OffscreenCanvas(width, height));

/** A filter in any of its forms → the compiled filter (not yet copied). */
export function toCompiled(filter) {
    if (filter && typeof filter === 'object' && Array.isArray(filter.passes)) return filter;   // (isCompiled, below)
    if (typeof filter === 'string') {
        const named = LIBRARY.find((f) => f.name.toLowerCase() === filter.trim().toLowerCase());
        return compileFilter(named ?? readFilter(filter));
    }
    return compileFilter(filter);
}

/** The longest side applyFilter draws on the GPU, and on the CPU; a bigger picture is scaled down to it (option `maxSize`). */
export const MAX_SIZE = 4096;
export const MAX_SIZE_CPU = 2048;

const isPlain = (image) => Boolean(image && image.data && image.width && image.height) && !(typeof ImageData !== 'undefined' && image instanceof ImageData);
const toImageData = (p) => (typeof ImageData !== 'undefined' && p instanceof ImageData ? p : new ImageData(
    p.data instanceof Uint8ClampedArray ? p.data : Uint8ClampedArray.from(p.data, p.data instanceof Float32Array || p.data instanceof Float64Array ? (v) => v * 255 : undefined),
    p.width, p.height));

/** The picture at most `limit` on its long side: itself when it fits, else a smaller copy (a canvas, or in Node a picture). */
function fit(image, width, height, limit) {
    const k = Math.min(1, limit / Math.max(width, height));
    if (k >= 1) return { image, width, height };
    const W = Math.max(1, Math.round(width * k)), H = Math.max(1, Math.round(height * k));
    if (hasCanvas()) {
        let source = image;
        if (isPlain(image) || (typeof ImageData !== 'undefined' && image instanceof ImageData)) {
            source = newCanvas(width, height);
            source.getContext('2d').putImageData(toImageData(image), 0, 0);
        }
        const out = newCanvas(W, H), ctx = out.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, 0, 0, W, H);
        return { image: out, width: W, height: H };
    }
    // no canvas (Node): each new pixel is the average of the pixels it covers
    const src = image.data, out = new src.constructor(W * H * 4);
    for (let Y = 0; Y < H; Y++) {
        const y0 = Math.floor((Y * height) / H), y1 = Math.max(y0 + 1, Math.floor(((Y + 1) * height) / H));
        for (let X = 0; X < W; X++) {
            const x0 = Math.floor((X * width) / W), x1 = Math.max(x0 + 1, Math.floor(((X + 1) * width) / W));
            const sum = [0, 0, 0, 0];
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 4; c++) sum[c] += src[(y * width + x) * 4 + c];
            const n = (y1 - y0) * (x1 - x0);
            for (let c = 0; c < 4; c++) out[(Y * W + X) * 4 + c] = sum[c] / n;
        }
    }
    return { image: { data: out, width: W, height: H }, width: W, height: H };
}

const isImg = (image) => typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement;
const pictureSize = (image) => (isImg(image) && !(image.complete && image.naturalWidth) ? [0, 0] : [   // an <img>'s width attribute is not a picture
    image.naturalWidth || image.videoWidth || image.displayWidth || image.width || 0,
    image.naturalHeight || image.videoHeight || image.displayHeight || image.height || 0,
]);
const isCompiled = (filter) => Boolean(filter) && typeof filter === 'object' && Array.isArray(filter.passes);
const isColor = (v) => (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length === 3 && [...v].every((n) => Number.isFinite(Number(n)));

// ---- the shared WebGL canvas -------------------------------------------------------------

let shared = null;                     // { canvas, gl, runners: Map(key → { compiled, runner, engine }) }
const byObject = new WeakMap();        // compiled filter → its key

function sharedGl() {
    if (shared && !shared.gl.isContextLost()) return shared;
    if (!hasCanvas()) return null;
    const canvas = newCanvas(1, 1);
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false });
    shared = gl ? { canvas, gl, runners: new Map() } : null;
    return shared;
}

let nextKey = 0;
/** What a kept runner is found by: the text, what a document says, or which compiled filter it is. */
function keyOf(filter) {
    if (typeof filter === 'string') return `s:${filter}`;
    if (isCompiled(filter)) {
        if (!byObject.has(filter)) byObject.set(filter, `c:${nextKey++}`);
        return byObject.get(filter);
    }
    if (filter && typeof filter === 'object') { try { return `d:${filterToJSON(filter)}`; } catch { return null; } }
    return null;
}

/** A copy whose knob values can change without touching the caller's compiled filter. */
const copyOf = (compiled) => ({ ...compiled, passes: compiled.passes.map((p) => ({ ...p, values: { ...p.values } })) });

function runnerFor(filter, engine, gl) {
    const key = keyOf(filter) && `${engine}|${keyOf(filter)}`;
    const cache = shared?.runners;
    if (gl && key && cache?.has(key)) {
        const entry = cache.get(key);
        cache.delete(key);                                       // used again: the last to go
        cache.set(key, entry);
        return entry;
    }
    const source = toCompiled(filter);
    const compiled = copyOf(source);
    const made = createRunner(compiled, { gl, prefer: engine });
    // a compiled filter is the caller's: its knob values and opacities are read on every call; anything else starts from its own
    const entry = { compiled, source: isCompiled(filter) ? source : copyOf(source), ...made };
    if (gl && key && made.engine === 'gpu') {
        cache.set(key, entry);
        if (cache.size > 16) {                               // the one unused longest goes
            const [oldest, old] = cache.entries().next().value;
            cache.delete(oldest);
            old.runner.dispose();
        }
    }
    return entry;
}

let queue = Promise.resolve();         // one drawing at a time: they share the canvas, and a filter's runner

/**
 * @param {CanvasImageSource|ImageData|{ data, width, height }} image the picture (loaded)
 * @param {string|object} filter maths, a filter document, JSON, a link, a compiled filter, or a LIBRARY name
 * @param {object} [options]
 *   params  { name: value } — knob values (a colour is [r, g, b], 0–1); the rest keep their defaults.
 *           In a chain, every step with a knob of that name takes it.
 *   t       the frame, for filters that move (default 0)
 *   images  { name: picture } — the other pictures the filter asks for (compiled.images)
 *   engine  'auto' (default) | 'gpu' | 'cpu'
 *   canvas  a 2D canvas to draw on (resized to the picture); otherwise a new one
 *   maxSize the longest side drawn (default MAX_SIZE on the GPU, MAX_SIZE_CPU on the CPU); bigger pictures are scaled down
 * @returns {Promise<HTMLCanvasElement|OffscreenCanvas|{ data: Uint8ClampedArray, width: number, height: number }>}
 */
export function applyFilter(image, filter, options = {}) {
    const run = queue.then(() => apply(image, filter, options));
    queue = run.catch(() => {});
    return run;
}

async function apply(picture, filter, { params = {}, t = 0, images = {}, engine = 'auto', canvas = null, maxSize = null } = {}) {
    if (!picture) throw new Error('applyFilter: no picture');
    const [fullWidth, fullHeight] = pictureSize(picture);
    if (!fullWidth || !fullHeight) throw new Error('applyFilter: the picture has no size yet (not loaded?)');
    if (maxSize !== null && !(Number(maxSize) >= 1)) throw new Error(`applyFilter: maxSize is a number of pixels, not ${JSON.stringify(maxSize)}`);
    if (engine !== 'auto' && engine !== 'gpu' && engine !== 'cpu') throw new Error(`applyFilter: engine is 'auto', 'gpu' or 'cpu', not "${engine}"`);
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (canvas && !ctx) throw new Error('applyFilter: `canvas` must be a 2D canvas (this one already has another kind of context)');
    const gpu = engine !== 'cpu' ? sharedGl() : null;
    if (engine === 'gpu' && !gpu) throw new Error('applyFilter: no WebGL here (use engine "auto" or "cpu")');
    const entry = runnerFor(filter, engine === 'gpu' ? 'gpu' : gpu ? 'auto' : 'cpu', gpu?.gl);
    const { compiled, source, runner } = entry;
    const kept = entry.engine === 'gpu';                          // a kept runner (the GPU's); the CPU's is this call's alone
    // the size drawn: the picture's, up to the limit (and never more than the GPU can hold)
    const limit = kept ? Math.min(Number(maxSize ?? MAX_SIZE), gpu.gl.getParameter(gpu.gl.MAX_TEXTURE_SIZE) || MAX_SIZE) : Number(maxSize ?? MAX_SIZE_CPU);
    const { image, width, height } = fit(picture, fullWidth, fullHeight, limit);
    try {
        // knobs: back to the filter's own values, then the ones asked for
        const known = new Map(compiled.passes.flatMap((p) => Object.entries(p.params ?? {})));
        for (const [name, value] of Object.entries(params)) {
            if (!known.has(name)) throw new Error(`applyFilter: the filter has no knob called "${name}" (it has ${[...known.keys()].join(', ') || 'none'})`);
            if (known.get(name).type === 'color' ? !isColor(value) : !Number.isFinite(Number(value)) || typeof value === 'object' || value === '') {
                throw new Error(`applyFilter: the knob "${name}" needs ${known.get(name).type === 'color' ? 'a colour, [r, g, b] with each 0–1' : 'a number'}, not ${JSON.stringify(value)}`);
            }
        }
        // the filter's graphics (text, shapes, strokes) are drawn first: nothing below waits, so a kept runner is set and drawn in one go
        const graphics = Object.entries(compiled.graphics ?? {});
        let drawn = {};
        if (graphics.length) {
            const needCanvas = graphics.filter(([, g]) => g.type !== 'strokes').map(([key]) => key);
            if (!hasCanvas() && needCanvas.length) throw new Error(`applyFilter: this filter draws ${needCanvas.join(', ')} (text or shapes), which needs a canvas — there is none here`);
            drawn = await renderGraphics(compiled, width, height, { t: Number.isFinite(t) ? t : Infinity });
        }
        compiled.passes.forEach((pass, i) => {
            pass.values = { ...source.passes[i].values };
            pass.opacity = source.passes[i].opacity;
            for (const [name, value] of Object.entries(params)) {
                if (name in (pass.params ?? {})) pass.values[name] = pass.params[name].type === 'color' ? [...value].map(Number) : Number(value);
            }
        });
        runner.setImage(image);
        for (const [name, other] of Object.entries(images)) {
            const [w, h] = pictureSize(other);
            runner.setImage(name, w && h ? fit(other, w, h, limit).image : other);
        }
        for (const [key, picture] of Object.entries(drawn)) runner.setImage(key, picture);

        if (kept) {
            gpu.canvas.width = width;
            gpu.canvas.height = height;
            runner.draw({ t });
            const out = canvas ?? newCanvas(width, height);
            out.width = width;
            out.height = height;
            const to = ctx ?? out.getContext('2d');
            to.clearRect(0, 0, width, height);
            to.drawImage(gpu.canvas, 0, 0);
            return out;
        }
        const picture = await runner.drawAsync({ t });          // big pictures: rows spread over workers
        if (!hasCanvas() && !canvas) return picture;
        const out = canvas ?? newCanvas(width, height);
        out.width = width;
        out.height = height;
        (ctx ?? out.getContext('2d')).putImageData(new ImageData(picture.data, width, height), 0, 0);
        return out;
    } finally {
        if (!kept) runner.dispose();                             // its workers too, whatever happened
    }
}
