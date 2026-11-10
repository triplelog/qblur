import * as core from 'mathzetta';   // the core (shared with qblur's own imports); qblur's checks read window.MathZetta
import * as filters from '@mathzetta/qblur';
import { HELP, explain } from './help.js';
import { EXAMPLES, resolveExample } from './examples.js';
import { decodeGif } from './gif.js';
import { setupExport } from './export.js';
import { setupSelection } from './livewire.js';
import { setupAI, AI_MODELS, DEFAULT_MODEL, SHIPPED_MODELS } from './ai.js';
import { createTracker, resample } from './tracker.js';
import { renderMarkdownInto, markdownToHTML, createVariables } from '@mathzetta/inlinemath/markdown';
import {
  HOW, definitionOf, inlineDefinition, parseDefinition, numberOf, sliderStep, blocksOf, notesOf, freeName, renameInMaths, bakeStep, trim, toHex, fromHex,
} from './knobs.js';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
const MZ = { ...core, ...filters };
window.MathZetta = MZ;   // for tools/check.mjs
const $ = (id) => document.getElementById(id);

// ---- built-in library ------------------------------------------------------
const BUILTIN = MZ.LIBRARY;
const byName = (name) => BUILTIN.find((f) => f.name === name);

// Saved filters: a list of filters (the format's JSON) in localStorage, under "qblur".
const STORE = 'qblur';
const saved = () => { try { const list = JSON.parse(localStorage.getItem(STORE)); return Array.isArray(list) ? list : []; } catch { return []; } };
const store = (list) => localStorage.setItem(STORE, JSON.stringify(list));

// ---- state -----------------------------------------------------------------
let chain = { format: MZ.FILTER_FORMAT, steps: [] };
let compiled = null;
let runner = null;
let currentT = 0;
let video = null;
let media = { kind: 'test', source: null, width: 320, height: 240 };   // the picture, at its own size
const toStep = (stepLike) => MZ.normalizeFilter({ steps: [stepLike] }).steps[0];
const base = () => location.href.split('#')[0];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const GUIDE = $('guide-link').getAttribute('href');   // ../docs/filters.md here, guide.html on the site

// ---- help, and errors that say where to look ------------------------------
function renderHelp() {
  const box = $('help-body');
  for (const section of HELP) {
    const div = document.createElement('section');
    div.id = `help-${section.id}`;
    div.innerHTML = `<h3>${esc(section.title)}<a class="hint" href="${esc(GUIDE)}#${section.guide}">more in the guide</a></h3>`
      + (section.note ? `<div class="hint">${esc(section.note)}</div>` : '')
      + `<table>${section.rows.map(([code, meaning]) => `<tr><td><code>${esc(code)}</code></td><td>${esc(meaning)}</td></tr>`).join('')}</table>`;
    for (const example of section.examples) {
      const def = Array.isArray(example) ? example[0] : example.def;
      const show = Array.isArray(example) ? example[0] : example.show;
      const caption = Array.isArray(example) ? example[1] : example.caption;
      const row = document.createElement('div');
      row.className = 'example';
      row.append(button('Try', () => addStep(def)), Object.assign(document.createElement('code'), { textContent: show }), Object.assign(document.createElement('span'), { className: 'hint', textContent: caption }));
      div.append(row);
    }
    box.append(div);
  }
}

function showHelp(id) {
  $('help').open = true;
  const section = document.getElementById(`help-${id}`) ?? $('help');
  section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** The error, plus — when it is one we recognise — what to do and where to read. */
function showError(message) {
  const box = $('error');
  box.textContent = '';
  if (!message) return;
  const { text, hint, id, guide } = explain(message);
  box.textContent = text;
  if (!hint) return;
  const line = document.createElement('div');
  line.className = 'hint';
  line.append(hint + ' ');
  if (id) {
    const a = Object.assign(document.createElement('a'), { href: '#help', textContent: 'help' });
    a.onclick = (e) => { e.preventDefault(); showHelp(id); };
    line.append(a, ' · ');
  }
  if (guide) line.append(Object.assign(document.createElement('a'), { href: `${GUIDE}#${guide}`, textContent: 'guide' }));
  box.append(line);
}

// ?webgl2 runs the GLSL ES 3.0 output on WebGL 2; ?precision=half|float keeps more between passes.
const QUERY = new URLSearchParams(location.search);
const WEBGL2 = QUERY.has('webgl2');
const PRECISION = QUERY.get('precision') || 'byte';
const gl = $('out').getContext(WEBGL2 ? 'webgl2' : 'webgl', { preserveDrawingBuffer: true });
// The GPU can take the context away (a reset, the laptop sleeping, too much memory). Say so,
// come back when it is restored, and after repeated losses stay on the CPU.
let contextLosses = 0;
$('out').addEventListener('webglcontextlost', (e) => {
  e.preventDefault();                                      // ask for it back
  contextLosses += 1;
  runner = null;                                           // its programs and textures are gone
  $('error').textContent = 'The graphics context was lost (the GPU reset). Waiting for it to come back…';
});
$('out').addEventListener('webglcontextrestored', () => {
  $('error').textContent = '';
  if (contextLosses >= 2 && $('engine').value === 'auto') {
    $('engine').value = 'cpu';
    $('engineNote').textContent = 'switched to the CPU after repeated GPU resets';
  }
  recompile();
});
// Without WebGL the filters still run, on the CPU (createCpuRunner); ?engine=gpu|cpu forces one.
let engine = 'gpu';
let engineReason = '';
const outCanvas = () => (engine === 'cpu' ? $('outCpu') : $('out'));

function recompile() {
  if (runner) { runner.dispose(); runner = null; }
  compiled = null;
  showError('');
  try {
    compiled = MZ.compileFilter(chain.steps.length ? chain : 'rgb', { version: WEBGL2 ? 300 : 100 });
    // A colour space between passes wants more than 8 bits (Lab's dark corners lose ~20/255 in bytes): half floats where the GPU has them.
    const precision = QUERY.get('precision') || (compiled.passes.some((p) => p.space && p.space !== 'srgb') ? 'half' : 'byte');
    const made = MZ.createRunner(compiled, { gl, prefer: QUERY.get('engine') || $('engine').value, precision });
    runner = made.runner.setImage($('source'));
    engine = made.engine;
    engineReason = made.reason;
    $('out').hidden = engine === 'cpu';
    $('outCpu').hidden = engine !== 'cpu';
    bindPictures();
    if (typeof selection !== 'undefined') bindSelection(false);
    bindGraphics();
  } catch (e) {
    showError(e.message);
  }
  $('shaders').textContent = compiled ? compiled.passes.map((p) => `// ${p.name || 'step'} ${p.path.map((i) => i + 1).join('.')}\n${p.fragment}`).join('\n\n') : '';
  $('credits').textContent = compiled && compiled.credits.length
    ? 'Uses ' + compiled.credits.map((c) => c.name + (c.author ? ' by ' + c.author : '')).join(', ')
    : '';
  $('steps-empty').hidden = chain.steps.length > 0;
  updateMoving();
  draw();
}

// ---- still or moving: time is shown only when something moves ---------------
// A still picture under a filter that doesn't use t (or random, or brush strokes, which play out) never changes,
// so it isn't redrawn every frame and the time slider, play, "record" and "save as GIF" are put away.
let moving = true;
function filterMoves() {
  if (!compiled) return false;
  if (Object.values(compiled.graphics ?? {}).some((g) => g.type === 'strokes')) return true;
  return compiled.passes.some((p) => {
    if (p.blendKept) return false;
    try { const uses = MZ.compileCpuPass(p).uses; return uses.has('t') || uses.has('random'); } catch { return true; }
  });
}
function updateMoving() {
  moving = media.kind === 'video' || media.kind === 'gif' || filterMoves();
  document.body.classList.toggle('still', !moving);
}

function draw() {
  if (!runner || (engine === 'gpu' && gl && gl.isContextLost())) return;
  updateStrokes();
  drawStrokeOverlay();
  const t0 = performance.now();
  runner.draw({ t: currentT, canvas: engine === 'cpu' ? $('outCpu') : undefined });
  const textures = runner.precision && runner.precision !== 'byte' ? ` · ${runner.precision} textures` : '';
  $('engineNote').textContent = engine === 'cpu' ? `CPU — ${engineReason} · ${(performance.now() - t0).toFixed(1)} ms a frame${textures}` : `GPU — ${engineReason}${textures}`;
}
$('engine').addEventListener('change', recompile);

function rebuild() { recompile(); renderSteps(); renderPictures(); updateShare(); }

// ---- other pictures: masks and overlays ------------------------------------
const slots = new Map();   // image name → { canvas, kind, file }
const KINDS = {
  'radial mask': (ctx, w, h) => { const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.15, w / 2, h / 2, h * 0.7); g.addColorStop(0, '#000'); g.addColorStop(1, '#fff'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); },
  'portrait photo': (ctx, w, h) => {              // a different size, to show placement
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#0b3d91'); g.addColorStop(1, '#f28c28');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(w * 0.5, h * 0.3, w * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1e7f3a'; ctx.fillRect(0, h * 0.7, w, h * 0.3);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 24px sans-serif'; ctx.fillText('portrait', 20, h - 20);
  },
  'left-right mask': (ctx, w, h) => { const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#000'); g.addColorStop(1, '#fff'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); },
  stripes: (ctx, w, h) => {
    ctx.fillStyle = '#f7b733'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fc4a1a';
    for (let i = -h; i < w; i += 40) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 20, 0); ctx.lineTo(i + 20 + h, h); ctx.lineTo(i + h, h); ctx.fill(); }
    ctx.fillStyle = 'rgba(40, 90, 220, 0.9)'; ctx.beginPath(); ctx.arc(w * 0.65, h * 0.45, h * 0.3, 0, Math.PI * 2); ctx.fill();
  },
  checkerboard: (ctx, w, h) => { for (let i = 0; i < w / 32; i++) for (let j = 0; j < h / 32; j++) { ctx.fillStyle = (i + j) % 2 ? '#fff' : '#333'; ctx.fillRect(i * 32, j * 32, 32, 32); } },
  'the picture': (ctx, w, h) => ctx.drawImage($('source'), 0, 0, w, h),
};

const SIZES = { 'portrait photo': [200, 300] };    // other kinds are 320 × 240

function paintSlot(slot) {
  const [w, h] = slot.file ? [slot.file.naturalWidth, slot.file.naturalHeight].map((v, i) => Math.round(v * Math.min(1, 640 / slot.file.naturalWidth, 640 / slot.file.naturalHeight))) : (SIZES[slot.kind] ?? [320, 240]);
  slot.canvas.width = w; slot.canvas.height = h;
  const ctx = slot.canvas.getContext('2d');
  if (slot.file) ctx.drawImage(slot.file, 0, 0, w, h); else KINDS[slot.kind](ctx, w, h);
}

function slotFor(name) {
  if (!slots.has(name)) {
    const kind = /mask/i.test(name) ? 'radial mask' : /inset|photo|picture/i.test(name) ? 'portrait photo' : 'stripes';
    const slot = { canvas: document.createElement('canvas'), kind, file: null };
    slots.set(name, slot);
    paintSlot(slot);
  }
  return slots.get(name);
}

function bindPictures() {
  if (!runner || !compiled) return;
  for (const name of Object.keys(compiled.images)) runner.setImage(name, slotFor(name).canvas);
}

function repaintCopies() {           // slots showing "the picture" follow the main picture
  for (const slot of slots.values()) if (slot.kind === 'the picture' && !slot.file) paintSlot(slot);
  bindPictures();
}

function renderPictures() {
  const names = compiled ? Object.keys(compiled.images) : [];
  const box = $('pictures');
  box.innerHTML = '';
  $('pictures-section').hidden = !names.length;
  for (const name of names) {
    const slot = slotFor(name);
    const row = document.createElement('div');
    row.className = 'slot';
    const info = document.createElement('div');
    const description = compiled.images[name].description;
    info.innerHTML = `<b>${esc(name)}</b>${description ? ` <span class="hint">${esc(description)}</span>` : ''}<br>`;
    const pick = document.createElement('select');
    for (const kind of Object.keys(KINDS)) pick.append(Object.assign(document.createElement('option'), { value: kind, textContent: kind, selected: kind === slot.kind && !slot.file }));
    if (slot.file) pick.append(Object.assign(document.createElement('option'), { value: 'file', textContent: 'your file', selected: true }));
    pick.onchange = () => { if (pick.value === 'file') return; slot.kind = pick.value; slot.file = null; paintSlot(slot); bindPictures(); draw(); renderPictures(); };
    const file = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    file.onchange = async () => {
      if (!file.files[0]) return;
      const img = new Image();
      img.src = URL.createObjectURL(file.files[0]);
      await img.decode();
      slot.file = img; paintSlot(slot); bindPictures(); draw(); renderPictures();
    };
    info.append(pick, ' ', file);
    // Placement: how this picture sits over the frame. Set on every step that uses it.
    const current = placementOf(name);
    const steps = chain.steps.filter((step) => name in MZ.filterImages(step.filter));
    const setPlacement = (key, value, recompileNeeded) => {
      for (const step of steps) step.with[name] = { ...(step.with[name] ?? {}), [key]: value };
      if (recompileNeeded) { recompile(); updateShareSoon(); return; }
      if (compiled) for (const pass of compiled.passes) if (pass.placements[name]) pass.placements[name][key] = value;
      draw(); updateShareSoon();
    };
    const place = document.createElement('select');
    for (const mode of ['cover', 'fit', 'stretch', 'tile']) place.append(Object.assign(document.createElement('option'), { value: mode, textContent: mode, selected: mode === current.place }));
    place.onchange = () => setPlacement('place', place.value, true);
    const placing = document.createElement('div');
    placing.append('place: ', place);
    placing.append(knob('zoom', current.zoom, 0.1, 4, 0.01, (v) => setPlacement('zoom', v)));
    placing.append(knob('x', current.x, -0.5, 1.5, 0.01, (v) => setPlacement('x', v)));
    placing.append(knob('y', current.y, -0.5, 1.5, 0.01, (v) => setPlacement('y', v)));
    placing.append(knob('angle', current.angle, -3.14, 3.14, 0.01, (v) => setPlacement('angle', v)));
    info.append(placing);
    row.append(slot.canvas, info);
    box.append(row);
  }
}

