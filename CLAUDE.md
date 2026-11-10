# CLAUDE.md — qblur

Image filters written as maths: the filter document format (params,
pictures, chains), its compiler to WebGL passes, and the runner. Depends on
`mathzetta/glsl` (which stays in MathZetta: `toGLSL`, `filterShader`).

```bash
npm install      # links ../mathzetta/packages/mathzetta (the public library workspace)
npm test         # format, compiler, sharing — no browser
npm run serve    # http://localhost:8016/demo/
npm run check    # every library filter through real WebGL in headless Chrome (SwiftShader); exits 1 on a failure
npm run check:cpu       # …plus the CPU runner on the same pictures, compared pixel by pixel (≤0.5% of channels off by >4/255)
npm run check:nowebgl   # Chrome without WebGL: the editor must fall back to the CPU
npm run build           # site/ — demo/app.js bundled (via the page's import map) with MathZetta; deployable as is
npm run check:site      # build, then the checks against site/
npm run check:docs      # every example in docs/library.md run (pages in Chrome against dist/, `js node` blocks in Node); build first
npm run check:apps      # the small apps (profile picture, colour splash, make it move, fancy text) each doing its job; --site for site/
```

## Where things are

- `src/format.js` — normalize / validate / compile a filter; JSON and share links.
- `src/runtime.js` — WebGL runner (textures, passes, live params).
- `demo/index.html` + `demo/app.js` — the editor; `window.MathZetta` and `window.mzDemo` are set there for `tools/check.mjs`.
  One mode (writing the maths; there is no Simple mode any more). The controls are one card: the steps (each folds away: name,
  maths, its page of knobs and notes, opacity, "Save this step" / "Copy its link"), a rule, "Add a new filter" (maths, the saved
  filters, the library — folded, a fold per group, a line per filter; the built-in filters have no author), a rule, the examples.
  A brush's strokes are drawn as lines over the original (`#strokes-overlay`, `drawStrokeOverlay()`) until "hide strokes". A step's knobs are Inline Math variables: each is a line (`cutoff := [[0..1 step
  0.01 = 0.5]]`, `[[3]]` a box, `[[2 | 4 | 8]]` a menu, `#ff8800` a colour) drawn live by `@mathzetta/inlinemath/markdown`
  (`renderMarkdownInto`, one `createVariables()` store per step, so its notes' `{{k}}` follow the knobs); names Inline Math reads
  as products (`cx`, `dx`) get a plain slider. The lines, the page's order and saving a step on its own are `demo/knobs.js`
  (no DOM, test/knobs.test.js); in the format they are a param's `options` / `input: "box"` and a filter's `notes`.
  A step shows its maths (a textarea that grows; Enter applies), its knobs and its notes; its **Edit** toggle (`editing`, on for a
  step written in "Add a new filter") shows the editing parts: name and author, each knob's line, the add buttons, a note's tools.
  On phones the original picture is hidden (`body.hide-original`, "show original") until asked for or a panel that draws on it opens.
  Saved filters: localStorage "qblur" (a list of filters). A link (#…) opens as a fork, with a note saying whose it was. `still` (no video/GIF, and no pass uses `t`, `random` or brush strokes — `compileCpuPass(p).uses`)
  hides `.when-moving` (time, record, GIF) and stops the redraw loop. Panels are `<details class="panel" data-remember>` (open state kept).
  Keep every element id: app.js, export.js and tools/check.mjs find things by id.
  `demo/help.js` is the cheat sheet and `explain()` (errors → hints); test/help.test.js checks its sections against the guide's headings.
  `demo/photos/index.json` lists the default photos. `demo/gif.js` decodes GIFs (tested against gifenc, which encodes "Save as GIF").
- Dev dependencies: rollup (the build), gifenc (bundled into site/app.js), @mathzetta/inlinemath (the knobs and notes; from jsDelivr on the site, its CSS too), onnxruntime-web and @mediapipe/tasks-vision (NOT bundled: the dev import map points at node_modules, the build copies its WASM files into site/ort/), onnxruntime-node (test/ai.test.js). The package itself has none. The object models (demo/models/: RF-DETR Small and Nano, MobileSAM, MagicTouch 1 and 2; all Apache-2.0, see NOTICE): only MobileSAM is in git — the others are git-ignored for their size, and demo/models/README.md says how to get them — the site ships only `SHIPPED_MODELS` (demo/ai.js: MobileSAM — the editor's "find objects" and the profile picture's person, guessed from two clicks where a portrait's subject is, then the user's clicks; every site file must stay under Cloudflare Pages' 25 MiB, which RF-DETR Small's 39 MB isn't); `npm run build` copies just its file, LICENSE and its NOTICE paragraph to site/models/, and onnxruntime-web to site/ort/. The others (and MediaPipe, which only MagicTouch used) are for comparing in demo/: the model menu shows them there, and only there. `tools/export-model.py` remakes the ONNX ones; `tools/compare-ai.mjs` compares them; `npm run check:ai` / `npm run test:ai` run them.
- The small apps: `demo/avatar/`, `demo/splash/`, `demo/move/`, `demo/text/` — one page each with a few choices, for people who want one thing done
  (a profile picture — the person outlined by MobileSAM from a guess, then marks: a toggle under the photo (Move / Mark me /
  Mark not me: a point per click, shown as dots — few points work best; the decoder costs ~20 ms for 1 point or 30 — / Keep as is:
  painted areas (`state.lock`, `state.kept`) keep the outline they had, whatever the model answers later); or, background None and shape Cut-out, a transparent sticker with an outline drawn by the filter (`outline` picture);
  a colour splash; a moving GIF (speed and how much can be per-pixel formulas: `withFormulas` swaps every `t` / `amount` in the motion's maths); fancy text — the words drawn by the page as masks `fill`/`border`/`glow`, coloured by one filter whose
  letter and border colours are user formulas spliced into it (only ever parsed as maths), with `pattern` a picture). They share `demo/kit.js` (open a picture, the sample photos, `createView` = a filter
  on the GPU or CPU, download, GIF) and `demo/apps.css`; the avatar uses `ai.js` (MobileSAM, `base` = the folder above) for the person.
  The build bundles each into `site/<app>/`. They are pages of the qblur site in `mathzetta-sites/src/sites.js` and in
  `tools/deploy/check-sites.mjs`. `window.qblurApp` is for the checks; `SHOT_READY="Boolean(window.qblurApp)"` lets tools/shot.mjs open them.
- The look: the **Shioh style** (decided 2026-11-01, updated to the new base 2026-11-06) — three files in demo/:
  `shioh-style.css` (the style's base, copied **unchanged** from the shioh-style skill's assets: updating the look is replacing
  this file; theme = its defaults: the Shioh pastels, navy accent, black background), `site-theme.css` (loaded after it: qblur's
  own layer — maps the family's `--mz-*` variables onto the style, so the pages' own CSS follows, and makes each part of a page
  a cell; pictures, code and wide tables on white) and `shioh.js` (the phone menu, `ssToast()`, `ssConfirm()`; loaded `defer`
  AFTER the page's mountShell module, so the Menu button exists when it wires it up; plus the one-line `ss-js` script in
  <head>). `demo/shell.js` (`mountShell({ page, base })`) builds the frame: the sidebar — a `.ss-navcell` (wordmark, Menu
  button, qblur's pages from mathzetta-sites' registry), then a `.ss-desktop-only` cell with "Made with MathZetta", the other
  sites, Privacy · Terms — in place of the family's mountChrome (root CLAUDE.md rule 7 notes the exception); on phones a
  `.ss-phone-only` footer cell at the end of <main> repeats the MathZetta link, privacy and terms (the audit needs that link at
  390px). Copy confirmations are toasts (`ssToast`), not text in the page. Fonts: Montserrat and Open Sans from Google Fonts.
  Muted text is too light on the raspberry cell (`.ss-p5`), which uses the full ink. The build copies all four to site/
  (shell.js's registry import → ./mz/).
- Head tags: `head()` in tools/build.mjs gives every built page its canonical address, og:/twitter: tags with its card
  (`demo/share/<page>.jpg`, 1200 × 630) and the icons (`demo/favicon.svg`, `favicon.ico`, `apple-touch-icon.png`), from the page's
  own <title> and description (the guide pages' descriptions are in build.mjs). `node tools/share-cards.mjs` remakes the cards
  (each page's result, captured) and the icons. `site/_headers` keeps models/, ort/, photos/ and share/ cached (Cloudflare Pages).
- The guide on the site is docs/filters.md without its `<!-- dev -->…<!-- /dev -->` parts (`forSite` in tools/markdown.mjs):
  repo paths, npm scripts and the API stay on GitHub. Keep new developer-only paragraphs inside such markers.
- The profile-picture page's opening sample has its outline worked out ahead (`"person"` in demo/photos/index.json,
  `node tools/person-outline.mjs portrait.jpg` remakes it), so the model downloads only for the user's own photo or marks.
- Site essentials: `docs/privacy.md` and `docs/terms.md`, rendered by the build as privacy.html and terms.html like the guide;
  their `{{KEY}}`s are filled from `docs/site-details.json` (the owner's name, email, dates…; empty = still `{{KEY}}`, and the
  "Draft" note goes when none is left);
  `demo/404.html` (the shioh-style skill's self-contained 404 with the limerick prompt, filled for qblur: its SITE block lists home, a few pages and the MathZetta link; theme block = the base's colours; absolute addresses: the host serves it at any depth); robots.txt and sitemap.xml generated from the registry.
- The owner's words are on Claude UI's **Content** page (project qblur): docs/site-details.json (pattern fields, one per key),
  the editor's intro and "On your own site" blurb and each app's lead (between `<!-- claude-ui:begin/end … -->` lines in
  demo/index.html and demo/<app>/index.html — keep the markers), each page's meta description, and privacy.md / terms.md whole.
- `src/library.js` — `LIBRARY`, the built-in filters (tested by test/library.test.js). The editor opens on "Colour circle" (still, so no redraw loop).
- The package's three entries, each with its .d.ts (test/types.test.js checks every export is declared): `qblur` (src/index.js),
  `qblur/apply` (src/apply.js: `applyFilter` from src/apply-filter.js — pictures over `maxSize`, 4096 GPU / 2048 CPU, scaled down
  first — and saving: save.js, png.js) and `qblur/element` (src/element.js, `<qblur-image>`). dist/: qblur.js (the main entry),
  qblur-apply.js, qblur-element.js; the classic scripts carry all of it on window.QBlur.
- `src/graphics.js` — text/rect/ellipse graphics: validated in the format (`graphics`), drawn by the page (or `renderGraphics`) into frame-sized pictures. Each pass's graphic is bound under its own key (`pass.bind`: `title` → `title~2`), unlike pictures, which are shared by name.
- `src/strokes.js` — brush strokes: a `strokes` graphic re-rasterized per frame by its own dab rasterizer (channels are data: alpha coverage, red age, green passes/4, blue progress), uploaded as ImageData (a canvas would premultiply the channels away). The page calls `updateStrokes()` in draw(), export and GIF frames.
- `demo/tracker.js` — tracking (no DOM, test/tracker.test.js). The page feeds it frames from a second copy of the video (seeked; videos from the list are loaded as blobs so seeking works on any server) or the GIF's frames. tools/send-file.mjs gives the local servers byte ranges.
- `demo/examples.js` — the guided examples (data); test/examples.test.js compiles them, tools/check.mjs runs them in the page.
- `tools/shot.mjs` — `node tools/shot.mjs "/site/index.html" "<js>" out.png` for a look at the page.
- `docs/filters.md` — the guide to what an expression can use (`px py rgb gray`, neighbourhoods, geometry, several pictures).
- `docs/library.md` — the library on other people's pages: the CDN (placeholder jsDelivr URLs until qblur is on npm — they are
  written there and in README.md; grep `cdn.jsdelivr.net/npm/qblur`), builds, GPU/CPU/Node, knobs, video, pictures, text, sharing,
  every export. Blocks fenced ```` ```html runnable ```` / ```` ```js node ```` are run by `npm run check:docs`: keep them working.
  The build renders it as site/library.html (the editor's "On your own site" links it). `dist/cpu-worker.js` ships beside the bundles
  for drawAsync; from another origin cpu-runner.js starts it through a blob: module, and falls back to draw() if workers can't start.

- `src/cpu.js` + `src/cpu-helpers.js` + `src/cpu-runner.js` + `src/cpu-worker.js` — the CPU runner: each pass compiled to typed straight-line JS (one local per vector component), neighbourhood planes computed once per pass by bands of rows; `src/auto.js` chooses: the GPU whenever WebGL is available (shaders compile once per filter), the CPU without it or when asked.

## Rules

- The CPU and GPU must give the same pixels: a change to the filter language (mathzetta's render/glsl.js) needs the matching change in src/cpu.js / cpu-helpers.js, then `npm run check:cpu`.
- Generated CPU code passes `checkGeneratedJs` (variables /^\$\w+$/, indexable /^\$[A-Z]/, no strings) before `new Function` — keep every generated name `$`-prefixed and never splice user text into it.

- Changing what an expression can do (new helper, new value) usually means a change in `mathzetta/src/render/glsl.js` first; keep the two in step and run `npm run check`.
- The filter format is frozen at `mathzetta-filter/1` (docs/filters.md, "Format stability"): add, never change or remove; a breaking change is a new format with a converter in `readFilter`.
- After changing demo/ or src/, `npm run build` so site/ matches (it is committed).
