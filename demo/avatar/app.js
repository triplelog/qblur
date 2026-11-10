/**
 * Profile picture: a photo, framed on the person in it, in a style, with the background kept,
 * blurred, replaced or removed, cut to a circle, saved as a 1024 × 1024 PNG — or cut out round the
 * person as a sticker (a transparent PNG, an outline round the silhouette if wanted).
 *
 * The frame is a square of the photo (centre and side, in the photo's pixels) drawn into a 1024
 * canvas — or, cut out, the person's box with a margin, 1024 on its long side; the filter runs on that. The person is outlined by MobileSAM (../ai.js):
 * a guess from two clicks where a portrait's subject is (face, chest), then the user's own marks —
 * with "Mark me" / "Mark not me" (a toggle under the photo), each click adds a point in or out, shown
 * as a dot; "Keep as is" paints over areas that are right, which later answers don't change. The outline is the `selection`, so the background step is `mix(…, rgb, selected)`.
 */
import { createView, openFile, loadPicture, samplePhotos, showCredit, download, dragAndZoom, byName, ROOT, ORT_URL, MEDIAPIPE_URL } from '../kit.js';
import { setupAI } from '../ai.js';

const $ = (id) => document.getElementById(id);
const SIZE = 1024;                     // what is saved
const THUMB = 112;                     // the style previews

/** The styles: steps for a filter chain; `s` is the output's size over 1024, for effects measured in pixels. */
const STYLES = [
  { id: 'natural', name: 'Natural', steps: () => [] },
  { id: 'bw', name: 'Black & white', steps: () => [byName('Grayscale'), { filter: byName('Brightness & contrast'), with: { contrast: 1.15 } }] },
  { id: 'warm', name: 'Warm', steps: () => ['rgb * (1.1, 1.0, 0.86)'] },
  { id: 'cool', name: 'Cool', steps: () => ['rgb * (0.9, 1.0, 1.12)'] },
  { id: 'vivid', name: 'Vivid', steps: () => [byName('Vivid')] },
  { id: 'vintage', name: 'Vintage', steps: () => [byName('Sepia'), { filter: byName('Vignette'), with: { strength: 1.2 } }] },
  { id: 'duotone', name: 'Duotone', steps: () => [{ name: 'Duotone', params: { dark: [0.12, 0.09, 0.35], light: [1, 0.78, 0.45] }, color: 'mix(dark, light, gray)' }] },
  { id: 'pop', name: 'Pop art', steps: () => [byName('Vivid'), { filter: byName('Posterize'), with: { levels: 4 } }] },
  { id: 'comic', name: 'Comic', steps: () => [byName('Comic')] },
  { id: 'cartoon', name: 'Cartoon', steps: () => [byName('Cartoon')] },
  { id: 'sketch', name: 'Sketch', steps: (s) => [`gaussian(${(2.2 * s).toFixed(2)})`, '(1 - smoothstep(0.06, 0.3, sobel())) * (1, 1, 1)'] },
  { id: 'dreamy', name: 'Dreamy', steps: () => [byName('Dreamy')] },
  { id: 'pixel', name: 'Pixel', steps: (s) => [{ filter: byName('Pixelate'), with: { size: Math.max(2, Math.round(28 * s)) } }] },
];
/** The background, applied after the style: `selected` is 1 on the person. */
const BACKGROUNDS = {
  keep: null,
  blur: (s) => ({ name: 'Blurred background', color: `mix(gaussian(${(10 * s).toFixed(1)}), rgb, selected)` }),
  colour: () => ({ name: 'Colour background', params: { c1: [0.16, 0.44, 0.86] }, color: 'mix(c1, rgb, selected)' }),
  gradient: () => ({ name: 'Gradient background', params: { c1: [0.16, 0.44, 0.86], c2: [0.96, 0.64, 0.78] }, color: 'mix(mix(c1, c2, y), rgb, selected)' }),
  none: () => ({ name: 'No background', color: { rgb: 'rgb', a: 'a selected' } }),
};
/** A cut-out's outline: `outline` is the person's shape grown a little; where it is and the person isn't, the ring colour. */
const OUTLINE = { name: 'Sticker outline', images: { outline: {} }, params: { ringc: [1, 1, 1] }, color: { rgb: 'mix(ringc, rgb, selected)', a: 'max(a, luma(outline))' } };

