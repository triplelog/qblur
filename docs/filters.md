# Image filters

A filter is a bit of maths that runs on every pixel of a picture. It reads the pixel — its
colour `r` `g` `b`, its brightness `gray`, where it is (`x` `y`, or `px` `py` in pixels) — and works
out the new colour. Type one into the editor's *Add a new filter* box and press *Add*:

| Write | You get |
| --- | --- |
| `1 - rgb` | the negative: every channel turned upside down |
| `gray` | black and white |
| `(g, r, b)` | red and green swapped |
| `if gray > 0.5 then 1 else 0` | a hard black-and-white threshold |
| `rgb * 1.3` | brighter |
| `pixel(px + 8 sin(py / 10 + t / 5), py)` | a wave that moves (`t` counts the frames) |
| `gaussian(3)` | a soft blur |

Then give it knobs: with the step's *Edit* on, *+ slider* adds a line like
`strength := [[0..1 step 0.01 = 0.5]]` — a slider the maths can use as `strength` (*Edit* also shows
the step's name and author, and lets you write notes). Steps run top to bottom, each on the result of the one
above, so filters chain; *Copy link* puts the whole thing in a link anyone can open, change and
keep (see [Sharing filters](#sharing-filters)). Everything runs in your browser — nothing is
uploaded. The rest of this guide is everything an expression can use; the editor's *Examples* each
explain one idea, and the *Library* has dozens of filters to open and read.

**Saving the result.** *Download* draws the filter at the picture's own size. *Download options*
choose the format — PNG, JPEG or WebP, or *auto*, which picks the smallest sensible one (a result
with few colours becomes a small indexed PNG; one with transparency stays lossless; a photo goes to
whichever of JPEG and WebP is smaller) — the size, a crop you drag on the result, and for moving
pictures *Save as GIF* (at the preview size; a GIF plays through once with its own delays, anything
else gets 3 seconds) or *Record* (video). Effects measured in pixels — blur radii, `px` — stay the
same number of pixels, so they look finer on a big picture.

<!-- dev -->
**For developers.** MathZetta turns the maths into GLSL, and `filterShader()` wraps it in a complete
fragment shader, so a filter runs on the GPU — fast enough for video:

```js
import { filterShader, filterVertexShader } from 'mathzetta/glsl';

filterShader('(1 - r, 1 - g, 1 - b)')                    // invert
filterShader('gray')                                     // greyscale
filterShader({ r: 'g', g: 'r' })                         // swap red and green; b and a unchanged
filterShader('if gray > 0.5 then 1 else 0')              // threshold
filterShader('pixel(px + 8 sin(py / 10 + t / 5), py)')   // a wave that moves with t
```

`demo/index.html` is the editor; `LIBRARY` (exported by the package) is the built-in catalogue it
shows. [qblur on your own pages](library.md) is how to use the package.
<!-- /dev -->

## What an expression can use

| Name | Meaning |
| --- | --- |
| `r` `g` `b` `a` | the pixel's channels, 0–1 |
| `rgb` | the same three as a vector; `rgb * 0.5` dims every channel |
| `gray` | the pixel's brightness, 0.299 r + 0.587 g + 0.114 b |
| `x` `y` | where the pixel is, 0–1 across and down the image |
| `px` `py` | the same in pixels (`py` runs downwards, like image rows) |
| `w` `h` | the image's width and height in pixels |
| `t` | the frame index — a uniform you set; count it up each frame of a video or GIF |
| `random()` | a different number 0–1 for every pixel, every call and every frame: `rgb + 0.15 (random() - 0.5)` is film grain |
| `pixel(px, py)` | another pixel, as a vector (r, g, b, a) |
| `red(px, py)` `green(…)` `blue(…)` `alpha(…)` `luma(…)` | one channel, or the brightness, of another pixel |
| `unchanged` | the value this expression replaces (see conditionals); as the missing `else` it takes the other branch's type, so `if c then 1` and `if c then (1, 0, 0)` both work |

And everything GLSL has: `clamp(v, 0, 1)`, `mix(a, b, 0.5)`, `smoothstep(0, 1, x)`,
`step(0.5, x)`, `fract(x)`, `length((x, y))`, `distance(…)`, `floor`, `abs`,
`min`, `max`, `sin`, `cos`, `exp`, `log`, `sqrt`, `pow`, `atan2(y, x)`, `mod`.

## Results: numbers, colours, true/false

The shader accepts whatever the expression works out to:

- a **number** is grey (or, for a channel, that channel's value);
- a **tuple** `(r, g, b)` or `(r, g, b, a)` is the colour;
- a **comparison** is 1 or 0 — `r > 0.5` is a mask you can multiply by.

Give one expression for the whole colour, or an object with any of
`r`, `g`, `b`, `a`, `rgb`, `rgba`. Channels you don't mention keep their
value. In a per-channel expression, `r g b a` are always the *original*
pixel, so `{ r: 'g', g: 'r' }` swaps rather than copies.

## Conditionals

```
if gray > 0.5 then 1 else 0                 threshold
if y < 0.5 then rgb else (1 - r, 1 - g, 1 - b)
if g > 0.5 & g > 1.3 r & g > 1.3 b then (0.1, 0.1, 0.4) else rgb      chroma key
if a then … else if b then … else …         chains
IF(gray > 0.5, 1, 0)                         the spreadsheet form
gray > 0.5 ? 1 : 0                           the C form
```

Leave the `else` off and the pixel keeps its value where the condition is
false: `{ r: 'if x < 0.5 then 1 - r' }` inverts red on the left half
only. (`unchanged` is the name for that value; you can use it yourself:
`if y < 0.5 then unchanged * 0.5`.)

`&` is "and", `|` is "or", `!` or `not` is "not": `if r > 0.5 & !(g > 0.5)`.
Comparisons need numbers on both sides and logic needs comparisons —
GLSL won't take a bare number as true or false.

## Animation with `t`

`t` is whatever you put in the uniform; counting frames is the natural
choice for video and GIF, because then a filter means the same thing at
every frame rate:

```
rgb * (0.75 + 0.25 sin(t / 6))                       pulse every 38 frames
pixel(px + 8 sin(py / 10 + t / 5), py)               wave
if (px + t) mod 8 < 4 then rgb * 0.7 else rgb        crawling stripes
rgb * (1 - 1.6 ((x - 0.5)^2 + (y - 0.5)^2))          vignette (no t)
```

For time in seconds instead, set `t` to `performance.now() / 1000` and
write `sin(2π t)` for one cycle a second.

## Neighbouring pixels

`pixel(px, py)` reads any pixel, so blurs, edges and distortions are
expressions too:

```
(pixel(px-1, py) + pixel(px+1, py) + pixel(px, py-1) + pixel(px, py+1)) / 4     blur
abs(gray - luma(px + 1, py)) * 8 + abs(gray - luma(px, py + 1)) * 8            edges
pixel(w - px, py)                                                               mirror
pixel(floor(px / 8) * 8, floor(py / 8) * 8)                                     pixelate
pixel(w/2 + (px - w/2) cos(0.02 t gray) - (py - h/2) sin(0.02 t gray),
      h/2 + (px - w/2) sin(0.02 t gray) + (py - h/2) cos(0.02 t gray))          swirl
```

Coordinates outside the image clamp to the edge (the demo sets
`CLAMP_TO_EDGE`; set `REPEAT` on the texture for tiling).

## Moving the picture: zoom, pan, rotate, crop, tile

These read the picture from somewhere else, so with `t` inside them a
still picture moves:

| Function | Result |
| --- | --- |
| `zoom(s)` `zoom(s, cx, cy)` | the picture `s` times larger, about its centre or the point (cx, cy) in 0–1 |
| `shift(dx, dy)` | moved right and down by that many pixels, wrapping around |
| `rotate(a)` `rotate(a, cx, cy)` | turned clockwise by `a` radians (`rotate(10°)` works) |
| `crop(x0, y0, x1, y1)` | that part of the picture, in 0–1 fractions, filling the frame |
| `tile(n)` `tile(nx, ny)` | the picture repeated n × n times |
| `flipx()` `flipy()` | mirrored |

```
zoom(1 + 0.002 t, 0.5 + 0.0003 t, 0.45)      Ken Burns: a slow zoom that drifts
shift(2 t, 0)                                 scrolling
rotate(t / 100)                               spinning
crop(0.1 + t / 2000, 0.1, 0.6 + t / 2000, 0.6)    panning across a crop
tile(2)                                       four copies
```

Each is one transform about the frame; to combine them, chain steps
(`Zoom` then `Spin`). Where a transform leaves the frame — zoomed out,
rotated corners — the picture is **transparent** when the transform is
the whole colour (`zoom(0.5)` alone: the page, or a PNG's transparency,
shows through; a later step sees `a` = 0 there and can fill it:
`mix(background, rgb, a)`). Inside a bigger expression it is a colour,
black there, and `alpha(zoom(0.5))` is 1 inside the picture and 0
outside, so `mix(rgb, zoom(0.5), alpha(zoom(0.5)))` lays the small copy
over the original. `shift` and `tile` wrap instead.
They work on another picture too: `zoom(overlay, 2)`, `shift(overlay,
2 t, 0)`, `rotate(mask, t / 50)`, and `width(overlay)`, `height(overlay)`
are that picture's own size in pixels.

### Placing a picture of another size

A named picture is laid over the frame according to its own size:

```json
"images": { "inset": { "place": "fit", "zoom": 0.35, "x": 0.8, "y": 0.78 } }
```

- `place` — `cover` (fills the frame keeping the aspect ratio, the
  default), `fit` (shows all of it), `stretch` (ignores the ratio), or
  `tile` (repeats it at its own size).
- `zoom`, `x`, `y`, `angle` — then scaled, centred at (x, y) in 0–1 of
  the frame, and turned. Outside the picture it is transparent, so
  `mix(rgb, inset, alpha(inset))` composites it — a picture in picture.

Whoever uses the filter can move it: `"with": { "inset": { "x": 0.2,
"zoom": 0.5 } }` in a chain step (the demo shows these as knobs beside
each picture), and `zoom(inset, 1 + t / 500)` in the maths animates on
top of that. The `source` picture is the frame's size, so it has no
placement.

## Text and shapes

A filter can draw text, rectangles and ovals. Each is named in
`graphics`, drawn by the browser into a transparent picture the size of
the frame, and read by the maths like any picture:

```json
{ "name": "Caption",
  "graphics": { "title": { "type": "text", "text": "Hello", "y": 0.88, "font": "Georgia, serif" } },
  "color": "mix(rgb, title, alpha(title))" }
```

- `title` is the graphic's colour at this pixel, `alpha(title)` where it
  is — so the maths decides how it lands: `mix(rgb, title, alpha(title))`
  lays it on; `mix(rgb, mix((1, 0.35, 0.3), (1, 0.85, 0.25), x), alpha(title))`
  colours the letters with a gradient; `mix(rgb, gaussian(5) * 0.7, alpha(panel))`
  frosts the picture behind a panel (a shape with its own filter);
  `mix(rgb * 0.3, rgb, alpha(spot))` darkens all but an oval.
- **Animated** through the same geometry as any picture, with `t`:
  `mix(rgb, shift(title, -3 t, 0), alpha(shift(title, -3 t, 0)))` scrolls
  it, `zoom(title, 1 + 0.06 sin(t / 8))` pulses it,
  `mix(rgb, title, alpha(title) clamp(t / 40, 0, 1))` fades it in.

| Setting | For | Meaning |
| --- | --- | --- |
| `type` | all | `text` (the default), `rect` or `ellipse` |
| `x`, `y` | all | the centre, 0–1 across and down the frame |
| `angle` | all | turned clockwise, radians |
| `color` | all | any CSS colour: `#ffcc00`, `rgba(0,0,0,0.5)`, `white` |
| `shadow` | all | `{ "color", "blur", "dx", "dy" }` drawn into the graphic (sizes as fractions of the text size, or the frame height for shapes), or `null` |
| `shadows` | all | a list of up to 8 shadow layers, back to front, each drawn into a picture of its own (see below) |
| `outline` | all | `{ "color", "width" }`, or `null` |
| `text` | text | the words; `\n` starts a new line |
| `font`, `weight`, `style` | text | a CSS font family (`"Georgia, serif"`), `normal`/`bold`/`100`–`900`, `normal`/`italic` |
| `fontUrl` | text | an `https://` font file (.woff2, .woff, .ttf, .otf), or a Google Fonts stylesheet address, loaded before drawing; `font` is the fallback while it loads or if it can't |
| `size`, `align`, `lineHeight` | text | height as a fraction of the frame's, `left`/`center`/`right`, line spacing |
| `w`, `h`, `radius` | shapes | size as fractions of the frame; a rectangle's corner rounding |

### Shadow layers, each with its own filter

`shadow` is drawn into the graphic, so whatever the maths does to the
text it does to that shadow too. `shadows` keeps them apart: each layer
is drawn into a picture of its own — `title_shadow1`, `title_shadow2`…,
back to front — and the maths lays each on as it likes:

```json
{ "graphics": { "title": { "text": "LAYERS", "shadow": null,
    "shadows": [ { "color": "#000", "blur": 0.7, "dy": 0.08 }, { "color": "#000", "dx": 0.07, "dy": 0.07 } ] } },
  "color": "mix(mix(mix(rgb, rgb * 0.25, alpha(title_shadow1) (0.7 + 0.3 sin(t / 10))), mix((1, 0.2, 0.6), (0.2, 0.6, 1), x), alpha(title_shadow2)), title, alpha(title))" }
```

Here the first layer darkens the picture under a soft glow that breathes
with `t`, and the second is a hard offset shadow coloured by a gradient
whatever colour it was cast in ("Layered shadow" in the library). The
plain way to lay them all on is `mix(mix(mix(rgb, title_shadow1,
alpha(title_shadow1)), title_shadow2, alpha(title_shadow2)), title,
alpha(title))`; the editor writes that for you when you add a layer to
a step whose maths is still the plain one, and points out a layer your
own maths doesn't use yet.

### Fonts

`font` is a CSS family list, so anything the viewer's computer has
works (`"Georgia, serif"`). For a font they may not have, give
`fontUrl`: a Google Fonts stylesheet (`googleFontUrl('Lobster')`, or the
editor's "Google Fonts name" box) or the address of a font file. Those
travel in share links; the viewer's browser fetches them from that
address. A font file loaded from your own computer works in the editor
only — a link opened elsewhere shows the fallback `font`.

Sizes are fractions of the frame, so at export the graphics are drawn
again at the export size — crisp, and in the same place. A chain changes
a graphic with `with`, merging settings: `{ "filter": …Caption…, "with":
{ "title": { "text": "Bye", "color": "#ffcc00" } } }`. Unlike pictures,
graphics are not shared between steps: two steps whose text is called
`title` draw two texts (the compiler binds them as `title`, `title~2`…).

In the editor, *+ text*, *+ rectangle* and *+ oval* add a step with an
editable expression; each graphic gets controls for its words, font,
size, place, angle, colour, shadow and outline, and can be dragged on
the picture. A font file loaded from the computer works there but can't
travel in a link; a font URL can (the browser of whoever opens the link
fetches it from that address).

With the runners directly, draw the graphics yourself after compiling:

```js
const compiled = compileFilter(def);
for (const [key, canvas] of Object.entries(await renderGraphics(compiled, width, height))) runner.setImage(key, canvas);
```

A graphic not drawn yet is transparent, so nothing covers the picture
meanwhile.

## Brushes

A brush is a graphic of type `strokes`: what the user paints on the
picture, recorded point by point (`[x, y, milliseconds, pressure]`, x and
y as fractions of the frame) and drawn again for every frame — only the
paint laid down by frame `t` is there, so the painting animates. Its
picture carries data rather than colour:

| Channel | Meaning |
| --- | --- |
| `alpha(brush)` | coverage: how much paint is here so far |
| `red(brush)` | age: 0 where it was just painted, rising to 1 after `age` frames |
| `green(brush)` | passes ÷ 4: how many strokes have gone over it (`4 green(brush)` counts them) |
| `blue(brush)` | progress: how far through the whole drawing it was painted, 0 → 1 |

So the maths decides what the paint does, and how it changes:

```
mix(rgb, ink, alpha(brush))                                           ink in a colour (a knob)
mix(rgb, gaussian(2 + 3 min(4 green(brush), 3)), alpha(brush))        a blur, stronger with every pass
rgb (1 - 0.22 min(4 green(brush), 4) alpha(brush))                    darker with every pass, like a wash
mix(rgb, mix((1, 0.9, 0.5), (0.1, 0.07, 0.06), red(brush)), alpha(brush))   glowing as it goes down, then cooling
mix(rgb, fromhsv(blue(brush), 0.85, 1), alpha(brush))                 a rainbow along the drawing
mix((gray, gray, gray), rgb, alpha(brush))                            the picture's colour painted back in
```

| Setting | Meaning |
| --- | --- |
| `brush` | `round`, `soft` (airbrush), `marker` (a flat nib at 45°), `chalk` (grain fixed to the paper), `spray` |
| `size`, `flow`, `spacing` | diameter as a fraction of the frame height; paint per dab; dab spacing in brush widths |
| `taper` | thinner at both ends, over this fraction of the stroke |
| `widthFrom` | `pressure` (a pen or touch screen), `speed` (fast is thin, as with ink), or `none` |
| `buildUp` | coverage adds up where strokes overlap, instead of taking the most |
| `timing` | `recorded` (the user's own speed), `even` (time follows length), `per-stroke` (each the same time) |
| `speed`, `gap`, `start`, `fit` | faster or slower; frames between strokes; frames before the first; stretch the whole drawing to this many frames (0: off) |
| `age` | how many frames `red(brush)` takes to go from 0 to 1 |
| `clip` | `none`, `inside` or `outside`: paint only inside (or outside) the user's selection |

A stroke counts once wherever it goes, however often it crosses itself,
so `green` counts separate passes. In the editor, "+ brush" adds a step
and starts drawing (the picture shows the painting finished while you
draw; "replay" plays it); each brush's panel chooses what the paint does,
the brush, the timing and where it may paint, and "outline the
selection" turns the selection's edge into strokes — a brush that draws
round an object. `traceContours(mask, w, h)` and `rasterizeStrokes(spec,
w, h, t, { mask })` do the same outside the editor; `renderGraphics`
takes `{ t, mask }`.

## Several pictures: masks and blending

A filter can ask for more pictures by name, and the maths treats each
like the main one:

```json
{ "name": "Through a mask",
  "images": { "mask": { "description": "light where the effect shows" } },
  "color": "mix(source, rgb, luma(mask))" }
```

- `mask` is that picture's colour at this pixel (like `rgb`);
  `mask(px, py)` is any pixel of it, also a colour; `red(mask)` …
  `alpha(mask)` and `luma(mask)` read one channel.
- `source` is always available: the picture the chain started from,
  before any step. So "Through a mask" as the last step shows everything
  above it only where the mask is light — a blur, a posterize, anything.
- `images` is a list of names, or an object with a `description` for
  each (the demo shows it beside the picture chooser).

```
mix(rgb, overlay, amount)                     fade to another picture
mix(rgb, overlay, luma(mask))                 …through a mask
rgb * overlay                                 multiply
1 - (1 - rgb)(1 - overlay)                    screen
if gray < 0.5 then 2 rgb overlay else 1 - 2 (1 - rgb)(1 - overlay)     overlay blend
abs(rgb - overlay)                            difference
mix(rgb, overlay, alpha(overlay))             a transparent PNG laid on top
if distance(rgb, key) < tolerance then background else rgb             chroma key onto a picture
mix(source, rgb, luma(mask))                  keep the chain's result where the mask is light
```

### Selecting an object

`selected` is 1 inside what the user selected on the picture and 0
outside — 1 everywhere when nothing is selected, so a filter that uses
it works unchanged. `mix(source, rgb, selected)` as a last step keeps
the chain's result only inside the selection ("Only inside the
selection" in the library); `selection(px, py)` reads the mask elsewhere.
It is a mask, so a colour space leaves it alone. The runner takes it as
a picture named `selection` (white = in): `runner.setImage('selection',
maskCanvas)`.

The editor makes one two ways. *Trace the edge* is intelligent scissors
(livewire): click a few points around the object and the line between
them follows the edge — every pixel has a cost, low where the brightness
changes sharply, and the line is the cheapest path (Dijkstra) between
your points; a click runs the search once from that point, so the wire
to the cursor moves in real time and only the segments a point touches
are recomputed when you add or drag one. A clicked point snaps to the
strongest edge within a few pixels, so it need not be placed exactly.
With *freeze as I go* (path cooling), the part of the line that has
stayed the same for a moment as you move on is fixed for you — small
blue points — so around a clear edge you click once and steer, and click
only where the line needs help. Click the first point, press Enter or
double-click to close; Backspace removes the last point. When the
object runs off the picture, click *outside* it (in the margin round the
picture): that point (drawn as a square) sits on the picture's edge, and
between two such points the line runs along the edge, so the shape takes
in the border without tracing it. *Find objects (AI)* runs **MobileSAM** (Segment Anything with a small image
encoder) in the browser: click anything — a person, a house, a tree, a
cloud — and it is outlined. It looks at the picture once (a second or two);
each click is then about a tenth of a second. One click can be ambiguous
(the harness or the horse?): click again to add, shift-click where it went
too far.

<!-- dev -->
In development, `demo/`, a *model* menu also offers the others
compared under "The object models" below — RF-DETR, which lists and labels
80 kinds of thing; `?ai=…` in the address chooses one.
<!-- /dev -->

Enter keeps, and the next click starts another
object. The model and its runtime (ONNX Runtime Web) are
served by the site itself — no CDN, no Hugging Face — load only when
asked and are then cached by the browser; the rest of the editor never
depends on them. Anything not among the 80 kinds is for the edge tracer,
the colour fill or the refine brush.

The *refine* brush fixes any selection, however it was made. Paint with
*inside* over a part that was missed, or with *outside* over a part that
leaked; the boundary then settles on the nearest real edge near the
stroke. Under the hood, the stroke and the rim of a band round it are
seeds, and each side grows through the band with a cost that is tiny in
even colour and steep across an edge (measured over three pixels, so a
soft edge counts in full) — whichever side reaches a pixel first claims it
(a seeded region competition, Dijkstra again); nothing outside the band
moves. With nothing selected, an inside stroke makes a selection from
scratch: the whole picture is in play and its border is "outside", so the
stroke grows to the object's edges. The size slider sets the brush. *Fill a colour* is a magic wand that
knows several colours: each click adds that pixel's colour to a set,
and the fill grows from every click through any pixel within the
tolerance of *any* colour in the set — a striped shirt is two clicks;
"connected only" off takes those colours anywhere in the picture;
click a swatch to drop a colour, and the tolerance slider refills live. Feather softens the edge,
invert swaps inside and out; the selection is drawn at any export size.
It belongs to the picture, not the filter, so share links don't carry it.

### The object models

The site uses **MobileSAM** to find an object from a click or two. It runs in your browser like the
filters (about 19 MB, downloaded the first time it is needed); the photo never leaves your computer.

<!-- dev -->
The site ships one: **MobileSAM** (`SHIPPED_MODELS` in `demo/ai.js`; the build copies only its files,
with the LICENSE and its part of the NOTICE). Every file of the site has to stay under 25 MiB to be
hosted on Cloudflare Pages, which RF-DETR Small (39 MB) isn't; a bigger model can come back split
into parts and joined when it loads. The others stay in `demo/models/` for comparing in
development. All are Apache-2.0:

| model | file | size | what |
| --- | --- | --- | --- |
| RF-DETR Small | rfdetr-seg-small.onnx | 41 MB | exported at 576 × 576 (not its own 384: more found, finer outlines), int8 |
| RF-DETR Nano | rfdetr-seg-nano.onnx | 37 MB | its own 312 × 312, int8 — the same backbone, so hardly smaller |
| MobileSAM | mobilesam-encoder/decoder.onnx | 19 MB | int8 (the encoder's MatMuls only: quantizing its convolutions breaks it) |
| MagicTouch | magic_touch.tflite | 6 MB | as published |
| MagicTouch 2 | magic_touch_2.task | 31 MB | as published (int8) |

`tools/export-model.py` remakes the ONNX files; `node tools/compare-ai.mjs
out.png` draws every model's outline of the same things in a photo side by
side, with timings. They run on one thread; ONNX Runtime uses several when
the page is cross-origin isolated (the host sends
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`).
<!-- /dev -->

### Tracking an object through a video or GIF

The editor can make a selection follow an object through a clip, so
`selected` (and brushes that stay inside the selection) follow it frame
by frame. Pause on a frame, select the object with any tool, "use as
keyframe", then "track". From each keyframe the outline is carried
forward and backward a frame at a time:

- points round the outline are found again in the next frame by matching
  the patch of picture round each (coarse, then fine); points that
  disagree with the rest are pulled back to the group's movement, and
  each may stray only a few pixels from the group's overall move, scale
  and turn, so the outline can't wander off;
- the keyframe teaches it the object's colours against a band just
  outside, so each frame has a map of how object-like every pixel is;
  the outline between the points follows the edge of that map (and some
  plain brightness edges) — not every leaf behind the object;
- each frame's confidence is how much more object-like the inside is than
  the band just outside, against the keyframe, and whether the area
  jumped. Between two keyframes, each frame keeps the direction that
  scored higher.

The timeline under the picture shows confidence (green sure, red not):
click a frame to go there, fix it ("edit this frame" puts the outline into
the edge tracer to drag its points, or select again), and use it as another
keyframe. "Fix red frames with AI" runs the chosen model on each unsure frame
with a box round the tracked outline (RF-DETR takes the object whose box
matches best; MobileSAM outlines what is in the box). Tracking runs at preview
size, about 15 s for 240 frames.

<!-- dev -->
Videos in the photo list are held in memory
so they can be stepped through frame by frame (a server must allow byte
ranges for that otherwise; `tools/serve.js` does).
<!-- /dev -->

In a chain, pictures are matched by name: every step that asks for
`mask` gets the same one, and `compiled.images` lists what to supply.
The runner takes them with `runner.setImage('mask', image)`; a picture
not given is white, so a missing mask lets everything through. Pictures
are stretched to the canvas, so size them like the main picture.

## Colour spaces

The frame holds sRGB — the numbers a screen shows. A filter can work in
another space instead:

```json
{ "name": "Hue shift", "space": "hsv", "params": { "amount": 0.1 }, "color": "(fract(r + amount), g, b)" }
```

With `"space": "hsv"`, `r g b` (and `rgb`, `pixel()`, the blurs, named
pictures, `source` — everything read) are hue, saturation and value,
and the result is taken as HSV and converted back. `gray` is still the
brightness as seen. `"space": { "in": "lab", "out": "srgb" }` converts
on the way in only, when the expression writes sRGB itself.

| Space | `r`, `g`, `b` are |
| --- | --- |
| `srgb` | what the picture holds (the default) |
| `linear` | light rather than gamma-encoded values: blurs and mixes in it behave like a lens, bright spots stay bright |
| `hsv`, `hsl` | hue (0–1 around the wheel), saturation, value / lightness |
| `lab` | L 0–1, then a and b centred on 0.5 (0.5 ± value/256) |
| `oklab` | L 0–1, then a and b centred on 0.5 (0.5 + value) — perceptually even |
| `ycbcr` | luma, then Cb and Cr centred on 0.5 |

Every space keeps its values in 0–1 so they survive the 8-bit texture
between passes — but 8 bits of Lab or OKLab is coarse for dark, saturated
colours (up to ~20/255 off after the round trip), so the editor uses
half-float textures for a chain with a colour space where the GPU
allows (`createFilterRunner(gl, c, { precision: 'half' })`,
`createCpuRunner(c, { precision: 'float' })`). A step's opacity blends
the result over its input in sRGB. The conversions are also functions you can use anywhere —
`tohsv(c)`, `fromhsv(c)`, `tolinear`, `fromlinear`, `tohsl`, `tolab`,
`tooklab`, `toycbcr` and their inverses, sRGB on the other side —
so a single expression can do it: `fromhsv(fract(red(tohsv(rgb)) + t /
300), green(tohsv(rgb)), blue(tohsv(rgb)))` cycles the hue. The editor
has a space chooser beside the expression box.

## Blur, edges and other neighbourhood functions

The classic image-processing operations are functions you can use in
any expression, so they combine with everything else and with each
other. Colour-valued ones return a colour like `rgb` (alpha is left
alone); the edge detectors work on brightness and return a number.

| Function | Result |
| --- | --- |
| `blur(radius)` | box blur: the mean of the square ±radius pixels |
| `gaussian(sigma)` | Gaussian blur, weights falling off with `sigma` |
| `blurx(r)` `blury(r)` `gaussianx(s)` `gaussiany(s)` | the same along one axis — chain an x then a y step for a wide, fast blur |
| `sharpen(amount)` | the 3×3 sharpen kernel, scaled by `amount` |
| `dilate(radius)` `erode(radius)` | the brightest / darkest colour within ±radius: light or dark areas grow |
| `convolve(k1, …, k9)` | your own 3×3 kernel, row by row |
| `sobel()` `sobelx()` `sobely()` | Sobel edge strength (and its horizontal / vertical parts) |
| `laplacian()` | the 4-neighbour Laplacian of brightness |
| `emboss()` | brightness relief lit from the top-left, around 0.5 |

```
gaussian(3)                                   a blur
rgb + 1.5 (rgb - gaussian(2))                 unsharp mask
rgb + 0.8 max(gaussian(3) - 0.6, 0)           bloom: bright parts glow
if sobel() > 0.3 then 1 else 0                an edge map
rgb (1 - 3 sobel())                           ink outline over the colour
convolve(0, -1, 0, -1, 5, -1, 0, -1, 0)       sharpen, as a kernel
dilate(2) - erode(2)                          morphological gradient: outlines of shapes
```

Every one of them takes expressions, so a parameter can drive it
(`gaussian(sigma)`), and `t` can too (`gaussian(2 + 2 sin(t / 20))`).
In a per-channel expression a colour result gives that channel:
`{ "r": "gaussian(4)" }` blurs only red. The library in the demo has
each of these as a filter with knobs, and chains built from them
(Cartoon = Gaussian blur → Posterize → Outline).

Two limits, because a shader loop needs fixed bounds: the square
functions reach ±8 pixels, so `gaussian(sigma)` inside an expression is
truncated above `sigma ≈ 2.7`; the one-axis functions reach ±24. A step
whose whole colour is just `gaussian(sigma)` or `blur(radius)` is
computed separably for you — an x pass then a y pass, 2n taps instead
of n², reaching ±24 — so the plain blur is the fast, wide one; write
`gaussianx`/`gaussiany` yourself only when you want one axis.
Each call samples the neighbourhood again, so `gaussian(3)` used twice
in one expression costs twice — put it in its own step if that matters.
"Canny edges" in the library is a chain of these: a Gaussian, then
gradient strength and direction (`atan2(sobely(), sobelx())` into four
buckets), non-maximum suppression along the gradient, two thresholds,
three rounds of hysteresis (`red(dilate(1))` tells a weak pixel whether a
strong one is next to it), and a clean-up — nine passes, all plain
expressions, so it runs on the CPU too.

## Running it

The editor runs a filter on the GPU (WebGL) when the browser has it, and on the CPU otherwise —
*Advanced* → *runs on* lets you choose. Both give the same pixels; the GPU is much faster, so big
pictures and video want it.

<!-- dev -->
### Without a GPU

Every filter also runs on the CPU, in plain JavaScript, for when WebGL isn't
there (some browsers, Node, servers). Where it is, the GPU is the one to use:
a filter's shaders compile once and then serve every picture and frame.

```js
import { compileFilter, createCpuRunner, createRunner } from 'qblur';

const runner = createCpuRunner(compileFilter(def));      // same interface as createFilterRunner
runner.setImage(imageData);                               // ImageData or { data, width, height }; an <img>/<canvas> in a browser
const out = runner.draw({ t: 0 });                        // { data: Uint8ClampedArray, width, height }
await runner.drawAsync({ t: 0, canvas });                 // rows spread over workers for big pictures

const { runner: r, engine, reason } = createRunner(compileFilter(def), { gl });   // the GPU if there is WebGL, else the CPU; and why
```

Each pass is compiled to one JavaScript loop over the pixels — the same
language, types and sampling as the shader (bilinear `pixel()`, edges
clamped, 8-bit rounding between passes), so both give the same pixels:
`npm run check -- --cpu` compares them on every library filter (all within
1/255 apart from a handful of pixels exactly on an edge; `random()` can't
match — GPUs compute the hash's `sin` in lower precision). Neighbourhood
functions with an argument that is the same for every pixel (`blur(radius)`)
are computed once per pass, separably; one that changes per pixel
(`blur(x * 8)`) is computed pixel by pixel and is slow. Rough single-thread
times for 1 megapixel: per-pixel formulas 12–35 ms, `blur`/`sobel` 30–85 ms,
`gaussian(3)` 115 ms, a σ = 8 Gaussian chain 310 ms; `drawAsync` with 8
workers is 3–5× faster on the heavy ones.

The generated code is compiled only after MathZetta's `checkGeneratedJs`
passes it (no names but its own, no strings, only its own arrays indexed),
so a filter from a share link can read the picture and write colours,
nothing else. Pages whose Content-Security-Policy forbids `'unsafe-eval'`
can't use the CPU runner.

### On the GPU

A complete WebGL 1 setup with MathZetta alone (qblur's `createFilterRunner` does all of this for you):

```js
const gl = canvas.getContext('webgl');
const fragment = MathZetta.filterShader('(1 - r, 1 - g, 1 - b)');
const program = link(gl, MathZetta.filterVertexShader(), fragment);   // compile + link as usual

// One triangle covering the canvas.
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
const position = gl.getAttribLocation(program, 'position');
gl.enableVertexAttribArray(position);
gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

// The image, flipped so y = 0 is the top.
gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageOrVideoOrCanvas);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

// Each frame: upload the new frame (texImage2D again for video), set t, draw.
gl.useProgram(program);
gl.uniform1i(gl.getUniformLocation(program, 'image'), 0);
gl.uniform2f(gl.getUniformLocation(program, 'resolution'), canvas.width, canvas.height);
gl.uniform1f(gl.getUniformLocation(program, 't'), frameIndex);
gl.drawArrays(gl.TRIANGLES, 0, 3);
```

For WebGL 2, pass `{ version: 300 }` to both `filterShader` and
`filterVertexShader`. `npm run check` runs every library filter
through real WebGL in headless Chrome (`--webgl2` for the ES 3.0 output). To process a GIF or video offline, draw each frame
to a canvas, upload it, draw, and read the canvas back (`toBlob` or
`readPixels`).
<!-- /dev -->

## Sharing filters

A filter is a small JSON document: the maths, a name and author, and the
knobs it exposes. Since it is only maths, it is safe to accept from
anyone — it can read the picture and write colours, nothing else.

```json
{
  "format": "mathzetta-filter/1",
  "name": "Threshold",
  "author": "Ada",
  "description": "Black or white, at a cutoff you choose",
  "params": { "cutoff": { "default": 0.5, "min": 0, "max": 1 } },
  "color": "if gray > cutoff then 1 else 0"
}
```

- `color` is one expression for the colour, or an object with any of
  `r`, `g`, `b`, `a`, `rgb`, `rgba` — exactly as `filterShader()` takes.
- `params` are the knobs. Each is a number (`"cutoff": 0.5` means
  0–1; larger defaults get 0–2×) or `{ "default", "min", "max", "step",
  "label" }`, or a colour: `"tint": [1, 0.85, 0.7]` (three numbers, 0–1).
  A parameter is a value, never a function, so `strength (x + 1)` is a
  product.
  A number knob is a slider, unless it has `"options": [2, 4, 8]` (a menu
  of those values; the default is the first unless given) or
  `"input": "box"` (a box to type a value in — any maths that works out
  to a number, such as `1/3`).
- `notes` is the filter's page, shown in its step in the editor: a list of
  Markdown texts (maths in `$…$` is drawn by Inline Math, and `{{cutoff}}`
  inside it is a knob's value) and `{ "param": "cutoff" }` entries that
  place a knob's input among them; knobs it doesn't place come first.
  Notes never change the picture.

  ```json
  "notes": ["Pixels darker than the cutoff go black.", { "param": "cutoff" }, "Now at ${{cutoff}}$."]
  ```
- `name`, `author`, `description` are free text; `format` says which
  version of this format the document follows.

In the editor each knob is written as an Inline Math variable, one line
you can edit (shown while the step's *Edit* is on): `cutoff := [[0..1 step 0.01 = 0.5]]` (a slider: from, to,
its step, where it starts), `radius := [[3]]` (a box), `levels := [[2 | 4 | 8]]`
(a menu) or `tint := #ff8800` (a colour). Renaming a knob there renames it
in the maths too.

### Combining filters

A chain lists steps. Each step is a filter — pasted in whole, so the
chain stays self-contained — or just an expression, with optional
settings for its parameters, an **opacity** (how much of the step's
result shows over its input), and `"skip": true` to switch it off
without removing it (a chain with every step off shows the picture
as it is):

```json
{
  "format": "mathzetta-filter/1",
  "name": "Old film",
  "author": "Bo",
  "steps": [
    { "name": "Sepia", "color": "(0.393r + 0.769g + 0.189b, 0.349r + 0.686g + 0.168b, 0.272r + 0.534g + 0.131b)" },
    { "filter": { "name": "Vignette", "params": { "strength": 1.6 }, "color": "rgb * (1 - strength ((x - 0.5)^2 + (y - 0.5)^2))" },
      "with": { "strength": 1.2 } },
    { "filter": "if py mod 4 < 2 then rgb else rgb * 0.6", "opacity": 0.5 }
  ]
}
```

A chain is a filter, so Bo's "Old film" can be one step of your chain,
at half strength and with its vignette turned up:

```json
{ "steps": [ { "filter": { …Old film… }, "opacity": 0.5, "with": { "strength": 2 } }, "rgb * 1.1" ] }
```

`with` on a chain reaches every parameter of that name inside it, and
the outer setting wins — whoever is combining decides. Compiling lists
the names and authors of everything used as `credits`.

<!-- dev -->
### The API

[qblur on your own pages](library.md) is the full account: the CDN, the builds, running on the GPU, the CPU
and in Node, knobs, video, other pictures, text, sharing and every export, with examples that are run as tests.

```js
import { compileFilter, createFilterRunner, filterToLink, readFilter } from 'qblur';

const compiled = compileFilter(def);             // def: JSON, or a string expression
compiled.passes;                                 // shader passes, in order
compiled.credits;                                // [{ name: 'Sepia', author: '' }, …]

const runner = createFilterRunner(gl, compiled); // WebGL 1 or 2 (compileFilter(def, { version: 300 }))
runner.setImage(image);                          // <img>, <video>, <canvas>, ImageData — again for each video frame
runner.setImage('mask', maskImage);              // each picture in compiled.images
runner.draw({ t: frameIndex });                  // onto the canvas gl belongs to
runner.passes[0].values.cutoff = 0.3;            // knobs change live, no recompiling
runner.passes[0].placements.inset.x = 0.2;       // so does where a picture sits (changing `place` needs a recompile)

createFilterRunner(gl, compiled, { precision: 'half' });   // keep values over 1 between passes (bloom, edges); runner.precision says what the GPU gave
runner.dispose();
```

| Function | Does |
| --- | --- |
| `validateFilter(def)` | every problem, as messages naming the filter: `"Threshold": "with" sets "nope", but there is no parameter called that` |
| `normalizeFilter(def)` | the full form: types and ranges on params, `with` and `opacity` on steps |
| `filterParams(filter)` | every parameter a filter or chain exposes |
| `filterImages(filter)` | every picture a filter or chain needs, by name, with how it is placed |
| `PLACEMENT` | the default placement: `{ place: 'cover', zoom: 1, x: 0.5, y: 0.5, angle: 0 }` |
| `filterToJSON(def)` / `filterFromJSON(text)` | JSON to publish (defaults left out) and back |
| `filterToLink(def, pageUrl)` / `filterFromLink(text)` | the filter packed into a URL's `#…` and back |
| `readFilter(text)` | whatever was pasted: JSON, a link, or a bare expression |

A chain compiles to one pass per filter, each drawn into a texture the
next pass reads (so `pixel(px, py)` in step two sees step one's result,
while `source` is still the original).
A chain used at partial opacity keeps its input and ends with a blend
pass. Parameters become uniforms; `t` and the picture are shared by
every pass.
<!-- /dev -->

## Format stability

Share links carry the whole filter, so a link made today must open
tomorrow. The rules, from `mathzetta-filter/1` on:

- **Additions only.** New keys, new functions in expressions, new
  placement modes may arrive; nothing existing changes meaning or goes
  away. A document that uses only what this guide describes keeps
  working in every later version.
- **Unknown top-level keys are ignored**, so a document written by a
  newer version still opens in an older one (minus what it doesn't
  know). Unknown *settings* inside `params`, `images` or `with` are
  errors, because they would silently change the result.
- **A breaking change means a new `format`** (`mathzetta-filter/2`), and
  `readFilter()` will convert `/1` documents to it. An unknown format is
  refused with a clear message rather than guessed at.
- Expression semantics are pinned by tests: the GPU and the CPU must
  agree, so a change to what `shift` or `gaussian` means would show up there.

## What doesn't carry over to a shader

`toGLSL()` renders everything the parser understands, but a shader can
only run what has a numeric meaning per pixel:

- **Not available:** derivatives, integrals, limits, sums with an index
  (`\sum_{i=1}^{n}`), set union/intersection, strings. These come out as
  calls to functions you would have to write (`derivative(…)`,
  `summation(…)`).
- **Needs care:** `x^y` with a negative `x` is undefined in GLSL (small
  whole powers are safe — they're written as products); `log` of a
  non-positive number; `pow`, `exp` overflowing to infinity. `n!`, `gcd`
  and `perm` loop on the GPU and are slow.
- **Typing:** every number is a float. Logic (`&`, `|`, `!`) needs
  comparisons as operands; chained comparisons like `0 < x < 1` must be
  written `0 < x & x < 1`; `±` gives a two-component vector.
- **Names:** `x y r g b a t w h px py rgb gray unchanged` are taken, as
  are GLSL's own words (`in`, `out`, `float`, `main`, …). Greek letters are
  spelled out (`θ` → `theta`), primes become `_prime`. `f`, `g` and `h`
  followed by a bracket are read as function calls, as in maths: write
  `g * (1 - r)`, not `g(1 - r)`.

MathZetta's [how it works](https://github.com/triplelog/mathzetta/blob/main/packages/mathzetta/docs/how-it-works.md)
describes the GLSL renderer itself, and its
[glsl.tsv](https://github.com/triplelog/mathzetta/blob/main/packages/mathzetta/test/cases/glsl.tsv) lists
filter-style expressions with their GLSL.
