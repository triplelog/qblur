# Changelog

## Unreleased

- The CPU runner reads what the next MathZetta's shaders read: `arcsec`, `arccsc` and `arccot` (as `acos(1/x)`,
  `asin(1/x)` and `π/2 − atan x`), degrees (`30°`, which the GPU already took and the CPU called an unknown name),
  and evaluation bars (`\left[F\right]_a^b`, F at b minus F at a).
- …and `⇒` / `⇔` (`\Rightarrow`, `\iff`), and membership in set-builder notation (`r \in \{x \mid x > 0.4\}`).
- The site (not the package): the editor has its own page, `editor.html`, laid out as a dashboard — the pictures on a
  stage that takes the room the window has (Result / Both / Original, **Expand** over the whole window, a sharper
  preview: up to 960 × 720, or 1440 × 1080 when asked), beside the controls as tabs. The home page is now one small
  example that opens in the editor; a filter's old link (`qblur.com/#…`) is sent on to the editor.
- The site: writing filters has its own page, `filters.html` (the steps' maths, knobs and notes, a smaller preview,
  saving, importing, the library and the cheat sheet), and the editor is for using them: choose one (saved or from
  the library), tune its knobs, select and draw, download — "Edit this filter" and "Use it in the editor" carry the
  filter (and the sample picture) between the two. Both pages are the same editor (`demo/app.js`, `data-mode`);
  `filters.html` is made from `editor.html` by `tools/filters-page.mjs`. They have no sidebar column (the site's nav is
  a bar across the top), so the pictures get the width. **Expand** fills the window again (the pictures were held to
  the 200 px minimum: an expanded stage's height was counted as its bars). The home page's example takes your own photo
  or video (or a file dropped on it), and Download saves a photo's result. New branding: the logo in the sidebar and
  on the link-preview cards, new icons; the profile-picture sample is a photo now, not a painting.

## 0.1.2

Fixes from a review before this release. Needs MathZetta 1.2 (the peer range is `^1.2.0`).

- **The CPU gives the shader's pixels again.** `round` takes a half away from zero (`round(-2.5)` is −3, as
  MathZetta 1.2's shaders round), and `50%` is 0.5 on the CPU too (it was "unknown name").
- **Names every object has are ordinary names.** A knob, picture or graphic called `constructor`, `toString` or
  `valueOf` works (a knob so named had the value NaN, and a picture was refused); an unknown name or function
  so called is refused as unknown, not by a later error.
- **Text is not maths.** A quoted string in a filter is refused on the GPU as it was on the CPU (it was
  written into the shader, which then failed to compile).
- **A filter built to stall the page is stopped.** At most 256 passes and 64 graphics; brush strokes stop
  painting after a few hundred frames' worth of work in one call (a point far outside the frame, or the
  largest brush crossing it thousands of times, froze the page for minutes); a very long `options` list no
  longer overflows the stack.
- **`drawAsync`:** calls made before the workers are up share one pool (two pools were started, one was never
  closed, and a call could fail); `dispose()` during a draw ends that draw with an error instead of leaving
  it waiting for ever; a picture is copied to shared memory once, not on every draw.
- **WebGL:** shaders are freed once their program is linked, and when a pass does not compile the passes
  compiled before it are freed too (each filter left two shader objects per pass behind).
- A font's CSS is fetched without cookies or a referrer. `encodePng` refuses a size that isn't whole pixels
  or data too short for it.
- More npm keywords (image-processing, canvas, gif, web-component …).

## 0.1.1

No change to the code. The licence names its holder (`Copyright (c) 2025-2026 Robert Wilcox`; 0.1.0's said
"MathZetta Contributors"), and every bundle's banner says whose it is and its licence, MathZetta's too.
The README has a Licence section, and it and docs/library.md no longer say the package isn't on npm yet.
## 0.1.0 — first release

The filter format, its compiler and two runners that give the same pixels.

- **The format, `mathzetta-filter/1`** (frozen: later versions add, never change or remove): a filter is
  maths over a pixel, or a JSON document with a name, an author, knobs (`params`: numbers, colours, menus,
  boxes), notes, other pictures (`images`, each placed), text and shapes and brush strokes (`graphics`), a
  colour space, or `steps` — a chain of other filters with their own settings and opacity, which nests and
  keeps its authors' names. `normalizeFilter`, `validateFilter`, `compileFilter`; sharing as JSON or a link
  (`filterToJSON`, `filterToLink`, `readFilter`). A filter is only maths: running someone else's is safe (a text's font, if it names one, is fetched).
- **`applyFilter(picture, filter, { params, t, images, engine, canvas, maxSize })`** (`@mathzetta/qblur/apply`, `dist/qblur-apply.js`): the one call — a filter in any
  form (maths, a document, JSON, a link, a compiled filter, or a built-in filter's name) on an `<img>`,
  `<video>`, canvas, ImageData or `{ data, width, height }`; a 2D canvas back in a page, the picture in Node. Pictures over 4096 px on the long side (2048 on the CPU)
  are scaled down first; `maxSize` sets the limit.
- **`<qblur-image>`** (`@mathzetta/qblur/element`, `dist/qblur-element.js`): a picture with a filter on it as an HTML
  element; attributes `src`, `filter`, `params`, `t`, `animate`, `engine`, `alt`, `crossorigin`.
- **Runners**: WebGL 1 and 2 (`createFilterRunner`; 8-bit, half or float textures between passes) and plain
  JavaScript (`createCpuRunner`; browsers and Node, `drawAsync` over workers for big pictures, generated
  code checked before it runs); `createRunner` picks the GPU when it can.
- **Saving**: `toBlob` (PNG written by the package — indexed when there are few colours — so it works in
  Node; JPEG and WebP in a browser), `encodeGif` (with gifenc passed in), `encodePng` — in `@mathzetta/qblur/apply`.
- **79 built-in filters** in `LIBRARY`, in seven `GROUPS`.
- **Text, shapes and brush strokes** drawn into frame-sized pictures (`renderGraphics`, `rasterizeStrokes`),
  with web fonts and separate shadow layers.
- **Builds** on jsDelivr/unpkg: an ES module and a classic script, each with MathZetta inside or without
  it, a GPU-only core, the element, and the CPU worker. TypeScript declarations for the package and the
  element. MIT; no dependencies (MathZetta 1.x is a peer).