const state = { picture: null, person: null, frame: null, style: 'natural', bg: 'keep', moved: false, found: undefined, shape: 'circle' };
const framed = Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
const framedMask = Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
const outline = Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
const WHITE = Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
WHITE.getContext('2d').fillStyle = '#fff'; WHITE.getContext('2d').fillRect(0, 0, 1, 1);

const view = createView($('frame'), SIZE, SIZE, { label: 'your profile picture' });
const thumbBox = document.createElement('div');                      // the previews are drawn here, then copied to the tiles
const thumbs = createView(thumbBox, THUMB, THUMB);
const status = (text, bad = false) => { $('status').textContent = text; $('status').classList.toggle('bad', bad); };
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

const ai = setupAI({
  source: () => state.picture, model: 'mobilesam', base: ROOT, ortUrl: ORT_URL, mediapipeUrl: MEDIAPIPE_URL,
  onProgress: (text) => { if (text) status(text.replace(/^(Loading )?MobileSAM( \(\d of 2\))?/, 'Getting ready to find you')); },
});

// ---- the frame ------------------------------------------------------------------
function clampFrame() {
  const { width: w, height: h } = state.picture;
  const f = state.frame;
  f.size = Math.min(f.size, w, h);
  f.cx = Math.min(w - f.size / 2, Math.max(f.size / 2, f.cx));
  f.cy = Math.min(h - f.size / 2, Math.max(f.size / 2, f.cy));
  $('zoom').value = String(Math.min(w, h) / f.size);
}
/** The part of the photo that is drawn: the square frame, or (cut out) the person's box with a margin. */
function region() {
  if (state.shape === 'cutout' && state.personBox) {
    const [x0, y0, x1, y1] = state.personBox, m = 0.06 * Math.max(x1 - x0, y1 - y0);
    const x = Math.max(0, x0 - m), y = Math.max(0, y0 - m);
    return { x, y, w: Math.min(state.picture.width, x1 + m) - x, h: Math.min(state.picture.height, y1 + m) - y };
  }
  const f = state.frame;
  return { x: f.cx - f.size / 2, y: f.cy - f.size / 2, w: f.size, h: f.size };
}
function drawFramed() {
  const r = region();
  const k = SIZE / Math.max(r.w, r.h);
  const W = Math.round(r.w * k), H = Math.round(r.h * k);
  if (framed.width !== W || framed.height !== H) {
    for (const c of [framed, framedMask, outline]) { c.width = W; c.height = H; }
    view.resize(W, H);
    shape = '';                                                    // the passes are sized to the canvas: build them again
  }
  framed.getContext('2d').drawImage(state.picture, r.x, r.y, r.w, r.h, 0, 0, W, H);
  if (state.person) {
    const m = framedMask.getContext('2d');
    m.clearRect(0, 0, W, H);
    m.filter = 'blur(2px)';                                       // a soft edge: the model's outline is a little coarse
    m.drawImage(state.person, r.x, r.y, r.w, r.h, 0, 0, W, H);
    m.filter = 'none';
    if (state.shape === 'cutout' && $('ring').checked) drawOutline(W, H);
  }
}
/** The person's shape grown by the outline's width (a blur, then everything it reached). */
function drawOutline(W, H) {
  const g = outline.getContext('2d', { willReadFrequently: true });
  const width = Math.round(0.022 * Math.max(W, H));
  g.clearRect(0, 0, W, H);
  g.filter = `blur(${width / 2}px)`;
  g.drawImage(framedMask, 0, 0);
  g.filter = 'none';
  const img = g.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const v = Math.min(255, Math.max(0, (d[i + 3] - 8) * 12)); d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = v; }
  g.putImageData(img, 0, 0);
}

