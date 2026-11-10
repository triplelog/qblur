# Changelog

## 0.1.0 — first release

The filter format, its compiler and two runners that give the same pixels.

- **The format, `mathzetta-filter/1`** (frozen: later versions add, never change or remove): a filter is
  maths over a pixel, or a JSON document with a name, an author, knobs (`params`: numbers, colours, menus,
  boxes), notes, other pictures (`images`, each placed), text and shapes and brush strokes (`graphics`), a
  colour space, or `steps` — a chain of other filters with their own settings and opacity, which nests and
  keeps its authors' names. `normalizeFilter`, `validateFilter`, `compileFilter`; sharing as JSON or a link
  (`filterToJSON`, `filterToLink`, `readFilter`). A filter is only maths: running someone else's is safe (a text's font, if it names one, is fetched).
- **`applyFilter(picture, filter, { params, t, images, engine, canvas, maxSize })`** (`qblur/apply`, `dist/qblur-apply.js`): the one call — a filter in any
  form (maths, a document, JSON, a link, a compiled filter, or a built-in filter's name) on an `<img>`,
  `<video>`, canvas, ImageData or `{ data, width, height }`; a 2D canvas back in a page, the picture in Node. Pictures over 4096 px on the long side (2048 on the CPU)
  are scaled down first; `maxSize` sets the limit.
- **`<qblur-image>`** (`qblur/element`, `dist/qblur-element.js`): a picture with a filter on it as an HTML
  element; attributes `src`, `filter`, `params`, `t`, `animate`, `engine`, `alt`, `crossorigin`.
- **Runners**: WebGL 1 and 2 (`createFilterRunner`; 8-bit, half or float textures between passes) and plain
  JavaScript (`createCpuRunner`; browsers and Node, `drawAsync` over workers for big pictures, generated
  code checked before it runs); `createRunner` picks the GPU when it can.
- **Saving**: `toBlob` (PNG written by the package — indexed when there are few colours — so it works in
  Node; JPEG and WebP in a browser), `encodeGif` (with gifenc passed in), `encodePng` — in `qblur/apply`.
- **79 built-in filters** in `LIBRARY`, in seven `GROUPS`.
- **Text, shapes and brush strokes** drawn into frame-sized pictures (`renderGraphics`, `rasterizeStrokes`),
  with web fonts and separate shadow layers.
- **Builds** on jsDelivr/unpkg: an ES module and a classic script, each with MathZetta inside or without
  it, a GPU-only core, the element, and the CPU worker. TypeScript declarations for the package and the
  element. MIT; no dependencies (MathZetta 1.x is a peer).
