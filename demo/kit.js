/**
 * What the small apps (demo/avatar/, demo/splash/, demo/move/) share: a picture in, a filter run on
 * it (the GPU, or the CPU without WebGL), a file out. Each app is one page with a few choices; the
 * editor (demo/index.html) is where everything else lives.
 *
 *   import { openFile, samplePhotos, loadPicture, createView, download, saveGif, ROOT } from '../kit.js';
 *   const view = createView(box, 512, 512);          // a result canvas of that size, inside `box`
 *   view.set(chain);                                  // a filter: an expression, a library filter, { steps }
 *   view.setImage('source', canvas);                  // the picture (and 'selection', other pictures by name)
 *   view.draw(t);                                     // draws; view.canvas is what is on screen
 *
 * Paths are relative to the folder above the app, so the same code runs in demo/ (development: the
 * runtimes from node_modules) and in the built site (site/<app>/, the runtimes in site/ort/).
 */
import * as qblur from '@mathzetta/qblur';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

export const MZ = qblur;
/** The editor's folder: photos/, models/ and the editor itself are there. */
export const ROOT = new URL('../', location.href).href;
export const DEV = location.pathname.includes('/demo/');
export const ORT_URL = DEV ? '/node_modules/onnxruntime-web/dist/' : new URL('ort/', ROOT).href;
export const MEDIAPIPE_URL = DEV ? '/node_modules/@mediapipe/tasks-vision/wasm/' : new URL('mediapipe/', ROOT).href;
export const byName = (name) => qblur.LIBRARY.find((f) => f.name === name);

/** A picture as a canvas, at most `max` pixels on its long side. */
export function toCanvas(image, max = 1600) {
    const w = image.naturalWidth || image.videoWidth || image.width, h = image.naturalHeight || image.videoHeight || image.height;
    const s = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d').drawImage(image, 0, 0, c.width, c.height);
    return c;
}

/** A picture from an address, as a canvas. */
export async function loadPicture(url, max) {
    const img = new Image();
    img.src = url;
    await img.decode();
    return toCanvas(img, max);
}

/** A file the user chose (an image), as a canvas; it never leaves the computer. */
export async function openFile(file, max) {
    if (!file || !file.type.startsWith('image/')) throw new Error('That isn\'t a picture — choose a JPEG, PNG, WebP or GIF.');
    const url = URL.createObjectURL(file);
    try { return await loadPicture(url, max); } finally { URL.revokeObjectURL(url); }
}

/** The editor's sample photos (not the videos): [{ title, url, credit, personUrl }] (personUrl: the person's outline, worked out ahead). */
export async function samplePhotos() {
    try {
        const list = await (await fetch(new URL('photos/index.json', ROOT))).json();
        return list.filter((p) => !/\.(mp4|webm|mov)$/i.test(p.file)).map((p) => ({ ...p, url: new URL(`photos/${p.file}`, ROOT).href, personUrl: p.person ? new URL(`photos/${p.person}`, ROOT).href : '' }));
    } catch { return []; }
}

/** A photo credit with [text](https://…) links, rendered safely into `el`. */
export function showCredit(el, credit = '') {
    el.textContent = '';
    for (const part of String(credit).split(/(\[[^\]]+\]\(https?:\/\/[^)\s]+\))/)) {
        const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
        if (link) el.append(Object.assign(document.createElement('a'), { textContent: link[1], href: link[2], target: '_blank', rel: 'noopener' }));
        else if (part) el.append(part);
    }
}

/**
 * The result: a filter run on pictures, drawn into a canvas of a fixed size inside `box`. The GPU
 * when there is WebGL; otherwise the CPU (the same pixels, slower).
 */
