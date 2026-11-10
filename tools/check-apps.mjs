#!/usr/bin/env node
/**
 * The small apps (demo/avatar/, splash/, move/, text/) in headless Chrome, each doing its one job:
 * the profile picture shows the sample's ready-made outline without fetching the model, runs the model on marks, saves a 1024 PNG with a blurred background and a cut-out
 * sticker; Colour splash keeps a clicked colour; Make it move saves a GIF; Fancy text draws a
 * transparent PNG, says which formula box has an error, and saves a GIF when a formula uses t.
 *
 *   node tools/check-apps.mjs [--site]        demo/ (default) or the built site/
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const base = process.argv.includes('--site') ? '/site' : '/demo';
const shot = fileURLToPath(new URL('shot.mjs', import.meta.url));
const READY = 'Boolean(window.qblurApp && qblurApp.view && qblurApp.view.compiled)';
const wait = (cond, ms = 60000) => `for (let i = 0; i < ${ms / 250} && !(${cond}); i++) await new Promise((r) => setTimeout(r, 250));`;
const CASES = {
    avatar: `${wait('qblurApp.state.person', 120000)}
        const A = qblurApp; window.qblurNoDownload = true;
        // the opening sample's outline is ready-made: the model must not have been fetched to show it
        const fetched = () => performance.getEntriesByType('resource').filter((e) => /\.onnx/.test(e.name)).length;
        const early = fetched();
        document.querySelector('input[name=bg][value=blur]').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('download').click();
        ${wait("/Saved/.test(document.getElementById('status').textContent)")}
        const round = document.getElementById('status').textContent;
        const ok1 = A.state.person && A.state.bg === 'blur' && /1024 × 1024/.test(round);
        document.getElementById('ring').checked = true;
        const cut = document.querySelector('input[name=shape][value=cutout]'); cut.checked = true; cut.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 600));
        document.getElementById('download').click();
        ${wait("/transparent background/.test(document.getElementById('status').textContent)")}
        const sticker = document.getElementById('status').textContent;
        const px = A.view.snapshot().getContext('2d').getImageData(2, 2, 1, 1).data[3];          // a corner: nothing there
        // marking brings the model in: a point on him, then one on the background — he is still outlined, by the model now
        const before = A.state.personMask.reduce((n, v) => n + v, 0), { width: W, height: H } = A.state.picture;
        A.addMark([W * 0.5, H * 0.45], 1);
        A.addMark([W * 0.04, H * 0.04], 0);
        ${wait('A.state.looked === A.state.picture && A.state.marks && A.state.prompt && A.state.prompt.labels.length === 2', 180000)}
        await new Promise((r) => setTimeout(r, 1500));
        const after = A.state.personMask.reduce((n, v) => n + v, 0);
        const ok2 = early === 0 && fetched() > 0 && Boolean(A.state.person) && after > 0.5 * before && after < 1.5 * before && !A.state.personMask[0];
        const ok = ok1 && A.state.bg === 'none' && /transparent background/.test(sticker) && px === 0 && ok2;
        return (ok ? 'ok' : 'FAIL') + ' — person ' + Boolean(A.state.person) + '; ' + round + ' ' + sticker + ' (corner alpha ' + px + '); no model to open (' + early + ' fetched), then marks ran it: ' + before + ' → ' + after + ' px';`,
    splash: `const A = qblurApp, c = A.view.canvas, r = c.getBoundingClientRect();
        const kept = A.state.hues.length;
        A.pick({ clientX: r.left + r.width * 0.55, clientY: r.top + r.height * 0.6 });     // the umbrella
        return (kept === 1 && A.state.hues.length >= 1 ? 'ok' : 'FAIL') + ' — kept ' + A.state.hues.length + ' colour(s); ' + document.getElementById('status').textContent;`,
    move: `const A = qblurApp; window.qblurNoDownload = true;
        A.useMotion(A.MOTIONS.find((m) => m.id === 'ripple'));
        document.getElementById('length').value = '2';
        document.getElementById('gif').click();
        ${wait('A.state.lastGif', 120000)}
        return (A.state.lastGif && A.state.lastGif.size > 10000 ? 'ok' : 'FAIL') + ' — ' + document.getElementById('status').textContent;`,
    text: `const A = qblurApp, $ = (id) => document.getElementById(id); window.qblurNoDownload = true;
        $('download').click();
        ${wait("/Saved/.test(document.getElementById('status').textContent)")}
        const png = $('status').textContent, corner = A.view.snapshot().getContext('2d').getImageData(1, 1, 1, 1).data[3];
        $('border').value = 'mix(c1, ';  $('border').dispatchEvent(new Event('input'));
        ${wait("document.getElementById('border-error').textContent")}
        const error = $('border-error').textContent;
        $('border').value = 'c1'; $('fill').value = 'fromhsv((fract(x + t / 200), 0.8, 1))'; $('fill').dispatchEvent(new Event('input'));
        ${wait("!document.getElementById('gif').hidden")}
        $('gif').click();
        ${wait('A.lastGif', 120000)}
        const ok = /transparent/.test(png) && corner === 0 && error && A.lastGif && A.lastGif.size > 5000;
        return (ok ? 'ok' : 'FAIL') + ' — ' + png + ' a bad border formula says: ' + error + '; ' + $('status').textContent;`,
};
let failures = 0;
for (const [app, body] of Object.entries(CASES)) {
    const run = spawnSync(process.execPath, [shot, `${base}/${app}/index.html`, `(async () => { ${body} })()`, `/tmp/qblur-app-${app}.png`],
        { encoding: 'utf8', env: { ...process.env, SHOT_READY: READY, SHOT_TIMEOUT: '240000' } });
    const out = run.stdout, at = out.indexOf('RESULT: '), end = out.lastIndexOf(' → ');
    let line;
    try { line = JSON.parse(out.slice(at + 8, end)); } catch { line = (run.stderr || out).trim().split('\n').pop(); }
    const ok = /^ok/.test(line);
    if (!ok) failures++;
    console.log(`${ok ? '✓' : '✗'} ${app}: ${line}`);
}
console.log(failures ? `${failures} app(s) failed` : 'every app does its job');
process.exit(failures ? 1 : 0);
