/**
 * Make it move: a photo, one motion (a filter that uses t), speed and "how much", saved as a GIF
 * or a video. Each motion has one knob, `amount`; the slider maps 0–1 onto its range. Speed scales
 * t. Both can be formulas worked out per pixel (`speed (0.3 + y)`, `amount gray`): every `t` in the
 * motion's math becomes `(t (speed formula))` and every `amount` `(amount formula)`, with the two
 * sliders as the knobs `speed` and `amount` — so the user's text only ever reaches the filter as math. The picture is shown at most 720 on its long side (it redraws every frame); GIFs are at most
 * 480, which keeps them a sensible size.
 *
 * Ken Burns is a camera: `crop` round a center (cx, cy) that follows a path the user draws (../path.js; a gentle drift
 * when none), at a zoom that is the user's formula of `p` (how far along the path: 0 → 1 and back, once over the length
 * saved, so a GIF loops) and `t`. cx, cy and p are knobs set from JS every frame; the zoom is math in the filter.
 */
import { createView, openFile, loadPicture, samplePhotos, showCredit, download, saveGif, byName, MZ, yourFilterPicker } from '../kit.js';
import { makePath, pointAt, progress } from '../path.js';

const $ = (id) => document.getElementById(id);
const SHOW = 720, GIF = 480, FPS = 15;
const STEP = 60 / FPS;                                  // t moves 60 a second on screen

