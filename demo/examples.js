/**
 * The examples: a guided tour of what filters can do, each on a picture
 * that suits it, with the features it shows and its maths explained in
 * steps. Plain data; the page renders it, test/examples.test.js checks
 * every one compiles, and tools/check.mjs runs every one in WebGL.
 *
 * `picture` is a photo's file name in demo/photos/index.json (or 'test' for
 * the drawn test picture); the page falls back to the first photo.
 * `filter` is an ordinary filter document — a single filter or a chain.
 * In `how`, `code` spans are written with backticks.
 */

const caption = (text, extra = {}) => ({
    graphics: { title: { text, y: 0.88, size: 0.075, ...extra } },
    color: 'mix(rgb, title, alpha(title))',
});

export const EXAMPLES = [
    {
        id: 'first',
        title: 'Your first filter',
        picture: 'charleston.jpg',
        shows: ['maths on every pixel'],
        how: [
            'A filter is one line of maths run on every pixel. `rgb` is the pixel\'s colour, three numbers from 0 to 1.',
            '`1 - rgb` turns each number around: dark becomes light, red becomes cyan. That is the whole filter.',
            'Try changing it in the step below: `rgb * 1.3` brightens, `rgb ^ 2` deepens the shadows, `(g, r, b)` swaps red and green.',
        ],
        filter: { name: 'Negative', steps: ['1 - rgb'] },
    },
    {
        id: 'duotone',
        title: 'Duotone with two colour knobs',
        picture: 'mountains.jpg',
        shows: ['knobs (params)', 'mix'],
        how: [
            '`gray` is how bright the pixel looks. `mix(dark, light, gray)` paints black pixels in one colour, white in the other, and blends between.',
            '`dark` and `light` are knobs: declared in "params" with a colour each, they show up as colour pickers under the step — and travel in a share link with whatever you pick.',
        ],
        filter: {
            name: 'Duotone', params: { dark: [0.12, 0.09, 0.35], light: [1, 0.78, 0.45] },
            color: 'mix(dark, light, gray)',
        },
    },
    {
        id: 'splash',
        title: 'Colour splash: keep only the reds',
        picture: 'redumbrella.jpg',
        shows: ['colour spaces', 'conditions', 'knobs'],
        how: [
            '`tohsv(rgb)` gives hue, saturation and value; `red(…)` of it is the hue, 0–1 round the colour wheel, where red sits at both ends.',
            '`if … then rgb else (gray, gray, gray)` keeps the pixel\'s colour only when the condition holds; elsewhere it is grey. Both sides of an `if` must be the same kind of thing — `rgb` is a colour, so the grey is written as one too.',
            'The condition asks for a hue near red (the `band` knob) that is also strongly saturated (the `vivid` knob): the whole scene is warm, and without that the red-brown dome and coats would count too. Drag the knobs to see.',
        ],
        filter: {
            name: 'Colour splash', params: { band: { default: 0.035, min: 0.01, max: 0.2 }, vivid: { default: 0.62, min: 0, max: 1 } },
            color: 'if (red(tohsv(rgb)) < band | red(tohsv(rgb)) > 1 - band) & green(tohsv(rgb)) > vivid then rgb else (gray, gray, gray)',
        },
    },
    {
        id: 'tiltshift',
        title: 'Tilt-shift miniature',
        picture: 'cityabove.jpg',
        shows: ['neighbouring pixels', 'position (y)', 'chains', 'colour spaces'],
        how: [
            'Seen from above, a real city looks like a model when only a band of it is sharp — as with a close-up lens. Step 1: `gaussian(4)` is a blur — it looks at the pixels around this one. `smoothstep(0.06, 0.25, abs(y - focus))` is 0 near the line `y = focus` and rises to 1 away from it, so the picture is sharp in a band and blurred above and below.',
            'Step 2 works in HSV (the space chooser beside the step): `g` is the saturation there, so `g * 1.4` makes the colours toy-like.',
            'Steps run top to bottom, each on the result of the one before; drag them to reorder, untick to skip.',
        ],
        filter: {
            name: 'Tilt-shift',
            steps: [
                { params: { focus: { default: 0.55, min: 0, max: 1 } }, color: 'mix(rgb, gaussian(4), smoothstep(0.06, 0.25, abs(y - focus)))' },
                { space: 'hsv', color: '(r, clamp(g * 1.4, 0, 1), b)' },
            ],
        },
    },
    {
        id: 'neon',
        title: 'Neon edges',
        picture: 'cityabove.jpg',
        shows: ['edge detection', 'colour by position'],
        how: [
            '`sobel()` is how fast the brightness changes around the pixel — large on edges, near 0 on flat areas.',
            '`mix((1, 0.2, 0.7), (0.2, 0.9, 1), x)` is a colour that goes from pink on the left to cyan on the right.',
            'The picture is darkened to `rgb * 0.15` and the edges are added in that colour, brighter where they are stronger.',
        ],
        filter: { name: 'Neon edges', params: { glow: { default: 2.5, min: 0.5, max: 6 } }, color: 'rgb * 0.15 + mix((1, 0.2, 0.7), (0.2, 0.9, 1), x) * min(glow sobel(), 1)' },
    },
    {
        id: 'glitch',
        title: 'Animated glitch on a video',
        picture: 'citytraffic.mp4',
        shows: ['animation with t', 'reading other pixels'],
        how: [
            'On a video, `t` counts its frames; on a photo, it counts while "play" is ticked. Anything with `t` in it moves.',
            '`red(px + s, py)` reads the red of the pixel `s` to the right; taking red and blue from opposite sides splits the colours apart.',
            '`s = 8 sin(t / 6)` makes the split swing back and forth; `if py mod 4 < 2 …` darkens every other pair of rows into scanlines.',
        ],
        filter: {
            name: 'Glitch',
            steps: [
                '(red(px + 8 sin(t / 6), py), g, blue(px - 8 sin(t / 6), py))',
                'if py mod 4 < 2 then rgb else rgb * 0.75',
            ],
        },
    },
    {
        id: 'comic',
        title: 'Comic poster with a title',
        picture: 'charleston.jpg',
        shows: ['chains of other people\'s filters', 'text with an outline'],
        how: [
            'This chain reuses filters from the library: Comic (itself a chain of four: a small blur, bolder colours, the colours flattened to four levels with `floor(rgb * levels) / (levels - 1)`, then ink on the edges with `rgb (1 - gain sobel())`) and Poster title.',
            'The blur comes first so that only real edges get ink — on a photo, every leaf and crack would count as an edge otherwise.',
            'Each step keeps its own knobs, and a chain can set them: here the title\'s words are changed with "with", the way a share link would carry them.',
            'Click the words under the step to change them; drag them on the picture to move them.',
        ],
        filter: {
            name: 'Comic poster',
            steps: [
                { filter: 'library:Comic' },
                { filter: 'library:Poster title', with: { title: { text: 'RAINBOW ROW', size: 0.13 } } },
            ],
        },
    },
    {
        id: 'titlecard',
        title: 'Title card with a layered shadow',
        picture: 'minimaldesk.jpg',
        shows: ['shapes with their own filter', 'shadow layers', 'Google Fonts'],
        how: [
            'Step 1 draws a rounded rectangle called `panel` and uses it only as a place: `mix(rgb, gaussian(6) * 0.6, alpha(panel))` blurs and darkens what is behind it — frosted glass.',
            'Step 2 is text in the Google font Playfair Display with two shadow layers, each a picture of its own: `title_shadow1` is a wide soft shadow, `title_shadow2` a hard gold offset — the maths lays each on separately.',
            'Change the font under the step: pick one, type another Google Fonts name, or load a font file.',
        ],
        filter: {
            name: 'Title card',
            steps: [
                { graphics: { panel: { type: 'rect', x: 0.62, y: 0.32, w: 0.62, h: 0.26, radius: 0.2 } }, color: 'mix(rgb, gaussian(6) * 0.6, alpha(panel))' },
                {
                    graphics: { title: {
                        text: 'Less, but better', font: 'Georgia, serif', fontUrl: 'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&display=swap',
                        size: 0.085, x: 0.62, y: 0.32, shadow: null,
                        shadows: [{ color: '#000000', blur: 0.8, dx: 0, dy: 0.1 }, { color: '#000000', blur: 0, dx: 0.04, dy: 0.04 }],
                    } },
                    color: 'mix(mix(mix(rgb, rgb * 0.4, alpha(title_shadow1)), (0.95, 0.75, 0.3), alpha(title_shadow2)), title, alpha(title))',
                },
            ],
        },
    },
    {
        id: 'kenburns',
        title: 'Ken Burns with a caption fading in',
        picture: 'mountains.jpg',
        shows: ['animation with t', 'zoom', 'text'],
        how: [
            'Step 1: `zoom(1 + 0.0015 t, 0.45, 0.5)` reads the picture a little closer each frame — a still photo that moves, like a documentary.',
            'Step 2: the caption\'s visibility is `alpha(title)` times `clamp((t - 30) / 40, 0, 1)` — nothing for 30 frames, then fading in over 40.',
            'Save as GIF or Record writes the animation; "auto" in Export picks the smallest file for a still.',
        ],
        filter: {
            name: 'Ken Burns',
            steps: [
                'zoom(1 + 0.0015 t, 0.45, 0.5)',
                { ...caption('Somewhere in the hills', { font: 'Georgia, serif', style: 'italic', weight: 'normal' }), color: 'mix(rgb, title, alpha(title) clamp((t - 30) / 40, 0, 1))' },
            ],
        },
    },
    {
        id: 'hue',
        title: 'Hue cycle on a video',
        picture: 'waves.mp4',
        shows: ['colour spaces', 'animation with t'],
        how: [
            'The step works in HSV (the chooser beside it), where `r` is the hue — 0 to 1 round the colour wheel.',
            '`fract(r + t / 100)` adds a little more each frame and wraps round past 1, so the sea turns green, purple, red and back.',
            'Save as GIF or Record 5 s writes the result; the video loops, and so does the colour.',
        ],
        filter: { name: 'Hue cycle', steps: [{ space: 'hsv', color: '(fract(r + t / 100), g, b)' }] },
    },
    {
        id: 'brush',
        title: 'Brushes: paint that glows, then cools',
        picture: 'charleston.jpg',
        shows: ['brushes', 'animation with t', 'paint that changes with age'],
        how: [
            'A brush records what you paint, point by point with its timing and pressure, and draws it again for every frame — press play and the scribble draws itself at the speed it was drawn.',
            'Its picture carries data: `alpha(brush)` is where the paint is, `red(brush)` how long ago it was painted (0 just now, 1 after 40 frames). `mix((1, 0.9, 0.5), (0.1, 0.07, 0.06), red(brush))` is yellow-white when fresh and charcoal when old — so the line glows at its tip and cools behind it.',
            'Paint your own: in its step, click "draw" and paint on the picture (top left); "replay" plays it. "the paint" chooses other effects — a blur that grows with every pass, a rainbow along the drawing — and "outline the selection" draws round whatever is selected.',
        ],
        filter: {
            name: 'Fuse',
            steps: [{
                filter: 'library:Fuse brush',
                with: { brush: { size: 0.022, strokes: [{ points: Array.from({ length: 90 }, (_, k) => {
                    const u = k / 89;
                    return [+(0.08 + 0.84 * u).toFixed(4), +(0.5 + 0.07 * Math.sin(u * Math.PI * 7) * (1 - 0.5 * u)).toFixed(4), Math.round(u * 2400), +(0.45 + 0.55 * Math.sin(u * Math.PI)).toFixed(2)];
                }) }] } },
            }],
        },
    },
    {
        id: 'track',
        title: 'Track a person through a video',
        picture: 'personwalking.mp4',
        shows: ['tracking', 'selections', 'AI object finding'],
        how: [
            'The maths is `mix((gray, gray, gray), rgb, selected)`: grey everywhere except what is selected. Tracking makes the selection follow the man through every frame.',
            'Under the picture, in "Track an object": press "❚❚ pause" on the first frame. Select him — "find objects (AI)" and click inside his box, or "trace the edge" — then "use as keyframe", then "track".',
            'The timeline turns green where the tracker is sure and red where it is not. Click a red frame, fix the outline ("edit this frame", or select again), "use as keyframe", and "track" again — or "fix red frames with AI".',
        ],
        filter: { name: 'Colour on the person', steps: ['mix((gray, gray, gray), rgb, selected)'] },
    },
    {
        id: 'chroma',
        title: 'Green screen: a new background',
        picture: 'greenscreen.jpg',
        shows: ['colour spaces', 'conditions', 'colour by position'],
        how: [
            '`tohsv(rgb)` again: green is a hue of about 0.33. A pixel is "screen" when its hue is within `band` of that and it is saturated enough (the mannequin\'s skin is not).',
            'Where it is screen, `mix((0.95, 0.55, 0.45), (0.15, 0.2, 0.5), y)` paints a sunset, warm at the top and deep blue at the bottom; everywhere else the photo stays.',
            'To put another picture there instead, use "Chroma key onto a picture" from the library: it asks for a `background` picture.',
        ],
        filter: {
            name: 'New background', params: { band: { default: 0.09, min: 0.02, max: 0.2 } },
            color: 'if abs(red(tohsv(rgb)) - 0.33) < band & green(tohsv(rgb)) > 0.45 then mix((0.95, 0.55, 0.45), (0.15, 0.2, 0.5), y) else rgb',
        },
    },
    {
        id: 'canny',
        title: 'Canny edges: clean lines in nine passes',
        picture: 'contrastarchitecture.jpg',
        shows: ['multi-pass chains', 'neighbouring pixels'],
        how: [
            'Canny is the classic way to find thin, clean edges, and here it is just a chain of expressions — open each step to read them.',
            'Blur a little; measure how strongly and in which direction the brightness changes (`sobel()`, `atan2(sobely(), sobelx())`); keep only pixels stronger than their neighbours across the edge, so lines are one pixel thin.',
            'Then two thresholds (the `low` and `high` knobs): strong pixels are edges, weak ones only if they touch a strong one — three rounds of `red(dilate(1))` spread that along each line.',
        ],
        filter: { name: 'Canny', steps: [{ filter: 'library:Canny edges' }] },
    },
    {
        id: 'aiblur',
        title: 'Portrait: blur the background (select with AI)',
        picture: 'portrait.jpg',
        shows: ['selections', 'AI object finding', 'neighbouring pixels'],
        how: [
            'The maths is `mix(gaussian(5) * 0.85, rgb, selected)`: blurred and a little darker where `selected` is 0, the photo where it is 1.',
            'Nothing changes until something is selected (without a selection `selected` is 1 everywhere). Under the picture, click "find objects (AI)" and then click the man — the object model outlines him — and press Enter. Or use "trace the edge" and click around him.',
            'Tick "invert" to blur him instead; drag "feather" to soften the edge of the selection.',
        ],
        filter: { name: 'Background blur', steps: ['mix(gaussian(5) * 0.85, rgb, selected)'] },
    },
    {
        id: 'film',
        title: 'Old film look on a video, with a title',
        picture: 'personwalking.mp4',
        shows: ['chains', 'random()', 'text', 'animation with t'],
        how: [
            'Old film from the library (sepia, a vignette, faint scanlines), then Film grain: `rgb + amount (random() - 0.5)` — `random()` is new on every pixel and every frame, so the grain crawls like real film.',
            'Last, a caption that fades in after a second: `alpha(title) clamp((t - 30) / 30, 0, 1)`.',
            'Record 5 s of video, or Save as GIF, writes the filtered clip.',
        ],
        filter: {
            name: 'Old film',
            steps: [
                { filter: 'library:Old film' },
                { filter: 'library:Film grain', with: { amount: 0.12 } },
                { ...caption('Chicago, 1924', { font: 'Georgia, serif', style: 'italic', weight: 'normal', color: '#f3e6c8' }), color: 'mix(rgb, title, alpha(title) clamp((t - 30) / 30, 0, 1))' },
            ],
        },
    },
];

/** An example's filter with `library:Name` steps replaced by those library filters. */
export function resolveExample(example, library) {
    const resolve = (step) => {
        if (step && typeof step === 'object' && typeof step.filter === 'string' && step.filter.startsWith('library:')) {
            const found = library.find((f) => f.name === step.filter.slice(8));
            if (!found) throw new Error(`Example "${example.title}": no "${step.filter.slice(8)}" in the library`);
            return { ...step, filter: found };
        }
        return step;
    };
    const f = example.filter;
    return f.steps ? { ...f, steps: f.steps.map(resolve) } : f;
}
