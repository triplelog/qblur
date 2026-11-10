/**
 * Finding objects with a neural network, in the browser — served by this
 * site itself: no Hugging Face, no CDN. Several models, to compare (all
 * Apache-2.0, demo/models/NOTICE):
 *
 *   rfdetr-small   RF-DETR-Seg Small: every object of 80 common kinds (people, cars, dogs, cups…),
 *                  labelled and outlined, in one pass; click one to take it
 *   rfdetr-nano    the same, smaller input: faster, a little less sure, finer things missed
 *   mobilesam      MobileSAM (Segment Anything): no list — click anything and it is outlined
 *   magictouch     MediaPipe's MagicTouch: click anything (small)
 *   magictouch2    MagicTouch 2: looks at the picture once, then clicks are quick
 *
 * The ONNX models run in ONNX Runtime Web (its WebAssembly build: ort/ on
 * the site), MagicTouch in MediaPipe's runtime (mediapipe/). Nothing loads
 * until "find objects" is used; then the browser caches it.
 *
 *   const ai = setupAI({ source: () => canvas, onProgress });
 *   ai.setModel('mobilesam');
 *   const boxes = await ai.detect();                                   // [{ label, score, box }] — [] for the click-anything models
 *   await ai.embed(otherFrame);                                         // look at another picture (a frame of a video)
 *   const mask = await ai.mask({ points: [[x, y]], labels: [1], box }); // Uint8Array, 1 inside, at the picture's size
 *
 * mask(): points labelled 1 are in the object, 0 are not; a box says
 * roughly where it is (the tracker's "fix red frames" uses that).
 */
import { loadDetector } from './rfdetr.js';
import { loadSam } from './sam.js';

export const AI_MODELS = {
    'rfdetr-small': { name: 'RF-DETR Small', kind: 'objects', about: 'finds 80 kinds of thing, labelled — 41 MB', files: ['models/rfdetr-seg-small.onnx'], size: 576 },
    'rfdetr-nano': { name: 'RF-DETR Nano', kind: 'objects', about: 'the same, faster, less detail — 37 MB', files: ['models/rfdetr-seg-nano.onnx'], size: 312 },
    mobilesam: { name: 'MobileSAM', kind: 'anything', about: 'click anything — 19 MB', files: ['models/mobilesam-encoder.onnx', 'models/mobilesam-decoder.onnx'] },
    magictouch: { name: 'MagicTouch', kind: 'anything', about: 'click anything, small — 6 MB', files: ['models/magic_touch.tflite'] },
    magictouch2: { name: 'MagicTouch 2', kind: 'anything', about: 'click anything — 31 MB', files: ['models/magic_touch_2.task'] },
};
/**
 * What the built site carries (tools/build.mjs copies only these models; the first is the default): MobileSAM, as every
 * file must stay under 25 MiB to be hosted on Cloudflare Pages (RF-DETR Small is 39 MB). The others stay in demo/models/
 * to compare in development.
 */
export const SHIPPED_MODELS = ['mobilesam'];
export const DEFAULT_MODEL = SHIPPED_MODELS[0];
/** Where the runtimes are, relative to the page (node_modules in development, beside the page on the site). */
export const ORT_URL = 'ort/';
export const MEDIAPIPE_URL = 'mediapipe/';

