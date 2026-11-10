/**
 * The editor's cheat sheet, and the hints that go with error messages.
 *
 * Plain data and functions (no DOM), so the page renders HELP and the tests
 * read it: every section's `guide` must be a heading in docs/filters.md.
 * An example is a bare expression, or `{ def, show }` when it needs a
 * filter document (pictures, params); "Try" adds it to the chain.
 */

export const HELP = [
    {
        id: 'pixel', title: 'The pixel', guide: 'what-an-expression-can-use',
        rows: [
            ['r g b a', 'its red, green, blue and alpha, 0–1'],
            ['rgb', 'all three as one colour'],
            ['gray', 'its brightness'],
            ['x y', 'where it is: 0–1 across and down'],
            ['px py', 'the same in pixels'],
            ['w h', 'the picture\'s width and height'],
            ['t', 'the frame number — put it in the maths and the picture moves'],
            ['random()', 'a new number 0–1 for every pixel, every frame'],
        ],
        examples: [
            ['1 - rgb', 'invert'],
            ['gray', 'black and white'],
            ['rgb * (1 - 1.6 ((x - 0.5)^2 + (y - 0.5)^2))', 'vignette'],
            ['rgb (0.75 + 0.25 sin(t / 6))', 'pulsing'],
        ],
    },
    {
        id: 'results', title: 'What a result can be', guide: 'results-numbers-colours-truefalse',
        rows: [
            ['a number', 'grey — or, for one channel, that channel'],
            ['(r, g, b)', 'a colour'],
            ['r > 0.5', 'a comparison: 1 where true, 0 where false — a mask to multiply by'],
            ['unchanged', 'what the step started with'],
        ],
        examples: [
            ['(g, r, b)', 'swap red and green'],
            ['(r > 0.5) rgb', 'keep only where red is strong'],
        ],
    },
    {
        id: 'if', title: 'Conditions', guide: 'conditionals',
        note: 'Both branches must be the same kind of thing: two numbers, or two colours.',
        rows: [
            ['if c then a else b', ''],
            ['if c then a', 'without an else the pixel keeps its value'],
            ['a & b   a | b   !a', 'and, or, not'],
            ['IF(c, a, b)   c ? a : b', 'the same, spreadsheet and C style'],
        ],
        examples: [
            ['if gray > 0.5 then 1 else 0', 'threshold'],
            ['if y < 0.5 then rgb else 1 - rgb', 'invert the bottom half'],
            ['if g > 0.5 & g > 1.3 r & g > 1.3 b then (0.1, 0.1, 0.4) else rgb', 'chroma key'],
        ],
    },
    {
        id: 'near', title: 'Nearby pixels', guide: 'blur-edges-and-other-neighbourhood-functions',
        rows: [
            ['pixel(px, py)', 'the pixel there'],
            ['red(px, py) … luma(px, py)', 'one of its channels'],
            ['blur(radius)   gaussian(sigma)', 'blurs — alone in a step, computed in two fast passes that reach ±24 px'],
            ['blurx blury gaussianx gaussiany', 'along one axis'],
            ['sharpen(amount)', ''],
            ['sobel()   laplacian()   emboss()', 'edge strength, relief — "Canny edges" in the library chains them into clean lines'],
            ['dilate(r)   erode(r)', 'light or dark areas grow'],
            ['convolve(k1, …, k9)', 'your own 3×3 kernel'],
        ],
        examples: [
            ['gaussian(3)', 'blur'],
            ['rgb + 1.5 (rgb - gaussian(2))', 'unsharp mask'],
            ['if sobel() > 0.3 then 1 else 0', 'edge map'],
            ['pixel(w - px, py)', 'mirror'],
        ],
    },
    {
        id: 'move', title: 'Moving the picture', guide: 'moving-the-picture-zoom-pan-rotate-crop-tile',
        rows: [
            ['zoom(s)   zoom(s, cx, cy)', 's times larger, about the centre or a point (0–1)'],
            ['shift(dx, dy)', 'moved by that many pixels, wrapping around'],
            ['rotate(a)', 'turned clockwise, radians — rotate(30°) works'],
            ['crop(x0, y0, x1, y1)', 'that part (0–1) filling the frame'],
            ['tile(n)', 'repeated n × n'],
            ['flipx()   flipy()', 'mirrored'],
            ['zoom(overlay, 2)', '…any of them on another picture'],
            ['alpha(zoom(0.5))', '1 inside the picture, 0 outside'],
        ],
        note: 'On its own, a moved picture is transparent where it leaves the frame (zoom out, rotate); inside a bigger expression it is black there, and alpha(zoom(…)) tells you where it is.',
        examples: [
            ['zoom(1 + 0.002 t, 0.5 + 0.0003 t, 0.45)', 'Ken Burns'],
            ['shift(2 t, 0)', 'scrolling'],
            ['rotate(t / 100)', 'spinning'],
            ['tile(2)', 'four copies'],
        ],
    },
    {
        id: 'pictures', title: 'Other pictures', guide: 'several-pictures-masks-and-blending',
        note: 'A filter names the pictures it needs — "images": ["mask"] in its JSON — and the editor shows a chooser and placement knobs for each.',
        rows: [
            ['source', 'the picture before any step'],
            ['mask   overlay   …', 'a named picture: its colour at this pixel'],
            ['overlay(px, py)', 'any pixel of it'],
            ['luma(mask)   alpha(overlay)   red(…)', 'one channel of it'],
            ['width(overlay)   height(overlay)', 'its size'],
            ['selected', '1 inside the object you selected on the picture (trace its edge — click past the picture to run along its border —, click its colours, or let the AI find it; the refine brush paints parts in or out and the edge settles), 0 outside — 1 everywhere without a selection. On a video or GIF, "Track an object" makes it follow the object frame by frame'],
        ],
        examples: [
            { def: { images: ['overlay'], color: 'mix(rgb, overlay, 0.5)' }, show: '{ "images": ["overlay"], "color": "mix(rgb, overlay, 0.5)" }', caption: 'fade to another picture' },
            { def: { images: ['overlay'], color: 'rgb * overlay' }, show: '{ "images": ["overlay"], "color": "rgb * overlay" }', caption: 'multiply' },
            { def: { images: { mask: { description: 'light where the effect shows' } }, color: 'mix(source, rgb, luma(mask))' }, show: '{ "images": ["mask"], "color": "mix(source, rgb, luma(mask))" }', caption: 'put last: the steps above show only where the mask is light' },
            ['mix(source, rgb, selected)', 'put last: the steps above show only inside your selection'],
        ],
    },
    {
        id: 'text', title: 'Text and shapes', guide: 'text-and-shapes',
        note: 'Add with "+ text", "+ rectangle" or "+ oval" under the picture, or from the library\'s Text & shapes. Each graphic is a picture under its name: its colour, and alpha(name) for where it is.',
        rows: [
            ['mix(rgb, title, alpha(title))', 'lay the text on'],
            ['mix(rgb, (1, 0.8, 0.2), alpha(title))', 'in a colour the maths chooses'],
            ['mix(rgb, gaussian(5) * 0.7, alpha(panel))', 'a shape with its own filter: frosted glass'],
            ['shift(title, -3 t, 0)   zoom(title, 1 + 0.06 sin(t / 8))', 'animated, like any picture'],
            ['title_shadow1   title_shadow2', 'its shadow layers ("+ shadow layer"), each a picture of its own: mix(rgb, gaussian(4), alpha(title_shadow1)) gives one its own filter'],
            ['font', 'pick from the list, type a Google Fonts name and press "use", or load a font file'],
            ['alpha(brush)   red(brush)   green(brush)   blue(brush)', 'a brush ("+ brush"): where the paint is, how long ago it was painted (0 → 1), passes ÷ 4, how far through the drawing'],
        ],
        examples: [
            { def: { graphics: { title: { text: 'Hello', y: 0.5, size: 0.12 } }, color: 'mix(rgb, title, alpha(title))' }, show: '{ "graphics": { "title": { "text": "Hello" } }, "color": "mix(rgb, title, alpha(title))" }', caption: 'a caption' },
            { def: { graphics: { title: { text: 'Golden', font: 'Georgia, serif', size: 0.14, y: 0.5 } }, color: 'mix(rgb, mix((1, 0.35, 0.3), (1, 0.85, 0.25), x), alpha(title))' }, show: 'mix(rgb, mix((1, 0.35, 0.3), (1, 0.85, 0.25), x), alpha(title))', caption: 'gradient letters' },
        ],
    },
    {
        id: 'spaces', title: 'Colour spaces', guide: 'colour-spaces',
        note: 'Pick a space next to the expression box (or "space": "hsv" in the JSON) and r g b are hue, saturation, value — every read of the picture is in that space, and the result is converted back. gray is still the brightness you see.',
        rows: [
            ['sRGB', 'what the picture holds; the default'],
            ['linear', 'light, not gamma: blurs and mixes behave like a lens'],
            ['HSV   HSL', 'r g b = hue (0–1 around the wheel), saturation, value / lightness'],
            ['Lab   OKLab', 'r = lightness 0–1, g b = colour axes centred on 0.5'],
            ['YCbCr', 'r = luma, g b = chroma centred on 0.5'],
            ['tohsv(c)   fromhsv(c)   tolab(c)   tooklab(c)   tolinear(c)   …', 'convert a colour yourself, inside any expression'],
        ],
        examples: [
            { def: { space: 'hsv', color: '(fract(r + 0.1), g, b)' }, show: 'HSV: (fract(r + 0.1), g, b)', caption: 'hue shift' },
            { def: { space: 'oklab', color: '(r, 0.5 + (g - 0.5) 1.6, 0.5 + (b - 0.5) 1.6)' }, show: 'OKLab: (r, 0.5 + (g - 0.5) 1.6, 0.5 + (b - 0.5) 1.6)', caption: 'more vivid' },
            ['fromhsv(fract(red(tohsv(rgb)) + t / 300), green(tohsv(rgb)), blue(tohsv(rgb)))', 'hue cycling, in sRGB with conversions'],
        ],
    },
    {
        id: 'params', title: 'Knobs, chains and sharing', guide: 'sharing-filters',
        note: 'Paste a filter\'s JSON into Import, or share yours with Copy link — the link holds the whole filter. Export (under the picture) saves the result at any size, cropped, as PNG, JPEG or WebP; "auto" estimates each and picks the smallest sensible one.',
        rows: [
            ['"params": { "amount": 0.5 }', 'a slider; use amount in the maths'],
            ['"params": { "tint": [1, 0.8, 0.6] }', 'a colour picker'],
            ['"with": { "amount": 0.3 }', 'what a chain sets a step to'],
            ['"opacity": 0.5', 'how much of a step shows'],
        ],
        examples: [
            { def: { name: 'My threshold', params: { cutoff: 0.5 }, color: 'if gray > cutoff then 1 else 0' }, show: '{ "name": "My threshold", "params": { "cutoff": 0.5 }, "color": "if gray > cutoff then 1 else 0" }', caption: 'a filter with a knob' },
        ],
    },
    {
        id: 'maths', title: 'Maths that works', guide: 'what-an-expression-can-use',
        note: 'Colours and numbers combine: rgb * 0.5, rgb + 0.1, 1 - rgb; two colours combine channel by channel. Not here: derivatives, integrals, sums over an index.',
        rows: [
            ['+ − × ÷ ^', 'and writing things next to each other: 2x, rgb overlay'],
            ['sin cos tan asin acos atan2 exp log sqrt abs floor ceil round min max', ''],
            ['a mod b', 'the remainder: py mod 4'],
            ['mix(a, b, k)   clamp(v, 0, 1)   smoothstep(0, 1, v)   step(e, v)   fract(v)   distance(a, b)   length(v)   dot(a, b)', 'from GLSL'],
            ['π   e   30°', 'constants, and degrees'],
        ],
        examples: [
            ['clamp(rgb * 1.4 - 0.2, 0, 1)', 'more contrast'],
            ['mix(rgb, gray, 0.6)', 'desaturate'],
        ],
    },
];