function placementOf(name) {
  const pass = compiled && compiled.passes.find((p) => p.placements[name]);
  return pass ? pass.placements[name] : MZ.PLACEMENT;
}

// ---- the chain -------------------------------------------------------------
function addStep(def) { chain.steps.push(toStep(def)); rebuild(); }

function liveValue(stepIndex, name, fallback) {
  const pass = compiled && compiled.passes.find((p) => p.path[0] === stepIndex && name in p.params);
  return pass ? pass.values[name] : fallback;
}

function setLive(stepIndex, name, value) {
  if (compiled) for (const pass of compiled.passes) if (pass.path[0] === stepIndex && name in pass.params) pass.values[name] = value;
  draw();
  updateShareSoon();
}

// Each step is a filter that folds away: its name, its maths, and its page — the knobs, each a line
// written as an Inline Math variable (`cutoff := [[0..1 step 0.01 = 0.5]]`) and drawn by Inline Math
// as its input, and notes in Markdown, whose maths sees the knobs ({{cutoff}} is the value now).
const folded = new WeakSet();            // steps the user folded away
const editing = new WeakSet();           // steps showing their editing parts: name and author, each knob's line, the add buttons
let openNote = null;                     // { step, k }: a text just added, opened for writing

function stepTitle(f) {
  const drawn = Object.values(MZ.filterGraphics(f)).map((g) => ({ text: 'Text', rect: 'Rectangle', ellipse: 'Oval', strokes: 'Brush strokes' }[g.type] ?? 'Shape'));
  if (f.name) return `<b>${esc(f.name)}</b>${f.author ? ` <span class="hint">by ${esc(f.author)}</span>` : ''}${f.steps ? ' <span class="hint">· chain</span>' : ''}`;
  if (drawn.length) return `<b>${esc([...new Set(drawn)].join(' and '))}</b>`;
  return typeof f.color === 'string' ? `<code>${esc(f.color)}</code>` : '<span class="hint">expression</span>';
}

function renderSteps() {
  const list = $('steps');
  // Inline Math keeps a drawing live until it is drawn again: let the old ones go
  for (const el of list.querySelectorAll('.md-live')) renderMarkdownInto(el, '', { variables: false });
  list.innerHTML = '';
  chain.steps.forEach((step, i) => list.append(stepItem(step, i)));
}

