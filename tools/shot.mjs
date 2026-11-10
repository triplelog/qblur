#!/usr/bin/env node
/**
 * A screenshot of a page of this repo after running some JavaScript in it —
 * for looking at the editor without a browser window.
 *
 *   node tools/shot.mjs "/site/index.html?picture=test" "mzDemo.loadChain({ steps: ['1 - rgb'] })" out.png
 *
 * Serves the repository itself, starts headless Chrome (SwiftShader WebGL),
 * waits for the editor to be ready, evaluates the expression (awaited), and
 * prints its result. SHOT_READY is the expression that says the page is ready (default: the
 * editor's), for the small apps: "Boolean(window.qblurApp)". SHOT_TIMEOUT (ms, default 60000) bounds the whole run;
 * CHROME overrides the browser's path.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendFile } from './send-file.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const [path = '/demo/index.html', expr = '0', out = 'shot.png'] = process.argv.slice(2);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.mp4': 'video/mp4', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.wasm': 'application/wasm' };

const server = createServer(async (req, res) => {
    const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    try {
        const body = await readFile(join(ROOT, p));
        sendFile(req, res, body, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
    } catch {
        res.writeHead(404);
        res.end();
    }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = 9400 + Math.floor(Math.random() * 400);
const profile = join(tmpdir(), `mathzetta-shot-${process.pid}`);
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--window-size=1200,1500', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = async (code) => { chrome.kill(); server.close(); await rm(profile, { recursive: true, force: true }).catch(() => {}); process.exit(code); };
setTimeout(() => { console.error('timed out'); finish(2); }, Number(process.env.SHOT_TIMEOUT || 60000));

let page;
for (let i = 0; i < 100 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
    if (!page) await sleep(200);
}
if (!page) { console.error('Chrome did not come up'); await finish(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => { pending.set(++id, resolve); ws.send(JSON.stringify({ id, method, params })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1500, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}${path}` });
for (let i = 0; i < 100; i++) {
    const r = await send('Runtime.evaluate', { expression: process.env.SHOT_READY || 'Boolean(window.mzDemo && mzDemo.compiled)', returnByValue: true });
    if (r.result?.value) break;
    await sleep(200);
}
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
await sleep(800);
const shot = await send('Page.captureScreenshot', { format: 'png' });
await writeFile(out, Buffer.from(shot.data, 'base64'));
console.log('RESULT:', JSON.stringify(r.result?.value ?? r.exceptionDetails?.exception?.description)?.slice(0, process.env.SHOT_FULL ? undefined : 600), '→', out);   // SHOT_FULL=1: all of it
ws.close();
await finish(0);
