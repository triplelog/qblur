#!/usr/bin/env node
/**
 * The examples in docs/library.md, run: every ```html runnable block as a page in headless Chrome
 * (the CDN addresses pointed at this repository's dist/ and MathZetta's build/, photo.jpg and
 * clip.mp4 at the sample photos), which must draw a picture on #out without an error; every
 * ```js node block in Node, `from '@mathzetta/qblur'` and `from '@mathzetta/qblur/apply'` pointed at src/, which must exit cleanly.
 *
 *   npm run build && node tools/check-docs.mjs
 *   node tools/check-docs.mjs --cdn      the pages load qblur and MathZetta from jsDelivr itself, as a visitor's would
 *                                        (another origin: CORS, the CPU worker started through a blob: module)
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = `${ROOT}.docs-check/`;                    // pages must be inside the repository: shot.mjs serves it
const md = readFileSync(`${ROOT}docs/library.md`, 'utf8');
const blocks = [...md.matchAll(/^```(html runnable|js node)\n([\s\S]*?)^```/gm)].map((m) => ({ kind: m[1], code: m[2] }));
const heading = (code) => { const at = md.indexOf(code); return [...md.slice(0, at).matchAll(/^#+ (.+)$/gm)].pop()?.[1] ?? '?'; };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const CDN = process.argv.includes('--cdn');
const local = (code) => (CDN ? code : code
    .replaceAll('https://cdn.jsdelivr.net/npm/@mathzetta/qblur@0.1/dist/', '/dist/')
    .replaceAll('https://cdn.jsdelivr.net/npm/mathzetta@1/build/', '/node_modules/mathzetta/build/'))
    .replaceAll("'photo.jpg'", "'/demo/photos/charleston.jpg'").replaceAll('"photo.jpg"', '"/demo/photos/charleston.jpg"')
    .replaceAll('"clip.mp4"', '"/demo/photos/waves.mp4"');
const CATCH = `<script>window.__errors = []; addEventListener('error', (e) => __errors.push(String(e.message || e)));
addEventListener('unhandledrejection', (e) => __errors.push(String(e.reason && e.reason.message || e.reason)));
// so the check can read a WebGL canvas after the frame was shown (the examples don't need to keep it)
const getContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (kind, o) { return getContext.call(this, kind, /webgl/.test(kind) ? { ...o, preserveDrawingBuffer: true } : o); };</script>`;
// after a moment: no errors, and #out shows a picture (not blank, not one flat colour)
const LOOK = `(async () => {
  await new Promise((r) => setTimeout(r, 3000));
  const out = document.getElementById('out').canvas ?? document.getElementById('out');   // <qblur-image> draws on its own canvas
  const c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(out, 0, 0, 64, 64);
  const d = g.getImageData(0, 0, 64, 64).data;
  let sum = 0, sq = 0;
  for (let i = 0; i < d.length; i += 4) { const v = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += v; sq += v * v; }
  const n = d.length / 4, mean = sum / n, spread = Math.sqrt(sq / n - mean * mean);
  return JSON.stringify({ errors: __errors, size: out.width + '×' + out.height, mean: Math.round(mean), spread: Math.round(spread) });
})()`;

let failures = 0;
for (const [i, { kind, code }] of blocks.entries()) {
    const where = `#${i + 1} (${heading(code)})`;
    let ok, note;
    if (kind === 'js node') {
        const file = `${OUT}${i}.mjs`;
        writeFileSync(file, code.replaceAll("from '@mathzetta/qblur'", `from '${pathToFileURL(`${ROOT}src/index.js`).href}'`)
            .replaceAll("from '@mathzetta/qblur/apply'", `from '${pathToFileURL(`${ROOT}src/apply.js`).href}'`));
        const run = spawnSync(process.execPath, [file], { encoding: 'utf8' });
        ok = run.status === 0;
        note = (ok ? run.stdout : run.stderr).trim().split('\n').pop();
    } else {
        writeFileSync(`${OUT}${i}.html`, `<!DOCTYPE html><html><head><meta charset="utf-8">${CATCH}</head><body>\n${local(code)}\n</body></html>`);
        const run = spawnSync(process.execPath, [fileURLToPath(new URL('shot.mjs', import.meta.url)), `/.docs-check/${i}.html`, LOOK, `${OUT}${i}.png`],
            { encoding: 'utf8', env: { ...process.env, SHOT_READY: "document.readyState === 'complete'", SHOT_TIMEOUT: '60000' } });
        const at = run.stdout.indexOf('RESULT: '), end = run.stdout.lastIndexOf(' → ');
        try {
            const r = JSON.parse(JSON.parse(run.stdout.slice(at + 8, end)));
            ok = !r.errors.length && r.spread > 4;
            note = r.errors.length ? r.errors.join('; ') : `${r.size}, mean ${r.mean}, spread ${r.spread}`;
        } catch { ok = false; note = (run.stderr || run.stdout).trim().split('\n').pop(); }
    }
    if (!ok) failures++;
    console.log(`${ok ? '✓' : '✗'} ${kind === 'js node' ? 'node' : 'page'} ${where}: ${note}`);
}
rmSync(OUT, { recursive: true, force: true });
console.log(failures ? `${failures} of ${blocks.length} examples failed` : `all ${blocks.length} examples run`);
process.exit(failures ? 1 : 0);
