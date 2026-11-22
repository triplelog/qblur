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
        /** The same, only in the passes of one step (`path`: its place in the chain, e.g. [1]) — a filter of the user's, whose
         *  knob names may be the page's own. Call after knobs(). */
        knobsAt(path, values) {
            if (!compiled) return;
            const under = (pass) => path.every((k, i) => pass.path?.[i] === k);
            for (const pass of compiled.passes) if (under(pass)) for (const [k, v] of Object.entries(values)) if (k in pass.params) pass.values[k] = v;
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

// ---- the user's own filters --------------------------------------------------------------------
// The filters page saves filters in this browser (localStorage "qblur", a list of the format's JSON); its "Use it in"
// links carry one in the address (#…, as filterToLink writes it). Every small app offers both: what the user wrote,
// used like the app's own choices. A filter is only ever math (compiled, checked), never run as code.

/** The filters saved on the filters page, and the one in this page's address: [{ def, from: 'link' | 'saved', key }]. */
export function yourFilters() {
    const out = [];
    if (location.hash.length > 1) {
        try { out.push({ def: qblur.normalizeFilter(qblur.filterFromLink(location.hash)), from: 'link' }); } catch { /* not a filter */ }
    }
    let list = [];
    try { list = JSON.parse(localStorage.getItem('qblur')) ?? []; } catch { /* storage blocked */ }
    for (const def of Array.isArray(list) ? list : []) {
        try {
            const d = qblur.normalizeFilter(def);
            if (!out.some((f) => JSON.stringify(f.def) === JSON.stringify(d))) out.push({ def: d, from: 'saved' });
        } catch { /* a broken entry: skip it */ }
    }
    return out.map((f, i) => ({ ...f, key: `yours-${i}`, name: f.def.name || (f.from === 'link' ? 'From the filters page' : `Filter ${i + 1}`) }));
}

/** Its knobs (the filter's params, as the editor shows them): a slider, a menu or a color each, for showKnobs(). */
export function knobsOf(def) {
    return Object.entries(qblur.filterParams(qblur.normalizeFilter(def))).map(([name, p]) => {
        const label = p.label ?? name;
        if (p.type === 'color') return { name, label, color: '#' + p.default.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('') };
        if (p.options) return { name, label, options: p.options, value: p.default };
        const step = p.step ?? (Number.isInteger(p.min) && Number.isInteger(p.max) && p.max - p.min >= 20 && Number.isInteger(p.default) ? 1 : +((p.max - p.min) / 100).toPrecision(2));
        return { name, label, min: p.min, max: p.max, step, value: p.default };
    });
}

/** '#rrggbb' → [r, g, b], 0–1. */
export const hexColor = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

/**
 * Knobs under a choice: each a labeled slider (with its value), a menu or a color. A knob is { name, label } and
 * { min, max, step, value, unit?, scale? } (the filter gets value × scale), { options, value }, or { color: '#rrggbb' }.
 * `settings` keeps what the user set, by `prefix + name`; `onInput` runs after each change.
 */
export function showKnobs(box, knobs, settings, onInput, prefix = '') {
    box.replaceChildren();
    box.hidden = !knobs.length;
    for (const knob of knobs) {
        const key = prefix + knob.name, id = `knob-${(prefix + knob.name).replace(/[^\w-]/g, '-')}`;
        const row = Object.assign(document.createElement('div'), { className: 'slider' });
        const label = Object.assign(document.createElement('label'), { htmlFor: id, textContent: knob.label });
        let input;
        if (knob.options) {
            input = Object.assign(document.createElement('select'), { id });
            input.append(...knob.options.map((o) => new Option(String(o), String(o))));
        } else input = Object.assign(document.createElement('input'), { id, type: knob.color ? 'color' : 'range' });
        const shown = Object.assign(document.createElement('output'), { htmlFor: id, className: 'knob-value' });
        if (!knob.color && !knob.options) Object.assign(input, { min: knob.min, max: knob.max, step: knob.step });
        input.value = String(settings[key] ?? knob.color ?? knob.value);
        const say = () => { shown.textContent = knob.color || knob.options ? '' : `${input.value}${knob.unit ?? ''}`; };
        input.oninput = () => {
            settings[key] = knob.color ? input.value : Number(input.value);
            say();
            onInput();
        };
        say();
        row.append(label, input, shown);
        box.append(row);
    }
}

/** The filter's values for these knobs (what showKnobs set, or each knob's own): { name: number | [r, g, b] }. */
export function knobValues(knobs, settings, prefix = '') {
    const values = {};
    for (const knob of knobs) {
        const v = settings[prefix + knob.name] ?? knob.color ?? knob.value;
        values[knob.name] = knob.color ? hexColor(v) : v * (knob.scale ?? 1);
    }
    return values;
}

/**
 * "Your filter" for an app's side panel (`box`): a menu of the user's filters (none, then yourFilters()) and the chosen
 * one's knobs. The app adds `step()` to its chain (null for none) and, after its own knobs, `view.knobsAt([index], values())`.
 * `onChange(recompile)` runs on every change. A filter from the page's link starts chosen.
 */
export function yourFilterPicker(box, onChange) {
    const filters = yourFilters(), settings = {};
    const filtersPage = new URL('filters.html', ROOT).href;
    box.replaceChildren();
    const note = Object.assign(document.createElement('p'), { className: 'hint' });
    note.append(filters.length ? 'Filters you write and save on the ' : 'Write a filter on the ', Object.assign(document.createElement('a'), { href: filtersPage, textContent: 'filters page' }),
        filters.length ? ' show here; it runs after this page\'s own.' : ' and save it (or use its "Use it in" link): it can be added here, after this page\'s own.');
    if (!filters.length) { box.append(note); return { step: () => null, values: () => ({}), get chosen() { return null; } }; }
    const row = Object.assign(document.createElement('div'), { className: 'row' });
    const select = Object.assign(document.createElement('select'), { id: 'your-filter' });
    select.setAttribute('aria-label', 'your filter');
    select.append(new Option('none', ''), ...filters.map((f) => new Option(f.from === 'link' ? `${f.name} (from the link)` : f.name, f.key)));
    row.append(select);
    const knobsBox = Object.assign(document.createElement('div'), { className: 'knobs' });
    knobsBox.setAttribute('role', 'group');
    knobsBox.setAttribute('aria-label', 'your filter\'s settings');
    box.append(row, knobsBox, note);
    let chosen = null, knobs = [];
    const choose = () => {
        chosen = filters.find((f) => f.key === select.value) ?? null;
        try { knobs = chosen ? knobsOf(chosen.def) : []; } catch { knobs = []; }
        showKnobs(knobsBox, knobs, settings, () => onChange(false), `${select.value}:`);
    };
    select.onchange = () => { choose(); onChange(true); };
    const fromLink = filters.find((f) => f.from === 'link');
    if (fromLink) select.value = fromLink.key;
    choose();
    return {
        get chosen() { return chosen; },
        step: () => (chosen ? { filter: chosen.def } : null),
        values: () => (chosen ? knobValues(knobs, settings, `${select.value}:`) : {}),
    };
}
