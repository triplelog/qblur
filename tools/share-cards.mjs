#!/usr/bin/env node
/**
 * `node tools/share-cards.mjs` — the link-preview pictures (og:image, 1200 × 630) and the icons, made in headless Chrome
 * and committed in demo/share/ (the build copies them to site/share/; the icons to the site's root):
 *
 *   demo/share/<page>.jpg   a Shioh card: the page's name and line on a pastel cell, beside what the page makes
 *                           (its result, captured from the dev page)
 *   demo/favicon.svg        the icon (written by hand), and from it favicon.ico (32 px) and apple-touch-icon.png (180 px)
 *
 * Run it again after changing a page's look or result; it needs Chrome (CHROME=… to point elsewhere) and ImageMagick (`magick`).
 */
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sendFile } from './send-file.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.mp4': 'video/mp4', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };

/** Each card: the page, what to wait for, the element whose picture goes on the card, and its words. */
export const CARDS = [
    { name: 'index', path: '/demo/index.html', ready: 'Boolean(window.mzDemo && mzDemo.compiled)', shot: '#out', colour: '#a4b6dd',
        title: 'Image filters written as maths', line: 'Chain them, tune their knobs, share them as a link. In your browser.' },
    { name: 'avatar', path: '/demo/avatar/index.html', ready: 'Boolean(window.qblurApp && qblurApp.state.person)', shot: '#frame canvas:not(#marks)', colour: '#a2d0c0',
        before: "document.getElementById('show-marks').click()",
        title: 'Profile picture', line: 'Centred on you, in a style you like, with the background blurred or replaced.' },
    { name: 'splash', path: '/demo/splash/index.html', ready: 'Boolean(window.qblurApp && qblurApp.view && qblurApp.view.compiled)', shot: '#frame', colour: '#d09292',
        title: 'Colour splash', line: 'Keep one colour and turn the rest of the photo grey.' },
    { name: 'move', path: '/demo/move/index.html', ready: 'Boolean(window.qblurApp && qblurApp.view && qblurApp.view.compiled)', shot: '#frame', colour: '#c094cc',
        title: 'Make it move', line: 'A wave, a ripple, a slow zoom: a photo saved as a GIF or a video.' },
    { name: 'text', path: '/demo/text/index.html', ready: 'Boolean(window.qblurApp && qblurApp.view && qblurApp.view.compiled)', shot: '#frame', colour: '#a4b6dd',
        title: 'Fancy text', line: 'Gold, chrome, fire, a photo inside the letters: a transparent PNG or a GIF.' },
    { name: 'docs', path: null, colour: '#a2d0c0',
        title: 'Filters as maths, on your pages', line: 'The guide to the filter language, and qblur as a library: GPU or CPU, in Node too.' },
];

const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const card = (c, img) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800&family=Open+Sans:wght@400;600&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 630px; background: #000; padding: 28px; display: flex; gap: 24px; font-family: 'Open Sans', sans-serif; }
  .words { flex: 1; background: ${c.colour}; border-radius: 3px; padding: 44px 44px 36px; display: flex; flex-direction: column; color: #222; }
  .mark { font: 800 44px Montserrat, sans-serif; color: #000080; letter-spacing: -1px; }
  h1 { font: 800 ${c.title.length > 24 ? 56 : 64}px/1.05 Montserrat, sans-serif; margin-top: auto; }
  p { font-size: 27px; line-height: 1.35; margin-top: 22px; }
  .url { margin-top: 28px; font: 700 22px Montserrat, sans-serif; color: #000080; }
  .pic { width: ${img ? 520 : 0}px; display: ${img ? 'flex' : 'none'}; align-items: center; justify-content: center; background: #fff; border-radius: 3px; overflow: hidden; }
  .pic img { max-width: 100%; max-height: 100%; }
</style></head><body>
<div class="words"><div class="mark">qblur</div><h1>${esc(c.title)}</h1><p>${esc(c.line)}</p><div class="url">qblur.com</div></div>
<div class="pic">${img ? `<img src="${img}">` : ''}</div>
</body></html>`;

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2a6fdb"/><circle cx="16" cy="16" r="8" fill="none" stroke="white" stroke-width="3"/><circle cx="16" cy="16" r="2.5" fill="white"/></svg>\n`;

const server = createServer(async (req, res) => {
    const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (p === '/card.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(server.card); return; }
    try { sendFile(req, res, await readFile(join(ROOT, p)), { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' }); }
    catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const port = 9800 + Math.floor(Math.random() * 150);
const profile = join(tmpdir(), `qblur-cards-${process.pid}`);
const chrome = spawn(CHROME, ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--hide-scrollbars',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--window-size=1200,1400', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = async (code) => { chrome.kill(); server.close(); await rm(profile, { recursive: true, force: true }).catch(() => {}); process.exit(code); };
setTimeout(() => { console.error('timed out'); finish(2); }, 240000);

let page;
for (let i = 0; i < 100 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
    if (!page) await sleep(200);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => { pending.set(++id, resolve); ws.send(JSON.stringify({ id, method, params })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
async function open(url, ready, width, height) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    for (let i = 0; i < 300 && !(await evaluate(ready)); i++) await sleep(200);
    await sleep(1200);
}
await send('Page.enable');
await send('Runtime.enable');

const out = join(ROOT, 'demo/share');
await mkdir(out, { recursive: true });
for (const c of CARDS) {
    let img = '';
    if (c.path) {
        await open(base + c.path, c.ready, 1280, 1400);
        if (c.before) { await evaluate(c.before); await sleep(600); }
        const box = await evaluate(`(() => { const e = document.querySelector('${c.shot}'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`);
        await sleep(400);
        const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } });
        img = `data:image/png;base64,${shot.data}`;
    }
    server.card = card(c, img);
    await open(`${base}/card.html`, "document.fonts.status === 'loaded'", 1200, 630);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1200, height: 630, scale: 1 } });
    const png = join(tmpdir(), `qblur-card-${c.name}.png`);
    await writeFile(png, Buffer.from(shot.data, 'base64'));
    execFileSync('magick', [png, '-strip', '-quality', '84', join(out, `${c.name}.jpg`)]);
    await rm(png);
    console.log(`demo/share/${c.name}.jpg`);
}

// the icons: the SVG as written, and PNGs drawn from it
await writeFile(join(ROOT, 'demo/favicon.svg'), FAVICON);
// square corners for the touch icon: iOS rounds them itself, and would fill transparent ones with black
server.card = `<!DOCTYPE html><style>body{margin:0;background:transparent}</style><img id="i" width="180" height="180" src="data:image/svg+xml,${encodeURIComponent(FAVICON.replace('rx="7"', 'rx="0"'))}">`;
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
await open(`${base}/card.html`, "document.getElementById('i')?.complete", 180, 180);
const icon = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 180, height: 180, scale: 1 } });
const big = join(ROOT, 'demo/apple-touch-icon.png');
await writeFile(big, Buffer.from(icon.data, 'base64'));
execFileSync('magick', ['-background', 'none', join(ROOT, 'demo/favicon.svg'), '-define', 'icon:auto-resize=32,16', join(ROOT, 'demo/favicon.ico')]);
console.log('demo/favicon.svg, demo/favicon.ico, demo/apple-touch-icon.png');
ws.close();
await finish(0);