function stepItem(step, i) {
  const f = step.filter;
  const li = document.createElement('li');
  li.className = 'step';
  const open = !folded.has(step);
  li.innerHTML = `<div class="head"><button class="fold" aria-expanded="${open}" aria-controls="step-${i}" aria-label="fold or unfold this step" title="fold / unfold">▸</button>`
    + `<span class="grip" draggable="true" title="drag to reorder">⠿</span><input type="checkbox" class="on" title="on / off" aria-label="use this step"${step.skip ? '' : ' checked'}>`
    + `<span class="title">${stepTitle(f)}</span><button class="edit" aria-pressed="${editing.has(step)}" title="show or hide the step's name, its knobs' lines and the add buttons">Edit</button><button data-act="up" title="move up" aria-label="move up">↑</button><button data-act="down" title="move down" aria-label="move down">↓</button><button data-act="remove" title="remove" aria-label="remove this step">✕</button></div>`;
  li.classList.toggle('skipped', Boolean(step.skip));
  li.classList.toggle('editing', editing.has(step));
  const setEditing = (on) => {
    if (on) editing.add(step); else editing.delete(step);
    li.classList.toggle('editing', on);
    li.querySelector('.edit').setAttribute('aria-pressed', String(on));
  };
  li.querySelector('.edit').onclick = () => {
    setEditing(!editing.has(step));
    if (body.hidden) fold();                                         // editing a folded step: open it
  };
  const body = Object.assign(document.createElement('div'), { className: 'body', id: `step-${i}`, hidden: !open });
  const fold = () => {
    const now = body.hidden;
    body.hidden = !now;
    li.querySelector('.fold').setAttribute('aria-expanded', String(now));
    if (now) folded.delete(step); else folded.add(step);
  };
  li.querySelector('.fold').onclick = fold;
  li.querySelector('.title').onclick = fold;
  li.querySelector('.on').addEventListener('change', (e) => { step.skip = !e.target.checked; li.classList.toggle('skipped', step.skip); recompile(); updateShareSoon(); });
  // Drag the grip onto another step to move this one there (the ↑ ↓ buttons do the same one place at a time).
  li.querySelector('.grip').addEventListener('dragstart', (e) => { dragging = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
  li.addEventListener('dragover', (e) => { if (dragging === null) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; li.classList.add('over'); });
  li.addEventListener('dragleave', () => li.classList.remove('over'));
  li.addEventListener('drop', (e) => { e.preventDefault(); li.classList.remove('over'); if (dragging !== null && dragging !== i) moveStep(dragging, i); dragging = null; });
  li.addEventListener('dragend', () => { dragging = null; for (const el of $('steps').querySelectorAll('.over')) el.classList.remove('over'); });
  for (const b of li.querySelectorAll('.head button[data-act]')) b.onclick = () => act(b.dataset.act, i);

  // its name and author: a filter from the library or a link, renamed, is your fork of it
  const who = Object.assign(document.createElement('div'), { className: 'meta' });
  for (const [key, placeholder] of [['name', 'name this filter'], ['author', 'author']]) {
    const input = Object.assign(document.createElement('input'), { type: 'text', value: f[key] ?? '', placeholder });
    input.setAttribute('aria-label', `this step's ${key}`);
    input.addEventListener('input', () => {
      if (input.value.trim()) f[key] = input.value.trim(); else delete f[key];
      li.querySelector('.title').innerHTML = stepTitle(f);
      updateShareSoon();
    });
    input.addEventListener('change', recompile);                       // the credits line
    who.append(input);
  }
  body.append(who);
  if (!f.steps && typeof f.color === 'string') {                       // a filter's maths stays editable, and so does its colour space
    // the maths wraps and grows with what is written (Enter applies it; shift+Enter is a new line)
    const input = Object.assign(document.createElement('textarea'), { className: 'expr', value: f.color, spellcheck: false, rows: 1 });
    input.setAttribute('aria-label', 'the maths');
    const fit = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight + 2}px`; };
    input.addEventListener('input', fit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); input.dispatchEvent(new Event('change')); } });
    input.addEventListener('change', () => { f.color = input.value; li.querySelector('.title').innerHTML = stepTitle(f); recompile(); updateShare(); });
    requestAnimationFrame(fit);
    const space = $('expr-space').cloneNode(true);
    space.id = '';
    space.value = f.space ? f.space.in : 'srgb';
    space.addEventListener('change', () => { if (space.value === 'srgb') delete f.space; else f.space = { in: space.value, out: space.value }; recompile(); updateShare(); });
    const row = document.createElement('div');
    row.className = 'add';
    row.append(input, space);
    input.style.flex = '1'; input.style.width = 'auto';
    body.append(row);
  } else if (f.space) {
    body.append(Object.assign(document.createElement('div'), { className: 'hint', textContent: `in ${f.space.in === f.space.out ? f.space.in : `${f.space.in} → ${f.space.out}`}` }));
  }
  body.append(stepPage(step, i));
  body.append(knob('opacity', step.opacity, 0, 1, 0.01, (v) => setOpacity(step, v)));
  for (const [name, base] of Object.entries(MZ.filterGraphics(f))) body.append(graphicControls(i, name, base));
  const actions = Object.assign(document.createElement('div'), { className: 'step-actions' });
  actions.append(button('Save this step', () => { if (!f.name) setEditing(true); saveFilter(MZ.normalizeFilter(bakeStep(step)), who.querySelector('input')); }),
    button('Copy its link', () => copy(MZ.filterToLink(bakeStep(step), base()), 'Link to this step copied — whoever opens it can change it and keep their own')));
  body.append(actions);
  li.append(body);
  return li;
}

/** Can Inline Math take this name as one variable? (`cx` reads as c times x: those knobs get a plain slider.) */
const readable = new Map();
function inlineName(name) {
  if (!readable.has(name)) {
    let ok = false;
    try { ok = markdownToHTML(`$${name} := [[0..1 step 1 = 0]]$`, { variables: false }).includes(`data-mv-var="${name}"`); } catch { /* not a name */ }
    readable.set(name, ok);
  }
  return readable.get(name);
}

/**
 * The step's page: its knobs and its notes, in order. A filter of its own defines its knobs here
 * (each line edits it) and can have more; a chain's knobs belong to its steps, so here they are only set.
 */
function stepPage(step, i) {
  const f = step.filter;
  const own = !f.steps;
  const params = own ? (f.params ?? {}) : MZ.filterParams(f);
  const store = createVariables();                                   // the step's variables: its knobs, seen by its notes
  const box = Object.assign(document.createElement('div'), { className: 'blocks' });
  const blocks = blocksOf(params, f.notes);
  const draws = [];                                                   // Inline Math draws the knobs first, so the notes see them
  const notes = [];
  const setBlocks = (next) => {
    const kept = notesOf(next);
    if (kept) f.notes = kept;
    else {
      delete f.notes;
      if (own && f.params) f.params = Object.fromEntries(next.filter((b) => typeof b === 'object').map((b) => [b.param, f.params[b.param]]));   // knobs alone: their order is the params'
    }
  };
  const tools = (k) => {
    const span = Object.assign(document.createElement('span'), { className: 'tools' });
    const up = button('↑', () => { const next = [...blocks]; [next[k - 1], next[k]] = [next[k], next[k - 1]]; setBlocks(next); rebuild(); });
    up.disabled = k === 0;
    up.title = 'move up'; up.setAttribute('aria-label', 'move up');
    span.append(up);
    return span;
  };
  blocks.forEach((block, k) => {
    if (typeof block === 'string') {
      box.append(noteBlock(step, block, k, blocks, setBlocks, store, tools(k), notes));
      return;
    }
    const name = block.param;
    const param = params[name];
    const row = Object.assign(document.createElement('div'), { className: 'block knob-block' });
    const live = Object.assign(document.createElement('div'), { className: 'live' });
    const current = liveValue(i, name, name in step.with ? step.with[name] : param.default);
    const set = (v) => { step.with[name] = v; setLive(i, name, v); };
    if (param.label) live.append(Object.assign(document.createElement('span'), { className: 'hint', textContent: param.label }));
    if (param.type === 'color') live.append(colorKnob(name, current, set));
    else if (!inlineName(name)) live.append(knob(name, current, param.min, param.max, sliderStep(param), set));
    else {
      const at = Object.assign(document.createElement('div'), { className: 'md-live' });
      live.append(at);
      draws.push(() => renderMarkdownInto(at, `$${inlineDefinition(name, { ...param, default: current })}$`, { variables: store }));
    }
    row.append(live);
    if (own) {
      const line = Object.assign(document.createElement('input'), { type: 'text', className: 'def', value: definitionOf(name, param), spellcheck: false, title: HOW });
      line.setAttribute('aria-label', `the knob ${name}, as a line`);
      const msg = Object.assign(document.createElement('div'), { className: 'block-msg', role: 'alert' });
      line.addEventListener('change', () => {
        const problem = setKnob(step, name, line.value);
        if (problem) line.setAttribute('aria-invalid', 'true'); else line.removeAttribute('aria-invalid');
        msg.textContent = problem ?? '';
      });
      const remove = button('✕', () => {
        delete f.params[name];
        if (!Object.keys(f.params).length) delete f.params;
        delete step.with[name];
        setBlocks(blocks.filter((b) => b !== block));
        rebuild();
        updateShareSoon();
      });
      remove.title = `remove the knob ${name}`; remove.setAttribute('aria-label', remove.title);
      const t = tools(k);
      t.append(remove);
      row.append(line, t, msg);
    } else {
      row.append(tools(k));
    }
    box.append(row);
  });
  for (const d of [...draws, ...notes]) d();
  store.subscribe((owner, name) => {                                  // an Inline Math input moved: the knob follows
    if (!name || !(name in params) || params[name].type === 'color') return;
    const v = numberOf(store.get(name));
    if (v !== null) { step.with[name] = v; setLive(i, name, v); }
  });

  const add = Object.assign(document.createElement('div'), { className: 'block-add' });
  add.append(Object.assign(document.createElement('span'), { className: 'hint', textContent: 'add' }));
  if (own) {
    const knobs = [['slider', { default: 0.5, min: 0, max: 1, step: 0.01 }], ['box', { default: 1, input: 'box' }],
      ['menu', { options: [1, 2, 4] }], ['colour', { type: 'color', default: [1, 0.5, 0] }]];
    for (const [label, spec] of knobs) {
      const b = button(`+ ${label}`, () => addKnob(step, spec));
      b.title = `a new knob: ${definitionOf('k', MZ.normalizeFilter({ params: { k: spec }, color: 'k' }).params.k)}`;
      add.append(b);
    }
  }
  const text = button('+ text', () => {
    const next = [...blocks, 'Write about it here: *Markdown*, with maths such as $x^2$' + (Object.keys(params).some(inlineName) ? ", and a knob's value: $" + '{{' + Object.keys(params).find(inlineName) + '}}$' : '') + '.'];
    setBlocks(next);
    openNote = { step, k: next.length - 1 };
    rebuild();
    updateShareSoon();
  });
  text.title = 'a note in Markdown, with maths drawn by Inline Math';
  add.append(text);
  box.append(add);
  return box;
}

/** A text on the step's page: drawn by Inline Math; Edit shows the Markdown. */
function noteBlock(step, text, k, blocks, setBlocks, store, tools, draws) {
  const row = Object.assign(document.createElement('div'), { className: 'block note' });
  const view = Object.assign(document.createElement('div'), { className: 'md md-live' });
  const shown = (t) => (t.trim() ? t : '*Empty: Edit to write something.*');
  draws.push(() => renderMarkdownInto(view, shown(text), { variables: store }));
  const area = Object.assign(document.createElement('textarea'), { value: text, rows: 3, spellcheck: true, hidden: true });
  area.setAttribute('aria-label', 'the note, in Markdown');
  const edit = button('Edit', () => {
    area.hidden = !area.hidden;
    edit.textContent = area.hidden ? 'Edit' : 'Done';
    if (!area.hidden) area.focus();
  });
  area.addEventListener('input', () => {
    blocks[k] = area.value;
    setBlocks(blocks);
    renderMarkdownInto(view, shown(area.value), { variables: store });
    updateShareSoon();
  });
  const remove = button('✕', () => { setBlocks(blocks.filter((_, j) => j !== k)); rebuild(); updateShareSoon(); });
  remove.title = 'remove this note'; remove.setAttribute('aria-label', remove.title);
  tools.prepend(edit);
  tools.append(remove);
  row.append(view, tools, area);
  if (openNote && openNote.step === step && openNote.k === k) {
    openNote = null;
    area.hidden = false;
    edit.textContent = 'Done';
    setTimeout(() => { area.focus(); area.select(); });
  }
  return row;
}

/** A knob's line changed: the knob is defined again (renamed in the maths too); the problem, if there is one. */
function setKnob(step, old, text) {
  const f = step.filter;
  let parsed;
  try { parsed = parseDefinition(text, f.params[old].label); } catch (e) { return e.message; }
  const { name, spec } = parsed;
  if (name !== old && (name in f.params || name in (f.images ?? {}) || name in (f.graphics ?? {}))) return `There is already something called ${name} in this filter`;
  const params = Object.fromEntries(Object.entries(f.params).map(([k, v]) => (k === old ? [name, spec] : [k, v])));
  const next = { ...f, params };
  if (f.notes) next.notes = f.notes.map((b) => (typeof b === 'object' && b.param === old ? { param: name } : b));
  if (name !== old) next.color = renameInMaths(f.color, old, name);
  try { step.filter = MZ.normalizeFilter(next); } catch (e) { return e.message; }
  delete step.with[old];                                            // the line says where it starts now
  rebuild();
  updateShareSoon();
  return null;
}

function addKnob(step, spec) {
  const f = step.filter;
  const name = freeName(new Set([...Object.keys(f.params ?? {}), ...Object.keys(f.images ?? {}), ...Object.keys(MZ.filterGraphics(f))]));
  const next = { ...f, params: { ...(f.params ?? {}), [name]: spec } };
  if (f.notes) next.notes = [...f.notes, { param: name }];
  step.filter = MZ.normalizeFilter(next);
  rebuild();
  updateShareSoon();
  toast(`${name} is a new knob: use it in the maths, e.g. ${spec.type === 'color' ? `mix(rgb, ${name}, 0.5)` : `rgb * ${name}`}`);
}

// Opacity is a uniform, so unless the chain's shape changes (a chain step crossing 1 → less
// than 1 needs a blend pass) the new values go straight to the live passes.
function setOpacity(step, value) {
  step.opacity = value;
  let fresh = null;
  try { fresh = MZ.compileFilter(chain, { version: WEBGL2 ? 300 : 100 }); } catch { /* recompile reports it */ }
  const same = fresh && compiled && fresh.passes.length === compiled.passes.length && fresh.passes.every((p, k) => p.fragment === compiled.passes[k].fragment);
  if (!same) { recompile(); updateShareSoon(); return; }
  fresh.passes.forEach((p, k) => { compiled.passes[k].opacity = p.opacity; });
  draw();
  updateShareSoon();
}

let dragging = null;     // the index of the step being dragged
function moveStep(from, to) {
  const [step] = chain.steps.splice(from, 1);
  chain.steps.splice(to, 0, step);
  rebuild();
}

function act(kind, i) {
  const steps = chain.steps;
  if (kind === 'remove') steps.splice(i, 1);
  if (kind === 'up' && i > 0) [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
  if (kind === 'down' && i < steps.length - 1) [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]];
  rebuild();
}

function knob(label, value, min, max, step, onInput) {
  const div = document.createElement('div');
  div.className = 'knob';
  div.innerHTML = `<label>${esc(label)}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${esc(label)}"><output>${trim(value)}</output>`;
  const input = div.querySelector('input');
  input.addEventListener('input', () => { div.querySelector('output').textContent = trim(input.value); onInput(Number(input.value)); });
  return div;
}

function colorKnob(label, value, onInput) {
  const div = document.createElement('div');
  div.className = 'knob';
  div.innerHTML = `<label>${esc(label)}</label><input type="color" value="${toHex(value)}" aria-label="${esc(label)}"><output>${toHex(value)}</output>`;
  const input = div.querySelector('input');
  input.addEventListener('input', () => { div.querySelector('output').textContent = input.value; onInput(fromHex(input.value)); });
  return div;
}

// ---- sharing and saving ------------------------------------------------------
// A link carries the whole filter (in the address after #): whoever opens it gets every step to
// change, and Save keeps their version — a fork — in their browser.
function shareable() {
  const def = { ...chain, name: $('name').value.trim(), author: $('author').value.trim() };
  if (!def.name) delete def.name;
  if (!def.author) delete def.author;
  return def;
}

function updateShare() {
  if (!chain.steps.length) { $('json').value = ''; history.replaceState(null, '', location.pathname + location.search); return; }
  const def = shareable();
  $('json').value = MZ.filterToJSON(def);
  history.replaceState(null, '', MZ.filterToLink(def, base()));
}
let shareTimer = null;
function updateShareSoon() { clearTimeout(shareTimer); shareTimer = setTimeout(updateShare, 150); }

// a confirmation is a toast (shioh.js); the message line keeps what needs the user's hand
const toast = (text) => (window.ssToast ? window.ssToast(text) : ($('share-msg').textContent = text, setTimeout(() => { $('share-msg').textContent = ''; }, 2500)));
const ask = (message, opts) => (window.ssConfirm ? window.ssConfirm(message, opts) : Promise.resolve(confirm(message)));
async function copy(text, message = 'Copied') {
  try { await navigator.clipboard.writeText(text); $('share-msg').textContent = ''; toast(message); }
  catch { $('share-section').open = true; $('json').value = text; $('json').select(); $('share-msg').textContent = 'Select and copy the text below'; }
}

function loadChain(def) {
  const f = MZ.normalizeFilter(def);
  chain = f.steps ? f : { format: MZ.FILTER_FORMAT, steps: [{ filter: f, with: {}, opacity: 1 }] };
  $('name').value = chain.name || '';
  $('author').value = chain.author || '';
  $('fork-note').hidden = true;
  rebuild();
}

/** Keep a filter in this browser (localStorage): one of the same name and author is replaced. `nameBox` is where to ask for a name. */
function saveFilter(def, nameBox) {
  if (!def.name) { $('share-msg').textContent = 'Give it a name first'; nameBox.focus(); return; }
  const list = saved();
  const kept = JSON.parse(MZ.filterToJSON(def));
  const at = list.findIndex((d) => d.name === kept.name && (d.author ?? '') === (kept.author ?? ''));
  if (at >= 0) list[at] = kept; else list.push(kept);
  try { store(list); } catch (e) { $('share-msg').textContent = `Could not save: ${e.message}`; return; }
  renderSaved();
  $('share-msg').textContent = '';
  toast(`${at >= 0 ? 'Updated' : 'Saved'} "${kept.name}" — it is under Your saved filters`);
}

/** One line: a filter's name and what it does, and its buttons. */
function filterRow(def, extra, buttons) {
  const li = document.createElement('li');
  const what = Object.assign(document.createElement('span'), { className: 'what' });
  what.innerHTML = `<b>${esc(def.name ?? 'unnamed')}</b>${extra ? `<span class="hint">${esc(extra)}</span>` : ''}`;
  if (def.description) what.title = def.description;
  li.append(what, ...buttons);
  return li;
}

/** The filters saved in this browser: open one (in place of what is here), add it as a step, share it, or delete it. */
function renderSaved() {
  const box = $('saved');
  box.textContent = '';
  const list = saved();
  if (!list.length) {
    box.append(Object.assign(document.createElement('li'), { className: 'hint', textContent: 'Nothing saved yet. Name your filter (or one step) and press Save: it stays in this browser.' }));
    return;
  }
  list.forEach((def, index) => {
    const steps = Array.isArray(def.steps) ? `${def.steps.length} step${def.steps.length > 1 ? 's' : ''}` : '';
    const extra = [def.author ? `by ${def.author}` : '', steps, def.description ?? ''].filter(Boolean).join(' · ');
    box.append(filterRow(def, extra, [
      button('Open', async () => {
        if (chain.steps.length && !(await ask(`Open "${def.name}" in place of the filter you have? (Save that first to keep it.)`, { title: 'Open a saved filter', ok: 'Open' }))) return;
        try { loadChain(def); } catch (e) { showError(e.message); }
      }),
      button('Add', () => { try { addStep(def); } catch (e) { showError(e.message); } }),
      button('Copy link', () => copy(MZ.filterToLink(def, base()), `Link to "${def.name}" copied`)),
      button('Delete', async () => {
        if (!(await ask(`Delete "${def.name}" from this browser?`, { title: 'Delete a saved filter', ok: 'Delete' }))) return;
        const now = saved();
        now.splice(index, 1);
        store(now);
        renderSaved();
      }),
    ]));
  });
}

/** Opened from a link: say whose it is, and that it is the user's to change. */
function showForkNote(def) {
  const box = $('fork-note');
  const whose = def.name ? `“${def.name}”${def.author ? ` by ${def.author}` : ''}` : 'This filter';
  box.textContent = `${whose} came from a link. It is yours to change: edit any step, then Save to keep your version here, or Copy link to share it.`;
  box.hidden = false;
}

// The library: a group per fold, a line per filter, narrowed by the search box (name, description,
// group, or the maths itself). A search opens every group with something in it.
const openGroups = new Set();
function renderLibrary() {
  const box = $('library');
  box.textContent = '';
  const query = $('search').value.trim().toLowerCase();
  const text = (def) => [def.name, def.description, def.group, JSON.stringify(def.color ?? def.steps ?? '')].join(' ').toLowerCase();
  $('library-count').textContent = `— ${BUILTIN.length} filters`;
  let count = 0;
  for (const group of MZ.GROUPS) {
    const members = BUILTIN.filter((def) => def.group === group && (!query || text(def).includes(query)));
    if (!members.length) continue;
    const fold = Object.assign(document.createElement('details'), { className: 'lib-group', open: Boolean(query) || openGroups.has(group) });
    fold.dataset.group = group;
    fold.innerHTML = `<summary>${esc(group)}<span class="hint">${members.length}</span></summary>`;
    fold.addEventListener('toggle', () => { if (!query) { if (fold.open) openGroups.add(group); else openGroups.delete(group); } });
    const list = Object.assign(document.createElement('ul'), { className: 'rows' });
    for (const def of members) {
      count++;
      list.append(filterRow(def, `${def.steps ? 'chain · ' : ''}${def.description ?? ''}`, [
        button('Add', () => addStep(def)),
        button('Copy link', () => copy(MZ.filterToLink(def, base()), `Link to "${def.name}" copied`)),
      ]));
    }
    fold.append(list);
    box.append(fold);
  }
  if (!count) box.append(Object.assign(document.createElement('div'), { className: 'hint', textContent: `Nothing in the library matches "${query}"` }));
}
$('search').addEventListener('input', renderLibrary);
const button = (text, onClick) => Object.assign(document.createElement('button'), { textContent: text, onclick: onClick });

$('add-expr').onclick = () => {
  if (!$('expr').value.trim()) return;
  const space = $('expr-space').value;
  try { addStep(space === 'srgb' ? $('expr').value : { color: $('expr').value, space }); editing.add(chain.steps.at(-1)); renderSteps(); } catch (e) { showError(e.message); return; }
  $('expr').value = '';
  $('steps').lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};
$('expr').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('add-expr').onclick(); });
$('copy-link').onclick = () => copy(MZ.filterToLink(shareable(), base()), 'Link copied — whoever opens it can change it and keep their own');
$('copy-json').onclick = () => copy(MZ.filterToJSON(shareable()), 'JSON copied');
$('save').onclick = () => { if (chain.steps.length) saveFilter(shareable(), $('name')); };
for (const id of ['name', 'author']) $(id).addEventListener('input', updateShareSoon);
$('do-import').onclick = () => {
  try {
    const def = MZ.readFilter($('import').value);
    const problems = MZ.validateFilter(def);
    if (problems.length) throw new Error(problems.join('\n'));
    addStep(def);
    $('import-msg').textContent = def.name ? `Added "${def.name}"${def.author ? ' by ' + def.author : ''} as a step` : 'Added as a step';
    $('import').value = '';
  } catch (e) {
    const { text, hint } = explain(e.message);
    $('import-msg').textContent = hint ? `${text} — ${hint}` : text;
  }
};

// ---- the picture, and t ----------------------------------------------------
function drawTestPicture(ctx, w, h) {
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#2a6fdb'); grad.addColorStop(0.5, '#f5d547'); grad.addColorStop(1, '#8e3bbf');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#39b54a'; ctx.fillRect(w * 0.55, h * 0.1, w * 0.35, h * 0.35);
  ctx.fillStyle = '#e03a3a'; ctx.beginPath(); ctx.arc(w * 0.3, h * 0.6, h * 0.25, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#222';
  for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) if ((i + j) % 2 === 0) ctx.fillRect(w * 0.6 + i * 16, h * 0.65 + j * 16, 16, 16);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 28px sans-serif'; ctx.fillText('MathZetta', 12, 36);
}

