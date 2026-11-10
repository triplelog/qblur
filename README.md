# qblur

Image filters written as maths — the site is **qblur** (qblur.com). A filter is an expression over a pixel —
`1 - rgb`, `if gray > 0.5 then (1, 0, 0)`, `gaussian(3)`,
`mix(source, rgb, luma(mask))` — or a JSON document with parameters, extra
pictures (masks, overlays) and chains of other people's filters. The
package turns one into WebGL shaders (through MathZetta's GLSL output) and
runs it on a picture.

```js
import { applyFilter, toBlob } from '@mathzetta/qblur/apply';      // one call, and saving: its own entry

const canvas = await applyFilter(img, 'Sepia');                                  // a built-in filter, by name
const sharp = await applyFilter(img, 'Threshold', { params: { cutoff: 0.3 } });  // …with a knob set
const mine = await applyFilter(img, 'if gray > 0.5 then (1, 0, 0) else rgb');    // or maths
const png = await toBlob(mine);                                                  // PNG (JPEG, WebP in a browser)
// pictures over 4096 px on the long side (2048 on the CPU) are scaled down first: { maxSize } changes it
```

```html
<qblur-image src="photo.jpg" filter="Vignette" params='{"strength": 2}' alt="…"></qblur-image>
<script type="module" src="https://cdn.jsdelivr.net/npm/@mathzetta/qblur@0.1/dist/qblur-element.js"></script>
```

For live knobs and video, a runner of your own:

```js
import { compileFilter, createRunner, filterToLink } from '@mathzetta/qblur';

const compiled = compileFilter({ name: 'Old film', params: { strength: 1 }, color: 'gray + strength * 0.1 * sin(py)' });
const { runner } = createRunner(compiled, { gl: canvas.getContext('webgl') });
runner.setImage(img).draw({ t: 0, canvas });
filterToLink(compiled);   // a URL anyone can open
```

Needs `mathzetta` 1.x (a peer dependency: `npm install @mathzetta/qblur mathzetta`). TypeScript types are included.
Three entries: `@mathzetta/qblur` (the filters, the runners, the library), `@mathzetta/qblur/apply` (`applyFilter` and saving) and
`@mathzetta/qblur/element` (`<qblur-image>`).
Saving: `toBlob` (PNG anywhere, JPEG/WebP in a browser) and `encodeGif` (bring
[gifenc](https://www.npmjs.com/package/gifenc): the package has no dependencies of its own). See [CHANGELOG.md](CHANGELOG.md). [docs/library.md](docs/library.md) is how to use the
library on your own pages — the CDN, the builds, the API, with examples that `npm run check:docs` runs.
[docs/filters.md](docs/filters.md) is the full guide to the maths: what an expression can use, animation, neighbourhoods,
geometry, several pictures, sharing and the API.

It runs on the GPU (WebGL) or the CPU (plain JavaScript, also in Node):
`createRunner(compiled, { gl })` uses the GPU whenever WebGL is there (a
filter's shaders compile once, then serve every picture and frame) and the
CPU without it — both give the same pixels. See "Running it" in the guide.

```bash
npm install        # links ../mathzetta/packages/mathzetta (the public repo, checked out beside this one) for development
npm test           # format, compiler, sharing, the CPU runner (pixels, bands, workers, safety) — no browser
npm run serve      # http://localhost:8016/demo/  — the editor and library ("runs on": auto / GPU / CPU)
npm run check      # every library filter through real WebGL in headless Chrome
npm run check:cpu  # …and the CPU runner on the same pictures, compared pixel by pixel
npm run check:nowebgl   # Chrome without WebGL: the editor must fall back to the CPU
npm run build      # site/ — the editor bundled for any static host (no node_modules, no import map)
npm run check:site # build, then run the checks against site/
```

Before building for a real address, set `SITE_URL=https://…/` (or
`"homepage"` in package.json) so pages get absolute canonical, `og:url` and
`og:image` addresses; the preview cards are `demo/share/*.jpg` (`node tools/share-cards.mjs` remakes them).

`site/` is the deployable editor: `index.html`, `app.js` (the page with
MathZetta and this package bundled in), `cpu-worker.js`, `guide.html` (the
guide rendered, heading ids as on GitHub) and `photos/`. Default photos go
in `demo/photos/` with an `index.json` — see the README there.
Serve the folder from anywhere (GitHub Pages, S3, a CDN); share links are
`#…` fragments, so nothing else is needed.

## From a CDN

> Not on npm yet: the addresses below are where releases will be (placeholders until the first one).
> Search for `cdn.jsdelivr.net/npm/@mathzetta/qblur` to find every place they are written: this README,
> docs/library.md (and the site's library.html built from it).

Every npm release's `dist/` is on jsDelivr (and unpkg), MathZetta's GLSL output bundled in —
[docs/library.md](docs/library.md) has working examples of each way in:

```html
<script type="module">
  import { compileFilter, createRunner } from 'https://cdn.jsdelivr.net/npm/@mathzetta/qblur@0.1/dist/qblur.js';
</script>
<!-- or a classic script: window.QBlur -->
<script src="https://cdn.jsdelivr.net/npm/@mathzetta/qblur@0.1/dist/qblur.global.min.js"></script>
```

Every build comes **with MathZetta inside or without it** (`*.external.*`). Sizes as the CDN sends them (compressed):

| | ES module | classic `<script>` (`window.QBlur`) |
|---|---|---|
| everything, MathZetta inside (the classic script: `@mathzetta/qblur/apply` too) | `qblur.js` 54 KB | `qblur.global.min.js` 58 KB |
| `@mathzetta/qblur/apply`: applyFilter and saving, MathZetta inside | `qblur-apply.js` 56 KB | |
| the `<qblur-image>` element (applyFilter and MathZetta inside) | `qblur-element.js` 56 KB | |
| everything, without MathZetta | `qblur.external.js` 26 KB | `qblur.external.global.min.js` 30 KB |
| compile + run on the GPU only (no CPU runner, strokes, graphics, library) | `qblur.core.js` 33 KB | |
| the CPU runner's worker (`drawAsync` on big pictures), found beside the bundle | `cpu-worker.js` 31 KB | |

MathZetta (its GLSL output and the parser) is about half of a full build. Without it, the page
loads MathZetta once itself: a classic page puts a MathZetta `<script>` first — `mathzetta.min.js`
or the `glsl` flavour (GLSL + formulas is what the filters use) — and the external classic build
reads `window.MathZetta`; a module page maps `mathzetta`, `mathzetta/glsl` and `mathzetta/formulas`
to MathZetta's bundle with an import map (every name can point at the one file). The object models and their runtimes (the site's
`models/`, `ort/`) are not in the package: they belong to the editor at qblur.com.
Publishing is `npm publish` (`prepublishOnly` runs the tests and the build).

## Files

| | |
| --- | --- |
| `src/format.js` | the filter document: normalize, validate, compile to passes, JSON and share links |
| `src/runtime.js` | the WebGL runner: textures, passes, live parameters |
| `src/cpu.js` | filter expressions → typed, straight-line JavaScript per pass (through the whitelist gate) |
| `src/cpu-helpers.js` | what that code calls: texture-like sampling, neighbourhood planes (separable, by bands of rows) |
| `src/cpu-runner.js`, `src/cpu-worker.js` | the CPU runner (draw / drawAsync over workers) |
| `src/auto.js` | `createRunner` / `chooseEngine`: GPU or CPU, and why |
| `src/library.js` | `LIBRARY`: the built-in filters, each with a `group` (`GROUPS`); every one validated, compiled and round-tripped by `npm test`. Canny edges is a nine-pass chain of plain expressions |
| `demo/avatar/`, `demo/splash/`, `demo/move/`, `demo/text/` | the small apps: a profile picture (framed on the person, a style, the background blurred, replaced or removed; a circle, a square or a cut-out sticker), a colour splash (click colours to keep), a photo that moves (saved as a GIF or video), fancy text (letters and border each coloured by a formula — gold, chrome, fire, a picture, or your own — as a transparent PNG or a GIF) — a few choices each; `npm run check:apps` |
| `demo/kit.js`, `demo/apps.css` | what the small apps share: open a picture, the sample photos, a filter on the GPU or CPU (`createView`), download, GIF |
| `demo/gif.js` | a GIF decoder (all frames, delays, disposal) so GIFs play and filter frame by frame; `gifenc` (a dev dependency, bundled) writes "Save as GIF" |
| `demo/png.js` | a PNG writer for what the browser's cannot do: indexed (1/2/4/8-bit) when the picture has few colours, RGB when nothing is transparent, forced palettes with dithering |
| `demo/export.js` | the Export panel: format with estimated sizes (auto picks the smallest sensible), quality / colours, size, a crop dragged on the picture, background for JPEG |
| `demo/livewire.js` | selecting an object: intelligent scissors (a cost map from the gradient, Dijkstra once per clicked point, the wire to the cursor walked back in real time, snapping, path cooling) and a colour-fill wand; the mask is `selected` in the maths |
| `src/graphics.js` | text and shapes: `normalizeGraphic` (validation), `drawGraphic` onto any 2D canvas, `loadGraphicFonts`, `renderGraphics(compiled, w, h)` for the runner |
| `tools/shot.mjs` | a screenshot of a page of this repo after running some JavaScript in it (headless Chrome) |
| `src/strokes.js` | brushes: recorded strokes drawn again for every frame (round, soft, marker, chalk, spray; pressure or speed; timing; passes; clip to a mask) into a picture of coverage, age, passes and progress; `traceContours` for outlining a selection |
| `demo/tracker.js` | tracking an object through a clip: patch-matched outline points held to the group's move/scale/turn, a colour model per keyframe so the outline follows the object's edge, a confidence per frame, keyframes propagated both ways |
| `demo/examples.js` | the Examples tour at the top of the editor: each example's filter, picture, features and step-by-step explanation (tested to compile; the checker runs each) |
| `demo/ai.js` | finding objects: MobileSAM on the site (`SHIPPED_MODELS`, run by ONNX Runtime Web in `ort/`; every site file stays under 25 MiB for Cloudflare Pages); in development a menu also offers RF-DETR Small and Nano and MagicTouch 1 and 2 (`demo/models/`, Apache-2.0) to compare; nothing loads until asked |
| `demo/rfdetr.js` | the model's input (stretched, normalized) and its decoding (boxes, labels, outlines); used by the page and by Node (test/ai.test.js) |
| `demo/sam.js` | MobileSAM: the picture scaled for its encoder, the decoder's prompt (points, box), the surest of its masks; used by the page and by Node |
| `tools/export-model.py` | remakes the ONNX models in demo/models/ (RF-DETR Small and Nano, MobileSAM; Python `rfdetr`) |
| `tools/compare-ai.mjs` | every object model on the same things in a photo, drawn side by side with timings (built site, headless Chrome) |
| `demo/app.js` | the editor's script; `tools/build.mjs` bundles it (resolving the page's import map) into `site/` |
| `demo/help.js` | the in-page cheat sheet, and `explain()`: an error → a hint and the help section / guide heading for it |
| `demo/photos/` | default photos (`index.json` lists them); the editor opens on the first |
| `tools/markdown.mjs` | the small Markdown renderer behind `site/guide.html` |
| `demo/index.html` | editor, library, share links; what `npm run check` drives |
| `docs/filters.md` | the guide |

This was `src/filters/` and `demos/filters.html` in MathZetta until
2026-10-16; the GLSL expression output (`toGLSL`, `filterShader`) stayed
there as `mathzetta/glsl`.