export function setupAI({ source, onProgress = () => {}, model = DEFAULT_MODEL, ortUrl = ORT_URL, mediapipeUrl = MEDIAPIPE_URL, base = location.href }) {   // base: where models/ is (the small apps live a folder down)
    let key = AI_MODELS[model] ? model : DEFAULT_MODEL;
    const backends = {};                // key → Promise<backend>
    const ready = {};                   // key → backend, once loaded
    let looked = false;                 // the current backend has looked at the picture
    let lookMs = 0;

    async function fetchWithProgress(url, what) {
        url = new URL(url, base).href;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${what} is not on this site (${url}: ${response.status}).`);
        const total = Number(response.headers.get('content-length')) || 0;
        if (!total || !response.body) return new Uint8Array(await response.arrayBuffer());
        const reader = response.body.getReader();
        const bytes = new Uint8Array(total);
        let got = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes.set(value, got);
            got += value.length;
            onProgress(`${what}: ${Math.round((got / total) * 100)}%`);
        }
        return bytes;
    }

    let ortPromise = null;
    const onnx = () => (ortPromise ??= import('onnxruntime-web').then((ort) => {   // the import map: node_modules in development, ort/ on the site
        ort.env.wasm.wasmPaths = new URL(ortUrl, location.href).href;
        // threads need a cross-origin-isolated page; elsewhere one thread, which still works
        ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
        return ort;
    }));
    let visionPromise = null;
    const mediapipe = () => (visionPromise ??= import('@mediapipe/tasks-vision').then(async (mp) => ({
        mp, fileset: await mp.FilesetResolver.forVisionTasks(new URL(mediapipeUrl, location.href).href.replace(/\/$/, '')),
    })));

    const pixels = (canvas) => canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;

    /** Two outlines that mostly agree are the same object found twice: keep the surer. */
    function merge(list) {
        const kept = [];
        for (const o of list) {
            const area = o.mask.reduce((a, b) => a + b, 0);
            const same = kept.some((k) => {
                let both = 0;
                for (let i = 0; i < o.mask.length; i++) if (o.mask[i] && k.mask[i]) both++;
                return both / Math.max(1, Math.min(area, k.area)) > 0.8;
            });
            if (!same) kept.push({ ...o, area });
        }
        return kept;
    }

    /** Each backend: look(canvas) once per picture, objects() (labelled, if it finds any), mask(prompt). */
    const makers = {
        async objects(spec, what) {
            const ort = await onnx();
            const model = await loadDetector(ort, await fetchWithProgress(spec.files[0], what), { size: spec.size, executionProviders: ['wasm'] });
            let found = [], w = 0, h = 0;
            return {
                async look(c) { w = c.width; h = c.height; found = merge(await model.find(pixels(c), w, h, { threshold: 0.4 })); },
                objects: () => found.map(({ label, score, box }) => ({ label, score, box })),
                async mask({ points = [], labels = [], box = null }) {
                    const result = new Uint8Array(w * h);
                    const add = (o, on) => { for (let i = 0; i < o.mask.length; i++) if (o.mask[i]) result[i] = on ? 1 : 0; };
                    if (box) {
                        // the object whose box overlaps this one most
                        const iou = (b) => {
                            const ix = Math.max(0, Math.min(b[2], box[2]) - Math.max(b[0], box[0])), iy = Math.max(0, Math.min(b[3], box[3]) - Math.max(b[1], box[1]));
                            const inter = ix * iy;
                            return inter / ((b[2] - b[0]) * (b[3] - b[1]) + (box[2] - box[0]) * (box[3] - box[1]) - inter);
                        };
                        const best = [...found].sort((a, b) => iou(b.box) - iou(a.box))[0];
                        if (best && iou(best.box) > 0.1) add(best, true);
                    }
                    const under = ([x, y]) => found
                        .filter((o) => o.mask[Math.round(y) * w + Math.round(x)])
                        .sort((a, b) => a.area - b.area)[0];                      // the smallest object there: a cup on a table, not the table
                    points.forEach((p, k) => { if (labels[k] === 1) { const o = under(p); if (o) add(o, true); } });
                    points.forEach((p, k) => { if (labels[k] === 0) { const o = under(p); if (o) add(o, false); } });
                    if (!result.some(Boolean) && points.some((_, k) => labels[k] === 1)) throw new Error('Nothing this model knows is there — try a click-anything model (MobileSAM, MagicTouch), or "trace the edge" or "fill a colour".');
                    return result;
                },
            };
        },
        async mobilesam(spec, what) {
            const ort = await onnx();
            const encoder = await fetchWithProgress(spec.files[0], what + ' (1 of 2)');
            const decoder = await fetchWithProgress(spec.files[1], what + ' (2 of 2)');
            const sam = await loadSam(ort, encoder, decoder, { executionProviders: ['wasm'] });
            return { look: (c) => sam.look(pixels(c), c.width, c.height), objects: () => [], mask: (p) => sam.mask(p) };
        },
        async magictouch(spec, what) {
            // the first MagicTouch: one keypoint per run of the whole model — each click is a run
            const { mp, fileset } = await mediapipe();
            const bytes = await fetchWithProgress(spec.files[0], what);
            const seg = await mp.InteractiveSegmenterLegacy.createFromOptions(fileset, { baseOptions: { modelAssetBuffer: bytes, delegate: 'CPU' }, outputCategoryMask: false, outputConfidenceMasks: true });
            let picture = null;
            const one = ([x, y]) => {
                const { width: w, height: h } = picture;
                const result = seg.segment(picture, { keypoint: { x: (x + 0.5) / w, y: (y + 0.5) / h } });
                const conf = result.confidenceMasks[0];
                const mask = resample(conf.getAsFloat32Array(), conf.width, conf.height, w, h, 0.5);
                result.close();
                return mask;
            };
            return {
                async look(c) { picture = copy(c); },
                objects: () => [],
                async mask({ points = [], labels = [], box = null }) {
                    const result = new Uint8Array(picture.width * picture.height);
                    const asks = points.map((p, k) => [p, labels[k]]);
                    if (box) asks.unshift([[(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], 1]);   // a box: its middle
                    for (const [p] of asks.filter(([, l]) => l === 1)) one(p).forEach((v, i) => { if (v) result[i] = 1; });
                    for (const [p] of asks.filter(([, l]) => l === 0)) one(p).forEach((v, i) => { if (v) result[i] = 0; });
                    return result;
                },
            };
        },
        async magictouch2(spec, what) {
            // MagicTouch 2: setImage runs its encoder once; each set of strokes runs only the decoder
            const { mp, fileset } = await mediapipe();
            const bytes = await fetchWithProgress(spec.files[0], what);
            const seg = await mp.InteractiveSegmenter.createFromOptions(fileset, { baseOptions: { modelAssetBuffer: bytes } });
            const POSITIVE = 1, NEGATIVE = 2, LASSO = 3;            // its BrushMode (a type only: the bundle doesn't export it)
            let w = 0, h = 0;
            return {
                async look(c) { w = c.width; h = c.height; seg.setImage(copy(c)); },
                objects: () => [],
                async mask({ points = [], labels = [], box = null }) {
                    const at = ([x, y]) => ({ x: (x + 0.5) / w, y: (y + 0.5) / h });
                    const strokes = points.map((p, k) => ({ brushMode: labels[k] ? POSITIVE : NEGATIVE, point: [at(p)], isCompleted: true }));
                    if (box) strokes.unshift({ brushMode: LASSO, point: [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]], [box[0], box[1]]].map(at), isCompleted: true });
                    const m = seg.segment(strokes);
                    const values = m.hasFloat32Array() ? m.getAsFloat32Array() : Float32Array.from(m.getAsUint8Array(), (v) => v / 255);
                    const mask = resample(values, m.width, m.height, w, h, 0.5);
                    m.close();
                    return mask;
                },
            };
        },
    };

    async function load() {
        const k = key;
        if (ready[k]) return ready[k];
        const spec = AI_MODELS[k];
        backends[k] ??= (async () => {
            onProgress(`Loading ${spec.name}…`);
            const backend = await (spec.kind === 'objects' ? makers.objects : makers[k])(spec, spec.name);
            onProgress('');
            return backend;
        })().catch((e) => { delete backends[k]; throw new Error(`Finding objects with ${spec.name} is not available: ${e.message}`); });
        ready[k] = await backends[k];
        return ready[k];
    }

    return {
        get loaded() { return Boolean(ready[key]); },
        get device() { return ready[key] ? 'wasm' : null; },
        get model() { return key; },
        get spec() { return AI_MODELS[key]; },
        /** How long the last look at a picture took, in ms. */
        get lookMs() { return lookMs; },
        setModel(k) { if (AI_MODELS[k] && k !== key) { key = k; looked = false; } },
        load,

        /** Look at the picture (or `canvas`). */
        async embed(canvas) {
            const backend = await load();
            const c = canvas ?? source();
            onProgress('Looking…');
            const t0 = performance.now();
            await backend.look(c);
            lookMs = performance.now() - t0;
            looked = true;
            onProgress('');
        },
        invalidate() { looked = false; },

        /** What is in the picture: labels and boxes ([] for the click-anything models). */
        async detect() {
            if (!looked) await this.embed();
            return ready[key].objects();
        },

        /** An outline from a box and/or points (1: this object, 0: not this one), at the picture's size. */
        async mask(prompt = {}) {
            if (!looked) await this.embed();
            return ready[key].mask(prompt);
        },
    };
}

/** A copy of a canvas (MediaPipe may keep it; the source canvas changes as a video plays). */
function copy(c) {
    const out = document.createElement('canvas');
    out.width = c.width; out.height = c.height;
    out.getContext('2d').drawImage(c, 0, 0);
    return out;
}

/** values (sw × sh) → a 0/1 mask (w × h), bilinear, above `cut`. */
function resample(values, sw, sh, w, h, cut) {
    const mask = new Uint8Array(w * h);
    if (sw === w && sh === h) { for (let i = 0; i < mask.length; i++) mask[i] = values[i] > cut ? 1 : 0; return mask; }
    for (let y = 0; y < h; y++) {
        const fy = Math.max(0, Math.min(sh - 1, ((y + 0.5) * sh) / h - 0.5));
        const y0 = Math.min(sh - 2, Math.floor(fy)), ay = fy - y0;
        for (let x = 0; x < w; x++) {
            const fx = Math.max(0, Math.min(sw - 1, ((x + 0.5) * sw) / w - 0.5));
            const x0 = Math.min(sw - 2, Math.floor(fx)), ax = fx - x0;
            const i = y0 * sw + x0;
            const v = (values[i] * (1 - ax) + values[i + 1] * ax) * (1 - ay) + (values[i + sw] * (1 - ax) + values[i + sw + 1] * ax) * ay;
            if (v > cut) mask[y * w + x] = 1;
        }
    }
    return mask;
}