export function createView(box, width, height, { label = 'the result' } = {}) {
    const glCanvas = Object.assign(document.createElement('canvas'), { width, height });
    const cpuCanvas = Object.assign(document.createElement('canvas'), { width, height, hidden: true });
    for (const c of [glCanvas, cpuCanvas]) { c.setAttribute('role', 'img'); c.setAttribute('aria-label', label); }
    box.append(glCanvas, cpuCanvas);
    const gl = glCanvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false });
    const images = new Map();
    let runner = null, engine = gl ? 'gpu' : 'cpu', compiled = null;

    const view = {
        get canvas() { return engine === 'cpu' ? cpuCanvas : glCanvas; },
        get engine() { return engine; },
        get compiled() { return compiled; },
        /** The filter to run, and knob values by step: [{ name: value }, …] (or one object for a single filter). */
        set(def, values = null) {
            if (runner) runner.dispose();
            runner = null;
            compiled = qblur.compileFilter(def, { version: 100 });
            const made = qblur.createRunner(compiled, { gl, prefer: gl ? 'auto' : 'cpu' });
            runner = made.runner;
            engine = made.engine;
            glCanvas.hidden = engine === 'cpu';
            cpuCanvas.hidden = engine !== 'cpu';
            for (const [name, image] of images) runner.setImage(name, image);
            if (values) view.knobs(values);
            return view;
        },
        /** Change knobs without recompiling: { name: value } for every pass that has that knob. */
        knobs(values) {
            if (!compiled) return;
            for (const pass of compiled.passes) for (const [k, v] of Object.entries(values)) if (k in pass.params) pass.values[k] = v;
        },
        setImage(name, image) {
            images.set(name, image);
            if (runner) runner.setImage(name, image);
            return view;
        },
        draw(t = 0) {
            if (!runner) return;
            if (engine === 'cpu') runner.draw({ t, canvas: cpuCanvas });
            else runner.draw({ t });
        },
        /** A 2D copy of what is drawn (to draw on, or to save). */
        snapshot() {
            const c = Object.assign(document.createElement('canvas'), { width, height });
            c.getContext('2d').drawImage(view.canvas, 0, 0);
            return c;
        },
        resize(w, h) {
            width = w; height = h;
            for (const c of [glCanvas, cpuCanvas]) { c.width = w; c.height = h; }
        },
    };
    return view;
}

/** Save a blob (or a canvas, as PNG) under `name`. */
export async function download(what, name) {
    const blob = what instanceof Blob ? what : await new Promise((r) => what.toBlob(r, 'image/png'));
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return blob;
}

/**
 * An animated GIF from frames drawn by `frame(i)` (which returns a canvas), `count` of them,
 * `delay` ms each; `progress(i)` is called as it goes. Returns the GIF as a Blob.
 */
export async function saveGif({ count, delay, frame, progress = () => {} }) {
    const encoder = GIFEncoder();
    let w = 0, h = 0;
    for (let i = 0; i < count; i++) {
        progress(i);
        const c = frame(i);
        w = c.width; h = c.height;
        const rgba = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
        const palette = quantize(rgba, 256);
        encoder.writeFrame(applyPalette(rgba, palette), w, h, { palette, delay });
        await new Promise((r) => setTimeout(r, 0));          // let the page breathe
    }
    encoder.finish();
    return new Blob([encoder.bytes()], { type: 'image/gif' });
}

/** Drag on `el` to move something: onMove(dx, dy) in CSS pixels; a wheel or pinch calls onZoom(factor). */
export function dragAndZoom(el, { onMove, onZoom = () => {}, onStart = () => {} }) {
    const pointers = new Map();
    let pinch = 0;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
        pointers.set(e.pointerId, [e.clientX, e.clientY]);
        el.setPointerCapture(e.pointerId);
        onStart();
    });
    el.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        const [x0, y0] = pointers.get(e.pointerId);
        pointers.set(e.pointerId, [e.clientX, e.clientY]);
        if (pointers.size === 1) onMove(e.clientX - x0, e.clientY - y0);
        else if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
            if (pinch) onZoom(d / pinch);
            pinch = d;
        }
    });
    const end = (e) => { pointers.delete(e.pointerId); pinch = 0; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => { e.preventDefault(); onZoom(Math.exp(-e.deltaY / 500)); }, { passive: false });
}
