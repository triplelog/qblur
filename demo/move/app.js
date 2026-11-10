/**
 * Make it move: a photo, one motion (a filter that uses t), speed and "how much", saved as a GIF
 * or a video. Each motion has one knob, `amount`; the slider maps 0–1 onto its range. Speed scales
 * t. Both can be formulas worked out per pixel (`speed (0.3 + y)`, `amount gray`): every `t` in the
 * motion's maths becomes `(t (speed formula))` and every `amount` `(amount formula)`, with the two
 * sliders as the knobs `speed` and `amount` — so the user's text only ever reaches the filter as maths. The picture is shown at most 720 on its long side (it redraws every frame); GIFs are at most
 * 480, which keeps them a sensible size.
 */
import { createView, openFile, loadPicture, samplePhotos, showCredit, download, saveGif, byName, MZ } from '../kit.js';

const $ = (id) => document.getElementById(id);
const SHOW = 720, GIF = 480, FPS = 15;
const STEP = 60 / FPS;                                  // t moves 60 a second on screen

// around the centre, by an angle that falls to 0 at the edge of a circle half the picture across
const SWIRL_A = 'amount sin(t / 25) max(0, 1 - sqrt((px - w/2)^2 + (py - h/2)^2) / (0.5 min(w, h)))^2';
const MOTIONS = [
  { id: 'wave', name: 'Wave', amount: [0, 30, 8], def: { params: { amount: 8 }, color: 'pixel(px + amount sin(py / 10 + t / 5), py)' } },
  { id: 'ripple', name: 'Ripple', amount: [0, 12, 4], def: { params: { amount: 4 }, color: 'pixel(px + amount sin(py / 14 + t / 4), py + amount cos(px / 14 + t / 5))' } },
  { id: 'zoom', name: 'Slow zoom', amount: [0.02, 0.5, 0.15], def: { params: { amount: 0.15 }, color: 'zoom(1 + amount (0.5 - 0.5 cos(t / 40)), 0.5, 0.45)' } },
  { id: 'swirl', name: 'Swirl', amount: [0, 4, 1.5], def: { params: { amount: 1.5 }, color: `pixel(w/2 + (px - w/2) cos(${SWIRL_A}) - (py - h/2) sin(${SWIRL_A}), h/2 + (px - w/2) sin(${SWIRL_A}) + (py - h/2) cos(${SWIRL_A}))` } },
  { id: 'glitch', name: 'Glitch', amount: [0, 24, 8], def: { steps: [{ params: { amount: 8 }, color: '(red(px + amount sin(t / 6), py), g, blue(px - amount sin(t / 6), py))' }, 'if py mod 4 < 2 then rgb else rgb * 0.8'] } },
  { id: 'shake', name: 'Shake', amount: [0, 10, 3], def: { params: { amount: 3 }, color: 'pixel(px + amount sin(1.7 t), py + amount cos(2.3 t))' } },
  { id: 'rainbow', name: 'Rainbow', amount: [0.5, 2, 1.2], def: { space: 'hsv', params: { amount: 1.2 }, color: '(fract(r + t / 100), clamp(g * amount, 0, 1), b)' } },
  { id: 'glow', name: 'Glow', amount: [0, 0.5, 0.2], def: { params: { amount: 0.2 }, color: 'rgb (1 + amount sin(t / 10))' } },
  { id: 'film', name: 'Old film', amount: null, def: byName('Old film') },
];

/**
 * The motion with the formulas put in: `t` → `(t * (speed))`, `amount` → `(amount formula)`, in one
 * pass (so a formula's own t or amount is the plain one), in every expression of the motion and of
 * the filters inside it; the knobs `speed` and `amount` are added where they are used.
 */