// ---- the filter -------------------------------------------------------------------
function chainFor(styleId, bg, s = 1, sticker = false) {
  const steps = [...STYLES.find((st) => st.id === styleId).steps(s)];
  if (bg !== 'keep' && state.person) steps.push(BACKGROUNDS[bg](s));
  if (sticker && state.person) steps.push(OUTLINE);
  return steps.length ? { steps } : 'rgb';
}
const sticker = () => state.shape === 'cutout' && $('ring').checked;
function bgKnobs() { return { c1: hex($('bg1').value), c2: hex($('bg2').value), ringc: hex($('ring-colour').value) }; }
let shape = '';
function rebuild() {
  try {
    view.set(chainFor(state.style, state.bg, 1, sticker()), bgKnobs());
    shape = JSON.stringify([state.style, state.bg, Boolean(state.person), sticker(), framed.width, framed.height]);
  } catch (e) { status(e.message, true); }
  render();
}
function render() {
  if (!state.picture) return;
  drawFramed();
  if (shape !== JSON.stringify([state.style, state.bg, Boolean(state.person), sticker(), framed.width, framed.height])) { rebuild(); return; }
  view.setImage('source', framed);
  view.setImage('selection', state.person ? framedMask : WHITE);
  view.setImage('outline', outline);
  view.knobs(bgKnobs());
  view.draw(0);
  const ring = $('ring').checked && state.shape !== 'cutout';      // a cut-out's outline is drawn by the filter
  $('frame').style.setProperty('--ring', ring ? $('ring-colour').value : 'transparent');
  $('frame').style.setProperty('--ring-w', `${(ring ? 0.035 : 0) * $('frame').clientWidth}px`);
  drawMarks();
}

/** The style tiles: each style on a small copy of the frame (redrawn a moment after the frame stops moving). */
function makeTiles() {
  const box = $('styles');
  for (const st of STYLES) {
    const tile = Object.assign(document.createElement('button'), { type: 'button', className: 'tile' });
    tile.dataset.style = st.id;
    tile.setAttribute('aria-pressed', String(st.id === state.style));
    const c = Object.assign(document.createElement('canvas'), { width: THUMB, height: THUMB });
    c.setAttribute('aria-hidden', 'true');
    tile.append(c, st.name);
    tile.onclick = () => {
      state.style = st.id;
      for (const t of box.children) t.setAttribute('aria-pressed', String(t === tile));
      render();
    };
    box.append(tile);
  }
}
let thumbTimer = null;
function updateTiles() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    const small = Object.assign(document.createElement('canvas'), { width: THUMB, height: THUMB });
    small.getContext('2d').drawImage(framed, 0, 0, THUMB, THUMB);
    thumbs.setImage('source', small);
    for (const tile of $('styles').children) {
      try {
        thumbs.set(chainFor(tile.dataset.style, 'keep', THUMB / SIZE));
        thumbs.draw(0);
        tile.querySelector('canvas').getContext('2d').drawImage(thumbs.canvas, 0, 0);
      } catch { /* a preview is a nicety */ }
    }
  }, 250);
}