// around the center, by an angle that falls to 0 at the edge of a circle half the picture across
const SWIRL_A = 'amount sin(t / 25) max(0, 1 - sqrt((px - w/2)^2 + (py - h/2)^2) / (0.5 min(w, h)))^2';
const MOTIONS = [
  { id: 'wave', name: 'Wave', amount: [0, 30, 8], def: { params: { amount: 8 }, color: 'pixel(px + amount sin(py / 10 + t / 5), py)' } },
  { id: 'ripple', name: 'Ripple', amount: [0, 12, 4], def: { params: { amount: 4 }, color: 'pixel(px + amount sin(py / 14 + t / 4), py + amount cos(px / 14 + t / 5))' } },
  { id: 'kenburns', name: 'Ken Burns', amount: null, kenBurns: true, get def() { return kenBurns(formula('zoom-formula', '1')); } },
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

/** Ken Burns: the part of the picture 1/zoom across, centered on (cx, cy) but kept inside the picture. */
function kenBurns(zoom) {
  const h = `(0.5 / max(1, ${zoom}))`, X = `clamp(cx, ${h}, 1 - ${h})`, Y = `clamp(cy, ${h}, 1 - ${h})`;
  return { name: 'Ken Burns', params: { cx: 0.5, cy: 0.5, p: 0 }, color: `crop(${X} - ${h}, ${Y} - ${h}, ${X} + ${h}, ${Y} + ${h})` };
}
const DRIFT = [[0.42, 0.56], [0.58, 0.44]];               // the path when none is drawn

const state = { picture: null, motion: MOTIONS[0], t: 0, playing: true, busy: false, path: makePath(DRIFT), drawing: false };
let view = null;
const status = (text, bad = false) => { $('status').textContent = text; $('status').classList.toggle('bad', bad); };
const amount = () => {
  const [lo, hi] = state.motion.amount ?? [0, 1];
  return lo + (hi - lo) * Number($('amount').value);
};

/** The knobs at time t: the sliders, and for Ken Burns where along the path it is (p) and the center there. */
function knobs(t = state.t) {
  const back = $('path-back').checked, period = (Number($('length').value) * 60) / (back ? 2 : 1);   // one loop = the length saved
  const p = progress(t, period, back), [cx, cy] = pointAt(state.path, p);
  return { amount: amount(), speed: Number($('speed').value), p, cx, cy };
}
/** "Your filter": the user's own, after the motion (step 1), its knobs set only in its passes. */
const yours = yourFilterPicker($('yours'), (recompile) => { if (recompile) setMotion(); });
function applyKnobs(t = state.t) {
  view.knobs(knobs(t));
  view.knobsAt([1], yours.values());
}
/** The motion (and the user's filter after it) on the view. */
function put(motion) {
  const step = yours.step();
  state.yoursError = '';
  try { view.set(step ? { steps: [motion, step] } : motion); }
  catch (e) { if (!step) throw e; view.set(motion); state.yoursError = `Your filter doesn't work here: ${e.message.split('\n')[0]}`; }
  applyKnobs();
}
/** The motion, with the formulas, on the view; a formula that doesn't work is marked and the last good one stays. */
function setMotion() {
  if (!view) return;
  const m = state.motion;
  // each formula on its own first, so a mistake is reported in the user's words, not the motion's
  for (const [id, label] of [['speed-formula', 'speed'], ['amount-formula', 'how much'], ['zoom-formula', 'zoom']]) {
    if (id === 'amount-formula' && !m.amount) continue;
    if (id === 'zoom-formula' && !m.kenBurns) continue;
    try { MZ.compileFilter({ params: { speed: 1, amount: 1, p: 0 }, color: formula(id, label) }); $(id).classList.remove('bad'); }
    catch (e) {
      $(id).classList.add('bad');
      status(`The ${label} formula doesn't work: ${e.message.replace(/^the filter: /, '').split('\n')[0]}`, true);
      try { put(withFormulas(m.kenBurns ? kenBurns('1.15 + 0.25 p') : m.def, 'speed', 'amount')); } catch { /* the motion alone always works */ }
      return;
    }
  }
  try {
    put(withFormulas(m.def, formula('speed-formula', 'speed'), m.amount ? formula('amount-formula', 'amount') : 'amount'));
    for (const id of ['speed-formula', 'amount-formula']) $(id).classList.remove('bad');
    status(state.yoursError, Boolean(state.yoursError));
  } catch (e) {
    for (const id of ['speed-formula', 'amount-formula']) $(id).classList.toggle('bad', $(id).value.trim() !== (id === 'speed-formula' ? 'speed' : 'amount'));
    status(`That formula doesn't work: ${e.message.split('\n')[0]}`, true);
    try { put(withFormulas(m.def, 'speed', 'amount')); } catch { /* the motion alone always works */ }
  }
}
function useMotion(m) {
  state.motion = m;
  for (const tile of $('motions').children) tile.setAttribute('aria-pressed', String(tile.dataset.id === m.id));
  $('amount-row').hidden = !m.amount;
  $('amount-formula-row').hidden = !m.amount;
  $('kb').hidden = !m.kenBurns;                       // Ken Burns: the zoom formula and the path instead of speed
  $('speed-row').hidden = Boolean(m.kenBurns);
  $('formulas').hidden = Boolean(m.kenBurns);
  if (!m.kenBurns) drawPath(false);
  if (m.amount) $('amount').value = String((m.amount[2] - m.amount[0]) / (m.amount[1] - m.amount[0]));
  setMotion();
}
function frame() {
  if (state.playing && view && !state.busy) {
    state.t += 1;                                     // a frame at 60 a second moves t by 1; the speed is in the math
    applyKnobs();
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
for (const id of ['speed-formula', 'amount-formula', 'zoom-formula']) $(id).addEventListener('input', () => { clearTimeout(formulaTimer); formulaTimer = setTimeout(setMotion, 300); });
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
    applyKnobs();
    const blob = await saveGif({
      count, delay: Math.round(1000 / FPS),
      frame: (i) => { applyKnobs(t0 + i * STEP); view.draw(t0 + i * STEP); g.drawImage(view.canvas, 0, 0, small.width, small.height); return small; },
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

// ---- the Ken Burns path: drawn on the whole picture (shown over the view while drawing) -----------------------------
const overlay = $('path-overlay');
function showPath() {
  if (!state.picture) return;
  overlay.width = state.picture.width; overlay.height = state.picture.height;
  const g = overlay.getContext('2d'), W = overlay.width, H = overlay.height;
  g.drawImage(state.picture, 0, 0);
  g.fillStyle = 'rgb(0 0 0 / .25)'; g.fillRect(0, 0, W, H);
  const pts = state.drawn ?? state.path;
  if (!pts.length) return;
  g.lineWidth = Math.max(3, W / 160); g.lineCap = g.lineJoin = 'round'; g.strokeStyle = '#ffd166';
  g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H))); g.stroke();
  for (const [[x, y], c] of [[pts[0], '#2fbf4a'], [pts[pts.length - 1], '#e0313b']]) { g.fillStyle = c; g.beginPath(); g.arc(x * W, y * H, g.lineWidth * 1.8, 0, 7); g.fill(); }
}
function drawPath(on) {
  state.drawing = on;
  overlay.hidden = !on;
  $('draw-path').setAttribute('aria-pressed', String(on));
  $('draw-path').textContent = on ? 'Done' : 'Draw the path';
  if (on) { showPath(); status('Draw where the middle of the view should go: green is the start, red the end.'); }
  else if (/^Draw where/.test($('status').textContent)) status('');
}
const at = (e) => { const r = overlay.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };
overlay.addEventListener('pointerdown', (e) => { overlay.setPointerCapture(e.pointerId); state.drawn = [at(e)]; showPath(); });
overlay.addEventListener('pointermove', (e) => { if (state.drawn) { state.drawn.push(at(e)); showPath(); } });
overlay.addEventListener('pointerup', () => {
  if (!state.drawn) return;
  if (state.drawn.length > 2) { state.path = makePath(state.drawn); status('The view follows your path. Draw again to change it, or press Done.'); }
  state.drawn = null;
  showPath();
});
$('draw-path').onclick = () => drawPath(!state.drawing);
$('clear-path').onclick = () => { state.path = makePath(DRIFT); if (state.drawing) showPath(); };

useMotion(MOTIONS[0]);
const first = Math.max(0, samples.findIndex((p) => /mountain/i.test(p.title || p.file)));
if (samples[first]) { $('sample').value = String(first); await usePicture(await loadPicture(samples[first].url, 2048), samples[first].credit); }
useMotion(state.motion);
requestAnimationFrame(frame);

window.qblurApp = { state, get view() { return view; }, MOTIONS, useMotion, setMotion, withFormulas, yours, makePath, knobs };     // for tools/check.mjs