function fit(w, h) {
  const scale = Math.min(1, 480 / w, 360 / h);
  for (const id of ['source', 'out', 'outCpu']) { $(id).width = Math.round(w * scale); $(id).height = Math.round(h * scale); }
  if (typeof selection !== 'undefined') { selection.reset($('source').width, $('source').height); bindSelection(); }
  if (typeof ai !== 'undefined') { ai.invalidate(); aiBoxes = []; }
  if (typeof resetTrack !== 'undefined') resetTrack();
}

/** The picture drawn at any size: the preview, or the full size for export. */
function drawMedia(ctx, w, h) {
  if (media.kind === 'test') {
    ctx.save();
    ctx.scale(w / 320, h / 240);
    drawTestPicture(ctx, 320, 240);
    ctx.restore();
  } else {
    ctx.drawImage(media.source, 0, 0, w, h);
  }
}

function showPicture() {
  if (typeof updateMoving !== 'undefined') updateMoving();
  const src = $('source');
  drawMedia(src.getContext('2d'), src.width, src.height);
  if (runner) runner.setImage(src);
  repaintCopies();
  draw();
  if (typeof exporter !== 'undefined') exporter.pictureChanged();
  if (typeof selection !== 'undefined') selection.pictureChanged();
  if (typeof trackFrameShown !== 'undefined') trackFrameShown();
}

let gifTimer = null;
function stopMedia() {
  if (video) { video.pause(); video = null; }
  clearTimeout(gifTimer);
  gifTimer = null;
}
const stopVideo = stopMedia;

/** An animated GIF plays frame by frame at its own delays; t is the frame index. */
function playGif(gif, from = 0) {
  stopMedia();
  $('file').value = '';
  const frame = document.createElement('canvas');
  frame.width = gif.width;
  frame.height = gif.height;
  const ctx = frame.getContext('2d');
  media = { kind: 'gif', source: frame, width: gif.width, height: gif.height, gif, index: from };
  fit(gif.width, gif.height);
  $('credit').textContent = `GIF: ${gif.frames.length} frames`;
  const step = () => {
    if (media.gif !== gif) return;
    ctx.putImageData(new ImageData(gif.frames[media.index].data, gif.width, gif.height), 0, 0);
    showPicture();
    syncT(media.index);
    gifTimer = setTimeout(() => { media.index = (media.index + 1) % gif.frames.length; step(); }, gif.frames[media.index].delay);
  };
  step();
}

function testPicture() {
  stopVideo();
  media = { kind: 'test', source: null, width: 320, height: 240 };
  fit(320, 240);
  showPicture();
  $('photo').value = 'test';
  $('credit').textContent = '';
}

// Photos listed in photos/index.json (see demo/photos/README.md) go in the chooser; the first is
// what the page opens on. ?picture=test (or a number) chooses; the checkers use the test picture.
let photos = [];
async function loadPhotos() {
  try {
    const response = await fetch('photos/index.json', { cache: 'no-store' });
    if (response.ok) photos = await response.json();
  } catch { photos = []; }
  if (!Array.isArray(photos) || !photos.length) { photos = []; return; }
  const chooser = $('photo');
  chooser.hidden = false;
  chooser.append(new Option('test picture', 'test'), ...photos.map((p, i) => new Option((p.title || p.file) + (/\.(mp4|webm|mov)$/i.test(p.file) ? ' (video)' : ''), String(i))));
  chooser.onchange = () => (chooser.value === 'test' ? testPicture() : showPhoto(Number(chooser.value)));
  const wanted = QUERY.get('picture');
  if (wanted !== 'test') await showPhoto(Math.min(photos.length - 1, Math.max(0, Number(wanted) || 0)));
}

/** A video plays muted and looped; t counts its frames. */
async function playVideo(url) {
  stopVideo();
  const v = Object.assign(document.createElement('video'), { src: url, muted: true, loop: true, playsInline: true, crossOrigin: 'anonymous' });
  await new Promise((resolve, reject) => { v.onloadedmetadata = resolve; v.onerror = () => reject(new Error(`Could not play ${url}`)); });
  video = v;
  media = { kind: 'video', source: v, width: v.videoWidth, height: v.videoHeight };
  fit(v.videoWidth, v.videoHeight);
  currentT = 0;
  const onFrame = () => {                        // t counts the video's frames
    if (video !== v) return;
    showPicture();
    syncT(currentT + 1);
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame); else requestAnimationFrame(onFrame);
  };
  await v.play();
  onFrame();
}

async function showPhoto(index) {
  const photo = photos[index];
  if (/\.(mp4|webm|mov)$/i.test(photo.file)) {
    // Held in memory (they are small): then seeking works whatever the server — tracking and pausing on a frame need it.
    try {
      const response = await fetch(`photos/${photo.file}`);
      if (!response.ok) throw new Error(`Could not load photos/${photo.file}`);
      await playVideo(URL.createObjectURL(await response.blob()));
    } catch (e) { showError(e.message); return; }
    $('file').value = '';
    $('photo').value = String(index);
    showCredit(photo.credit || '');
    return;
  }
  const img = new Image();
  img.src = `photos/${photo.file}`;
  try { await img.decode(); } catch { showError(`Could not load photos/${photo.file}`); return; }
  stopVideo();
  $('file').value = '';
  media = { kind: 'image', source: img, width: img.naturalWidth, height: img.naturalHeight };
  fit(img.naturalWidth, img.naturalHeight);
  showPicture();
  $('photo').value = String(index);
  showCredit(photo.credit || '');
}

/** A credit line with [text](https://…) links — Unsplash and Pexels ask for them — rendered safely. */
function showCredit(credit) {
  const box = $('credit');
  box.textContent = '';
  for (const part of String(credit).split(/(\[[^\]]+\]\(https?:\/\/[^)\s]+\))/)) {
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
    if (link) box.append(Object.assign(document.createElement('a'), { textContent: link[1], href: link[2], target: '_blank', rel: 'noopener' }));
    else if (part) box.append(part);
  }
}

$('test-picture').onclick = testPicture;
$('file').onchange = async () => {
  const file = $('file').files[0];
  if (!file) return;
  stopVideo();
  if (file.type === 'image/gif' || /\.gif$/i.test(file.name)) {
    try { playGif(decodeGif(await file.arrayBuffer())); } catch (e) { showError(`Could not read the GIF: ${e.message}`); }
    return;
  }
  const url = URL.createObjectURL(file);
  if (file.type.startsWith('video/')) {
    await playVideo(url);
  } else {
    const img = new Image();
    img.src = url;
    await img.decode();
    media = { kind: 'image', source: img, width: img.naturalWidth, height: img.naturalHeight };
    fit(img.naturalWidth, img.naturalHeight);
    showPicture();
    $('credit').textContent = '';
  }
};

function syncT(value) {
  currentT = value;
  $('t').value = value % 241;
  $('tval').textContent = value;
  draw();
}
$('t').addEventListener('input', () => syncT(Number($('t').value)));

// ---- export ------------------------------------------------------------------
function download(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
/**
 * The filter on the picture at any size (the preview is at most 480 × 360),
 * within what the GPU can draw, as a 2D canvas. Effects measured in pixels —
 * blur radii, px — are the same number of pixels, so they look finer on a
 * big picture.
 */
async function renderFrame(width, height) {
  if (!runner) throw new Error('Nothing to draw yet');
  const limit = engine === 'gpu' ? Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), 4096) : 4096;
  const w = Math.min(limit, width), h = Math.min(limit, height);
  await new Promise((r) => setTimeout(r, 0));
  const full = document.createElement('canvas');
  full.width = w; full.height = h;
  drawMedia(full.getContext('2d'), w, h);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  if (selectionActive()) runner.setImage('selection', currentSelectionCanvas(w, h));
  await bindGraphics(w, h, false);                              // text and shapes drawn again at this size: crisp
  updateStrokes(w, h);                                           // and brush strokes, as at this frame
  try {
    if (engine === 'cpu') {
      runner.setImage(full);
      await runner.drawAsync({ t: currentT, canvas: out });
    } else {
      const canvas = $('out');
      const preview = [canvas.width, canvas.height];
      canvas.width = w; canvas.height = h;                       // the runner draws at the canvas's size
      runner.setImage(full);
      runner.draw({ t: currentT });
      out.getContext('2d').drawImage(canvas, 0, 0);
      [canvas.width, canvas.height] = preview;
    }
  } finally {
    runner.setImage($('source'));
    if (selectionActive()) runner.setImage('selection', currentSelectionCanvas($('source').width, $('source').height));
    await bindGraphics(undefined, undefined, false);
    draw();
  }
  return out;
}

// ---- text and shapes ---------------------------------------------------------
/** Draws every graphic of the filter at w × h (the preview by default) and gives them to the runner. */
let graphicsTurn = 0;
async function bindGraphics(w = $('source').width, h = $('source').height, redraw = true) {
  if (!runner || !compiled || !Object.keys(compiled.graphics ?? {}).length) return;
  const turn = ++graphicsTurn;
  const canvases = await MZ.renderGraphics(compiled, w, h);
  if (turn !== graphicsTurn && redraw) return;                  // a newer edit is already drawing
  for (const el of document.querySelectorAll('.font-status')) {
    const url = el.dataset.url;
    if (!url) continue;
    el.textContent = canvases.failedFonts.includes(url)
      ? `Could not load that font — check the name or address; the text uses ${el.dataset.fallback} meanwhile.`
      : `Using ${MZ.googleFontFamily(url) ? `"${MZ.googleFontFamily(url)}" from Google Fonts` : 'the font from that address'}.`;
  }
  for (const [name, canvas] of Object.entries(canvases)) runner.setImage(name, canvas);
  if (redraw) draw();
}

/** The graphic as drawn now: as compiled (with the settings of any chain inside the step), else its spec with this step's settings. */
function graphicNow(i, name, base) {
  const pass = compiled?.passes.find((p) => p.path[0] === i && p.graphics?.[name]);
  return pass ? pass.graphics[name] : MZ.normalizeGraphic(name, { ...base, ...(chain.steps[i].with[name] ?? {}) });
}

/** Change a graphic: kept in the step's `with`, so it is shared; no recompiling — only its picture is drawn again. */
function setGraphic(i, name, base, changes) {
  const step = chain.steps[i];
  const next = { ...(step.with[name] ?? {}), ...changes };            // the step's own settings win over any inside it, so this is what gets shared
  let spec;
  try { spec = MZ.normalizeGraphic(name, { ...graphicNow(i, name, base), ...changes }); } catch (e) { showError(e.message); return; }
  showError('');
  const before = graphicNow(i, name, base);
  step.with[name] = next;
  if (spec.shadows.length !== before.shadows.length) {
    // More or fewer shadow layers: new pictures, so the shaders change. Maths still laying the graphic on
    // the default way is kept in step with them; maths of one's own is left alone (the panel says what to add).
    const f = step.filter;
    if (typeof f.color === 'string' && f.color.replace(/\s+/g, '') === MZ.layeredExpression(name, before).replace(/\s+/g, '')) f.color = MZ.layeredExpression(name, spec);
    rebuild();
    updateShareSoon();
    return;
  }
  if (compiled) {
    for (const pass of compiled.passes) {
      if (pass.path[0] !== i || !pass.graphics?.[name]) continue;
      pass.graphics[name] = spec;
      compiled.graphics[pass.bind[name]] = spec;                 // its own picture: other steps' `title`s are untouched
      MZ.shadowLayerNames(name, spec).forEach((layer, k) => {    // and each shadow layer's picture
        pass.graphics[layer] = { ...spec, onlyShadow: k };
        compiled.graphics[pass.bind[layer]] = pass.graphics[layer];
      });
    }
  }
  bindGraphics();
  updateShareSoon();
}

const FAMILIES = ['sans-serif', 'serif', 'monospace', 'system-ui', 'Georgia, serif', 'Impact, Haettenschweiler, sans-serif', 'Trebuchet MS, sans-serif',
  'Courier New, monospace', 'Palatino, serif', 'Comic Sans MS, cursive', 'Brush Script MT, cursive'];
const localFonts = [];                                           // families loaded from files: on this computer only