// ---- finding the person -------------------------------------------------------------
/** The model's copy of the photo: at most 1024 across (the outline is as good, and the masks much smaller). */
function smallCopy() {
  const { width: w, height: h } = state.picture, k = Math.min(1, 1024 / Math.max(w, h));
  state.small = Object.assign(document.createElement('canvas'), { width: Math.round(w * k), height: Math.round(h * k) });
  state.small.getContext('2d').drawImage(state.picture, 0, 0, state.small.width, state.small.height);
}
/** A mask over state.small (1 = the person) becomes the person: the outline, its box, the frame. */
function useMask(mask, { reframe, prompt = null }) {
  const { width: w, height: h } = state.picture;
  const sw = state.small.width, sh = state.small.height, k = sw / w;
  state.found = state.picture;
  let area = 0, x0 = sw, y0 = sh, x1 = 0, y1 = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    area++;
    const x = i % sw, y = (i - x) / sw;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  // a guess that takes almost nothing or almost everything isn't a person in the middle: ask instead
  if (!area || (!prompt && (area < 0.04 * sw * sh || area > 0.85 * sw * sh))) {
    state.person = null;
    state.personMask = new Uint8Array(sw * sh);
    state.prompt = { points: [], labels: [] };
    status(prompt ? 'Nothing there — choose "Mark me" and click on yourself.' : 'Choose "Mark me" under the photo and click on yourself to show where you are.');
    render();
    return false;
  }
  state.prompt = prompt ?? { points: GUESS(w, h).points, labels: [1, 1] };
  state.personMask = Uint8Array.from(mask);
  const small = Object.assign(document.createElement('canvas'), { width: sw, height: sh });
  const img = new ImageData(sw, sh);
  for (let i = 0; i < mask.length; i++) if (mask[i]) img.data.set([255, 255, 255, 255], i * 4);
  small.getContext('2d').putImageData(img, 0, 0);
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  c.getContext('2d').drawImage(small, 0, 0, w, h);          // smoothed on the way up
  state.person = c;
  state.personBox = [x0 / k, y0 / k, (x1 + 1) / k, (y1 + 1) / k];
  if (reframe) frameOn(state.personBox);
  status('');
  render();
  return true;
}
/** A sample's outline worked out ahead of time (photos/index.json "person": a PNG the size of the model's copy, white = the
 *  person), so opening the page doesn't download the model; it loads when the user marks or opens their own photo. */
