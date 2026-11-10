/**
 * Colour splash: up to three colours kept, the rest grey. The colours are hues (0–1 round the
 * wheel), picked by clicking the photo; one filter with knobs, so clicking and sliding never
 * recompile. Saved at the photo's own size (up to 2048 on the long side).
 */
import { createView, openFile, loadPicture, samplePhotos, showCredit, download } from '../kit.js';

const $ = (id) => document.getElementById(id);
const MAX = 2048;

// how near a pixel's hue is to colour k: 1 within `range`, fading to 0 just past it
const near = (k) => `on${k} (1 - smoothstep(range, range + 0.03, abs(fract(red(tohsv(rgb)) - h${k} + 0.5) - 0.5)))`;
const SPLASH = {
  name: 'Colour splash',
  params: {
    h1: 0, h2: 0, h3: 0, on1: 0, on2: 0, on3: 0,
    range: { default: 0.05, min: 0.01, max: 0.2 }, dull: { default: 0.3, min: 0, max: 0.9 }, fade: { default: 0, min: 0, max: 1 },
  },
  // the rest: grey (with `fade` of its colour left); kept: near one of the hues and colourful enough
  color: `mix(mix((gray, gray, gray), rgb, fade), rgb, max(${near(1)}, max(${near(2)}, ${near(3)})) smoothstep(dull - 0.08, dull, green(tohsv(rgb))))`,
};

const state = { picture: null, hues: [] };            // hues: [{ h, rgb }]
let view = null;
const status = (text, bad = false) => { $('status').textContent = text; $('status').classList.toggle('bad', bad); };

function knobs() {
  const k = { range: Number($('range').value), dull: Number($('dull').value), fade: Number($('fade').value) };
  for (let i = 0; i < 3; i++) { k[`h${i + 1}`] = state.hues[i]?.h ?? 0; k[`on${i + 1}`] = state.hues[i] ? 1 : 0; }
  return k;
}
function render() {
  if (!state.picture) return;
  view.knobs(knobs());
  view.draw(0);
}
function showKept() {
  const box = $('kept');
  box.textContent = '';
  if (!state.hues.length) box.append(Object.assign(document.createElement('span'), { className: 'hint', textContent: 'none yet — the whole photo is grey' }));
  state.hues.forEach((c, i) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', title: 'remove this colour', textContent: '×' });
    b.setAttribute('aria-label', `remove colour ${i + 1}`);
    b.style.cssText = `background: rgb(${c.rgb.join(',')}); color: #fff; text-shadow: 0 0 2px #000; min-width: 2.6rem;`;
    b.onclick = () => { state.hues.splice(i, 1); showKept(); render(); };
    box.append(b);
  });
}

/** The colour under a click: the average of a small square, as a hue. */
function pick(e) {
  if (!state.picture) return;
  const r = view.canvas.getBoundingClientRect();
  const x = Math.round(((e.clientX - r.left) / r.width) * state.picture.width), y = Math.round(((e.clientY - r.top) / r.height) * state.picture.height);
  const d = state.picture.getContext('2d', { willReadFrequently: true }).getImageData(Math.max(0, x - 3), Math.max(0, y - 3), 7, 7).data;
  const sum = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += d[i + k];
  const rgb = sum.map((v) => Math.round(v / (d.length / 4)));
  const [R, G, B] = rgb.map((v) => v / 255), max = Math.max(R, G, B), min = Math.min(R, G, B), c = max - min;
  if (c < 0.12 || max < 0.15) { status('That spot is grey, black or white — click somewhere more colourful.', true); return; }
  let h = max === R ? ((G - B) / c) % 6 : max === G ? (B - R) / c + 2 : (R - G) / c + 4;
  h = ((h / 6) + 1) % 1;
  if (state.hues.length >= 3) state.hues.shift();         // three at most: the oldest goes
  state.hues.push({ h, rgb, sat: c / max });
  autoDull();
  status('');
  showKept();
  render();
}

/** "Skip dull" follows the colours picked: a vivid red keeps only vivid reds, so a brick wall of the same hue stays grey. */
function autoDull() {
  if (!state.hues.length) return;
  $('dull').value = String(Math.min(0.75, Math.max(0.15, Math.min(...state.hues.map((c) => c.sat)) * 0.7)));
}

async function usePicture(canvas, credit = '', hues = []) {
  state.picture = canvas;
  if (!view) {
    view = createView($('frame'), canvas.width, canvas.height, { label: 'the photo with the colours kept' });
    view.set(SPLASH);
  } else view.resize(canvas.width, canvas.height);
  view.setImage('source', canvas);
  state.hues = hues;
  autoDull();
  showCredit($('credit'), credit);
  showKept();
  render();
}

$('frame').addEventListener('click', pick);
for (const id of ['range', 'dull', 'fade']) $(id).oninput = render;
$('fade').addEventListener('input', () => $('fade').setAttribute('aria-valuetext', Number($('fade').value) ? `${Math.round($('fade').value * 100)}% of the colour` : 'grey'));
$('file').onchange = async () => {
  try { await usePicture(await openFile($('file').files[0], MAX)); $('sample').value = ''; status('Now click a colour to keep.'); }
  catch (e) { status(e.message, true); }
};
const samples = await samplePhotos();
$('sample').append(new Option('a sample photo', ''), ...samples.map((p, i) => new Option(p.title || p.file, String(i))));
$('sample').onchange = async () => {
  const p = samples[Number($('sample').value)];
  if (p) await usePicture(await loadPicture(p.url, MAX), p.credit);
};
$('download').onclick = async () => {
  if (!state.picture) return;
  render();
  const out = view.snapshot();
  if (!window.qblurNoDownload) await download(out, 'colour-splash.png');
  status(`Saved a ${out.width} × ${out.height} PNG.`);
};

// start on the red umbrella, with red kept
const first = Math.max(0, samples.findIndex((p) => /umbrella/i.test(p.title || p.file)));
if (samples[first]) { $('sample').value = String(first); await usePicture(await loadPicture(samples[first].url, MAX), samples[first].credit, [{ h: 0.99, rgb: [200, 30, 40], sat: 0.85 }]); }

window.qblurApp = { state, get view() { return view; }, render, pick };      // for tools/check.mjs