function graphicControls(i, name, base) {
  const g = graphicNow(i, name, base);
  const box = document.createElement('div');
  box.className = 'graphic';
  const set = (changes) => setGraphic(i, name, base, changes);
  const row = () => Object.assign(document.createElement('div'), { className: 'row2' });
  const head = row();
  head.append(Object.assign(document.createElement('b'), { textContent: name }), ` ${{ text: 'text', rect: 'rectangle', ellipse: 'oval', strokes: 'brush' }[g.type] ?? 'shape'}`);
  box.append(head);
  if (g.type === 'strokes') return brushControls(i, name, base, g, set, box);
  if (g.type === 'text') {
    const words = Object.assign(document.createElement('textarea'), { value: g.text, rows: 1 });
    words.addEventListener('input', () => set({ text: words.value }));
    box.append(words);
    box.append(fontControls(g, set));
    const style = row();
    const bold = Object.assign(document.createElement('input'), { type: 'checkbox', checked: g.weight === 'bold' || Number(g.weight) >= 600 });
    bold.onchange = () => set({ weight: bold.checked ? 'bold' : 'normal' });
    const italic = Object.assign(document.createElement('input'), { type: 'checkbox', checked: g.style === 'italic' });
    italic.onchange = () => set({ style: italic.checked ? 'italic' : 'normal' });
    const align = document.createElement('select');
    for (const a of ['left', 'center', 'right']) align.append(new Option(a, a, false, a === g.align));
    align.onchange = () => set({ align: align.value });
    const label = (input, text) => { const l = document.createElement('label'); l.append(input, ` ${text}`); return l; };
    style.append(label(bold, 'bold'), label(italic, 'italic'), label(align, 'align'));
    box.append(style);
    box.append(knob('size', g.size, 0.01, 0.4, 0.002, (v) => set({ size: v })));
  } else {
    box.append(knob('width', g.w, 0, 1.5, 0.005, (v) => set({ w: v })));
    box.append(knob('height', g.h, 0, 1.5, 0.005, (v) => set({ h: v })));
    if (g.type === 'rect') box.append(knob('corners', g.radius, 0, 0.5, 0.01, (v) => set({ radius: v })));
  }
  box.append(knob('x', g.x, -0.2, 1.2, 0.002, (v) => set({ x: v })));
  box.append(knob('y', g.y, -0.2, 1.2, 0.002, (v) => set({ y: v })));
  box.append(knob('angle', g.angle, -3.14, 3.14, 0.01, (v) => set({ angle: v })));
  const looks = row();
  const colour = Object.assign(document.createElement('input'), { type: 'color', value: cssToHex(g.color) });
  colour.oninput = () => set({ color: colour.value });
  const shadowOn = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(g.shadow) });
  const shadowColour = Object.assign(document.createElement('input'), { type: 'color', value: cssToHex(g.shadow?.color ?? '#000000') });
  const shadow = () => (shadowOn.checked ? { ...(g.shadow ?? { blur: 0.15, dx: 0.04, dy: 0.06 }), color: hexAlpha(shadowColour.value, 0.7) } : null);
  shadowOn.onchange = () => set({ shadow: shadow() });
  shadowColour.oninput = () => { shadowOn.checked = true; set({ shadow: shadow() }); };
  const outlineOn = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(g.outline) });
  const outlineColour = Object.assign(document.createElement('input'), { type: 'color', value: cssToHex(g.outline?.color ?? '#000000') });
  const outline = () => (outlineOn.checked ? { width: g.outline?.width ?? 0.06, color: outlineColour.value } : null);
  outlineOn.onchange = () => set({ outline: outline() });
  outlineColour.oninput = () => { outlineOn.checked = true; set({ outline: outline() }); };
  looks.append('colour', colour, outlineOn, 'outline', outlineColour, shadowOn, 'shadow, drawn in', shadowColour);
  box.append(looks);
  if (g.shadow) box.append(knob('shadow blur', g.shadow.blur, 0, 1, 0.01, (v) => set({ shadow: { ...graphicNow(i, name, base).shadow, blur: v } })));
  box.append(shadowLayerControls(i, name, base, g, set));
  return box;
}

/**
 * Shadow layers: each a picture of its own (title_shadow1, title_shadow2… back to front),
 * so the maths can give each its own filter. The controls set how each is cast.
 */
function shadowLayerControls(i, name, base, g, set) {
  const box = document.createElement('div');
  const head = Object.assign(document.createElement('div'), { className: 'row2' });
  const add = button('+ shadow layer', () => set({ shadows: [...g.shadows, { color: 'rgba(0,0,0,0.7)', blur: 0.3, dx: 0.05, dy: 0.08 }] }));
  add.disabled = g.shadows.length >= MZ.MAX_SHADOW_LAYERS;
  head.append(Object.assign(document.createElement('b'), { textContent: 'shadow layers' }), add);
  box.append(head);
  const names = MZ.shadowLayerNames(name, g);
  const maths = String(chain.steps[i].filter.color ?? '');
  g.shadows.forEach((layer, k) => {
    const change = (changes) => set({ shadows: g.shadows.map((l, j) => (j === k ? { ...l, ...changes } : l)) });
    const line = Object.assign(document.createElement('div'), { className: 'row2' });
    const c = Object.assign(document.createElement('input'), { type: 'color', value: cssToHex(layer.color) });
    c.oninput = () => change({ color: hexAlpha(c.value, 0.8) });
    line.append(Object.assign(document.createElement('code'), { textContent: names[k] }), c,
      button('remove', () => set({ shadows: g.shadows.filter((_, j) => j !== k) })));
    if (!new RegExp(`\\b${names[k]}\\b`).test(maths)) line.append(Object.assign(document.createElement('span'), { className: 'hint', textContent: ` — not in the maths yet: add mix(…, ${names[k]}, alpha(${names[k]}))` }));
    box.append(line);
    box.append(knob('blur', layer.blur, 0, 2, 0.01, (v) => change({ blur: v })));
    box.append(knob('across', layer.dx, -1, 1, 0.005, (v) => change({ dx: v })));
    box.append(knob('down', layer.dy, -1, 1, 0.005, (v) => change({ dy: v })));
  });
  if (g.shadows.length) {
    box.append(Object.assign(document.createElement('div'), { className: 'hint',
      textContent: `Each layer is a picture of that shadow alone, back to front, so the maths can treat it on its own — e.g. mix(rgb, gaussian(4), alpha(${names[0]})) blurs the picture under it, mix(rgb, (1, 0.2, 0.6), alpha(${names[0]})) colours it, shift(${names[0]}, 2 sin(t / 9), 0) moves it.` }));
  }
  return box;
}

/**
 * The font: one on every computer, a Google Fonts name, a font file from this computer
 * (here only), or the web address of a font file — and whether it loaded.
 */