function withFormulas(def, speed, howMuch) {
  const swap = (text) => text.replace(/(?<![\w.])(t|amount)(?![\w])/g, (name) => (name === 't' ? `(t * (${speed}))` : `(${howMuch})`));
  const visit = (f) => {
    if (typeof f === 'string') return visit({ color: f });
    if (f.steps) return { ...f, steps: f.steps.map((step) => (typeof step === 'object' && step.filter !== undefined ? { ...step, filter: visit(step.filter) } : visit(step))) };
    const color = typeof f.color === 'string' ? swap(f.color) : Object.fromEntries(Object.entries(f.color).map(([k, v]) => [k, swap(v)]));
    const params = { ...(f.params ?? {}) };
    const text = JSON.stringify(color);
    if (/(?<![\w.])speed(?![\w])/.test(text) && !params.speed) params.speed = { default: 1, min: 0, max: 3 };
    if (/(?<![\w.])amount(?![\w])/.test(text) && !params.amount) params.amount = { default: 0, min: -100, max: 100 };
    return { ...f, params, color };
  };
  return visit(def);
}
const formula = (id, fallback) => $(id).value.trim() || fallback;

const state = { picture: null, motion: MOTIONS[0], t: 0, playing: true, busy: false };
let view = null;
const status = (text, bad = false) => { $('status').textContent = text; $('status').classList.toggle('bad', bad); };
const amount = () => {
  const [lo, hi] = state.motion.amount ?? [0, 1];
  return lo + (hi - lo) * Number($('amount').value);
};

const knobs = () => ({ amount: amount(), speed: Number($('speed').value) });
/** The motion, with the formulas, on the view; a formula that doesn't work is marked and the last good one stays. */
function setMotion() {
  if (!view) return;
  const m = state.motion;
  // each formula on its own first, so a mistake is reported in the user's words, not the motion's
  for (const [id, label] of [['speed-formula', 'speed'], ['amount-formula', 'how much']]) {
    if (id === 'amount-formula' && !m.amount) continue;
    try { MZ.compileFilter({ params: { speed: 1, amount: 1 }, color: formula(id, label) }); $(id).classList.remove('bad'); }
    catch (e) {
      $(id).classList.add('bad');
      status(`The ${label} formula doesn't work: ${e.message.replace(/^the filter: /, '').split('\n')[0]}`, true);
      try { view.set(withFormulas(m.def, 'speed', 'amount'), knobs()); } catch { /* the motion alone always works */ }
      return;
    }
  }
  try {
    view.set(withFormulas(m.def, formula('speed-formula', 'speed'), m.amount ? formula('amount-formula', 'amount') : 'amount'), knobs());
    for (const id of ['speed-formula', 'amount-formula']) $(id).classList.remove('bad');
    status('');
  } catch (e) {
    for (const id of ['speed-formula', 'amount-formula']) $(id).classList.toggle('bad', $(id).value.trim() !== (id === 'speed-formula' ? 'speed' : 'amount'));
    status(`That formula doesn't work: ${e.message.split('\n')[0]}`, true);
    try { view.set(withFormulas(m.def, 'speed', 'amount'), knobs()); } catch { /* the motion alone always works */ }
  }
}
function useMotion(m) {
  state.motion = m;
  for (const tile of $('motions').children) tile.setAttribute('aria-pressed', String(tile.dataset.id === m.id));
  $('amount-row').hidden = !m.amount;
  $('amount-formula-row').hidden = !m.amount;
  if (m.amount) $('amount').value = String((m.amount[2] - m.amount[0]) / (m.amount[1] - m.amount[0]));
  setMotion();
}
function frame() {
  if (state.playing && view && !state.busy) {
    state.t += 1;                                     // a frame at 60 a second moves t by 1; the speed is in the maths
    view.knobs(knobs());
    view.draw(state.t);
  }
  requestAnimationFrame(frame);
}

async function usePicture(canvas, credit = '') {
  const s = Math.min(1, SHOW / Math.max(canvas.width, canvas.height));
  const shown = Object.assign(document.createElement('canvas'), { width: Math.round(canvas.width * s), height: Math.round(canvas.height * s) });
  shown.getContext('2d').drawImage(canvas, 0, 0, shown.width, shown.height);
  state.picture = shown;
  if (!view) view = createView($('frame'), shown.width, shown.height, { label: 'the moving picture' });
  else view.resize(shown.width, shown.height);
  setMotion();
  view.setImage('source', shown);
  showCredit($('credit'), credit);
}

