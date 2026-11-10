/**
 * Fancy text: words drawn as three masks — the letters, their border (a stroke round them) and a
 * shadow or glow (blurred) — coloured by one filter. The letters' and the border's colours are
 * formulas (a preset fills the box; the user can write anything the filter language allows), with
 * two colour knobs each and `pattern`, a picture. The masks are black with white where they are,
 * so `luma(fill)` is how much of the pixel is letter.
 *
 * Saved as a PNG (transparent unless a background colour is chosen), or a GIF when a formula uses t.
 */
import { createView, openFile, loadPicture, samplePhotos, download, saveGif, MZ } from '../kit.js';

const $ = (id) => document.getElementById(id);

const PRESETS = [
  { id: 'solid', name: 'Solid', formula: 'c1' },
  { id: 'gradient', name: 'Gradient', formula: 'mix(c1, c2, y)' },
  { id: 'sideways', name: 'Sideways', formula: 'mix(c1, c2, x)' },
  { id: 'gold', name: 'Gold', formula: 'mix((0.5, 0.32, 0.06), (1, 0.9, 0.5), 0.5 + 0.5 sin(14 y + 3 x))' },
  { id: 'chrome', name: 'Chrome', formula: 'if y < 0.5 then mix((0.97, 0.98, 1), (0.45, 0.55, 0.7), 2 y) else mix((0.18, 0.14, 0.1), (0.9, 0.86, 0.76), 2 y - 1)' },
  { id: 'rainbow', name: 'Rainbow', formula: 'fromhsv((fract(x + t / 200), 0.8, 1))' },
  { id: 'fire', name: 'Fire', formula: 'mix((1, 0.95, 0.3), (0.85, 0.1, 0), clamp(1.2 y + 0.12 sin(25 x + t / 3), 0, 1))' },
  { id: 'stripes', name: 'Stripes', formula: 'if fract((px + py) / 24) < 0.5 then c1 else c2' },
  { id: 'dots', name: 'Dots', formula: 'if (fract(px / 18) - 0.5)^2 + (fract(py / 18) - 0.5)^2 < 0.09 then c2 else c1' },
  { id: 'picture', name: 'Picture', formula: 'pattern' },
  { id: 'neon', name: 'Neon', formula: 'c1 (1.15 + 0.25 sin(t / 6))' },
];
const FONTS = [
  ['Anton', 'google'], ['Bangers', 'google'], ['Bebas Neue', 'google'], ['Lobster', 'google'], ['Pacifico', 'google'],
  ['Permanent Marker', 'google'], ['Righteous', 'google'], ['Rubik Mono One', 'google'], ['Press Start 2P', 'google'],
  ['Playfair Display', 'google'], ['Monoton', 'google'], ['Fredoka', 'google'],
  ['system-ui', 'system'], ['Georgia', 'system'], ['Impact', 'system'],
];

// the masks and the picture, all the size of the result
const masks = { fill: document.createElement('canvas'), border: document.createElement('canvas'), glow: document.createElement('canvas') };
let pattern = Object.assign(document.createElement('canvas'), { width: 4, height: 4 });
let view = null, W = 0, H = 0, compiledKey = '', moving = false, t = 0;
const status = (text, bad = false) => { $('status').textContent = text; $('status').classList.toggle('bad', bad); };
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const choice = (name) => document.querySelector(`input[name=${name}]:checked`).value;