async function usePrecomputed(url) {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    smallCopy();
    const sw = state.small.width, sh = state.small.height;
    const g = Object.assign(document.createElement('canvas'), { width: sw, height: sh }).getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, sw, sh);
    const d = g.getImageData(0, 0, sw, sh).data, mask = new Uint8Array(sw * sh);
    for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4] > 127 ? 1 : 0;
    return useMask(mask, { reframe: true });
  } catch { return false; }
}
/** The person: MobileSAM's outline from a guess (where a portrait's subject is) or the user's clicks; the frame goes to head and shoulders. */
const GUESS = (w, h) => ({ points: [[w * 0.5, h * 0.35], [w * 0.5, h * 0.65]], labels: [1, 1] });
async function findPerson({ reframe, prompt = null }) {
  if (!prompt && state.found === state.picture) { if (reframe && state.person) frameOn(state.personBox); return Boolean(state.person); }
  status('Finding you in the photo…');
  try {
    const { width: w } = state.picture;
    if (state.looked !== state.picture) {
      smallCopy();
      ai.invalidate();
      await ai.embed(state.small);
      state.looked = state.picture;
    }
    const sw = state.small.width, sh = state.small.height, k = sw / w;
    const ask = prompt ? { points: prompt.points.map(([x, y]) => [x * k, y * k]), labels: prompt.labels } : GUESS(sw, sh);
    const mask = await ai.mask(ask);
    if (state.lock) for (let i = 0; i < mask.length; i++) if (state.lock[i]) mask[i] = state.kept[i];   // what was kept stays as it was
    return useMask(mask, { reframe, prompt });
  } catch (e) {
    status(e.message, true);
    return false;
  }
}
// ---- marking: a point on the person (Mark me) or not (Mark not me) per click; areas kept as they are --------
// MobileSAM is given only the points clicked (and its first guess): a few well-placed points work best.
// "Keep as is" paints over an area that is right: there the outline stays as it was when painted,
// whatever the model answers after (state.lock: 1 where kept; state.kept: the outline there then).
let dragged = 0;
const tool = () => document.querySelector('input[name=tool]:checked').value;
/** A point of the photo under the pointer. */
function photoPoint(e) {
  const rect = view.canvas.getBoundingClientRect(), r = region();
  return [r.x + ((e.clientX - rect.left) / rect.width) * r.w, r.y + ((e.clientY - rect.top) / rect.height) * r.h];
}
/** The marks start from the guess (or the points that made the outline), so a first mark refines it rather than starting over. */
function marks() {
  if (!state.marks) state.marks = state.person && state.prompt ? { points: [...state.prompt.points], labels: [...state.prompt.labels] } : { points: [], labels: [] };
  return state.marks;
}
function addMark(point, label) {
  const m = marks();
  m.points.push(point);
  m.labels.push(label);
  drawMarks();
  runMarks();
}
/** The model on the marks; a click made while it works waits for the next run, so it never falls behind. */
let running = false, again = false;
async function runMarks() {
  if (running) { again = true; return; }
  if (!state.marks.labels.includes(1)) { status('Mark yourself first ("Mark me"), then what isn\'t you.'); return; }
  running = true;
  do {
    again = false;
    await findPerson({ reframe: false, prompt: { points: [...state.marks.points], labels: [...state.marks.labels] } });
  } while (again);
  running = false;
}
/** Paint "keep" round a point of the photo: a disc a twentieth of what is in view, in the model's (small) picture. */
function keepAt([x, y]) {
  if (!state.small || !state.personMask) return false;
  const sw = state.small.width, sh = state.small.height, k = sw / state.picture.width;
  if (!state.lock) {
    state.lock = new Uint8Array(sw * sh);
    state.kept = new Uint8Array(sw * sh);
    state.lockCanvas = Object.assign(document.createElement('canvas'), { width: sw, height: sh });
  }
  const r = region(), R = 0.05 * Math.max(r.w, r.h) * k, cx = x * k, cy = y * k;
  for (let j = Math.max(0, Math.floor(cy - R)); j <= Math.min(sh - 1, Math.ceil(cy + R)); j++) {
    for (let i = Math.max(0, Math.floor(cx - R)); i <= Math.min(sw - 1, Math.ceil(cx + R)); i++) {
      const at = j * sw + i;
      if ((i - cx) ** 2 + (j - cy) ** 2 > R * R || state.lock[at]) continue;
      state.lock[at] = 1;
      state.kept[at] = state.personMask[at];
    }
  }
  const g = state.lockCanvas.getContext('2d');
  g.fillStyle = '#3d7bff';
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fill();
  return true;
}
/** What is used, over the photo: the points (green on you, red not) and the kept areas (blue). */
function drawMarks() {
  const c = $('marks'), dpr = devicePixelRatio || 1;
  const w = Math.round($('frame').clientWidth * dpr), h = Math.round($('frame').clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!state.picture || !$('show-marks').checked) return;
  const r = region();
  if (state.lock) {
    const k = state.small.width / state.picture.width;
    g.globalAlpha = 0.35;
    g.drawImage(state.lockCanvas, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, w, h);
    g.globalAlpha = 1;
  }
  const used = state.marks ?? (state.person ? state.prompt : null);
  if (!used) return;
  used.points.forEach(([x, y], k) => {
    const px = ((x - r.x) / r.w) * w, py = ((y - r.y) / r.h) * h;
    g.beginPath();
    g.arc(px, py, 6 * dpr, 0, Math.PI * 2);
    g.fillStyle = used.labels[k] ? '#2fbf4a' : '#e0313b';
    g.fill();
    g.lineWidth = 2 * dpr;
    g.strokeStyle = '#fff';
    g.stroke();
  });
}
{
  let keeping = null;                                             // the last point of a "keep" drag
  const pointers = new Set();
  $('frame').addEventListener('pointerdown', (e) => {
    pointers.add(e.pointerId);
    keeping = null;
    if (tool() === 'move' || !state.picture || pointers.size > 1) return;   // two fingers: a pinch, not a mark
    const p = photoPoint(e);
    if (tool() === 'keep') {
      if (!keepAt(p)) { status('Wait until you are outlined, then paint over what is right.'); return; }
      keeping = p;
      drawMarks();
    } else addMark(p, tool() === 'add' ? 1 : 0);
  });
  $('frame').addEventListener('pointermove', (e) => {
    if (!keeping || !pointers.has(e.pointerId)) return;
    const p = photoPoint(e), r = region(), step = 0.02 * Math.max(r.w, r.h);
    const n = Math.ceil(Math.hypot(p[0] - keeping[0], p[1] - keeping[1]) / step);
    for (let s = 1; s <= n; s++) keepAt([keeping[0] + ((p[0] - keeping[0]) * s) / n, keeping[1] + ((p[1] - keeping[1]) * s) / n]);
    keeping = p;
    drawMarks();
  });
  const end = (e) => { pointers.delete(e.pointerId); keeping = null; };
  $('frame').addEventListener('pointerup', end);
  $('frame').addEventListener('pointercancel', end);
}
for (const r of document.querySelectorAll('input[name=tool]')) r.onchange = () => {
  $('frame').classList.toggle('grab', tool() === 'move' && state.shape !== 'cutout');
  $('frame').classList.toggle('pick', tool() !== 'move');
  $('frame').title = { move: 'drag to move, scroll or pinch to zoom', add: 'click on yourself', remove: 'click on what isn\'t you', keep: 'paint over what is outlined right, to keep it as it is' }[tool()];
  if (tool() !== 'move' && state.picture && !state.person && !state.marks) status('Click on yourself to show where you are.');
  drawMarks();
};
$('show-marks').onchange = drawMarks;
$('clear-marks').onclick = () => {
  state.marks = null;
  state.lock = state.kept = state.lockCanvas = null;
  state.found = undefined;                                       // look again from the guess
  drawMarks();
  findPerson({ reframe: false });
};