for (const m of MOTIONS) {
  const tile = Object.assign(document.createElement('button'), { type: 'button', className: 'tile', textContent: m.name });
  tile.dataset.id = m.id;
  tile.onclick = () => useMotion(m);
  $('motions').append(tile);
}
let formulaTimer = null;
for (const id of ['speed-formula', 'amount-formula']) $(id).addEventListener('input', () => { clearTimeout(formulaTimer); formulaTimer = setTimeout(setMotion, 300); });
$('formulas-reset').onclick = () => { $('speed-formula').value = 'speed'; $('amount-formula').value = 'amount'; setMotion(); };
$('pause').onclick = () => {
  state.playing = !state.playing;
  $('pause').textContent = state.playing ? 'Pause' : 'Play';
  $('pause').setAttribute('aria-pressed', String(!state.playing));
};
$('file').onchange = async () => {
  try { await usePicture(await openFile($('file').files[0], 2048)); $('sample').value = ''; }
  catch (e) { status(e.message, true); }
};
const samples = await samplePhotos();
$('sample').append(new Option('a sample photo', ''), ...samples.map((p, i) => new Option(p.title || p.file, String(i))));
$('sample').onchange = async () => {
  const p = samples[Number($('sample').value)];
  if (p) await usePicture(await loadPicture(p.url, 2048), p.credit);
};

/** The GIF: `length` seconds at 15 frames a second, t moving as it does on screen, at most 480 px. */
$('gif').onclick = async () => {
  if (!view || state.busy) return;
  state.busy = true;
  const count = Math.round(Number($('length').value) * FPS);
  const s = Math.min(1, GIF / Math.max(state.picture.width, state.picture.height));
  const small = Object.assign(document.createElement('canvas'), { width: Math.round(state.picture.width * s), height: Math.round(state.picture.height * s) });
  const g = small.getContext('2d', { willReadFrequently: true });
  const t0 = state.t;
  try {
    view.knobs(knobs());
    const blob = await saveGif({
      count, delay: Math.round(1000 / FPS),
      frame: (i) => { view.draw(t0 + i * STEP); g.drawImage(view.canvas, 0, 0, small.width, small.height); return small; },
      progress: (i) => status(`Making the GIF… frame ${i + 1} of ${count}`),
    });
    if (!window.qblurNoDownload) await download(blob, 'moving.gif');
    status(`Saved a ${small.width} × ${small.height} GIF, ${count} frames, ${Math.round(blob.size / 1024)} KB.`);
    state.lastGif = blob;
  } catch (e) { status(e.message, true); }
  state.busy = false;
};

/** The video: what is on screen, recorded for `length` seconds (WebM, or MP4 where that is what the browser records). */
$('video').onclick = () => {
  if (!view || state.busy) return;
  if (!window.MediaRecorder || !view.canvas.captureStream) { status('This browser can\'t record video — save a GIF instead.', true); return; }
  const type = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(view.canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 6e6 });
  const chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type });
    if (!window.qblurNoDownload) await download(blob, type.includes('mp4') ? 'moving.mp4' : 'moving.webm');
    status(`Saved a ${Number($('length').value)} s video.`);
  };
  state.playing = true;
  $('pause').textContent = 'Pause';
  recorder.start();
  status(`Recording ${$('length').value} s…`);
  setTimeout(() => recorder.stop(), Number($('length').value) * 1000);
};

useMotion(MOTIONS[0]);
const first = Math.max(0, samples.findIndex((p) => /mountain/i.test(p.title || p.file)));
if (samples[first]) { $('sample').value = String(first); await usePicture(await loadPicture(samples[first].url, 2048), samples[first].credit); }
useMotion(state.motion);
requestAnimationFrame(frame);

window.qblurApp = { state, get view() { return view; }, MOTIONS, useMotion, setMotion, withFormulas };     // for tools/check.mjs