const SECTION = Object.fromEntries(HELP.map((s) => [s.id, s]));

/**
 * An error message, cleaned up and with a hint: which help section (and
 * guide heading) explains it. `{ text, hint?, id?, guide? }`.
 */
export function explain(message) {
    const text = String(message ?? '').replace(/ERROR: \d+:\d+: /g, '').trim();
    const at = (id, hint) => ({ text, hint, id, guide: SECTION[id].guide });
    let m;
    if ((m = /'([^']+)' : undeclared identifier/.exec(text)) || (m = /unknown (?:name|function|picture) "([^"]+)"/.exec(text))) {
        return at('pixel', `"${m[1]}" isn't a name the filter knows. The pixel's names are r g b a rgb gray x y px py w h t; a knob needs "params", another picture needs "images".`);
    }
    if (/mismatching ternary|ternary operator/i.test(text)) return at('if', 'Both sides of an if must be the same kind of thing: two numbers, or two colours like (1, 0, 0) and rgb.');
    if (/no matching overloaded function|wrong operand types|operand types|cannot convert|dimension mismatch/i.test(text)) {
        return at('maths', 'Something got the wrong kind of argument — a colour where a number is needed, or the other way round: mix(colour, colour, number), gaussian(number).');
    }
    if (/Failed to parse|missing an operand|Unmatched|Unexpected|Empty expression|Empty brackets|syntax error/i.test(text)) {
        return at('maths', 'The maths doesn\'t parse: check brackets and operators. Multiply by writing things next to each other (2 rgb) or with *.');
    }
    if (/"with" sets|no parameter called|Parameter |"params"|should be a (?:number|colour)/i.test(text)) return at('params', 'Knobs are declared in "params" and set with "with"; a chain can only set knobs its filters have.');
    if (/Image |"images"|"place"|is both a parameter and an image|always available/i.test(text)) return at('pictures', 'Pictures are declared in "images"; each can be placed with place, zoom, x, y and angle.');
    if (/not allowed|refused|unsafe/i.test(text)) return at('maths', 'That isn\'t something a filter can do — only the maths listed here runs.');
    if (/context (?:was|is) lost/i.test(text)) return { text, hint: 'Waiting for the GPU. If it keeps happening, choose CPU under "runs on".' };
    if (/not a filter|Not valid JSON|Not a filter link|Unknown filter format/i.test(text)) return at('params', 'Paste a filter\'s JSON, a share link, or just an expression.');
    return { text };
}
