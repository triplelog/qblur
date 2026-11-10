#!/usr/bin/env node
/**
 * Runs every library filter of demo/index.html through real WebGL
 * (headless Chrome with SwiftShader, so no GPU is needed) and reports the
 * ones that do not compile or render.
 *
 *   npm run check              WebGL 1, GLSL ES 1.0
 *   npm run check -- --webgl2  WebGL 2, GLSL ES 3.0
 *   npm run check -- --precision=half   half-float textures between passes (or float)
 *   CHROME=/path/to/chrome …           if Chrome is not in the usual place
 *
 * Serves this folder (node_modules included, for the mathzetta link) on a free port, so nothing else need run.
 * Exits 1 if any filter fails.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendFile } from './send-file.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = process.env.CHROME || {
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: 'google-chrome',
    win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
}[process.platform];
const WEBGL2 = process.argv.includes('--webgl2');
const PRECISION = (process.argv.find((a) => a.startsWith('--precision=')) ?? '--precision=byte').split('=')[1];
// --cpu: also run every filter on the CPU (createCpuRunner) and compare its pixels with the GPU's
const CPU = process.argv.includes('--cpu');
// --engine=cpu runs the page on the CPU runner; --no-webgl starts Chrome without WebGL (the page must fall back to the CPU)
const ENGINE = (process.argv.find((a) => a.startsWith('--engine=')) ?? '--engine=gpu').split('=')[1];
const NO_WEBGL = process.argv.includes('--no-webgl');
// --site checks the built site/ (npm run build) instead of demo/
const SITE = process.argv.includes('--site');
// --ai also runs the object model (demo/models/rfdetr-seg-small.onnx)
const AI = process.argv.includes('--ai');
// filters whose output can't match: random() hashes a float sin, which GPUs compute differently
const RANDOM = new Set(['Film grain', 'Old film', 'Noise', 'Dither']);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

// What runs inside the page: every library filter alone, then the combinations that exercise the runtime.
const CHECK = `(async () => {
    const D = window.mzDemo, MZ = MathZetta, results = [];
    window.mzDemoNoDownload = true;
    const error = () => document.getElementById('error').textContent;
    document.getElementById('play').checked = false;
    const compare = async () => {
        const gpu = D.readOut();
        const graphics = await MZ.renderGraphics(D.compiled, gpu.width, gpu.height, { t: D.t });
        const t0 = performance.now();
        const cpuRunner = MZ.createCpuRunner(D.compiled, { precision: '${PRECISION}' });
        cpuRunner.setImage(document.getElementById('source'));
        for (const name of Object.keys(D.compiled.images)) cpuRunner.setImage(name, D.slotCanvas(name));
        for (const [name, canvas] of Object.entries(graphics)) cpuRunner.setImage(name, canvas);
        const cpu = cpuRunner.draw({ t: D.t }).data;
        const ms = performance.now() - t0;
        let max = 0, over1 = 0, over4 = 0;
        for (let i = 0; i < cpu.length; i++) {
            if (i % 4 === 3) continue;
            const d = Math.abs(cpu[i] - gpu.data[i]);
            if (d > max) max = d;
            if (d > 1) over1++;
            if (d > 4) over4++;
        }
        const n = cpu.length * 3 / 4;
        return { max, over1: +(over1 / n * 100).toFixed(2), over4: +(over4 / n * 100).toFixed(2), cpuMs: +ms.toFixed(1) };
    };
    const run = async (name, def) => {
        D.loadChain(def);
        await D.bindGraphics();                                             // text and shapes are drawn asynchronously (fonts)
        const s = D.stats();
        let c = null;
        if (${CPU} && !error()) { try { c = await compare(); } catch (e) { c = { cpuError: e.message }; } }
        results.push({ name, error: error(), ...s, ...(c ?? {}) });
    };
    for (const def of D.BUILTIN) await run(def.name, { steps: [def] });
    const by = (name) => D.BUILTIN.find((f) => f.name === name);
    await run('chain at half opacity, with settings', { steps: [{ filter: by('Old film'), opacity: 0.5, with: { strength: 2 } }, { filter: 'if x < 0.5 then unchanged else 1 - rgb', opacity: 0.8 }] });
    await run('mask over a blur', { steps: ['gaussian(3)', { images: ['mask'], color: 'mix(source, rgb, luma(mask))' }] });
    await run('picture sampled elsewhere', { steps: [{ images: ['overlay'], color: 'mix(rgb, overlay(px + 20, py), red(overlay))' }] });
    await run('placement overridden', { steps: [{ filter: by('Picture in picture'), with: { inset: { place: 'tile', x: 0.25, zoom: 0.5, angle: 0.3 } } }] });
    await run('per channel with a colour result', { steps: [{ color: { r: 'gaussian(4)', b: 'if sobel() > 0.3 then 1' } }] });
    await run('share link round trip', MZ.filterFromLink(MZ.filterToLink({ name: 'Mine', steps: [by('Cartoon'), { filter: by('Through a mask'), opacity: 0.7 }] })));
    for (const example of D.EXAMPLES) {                                    // every example, as the page shows it
        await D.showExample(example);
        const st = D.stats();
        results.push({ name: 'example: ' + example.title, error: error(), ...st });
    }
    D.testPicture();
    await run('share link round trip again', MZ.filterFromLink(MZ.filterToLink({ name: 'Mine', steps: [by('Cartoon'), { filter: by('Through a mask'), opacity: 0.7 }] })));
    D.setOpacity(D.chain.steps[1], 0.3);
    results.push({ name: 'opacity changed live', error: error(), ...D.stats() });
    if (D.engine === 'gpu' && D.gl && D.gl.getExtension('WEBGL_lose_context')) {   // the GPU taking the context away, and giving it back
        const ext = D.gl.getExtension('WEBGL_lose_context');
        ext.loseContext();
        await new Promise((r) => setTimeout(r, 300));
        const whileLost = error();
        ext.restoreContext();
        await new Promise((r) => setTimeout(r, 1000));
        D.loadChain({ steps: [by('Invert')] });
        results.push({ name: 'after a lost and restored context', error: error() || (/lost/.test(whileLost) ? '' : 'no message while the context was lost'), ...D.stats() });
    }
    D.loadChain({ steps: ['foo * rgb'] });                                        // an unknown name: the error must say so and point at help
    results.push({ name: 'an unknown name is explained', error: /isn't a name/.test(error()) && document.querySelector('#error a') ? '' : 'no hint: ' + error(), mean: 0, lit: 0 });
    results.push({ name: 'the help panel has every section', error: document.querySelectorAll('#help-body section').length === D.HELP.length ? '' : 'sections missing', mean: 0, lit: 0 });
    // the library: a fold per group, a line per filter; the search box narrows it and opens what it found
    document.getElementById('search').value = 'sobel';
    document.getElementById('search').dispatchEvent(new Event('input'));
    const rows = document.querySelectorAll('#library li').length;
    const groups = document.querySelectorAll('#library details.lib-group[open]').length;
    document.getElementById('search').value = '';
    document.getElementById('search').dispatchEvent(new Event('input'));
    const allGroups = document.querySelectorAll('#library details.lib-group').length;
    const openAtFirst = document.querySelectorAll('#library details.lib-group[open]').length;
    const attributed = [...document.querySelectorAll('#library li')].filter((li) => /MathZetta/.test(li.textContent)).length;
    results.push({ name: 'library search and groups', error: rows >= 3 && rows < 10 && groups >= 1 && allGroups === MZ.GROUPS.length && openAtFirst === 0 && !attributed ? '' : 'search gave ' + rows + ' lines in ' + groups + ' open groups; ' + allGroups + ' groups, ' + openAtFirst + ' open at first, ' + attributed + ' lines naming MathZetta', mean: 0, lit: 0 });
    // a GIF in, played frame by frame, and a GIF out
    {
        const { GIFEncoder, quantize, applyPalette } = D.gifenc;
        const w = 40, h = 30, enc = GIFEncoder();
        for (let f = 0; f < 3; f++) {
            const rgba = new Uint8Array(w * h * 4);
            for (let i = 0; i < w * h; i++) rgba.set([f * 80, (i % w) * 6, 120, 255], i * 4);
            const palette = quantize(rgba, 256);
            enc.writeFrame(applyPalette(rgba, palette), w, h, { palette, delay: 80 });
        }
        enc.finish();
        D.loadGif(enc.bytes().buffer);
        await new Promise((r) => setTimeout(r, 250));
        const played = D.media.kind === 'gif' && D.media.gif.frames.length === 3 && D.t < 3;
        D.loadChain({ steps: [by('Invert')] });
        await D.saveGif();
        const saved = document.getElementById('export-msg').textContent;
        D.testPicture();
        results.push({ name: 'GIF in, frame by frame, and GIF out', error: (played ? '' : 'the GIF did not play; ') + (/Saved a 40 × 30 GIF, 3 frames/.test(saved) ? '' : 'save: ' + saved), mean: 0, lit: 0 });
    }
    // colour spaces: there and back gives the picture again, on both engines
    {
        const size = D.readOut();
        const src = document.getElementById('source').getContext('2d').getImageData(0, 0, size.width, size.height).data;
        const bad = [];
        for (const space of ['linear', 'hsv', 'hsl', 'lab', 'oklab', 'ycbcr']) {
            D.loadChain({ steps: [{ space, color: 'rgb' }] });
            if (error()) { bad.push(space + ': ' + error()); continue; }
            const gpu = D.readOut().data;
            const r = MZ.createCpuRunner(D.compiled, { precision: 'float' }); r.setImage(document.getElementById('source'));
            const cpu = r.draw({ t: 0 }).data;
            const tolerance = D.runner && D.runner.precision !== 'byte' ? 3 : 24;    // bytes between passes lose Lab's dark corners
            let off = 0;
            for (let i = 0; i < src.length; i++) if (i % 4 !== 3 && (Math.abs(gpu[i] - src[i]) > tolerance || Math.abs(cpu[i] - src[i]) > 2)) off++;
            if (off > src.length * 0.75 * 0.01) bad.push(space + ': ' + off + ' channels off (' + (D.runner && D.runner.precision) + ' textures)');
        }
        results.push({ name: 'colour spaces round-trip, GPU and CPU', error: bad.join('; '), mean: 0, lit: 0 });
    }
    // outside the picture is transparent, on both engines
    D.loadChain({ steps: ['zoom(0.5)'] });
    {
        const gpu = D.readOut();
        const corner = gpu.data[3], centre = gpu.data[((gpu.height >> 1) * gpu.width + (gpu.width >> 1)) * 4 + 3];
        let cpuCorner = -1;
        try {
            const r = MZ.createCpuRunner(D.compiled);
            r.setImage(document.getElementById('source'));
            cpuCorner = r.draw({ t: 0 }).data[3];
        } catch (e) { cpuCorner = e.message; }
        results.push({ name: 'zoomed out: transparent outside the picture', error: error() || (corner === 0 && centre === 255 && cpuCorner === 0 ? '' : 'alpha corner ' + corner + ' centre ' + centre + ' cpu corner ' + cpuCorner), mean: 0, lit: 0 });
    }
    // a skipped step drops out of the chain; moving a step reorders it
    D.loadChain({ steps: [{ filter: by('Invert'), skip: true }, by('Sepia')] });
    const skippedPasses = D.compiled.passes.length;
    D.moveStep(1, 0);
    results.push({ name: 'skip and reorder', error: error() || (skippedPasses === 1 && D.chain.steps[0].filter.name === 'Sepia' && document.querySelectorAll('#steps li.skipped').length === 1 ? '' : 'passes ' + skippedPasses + ', first step ' + D.chain.steps[0].filter.name), mean: 0, lit: 0 });
    // a step's editing parts show only while its Edit is on; a knob's line renames it in the maths; the maths box applies on Enter;
    // a filter written in "Add a new filter" starts with Edit on
    {
        D.loadChain({ steps: [by('Wave')] });
        const li = () => document.querySelector('#steps li');
        const shown = (sel) => { const e = li().querySelector(sel); return Boolean(e) && getComputedStyle(e).display !== 'none'; };
        const closed = !li().classList.contains('editing') && !shown('.block > input.def') && !shown('.meta') && !shown('.block-add') && shown('textarea.expr');
        li().querySelector('.edit').click();
        const open = shown('.block > input.def') && shown('.meta') && shown('.block-add') && li().querySelector('.edit').getAttribute('aria-pressed') === 'true';
        const line = li().querySelector('.block > input.def');
        line.value = line.value.replace(/^amplitude/, 'amp');
        line.dispatchEvent(new Event('change'));
        const f = () => D.chain.steps[0].filter;
        const renamed = 'amp' in f().params && !('amplitude' in f().params) && f().color.includes('amp sin(') && !f().color.includes('amplitude') && li().classList.contains('editing');
        const box = li().querySelector('textarea.expr');
        box.value = '1 - rgb';
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        const applied = f().color === '1 - rgb' && !error();
        document.getElementById('expr').value = 'gray';
        document.getElementById('add-expr').click();
        const fresh = document.querySelectorAll('#steps li').length === 2 && document.querySelector('#steps li:last-child').classList.contains('editing') && li().classList.contains('editing');
        results.push({ name: 'a step: Edit shows its parts, a knob renamed by its line, the maths applied on Enter', error: error() || (closed && open && renamed && applied && fresh ? '' : JSON.stringify({ closed, open, renamed, applied, fresh })), mean: 0, lit: 0 });
    }
    // applyFilter in the page, on whichever engine it has (what a review before 0.1.0 found): a plain picture is taken, a changed document is a new filter,
    // a compiled filter's knobs are read on every call, calls made together keep their own picture; and <qblur-image> draws,
    // reports a bad filter, and draws again once it is put right
    {
        const flat = (r, g, b, data = new Uint8ClampedArray(16)) => { for (let i = 0; i < 16; i += 4) data.set([r, g, b, 255], i); return { width: 2, height: 2, data }; };
        const { applyFilter, MAX_SIZE } = await import('/src/apply.js');
        const first = async (...args) => [...(await applyFilter(...args)).getContext('2d').getImageData(0, 0, 1, 1).data].slice(0, 3).join();
        const out = {};
        try {
            out.plain = await first(flat(200, 40, 40), 'rgb', {});
            out.floats = await first({ width: 2, height: 2, data: Float32Array.from(flat(1, 0, 0).data, (v) => (v === 255 ? 1 : v)) }, 'rgb', {});
            const big = document.createElement('canvas');
            big.width = 5000; big.height = 100;
            const limited = await applyFilter(big, 'rgb', { maxSize: 1000 });
            out.limited = limited.width + 'x' + limited.height + ' ' + (MAX_SIZE === 4096);
            // a picture given in one call and not the next goes back to "not given" (white), as on the CPU
            const masked = { images: { mask: {} }, color: '(luma(mask), luma(mask), luma(mask))' };
            const black = document.createElement('canvas'); black.width = black.height = 2;
            black.getContext('2d').fillRect(0, 0, 2, 2);
            out.maskGiven = await first(flat(200, 40, 40), masked, { images: { mask: black } });
            out.maskNotGiven = await first(flat(200, 40, 40), masked);
            const doc = { color: '1 - rgb' };
            await first(flat(200, 40, 40), doc, {});
            doc.color = 'rgb';
            out.changedDoc = await first(flat(200, 40, 40), doc, {});
            const made = MZ.compileFilter({ params: { k: 0 }, color: '(k, k, k)' });
            await first(flat(0, 0, 0), made, {});
            made.passes[0].values.k = 1;
            out.liveKnob = await first(flat(0, 0, 0), made, {});
            const withBox = { graphics: { box: { type: 'rect', x: 0.9, y: 0.9, w: 0.01, h: 0.01 } }, color: 'mix(rgb, box, 0 alpha(box))' };
            out.together = (await Promise.all([first(flat(200, 40, 40), withBox, {}), first(flat(40, 40, 200), withBox, {})])).join(' ');
            await import('/src/element.js');
            const el = document.createElement('qblur-image');
            const heard = (name) => new Promise((resolve) => el.addEventListener(name, resolve, { once: true }));
            el.setAttribute('src', document.getElementById('source').toDataURL());
            el.setAttribute('filter', '1 - rgb');
            el.style.cssText = 'position:fixed;left:0;top:0;width:40px';
            let wait = heard('load');
            document.body.append(el);
            await wait;
            out.element = el.canvas.width > 0;
            wait = heard('error');
            el.setAttribute('filter', '((');
            out.elementError = (await wait).detail instanceof Error;
            wait = heard('load');
            el.setAttribute('filter', 'gray');
            await wait;
            const p = el.canvas.getContext('2d').getImageData(el.canvas.width >> 1, el.canvas.height >> 1, 1, 1).data;
            out.elementAgain = p[0] === p[1] && p[1] === p[2];
            el.remove();
        } catch (e) { out.error = e.message; }
        const want = { plain: '200,40,40', floats: '255,0,0', limited: '1000x20 true', maskGiven: '0,0,0', maskNotGiven: '255,255,255', changedDoc: '200,40,40', liveKnob: '255,255,255', together: '200,40,40 40,40,200', element: true, elementError: true, elementAgain: true };
        results.push({ name: 'applyFilter in the page and <qblur-image>', error: JSON.stringify(out) === JSON.stringify(want) ? '' : JSON.stringify(out), mean: 0, lit: 0 });
    }
    // selecting an object: eight rough clicks around the red disc of the test picture give its outline
    {
        D.testPicture();
        const S = D.selection;
        const cx = 320 * 0.3, cy = 240 * 0.6, r = 240 * 0.25;
        const points = Array.from({ length: 8 }, (_, i) => { const a = i / 8 * Math.PI * 2; const off = (i % 2 ? 4 : -4); return [Math.round(cx + (r + off) * Math.cos(a)), Math.round(cy + (r + off) * Math.sin(a))]; });
        const t0 = performance.now();
        S.trace(points);
        const ms = performance.now() - t0;
        const mask = S.maskCanvas(320, 240).getContext('2d').getImageData(0, 0, 320, 240).data;
        let inside = 0, offRing = 0, onRing = 0;
        for (let i = 0; i < mask.length; i += 4) if (mask[i] > 127) inside++;
        for (const segment of S.state.segments) for (const p of segment) { const d = Math.hypot(p % 320 - cx, Math.floor(p / 320) - cy); if (Math.abs(d - r) <= 2.5) onRing++; else offRing++; }
        const expected = Math.PI * r * r;
        D.loadChain({ steps: [by('Invert'), by('Only inside the selection')] });
        const out = D.readOut();
        const src = document.getElementById('source').getContext('2d').getImageData(0, 0, 320, 240).data;
        const at = (x, y) => (y * 320 + x) * 4;
        const centre = at(Math.round(cx), Math.round(cy)), corner = at(5, 5);
        const problems = [];
        if (Math.abs(inside - expected) > expected * 0.12) problems.push('mask area ' + inside + ' vs ' + Math.round(expected));
        if (onRing < (onRing + offRing) * 0.85) problems.push('only ' + onRing + ' of ' + (onRing + offRing) + ' path pixels on the edge');
        if (Math.abs(out.data[centre] - (255 - src[centre])) > 8) problems.push('centre not inverted: ' + out.data[centre] + ' vs source ' + src[centre]);
        if (Math.abs(out.data[corner] - src[corner]) > 4) problems.push('corner changed: ' + out.data[corner] + ' vs source ' + src[corner]);
        S.clear();
        results.push({ name: 'selection traced around the disc (' + points.length + ' clicks, ' + ms.toFixed(0) + ' ms)', error: error() || problems.join('; '), mean: 0, lit: 0 });
        // path cooling: click once on the disc's edge, steer the cursor half-way round, and points freeze behind the cursor
        {
            S.clear();
            S.setMode('trace');
            S.click(Math.round(cx + r), Math.round(cy));
            let now = 0;
            for (let a = 0; a <= Math.PI; a += Math.PI / 90) { now += 40; S.moveTo(Math.round(cx + (r + 3) * Math.cos(a)), Math.round(cy + (r + 3) * Math.sin(a)), now); }
            const auto = S.state.points.filter((p) => p[2] === 'auto');
            let offRing = 0;
            for (const [x, y] of auto) if (Math.abs(Math.hypot(x - cx, y - cy) - r) > 2.5) offRing++;
            const cursorFar = S.state.points.every(([x, y]) => Math.hypot(x - (cx - r - 3), y - cy) > 30);
            S.setMode('off');
            S.clear();
            results.push({ name: 'path cooling froze ' + auto.length + ' points while steering', error: auto.length >= 2 && offRing === 0 && cursorFar ? '' : auto.length + ' auto points, ' + offRing + ' off the edge, cursor clear: ' + cursorFar, mean: 0, lit: 0 });
        }
        if (${AI}) {                                                          // the object models: the red disc is no COCO object — so the photo's cars
            S.clear();
            D.testPicture();
            const pick = document.getElementById('photo');
            pick.selectedIndex = [...pick.options].findIndex((o) => /Charleston/.test(o.text));
            await pick.onchange();
            const choose = document.getElementById('select-ai-model');
            const msg = () => document.getElementById('select-msg').textContent;
            const settle = async (name) => {
                for (let i = 0; i < 1200 && !msg().includes(name + ' looked in') && !/not available/.test(msg()); i++) await new Promise((r) => setTimeout(r, 250));
            };
            // the car to click: RF-DETR finds it where it is offered (development); the built site ships MobileSAM only,
            // so there the SUV's box in the 480 × 360 preview (where RF-DETR found it) is used
            const offered = [...choose.options].map((o) => o.value), first = offered.includes('rfdetr-small') ? 'rfdetr-small' : offered[0];
            choose.value = first; choose.onchange();
            document.getElementById('select-ai').click();
            await settle(D.ai.models[first].name);
            const car = first === 'rfdetr-small' ? D.ai.boxes.find((b) => b.label === 'car') : { box: [155, 225, 221, 266] };
            const labels = D.ai.boxes.map((b) => b.label).join(', ');
            // every model clicks the middle of that car: how much it outlines, how much of that is in the car's box
            for (const key of offered) {
                const name = D.ai.models[key].name;
                if (key !== first) { choose.value = key; choose.onchange(); await settle(name); }
                let picked = 0, inside = 0, error = '';
                const found = D.ai.boxes.map((b) => b.label);
                if (!car) error = 'no car to click: ' + msg();
                else if (/not available/.test(msg())) error = msg();
                else {
                    const [x0, y0, x1, y1] = car.box, w = document.getElementById('source').width;
                    await D.ai.click(Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2), false);
                    const p = S.state.preview;
                    if (p) for (let i = 0; i < p.length; i++) if (p[i]) {
                        picked++;
                        const x = i % w, y = (i - x) / w, padX = (x1 - x0) * 0.15, padY = (y1 - y0) * 0.15;
                        if (x >= x0 - padX && x <= x1 + padX && y >= y0 - padY && y <= y1 + padY) inside++;
                    }
                    const area = (x1 - x0) * (y1 - y0);
                    // the wiring, not the model's judgement (tools/compare-ai.mjs is for that): RF-DETR and MobileSAM must
                    // outline the car; MagicTouch is known to spill over it, so it only has to take something there
                    const tight = key.startsWith('rfdetr') || key === 'mobilesam';
                    if (tight ? !(picked > 0.25 * area && inside > 0.7 * picked) : !(inside > 0.25 * area)) error = 'outline ' + picked + ' px (' + inside + ' near the car, whose box is ' + Math.round(area) + '): ' + msg();
                    D.ai.keep();
                    if (!S.hasSelection()) error ||= 'keep did not select';
                    S.clear();
                }
                const timing = msg().includes('looked in') ? msg().slice(msg().indexOf('looked in')) : '';
                results.push({ name: name + ': ' + (found.length ? 'found ' + found.join(', ') + '; ' : '') + 'the car ' + picked + ' px; ' + timing, error, mean: 0, lit: 0 });
            }
            choose.value = first; choose.onchange();
            document.getElementById('select-ai').click();
            S.clear();
            D.testPicture();
            void labels;
        }
        // past the picture's edge: two clicks outside the top corners and one inside make a band along the top edge
        {
            S.clear();
            S.setMode('trace');
            S.clickAt(0, 0, true); S.clickAt(319, 0, true); S.clickAt(160, 60); S.close();
            const band = S.maskCanvas(320, 240, { raw: true }).getContext('2d').getImageData(0, 0, 320, 240).data;
            const on = (x, y) => band[(y * 320 + x) * 4] > 127;
            const ok = on(20, 2) && on(300, 2) && on(160, 1) && on(160, 20) && !on(160, 200) && !on(20, 120);
            S.setMode('off'); S.clear();
            results.push({ name: 'tracing past the picture’s edge follows the border', error: ok ? '' : 'near the corners ' + on(20, 2) + ' ' + on(300, 2) + ', on the border ' + on(160, 1) + ', middle ' + on(160, 20) + ', below ' + on(160, 200), mean: 0, lit: 0 });
        }
        // the refine brush: an inside stroke on the red disc, with nothing selected, selects the disc
        {
            S.clear();
            S.setRefine({ size: 0.05 });
            S.refine([[Math.round(cx) - 10, Math.round(cy)], [Math.round(cx) + 10, Math.round(cy)]], true);
            const m = S.maskCanvas(320, 240, { raw: true }).getContext('2d').getImageData(0, 0, 320, 240).data;
            let n = 0; for (let i = 0; i < m.length; i += 4) if (m[i] > 127) n++;
            S.clear();
            results.push({ name: 'refine brush: an inside stroke selects the disc (' + n + ' of ~' + Math.round(expected) + ' px)', error: Math.abs(n - expected) < expected * 0.15 ? '' : 'selected ' + n, mean: 0, lit: 0 });
        }
        // the wand with two colours: the red disc and the green square, nothing else
        S.setMode('fill');
        S.wandAt(Math.round(cx), Math.round(cy));
        S.wandAt(Math.round(320 * 0.7), Math.round(240 * 0.25));
        const two = S.maskCanvas(320, 240).getContext('2d').getImageData(0, 0, 320, 240).data;
        let picked = 0;
        for (let i = 0; i < two.length; i += 4) if (two[i] > 127) picked++;
        const want = expected + 320 * 0.35 * 240 * 0.35;
        S.setMode('off');
        S.clear();
        results.push({ name: 'wand with two colours: disc and square', error: Math.abs(picked - want) < want * 0.1 && S.state.colours.length === 0 ? '' : 'picked ' + picked + ' of ~' + Math.round(want), mean: 0, lit: 0 });
    }
    // text: a caption appears where it is placed, follows a change of words, and is drawn again crisp at export size
    {
        D.testPicture();
        D.loadChain({ steps: [{ filter: by('Caption'), with: { title: { text: 'WWWWWWWW', y: 0.5, color: '#ffffff', shadow: null, size: 0.12 } } }] });
        await D.bindGraphics();
        const out = D.readOut(), src = document.getElementById('source').getContext('2d').getImageData(0, 0, out.width, out.height).data;
        const band = (data, w, y0, y1) => { let white = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245) white++; } return white; };
        const h = out.height, mid = [Math.round(h * 0.44), Math.round(h * 0.56)];
        const added = band(out.data, out.width, ...mid) - band(src, out.width, ...mid);
        const top = band(out.data, out.width, 0, Math.round(h * 0.3)) - band(src, out.width, 0, Math.round(h * 0.3));
        D.setGraphic(0, 'title', D.chain.steps[0].filter.graphics.title, { text: 'I' });
        await D.bindGraphics();
        const fewer = band(D.readOut().data, out.width, ...mid) - band(src, out.width, ...mid);
        const big = await D.exporter.produce('png');
        const bitmap = await createImageBitmap(big.blob);
        const c = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height }).getContext('2d');
        c.drawImage(bitmap, 0, 0);
        const problems = [];
        if (added < 400) problems.push('only ' + added + ' white pixels where the text is');
        if (Math.abs(top) > 20) problems.push(top + ' pixels changed far from the text');
        if (!(fewer < added / 3)) problems.push('changing the words to "I" left ' + fewer + ' of ' + added);
        D.loadChain({ steps: [by('Scrolling banner')] });
        await D.bindGraphics();
        D.draw(); const a = D.stats();
        results.push({ name: 'text: placed, re-worded, exported ' + bitmap.width + '×' + bitmap.height, error: error() || problems.join('; '), mean: a.mean, lit: a.lit });
    }
    // shadow layers: "+ text", then a layer added through the controls; the maths follows, and the layer has its own filter
    {
        D.testPicture();
        D.chain.steps.length = 0;
        document.getElementById('add-text').click();
        const name = Object.keys(D.chain.steps[0].filter.graphics)[0];
        const base = D.chain.steps[0].filter.graphics[name];
        D.setGraphic(0, name, base, { text: 'MMMM', size: 0.2, shadow: null, color: '#ffffff' });
        D.setGraphic(0, name, base, { shadows: [{ color: '#000000', blur: 0, dx: 0.5, dy: 0 }] });
        const layer = name + '_shadow1';
        const followed = D.chain.steps[0].filter.color.includes(layer);
        D.chain.steps[0].filter.color = 'mix(mix(rgb, (1, 0, 0), alpha(' + layer + ')), ' + name + ', alpha(' + name + '))';   // the layer red, whatever it was cast in
        D.rebuild();
        await D.bindGraphics();
        const out = D.readOut();
        let red = 0, white = 0;
        for (let y = Math.round(out.height * 0.4); y < out.height * 0.6; y++) for (let x = 0; x < out.width; x++) {
            const i = (y * out.width + x) * 4, [r, g, b] = [out.data[i], out.data[i + 1], out.data[i + 2]];
            if (r > 240 && g < 15 && b < 15) red++;
            if (r > 245 && g > 245 && b > 245) white++;
        }
        const problems = [];
        if (!followed) problems.push('the maths did not take the new layer: ' + D.chain.steps[0].filter.color);
        if (red < 300) problems.push('only ' + red + ' red pixels from the layer');
        if (white < 300) problems.push('only ' + white + ' white pixels of text');
        results.push({ name: 'shadow layer added, with its own filter (' + red + ' red, ' + white + ' white)', error: error() || problems.join('; '), mean: 0, lit: 0 });
    }
    // brushes: a painted blur shows only along the stroke, grows with t, and can outline a selection
    {
        D.testPicture();
        D.loadChain({ steps: [by('Ink brush')] });
        const base = D.chain.steps[0].filter.graphics.brush;
        D.setGraphic(0, 'brush', base, { size: 0.05, strokes: [{ points: [[0.1, 0.25, 0, 1], [0.9, 0.25, 1000, 1]] }] });
        const src = document.getElementById('source').getContext('2d').getImageData(0, 0, 320, 240).data;
        const changed = (data, x, y) => { const i = (y * 320 + x) * 4; return Math.abs(data[i] - src[i]) + Math.abs(data[i + 1] - src[i + 1]) + Math.abs(data[i + 2] - src[i + 2]) > 30; };
        document.getElementById('play').checked = false;
        D.setT(200); D.draw();
        let out = D.readOut().data;
        const along = [40, 160, 280].every((x) => changed(out, x, 60)), away = [40, 160, 280].some((x) => changed(out, x, 180));
        D.setT(15); D.draw();
        out = D.readOut().data;
        const partway = changed(out, 60, 60) && !changed(out, 270, 60);
        // outline: trace the disc, then outline it with the brush
        D.selection.trace(Array.from({ length: 8 }, (_, k) => [Math.round(96 + 60 * Math.cos(k / 8 * Math.PI * 2)), Math.round(144 + 60 * Math.sin(k / 8 * Math.PI * 2))]));
        D.bindSelection();
        const before = D.compiled.graphics.brush.strokes.length;
        [...document.querySelectorAll('#steps button')].find((b) => b.textContent === 'outline the selection').click();
        const outlined = D.compiled.graphics.brush.strokes.length - before;
        D.selection.clear();
        const problems = [];
        if (!along) problems.push('the stroke did not change the picture along it');
        if (away) problems.push('pixels away from the stroke changed');
        if (!partway) problems.push('at frame 15 the stroke was not partway');
        if (outlined !== 1) problems.push('outlining added ' + outlined + ' strokes');
        results.push({ name: 'brush: painted, animated, outlined', error: error() || problems.join('; '), mean: 0, lit: 0 });
    }
    // tracking: a disc moving across a GIF, selected on frame 0, followed through the clip
    {
        const { GIFEncoder, quantize, applyPalette } = D.gifenc;
        const W = 160, H = 120, N = 24, enc = GIFEncoder();
        const at = (k) => [40 + 3 * k, 60 + Math.round(1.2 * k)];
        for (let k = 0; k < N; k++) {
            const rgba = new Uint8Array(W * H * 4);
            const [cx, cy] = at(k);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                const inside = Math.hypot(x - cx, y - cy) < 22;
                const v = inside ? [200, 40, 40] : [60 + ((x >> 3) + (y >> 3)) % 2 * 40, 120, 160];
                rgba.set([...v, 255], (y * W + x) * 4);
            }
            const palette = quantize(rgba, 256);
            enc.writeFrame(applyPalette(rgba, palette), W, H, { palette, delay: 60 });
        }
        enc.finish();
        D.loadGif(enc.bytes().buffer);
        await D.pauseAt(0);
        const sw = document.getElementById('source').width, scale = sw / W;
        const [cx0, cy0] = at(0);
        D.selection.trace(Array.from({ length: 8 }, (_, k) => [Math.round((cx0 + 22 * Math.cos(k / 8 * Math.PI * 2)) * scale), Math.round((cy0 + 22 * Math.sin(k / 8 * Math.PI * 2)) * scale)]));
        await document.getElementById('track-key').onclick();
        await document.getElementById('track-run').onclick();
        const problems = [];
        const tracker = D.track.tracker;
        for (const k of [8, 16, 23]) {
            const loop = tracker.results[k]?.loop;
            if (!loop) { problems.push('frame ' + k + ' not tracked'); continue; }
            const mx = loop.reduce((s, p) => s + p[0], 0) / loop.length / scale, my = loop.reduce((s, p) => s + p[1], 0) / loop.length / scale;
            const [cx, cy] = at(k);
            if (Math.hypot(mx - cx, my - cy) > 4) problems.push('frame ' + k + ': outline at ' + mx.toFixed(1) + ',' + my.toFixed(1) + ' disc at ' + cx + ',' + cy);
        }
        // the selection follows: invert only inside it, on frame 16
        D.loadChain({ steps: [by('Invert'), by('Only inside the selection')] });
        await D.pauseAt(16);
        D.draw();
        const out = D.readOut(), [cx, cy] = at(16);
        const px = (x, y) => out.data[(Math.round(y * scale) * out.width + Math.round(x * scale)) * 4];
        if (!(px(cx, cy) < 100)) problems.push('the disc on frame 16 was not inverted (' + px(cx, cy) + ')');
        if (!(px(cx0, cy0) < 140)) problems.push('where the disc was on frame 0 changed (' + px(cx0, cy0) + ')');
        results.push({ name: 'tracking a moving disc through a GIF (' + tracker.flagged().length + ' flagged)', error: error() || problems.join('; '), mean: 0, lit: 0 });
        D.testPicture();
    }
    // export: a two-colour result becomes a tiny 1-bit PNG; crop and size apply; JPEG and WebP write
    {
        const X = D.exporter;
        D.loadChain({ steps: [by('Threshold')] });
        X.setCrop(null);
        document.getElementById('export-preset').value = 'preview';
        document.getElementById('export-preset').dispatchEvent(new Event('change'));
        const png = await X.produce('png');
        const big = await X.produce('png8');
        X.setCrop({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
        const cropped = await X.produce('png');
        const bitmap = await createImageBitmap(cropped.blob);
        const jpeg = await X.produce('jpeg');
        let webp = 'skipped';
        try { webp = (await X.produce('webp')).blob.type; } catch (e) { webp = e.message; }
        const auto = await X.produce('auto');
        X.setCrop(null);
        const problems = [];
        if (!/1 bit a pixel/.test(png.note)) problems.push('threshold PNG not 1-bit: ' + png.note);
        if (png.blob.size > 6000) problems.push('1-bit PNG is ' + png.blob.size + ' bytes');
        if (big.blob.size > png.blob.size * 2) problems.push('forced palette much bigger: ' + big.blob.size);
        const [w, h] = X.outputSize();
        if (bitmap.width !== Math.round(w / 2) || bitmap.height !== Math.round(h / 2)) problems.push('crop gave ' + bitmap.width + 'x' + bitmap.height + ' of ' + w + 'x' + h);
        if (jpeg.blob.type !== 'image/jpeg') problems.push('jpeg type ' + jpeg.blob.type);
        if (auto.format !== 'png') problems.push('auto chose ' + auto.format + ' for two colours');
        results.push({ name: 'export: palette PNG, crop, JPEG, auto (webp: ' + webp + ')', error: problems.join('; '), mean: 0, lit: 0 });
    }
    D.loadChain({ steps: [by('Sepia')] });
    const before = D.stats();
    await D.exportPng();
    const after = D.stats();
    results.push({ name: 'export at full size, preview restored', error: error() || (Math.abs(before.mean - after.mean) < 1 ? '' : 'the preview changed after exporting'), ...after });
    return { results, precision: D.runner && D.runner.precision, webgl2: ${WEBGL2} };
})()`;

const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    try {
        const body = await readFile(join(ROOT, path));
        sendFile(req, res, body, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    } catch {
        res.writeHead(404);
        res.end();
    }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/${SITE ? 'site' : 'demo'}/index.html?picture=test&engine=${NO_WEBGL ? 'auto' : ENGINE}&precision=${PRECISION}${WEBGL2 ? '&webgl2' : ''}`;

const debugPort = 9300 + Math.floor(Math.random() * 500);
const profile = join(tmpdir(), `mathzetta-check-${process.pid}`);
const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', ...(NO_WEBGL ? ['--disable-3d-apis'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']), '--no-first-run',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, 'about:blank',
], { stdio: 'ignore' });
chrome.on('error', (e) => { console.error(`Could not start Chrome at ${CHROME}: ${e.message} (set CHROME)`); process.exit(2); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function finish(code) {
    chrome.kill();
    server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    process.exit(code);
}

try {
    let page;
    for (let i = 0; i < 100 && !page; i++) {
        try { page = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'); } catch { await sleep(100); }
    }
    if (!page) throw new Error('Chrome did not come up');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
    const send = (method, params = {}) => new Promise((resolve) => { pending.set(++id, resolve); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluation failed');
        return r.result.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url });
    for (let i = 0; i < 100 && !(await evaluate('Boolean(window.mzDemo && mzDemo.compiled)').catch(() => false)); i++) await sleep(100);

    const { results, precision } = await evaluate(CHECK);
    const engineNow = await evaluate('mzDemo.engine + " — " + mzDemo.engineReason');
    if (NO_WEBGL && !/^cpu/.test(engineNow)) { console.error(`expected the CPU without WebGL, got ${engineNow}`); await finish(1); }
    const failed = results.filter((r) => r.error);
    for (const r of results) console.log(`${r.error ? '✗' : '✓'} ${r.name}${r.error ? `\n    ${r.error.split('\n').join('\n    ')}` : `  (mean ${r.mean}, lit ${r.lit})`}`
        + (CPU && !r.error ? (r.cpuError ? `\n    CPU ERROR ${r.cpuError}` : `   CPU: max diff ${r.max}/255, ${r.over1}% off by >1, ${r.over4}% by >4, ${r.cpuMs} ms${RANDOM.has(r.name) ? ' (random: not comparable)' : ''}`) : ''));
    if (CPU) {
        const bad = results.filter((r) => !r.error && !RANDOM.has(r.name) && (r.cpuError || r.over4 > 0.5));
        console.log(`\nCPU vs GPU: ${results.length - bad.length} of ${results.length} within tolerance (≤0.5% of channels off by more than 4/255)`);
        for (const r of bad) console.log(`  ✗ ${r.name}: ${r.cpuError ?? `max ${r.max}, ${r.over4}% > 4`}`);
        if (bad.length) failed.push(...bad);
    }
    console.log(`\n${results.length - failed.length} of ${results.length} ok · ran on ${engineNow}${engineNow.startsWith('gpu') ? ` · ${WEBGL2 ? 'WebGL 2' : 'WebGL 1'}, textures: ${precision}` : ''}`);
    ws.close();
    await finish(failed.length ? 1 : 0);
} catch (e) {
    console.error(e.message);
    await finish(2);
}