/** Head and shoulders: a square on the upper part of the person's box. */
function frameOn([x0, y0, x1, y1]) {
  const bw = x1 - x0, bh = y1 - y0;
  const size = Math.max(bw * 1.15, Math.min(bh, bw * 1.6) * 0.85);
  state.frame = { cx: (x0 + x1) / 2, cy: y0 + size * 0.46, size };
  clampFrame();
  render();
  updateTiles();
}

// ---- the photo ------------------------------------------------------------------------
async function usePicture(canvas, credit = '', person = '') {
  state.picture = canvas;
  state.person = null;
  state.found = undefined;
  state.prompt = null;
  state.marks = null;
  state.lock = state.kept = state.lockCanvas = null;
  state.personMask = null;
  state.moved = false;
  const side = Math.min(canvas.width, canvas.height);
  state.frame = { cx: canvas.width / 2, cy: canvas.height / 2, size: side };
  clampFrame();
  showCredit($('credit'), credit);
  shape = '';
  render();
  updateTiles();
  if (person && await usePrecomputed(person)) return;           // a sample with its outline ready: no model yet
  findPerson({ reframe: true });                              // centred on you, as soon as the model has looked
}

$('file').onchange = async () => {
  try { await usePicture(await openFile($('file').files[0], 2048)); $('sample').value = ''; }
  catch (e) { status(e.message, true); }
};
const samples = await samplePhotos();
$('sample').append(new Option('a sample photo', ''), ...samples.map((p, i) => new Option(p.title || p.file, String(i))));
$('sample').onchange = async () => {
  const p = samples[Number($('sample').value)];
  if (p) await usePicture(await loadPicture(p.url, 2048), p.credit, p.personUrl);
};