/** A Google font, loaded once (its stylesheet, then the font itself) before the words are drawn in it. */
const loaded = new Set();
async function useFont(family) {
  const [, kind] = FONTS.find(([f]) => f === family) ?? [family, 'system'];
  if (kind === 'google' && !loaded.has(family)) {
    loaded.add(family);
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}&display=block` });
    document.head.append(link);
    await new Promise((r) => { link.onload = r; link.onerror = r; });
  }
  try { await document.fonts.load(`64px "${family}"`, $('words').value || 'A'); } catch { /* the fallback font draws */ }
}

/** The words as masks: letters, a stroke round them, and the shadow or glow; the result is sized to fit. */
function drawMasks() {
  const size = Number($('size').value), family = $('font').value;
  const bw = Number($('border-width').value), glow = choice('glow');
  const font = `${size}px "${family}"${family === 'system-ui' ? '' : ', system-ui'}`;
  const lines = ($('words').value || ' ').split('\n');
  const measure = masks.fill.getContext('2d');
  measure.font = font;
  const widest = Math.max(...lines.map((l) => measure.measureText(l).width), 1);
  const lineH = size * 1.15, blur = glow === 'none' ? 0 : size * 0.12, shift = glow === 'shadow' ? size * 0.06 : 0;
  const pad = Math.ceil(bw + blur * 2 + shift + size * 0.08);
  const w = Math.ceil(widest + 2 * pad), h = Math.ceil(lines.length * lineH + 2 * pad);
  const resized = w !== W || h !== H;
  W = w; H = h;
  const shape = (g, stroke) => {
    g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    lines.forEach((line, i) => {
      const y = pad + (i + 0.5) * lineH;
      if (stroke) g.strokeText(line, W / 2, y);
      g.fillText(line, W / 2, y);
    });
  };
  for (const [name, c] of Object.entries(masks)) {
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.fillStyle = g.strokeStyle = '#fff';
    if (name === 'fill') shape(g, false);
    else if (name === 'border') { if (bw > 0) { g.lineWidth = 2 * bw; shape(g, true); } }
    else if (blur) {
      // the outer shape (letters and border), blurred; a shadow is moved down and right
      g.filter = `blur(${blur}px)`;
      g.lineWidth = 2 * bw;
      g.translate(shift, shift);
      shape(g, bw > 0);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.filter = 'none';
    }
  }
  return resized;
}

/** The filter: three layers, letters over border over glow, over the background (or nothing). */
function filterFor(fillF, borderF) {
  const border = borderF.replace(/\bc1\b/g, 'k1').replace(/\bc2\b/g, 'k2');      // the border's own two colours
  const wf = 'luma(fill)', wb = 'luma(border) (1 - luma(fill))', wg = 'shade luma(glow) (1 - luma(fill)) (1 - luma(border))';
  const cover = `(${wf} + ${wb} + ${wg})`;
  return {
    name: 'Fancy text',
    images: { fill: {}, border: {}, glow: {}, pattern: {} },
    params: { c1: [1, 0.8, 0.2], c2: [1, 0.2, 0.4], k1: [0.1, 0.1, 0.2], k2: [0.3, 0.2, 0.6], g1: [0, 0, 0], bg: [1, 1, 1], opaque: 0, shade: 0.8 },
    color: {
      rgb: `((${fillF}) ${wf} + (${border}) ${wb} + g1 ${wg} + opaque bg (1 - ${cover})) / max(${cover} + opaque (1 - ${cover}), 0.0001)`,
      a: `${cover} + opaque (1 - ${cover})`,
    },
  };
}
function knobs() {
  const glow = choice('glow');
  return {
    c1: hex($('c1').value), c2: hex($('c2').value), k1: hex($('k1').value), k2: hex($('k2').value),
    g1: hex($('glow-colour').value), bg: hex($('bg-colour').value),
    opaque: choice('bg') === 'colour' ? 1 : 0, shade: glow === 'none' ? 0 : glow === 'shadow' ? 0.75 : 1,
  };
}

/** Compile when a formula or the size changes; otherwise new knobs and masks are enough. */
function update({ force = false } = {}) {
  const resized = drawMasks();
  if (!view) view = createView($('frame'), W, H, { label: 'your text' });
  if (resized) { view.resize(W, H); force = true; }
  const key = [$('fill').value, $('border').value].join('\n');
  if (force || key !== compiledKey) {
    // each formula on its own first, as a colour, so an error says which box it is in and quotes only what was typed
    for (const part of ['fill', 'border']) {
      try {
        MZ.compileFilter({ name: part === 'fill' ? 'Letters' : 'Border', images: { pattern: {} }, params: { c1: [1, 1, 1], c2: [0, 0, 0] }, color: $(part).value || 'c1' }, { version: 100 });
        $(`${part}-error`).textContent = '';
        $(part).classList.remove('bad');
      } catch (e) {
        $(`${part}-error`).textContent = e.message.split('\n')[0].replace(/^"[^"]*": /, '');
        $(part).classList.add('bad');
        return;
      }
    }
    view.set(filterFor($('fill').value, $('border').value));
    compiledKey = key;
    moving = view.compiled.passes.some((p) => { try { return MZ.compileCpuPass(p).uses.has('t'); } catch { return false; } });
    $('gif').hidden = !moving;
  }
  for (const [name, c] of Object.entries(masks)) view.setImage(name, c);
  view.setImage('pattern', pattern);
  view.knobs(knobs());
  view.draw(t);
}
function frame() {
  if (moving && view) { t += 1; view.knobs(knobs()); view.draw(t); }
  requestAnimationFrame(frame);
}

function presetTiles(box, input) {
  for (const p of PRESETS) {
    const tile = Object.assign(document.createElement('button'), { type: 'button', className: 'tile', textContent: p.name });
    tile.dataset.formula = p.formula;
    tile.onclick = () => { input.value = p.formula; markPreset(box, input); update(); };
    box.append(tile);
  }
}
function markPreset(box, input) {
  for (const tile of box.children) tile.setAttribute('aria-pressed', String(tile.dataset.formula === input.value.trim()));
}

// ---- wiring --------------------------------------------------------------------------
$('font').append(...FONTS.map(([f]) => new Option(f, f)));
presetTiles($('fill-presets'), $('fill'));
presetTiles($('border-presets'), $('border'));
$('fill').value = PRESETS.find((p) => p.id === 'gradient').formula;
$('border').value = PRESETS.find((p) => p.id === 'solid').formula;
markPreset($('fill-presets'), $('fill'));
markPreset($('border-presets'), $('border'));

let typing = null;
const soon = () => { clearTimeout(typing); typing = setTimeout(update, 120); };
for (const id of ['words', 'size', 'border-width']) $(id).addEventListener('input', soon);
for (const part of ['fill', 'border']) $(part).addEventListener('input', () => { markPreset($(`${part}-presets`), $(part)); soon(); });
for (const id of ['c1', 'c2', 'k1', 'k2', 'glow-colour', 'bg-colour']) $(id).addEventListener('input', () => { if (view) { view.knobs(knobs()); view.draw(t); } });
for (const r of document.querySelectorAll('input[name=glow], input[name=bg]')) r.addEventListener('change', () => update());
$('font').onchange = async () => { await useFont($('font').value); update(); };
$('words').addEventListener('input', () => useFont($('font').value).then(soon));

const samples = await samplePhotos();
$('sample').append(new Option('a sample photo', ''), ...samples.map((p, i) => new Option(p.title || p.file, String(i))));
$('sample').onchange = async () => {
  const p = samples[Number($('sample').value)];
  if (p) { pattern = await loadPicture(p.url, 1200); update(); }
};
$('file').onchange = async () => {
  try { pattern = await openFile($('file').files[0], 1600); $('sample').value = ''; update(); }
  catch (e) { status(e.message, true); }
};

$('download').onclick = async () => {
  if (!view) return;
  update();
  const out = view.snapshot();
  if (!window.qblurNoDownload) await download(out, 'fancy-text.png');
  status(`Saved a ${out.width} × ${out.height} PNG${choice('bg') === 'none' ? ', transparent round the text' : ''}.`);
};
/** A GIF can't be partly transparent: its frames are drawn on the background colour (white when there is none). */
$('gif').onclick = async () => {
  if (!view) return;
  const s = Math.min(1, 640 / Math.max(W, H));
  const small = Object.assign(document.createElement('canvas'), { width: Math.round(W * s), height: Math.round(H * s) });
  const g = small.getContext('2d', { willReadFrequently: true });
  const t0 = t;
  moving = false;                                              // the GIF draws its own frames
  try {
    const blob = await saveGif({
      count: 45, delay: 67,
      frame: (i) => {
        view.draw(t0 + i * 4);
        g.fillStyle = choice('bg') === 'colour' ? $('bg-colour').value : '#ffffff';
        g.fillRect(0, 0, small.width, small.height);
        g.drawImage(view.canvas, 0, 0, small.width, small.height);
        return small;
      },
      progress: (i) => status(`Making the GIF… frame ${i + 1} of 45`),
    });
    if (!window.qblurNoDownload) await download(blob, 'fancy-text.gif');
    status(`Saved a ${small.width} × ${small.height} GIF, ${Math.round(blob.size / 1024)} KB.`);
    window.qblurApp.lastGif = blob;
  } catch (e) { status(e.message, true); }
  moving = true;
};

// start: a sample picture ready for "Picture", the first font loaded
const first = Math.max(0, samples.findIndex((p) => /charleston/i.test(p.title || p.file)));
if (samples[first]) { $('sample').value = String(first); pattern = await loadPicture(samples[first].url, 1200); }
await useFont($('font').value);
update();
requestAnimationFrame(frame);

window.qblurApp = { get view() { return view; }, update, PRESETS, lastGif: null };   // for tools/check.mjs
