/**
 * The Export panel: format (with each one's size estimated), quality or
 * colours, output size, a crop dragged on the picture, a background for
 * JPEG, and Download.
 *
 *   const exporter = setupExport({ $, renderFrame, media, download, outputCanvas, canCrop });   // canCrop: may a drag on the result crop now?
 *   exporter.produce('png8')  → { blob, width, height, note }
 *
 * `renderFrame(width, height)` draws the filter on the picture at that size
 * and returns a 2D canvas; everything here works on that canvas.
 */
import { encodePng, colourCount } from './png.js';

const LIMIT = 4096;
const ASPECTS = { free: 0, '1:1': 1, '4:3': 4 / 3, '3:2': 3 / 2, '16:9': 16 / 9, '9:16': 9 / 16 };

export function setupExport({ $, renderFrame, media, download, outputCanvas, noDownload, canCrop = () => true }) {
    const state = { crop: null, aspect: 0 };          // crop: { x, y, w, h } as fractions of the frame
    let webp = null;                                   // does canvas.toBlob know WebP? found out once
    let estimates = null;                              // { key, sizes }

    // ---- size ------------------------------------------------------------------
    function frameSize() {
        const m = media();
        const scale = Math.min(1, LIMIT / m.width, LIMIT / m.height);
        return [Math.round(m.width * scale), Math.round(m.height * scale)];
    }
    function sizeFromPreset() {
        const [fw, fh] = frameSize();
        const preset = $('export-preset').value;
        const m = media();
        const long = Math.max(m.width, m.height);
        const byLong = (n) => Math.min(1, n / long);
        const scale = preset === 'preview' ? Math.min(1, 480 / m.width, 360 / m.height) : preset === 'half' ? 0.5 : preset === 'quarter' ? 0.25
            : /^\d+$/.test(preset) ? byLong(Number(preset)) : 1;
        if (preset !== 'custom') {
            $('export-width').value = Math.max(1, Math.round(fw * scale));
            $('export-height').value = Math.max(1, Math.round(fh * scale));
        }
        showOutput();
    }
    function outputSize() {
        const w = Math.min(LIMIT, Math.max(1, Math.round(Number($('export-width').value) || frameSize()[0])));
        const h = Math.min(LIMIT, Math.max(1, Math.round(Number($('export-height').value) || frameSize()[1])));
        return [w, h];
    }
    function keepShape(changed) {
        if (!$('export-lock').checked) return;
        const m = media();
        if (changed === 'width') $('export-height').value = Math.max(1, Math.round(Number($('export-width').value) * m.height / m.width));
        else $('export-width').value = Math.max(1, Math.round(Number($('export-height').value) * m.width / m.height));
    }
    function showOutput() {
        const [w, h] = outputSize();
        const c = state.crop;
        const out = c ? [Math.max(1, Math.round(c.w * w)), Math.max(1, Math.round(c.h * h))] : [w, h];
        $('export-out').textContent = `${out[0]} × ${out[1]} px${c ? ' (cropped)' : ''}`;
        for (const [key, v] of Object.entries(c ? { x: c.x * w, y: c.y * h, w: c.w * w, h: c.h * h } : { x: 0, y: 0, w, h })) $(`crop-${key}`).value = Math.round(v);
        estimates = null;
        $('export-sizes').textContent = '';
    }

    // ---- crop: drag on the picture ----------------------------------------------
    const box = $('crop-box');
    function showCrop() {
        const c = state.crop;
        box.hidden = !c;
        if (c) Object.assign(box.style, { left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` });
    }
    function setCrop(crop) {
        state.crop = crop && crop.w > 0.005 && crop.h > 0.005 ? crop : null;
        showCrop();
        showOutput();
    }
    function cropFromNumbers() {
        const [w, h] = outputSize();
        const v = (k) => Number($(`crop-${k}`).value) || 0;
        const crop = { x: v('x') / w, y: v('y') / h, w: v('w') / w, h: v('h') / h };
        if (crop.x <= 0 && crop.y <= 0 && crop.w >= 1 && crop.h >= 1) setCrop(null);
        else setCrop({ x: Math.max(0, crop.x), y: Math.max(0, crop.y), w: Math.min(1 - Math.max(0, crop.x), crop.w), h: Math.min(1 - Math.max(0, crop.y), crop.h) });
    }
    let dragFrom = null;
    const frame = $('output');
    const fraction = (e) => {
        const r = outputCanvas().getBoundingClientRect();
        return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
    };
    frame.addEventListener('pointerdown', (e) => { if (e.button !== 0 || !canCrop()) return; dragFrom = fraction(e); frame.setPointerCapture(e.pointerId); e.preventDefault(); });
    frame.addEventListener('pointermove', (e) => {
        if (!dragFrom) return;
        const [x, y] = fraction(e);
        let w = Math.abs(x - dragFrom[0]), h = Math.abs(y - dragFrom[1]);
        if (state.aspect) {                                                // the picture's own pixels, not the fractions, keep the shape
            const m = media();
            h = (w * m.width) / state.aspect / m.height;
            if (dragFrom[1] + h > 1 && y >= dragFrom[1]) { h = 1 - dragFrom[1]; w = (h * m.height * state.aspect) / m.width; }
        }
        const left = Math.min(x, dragFrom[0]), top = y >= dragFrom[1] ? dragFrom[1] : Math.max(0, dragFrom[1] - h);
        state.crop = { x: left, y: top, w: Math.min(w, 1 - left), h: Math.min(h, 1 - top) };
        showCrop();
    });
    frame.addEventListener('pointerup', (e) => { if (!dragFrom) return; dragFrom = null; frame.releasePointerCapture(e.pointerId); setCrop(state.crop); });
    $('crop-aspect').addEventListener('change', () => { state.aspect = ASPECTS[$('crop-aspect').value] ?? 0; });
    $('crop-clear').onclick = () => setCrop(null);
    for (const k of ['x', 'y', 'w', 'h']) $(`crop-${k}`).addEventListener('change', cropFromNumbers);

    // ---- producing the file ------------------------------------------------------
    const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    async function webpWorks() {
        if (webp !== null) return webp;
        const c = document.createElement('canvas');
        c.width = c.height = 2;
        const blob = await toBlob(c, 'image/webp', 0.8);
        webp = Boolean(blob && blob.type === 'image/webp');
        return webp;
    }

    /** The filtered, cropped picture at the output size, as a 2D canvas (rendered once per settings). */
    let rendered = null;
    async function picture() {
        const [w, h] = outputSize();
        const key = JSON.stringify([w, h, state.crop, media().kind, media().width, $('export-t')?.value]);
        if (rendered && rendered.key === key) return rendered.canvas;
        const full = await renderFrame(w, h);
        let canvas = full;
        if (state.crop) {
            const c = state.crop;
            canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(c.w * w));
            canvas.height = Math.max(1, Math.round(c.h * h));
            canvas.getContext('2d').drawImage(full, Math.round(c.x * w), Math.round(c.y * h), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
        }
        rendered = { key, canvas };
        return canvas;
    }

    async function encode(canvas, format) {
        const quality = Number($('export-quality').value);
        if (format === 'jpeg') {
            const flat = document.createElement('canvas');
            flat.width = canvas.width; flat.height = canvas.height;
            const ctx = flat.getContext('2d');
            ctx.fillStyle = $('export-bg').value;
            ctx.fillRect(0, 0, flat.width, flat.height);
            ctx.drawImage(canvas, 0, 0);
            return { blob: await toBlob(flat, 'image/jpeg', quality), ext: 'jpg', note: `JPEG, quality ${Math.round(quality * 100)}` };
        }
        if (format === 'webp') {
            if (!(await webpWorks())) throw new Error('This browser cannot write WebP');
            return { blob: await toBlob(canvas, 'image/webp', quality), ext: 'webp', note: `WebP, quality ${Math.round(quality * 100)}` };
        }
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        if (format === 'png8') {
            const png = await encodePng({ width: canvas.width, height: canvas.height, data, palette: 'force', colours: Number($('export-colours').value) || 256, dither: $('export-dither').checked });
            if (png) return { blob: png.blob, ext: 'png', note: `PNG, ${png.colours} colours at ${png.bits} bit${png.bits > 1 ? 's' : ''} a pixel` };
            return { blob: await toBlob(canvas, 'image/png'), ext: 'png', note: 'PNG (this browser cannot write a palette PNG)' };
        }
        const png = await encodePng({ width: canvas.width, height: canvas.height, data, palette: 'auto' });   // few colours → indexed, else RGB/RGBA
        if (png) return { blob: png.blob, ext: 'png', note: png.kind === 'palette' ? `PNG, ${png.colours} colours at ${png.bits} bit${png.bits > 1 ? 's' : ''} a pixel` : `PNG, ${png.kind.toUpperCase()}` };
        return { blob: await toBlob(canvas, 'image/png'), ext: 'png', note: 'PNG' };
    }

    /** Every format's size, for the panel; the picture is rendered once. */
    async function estimate() {
        const canvas = await picture();
        const key = JSON.stringify([rendered.key, $('export-quality').value, $('export-colours').value, $('export-dither').checked, $('export-bg').value]);
        if (estimates && estimates.key === key) return estimates.sizes;
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const sizes = { colours: colourCount(data) };
        for (const format of ['png', 'png8', 'jpeg', 'webp']) {
            try { const r = await encode(canvas, format); sizes[format] = { bytes: r.blob.size, note: r.note }; } catch { sizes[format] = null; }
            await new Promise((r) => setTimeout(r, 0));
        }
        estimates = { key, sizes };
        return sizes;
    }

    /** Auto: lossless when the picture has few colours or transparency, otherwise the smaller of JPEG and WebP. */
    async function chooseAuto() {
        const sizes = await estimate();
        if (sizes.colours <= 256) return 'png';                               // encodePng('auto') indexes it
        const canvas = await picture();
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let transparent = false;
        for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { transparent = true; break; }
        if (transparent) return sizes.webp ? 'webp' : 'png';
        if (sizes.webp && sizes.jpeg) return sizes.webp.bytes < sizes.jpeg.bytes ? 'webp' : 'jpeg';
        return sizes.jpeg ? 'jpeg' : 'png';
    }

    async function produce(format = $('export-format').value) {
        const chosen = format === 'auto' ? await chooseAuto() : format;
        const canvas = await picture();
        const r = await encode(canvas, chosen);
        return { ...r, format: chosen, width: canvas.width, height: canvas.height };
    }

    const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
    async function showEstimates() {
        $('export-sizes').textContent = 'Estimating…';
        try {
            const sizes = await estimate();
            const auto = await chooseAuto();
            const parts = [];
            for (const [format, label] of [['png', 'PNG'], ['png8', 'PNG palette'], ['jpeg', 'JPEG'], ['webp', 'WebP']]) {
                if (sizes[format]) parts.push(`${label} ${kb(sizes[format].bytes)}${format === auto ? ' ←' : ''}`);
            }
            $('export-sizes').textContent = `${parts.join(' · ')}${sizes.colours <= 256 ? ` · ${sizes.colours} colours` : ''}`;
        } catch (e) {
            $('export-sizes').textContent = e.message;
        }
    }

    async function save() {
        $('export-msg').textContent = 'Drawing…';
        try {
            const r = await produce();
            if (!noDownload()) download(r.blob, `filter.${r.ext}`);
            $('export-msg').textContent = `Saved ${r.width} × ${r.height}: ${r.note}, ${kb(r.blob.size)}`;
        } catch (e) {
            $('export-msg').textContent = e.message;
        }
    }

    // ---- wiring ------------------------------------------------------------------
    function showControls() {
        const f = $('export-format').value;
        $('export-quality-row').hidden = !(f === 'jpeg' || f === 'webp' || f === 'auto');
        $('export-colours-row').hidden = f !== 'png8';
        $('export-bg-row').hidden = !(f === 'jpeg' || f === 'auto');
    }
    $('export-format').addEventListener('change', showControls);
    $('export-quality').addEventListener('input', () => { $('export-quality-val').textContent = Math.round($('export-quality').value * 100); estimates = null; $('export-sizes').textContent = ''; });
    for (const id of ['export-colours', 'export-dither', 'export-bg']) $(id).addEventListener('change', () => { estimates = null; $('export-sizes').textContent = ''; });
    $('export-preset').addEventListener('change', sizeFromPreset);
    $('export-width').addEventListener('change', () => { $('export-preset').value = 'custom'; keepShape('width'); showOutput(); });
    $('export-height').addEventListener('change', () => { $('export-preset').value = 'custom'; keepShape('height'); showOutput(); });
    $('export-estimate').onclick = showEstimates;
    $('export-download').onclick = save;
    showControls();

    return {
        state, produce, estimate, setCrop, outputSize, save,
        /** The picture changed (a new file, a frame): sizes follow it. */
        pictureChanged() { rendered = null; estimates = null; sizeFromPreset(); showCrop(); },
    };
}