// ---- the controls ------------------------------------------------------------------------
makeTiles();
dragAndZoom($('frame'), {
  onStart: () => { dragged = 0; },
  onMove: (dx, dy) => {
    dragged += Math.hypot(dx, dy);
    if (dragged > 5) state.moved = true;
    if (!state.picture || state.shape === 'cutout' || tool() !== 'move' || dragged <= 5) return;
    const k = state.frame.size / $('frame').clientWidth;
    state.frame.cx -= dx * k;
    state.frame.cy -= dy * k;
    clampFrame(); render(); updateTiles();
  },
  onZoom: (f) => {
    if (!state.picture || state.shape === 'cutout') return;
    state.frame.size /= f;
    clampFrame(); render(); updateTiles();
  },
});
$('zoom').oninput = () => {
  state.frame.size = Math.min(state.picture.width, state.picture.height) / Number($('zoom').value);
  clampFrame(); render(); updateTiles();
};
$('centre').onclick = () => findPerson({ reframe: true });
for (const r of document.querySelectorAll('input[name=bg]')) r.onchange = async () => {
  state.bg = r.value;
  $('bg-colours').hidden = !(r.value === 'colour' || r.value === 'gradient');
  $('bg2').hidden = r.value !== 'gradient';
  if (r.value !== 'keep' && !state.person) await findPerson({ reframe: !state.moved });
  render();
};
for (const id of ['bg1', 'bg2', 'ring', 'ring-colour']) $(id).oninput = render;
for (const r of document.querySelectorAll('input[name=shape]')) r.onchange = async () => {
  if (!r.checked) return;
  if (r.value === 'cutout' && !state.person && !(await findPerson({ reframe: false }))) {
    status('A cut-out needs a person in the photo.', true);
    document.querySelector('input[name=shape][value=circle]').checked = true;
    return;
  }
  state.shape = r.value;
  $('frame').classList.toggle('round', r.value === 'circle');
  $('frame').classList.toggle('grab', r.value !== 'cutout' && tool() === 'move');
  if (r.value === 'cutout' && state.bg !== 'none') document.querySelector('input[name=bg][value=none]').click();   // a sticker: nothing round it
  $('ring-label').textContent = r.value === 'cutout' ? 'outline' : 'ring';
  render();
};
addEventListener('resize', render);

$('download').onclick = async () => {
  if (!state.picture) return;
  render();
  const out = Object.assign(document.createElement('canvas'), { width: view.canvas.width, height: view.canvas.height });
  const g = out.getContext('2d');
  if (state.shape === 'cutout') {
    g.drawImage(view.canvas, 0, 0);
    if (!window.qblurNoDownload) await download(out, 'sticker.png');
    status(`Saved a ${out.width} × ${out.height} PNG${state.bg === 'none' ? ' with a transparent background' : ''}.`);
    return;
  }
  const circle = state.shape === 'circle';
  if (circle) { g.beginPath(); g.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2); g.clip(); }
  g.drawImage(view.canvas, 0, 0);
  if ($('ring').checked) {
    const w = SIZE * 0.035;
    g.strokeStyle = $('ring-colour').value;
    g.lineWidth = w;
    if (circle) { g.beginPath(); g.arc(SIZE / 2, SIZE / 2, SIZE / 2 - w / 2, 0, Math.PI * 2); g.stroke(); }
    else g.strokeRect(w / 2, w / 2, SIZE - w, SIZE - w);
  }
  if (!window.qblurNoDownload) await download(out, 'profile-picture.png');
  status(`Saved a ${SIZE} × ${SIZE} PNG${circle || state.bg === 'none' ? ' (transparent where there is nothing)' : ''}.`);
};

// start on the portrait sample
const first = Math.max(0, samples.findIndex((p) => /portrait/i.test(p.title || p.file)));
if (samples[first]) { $('sample').value = String(first); await usePicture(await loadPicture(samples[first].url, 2048), samples[first].credit, samples[first].personUrl); }

window.qblurApp = { state, view, ai, findPerson, render, STYLES, addMark, keepAt, runMarks };     // for tools/check.mjs
