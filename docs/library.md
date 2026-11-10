# qblur on your own pages

qblur is the library behind [the editor](https://qblur.com/): image filters written as maths, compiled to
WebGL shaders, with the same pixels from plain JavaScript where there is no GPU. Put it on any page
with one `<script>` from a CDN — no build step, no server, nothing uploaded: the pictures stay in the
visitor's browser.

> **Not on npm yet.** The CDN addresses below (`cdn.jsdelivr.net/npm/qblur@0.1/…`) are where every
> release will be, and start working with the first one. Until then, `npm run build` in the repository
> writes the same files to `dist/`: serve them yourself and change the address.

## What you can do with it

- **Filters on your pictures, live.** Any `<img>`, `<canvas>`, `<video>` or webcam — sepia, blur,
  comic, tilt-shift, a colour splash, or one of your own in a line of maths: `1 - rgb`,
  `if gray > 0.5 then (1, 0, 0) else rgb`, `mix(rgb, gaussian(4), y)`.
- **Knobs.** A filter declares its parameters (`strength`, `tint`, …) with ranges; your sliders set them
  and the picture redraws at once, without recompiling.
- **79 ready-made filters** in `LIBRARY`, in seven groups (colour and tone, blur and edges, shape and
  motion, text, brushes, other pictures, chains) — use them as they are, chain them, or read their maths.
- **Chains.** Filters run one after another, each with its own settings and opacity; a chain is a filter
  too, so published chains nest and keep their authors' names.
- **Animation.** `t` counts frames: `pixel(px + 8 sin(py / 10 + t / 5), py)` is a wave. On a video, the
  filter runs on every frame.
- **Several pictures.** Masks, overlays, a second photo to blend in, a background for a green screen —
  each placed (cover, fit, tile, zoomed, turned) and set by name.
- **Text and shapes** drawn into the picture and coloured, shadowed, frosted or animated by the maths.
- **Share a filter as a link** or a small JSON document; reading one is safe — a filter is only maths:
  it can read the picture and write colours, nothing else.
- **Save the result** as PNG (in Node too), JPEG, WebP or an animated GIF.
- **GPU or CPU, the same pixels.** WebGL when it is there (fast: the shaders are compiled once), plain
  JavaScript when it isn't — old browsers, locked-down machines, **Node** (thumbnails on a server, tests).

Some things people build with it: filters on upload in a photo or social app; effects on a `<video>` or a
webcam stream; a product page that recolours an item as the customer picks; generative art and
animated backgrounds; previews in a CMS; high-contrast or colour-blindness views for accessibility; a
lesson on how pictures are just numbers. The [small apps](https://qblur.com/avatar/) on qblur.com —
profile picture, colour splash, make it move, fancy text — are each a page of this library and a few
controls.

## Start here

### One line: applyFilter

```html runnable
<img id="photo" src="photo.jpg" alt="" hidden>
<canvas id="out"></canvas>
<script src="https://cdn.jsdelivr.net/npm/qblur@0.1/dist/qblur.global.min.js"></script>
<script>
  const img = document.getElementById('photo');
  img.decode().then(() => QBlur.applyFilter(img, 'Sepia', { canvas: document.getElementById('out') }));
</script>
```

`applyFilter(picture, filter, options)` takes the filter in any form — maths (`'1 - rgb'`), a built-in
filter's name (`'Sepia'`, `'Gaussian blur'`), a filter document, JSON, a share link or a compiled filter —
and resolves with the result at the picture's size: a 2D canvas (yours, given as `canvas`, or a new one) in a
page, `{ data, width, height }` in Node. A picture longer than 4096 px on its long side (2048 on the CPU) is
scaled down to that first, keeping its shape — `maxSize` sets the limit, up to what the GPU can hold. Knobs go in `params` (in a chain, every step with a knob of that
name takes it), the frame in `t`. Calls run one at a time, in the order they were made:

```js
import { applyFilter, toBlob } from 'qblur/apply';        // its own entry; the classic scripts have it on window.QBlur

const canvas = await applyFilter(img, 'Threshold', { params: { cutoff: 0.3 } });
const frame = await applyFilter(video, 'pixel(px + 8 sin(py / 10 + t / 5), py)', { t: 12 });
```

It uses the GPU when WebGL is there and the CPU when it isn't (`engine: 'gpu' | 'cpu'` to choose), keeps
one hidden WebGL canvas for every call, and compiles a filter once for all the calls that use it. For a
picture that redraws many times a second as a knob moves, a runner of your own (below) skips the copy.

### As an HTML element

```html runnable
<qblur-image id="out" src="photo.jpg" filter="Vignette" params='{"strength": 2.5}' alt="A street of coloured houses"></qblur-image>
<script type="module" src="https://cdn.jsdelivr.net/npm/qblur@0.1/dist/qblur-element.js"></script>
```

`<qblur-image>` draws its picture with the filter on it, and again whenever an attribute changes:
`src`, `filter` (any form `applyFilter` takes), `params` (JSON, or set the `params` property to an object: whichever was set last counts),
`t`, `animate` (present: `t` counts up, 30 a second, while the element is in view), `engine`, `alt` and `crossorigin` (as on `<img>`: a
picture from another site must allow CORS). It fires `load` after each drawing and `error` (the Error in
`event.detail`) when the picture or the filter fails; `element.canvas` is the drawing, for
[saving](#saving-the-result). From npm: `import 'qblur/element'`.

### One script tag, a runner of your own

```html runnable
<img id="photo" src="photo.jpg" alt="">
<canvas id="out"></canvas>
<script src="https://cdn.jsdelivr.net/npm/qblur@0.1/dist/qblur.global.min.js"></script>
<script>
  const img = document.getElementById('photo'), canvas = document.getElementById('out');
  img.decode().then(() => {
    canvas.width = img.naturalWidth;                   // the result is the canvas's size: make it the picture's
    canvas.height = img.naturalHeight;
    const compiled = QBlur.compileFilter('1 - rgb');   // a filter: here, one line of maths
    const { runner } = QBlur.createRunner(compiled, { gl: canvas.getContext('webgl') });
    runner.setImage(img).draw({ canvas });             // the GPU draws on gl's canvas; without WebGL, the CPU draws on `canvas`
  });
</script>
```

The classic build puts everything on `window.QBlur`. `createRunner` picks the GPU when the canvas gives
a WebGL context and the CPU when it doesn't; pass the same canvas to `draw` either way.

### An ES module, a library filter and a slider

```html runnable
<canvas id="out"></canvas>
<label>Vignette <input id="strength" type="range" min="0" max="4" step="0.01" value="1.6"></label>
<script type="module">
  import { compileFilter, createRunner, LIBRARY } from 'https://cdn.jsdelivr.net/npm/qblur@0.1/dist/qblur.js';

  const img = new Image();
  img.src = 'photo.jpg';
  await img.decode();
  const canvas = document.getElementById('out');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  const byName = (name) => LIBRARY.find((f) => f.name === name);
  const compiled = compileFilter({ steps: [byName('Sepia'), byName('Vignette')] });   // a chain of two
  const { runner } = createRunner(compiled, { gl: canvas.getContext('webgl') });
  runner.setImage(img).draw({ canvas });

  // knobs change live: set the value on every pass that has it, and draw again (no recompiling)
  document.getElementById('strength').oninput = (e) => {
    for (const pass of runner.passes) if ('strength' in pass.params) pass.values.strength = Number(e.target.value);
    runner.draw({ canvas });
  };
</script>
```

### From npm

```bash
npm install qblur mathzetta        # mathzetta is a peer dependency: qblur uses its maths parser and GLSL output
```

```js
import { compileFilter, createRunner } from 'qblur';      // the filters, the runners, the library
import { applyFilter, toBlob } from 'qblur/apply';        // one call, and saving
import 'qblur/element';                                   // defines <qblur-image>
```

A bundler (Vite, esbuild, webpack, rollup) handles the rest. TypeScript types come with the package (`src/index.d.ts`, `src/apply.d.ts`, `src/element.d.ts`). In Node the CPU runner works as it is (see
[In Node](#in-node)).

### Which file

Every release has these in `dist/` (sizes compressed, as the CDN sends them):

| File | Size | What |
| --- | --- | --- |
| `qblur.js` | 54 KB | ES module, everything but `qblur/apply`, MathZetta inside |
| `qblur.global.min.js` | 58 KB | a classic script: `window.QBlur`, everything — `applyFilter` and saving too |
| `qblur-apply.js` | 56 KB | ES module: `qblur/apply` (`applyFilter`, `toBlob`, `encodeGif`…), MathZetta inside |
| `qblur.core.js` | 33 KB | compile and run on the GPU only: `compileFilter`, `createFilterRunner`, `readFilter`, `filterToLink`, `normalizeFilter` — no CPU runner, library, text or brushes |
| `qblur.external.js` | 26 KB | `qblur.js` with MathZetta left out: the page provides it (an import map) |
| `qblur.external.global.min.js` | 30 KB | `qblur.global.min.js` without MathZetta: reads `window.MathZetta`, so a MathZetta script goes first |
| `qblur-element.js` | 56 KB | `<qblur-image>`, with `applyFilter` and MathZetta inside |
| `cpu-worker.js` | 31 KB | the CPU runner's helper for big pictures (`drawAsync`), loaded only when used; it must sit beside the bundle (it does on the CDN) |

MathZetta is about half of a full build. A page that already uses MathZetta, or several libraries built on
it, loads it once and takes the `external` build. With modules, an import map points every MathZetta name
at one file:

```html runnable
<canvas id="out"></canvas>
<script type="importmap">
{ "imports": {
    "mathzetta": "https://cdn.jsdelivr.net/npm/mathzetta@1/build/mathzetta.esm.min.js",
    "mathzetta/glsl": "https://cdn.jsdelivr.net/npm/mathzetta@1/build/mathzetta.esm.min.js",
    "mathzetta/formulas": "https://cdn.jsdelivr.net/npm/mathzetta@1/build/mathzetta.esm.min.js"
} }
</script>
<script type="module">
  import { compileFilter, createRunner } from 'https://cdn.jsdelivr.net/npm/qblur@0.1/dist/qblur.external.js';
  const img = new Image();
  img.src = 'photo.jpg';
  await img.decode();
  const canvas = document.getElementById('out');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const { runner } = createRunner(compileFilter('(gray, gray, gray)'), { gl: canvas.getContext('webgl') });
  runner.setImage(img).draw({ canvas });
</script>
```

With classic scripts: `<script src="…/mathzetta@1/build/mathzetta.glsl.min.js">` (the GLSL flavour, which
is what filters use) and then `…/qblur@0.1/dist/qblur.external.global.min.js`.

Pin a version (`@0.1` follows fixes, `@0.1.0` never changes) and, for a fixed version, add an `integrity`
hash so the browser checks the file: `npm run cdn` in the repository prints the snippets with hashes.

## Filters

A filter is maths run on every pixel. The [guide](filters.md) is the full language — what an expression
can use, animation, neighbouring pixels, geometry, several pictures, colour spaces, text and brushes. In
short: `r g b a` (or `rgb`) is the pixel, `x y` its position from 0 to 1, `px py` in pixels, `w h` the
picture's size, `t` the frame, `gray` its brightness, `source` the original picture, and
`pixel(px, py)` reads another pixel. The result is a colour `(r, g, b)` or a number (grey).

What you pass to `compileFilter`:

```js
compileFilter('1 - rgb');                                    // an expression
compileFilter({                                              // a filter document
  name: 'Threshold', author: 'Ada', description: 'Black or white',
  params: { cutoff: { default: 0.5, min: 0, max: 1 } },      // a knob
  color: 'if gray > cutoff then 1 else 0',
});
compileFilter({                                              // a chain: steps run top to bottom
  name: 'Old photo',
  steps: [
    LIBRARY.find((f) => f.name === 'Sepia'),                 // a filter as it is
    { filter: LIBRARY.find((f) => f.name === 'Vignette'), with: { strength: 1.2 } },   // with its knob set
    { filter: 'rgb * 1.1', opacity: 0.5 },                   // half strength
    { filter: 'gaussian(2)', skip: true },                   // left out for now
  ],
});
```

The fields of a filter document:

| Field | What |
| --- | --- |
| `format` | `"mathzetta-filter/1"` — optional when writing one; `filterToJSON` adds it. The format is frozen: later versions add, never change |
| `name`, `author`, `description` | shown in credits and the editor's library |
| `params` | knobs: `{ name: { default, min, max, step?, label? } }`; a colour is `[r, g, b]` (0–1) or `{ type: 'color', default: [r, g, b] }`; a bare number is a default |
| `color` | the maths: a string, or by channel — `{ rgb: '…', a: '…' }`, `{ r, g, b, a }`, `{ rgba: '…' }` |
| `space` | the colour space the maths works in: `'hsv'`, `'hsl'`, `'lab'`, `'oklab'`, `'linear'`, `'ycbcr'`, or `{ in, out }` |
| `images` | other pictures it reads, by name: `{ mask: { description: 'light where the effect shows' } }` |
| `graphics` | text, rectangles, ovals or brush strokes drawn into pictures it reads ([Text and shapes](#text-and-shapes)) |
| `steps` | a chain instead of `color`: each step a filter (or an expression), with `with`, `opacity` and `skip` |

## Running a filter

### compileFilter

```js
const compiled = compileFilter(def, { version: 100 });    // 100: WebGL 1 (the default); 300: WebGL 2
compiled.passes;      // one shader pass per filter in the chain, in order; each has params, values, images, placements
compiled.images;      // every picture it needs, by name
compiled.graphics;    // every graphic, by name
compiled.credits;     // [{ name: 'Sepia', author: '' }, …] — the filters it is made of
```

It throws when the filter is malformed or its maths doesn't parse:
`the filter: Failed to parse expression "rgb * (1, 2": …`. A name the maths doesn't know (`rgb * nope`) is
found when a runner is made: `unknown name "nope"`. `validateFilter(def)` lists every problem with the
document itself, as messages naming the filter (`"Vignette": "with" sets "nope", but there is no parameter
called that`), without throwing.

### createRunner: the GPU, or the CPU

```js
const { runner, engine, reason } = createRunner(compiled, {
  gl: canvas.getContext('webgl'),   // null or missing: the CPU
  prefer: 'auto',                   // 'gpu' or 'cpu' to insist
  precision: 'byte',                // 'half' or 'float' keeps values over 1 between passes (bloom, edges)
});
engine;   // 'gpu' or 'cpu'
reason;   // why: 'WebGL is here', 'no WebGL here', 'the GPU refused the shader (…)', 'asked for the CPU'
```

Both runners have the same methods:

| | |
| --- | --- |
| `runner.setImage(picture)` | the picture to filter: `<img>`, `<canvas>`, `<video>`, `ImageData`, `ImageBitmap`, or `{ data, width, height }`. Call it again for each new picture or video frame. Returns the runner |
| `runner.setImage(name, picture)` | another picture the filter names (`compiled.images`, graphics) |
| `runner.draw({ t, canvas })` | runs every pass. The GPU draws on the canvas `gl` belongs to; the CPU draws on `canvas` when given, and returns `{ data, width, height }` (RGBA bytes) |
| `runner.passes` | `compiled.passes`, live: `passes[i].values.cutoff = 0.3`, then `draw()` |
| `runner.dispose()` | frees the textures and programs (or the CPU's workers) |

The output is the canvas's size (GPU) or the picture's size (CPU), and the picture is stretched to it — so
**size the canvas to the picture**, or to the size you want to save.

### On the GPU: createFilterRunner

```js
const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false });
const runner = createFilterRunner(gl, compiled, { precision: 'half' });
runner.precision;     // what the GPU gave: 'byte', 'half' or 'float'
```

- `preserveDrawingBuffer: true` keeps the result on the canvas after the frame, so `canvas.toBlob()` can save
  it later (otherwise call it straight after `draw()`).
- `premultipliedAlpha: false` keeps transparent results (`a` below 1) as they are.
- WebGL 2: `canvas.getContext('webgl2')` and `compileFilter(def, { version: 300 })`.
- The browser can take the context away (a GPU reset, a sleeping laptop): listen for `webglcontextlost`
  (call `preventDefault()`), and on `webglcontextrestored` make a new runner.
- Pictures from another site need `img.crossOrigin = 'anonymous'` **and** that site's CORS header, or WebGL
  refuses them (the same rule as reading a canvas's pixels).

### On the CPU: createCpuRunner

```js
const runner = createCpuRunner(compiled, { precision: 'byte', workers: 'auto', parallelFrom: 250000 });
const out = runner.setImage(img).draw({ t: 0, canvas });         // on this thread
const out2 = await runner.drawAsync({ t: 0, canvas });           // big pictures: rows shared among workers
```

`drawAsync` splits each pass's rows among workers (`cpu-worker.js` beside the bundle — on the CDN it is;
`workerUrl` puts it elsewhere) when the picture has at least `parallelFrom` pixels, and draws on the calling
thread when it doesn't or when workers can't start. Both give the same pixels, and the same as the GPU.

### In Node

The CPU runner needs no browser:

```js node
import { compileFilter, createCpuRunner, LIBRARY } from 'qblur';

// a 64 × 64 picture as RGBA bytes — in practice, decoded from a file (sharp, pngjs, …)
const width = 64, height = 64, data = new Uint8ClampedArray(width * height * 4);
for (let i = 0; i < width * height; i++) data.set([(i % width) * 4, 120, 200, 255], i * 4);

const sepia = LIBRARY.find((f) => f.name === 'Sepia');
const runner = createCpuRunner(compileFilter(sepia));
const out = runner.setImage({ data, width, height }).draw();
console.log(out.width, out.height, out.data.slice(0, 4));    // 64 64 Uint8ClampedArray [ … ]
```

With [sharp](https://sharp.pixelplumbing.com/) for the files:

```js
const { data, info } = await sharp('in.jpg').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const out = createCpuRunner(compileFilter('1 - rgb')).setImage({ data: new Uint8ClampedArray(data), width: info.width, height: info.height }).draw();
await sharp(Buffer.from(out.data), { raw: { width: out.width, height: out.height, channels: 4 } }).toFile('out.png');
```

## Knobs

`filterParams(normalizeFilter(def))` lists every knob a filter or chain has —
`{ strength: { type: 'number', default: 1.6, min: 0, max: 4 } }`, colours as `{ type: 'color', default: [r, g, b] }` —
so a page can build its controls from the filter:

```html runnable
<canvas id="out"></canvas>
<form id="knobs"></form>
<script type="module">
  import { compileFilter, createRunner, normalizeFilter, filterParams } from 'https://cdn.jsdelivr.net/npm/qblur@0.1/dist/qblur.js';

  const def = {
    name: 'Duotone',
    params: { dark: [0.1, 0.05, 0.3], light: [1, 0.8, 0.4], contrast: { default: 1, min: 0.5, max: 2, label: 'Contrast' } },
    color: 'mix(dark, light, clamp((gray - 0.5) contrast + 0.5, 0, 1))',
  };
  const img = new Image();
  img.src = 'photo.jpg';
  await img.decode();
  const canvas = document.getElementById('out');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const { runner } = createRunner(compileFilter(def), { gl: canvas.getContext('webgl') });
  runner.setImage(img).draw({ canvas });

  const set = (name, value) => {
    for (const pass of runner.passes) if (name in pass.params) pass.values[name] = value;
    runner.draw({ canvas });
  };
  const hex = (rgb) => '#' + rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  for (const [name, p] of Object.entries(filterParams(normalizeFilter(def)))) {
    const input = document.createElement('input');
    if (p.type === 'color') { input.type = 'color'; input.value = hex(p.default); input.oninput = () => set(name, rgb(input.value)); }
    else Object.assign(input, { type: 'range', min: p.min, max: p.max, step: p.step ?? (p.max - p.min) / 200, value: p.default, oninput: () => set(name, Number(input.value)) });
    const label = document.createElement('label');
    label.append(p.label ?? name, ' ', input);
    document.getElementById('knobs').append(label);
  }
</script>
```

In a chain, `filterParams` gives each knob's own default; the values a chain sets with `with` are in
`compiled.passes[i].values`.

## Animation, video and the webcam

`t` is whatever you pass to `draw`. Count frames for an animation:

```html runnable
<canvas id="out"></canvas>
<script type="module">
  import { compileFilter, createRunner } from 'https://cdn.jsdelivr.net/npm/qblur@0.1/dist/qblur.js';
  const img = new Image();
  img.src = 'photo.jpg';
  await img.decode();
  const canvas = document.getElementById('out');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const { runner } = createRunner(compileFilter('pixel(px + 6 sin(py / 12 + t / 5), py)'), { gl: canvas.getContext('webgl') });
  runner.setImage(img);                           // a still picture: set it once
  let t = 0;
  (function frame() { runner.draw({ t: t++, canvas }); requestAnimationFrame(frame); })();
</script>
```

A video is a picture that changes: give the runner each frame.

```html runnable
<video id="clip" src="clip.mp4" muted loop playsinline autoplay hidden></video>
<canvas id="out"></canvas>
<script type="module">
  import { compileFilter, createRunner } from 'https://cdn.jsdelivr.net/npm/qblur@0.1/dist/qblur.js';
  const video = document.getElementById('clip'), canvas = document.getElementById('out');
  await new Promise((r) => { video.onloadeddata = r; if (video.readyState >= 2) r(); });
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const { runner } = createRunner(compileFilter('(red(px + 6, py), g, blue(px - 6, py))'), { gl: canvas.getContext('webgl') });
  let t = 0;
  const frame = () => {
    runner.setImage(video).draw({ t: t++, canvas });
    video.requestVideoFrameCallback ? video.requestVideoFrameCallback(frame) : requestAnimationFrame(frame);
  };
  frame();
</script>
```

The webcam is the same with `video.srcObject = await navigator.mediaDevices.getUserMedia({ video: true })`.
To save what is shown as a video: `new MediaRecorder(canvas.captureStream(30))`.

## Other pictures: masks, overlays, backgrounds

A filter names the pictures it reads in `images`; the maths uses them by name — `mask` is its colour at
this pixel, `luma(mask)` its brightness, `alpha(mask)` its transparency — and you give them with
`setImage(name, picture)`. A picture not given is white.

```html runnable
<canvas id="out"></canvas>
<script type="module">
  import { compileFilter, createRunner, LIBRARY } from 'https://cdn.jsdelivr.net/npm/qblur@0.1/dist/qblur.js';
  const img = new Image();
  img.src = 'photo.jpg';
  await img.decode();
  const canvas = document.getElementById('out');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  // a spotlight mask: light in the middle, dark at the edges
  const mask = Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  const g = mask.getContext('2d'), grad = g.createRadialGradient(128, 128, 20, 128, 128, 128);
  grad.addColorStop(0, '#fff'); grad.addColorStop(1, '#000');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);

  // grey everywhere, colour where the mask is light ("Through a mask" is mix(source, rgb, luma(mask)))
  const byName = (name) => LIBRARY.find((f) => f.name === name);
  const { runner } = createRunner(compileFilter({ steps: [byName('Grayscale'), byName('Through a mask')] }), { gl: canvas.getContext('webgl') });
  runner.setImage(img).setImage('mask', mask).draw({ canvas });
</script>
```

A picture of another shape is placed over the frame: `cover` (the default), `fit`, `stretch` or `tile`,
with `zoom`, `x`, `y` and `angle` — set per step (`{ filter, with: { overlay: { place: 'fit', zoom: 0.5 } } }`)
or live (`runner.passes[i].placements.overlay.x = 0.2`; changing `place` needs a new compile).
`selected` is the picture named `selection` (the editor's selection): give it a mask to limit a filter to
part of the picture.

## Text and shapes

A filter's `graphics` are drawn into pictures of the frame's size, which the maths reads like any other
picture. `renderGraphics` draws them (loading web fonts first); positions and sizes are fractions of the
frame, so they are crisp at any size.

```html runnable
<canvas id="out"></canvas>
<script type="module">
  import { compileFilter, createRunner, renderGraphics } from 'https://cdn.jsdelivr.net/npm/qblur@0.1/dist/qblur.js';
  const img = new Image();
  img.src = 'photo.jpg';
  await img.decode();
  const canvas = document.getElementById('out');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  const compiled = compileFilter({
    graphics: { title: { type: 'text', text: 'Hello!', size: 0.16, y: 0.5, color: '#ffd23f' } },
    color: 'mix(rgb * 0.6, title, alpha(title))',        // the picture darkened, the words laid on it
  });
  const { runner } = createRunner(compiled, { gl: canvas.getContext('webgl') });
  runner.setImage(img);
  for (const [key, picture] of Object.entries(await renderGraphics(compiled, canvas.width, canvas.height))) runner.setImage(key, picture);
  runner.draw({ canvas });
</script>
```

Text has `text`, `font` (a CSS family, or `fontUrl` for a web font), `weight`, `style`, `size`, `x`, `y`,
`align`, `angle`, `color`, `outline` and shadows; `rect` and `ellipse` have `x`, `y` (the centre), `w`, `h`,
`angle`, `color`, `outline` and shadows, and a rectangle a corner `radius`. Brush strokes (`type: 'strokes'`) are recorded drawings that play out over `t`; draw them
for each frame with `renderGraphics(compiled, w, h, { t })` or `rasterizeStrokes`. The guide's
"Text and shapes" and "Brushes" have every field.

## Saving the result

```js
const png = await toBlob(canvas);                                    // a PNG: indexed when there are ≤ 256 colours, RGB when opaque
const jpeg = await toBlob(canvas, { type: 'image/jpeg', quality: 0.9 });   // JPEG and WebP: the browser's encoder
const { data, width, height } = cpuRunner.draw();                    // CPU: the bytes themselves
```

`toBlob` takes a 2D canvas (what `applyFilter` returns) or a picture `{ data, width, height }`, and writes
PNG itself, so it works in Node as well; JPEG and WebP need a browser. A WebGL canvas can't be read back
with a 2D context: pass the canvas `applyFilter` gave you, or call the canvas's own `toBlob` right after
`draw()` (or create the context with `preserveDrawingBuffer: true`).

An animated GIF needs a colour quantizer and an LZW encoder. The package has no dependencies, so bring
[gifenc](https://www.npmjs.com/package/gifenc) (`npm i gifenc`, 9 KB) and pass it in:

```js node
import * as gifenc from 'gifenc';
import { applyFilter, encodeGif, toBlob } from 'qblur/apply';

const picture = { width: 64, height: 48, data: new Uint8ClampedArray(64 * 48 * 4).fill(200) };
const frames = [];
for (let t = 0; t < 10; t++) frames.push(await applyFilter(picture, '(x, y, 0.5 + 0.5 sin(t / 2))', { t }));
const gif = await encodeGif(frames, { gifenc, delay: 50 });          // 50 ms a frame, looping
const png = await toBlob(frames[0]);                                 // PNG in Node: no canvas needed
console.log(gif.type, gif.size, png.type);
```

Frames can be canvases or pictures, all one size, in an array or an async iterable (each frame drawn as it
is needed); `repeat: -1` plays once. To save at a different size than you show, draw into a second canvas
of that size, or with the CPU runner on a picture of that size.

## Sharing filters

```js
const link = filterToLink(def, 'https://qblur.com/');   // https://qblur.com/#eyJmb3Jt… — opens in the editor
const json = filterToJSON(def);                          // the document, defaults left out
readFilter(text);                                        // whatever was pasted: a link, JSON, or an expression
filterFromLink(location.hash);                           // a filter from your own page's address
validateFilter(readFilter(text));                        // [] when it is fine
```

A filter from someone else is safe to run: it is maths over the picture, compiled by qblur into shaders (or
checked JavaScript on the CPU), with no access to the page, the network or anything else. One thing does reach
the network: a filter with text may name a font (a Google Fonts family or an https address), which the page
then fetches to draw it — so whoever serves that font sees the request.

## The built-in library

`LIBRARY` is an array of filter documents (79), each with a `group` from `GROUPS`:

```js
GROUPS;                                                  // ['Colour & tone', 'Blur & edges', 'Shape & motion', 'Text & shapes', 'Brushes', 'Other pictures', 'Chains']
LIBRARY.filter((f) => f.group === 'Blur & edges').map((f) => f.name);
const comic = LIBRARY.find((f) => f.name === 'Comic');   // a chain of four
```

The editor's [library](https://qblur.com/) shows them all on your own photo, with their maths.

## Reference

Everything the package exports — from `qblur/apply`, the first seven; from `qblur/element`, `QBlurImage`; from
`qblur`, the rest:

| Export | What |
| --- | --- |
| `applyFilter(picture, filter, { params, t, images, engine, canvas, maxSize })` | the one call: the filtered picture (a 2D canvas, or `{ data, width, height }` in Node), at most `maxSize` on its long side; the filter in any form, or a `LIBRARY` name |
| `MAX_SIZE`, `MAX_SIZE_CPU` | the default `maxSize`: 4096 on the GPU, 2048 on the CPU |
| `toCompiled(filter)` | any form `applyFilter` takes → the compiled filter |
| `toBlob(canvasOrPicture, { type, quality, palette })` | the result as a file: PNG anywhere, JPEG and WebP in a browser |
| `encodeGif(frames, { gifenc, delay, repeat, colours })` | an animated GIF, with gifenc passed in |
| `encodePng({ width, height, data, palette, colours, quantize })` | the PNG writer `toBlob` uses (indexed, RGB or RGBA) |
| `pictureData(canvasOrPicture)` | its RGBA bytes |
| `QBlurImage` (from `qblur/element`) | the `<qblur-image>` element's class; importing the entry defines the element |
| `compileFilter(def, { version })` | a filter (expression, document or chain) → `{ passes, images, graphics, credits, … }`; throws on a malformed filter or maths that doesn't parse |
| `createRunner(compiled, { gl, prefer, precision, workers })` | `{ runner, engine, reason }`: the GPU when `gl` is a WebGL context, else the CPU |
| `createFilterRunner(gl, compiled, { precision })` | the WebGL runner |
| `createCpuRunner(compiled, { precision, workers, parallelFrom, workerUrl })` | the JavaScript runner (browsers and Node); `draw()` and `drawAsync()` |
| `chooseEngine({ webgl, prefer })` | which runner `createRunner` would use, and why |
| `toPicture(image)` | any picture as `{ data: Float32Array, width, height }` (what the CPU works on) |
| `normalizeFilter(def)` | the full form: types and ranges on params, `with` and `opacity` on steps; throws on a bad shape |
| `validateFilter(def)` | every problem, as messages naming the filter; `[]` when it will compile |
| `filterParams(filter)` / `filterImages(filter)` / `filterGraphics(filter)` | a normalized filter's knobs, pictures, graphics (a chain's included) |
| `filterToJSON(def)` / `filterFromJSON(text)` | the document as JSON, and back |
| `filterToLink(def, pageUrl)` / `filterFromLink(text)` | the filter in a URL's `#…`, and back |
| `readFilter(text)` | a link, JSON or a bare expression → a filter |
| `FILTER_FORMAT`, `PLACEMENT` | `'mathzetta-filter/1'`; the default placement `{ place: 'cover', zoom: 1, x: 0.5, y: 0.5, angle: 0 }` |
| `LIBRARY`, `GROUPS` | the built-in filters and their groups |
| `renderGraphics(compiled, w, h, { t, mask })` | every graphic drawn at w × h → `{ key: picture }` for `setImage` |
| `normalizeGraphic`, `drawGraphic(ctx, spec, w, h)`, `loadGraphicFonts`, `cssFont`, `GRAPHIC_TYPES`, `GRAPHIC_DEFAULTS` | text and shapes, one at a time |
| `googleFontUrl(family)`, `googleFontFamily(url)`, `fontFileFromCss`, `familyFor` | web fonts for text graphics |
| `shadowLayerNames`, `layeredExpression`, `MAX_SHADOW_LAYERS` | text shadows as pictures of their own |
| `normalizeStrokes`, `strokeTimeline`, `rasterizeStrokes(spec, w, h, t, { mask })` | brush strokes, frame by frame |
| `BRUSHES`, `TIMINGS`, `WIDTH_FROM`, `CLIPS`, `FPS`, `STROKES_DEFAULTS` | brush options |
| `traceContours(mask, w, h)`, `simplify`, `simplifyLoop` | the outlines of a mask, as polylines |
| `compileCpuPass(pass)` | one pass as checked JavaScript (what the CPU runner runs; `.uses` says if it reads `t`, other pictures, `random`) |

## Good to know

- **Sizes in pixels stay pixels.** `gaussian(4)` blurs 4 pixels whatever the picture's size, so effects look
  finer on a bigger picture; scale such numbers with `w` or `h` (`gaussian(w / 200)`) to keep a look at any size.
- **Between passes the picture is 8-bit**, as an image is: values clamp to 0–1. `precision: 'half'` keeps
  more where the effect needs it (bloom, edge strengths).
- **Big pictures.** WebGL limits a texture to `gl.getParameter(gl.MAX_TEXTURE_SIZE)` (often 4096 or more);
  the CPU has no limit but takes longer — `drawAsync` uses every core.
- **Licence.** MIT. The object models used by the editor's "find objects" are not in the package.