function fontControls(g, set) {
  const box = document.createElement('div');
  const line = Object.assign(document.createElement('div'), { className: 'row2' });
  line.append(Object.assign(document.createElement('b'), { textContent: 'font' }));
  const family = document.createElement('select');
  const group = (label, list) => {
    if (!list.length) return;
    const og = Object.assign(document.createElement('optgroup'), { label });
    for (const f of list) {
      const o = new Option(f.split(',')[0].replace(/"/g, ''), f, false, !g.fontUrl && f === g.font);
      o.style.fontFamily = f;
      og.append(o);
    }
    family.append(og);
  };
  const google = g.fontUrl ? MZ.googleFontFamily(g.fontUrl) : null;
  if (g.fontUrl) family.append(new Option(google ? `${google} (Google Fonts)` : 'from a web address', '', false, true));
  group('On every computer', FAMILIES.filter((f) => f !== g.font || !g.fontUrl));
  group('Loaded from a file (this computer only)', localFonts);
  if (!g.fontUrl && !FAMILIES.includes(g.font) && !localFonts.includes(g.font)) family.append(new Option(g.font, g.font, false, true));
  family.onchange = () => { if (family.value) set({ font: family.value, fontUrl: null }); };
  line.append(family);
  box.append(line);

  const more = Object.assign(document.createElement('div'), { className: 'row2' });
  const googleName = Object.assign(document.createElement('input'), { type: 'text', placeholder: 'a Google Fonts name, e.g. Lobster', value: google ?? '', size: 22 });
  const useGoogle = () => {
    if (!googleName.value.trim()) return;
    try { set({ fontUrl: MZ.googleFontUrl(googleName.value) }); } catch (e) { showError(e.message); }
  };
  googleName.addEventListener('keydown', (e) => { if (e.key === 'Enter') useGoogle(); });
  const file = Object.assign(document.createElement('input'), { type: 'file', accept: '.woff2,.woff,.ttf,.otf', hidden: true });
  file.onchange = async () => { const family = await loadFontFile(file.files[0]); if (family) set({ font: family, fontUrl: null }); };
  more.append(googleName, button('use', useGoogle), 'or', button('a font file…', () => file.click()), file);
  box.append(more);

  const address = Object.assign(document.createElement('details'));
  address.append(Object.assign(document.createElement('summary'), { className: 'hint', textContent: 'or a font file\'s web address' }));
  const url = Object.assign(document.createElement('input'), { type: 'text', placeholder: 'https://…/font.woff2', value: g.fontUrl && !google ? g.fontUrl : '', size: 34 });
  url.onchange = () => set({ fontUrl: url.value.trim() || null });
  address.append(url);
  if (g.fontUrl && !google) address.open = true;
  box.append(address);

  const status = Object.assign(document.createElement('div'), { className: 'hint font-status' });
  status.dataset.url = g.fontUrl ?? '';
  status.dataset.fallback = g.font.split(',')[0];
  status.textContent = g.fontUrl ? 'Loading the font…' : localFonts.includes(g.font) ? 'A font from a file on this computer: a share link will show another font instead (use a Google Fonts name or a web address to share it).' : '';
  box.append(status);
  return box;
}

/** CSS colour → #rrggbb for <input type=color> (the browser does the parsing). */
function cssToHex(css) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = '#000';
  c.fillStyle = css;
  const v = c.fillStyle;
  if (v.startsWith('#')) return v.slice(0, 7);
  const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(v);
  return m ? '#' + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('') : '#000000';
}
const hexAlpha = (hex, a) => `rgba(${[1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)).join(',')},${a})`;

/** New text or shapes: a step of their own, whose maths lays them on (and can be edited like any expression). */
function newName(prefix) {
  const taken = new Set(Object.keys(compiled?.graphics ?? {}));
  for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
}
$('add-text').onclick = () => { const n = newName('text'); addStep({ graphics: { [n]: { type: 'text', text: 'Your words', y: 0.5 } }, color: `mix(rgb, ${n}, alpha(${n}))` }); };
$('add-rect').onclick = () => { const n = newName('box'); addStep({ graphics: { [n]: { type: 'rect', y: 0.5, w: 0.5, h: 0.25, color: '#ffffff' } }, color: `mix(rgb, mix(rgb, ${n}, 0.6), alpha(${n}))` }); };
$('add-oval').onclick = () => { const n = newName('oval'); addStep({ graphics: { [n]: { type: 'ellipse', y: 0.5, w: 0.35, h: 0.35, color: '#ffffff' } }, color: `mix(rgb, mix(rgb, ${n}, 0.6), alpha(${n}))` }); };

// A font file from this computer: usable straight away, but a share link can't carry it (use a font URL for that).
async function loadFontFile(file) {
  if (!file) return null;
  const family = file.name.replace(/\.[^.]+$/, '').replace(/[^\w\s-]/g, ' ').trim() || 'My font';
  try {
    const face = new FontFace(family, await file.arrayBuffer());
    document.fonts.add(await face.load());
    if (!localFonts.includes(family)) localFonts.push(family);
    $('font-msg').textContent = `"${family}" is in every font list now — on this computer only; to share a font, use a Google Fonts name or a web address.`;
    renderSteps();
    return family;
  } catch (e) {
    $('font-msg').textContent = `Could not read that font file: ${e.message}`;
    return null;
  }
}
$('font-file').onchange = () => loadFontFile($('font-file').files[0]);

// Drag a graphic on the picture to move it: the one whose centre is nearest the pointer.
{
  let moving = null;
  const frac = (e) => { const r = $('source').getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  const nearest = ([x, y]) => {
    let best = null, bestD = 0.2;
    chain.steps.forEach((step, i) => {
      for (const [name, base] of Object.entries(MZ.filterGraphics(step.filter))) {
        const g = graphicNow(i, name, base);
        const d = Math.hypot(g.x - x, g.y - y);
        if (d < bestD) { bestD = d; best = { i, name, base, dx: g.x - x, dy: g.y - y }; }
      }
    });
    return best;
  };
  $('input').addEventListener('pointerdown', (e) => {
    if (selection.state.mode !== 'off' || e.button !== 0 || brushTarget) return;   // painting takes the picture when a brush is drawing
    moving = nearest(frac(e));
    if (!moving) return;
    $('input').setPointerCapture(e.pointerId);
    $('input').classList.add('moving');
    e.preventDefault();
  });
  $('input').addEventListener('pointermove', (e) => {
    if (!moving) return;
    const [x, y] = frac(e);
    setGraphic(moving.i, moving.name, moving.base, { x: +(x + moving.dx).toFixed(4), y: +(y + moving.dy).toFixed(4) });
  });
  $('input').addEventListener('pointerup', () => { if (moving) { moving = null; $('input').classList.remove('moving'); renderSteps(); } });
}

// ---- examples: a guided tour --------------------------------------------------
/** `code` in an explanation becomes <code>; everything else is text. */
function withCode(text) {
  const span = document.createElement('span');
  text.split(/`([^`]+)`/).forEach((part, k) => span.append(k % 2 ? Object.assign(document.createElement('code'), { textContent: part }) : part));
  return span;
}
function renderExamples() {
  const list = $('example-list');
  list.textContent = '';
  for (const example of EXAMPLES) {
    const b = button(example.title, () => showExample(example));
    b.dataset.id = example.id;
    list.append(b);
  }
}
async function showExample(example) {
  for (const b of $('example-list').children) b.classList.toggle('on', b.dataset.id === example.id);
  const index = photos.findIndex((p) => p.file === example.picture);
  if (example.picture === 'test' || !photos.length) testPicture();
  else await showPhoto(Math.max(0, index));
  loadChain(resolveExample(example, BUILTIN));
  currentT = 0;
  const box = $('example-how');
  box.hidden = false;
  box.textContent = '';
  box.append(Object.assign(document.createElement('h3'), { textContent: example.title }));
  const tags = document.createElement('div');
  for (const s of example.shows) tags.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: s }));
  box.append(tags);
  const steps = document.createElement('ol');
  for (const line of example.how) { const li = document.createElement('li'); li.append(withCode(line)); steps.append(li); }
  box.append(steps);
  box.append(Object.assign(document.createElement('div'), { className: 'hint', textContent: 'The maths is in the steps below — change any of it and the picture follows. "How to write a filter" lists everything you can use.' }));
  await bindGraphics();
}

// ---- brushes: strokes painted on the picture ----------------------------------
let brushTarget = null;                  // { i, name } of the brush that paints when the picture is dragged
let liveStroke = null;                   // the stroke being drawn: { key, points, t0 }
let selectionVersion = 0;
const maskCache = { key: '', mask: null };

/** The selection as a w × h Float32Array 0–1, for brushes that stay inside (or outside) it. */
function selectionMask(w, h) {
  if (!selectionActive()) return null;
  const key = `${w}x${h}:${selectionVersion}`;
  if (maskCache.key !== key) {
    const d = currentSelectionCanvas(w, h).getContext('2d').getImageData(0, 0, w, h).data;
    const m = new Float32Array(w * h);
    for (let i = 0; i < m.length; i++) m[i] = d[i * 4] / 255;
    maskCache.key = key;
    maskCache.mask = m;
  }
  return maskCache.mask;
}

/**
 * Brush strokes are drawn again for every frame: only the paint laid down by frame t shows.
 * While a brush is drawing, they are shown finished, so the painter sees what they paint.
 */
function updateStrokes(w = $('source').width, h = $('source').height, t = brushTarget ? Infinity : currentT) {
  if (!runner || !compiled) return;
  for (const [key, spec] of Object.entries(compiled.graphics ?? {})) {
    if (spec.type !== 'strokes') continue;
    const drawn = liveStroke && liveStroke.key === key ? { ...spec, strokes: [...spec.strokes, { points: liveStroke.points }] } : spec;
    const r = MZ.rasterizeStrokes(drawn, w, h, t, { mask: spec.clip === 'none' ? null : selectionMask(w, h) });
    runner.setImage(key, new ImageData(r.data, w, h));
  }
}

/**
 * The brush strokes drawn as lines over the original, so it is easy to see what has been painted
 * (the result may show little of them yet, or nothing: the paint is maths). Until "hide strokes".
 */
let showStrokes = true;
function drawStrokeOverlay() {
  const c = $('strokes-overlay'), w = $('source').width, h = $('source').height;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!showStrokes) return;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  chain.steps.forEach((step, i) => {
    if (step.skip) return;
    for (const [name, base] of Object.entries(MZ.filterGraphics(step.filter))) {
      if (base.type !== 'strokes') continue;
      const spec = graphicNow(i, name, base);
      const drawing = brushTarget && brushTarget.i === i && brushTarget.name === name;
      const strokes = drawing && liveStroke ? [...spec.strokes, { points: liveStroke.points }] : spec.strokes;
      for (const { points } of strokes) {
        if (!points.length) continue;
        const path = () => { g.beginPath(); points.forEach(([x, y], k) => (k ? g.lineTo(x * w, y * h) : g.moveTo(x * w, y * h))); if (points.length === 1) g.lineTo(points[0][0] * w + 0.01, points[0][1] * h); };
        path();
        g.strokeStyle = 'rgba(255, 40, 150, 0.45)';
        g.lineWidth = Math.max(2, spec.size * h);
        g.stroke();
        path();
        g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        g.lineWidth = 1;
        g.stroke();
      }
    }
  });
}

/** What each brush effect does: the step's maths (and any knob it needs). */
const BRUSH_EFFECTS = {
  'ink': { label: 'ink in a colour', color: (n) => `mix(rgb, ink, alpha(${n}))`, params: { ink: { type: 'color', default: [0.95, 0.2, 0.25] } } },
  'blur': { label: 'blur, stronger each pass', color: (n) => `mix(rgb, gaussian(2 + 3 min(4 green(${n}), 3)), alpha(${n}))` },
  'darken': { label: 'darken, building up', color: (n) => `rgb (1 - 0.22 min(4 green(${n}), 4) alpha(${n}))` },
  'reveal': { label: 'reveal the colour (picture starts grey)', color: (n) => `mix((gray, gray, gray), rgb, alpha(${n}))` },
  'fuse': { label: 'glow, then cool to charcoal', color: (n) => `mix(rgb, mix((1, 0.9, 0.5), (0.1, 0.07, 0.06), red(${n})), alpha(${n})) + (1, 0.5, 0.1) alpha(${n}) max(0, 1 - 3 red(${n})) 0.6` },
  'rainbow': { label: 'rainbow along the drawing', color: (n) => `mix(rgb, fromhsv(blue(${n}), 0.85, 1), alpha(${n}))` },
  'invert': { label: 'invert', color: (n) => `mix(rgb, 1 - rgb, alpha(${n}))` },
};

function brushControls(i, name, base, g, set, box) {
  const step = chain.steps[i];
  const f = step.filter;
  const row = () => Object.assign(document.createElement('div'), { className: 'row2' });
  const timeline = MZ.strokeTimeline(g, $('source').width / $('source').height);
  const drawing = brushTarget && brushTarget.i === i && brushTarget.name === name;

  const actions = row();
  const drawButton = button(drawing ? 'drawing — click to stop' : 'draw', () => { brushTarget = drawing ? null : { i, name, base }; $('input').classList.toggle('painting', Boolean(brushTarget)); renderSteps(); draw(); });
  if (drawing) drawButton.classList.add('brush-on');
  actions.append(drawButton,
    button('undo stroke', () => { set({ strokes: graphicNow(i, name, base).strokes.slice(0, -1) }); renderSteps(); }),   // the strokes as they are now, not as this panel was drawn
    button('clear', () => { set({ strokes: [] }); renderSteps(); }),
    button('outline the selection', () => { outlineSelection(graphicNow(i, name, base), set); renderSteps(); }),
    button('replay', () => { brushTarget = null; $('input').classList.remove('painting'); currentT = 0; $('play').checked = true; renderSteps(); }),
    button(showStrokes ? 'hide strokes' : 'show strokes', () => { showStrokes = !showStrokes; renderSteps(); draw(); }));
  box.append(actions);
  box.append(Object.assign(document.createElement('div'), { className: 'brush-info',
    textContent: g.strokes.length
      ? `${g.strokes.length} stroke${g.strokes.length > 1 ? 's' : ''} · drawn over ${Math.round(timeline.total)} frames (${(timeline.total / MZ.FPS).toFixed(1)} s)${drawing ? ' · shown finished while drawing' : ''}`
      : 'Click "draw", then paint on the picture (top left). A pen or touch screen gives pressure.' }));

  // what the paint does: the step's maths
  const effect = row();
  const pick = document.createElement('select');
  const current = Object.entries(BRUSH_EFFECTS).find(([, e]) => String(f.color).replace(/\s+/g, '') === e.color(name).replace(/\s+/g, ''))?.[0];
  if (!current) pick.append(new Option('your own maths (in the step above)', '', false, true));
  for (const [key, e] of Object.entries(BRUSH_EFFECTS)) pick.append(new Option(e.label, key, false, key === current));
  pick.onchange = () => {
    const e = BRUSH_EFFECTS[pick.value];
    if (!e) return;
    f.color = e.color(name);
    if (e.params) f.params = { ...(f.params ?? {}), ...e.params };
    rebuild();
    updateShareSoon();
  };
  effect.append(Object.assign(document.createElement('b'), { textContent: 'the paint' }), pick);
  box.append(effect);

  // the brush
  const brush = row();
  const kind = document.createElement('select');
  for (const b of MZ.BRUSHES) kind.append(new Option(b, b, false, b === g.brush));
  kind.onchange = () => set({ brush: kind.value });
  const from = document.createElement('select');
  for (const [v, l] of [['pressure', 'width from pressure'], ['speed', 'width from speed'], ['none', 'even width']]) from.append(new Option(l, v, false, v === g.widthFrom));
  from.onchange = () => set({ widthFrom: from.value });
  const build = Object.assign(document.createElement('input'), { type: 'checkbox', checked: g.buildUp });
  build.onchange = () => set({ buildUp: build.checked });
  const buildLabel = document.createElement('label');
  buildLabel.append(build, ' build up where strokes overlap');
  brush.append(Object.assign(document.createElement('b'), { textContent: 'brush' }), kind, from, buildLabel);
  box.append(brush);
  box.append(knob('size', g.size, 0.003, 0.25, 0.001, (v) => set({ size: v })));
  box.append(knob('flow', g.flow, 0.05, 1, 0.01, (v) => set({ flow: v })));
  box.append(knob('spacing', g.spacing, 0.05, 1, 0.01, (v) => set({ spacing: v })));
  box.append(knob('taper', g.taper, 0, 0.5, 0.01, (v) => set({ taper: v })));

  // timing
  const timing = row();
  const mode = document.createElement('select');
  for (const [v, l] of [['recorded', 'as I drew it'], ['even', 'by length (even speed)'], ['per-stroke', 'same time per stroke']]) mode.append(new Option(l, v, false, v === g.timing));
  mode.onchange = () => set({ timing: mode.value });
  timing.append(Object.assign(document.createElement('b'), { textContent: 'timing' }), mode);
  box.append(timing);
  box.append(knob('speed', g.speed, 0.1, 5, 0.05, (v) => set({ speed: v })));
  box.append(knob('gap (frames)', g.gap, 0, 60, 1, (v) => set({ gap: v })));
  box.append(knob('start (frames)', g.start, 0, 120, 1, (v) => set({ start: v })));
  box.append(knob('fit to frames (0: off)', g.fit, 0, 600, 1, (v) => set({ fit: v })));
  box.append(knob('age span (frames)', g.age, 1, 200, 1, (v) => set({ age: v })));

  // where it may paint
  const where = row();
  const clip = document.createElement('select');
  for (const [v, l] of [['none', 'anywhere'], ['inside', 'only inside the selection'], ['outside', 'only outside the selection']]) clip.append(new Option(l, v, false, v === g.clip));
  clip.onchange = () => set({ clip: clip.value });
  where.append(Object.assign(document.createElement('b'), { textContent: 'paint' }), clip);
  if (g.clip !== 'none' && !selection.hasSelection()) where.append(Object.assign(document.createElement('span'), { className: 'hint', textContent: ' — select something under the picture first' }));
  box.append(where);

  box.append(Object.assign(document.createElement('div'), { className: 'hint',
    textContent: `In the maths, ${name} is the paint: alpha(${name}) where it is; red(${name}) how long ago it was painted (0 just now, 1 after "age span" frames); green(${name}) × 4 how many strokes went over it; blue(${name}) how far through the drawing it was painted. So the paint can change as it is drawn — and with t, after.` }));
  return box;
}

/** The selection's outline (or outlines) as strokes, drawn round at an even pace. */
function outlineSelection(g, set) {
  if (!selection.hasSelection()) { showError('Select something first (under the picture: trace the edge, fill a colour, or find objects), then outline it.'); return; }
  const w = $('source').width, h = $('source').height;
  const loops = MZ.traceContours(selectionMask(w, h), w, h);
  if (!loops.length) { showError('The selection is too small to outline.'); return; }
  const strokes = loops.map((loop) => {
    let ms = 0;
    return { points: loop.map(([x, y], k) => {
      if (k) ms += Math.hypot(x - loop[k - 1][0], y - loop[k - 1][1]) / h * 1500;     // 1.5 s per frame height, as if drawn by hand
      return [(x + 0.5) / w, (y + 0.5) / h, Math.round(ms), 1];
    }) };
  });
  set({ strokes: [...g.strokes, ...strokes] });
}

// Painting: the brush in "draw" takes the picture.
{
  const at = (e) => { const r = $('source').getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  const pressure = (e) => (e.pointerType === 'mouse' ? 1 : e.pressure || 0.5);
  $('input').addEventListener('pointerdown', (e) => {
    if (!brushTarget || selection.state.mode !== 'off' || e.button !== 0) return;
    const pass = compiled?.passes.find((p) => p.path[0] === brushTarget.i && p.graphics?.[brushTarget.name]);
    if (!pass) return;
    const [x, y] = at(e);
    liveStroke = { key: pass.bind[brushTarget.name], t0: e.timeStamp, points: [[x, y, 0, pressure(e)]] };
    $('input').setPointerCapture(e.pointerId);
    e.preventDefault();
    draw();
  });
  $('input').addEventListener('pointermove', (e) => {
    if (!liveStroke) return;
    const aspect = $('source').width / $('source').height;
    for (const ev of e.getCoalescedEvents ? e.getCoalescedEvents() : [e]) {           // every sample the pointer gave, for smooth lines
      const [x, y] = at(ev);
      const last = liveStroke.points[liveStroke.points.length - 1];
      if (Math.hypot((x - last[0]) * aspect, y - last[1]) < 0.002) continue;
      liveStroke.points.push([x, y, Math.max(0, Math.round(ev.timeStamp - liveStroke.t0)), pressure(ev)]);   // the user's own timing
    }
    draw();
  });
  $('input').addEventListener('pointerup', () => {
    if (!liveStroke || !brushTarget) return;
    const { points } = liveStroke;
    liveStroke = null;
    const { i, name, base } = brushTarget;
    setGraphic(i, name, base, { strokes: [...graphicNow(i, name, base).strokes, { points }] });
    renderSteps();
  });
}

$('add-brush').onclick = () => {
  const n = newName('brush');
  addStep({ graphics: { [n]: { type: 'strokes', brush: 'round', size: 0.025 } }, params: { ink: [0.95, 0.2, 0.25] }, color: `mix(rgb, ink, alpha(${n}))` });
  brushTarget = { i: chain.steps.length - 1, name: n, base: MZ.normalizeGraphic(n, { type: 'strokes', brush: 'round', size: 0.025 }) };
  $('input').classList.add('painting');
  renderSteps();
};

// ---- tracking an object through a video or GIF ---------------------------------
let track = null;                        // { tracker, frames, w, h, analysis } for the clip on screen
let tracking = false, stopTracking = false, paused = false;

function clipFrames() {
  if (media.kind === 'gif') return media.gif.frames.length;
  if (media.kind === 'video') return Math.max(1, Math.floor(media.source.duration * MZ.FPS));
  return 0;
}
/** The frame on screen, as the tracker numbers them (t counts frames at MZ.FPS for a video). */
function currentFrame() {
  if (media.kind === 'gif') return media.index;
  if (media.kind === 'video') return Math.min(clipFrames() - 1, Math.max(0, Math.floor(media.source.currentTime * MZ.FPS + 0.01)));
  return 0;
}
function trackedOutline() {
  if (!track || !$('track-follow').checked) return null;
  return track.tracker.results[currentFrame()]?.loop ?? null;
}
/** Is anything selected for this frame: the user's selection, or the tracked outline? */
function selectionActive() { return Boolean(trackedOutline()) || selection.hasSelection(); }
function currentSelectionCanvas(w, h) {
  const outline = trackedOutline();
  return outline ? selection.maskCanvas(w, h, { outline }) : selection.maskCanvas(w, h);
}

function resetTrack() {
  stopTracking = true;
  track = null;
  paused = false;
  $('track-section').hidden = !(media.kind === 'video' || media.kind === 'gif');
  $('track-msg').textContent = '';
  drawTimeline();
  drawTrackOverlay();
}

/** A frame of the clip at preview size, as a canvas: from a second copy of the video (seeking it), or the GIF's frames. */
async function clipFrame(k) {
  const w = $('source').width, h = $('source').height;
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (media.kind === 'gif') {
    const g = media.gif, frame = Object.assign(document.createElement('canvas'), { width: g.width, height: g.height });
    frame.getContext('2d').putImageData(new ImageData(g.frames[k].data, g.width, g.height), 0, 0);
    ctx.drawImage(frame, 0, 0, w, h);
  } else {
    const v = track.analysis;
    await seekTo(v, k);
    ctx.drawImage(v, 0, 0, w, h);
  }
  return canvas;
}

async function ensureTrack() {
  if (track) return track;
  const w = $('source').width, h = $('source').height;
  let analysis = null;
  if (media.kind === 'video') {
    analysis = Object.assign(document.createElement('video'), { src: media.source.currentSrc || media.source.src, muted: true, preload: 'auto' });
    await new Promise((resolve, reject) => { analysis.onloadeddata = resolve; analysis.onerror = () => reject(new Error('Could not read the video for tracking')); });
  }
  track = { frames: clipFrames(), w, h, analysis };
  track.tracker = createTracker({
    frames: track.frames, w, h,
    getFrame: async (k) => (await clipFrame(k)).getContext('2d').getImageData(0, 0, w, h).data,
    onProgress: (done, total) => { if (done !== undefined) $('track-msg').textContent = `Tracking… ${done} of ${total} frames`; drawTimeline(); },
  });
  return track;
}

/** Seek a video to frame k, and make sure it got there (a server without byte ranges leaves it on frame 0). */
async function seekTo(v, k) {
  const target = Math.min(v.duration - 0.001, (k + 0.5) / MZ.FPS);
  await new Promise((resolve) => { v.onseeked = resolve; v.currentTime = target; });
  if (Math.abs(v.currentTime - target) > 1 / MZ.FPS) throw new Error('This video cannot be stepped through frame by frame here (the server does not allow seeking). Load it with "picture or video" instead.');
}

/** Pause the clip on frame k (and show it). */
async function pauseAt(k) {
  paused = true;
  if (media.kind === 'gif') {
    clearTimeout(gifTimer);
    gifTimer = null;
    media.index = k;
    media.source.getContext('2d').putImageData(new ImageData(media.gif.frames[k].data, media.gif.width, media.gif.height), 0, 0);
    showPicture();
    syncT(k);
  } else if (media.kind === 'video') {
    const v = media.source;
    v.pause();
    await seekTo(v, k);
    showPicture();
  }
  $('track-play').textContent = '▶ play';
  describeFrame();
}
function resumeClip() {
  paused = false;
  if (media.kind === 'gif') playGif(media.gif, media.index);
  else if (media.kind === 'video') media.source.play();
  $('track-play').textContent = '❚❚ pause';
}

function drawTimeline() {
  const c = $('track-timeline'), g = c.getContext('2d');
  c.width = c.clientWidth || 480;
  g.fillStyle = '#eee';
  g.fillRect(0, 0, c.width, c.height);
  if (!track) return;
  const n = track.frames, rs = track.tracker.results, keys = track.tracker.keyframes;
  const ref = keys.size ? [...keys.keys()].reduce((s, k) => s + (rs[k]?.score ?? 0), 0) / keys.size : 1;
  for (let k = 0; k < n; k++) {
    const r = rs[k];
    if (!r) continue;
    const sure = Math.max(0, Math.min(1, r.score / Math.max(1e-6, ref) / 0.9));
    g.fillStyle = `hsl(${Math.round(sure * 120)}, 70%, 48%)`;
    g.fillRect((k / n) * c.width, 6, Math.ceil(c.width / n), c.height - 12);
  }
  g.fillStyle = '#111';
  for (const k of keys.keys()) g.fillRect((k / n) * c.width, 0, Math.max(2, c.width / n), c.height);
  g.fillStyle = '#e03a3a';
  g.fillRect((currentFrame() / n) * c.width, 0, 2, c.height);
}

function drawTrackOverlay() {
  const c = $('track-overlay');
  c.width = $('source').width; c.height = $('source').height;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const outline = track && track.tracker.results[currentFrame()]?.loop;
  if (!outline || !$('track-follow').checked) return;
  const key = track.tracker.keyframes.has(currentFrame());
  g.beginPath();
  outline.forEach(([x, y], i) => (i ? g.lineTo(x + 0.5, y + 0.5) : g.moveTo(x + 0.5, y + 0.5)));
  g.closePath();
  g.lineWidth = 2; g.strokeStyle = key ? '#111' : '#00e5ff'; g.setLineDash(key ? [] : [5, 3]); g.stroke();
}

function describeFrame() {
  if (!track) return;
  const k = currentFrame(), r = track.tracker.results[k];
  $('track-msg').textContent = `Frame ${k + 1} of ${track.frames}` + (!r ? ' · not tracked yet'
    : r.from === 'key' ? ' · a keyframe' : ` · tracked ${r.from}, confidence ${(r.score).toFixed(2)}${track.tracker.flagged().includes(k) ? ' — unsure: fix it ("edit this frame" or select again) and use it as a keyframe' : ''}`);
}

/** Every new frame on screen: the selection follows the track, the overlay and timeline too. */
function trackFrameShown() {
  if (!track) return;
  if (track.tracker.results.some(Boolean)) bindSelection(false);
  drawTrackOverlay();
  drawTimeline();
}

/** The largest outline of the current selection, in preview pixels. */
function selectionOutline() {
  if (!selection.hasSelection()) return null;
  const w = $('source').width, h = $('source').height;
  const d = selection.maskCanvas(w, h, { raw: true }).getContext('2d').getImageData(0, 0, w, h).data;
  const m = new Float32Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4] / 255;
  return largestLoop(MZ.traceContours(m, w, h));
}
function largestLoop(loops) {
  if (!loops.length) return null;
  const size = (l) => Math.abs(l.reduce((s, p, i) => s + p[0] * l[(i + 1) % l.length][1] - l[(i + 1) % l.length][0] * p[1], 0));
  return [...loops].sort((a, b) => size(b) - size(a))[0].slice(0, -1);
}

$('track-play').onclick = () => (paused ? resumeClip() : pauseAt(currentFrame()));
$('track-key').onclick = async () => {
  const loop = selectionOutline();
  if (!loop) { $('track-msg').textContent = 'Select the object first, under the picture: trace the edge, fill a colour or find objects.'; return; }
  if (!paused) await pauseAt(currentFrame());
  await ensureTrack();
  await track.tracker.setKeyframe(currentFrame(), loop);
  selection.clear();
  trackFrameShown();
  $('track-msg').textContent = `Frame ${currentFrame() + 1} is a keyframe. Press "track" to follow the object from here.`;
};
$('track-run').onclick = async () => {
  if (!track || !track.tracker.keyframes.size) { $('track-msg').textContent = 'Use a selection as a keyframe first.'; return; }
  if (tracking) return;
  tracking = true; stopTracking = false;
  $('track-stop').hidden = false;
  const t0 = performance.now();
  try {
    await track.tracker.track({ stop: () => stopTracking });
    const flagged = track.tracker.flagged();
    $('track-msg').textContent = `Tracked ${track.frames} frames in ${((performance.now() - t0) / 1000).toFixed(1)} s` +
      (flagged.length ? ` · ${flagged.length} unsure (red): click one to fix it, or "fix red frames with AI"` : ' · all sure');
  } catch (e) { $('track-msg').textContent = e.message; }
  tracking = false;
  $('track-stop').hidden = true;
  trackFrameShown();
};
$('track-stop').onclick = () => { stopTracking = true; };
$('track-clear').onclick = () => { resetTrack(); bindSelection(); };
$('track-follow').onchange = () => { bindSelection(); drawTrackOverlay(); };
$('track-timeline').onclick = (e) => {
  if (!track) return;
  const r = $('track-timeline').getBoundingClientRect();
  pauseAt(Math.min(track.frames - 1, Math.max(0, Math.floor((e.clientX - r.left) / r.width * track.frames))));
};
$('track-edit').onclick = async () => {
  const loop = track?.tracker.results[currentFrame()]?.loop;
  if (!loop) { $('track-msg').textContent = 'No tracked outline on this frame.'; return; }
  if (!paused) await pauseAt(currentFrame());
  selectMode('trace');
  selection.trace(resample(loop, Math.max(8, Math.min(24, Math.round(loop.length / 2)))).map(([x, y]) => [Math.round(x), Math.round(y)]));
  $('track-msg').textContent = 'Drag the points onto the edge, then "use as keyframe".';
};
$('track-ai').onclick = async () => {
  if (!track || tracking) return;
  const flagged = track.tracker.flagged();
  if (!flagged.length) { $('track-msg').textContent = 'No unsure frames to fix.'; return; }
  tracking = true;
  try {
    for (const [n, k] of flagged.entries()) {
      $('track-msg').textContent = `AI: frame ${k + 1} (${n + 1} of ${flagged.length})…`;
      const loop = track.tracker.results[k].loop;
      const xs = loop.map((p) => p[0]), ys = loop.map((p) => p[1]);
      const padX = (Math.max(...xs) - Math.min(...xs)) * 0.06, padY = (Math.max(...ys) - Math.min(...ys)) * 0.06;
      const box = [Math.min(...xs) - padX, Math.min(...ys) - padY, Math.max(...xs) + padX, Math.max(...ys) + padY];
      await ai.embed(await clipFrame(k));
      const m = await ai.mask({ box });
      const better = largestLoop(MZ.traceContours(Float32Array.from(m), track.w, track.h));
      if (better) await track.tracker.setKeyframe(k, better);
      drawTimeline();
    }
    ai.invalidate();
    tracking = false;
    $('track-run').onclick();
  } catch (e) {
    $('track-msg').textContent = e.message;
    tracking = false;
  }
};
new ResizeObserver(() => drawTimeline()).observe($('track-timeline'));

const exporter = setupExport({ $, renderFrame, media: () => media, download, outputCanvas: outCanvas, noDownload: () => Boolean(window.mzDemoNoDownload), canCrop: () => $('export').open });

// ---- selecting an object: `selected` in the maths ---------------------------
const NO_SELECTION = Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
NO_SELECTION.getContext('2d').fillStyle = '#fff';
NO_SELECTION.getContext('2d').fillRect(0, 0, 1, 1);
const selection = setupSelection({ $, source: () => $('source'), overlay: $('overlay'), surface: $('select-surface'), onChange: () => { bindSelection(); showSwatches(); } });
function showSwatches() {                                      // the wand's colours; click one to drop it
  const box = $('select-colours');
  box.textContent = '';
  selection.state.colours.forEach((c, i) => {
    const swatch = Object.assign(document.createElement('span'), { className: 'swatch', title: 'click to remove this colour' });
    swatch.style.background = `rgb(${c.join(',')})`;
    swatch.onclick = () => selection.removeColour(i);
    box.append(swatch);
  });
}
function bindSelection(redraw = true) {
  selectionVersion++;
  if (!runner) return;
  runner.setImage('selection', selectionActive() ? currentSelectionCanvas($('source').width, $('source').height) : NO_SELECTION);
  if (redraw) draw();
  exporter.pictureChanged();
}
// ---- find objects with the AI -----------------------------------------------
// In development the runtimes are in node_modules and the models in demo/models; the built site has them beside the page.
// The model: ?ai=… in the address, else the last one chosen here (the choice is to compare them; see ai.js).
const dev = location.pathname.includes('/demo/');
// in development every model in demo/models/ can be tried; the built site has only the shipped ones
const aiOffered = dev ? Object.keys(AI_MODELS) : SHIPPED_MODELS;
const aiChoice = [new URLSearchParams(location.search).get('ai'), localStorage.getItem('mz-ai-model')].find((k) => aiOffered.includes(k)) ?? DEFAULT_MODEL;
const ai = setupAI({
  source: () => $('source'), model: aiChoice,
  ortUrl: dev ? '/node_modules/onnxruntime-web/dist/' : 'ort/',
  mediapipeUrl: dev ? '/node_modules/@mediapipe/tasks-vision/wasm/' : 'mediapipe/',
  onProgress: (text) => { if (selection.state.mode === 'ai') $('select-msg').textContent = text || aiHint(); },
});
for (const key of aiOffered) $('select-ai-model').append(new Option(`${AI_MODELS[key].name} — ${AI_MODELS[key].about}`, key));
$('select-ai-model').value = ai.model;
$('select-ai-model').onchange = () => {
  ai.setModel($('select-ai-model').value);
  try { localStorage.setItem('mz-ai-model', ai.model); } catch { /* private mode */ }
  selection.setPreview(null);
  if (selection.state.mode === 'ai') aiStart();
};
let aiBoxes = [];
let aiPrompt = { points: [], labels: [], box: null };
let aiClickMs = 0;
const aiTiming = () => `${ai.spec.name} looked in ${(ai.lookMs / 1000).toFixed(1)} s${aiClickMs ? `, the last click took ${Math.round(aiClickMs)} ms` : ''}.`;
const aiHint = () => (ai.spec.kind === 'objects'
  ? (aiBoxes.length ? `Found ${aiBoxes.map((b) => b.label).join(', ')}. ` : 'Found nothing it knows (people, animals, vehicles, furniture… 80 kinds). ') + 'Click an object to outline it in yellow; shift-click one to take it away; '
  : 'Click anything to outline it in yellow; click again to add to it, shift-click where it went too far; ')
  + 'Enter or "keep" adds it to the selection. For anything else, use "trace the edge", "fill a colour" or "refine with a brush". Then use "Only inside the selection". ' + aiTiming();
async function aiStart() {
  aiBoxes = [];
  aiPrompt = { points: [], labels: [], box: null };
  aiClickMs = 0;
  ai.invalidate();
  try {
    await ai.embed();
    aiBoxes = await ai.detect();
    $('select-msg').textContent = aiHint();
  } catch (e) {
    $('select-msg').textContent = e.message;
  }
  selection.draw();
}
async function aiClick(x, y, negative) {
  const w = $('source').width, h = $('source').height;
  if (!aiPrompt.points.length && !negative) {
    const hit = aiBoxes.find((b) => x >= b.box[0] && x <= b.box[2] && y >= b.box[1] && y <= b.box[3]);
    if (hit) aiPrompt.box = hit.box;
  }
  aiPrompt.points.push([x, y]);
  aiPrompt.labels.push(negative ? 0 : 1);
  $('select-msg').textContent = 'Thinking…';
  try {
    const t0 = performance.now();
    selection.setPreview(await ai.mask({ points: aiPrompt.points, labels: aiPrompt.labels, box: aiPrompt.box }));
    aiClickMs = performance.now() - t0;
    $('select-msg').textContent = aiHint();
  } catch (e) {
    $('select-msg').textContent = e.message;
  }
  void w; void h;
}
function aiKeep() {
  if (selection.state.preview) selection.addRaster(selection.state.preview);
  selection.setPreview(null);
  aiPrompt = { points: [], labels: [], box: null };
}
function aiKey(key) {
  if (key === 'Enter') aiKeep();
  else if (key === 'Escape') { selection.setPreview(null); aiPrompt = { points: [], labels: [], box: null }; }
  else if (aiPrompt.points.length) { aiPrompt.points.pop(); aiPrompt.labels.pop(); if (aiPrompt.points.length) aiClick(...aiPrompt.points.pop(), aiPrompt.labels.pop() === 0); else { selection.setPreview(null); aiPrompt.box = null; } }
}
function aiDraw(ctx) {
  if (selection.state.mode !== 'ai') return;
  ctx.font = '11px system-ui, sans-serif';
  for (const { label, box } of aiBoxes) {
    const [x0, y0, x1, y1] = box;
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.5; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    const width = ctx.measureText(label).width + 6;
    ctx.fillStyle = 'rgba(42,111,219,.9)'; ctx.fillRect(x0, y0, width, 14);
    ctx.fillStyle = '#fff'; ctx.fillText(label, x0 + 3, y0 + 11);
  }
  aiPrompt.points.forEach(([x, y], i) => {
    ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, 4, 0, Math.PI * 2);
    ctx.fillStyle = aiPrompt.labels[i] ? '#ffd54f' : '#e03a3a'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
  });
}
selection.setAiHandlers(aiClick, aiKey, aiDraw);
$('select-keep').onclick = aiKeep;

function selectMode(mode) {
  selection.setMode(selection.state.mode === mode ? 'off' : mode);
  const on = selection.state.mode;
  $('select-trace').classList.toggle('on', on === 'trace');
  $('select-fill').classList.toggle('on', on === 'fill');
  $('select-ai').classList.toggle('on', on === 'ai');
  $('select-refine').classList.toggle('on', on === 'refine');
  $('select-refine-row').hidden = on !== 'refine';
  $('select-keep').hidden = on !== 'ai';
  $('select-ai-row').hidden = on !== 'ai' || aiOffered.length < 2;   // one model: nothing to choose
  if (on !== 'off') $('select-panel').open = true;
  if (on === 'ai') aiStart(); else { selection.setPreview(null); aiPrompt = { points: [], labels: [], box: null }; }
  $('select-tol-row').hidden = on !== 'fill';
  $('select-contiguous-row').hidden = on !== 'fill';
  $('select-cool-row').hidden = on !== 'trace';
  $('select-msg').textContent = on === 'trace'
    ? 'Click past the picture\'s edge to run the outline along it. Click a point on the edge of the object, then move along it — the line follows the edge, and the part that stays put behind you is fixed for you (the small blue points). Click where it needs help. Click the first point (or press Enter) to close; drag a point to move it; Backspace removes the last; Esc stops. Then use "Only inside the selection" from the library, or `selected` in your maths.'
    : on === 'fill' ? 'Click a colour to select everything of that colour that touches it; click more colours to add them to the set (the fill grows through any of them). Untick "connected only" to take that colour anywhere. Click a swatch to drop a colour.'
    : on === 'ai' ? 'Loading…'
    : on === 'refine' ? 'Paint over the picture: "inside" where the selection should reach, "outside" where it should not. When you let go, the edge settles on the picture\'s own edges near the stroke; the rest stays. With nothing selected, inside strokes make a selection.' : '';
}
$('select-trace').onclick = () => selectMode('trace');
$('select-fill').onclick = () => selectMode('fill');
$('select-ai').onclick = () => selectMode('ai');
$('select-refine').onclick = () => selectMode('refine');
$('refine-in').onchange = $('refine-out').onchange = () => selection.setRefine({ inside: $('refine-in').checked });
$('refine-size').oninput = () => selection.setRefine({ size: Number($('refine-size').value) });
$('select-clear').onclick = () => { selection.clear(); };
$('select-feather').addEventListener('input', () => selection.setFeather(Number($('select-feather').value)));
$('select-invert').addEventListener('change', () => selection.setInvert($('select-invert').checked));
$('select-tol').addEventListener('input', () => selection.setTolerance(Number($('select-tol').value)));
$('select-contiguous').addEventListener('change', () => selection.setContiguous($('select-contiguous').checked));
$('select-cool').addEventListener('change', () => selection.setCooling($('select-cool').checked));
/** The old one-click export: a PNG at the picture's size (the checker uses it). */
async function exportPng() {
  const r = await exporter.produce('png');
  if (!window.mzDemoNoDownload) download(r.blob, 'filter.png');
  $('export-msg').textContent = `Saved ${r.width} × ${r.height}: ${r.note}`;
}
$('record').onclick = () => {
  if (!window.MediaRecorder || !outCanvas().captureStream) { $('export-msg').textContent = 'This browser cannot record a canvas'; return; }
  const type = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(outCanvas().captureStream(30), { mimeType: type });
  const chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = () => { download(new Blob(chunks, { type }), type.includes('mp4') ? 'filter.mp4' : 'filter.webm'); $('export-msg').textContent = 'Saved'; };
  $('play').checked = true;
  recorder.start();
  $('export-msg').textContent = `Recording 5 s at ${outCanvas().width} × ${outCanvas().height}…`;
  setTimeout(() => recorder.stop(), 5000);
};
(function tick() {
  if (moving && $('play').checked && !video && media.kind !== 'gif') syncT((currentT + 1) % 241);
  requestAnimationFrame(tick);
})();

/**
 * The filtered animation as a GIF, at the preview size (GIF files grow fast).
 * A GIF plays through once with its own frame delays; anything else gets
 * 3 seconds at 15 frames a second, with t moving as it does on screen.
 */
async function saveGif() {
  if (!runner) return;
  const out = outCanvas();
  const w = out.width, h = out.height;
  const scratch = document.createElement('canvas');
  scratch.width = w; scratch.height = h;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  const grab = () => {
    if (track) bindSelection(false);                             // the tracked selection for this frame
    updateStrokes();                                             // the strokes as at this frame
    if (engine === 'cpu') runner.draw({ t: currentT, canvas: scratch });
    else { runner.draw({ t: currentT }); sctx.drawImage($('out'), 0, 0); }
    return sctx.getImageData(0, 0, w, h).data;
  };
  const playing = $('play').checked;
  const wasT = currentT;
  const gif = media.kind === 'gif' ? media.gif : null;
  const wasIndex = media.index;
  const frames = gif
    ? gif.frames.map((f, i) => ({ t: i, delay: f.delay, index: i }))
    : Array.from({ length: 45 }, (_, i) => ({ t: wasT + i * 4, delay: 67 }));     // 60 t a second on screen, 15 frames a second here
  $('play').checked = false;
  clearTimeout(gifTimer);
  gifTimer = null;
  const encoder = GIFEncoder();
  try {
    for (const [n, f] of frames.entries()) {
      $('export-msg').textContent = `Saving GIF… frame ${n + 1} of ${frames.length}`;
      if (gif) {
        media.index = f.index;
        media.source.getContext('2d').putImageData(new ImageData(gif.frames[f.index].data, gif.width, gif.height), 0, 0);
        drawMedia($('source').getContext('2d'), $('source').width, $('source').height);
        runner.setImage($('source'));
      }
      currentT = f.t;
      const rgba = grab();
      const palette = quantize(rgba, 256);
      encoder.writeFrame(applyPalette(rgba, palette), w, h, { palette, delay: f.delay });
      await new Promise((r) => setTimeout(r, 0));
    }
    encoder.finish();
    if (!window.mzDemoNoDownload) download(new Blob([encoder.bytes()], { type: 'image/gif' }), 'filter.gif');
    $('export-msg').textContent = `Saved a ${w} × ${h} GIF, ${frames.length} frames`;
  } finally {
    currentT = wasT;
    $('play').checked = playing;
    if (gif) playGif(gif, wasIndex); else draw();
  }
}
$('gif').onclick = () => saveGif().catch((e) => { $('export-msg').textContent = e.message; });

// ---- the page's panels -------------------------------------------------------
// A folded panel stays as the user left it.
for (const panel of document.querySelectorAll('details[data-remember]')) {
  const key = 'mz-open-' + panel.id;
  try { if (localStorage.getItem(key) !== null) panel.open = localStorage.getItem(key) === '1'; } catch { /* private mode */ }
  panel.addEventListener('toggle', () => { try { localStorage.setItem(key, panel.open ? '1' : '0'); } catch { /* private mode */ } });
}
// Cropping is part of the download options: a drag on the result crops only while they are open.
$('export').addEventListener('toggle', () => document.body.classList.toggle('cropping', $('export').open));
// On a phone the original is hidden until asked for (the result is what matters, and both stacked push the filter far down);
// the panels that draw on the original show it.
{
  const show = (on) => { document.body.classList.toggle('hide-original', !on); $('show-original').setAttribute('aria-pressed', String(on)); $('show-original').textContent = on ? 'hide original' : 'show original'; };
  const drawsOnOriginal = ['select-panel', 'text-section', 'track-section'];
  show(drawsOnOriginal.some((id) => $(id).open));
  $('show-original').onclick = () => show(document.body.classList.contains('hide-original'));
  for (const id of drawsOnOriginal) $(id).addEventListener('toggle', () => { if ($(id).open) show(true); });
}
$('quick-download').onclick = () => exporter.save();
$('quick-link').onclick = async () => {
  try { await navigator.clipboard.writeText(MZ.filterToLink(shareable(), base())); $('export-msg').textContent = ''; toast('Link copied — it carries the filter, not the picture.'); }
  catch { $('export-msg').textContent = 'Copy the address bar: it carries the filter.'; }
};
$('start-over').onclick = async () => {
  if (chain.steps.length && !(await ask('Remove every step? (Save first to keep this filter.)', { title: 'Clear the filter', ok: 'Clear' }))) return;
  chain.steps = [];
  rebuild();
};
$('play-toggle').onclick = () => { $('play').checked = !$('play').checked; playLabel(); if (video) (($('play').checked) ? video.play() : video.pause()); };
const playLabel = () => { $('play-toggle').textContent = $('play').checked ? '❚❚' : '▶'; };

// ---- go --------------------------------------------------------------------
renderLibrary();
renderSaved();
testPicture();
try {
  if (location.hash.length > 1) {
    const shared = MZ.filterFromLink(location.hash);
    loadChain(shared);
    showForkNote(shared);
  } else loadChain({ steps: [byName('Colour circle')] });
} catch (e) {
  showError('The link is not a filter: ' + e.message);
  loadChain({ steps: [byName('Colour circle')] });
}
renderHelp();
renderExamples();
$('help-link').onclick = (e) => { e.preventDefault(); showHelp('pixel'); };
await loadPhotos();

// For scripts driving the page (tests).
window.mzDemo = {
  BUILTIN, loadChain, addStep, draw, slots, gl, exportPng, saveGif, explain, HELP, testPicture, moveStep, rebuild, exporter, selection,
  setGraphic, bindGraphics, showExample, EXAMPLES, updateStrokes, BRUSH_EFFECTS,
  setBrushTarget(target) { brushTarget = target; },
  get track() { return track; }, pauseAt, currentFrame, ensureTrack,
  setT(value) { currentT = value; },
  bindSelection,
  ai: { start: aiStart, click: aiClick, keep: aiKeep, key: aiKey, get boxes() { return aiBoxes; }, model: ai, models: AI_MODELS },
  loadGif: (buffer) => playGif(decodeGif(buffer)),
  gifenc: { GIFEncoder, quantize, applyPalette },
  get media() { return media; },
  get chain() { return chain; }, get compiled() { return compiled; }, get runner() { return runner; }, setOpacity,
  get t() { return currentT; },
  get engine() { return engine; },
  get engineReason() { return engineReason; },
  slotCanvas: (name) => slotFor(name).canvas,
  /** What the GPU drew, rows top down, as RGBA bytes. */
  readOut() {
    const w = $('out').width, h = $('out').height, px = new Uint8Array(4 * w * h), out = new Uint8Array(4 * w * h);
    if (engine === 'cpu') return { data: new Uint8Array($('outCpu').getContext('2d').getImageData(0, 0, w, h).data.buffer), width: w, height: h };
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return { data: out, width: w, height: h };
  },
  stats() {
    const w = $('out').width, h = $('out').height;
    const px = engine === 'cpu' ? $('outCpu').getContext('2d').getImageData(0, 0, w, h).data : new Uint8Array(4 * w * h);
    if (engine !== 'cpu') gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0, lit = 0;
    for (let i = 0; i < px.length; i += 4) { sum += px[i] + px[i + 1] + px[i + 2]; if (px[i] + px[i + 1] + px[i + 2]) lit++; }
    return { mean: +(sum / (w * h * 3)).toFixed(1), lit: +(lit / (w * h)).toFixed(2) };
  },
};
