/* qblur — MIT licence; mathzetta loads from jsDelivr */
import { FILTER_NAMES, COLOUR_SPACES, PLACES, filterShader, filterVertexShader, REACH, FILTER_FUNCTIONS, FILTER_VALUES, filterPictureCalls } from 'mathzetta/glsl';
import { parseTree } from 'mathzetta';
import { checkGeneratedJs } from 'mathzetta/formulas';

/**
 * Brush strokes: a graphic painted by hand, drawn again for every frame.
 *
 * A strokes graphic records each stroke's points as the user drew them —
 * [x, y, ms, pressure], x and y as fractions of the frame — and a brush.
 * For frame t it becomes a picture whose channels are data, not colour:
 *
 *   alpha   coverage: how much paint is here so far, 0–1
 *   red     age: how long ago this pixel was last painted, 0 (just now) → 1 (`age` frames or more)
 *   green   passes ÷ 4: how many strokes have gone over it (soft brushes count partly)
 *   blue    progress: how far through the whole drawing it was painted, 0 → 1
 *
 * so the maths decides what the paint does:
 *
 *   mix(rgb, ink, alpha(brush))                                        ink
 *   mix(rgb, gaussian(2 + 3 min(4 green(brush), 3)), alpha(brush))     a blur that grows with every pass
 *   mix(rgb, mix((1, 0.85, 0.35), (0.12, 0.08, 0.06), red(brush)), alpha(brush))   glowing, then cooling
 *   mix(rgb, fromhsv(blue(brush), 0.85, 1), alpha(brush))              a rainbow along the drawing
 *
 * Only paint laid down by frame t is there, so the drawing animates.
 * Timing: `recorded` (the user's own speed; pauses between strokes become
 * `gap` frames), `even` (time follows the length drawn), or `per-stroke`
 * (every stroke takes the same time); `speed` scales it, `start` delays it,
 * `fit` stretches the whole drawing to that many frames. `clip` keeps the
 * paint inside (or outside) a mask — the editor passes the selection.
 *
 *   normalizeStrokes(name, spec)                  the spec in full, or an error naming what is wrong
 *   strokeTimeline(spec, aspect)                  every point's frame and width; .total frames
 *   rasterizeStrokes(spec, w, h, t, { mask })     → ImageData-like { data, width, height }
 *   traceContours(mask, w, h)                     the outlines of a mask, as polylines (for "outline the selection")
 */

const BRUSHES = ['round', 'soft', 'marker', 'chalk', 'spray'];
const TIMINGS = ['recorded', 'even', 'per-stroke'];
const WIDTH_FROM = ['pressure', 'speed', 'none'];
const CLIPS = ['none', 'inside', 'outside'];

const STROKES_DEFAULTS = {
    type: 'strokes', strokes: [], brush: 'round', size: 0.03, flow: 1, spacing: 0.2, taper: 0, buildUp: false, widthFrom: 'pressure',
    timing: 'recorded', speed: 1, gap: 6, start: 0, fit: 0, age: 30, clip: 'none', shadows: [],
};

const MAX_POINTS = 60000;

function fail(name, text) { throw new Error(`Graphic "${name}": ${text}`); }

function num$1(name, key, value, min, max) {
    const v = Number(value);
    if (!Number.isFinite(v) || v < min || v > max) fail(name, `"${key}" is a number from ${min} to ${max}`);
    return v;
}

/** The whole spec, defaults filled in. Points are rounded, so a drawing stays compact. */
function normalizeStrokes(name, spec) {
    for (const key of Object.keys(spec)) if (!(key in STROKES_DEFAULTS)) fail(name, `no such setting "${key}" for strokes`);
    const s = { ...STROKES_DEFAULTS, ...spec };
    const choose = (key, list) => { if (!list.includes(s[key])) fail(name, `"${key}" is ${list.join(', ')} — not "${s[key]}"`); return s[key]; };
    const out = {
        type: 'strokes',
        brush: choose('brush', BRUSHES), widthFrom: choose('widthFrom', WIDTH_FROM), timing: choose('timing', TIMINGS), clip: choose('clip', CLIPS),
        size: num$1(name, 'size', s.size, 0.001, 0.5), flow: num$1(name, 'flow', s.flow, 0.01, 1), spacing: num$1(name, 'spacing', s.spacing, 0.02, 2),
        taper: num$1(name, 'taper', s.taper, 0, 0.5), speed: num$1(name, 'speed', s.speed, 0.05, 20), gap: num$1(name, 'gap', s.gap, 0, 600),
        start: num$1(name, 'start', s.start, 0, 10000), fit: num$1(name, 'fit', s.fit, 0, 10000), age: num$1(name, 'age', s.age, 1, 10000),
        buildUp: Boolean(s.buildUp), shadows: [],
    };
    if (!Array.isArray(s.strokes)) fail(name, '"strokes" is a list of { "points": [[x, y, ms, pressure], …] }');
    let count = 0;
    out.strokes = s.strokes.map((stroke, k) => {
        const points = Array.isArray(stroke) ? stroke : stroke?.points;
        if (!Array.isArray(points)) fail(name, `stroke ${k + 1} is { "points": [[x, y, ms, pressure], …] }`);
        count += points.length;
        if (count > MAX_POINTS) fail(name, `a drawing has at most ${MAX_POINTS} points`);
        return {
            points: points.map((p, j) => {
                if (!Array.isArray(p) || p.length < 2 || !p.every((v) => Number.isFinite(Number(v)))) fail(name, `stroke ${k + 1}, point ${j + 1} is [x, y, ms, pressure]`);
                return [+Number(p[0]).toFixed(4), +Number(p[1]).toFixed(4), Math.round(Number(p[2] ?? j * 16)), +Math.min(1, Math.max(0, Number(p[3] ?? 1))).toFixed(2)];
            }),
        };
    });
    return out;
}

/**
 * Text and shapes as pictures.
 *
 * A filter's `graphics` names things to draw — text, rectangles, ovals —
 * each rasterized into a transparent picture the size of the frame under
 * its name. The maths then treats it like any picture: `title` is its
 * colour, `alpha(title)` where it is, so
 *
 *   mix(rgb, title, alpha(title))                      lays the text on
 *   mix(rgb, gaussian(6) * 0.8, alpha(panel))          frosts the picture behind a panel
 *   mix(rgb, shift(title, 3t, 0), alpha(shift(title, 3t, 0)))   scrolls it
 *
 * A graphic's `shadow` is drawn into it. Its `shadows` — a list, back to
 * front — are drawn each into a picture of its own, `title_shadow1`,
 * `title_shadow2`…, so every shadow layer can have its own maths:
 *
 *   mix(mix(rgb, gaussian(4), alpha(title_shadow1)), title, alpha(title))
 *   mix(mix(rgb, (1, 0.3, 0.6) , alpha(shift(title_shadow1, 2 sin(t / 9), 0))), title, alpha(title))
 *
 * Positions and sizes are fractions of the frame (x, y 0–1; sizes of its
 * height), so a graphic drawn again at export size is crisp and in the
 * same place. Angles are radians, like everything else here.
 *
 *   normalizeGraphic(name, spec)        the full spec, or an error naming what is wrong
 *   drawGraphic(ctx, spec, w, h)        onto any 2D context (canvas, OffscreenCanvas)
 *   await loadGraphicFonts(graphics)    web fonts named by fontUrl, before drawing
 *   await renderGraphics(compiled, w, h) → { key: canvas } for runner.setImage(key, canvas)
 *   (keys are the names, made unique across a chain: `title`, `title~2`…)
 */


const GRAPHIC_TYPES = ['text', 'rect', 'ellipse', 'strokes'];

/** What each kind of graphic is, unless said otherwise. */
const GRAPHIC_DEFAULTS = {
    text: {
        type: 'text', text: 'Text', font: 'sans-serif', weight: 'bold', style: 'normal', size: 0.08,
        x: 0.5, y: 0.85, align: 'center', angle: 0, lineHeight: 1.2, color: '#ffffff',
        outline: null, shadow: { color: 'rgba(0,0,0,0.6)', blur: 0.15, dx: 0.04, dy: 0.06 }, shadows: [],
    },
    rect: { type: 'rect', x: 0.5, y: 0.85, w: 0.8, h: 0.18, radius: 0.15, angle: 0, color: '#ffffff', outline: null, shadow: null, shadows: [] },
    ellipse: { type: 'ellipse', x: 0.5, y: 0.5, w: 0.4, h: 0.4, angle: 0, color: '#ffffff', outline: null, shadow: null, shadows: [] },
};

/** At most this many separate shadow layers per graphic. */
const MAX_SHADOW_LAYERS = 8;

/**
 * The picture names of a graphic's separate shadow layers, back to front:
 * title_shadow1, title_shadow2… Each is a picture of that shadow alone, so
 * the maths can treat it on its own (blur it, colour it, move it with t).
 */
const shadowLayerNames = (name, spec) => (spec.shadows ?? []).map((_, k) => `${name}_shadow${k + 1}`);

const COLOUR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d.,\s%deg/]+\)|[a-z]{3,20}|transparent)$/i;
const FAMILY = /^[\w\s,'"-]{1,80}$/;
const WEIGHTS = ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'];

function colour(name, key, value) {
    if (typeof value !== 'string' || !COLOUR.test(value.trim())) throw new Error(`Graphic "${name}": "${key}" is a colour like "#ffcc00", "rgba(0,0,0,0.5)" or "white"`);
    return value.trim();
}

function number(name, key, value, min = -Infinity, max = Infinity) {
    const v = Number(value);
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`Graphic "${name}": "${key}" is a number${Number.isFinite(min) ? ` from ${min} to ${max}` : ''}`);
    return v;
}

/** `{ color, width }` around the text or shape; width is a fraction of the text size (or of the frame height for shapes). */
function outline$1(name, value) {
    if (value === null || value === false) return null;
    if (typeof value !== 'object') throw new Error(`Graphic "${name}": "outline" is { "color", "width" } or null`);
    return { color: colour(name, 'outline.color', value.color ?? '#000000'), width: number(name, 'outline.width', value.width ?? 0.06, 0, 1) };
}

/** `{ color, blur, dx, dy }` behind it; blur and offsets are fractions of the text size (frame height for shapes). */
function shadow(name, value) {
    if (value === null || value === false) return null;
    if (typeof value !== 'object') throw new Error(`Graphic "${name}": "shadow" is { "color", "blur", "dx", "dy" } or null`);
    return {
        color: colour(name, 'shadow.color', value.color ?? 'rgba(0,0,0,0.6)'),
        blur: number(name, 'shadow.blur', value.blur ?? 0.15, 0, 2),
        dx: number(name, 'shadow.dx', value.dx ?? 0, -2, 2),
        dy: number(name, 'shadow.dy', value.dy ?? 0, -2, 2),
    };
}

/** The whole spec, defaults filled in; throws a message naming the graphic and the setting. */
function normalizeGraphic(name, spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`Graphic "${name}": give { "type": "text" | "rect" | "ellipse", … }`);
    const type = spec.type ?? 'text';
    if (!GRAPHIC_TYPES.includes(type)) throw new Error(`Graphic "${name}": "type" is text, rect, ellipse or strokes — not "${type}"`);
    if (type === 'strokes') return normalizeStrokes(name, spec);         // brush strokes: src/strokes.js
    const base = GRAPHIC_DEFAULTS[type];
    for (const key of Object.keys(spec)) if (!(key in base) && key !== 'fontUrl' && key !== 'onlyShadow') throw new Error(`Graphic "${name}": no such setting "${key}" for ${type}`);
    const out = { type };
    for (const [key, fallback] of Object.entries(base)) {
        if (key === 'type') continue;
        const value = key in spec && spec[key] !== undefined ? spec[key] : fallback;     // null is a value: "no shadow"
        if (key === 'color') out.color = colour(name, key, value);
        else if (key === 'outline') out.outline = outline$1(name, value);
        else if (key === 'shadow') out.shadow = shadow(name, value);
        else if (key === 'shadows') {
            if (!Array.isArray(value) || value.length > MAX_SHADOW_LAYERS) throw new Error(`Graphic "${name}": "shadows" is a list of up to ${MAX_SHADOW_LAYERS} { "color", "blur", "dx", "dy" }`);
            out.shadows = value.map((layer, k) => {
                if (!layer || typeof layer !== 'object') throw new Error(`Graphic "${name}": shadow layer ${k + 1} is { "color", "blur", "dx", "dy" }`);
                return shadow(name, layer);
            });
        }
        else if (key === 'text') {
            if (typeof value !== 'string' || value.length > 500) throw new Error(`Graphic "${name}": "text" is up to 500 characters`);
            out.text = value;
        } else if (key === 'font') {
            if (typeof value !== 'string' || !FAMILY.test(value)) throw new Error(`Graphic "${name}": "font" is a font family, like "Georgia" or "sans-serif"`);
            out.font = value;
        } else if (key === 'weight') {
            if (!WEIGHTS.includes(String(value))) throw new Error(`Graphic "${name}": "weight" is normal, bold or 100–900`);
            out.weight = String(value);
        } else if (key === 'style') {
            if (!['normal', 'italic'].includes(value)) throw new Error(`Graphic "${name}": "style" is normal or italic`);
            out.style = value;
        } else if (key === 'align') {
            if (!['left', 'center', 'right'].includes(value)) throw new Error(`Graphic "${name}": "align" is left, center or right`);
            out.align = value;
        } else if (key === 'size') out.size = number(name, key, value, 0.005, 2);
        else if (key === 'w' || key === 'h') out[key] = number(name, key, value, 0, 4);
        else if (key === 'radius') out.radius = number(name, key, value, 0, 0.5);
        else if (key === 'lineHeight') out.lineHeight = number(name, key, value, 0.5, 4);
        else out[key] = number(name, key, value);                       // x, y, angle
    }
    if (spec.fontUrl !== undefined && spec.fontUrl !== null && spec.fontUrl !== '') {
        if (type !== 'text') throw new Error(`Graphic "${name}": "fontUrl" is for text`);
        let url;
        try { url = new URL(spec.fontUrl); } catch { url = null; }
        if (!url || url.protocol !== 'https:') throw new Error(`Graphic "${name}": "fontUrl" is an https:// address of a font file (.woff2, .woff, .ttf, .otf) or of a Google Fonts stylesheet`);
        out.fontUrl = url.href;
    }
    if (spec.onlyShadow !== undefined) out.onlyShadow = number(name, 'onlyShadow', spec.onlyShadow, 0, MAX_SHADOW_LAYERS - 1);   // set by the compiler for a layer's picture
    return out;
}

/**
 * Shareable image filters.
 *
 * A filter is a small JSON document anyone can publish — maths plus a
 * name, an author, the knobs it exposes and the pictures it needs:
 *
 *   { "format": "mathzetta-filter/1",
 *     "name": "Threshold", "author": "Ada",
 *     "description": "Black or white, at a cutoff you choose",
 *     "params": { "cutoff": { "default": 0.5, "min": 0, "max": 1 } },
 *     "color": "if gray > cutoff then 1 else 0" }
 *
 *   { "name": "Through a mask", "images": { "mask": { "description": "light where the effect shows" } },
 *     "color": "mix(source, rgb, luma(mask))" }
 *
 * A chain combines filters: each step is a filter (or just an expression)
 * with optional settings for its params and an opacity:
 *
 *   { "format": "mathzetta-filter/1", "name": "Old film", "author": "Bo",
 *     "steps": [
 *       { "filter": { …Ada's Threshold… }, "with": { "cutoff": 0.3 }, "opacity": 0.5 },
 *       "rgb * 0.9" ] }
 *
 * A chain is a filter too, so published chains nest inside new ones and
 * keep their authors' names (compileFilter() lists them as credits).
 * Because a filter is only maths, sharing one is safe: it can read the
 * picture and write colours, nothing else.
 *
 * normalizeFilter() fills in defaults and rejects bad shapes,
 * validateFilter() lists every problem, and compileFilter() flattens a
 * filter into the shader passes runtime.js draws. filterToJSON() /
 * filterFromJSON() and filterToLink() / filterFromLink() are the two ways
 * to pass one around; readFilter() accepts either, or a bare expression.
 */

const FILTER_FORMAT = 'mathzetta-filter/1';

const CHANNELS = ['r', 'g', 'b', 'a', 'rgb', 'rgba'];
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Names a parameter can't take: what every expression already has, and GLSL's own words. */
const RESERVED = new Set([
    ...FILTER_NAMES, 'r', 'g', 'b', 'a', 'x', 'y', 'w', 'h', 't', 'c', 'e', 'pi',
    'color', 'image', 'resolution', 'base', 'position', 'main',
    'in', 'out', 'inout', 'const', 'uniform', 'varying', 'attribute', 'void', 'float', 'int', 'bool',
    'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4', 'sampler2D', 'struct', 'precision', 'highp', 'mediump', 'lowp',
    'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'discard', 'true', 'false',
    'texture2D', 'texture', 'mix', 'clamp', 'step', 'smoothstep', 'abs', 'sign', 'floor', 'ceil', 'fract', 'mod',
    'min', 'max', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt',
    'inversesqrt', 'length', 'distance', 'dot', 'cross', 'normalize', 'radians', 'degrees',
]);

const isColor = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(Number(n)));
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
/** How a named picture sits over the frame unless the filter or the chain says otherwise. */
const PLACEMENT = { place: 'cover', zoom: 1, x: 0.5, y: 0.5, angle: 0 };

// ---- the shape ------------------------------------------------------------

/**
 * The full form of a filter: a string becomes `{ color }`, params get
 * their type and range, every step gets `with` and `opacity`. Throws on
 * anything that isn't a filter.
 */
function normalizeFilter(def) {
    if (typeof def === 'string') {
        if (!def.trim()) throw new Error('The filter is empty');
        return { format: FILTER_FORMAT, color: def.trim() };
    }
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw new Error('A filter is an expression, or an object with "color" or "steps"');
    if (def.format !== undefined && def.format !== FILTER_FORMAT) throw new Error(`Unknown filter format "${def.format}" (this is ${FILTER_FORMAT})`);
    const out = { format: FILTER_FORMAT };
    for (const key of ['name', 'author', 'description']) if (def[key] !== undefined && def[key] !== '') out[key] = String(def[key]);
    if (def.steps !== undefined) {
        if (def.color !== undefined) throw new Error('A filter has either "color" or "steps", not both');
        if (!Array.isArray(def.steps) || !def.steps.length) throw new Error('"steps" must be a list with at least one step');
        out.steps = def.steps.map(normalizeStep);
        if (def.notes !== undefined) out.notes = normalizeNotes(def.notes, filterParams(out));
        return out;
    }
    if (def.color === undefined) throw new Error('A filter needs "color" (an expression, or one per channel) or "steps"');
    const params = normalizeParams(def.params ?? {});
    if (Object.keys(params).length) out.params = params;
    if (def.notes !== undefined) out.notes = normalizeNotes(def.notes, params);
    const images = normalizeImages(def.images ?? {}, params);
    if (Object.keys(images).length) out.images = images;
    const graphics = normalizeGraphics(def.graphics ?? {}, params, images);
    if (Object.keys(graphics).length) out.graphics = graphics;
    const space = normalizeSpace(def.space);
    if (space) out.space = space;
    out.color = normalizeColor(def.color);
    return out;
}

/**
 * The filter's page: Markdown text (with maths: Inline Math draws it, and `{{k}}` is a knob's value)
 * and where each knob's input goes — `["Darker below the *cutoff*:", { "param": "cutoff" }]`.
 * Knobs it doesn't place come before it.
 */
function normalizeNotes(notes, params) {
    if (!Array.isArray(notes)) throw new Error('"notes" is a list of Markdown texts and { "param": name } entries');
    return notes.map((block) => {
        if (typeof block === 'string') return block;
        if (!isObject(block) || typeof block.param !== 'string' || Object.keys(block).length !== 1) throw new Error('"notes": each entry is a Markdown text or { "param": name }');
        if (!(block.param in params)) throw new Error(`"notes" places "${block.param}", but there is no parameter called that`);
        return { param: block.param };
    });
}

/** `"hsv"` or `{ "in": "hsv", "out": "srgb" }` → `{ in, out }`; nothing when both are sRGB. */
function normalizeSpace(space) {
    if (space === undefined || space === null) return null;
    const pair = typeof space === 'string' ? { in: space, out: space } : space;
    if (!isObject(pair)) throw new Error(`"space" is a colour space (${COLOUR_SPACES.join(', ')}) or { "in": …, "out": … }`);
    const out = { in: pair.in ?? 'srgb', out: pair.out ?? 'srgb' };
    for (const key of ['in', 'out']) {
        if (!COLOUR_SPACES.includes(out[key])) throw new Error(`"space": "${out[key]}" is not a colour space; they are ${COLOUR_SPACES.join(', ')}`);
    }
    return out.in === 'srgb' && out.out === 'srgb' ? null : out;
}

/** `{ "title": { "type": "text", "text": "Hello", … } }` → each spec in full (src/graphics.js). */
function normalizeGraphics(graphics, params, images) {
    if (!isObject(graphics)) throw new Error('"graphics" is an object of name → { "type": "text" | "rect" | "ellipse", … }');
    const out = {};
    for (const [name, spec] of Object.entries(graphics)) {
        if (!NAME.test(name) || name.startsWith('mz_')) throw new Error(`Graphic name "${name}" must be letters, digits and _, starting with a letter`);
        if (RESERVED.has(name) || name === 'source' || name === 'selection') throw new Error(`"${name}" is already defined in every filter; pick another graphic name`);
        if (name in params || name in images) throw new Error(`"${name}" is both a graphic and a parameter or picture`);
        out[name] = normalizeGraphic(name, spec);
    }
    // name_shadow1… are the pictures of its shadow layers: no other name may be one
    const layers = new Set(Object.keys(out).flatMap((name) => Array.from({ length: MAX_SHADOW_LAYERS }, (_, k) => `${name}_shadow${k + 1}`)));
    for (const name of [...Object.keys(out), ...Object.keys(params), ...Object.keys(images)]) {
        if (layers.has(name)) throw new Error(`"${name}" is the name of a shadow layer of another graphic; pick another name`);
    }
    return out;
}

/** Every graphic a filter draws, including those of the filters inside a chain (first one wins). */
function filterGraphics(filter) {
    if (filter.color) return { ...(filter.graphics ?? {}) };
    const out = {};
    for (const step of filter.steps) {
        for (const [name, g] of Object.entries(filterGraphics(step.filter))) if (!(name in out)) out[name] = g;
    }
    return out;
}

/** `["mask", "overlay"]` or `{ "mask": { "description": "…" } }` → the object form. */
function normalizeImages(images, params) {
    const list = Array.isArray(images) ? Object.fromEntries(images.map((name) => [name, {}])) : images;
    if (!list || typeof list !== 'object') throw new Error('"images" is a list of names, or an object of name → { description }');
    const out = {};
    for (const [name, spec] of Object.entries(list)) {
        if (!NAME.test(name) || name.startsWith('mz_')) throw new Error(`Image name "${name}" must be letters, digits and _, starting with a letter`);
        if (name === 'source') throw new Error('"source" is always available: the picture the chain started from');
        if (RESERVED.has(name)) throw new Error(`"${name}" is already defined in every filter; pick another image name`);
        if (name in params) throw new Error(`"${name}" is both a parameter and an image`);
        out[name] = normalizeImage(name, spec);
    }
    return out;
}

/** `{ description, place, zoom, x, y, angle }` — only what is given; the rest is PLACEMENT. */
function normalizeImage(name, spec) {
    if (!isObject(spec)) throw new Error(`Image "${name}": give { description, place, zoom, x, y, angle }`);
    const out = {};
    if (spec.description) out.description = String(spec.description);
    if (spec.place !== undefined) {
        if (!PLACES.includes(spec.place)) throw new Error(`Image "${name}": "place" is ${PLACES.join(', ')} — not "${spec.place}"`);
        out.place = spec.place;
    }
    for (const key of ['zoom', 'x', 'y', 'angle']) {
        if (spec[key] === undefined) continue;
        const value = Number(spec[key]);
        if (!Number.isFinite(value)) throw new Error(`Image "${name}": "${key}" is a number`);
        out[key] = value;
    }
    for (const key of Object.keys(spec)) if (!['description', 'place', 'zoom', 'x', 'y', 'angle'].includes(key)) throw new Error(`Image "${name}": no such setting "${key}"`);
    return out;
}

function normalizeStep(step) {
    if (typeof step === 'string') return { filter: normalizeFilter(step), with: {}, opacity: 1, skip: false };
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('A step is an expression, a filter, or { "filter": …, "with": { … }, "opacity": … }');
    const { filter, with: settings, opacity, skip, ...rest } = step;
    const out = { filter: normalizeFilter(filter !== undefined ? filter : rest), with: {}, opacity: 1, skip: Boolean(skip) };
    if (settings !== undefined) {
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('"with" is an object of parameter name → value');
        out.with = { ...settings };
    }
    if (opacity !== undefined) {
        const value = Number(opacity);
        if (!(value >= 0 && value <= 1)) throw new Error('"opacity" is a number from 0 to 1');
        out.opacity = value;
    }
    return out;
}

function normalizeParams(params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('"params" is an object of name → { default, min, max }');
    const out = {};
    for (const [name, spec] of Object.entries(params)) {
        if (!NAME.test(name)) throw new Error(`Parameter name "${name}" must be letters, digits and _, starting with a letter`);
        if (RESERVED.has(name)) throw new Error(`"${name}" is already defined in every filter; pick another parameter name`);
        out[name] = normalizeParam(name, spec);
    }
    return out;
}

/** `0.5` → a number 0–1; `[1, 0, 0]` → a colour; or the full `{ type, default, min, max, step, label }`. */
function normalizeParam(name, spec) {
    if (typeof spec === 'number') spec = { default: spec };
    else if (Array.isArray(spec)) spec = { type: 'color', default: spec };
    else if (!spec || typeof spec !== 'object') throw new Error(`Parameter "${name}" needs a default value`);
    const type = spec.type ?? (Array.isArray(spec.default) ? 'color' : 'number');
    const out = { type };
    if (spec.label !== undefined) out.label = String(spec.label);
    if (type === 'color') {
        const value = spec.default ?? [1, 1, 1];
        if (!isColor(value)) throw new Error(`Colour parameter "${name}" needs a default of three numbers, 0–1`);
        out.default = value.map(Number);
        return out;
    }
    if (type !== 'number') throw new Error(`Parameter "${name}": the type is "number" or "color", not "${type}"`);
    // `options`: a choice of values (a menu); `input: "box"`: typed in, as maths; otherwise a slider
    let options = null;
    if (spec.options !== undefined) {
        if (!Array.isArray(spec.options) || !spec.options.length || !spec.options.every((n) => n !== '' && Number.isFinite(Number(n)))) throw new Error(`Parameter "${name}": "options" is a list of numbers`);
        options = spec.options.map(Number);
    }
    if (spec.input !== undefined && spec.input !== 'slider' && spec.input !== 'box') throw new Error(`Parameter "${name}": "input" is "slider" or "box", not "${spec.input}"`);
    const value = Number(spec.default ?? (options ? options[0] : 0));
    if (!Number.isFinite(value)) throw new Error(`Parameter "${name}" needs a numeric default`);
    out.default = value;
    out.min = spec.min !== undefined ? Number(spec.min) : options ? Math.min(...options, value) : Math.min(0, value * 2);
    out.max = spec.max !== undefined ? Number(spec.max) : options ? Math.max(...options, value) : Math.max(1, value * 2);
    if (spec.step !== undefined) out.step = Number(spec.step);
    if (options) out.options = options;
    if (spec.input === 'box' && !options) out.input = 'box';
    if (!(out.min <= value && value <= out.max)) throw new Error(`Parameter "${name}": the default ${value} is outside ${out.min} to ${out.max}`);
    return out;
}

function normalizeColor(color) {
    if (typeof color === 'string') {
        if (!color.trim()) throw new Error('"color" is empty');
        return color.trim();
    }
    if (!color || typeof color !== 'object' || Array.isArray(color)) throw new Error('"color" is an expression, or an object with r, g, b, a, rgb or rgba expressions');
    const out = {};
    for (const [channel, expression] of Object.entries(color)) {
        if (!CHANNELS.includes(channel)) throw new Error(`"color" can set r, g, b, a, rgb or rgba — not "${channel}"`);
        if (typeof expression !== 'string' || !expression.trim()) throw new Error(`"color.${channel}" must be an expression`);
        out[channel] = expression.trim();
    }
    if (!Object.keys(out).length) throw new Error('"color" sets no channels');
    return out;
}

/** Every picture a filter needs, including those of the filters inside a chain (first description wins). */
function filterImages(filter) {
    if (filter.color) return { ...(filter.images ?? {}) };
    const out = {};
    for (const step of filter.steps) {
        for (const [name, image] of Object.entries(filterImages(step.filter))) if (!(name in out)) out[name] = image;
    }
    return out;
}

/** Every parameter a filter exposes, including those of the filters inside a chain (first one wins). */
function filterParams(filter) {
    if (filter.color) return { ...(filter.params ?? {}) };
    const out = {};
    for (const step of filter.steps) {
        for (const [name, param] of Object.entries(filterParams(step.filter))) if (!(name in out)) out[name] = param;
    }
    return out;
}

/** Settings problems, and — with `shaders` — whether each expression compiles (compileFilter() learns that as it builds). */
function check(step, path, problems, shaders) {
    const { filter } = step;
    const where = describe(filter, path);
    const params = filterParams(filter);
    const images = filterImages(filter);
    const graphics = filterGraphics(filter);
    for (const [name, value] of Object.entries(step.with)) {
        if (name in graphics) {                                 // changing a graphic: { text, x, color, … }
            if (!isObject(value)) problems.push(`${where}: "with" for the graphic "${name}" is an object of its settings`);
            else try { normalizeGraphic(name, { ...graphics[name], ...value }); } catch (e) { problems.push(`${where}: ${e.message}`); }
            continue;
        }
        if (name in images) {                                   // placing a picture: { place, zoom, x, y, angle }
            try { normalizeImage(name, value); } catch (e) { problems.push(`${where}: ${e.message}`); }
            continue;
        }
        const param = params[name];
        if (!param) problems.push(`${where}: "with" sets "${name}", but there is no parameter called that`);
        else if (param.type === 'color' ? !isColor(value) : !Number.isFinite(Number(value))) {
            problems.push(`${where}: "${name}" should be a ${param.type === 'color' ? 'colour: three numbers, 0–1' : 'number'}`);
        }
    }
    if (filter.steps) {
        filter.steps.forEach((inner, i) => check(inner, [...path, i], problems));
        return;
    }
}

function describe(filter, path) {
    if (filter.name) return `"${filter.name}"`;
    return path.length ? `step ${path.map((i) => i + 1).join('.')}` : 'the filter';
}

// ---- compiling ------------------------------------------------------------

/**
 * A filter flattened into shader passes, in order. Each pass has the
 * fragment shader, its `params` (declared as uniforms), the `values` to
 * set them to, the `images` it samples (`source` among them when used)
 * with how each is placed (`placements`: place, zoom, x, y, angle — live,
 * like `values`), and an `opacity` (how much of the result shows over the
 * pass's input). A chain used at partial opacity keeps its input
 * (`keepInput`) and ends with a blend pass (`blendKept`).
 *
 * @param {string|object} def
 * @param {{ version?: 100|300 }} [options]
 * @returns {{ name, author, description, version, passes, credits }}
 */
function compileFilter(def, options = {}) {
    const filter = normalizeFilter(def);
    const problems = [];
    check({ filter, with: {}}, [], problems);
    if (problems.length) throw new Error(problems.join('\n'));
    const context = { passes: [], credits: [], problems, version: options.version === 300 ? 300 : 100, top: filter, graphics: {} };
    flatten({ filter, with: {}, opacity: 1, skip: false }, [], {}, context);
    if (problems.length) throw new Error(problems.join('\n'));
    if (!context.passes.length) {                                // every step skipped: the picture as it is
        context.passes.push(makePass(normalizeFilter('pixel(px, py)'), {}, 1, [], context.version));
    }
    return {
        name: filter.name ?? '',
        author: filter.author ?? '',
        description: filter.description ?? '',
        version: context.version,
        passes: context.passes,
        credits: context.credits,
        images: filterImages(filter),
        graphics: context.graphics,              // key → spec as drawn (with the chain's settings); pass.bind maps a pass's names to keys
    };
}

function flatten(step, path, outer, context) {
    if (step.skip) return;                                       // switched off: no passes, no credit
    const rewritten = inColourSpace(step.filter) ?? separableBlur(step.filter);
    if (rewritten) {
        if (step.filter === context.top) context.top = rewritten;     // still the filter itself, not something it uses
        flatten({ ...step, filter: rewritten }, path, outer, context);
        return;
    }
    const { filter } = step;
    const settings = { ...step.with, ...outer };     // whoever combines decides: outer settings win
    for (const key of Object.keys(outer)) if (isObject(outer[key]) && isObject(step.with[key])) settings[key] = { ...step.with[key], ...outer[key] };
    if (filter.name && filter !== context.top && !context.credits.some((c) => c.name === filter.name && c.author === (filter.author ?? ''))) {
        context.credits.push({ name: filter.name, author: filter.author ?? '' });
    }
    if (filter.color) {
        try { context.passes.push(bindGraphics(makePass(filter, settings, step.opacity, path, context.version), context.graphics)); }
        catch (e) { context.problems.push(`${describe(filter, path)}: ${e.message}`); }
        return;
    }
    const start = context.passes.length;
    filter.steps.forEach((inner, i) => flatten(inner, [...path, i], settings, context));
    if (step.opacity < 1) {
        // mix(c, mix(c, f, a), b) is mix(c, f, ab): one pass can just fade more.
        if (context.passes.length - start === 1) context.passes[start].opacity *= step.opacity;
        else {
            context.passes[start].keepInput += 1;
            context.passes.push(blendPass(step.opacity, path, context.version));
        }
    }
}

/**
 * A step whose whole colour is just `gaussian(s)` or `blur(r)` is computed
 * separably — one pass along x, one along y: the same blur for 2n taps
 * instead of n², and reaching further (±24 pixels instead of ±8). The
 * step keeps its name, params, pictures and opacity; the two passes share
 * its settings.
 */
/**
 * A filter with a `space` becomes a chain: convert the frame into the
 * space (its values, kept 0–1, go through the texture between passes),
 * the filter itself — told the space, so pictures it samples are
 * converted too — then convert back. Opacity blends the result over
 * the input in sRGB, as any chain's does.
 */
function inColourSpace(filter) {
    if (!filter.space || typeof filter.color === 'undefined') return null;
    const { space, name, author, description, ...core } = filter;     // the chain carries the name; the middle step is nameless, so it is not a credit
    const step = (f) => ({ filter: f, with: {}, opacity: 1, skip: false });
    const steps = [];
    if (space.in !== 'srgb') steps.push(step({ format: FILTER_FORMAT, color: { rgb: `to${space.in}(rgb)` } }));
    steps.push(step({ ...core, _space: space.in }));
    if (space.out !== 'srgb') steps.push(step({ format: FILTER_FORMAT, color: { rgb: `from${space.out}(rgb)` } }));
    const chain = { format: FILTER_FORMAT, steps };
    for (const [key, value] of Object.entries({ name, author, description })) if (value) chain[key] = value;
    return chain;
}

function separableBlur(filter) {
    if (typeof filter.color !== 'string') return null;
    const m = /^(gaussian|blur)\((.*)\)$/s.exec(filter.color.trim());
    if (!m) return null;
    let depth = 0;
    for (const ch of m[2]) {                                     // the brackets must belong to this one call: not "gaussian(2) + blur(3)"
        if (ch === '(') depth++;
        else if (ch === ')' && --depth < 0) return null;
    }
    if (depth !== 0) return null;
    const { color, ...rest } = filter;
    const half = (axis) => {
        const inner = { format: FILTER_FORMAT, color: `${m[1]}${axis}(${m[2]})` };
        if (rest.params) inner.params = rest.params;
        if (rest.images) inner.images = rest.images;
        if (rest.graphics) inner.graphics = rest.graphics;
        return { filter: inner, with: {}, opacity: 1, skip: false };
    };
    return { ...rest, steps: [half('x'), half('y')] };
}

/**
 * Pictures are shared by name across a chain (every step asking for `mask` gets the
 * same one), but a graphic belongs to its step: two steps that both call their text
 * `title` draw two different texts. So each pass's graphic gets a key of its own —
 * `title`, then `title~2`… — the picture is drawn and bound under the key, and
 * `pass.bind` says which key a name in that pass means.
 */
function bindGraphics(pass, all) {
    pass.bind = {};
    for (const [name, spec] of Object.entries(pass.graphics ?? {})) {
        let key = name;
        for (let n = 2; key in all && JSON.stringify(all[key]) !== JSON.stringify(spec); n++) key = `${name}~${n}`;
        all[key] = spec;
        pass.bind[name] = key;
    }
    return pass;
}

function makePass(filter, settings, opacity, path, version) {
    const params = filter.params ?? {};
    const values = {};
    for (const [name, param] of Object.entries(params)) {
        if (!(name in settings)) values[name] = param.default;
        else values[name] = param.type === 'color' ? settings[name].map(Number) : Number(settings[name]);
    }
    const placements = {};
    for (const [name, spec] of Object.entries(filter.images ?? {})) {
        const { description, ...declared } = spec;
        placements[name] = { ...PLACEMENT, ...declared, ...(isObject(settings[name]) ? settings[name] : {}) };
    }
    // A graphic is a frame-sized picture the page (or renderGraphics) draws: stretched, so it lies exactly on the frame.
    const graphics = {};
    for (const [name, spec] of Object.entries(filter.graphics ?? {})) {
        graphics[name] = isObject(settings[name]) ? normalizeGraphic(name, { ...spec, ...settings[name] }) : spec;
        placements[name] = { ...PLACEMENT, place: 'stretch' };
        shadowLayerNames(name, graphics[name]).forEach((layer, k) => {             // each shadow layer: a picture of its own
            graphics[layer] = { ...graphics[name], onlyShadow: k };
            placements[layer] = { ...PLACEMENT, place: 'stretch' };
        });
    }
    const fragment = shaderFor(filter, version, placements);
    const images = Object.keys(placements);
    if (fragment.includes('uniform sampler2D mz_img_source;')) images.push('source');
    if (fragment.includes('uniform sampler2D mz_img_selection;')) images.push('selection');
    // `color` is the filter's own expression(s): the CPU runner compiles that, the GPU runner the fragment shader.
    return { name: filter.name ?? '', author: filter.author ?? '', path, color: filter.color, space: filter._space ?? 'srgb', fragment, params, values, opacity, images, placements, graphics, keepInput: 0, blendKept: false };
}

function shaderFor(filter, version, placements = null) {
    const params = filter.params ?? {};
    const uniforms = {};
    for (const [name, param] of Object.entries(params)) uniforms[name] = param.type === 'color' ? 'vec3' : 'float';
    const images = {};
    for (const [name, spec] of Object.entries(filter.images ?? {})) images[name] = { place: placements?.[name]?.place ?? spec.place ?? PLACEMENT.place };
    for (const [name, spec] of Object.entries(filter.graphics ?? {})) {
        images[name] = { place: 'stretch' };
        // its shadow layers: as compiled (a chain's "with" may add some), or as the filter has them when only checking
        const layers = placements ? Object.keys(placements).filter((k) => /_shadow\d+$/.test(k) && k.startsWith(`${name}_shadow`)) : shadowLayerNames(name, spec);
        for (const layer of layers) images[layer] = { place: 'stretch' };
    }
    return filterShader(filter.color, { version, uniforms, values: Object.keys(params), images, blend: true, space: filter._space ?? filter.space?.in ?? 'srgb' });
}

/** Mixes the pass before it (`image`) over the input a chain started from (`base`). */
function blendPass(opacity, path, version) {
    const es3 = version === 300;
    const sample = es3 ? 'texture' : 'texture2D';
    const fragment = [
        es3 ? '#version 300 es' : '',
        'precision highp float;',
        'uniform sampler2D image;',
        'uniform sampler2D base;',
        'uniform vec2 resolution;',
        'uniform float mz_opacity;',
        es3 ? 'out vec4 fragColor;' : '',
        'void main() {',
        '    vec2 uv = gl_FragCoord.xy / resolution;',
        `    ${es3 ? 'fragColor' : 'gl_FragColor'} = mix(${sample}(base, uv), ${sample}(image, uv), mz_opacity);`,
        '}',
    ].filter(Boolean).join('\n');
    return { name: 'blend', author: '', path, fragment, params: {}, values: {}, opacity, images: [], placements: {}, graphics: {}, keepInput: 0, blendKept: true };
}

/**
 * Runs a compiled filter (compileFilter()) in WebGL: uploads the picture,
 * draws each pass into a texture, and the last one onto the canvas.
 *
 *   const runner = createFilterRunner(gl, compileFilter(def));
 *   runner.setImage(imageOrVideoOrCanvas);
 *   runner.setImage('mask', maskImage);          // each picture the filter names (compiled.images)
 *   runner.draw({ t: frameIndex });
 *   runner.passes[0].values.cutoff = 0.3;    // knobs change without recompiling
 *   runner.dispose();
 *
 * Works with WebGL 1 and 2 (`compileFilter(def, { version: 300 })` for
 * the latter). The output is the size of the canvas; the picture is
 * stretched to it, so size the canvas to the picture.
 *
 * Between passes the picture lives in 8-bit textures, so values clamp
 * to 0–1 and round to 1/255 at each step. `{ precision: 'half' }` or
 * `'float'` keeps more (bloom's bright spill, edge strengths over 1)
 * where the GPU can render to such textures; `runner.precision` says
 * what was granted.
 */

function createFilterRunner(gl, compiled, options = {}) {
    if (gl.isContextLost()) throw new Error('The WebGL context is lost');
    const precision = texturePrecision(gl, options.precision);
    const vertex = filterVertexShader({ version: compiled.version });
    const programs = compiled.passes.map((pass) => link(gl, vertex, pass.fragment, pass.name));
    const locations = programs.map(() => new Map());
    const location = (i, name) => {
        if (!locations[i].has(name)) locations[i].set(name, gl.getUniformLocation(programs[i], name));
        return locations[i].get(name);
    };

    const triangle = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);   // one triangle covers the canvas

    const source = { texture: gl.createTexture(), framebuffer: null };
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    clampAndFilter(gl);
    const pictures = new Map();                                   // name → texture, for compiled.images
    const sizes = new Map();                                      // name → [width, height] of that picture
    const blank = gl.createTexture();                             // a picture not yet given: white, 1×1
    gl.bindTexture(gl.TEXTURE_2D, blank);
    clampAndFilter(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    const clear = gl.createTexture();                             // a graphic not yet drawn: transparent, 1×1
    gl.bindTexture(gl.TEXTURE_2D, clear);
    clampAndFilter(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    const pool = [];           // textures passes draw into, reused between frames
    let width = 0;
    let height = 0;

    function buffer(exclude) {
        let found = pool.find((b) => !exclude.includes(b));
        if (!found) {
            found = { texture: gl.createTexture(), framebuffer: gl.createFramebuffer() };
            gl.bindTexture(gl.TEXTURE_2D, found.texture);
            clampAndFilter(gl, precision.filter);
            gl.texImage2D(gl.TEXTURE_2D, 0, precision.internal, width, height, 0, gl.RGBA, precision.type, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, found.framebuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, found.texture, 0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE && precision.name !== 'byte') {
                Object.assign(precision, texturePrecision(gl, 'byte'));     // this GPU won't render to it after all
                gl.bindTexture(gl.TEXTURE_2D, found.texture);
                clampAndFilter(gl, precision.filter);
                gl.texImage2D(gl.TEXTURE_2D, 0, precision.internal, width, height, 0, gl.RGBA, precision.type, null);
            }
            pool.push(found);
        }
        return found;
    }

    const runner = {
        /** The passes with their live `values`; change one and the next draw uses it. */
        passes: compiled.passes,
        /** 'byte', 'half' or 'float': what the textures between passes hold. */
        get precision() { return precision.name; },

        /**
         * Uploads a picture: an <img>, <video>, <canvas> or ImageData. Call
         * again for each video frame. With a name first, it is one of the
         * pictures the filter asks for (`compiled.images`); `source` is the
         * main picture itself.
         */
        setImage(name, image) {
            if (typeof name !== 'string') { image = name; name = null; }
            let texture = source.texture;
            if (name && name !== 'source') {
                if (!pictures.has(name)) {
                    pictures.set(name, gl.createTexture());
                    gl.bindTexture(gl.TEXTURE_2D, pictures.get(name));
                    clampAndFilter(gl);
                }
                texture = pictures.get(name);
            }
            // a plain picture { data, width, height } (what the CPU runner and Node give; floats are 0–1): as ImageData
            if (image && image.data && image.width && image.height && typeof ImageData !== 'undefined' && !(image instanceof ImageData)) {
                const src = image.data, float = src instanceof Float32Array || src instanceof Float64Array;
                const bytes = src instanceof Uint8ClampedArray ? src : Uint8ClampedArray.from(src, float ? (v) => v * 255 : undefined);
                image = new ImageData(bytes, image.width, image.height);
            }
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);          // so y = 0 is the top, as in the picture
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            if (name) sizes.set(name, [image.naturalWidth || image.videoWidth || image.width || 1, image.naturalHeight || image.videoHeight || image.height || 1]);
            return runner;
        },

        /** Draws the filtered picture onto the canvas; `t` is the frame index. */
        draw({ t = 0 } = {}) {
            if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) {
                width = gl.drawingBufferWidth;
                height = gl.drawingBufferHeight;
                for (const b of pool) {
                    gl.bindTexture(gl.TEXTURE_2D, b.texture);
                    gl.texImage2D(gl.TEXTURE_2D, 0, precision.internal, width, height, 0, gl.RGBA, precision.type, null);
                }
            }
            let input = source;
            const kept = [];                   // inputs of chains still waiting for their blend pass
            compiled.passes.forEach((pass, i) => {
                for (let k = 0; k < pass.keepInput; k++) kept.push(input);
                const last = i === compiled.passes.length - 1;
                const target = last ? null : buffer([input, ...kept]);
                gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
                gl.viewport(0, 0, width, height);
                const program = programs[i];
                gl.useProgram(program);
                const position = gl.getAttribLocation(program, 'position');
                gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
                gl.enableVertexAttribArray(position);
                gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, input.texture);
                gl.uniform1i(location(i, 'image'), 0);
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, pass.blendKept ? kept[kept.length - 1].texture : null);
                if (pass.blendKept) gl.uniform1i(location(i, 'base'), 1);
                pass.images.forEach((name, k) => {
                    gl.activeTexture(gl.TEXTURE2 + k);
                    gl.bindTexture(gl.TEXTURE_2D, name === 'source' ? source.texture : (pictures.get(pass.bind?.[name] ?? name) ?? (pass.graphics?.[name] ? clear : blank)));
                    gl.uniform1i(location(i, `mz_img_${name}`), 2 + k);
                    if (!pass.placements[name]) return;                              // source, selection: the frame's size, no placement
                    const size = sizes.get(pass.bind?.[name] ?? name) ?? [1, 1];
                    const place = pass.placements[name];
                    gl.uniform2f(location(i, `mz_size_${name}`), size[0], size[1]);
                    gl.uniform4f(location(i, `mz_place_${name}`), Number(place.zoom), Number(place.x), Number(place.y), Number(place.angle));
                });
                gl.uniform2f(location(i, 'resolution'), width, height);
                gl.uniform1f(location(i, 't'), t);
                gl.uniform1f(location(i, 'mz_opacity'), pass.opacity);
                for (const [name, param] of Object.entries(pass.params)) {
                    const value = pass.values[name];
                    if (param.type === 'color') gl.uniform3fv(location(i, name), value.map(Number));
                    else gl.uniform1f(location(i, name), Number(value));
                }
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                if (pass.blendKept) kept.pop();
                input = target;
            });
            return runner;
        },

        dispose() {
            for (const program of programs) gl.deleteProgram(program);
            gl.deleteTexture(source.texture);
            gl.deleteTexture(blank);
            gl.deleteTexture(clear);
            for (const texture of pictures.values()) gl.deleteTexture(texture);
            for (const b of pool) { gl.deleteTexture(b.texture); gl.deleteFramebuffer(b.framebuffer); }
            gl.deleteBuffer(triangle);
        },
    };
    return runner;
}

function clampAndFilter(gl, filter = gl.LINEAR) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
}

/** The texture format for the pictures between passes: 8-bit unless asked for and available. */
function texturePrecision(gl, wanted = 'byte') {
    const byte = { name: 'byte', internal: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR };
    if (wanted !== 'half' && wanted !== 'float') return byte;
    const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    if (webgl2) {
        if (!gl.getExtension('EXT_color_buffer_float')) return byte;
        const linear = gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST;
        return wanted === 'float'
            ? { name: 'float', internal: gl.RGBA32F, type: gl.FLOAT, filter: linear }
            : { name: 'half', internal: gl.RGBA16F, type: gl.HALF_FLOAT, filter: gl.LINEAR };
    }
    if (wanted === 'float' && gl.getExtension('OES_texture_float') && gl.getExtension('WEBGL_color_buffer_float')) {
        return { name: 'float', internal: gl.RGBA, type: gl.FLOAT, filter: gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST };
    }
    const half = gl.getExtension('OES_texture_half_float');
    if (half && gl.getExtension('EXT_color_buffer_half_float')) {
        return { name: 'half', internal: gl.RGBA, type: half.HALF_FLOAT_OES, filter: gl.getExtension('OES_texture_half_float_linear') ? gl.LINEAR : gl.NEAREST };
    }
    return byte;
}

function link(gl, vertex, fragment, name) {
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(`${name || 'The filter'} does not compile: ${gl.getShaderInfoLog(shader).trim()}`);
        }
        gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`${name || 'The filter'} does not link: ${gl.getProgramInfoLog(program).trim()}`);
    return program;
}

/**
 * What the generated CPU filter code calls: sampling the picture the way a
 * WebGL texture does, and the neighbourhood functions as whole planes.
 *
 * Pictures are { data: Float32Array RGBA 0–1, width, height }, rows top
 * down. Positions are pixel centres in that frame: (px, py) is pixel px of
 * row py, so sampling there returns that pixel exactly and a fractional
 * position blends the four around it (bilinear, edges clamped) — what
 * texture2D does with LINEAR filtering and CLAMP_TO_EDGE.
 *
 * Every export that is a function is passed to the generated code as
 * $h_<name>; nothing else is reachable from it.
 */


const BLANK = { data: new Float32Array([1, 1, 1, 1]), width: 1, height: 1 };   // a picture not given yet: white
const CLEAR = { data: new Float32Array([0, 0, 0, 0]), width: 1, height: 1 };   // a graphic not drawn yet: transparent

const PLACE = { cover: 0, fit: 1, stretch: 2, tile: 3 };
function placeCode(place) { return PLACE[place ?? 'cover'] ?? 0; }

function scratch() { return new Float64Array(4); }
/** P[i][k], for colour params (the generated code may not index twice). */
function at(P, i, k) { return Number(P[i][k]); }

function fmod(a, b) { return a - b * Math.floor(a / b); }
function smoothstep(e0, e1, x) { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); }
function factorial(n) { let r = 1; for (let i = 2; i <= 170; i++) { if (i > n) break; r *= i; } return r; }
function perm(n, k) { let r = 1; for (let i = 0; i < 170; i++) { if (i >= k) break; r *= n - i; } return r; }
function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); for (let i = 0; i < 64; i++) { if (b === 0) break; const t = fmod(a, b); a = b; b = t; } return a; }
function root(n, x) { return n === 2 ? Math.sqrt(x) : n === 3 ? Math.sign(x) * Math.pow(Math.abs(x), 1 / 3) : Math.pow(x, 1 / n); }
/** The shader's hash: a new value per pixel and per call, seeded with t. (A GPU's float sin differs, so the values do too.) */
function random(px, py, h, seed) {
    const v = Math.sin((px + 0.5) * 12.9898 + (h - py - 0.5) * 78.233 + seed * 37.719) * 43758.5453;
    return v - Math.floor(v);
}

// ---- sampling --------------------------------------------------------------------

const clampi = (v, max) => (v < 0 ? 0 : v > max ? max : v);

/** Bilinear sample of picture data at pixel-centre position (X, Y), edges clamped, into out[0..3]. */
function sample(D, w, h, X, Y, out) {
    const x0f = Math.floor(X);
    const y0f = Math.floor(Y);
    const fx = X - x0f;
    const fy = Y - y0f;
    const x0 = clampi(x0f, w - 1), x1 = clampi(x0f + 1, w - 1);
    const y0 = clampi(y0f, h - 1), y1 = clampi(y0f + 1, h - 1);
    const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
    for (let k = 0; k < 4; k++) {
        const top = D[i00 + k] + (D[i10 + k] - D[i00 + k]) * fx;
        const bottom = D[i01 + k] + (D[i11 + k] - D[i01 + k]) * fx;
        out[k] = top + (bottom - top) * fy;
    }
    return out;
}

/** As sample(), but transparent black outside the picture (the shader's mz_at_image). */
function sampleOrZero(D, w, h, X, Y, out) {
    const qx = X + 0.5;
    const qy = Y + 0.5;
    if (qx < 0 || qy < 0 || qx > w || qy > h) { out[0] = out[1] = out[2] = out[3] = 0; return out; }
    return sample(D, w, h, X, Y, out);
}

/**
 * A named picture laid over the frame (the shader's mz_sample_<name>): scaled by `place`
 * (0 cover, 1 fit, 2 stretch, 3 tile) times zoom, centred at (x, y) of the frame, turned by
 * angle; transparent outside unless tiled.
 */
function picture(Q, qw, qh, w, h, zoom, x, y, angle, mode, X, Y, out) {
    let sx;
    let sy;
    if (mode === 0) sx = sy = Math.max(w / qw, h / qh);
    else if (mode === 1) sx = sy = Math.min(w / qw, h / qh);
    else if (mode === 2) { sx = w / qw; sy = h / qh; } else sx = sy = 1;
    sx *= zoom;
    sy *= zoom;
    const dx = X + 0.5 - x * w;
    const dy = Y + 0.5 - y * h;
    const co = Math.cos(angle);
    const si = Math.sin(angle);
    let qx = (co * dx + si * dy) / sx + qw * 0.5;
    let qy = (co * dy - si * dx) / sy + qh * 0.5;
    if (mode === 3) { qx = fmod(qx, qw); qy = fmod(qy, qh); }
    else if (qx < 0 || qy < 0 || qx > qw || qy > qh) { out[0] = out[1] = out[2] = out[3] = 0; return out; }
    return sample(Q, qw, qh, qx - 0.5, qy - 0.5, out);
}

// ---- neighbourhoods: whole planes, computed once per pass ------------------------------
//
// Taps are whole-pixel offsets, edges clamped; dy runs downwards. Square windows are done as a
// horizontal pass then a vertical one — the same sums, maxima and weights as the shader's
// double loop, in another order.

/** Offsets -r..r kept by `keep(offset)`, with r = min(max(ceil(limit), 0), reach). */
function offsets(limit, reach, keep) {
    const r = Math.min(Math.max(Math.ceil(limit), 0), reach);
    const out = [];
    for (let i = -r; i <= r; i++) if (keep(i)) out.push(i);
    return out;
}

/**
 * One separable pass over rgb along x or y: a weighted sum over whole-pixel offsets `taps`
 * (edges clamped), divided by `norm`. Tight loops — no closures per tap — since this is where
 * a blur spends its time.
 */
function weighted1D(src, stride, w, h, axis, taps, weights, norm, y0 = 0, y1 = h) {
    const out = new Float32Array(w * h * 3);
    const n = taps.length;
    const T = Int32Array.from(taps);
    const W = Float64Array.from(weights ?? taps.map(() => 1));
    const along = axis === 'x' ? w : h;
    const idx = new Int32Array(n);
    for (let y = y0; y < y1; y++) {
        for (let x = 0; x < w; x++) {
            const pos = axis === 'x' ? x : y;
            for (let t = 0; t < n; t++) {
                let q = pos + T[t];
                q = q < 0 ? 0 : q >= along ? along - 1 : q;
                idx[t] = (axis === 'x' ? y * w + q : q * w + x) * stride;
            }
            let s0 = 0, s1 = 0, s2 = 0;
            for (let t = 0; t < n; t++) { const i = idx[t], wt = W[t]; s0 += src[i] * wt; s1 += src[i + 1] * wt; s2 += src[i + 2] * wt; }
            const o = (y * w + x) * 3;
            out[o] = s0 / norm; out[o + 1] = s1 / norm; out[o + 2] = s2 / norm;
        }
    }
    return out;
}

/** A box along x or y with running sums: the same average whatever the radius costs the same. */
function box1D(src, stride, w, h, axis, lo, hi, y0 = 0, y1 = h) {
    const out = new Float32Array(w * h * 3);
    const along = axis === 'x' ? w : h;
    const lines = axis === 'x' ? h : w;
    const count = hi - lo + 1;
    const at = (line, q) => (axis === 'x' ? line * w + q : q * w + line);
    const clampq = (q) => (q < 0 ? 0 : q >= along ? along - 1 : q);
    // along x: the rows y0..y1, all of each; along y: every column, only positions y0..y1
    const [l0, l1] = axis === 'x' ? [y0, y1] : [0, lines];
    const [p0, p1] = axis === 'x' ? [0, along] : [y0, y1];
    for (let line = l0; line < l1; line++) {
        let s0 = 0, s1 = 0, s2 = 0;
        for (let t = p0 + lo; t <= p0 + hi; t++) { const i = at(line, clampq(t)) * stride; s0 += src[i]; s1 += src[i + 1]; s2 += src[i + 2]; }
        for (let pos = p0; pos < p1; pos++) {
            const o = at(line, pos) * 3;
            out[o] = s0 / count; out[o + 1] = s1 / count; out[o + 2] = s2 / count;
            const drop = at(line, clampq(pos + lo)) * stride;
            const take = at(line, clampq(pos + hi + 1)) * stride;
            s0 += src[take] - src[drop]; s1 += src[take + 1] - src[drop + 1]; s2 += src[take + 2] - src[drop + 2];
        }
    }
    return out;
}

/** Max or min along x or y, edges clamped, starting from `init` (the shader starts dilate at 0, erode at 1). */
function extreme1D(src, stride, w, h, axis, taps, init, isMax, y0 = 0, y1 = h) {
    const out = new Float32Array(w * h * 3);
    const along = axis === 'x' ? w : h;
    for (let y = y0; y < y1; y++) {
        for (let x = 0; x < w; x++) {
            const pos = axis === 'x' ? x : y;
            let m0 = init, m1 = init, m2 = init;
            for (let t = 0; t < taps.length; t++) {
                let q = pos + taps[t];
                q = q < 0 ? 0 : q >= along ? along - 1 : q;
                const i = (axis === 'x' ? y * w + q : q * w + x) * stride;
                if (isMax) { if (src[i] > m0) m0 = src[i]; if (src[i + 1] > m1) m1 = src[i + 1]; if (src[i + 2] > m2) m2 = src[i + 2]; }
                else { if (src[i] < m0) m0 = src[i]; if (src[i + 1] < m1) m1 = src[i + 1]; if (src[i + 2] < m2) m2 = src[i + 2]; }
            }
            const o = (y * w + x) * 3;
            out[o] = m0; out[o + 1] = m1; out[o + 2] = m2;
        }
    }
    return out;
}

const add = (acc, v, wt) => acc + v * wt;
const maxOf = (acc, v) => (v > acc ? v : acc);
const minOf = (acc, v) => (v < acc ? v : acc);

function rgbOf(I, w, h, y0 = 0, y1 = h) {
    const out = new Float32Array(w * h * 3);
    for (let j = y0 * w; j < y1 * w; j++) { out[j * 3] = I[j * 4]; out[j * 3 + 1] = I[j * 4 + 1]; out[j * 3 + 2] = I[j * 4 + 2]; }
    return out;
}

/** Rows the first (horizontal) pass must cover so the vertical pass can read ±reach around y0..y1. */
const widen = (y0, y1, reach, h) => [Math.max(0, y0 - reach), Math.min(h, y1 + reach)];

function boxPlanes(I, w, h, y0, y1, radius, axes, reach) {
    const taps = offsets(radius, reach, (i) => Math.abs(i) <= radius);
    if (!taps.length) return rgbOf(I, w, h, y0, y1);
    const lo = taps[0];
    const hi = taps[taps.length - 1];
    if (axes.length === 1) return box1D(I, 4, w, h, axes[0], lo, hi, y0, y1);
    const [a0, a1] = widen(y0, y1, hi, h);
    return box1D(box1D(I, 4, w, h, 'x', lo, hi, a0, a1), 3, w, h, 'y', lo, hi, y0, y1);
}

function gaussPlanes(I, w, h, y0, y1, sigma, axes, reach) {
    if (!(sigma > 0)) return rgbOf(I, w, h, y0, y1);
    const limit = 3 * sigma;
    const taps = offsets(limit, reach, (i) => Math.abs(i) <= limit);
    const weights = taps.map((i) => Math.exp(-(i * i) / (2 * sigma * sigma)));
    const total = weights.reduce((a, b) => a + b, 0);
    if (axes.length === 1) return weighted1D(I, 4, w, h, axes[0], taps, weights, total, y0, y1);
    const [a0, a1] = widen(y0, y1, taps[taps.length - 1], h);
    return weighted1D(weighted1D(I, 4, w, h, 'x', taps, weights, total, a0, a1), 3, w, h, 'y', taps, weights, total, y0, y1);
}

function extremePlanes(I, w, h, y0, y1, radius, init, isMax) {
    const taps = offsets(radius, REACH.square, (i) => Math.abs(i) <= radius);
    if (!taps.length) return new Float32Array(w * h * 3).fill(init);
    const [a0, a1] = widen(y0, y1, taps[taps.length - 1], h);
    return extreme1D(extreme1D(I, 4, w, h, 'x', taps, init, isMax, a0, a1), 3, w, h, 'y', taps, init, isMax, y0, y1);
}

function plane_blur(I, w, h, y0, y1, radius) { return boxPlanes(I, w, h, y0, y1, radius, ['x', 'y'], REACH.square); }
function plane_blurx(I, w, h, y0, y1, radius) { return boxPlanes(I, w, h, y0, y1, radius, ['x'], REACH.line); }
function plane_blury(I, w, h, y0, y1, radius) { return boxPlanes(I, w, h, y0, y1, radius, ['y'], REACH.line); }
function plane_gaussian(I, w, h, y0, y1, sigma) { return gaussPlanes(I, w, h, y0, y1, sigma, ['x', 'y'], REACH.square); }
function plane_gaussianx(I, w, h, y0, y1, sigma) { return gaussPlanes(I, w, h, y0, y1, sigma, ['x'], REACH.line); }
function plane_gaussiany(I, w, h, y0, y1, sigma) { return gaussPlanes(I, w, h, y0, y1, sigma, ['y'], REACH.line); }
function plane_dilate(I, w, h, y0, y1, radius) { return extremePlanes(I, w, h, y0, y1, radius, 0, true); }
function plane_erode(I, w, h, y0, y1, radius) { return extremePlanes(I, w, h, y0, y1, radius, 1, false); }

function plane_sharpen(I, w, h, y0, y1, amount) {
    const out = new Float32Array(w * h * 3);
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) {
        const t = (xx, yy) => (clampi(yy, h - 1) * w + clampi(xx, w - 1)) * 4;
        const c = t(x, y), l = t(x - 1, y), r = t(x + 1, y), u = t(x, y - 1), d = t(x, y + 1);
        for (let k = 0; k < 3; k++) out[(y * w + x) * 3 + k] = I[c + k] + amount * (4 * I[c + k] - I[l + k] - I[r + k] - I[u + k] - I[d + k]);
    }
    return out;
}

function lumaPlane(I, w, h) {
    const L = new Float32Array(w * h);
    for (let j = 0; j < w * h; j++) L[j] = I[j * 4] * 0.299 + I[j * 4 + 1] * 0.587 + I[j * 4 + 2] * 0.114;
    return L;
}

function lumaOp(I, w, h, y0, y1, fn) {
    const L = lumaPlane(I, w, h);
    const out = new Float32Array(w * h);
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) {
        const at = (dx, dy) => L[clampi(y + dy, h - 1) * w + clampi(x + dx, w - 1)];
        out[y * w + x] = fn(at);
    }
    return out;
}

const SOBELX = (L) => (L(1, -1) + 2 * L(1, 0) + L(1, 1)) - (L(-1, -1) + 2 * L(-1, 0) + L(-1, 1));
const SOBELY = (L) => (L(-1, 1) + 2 * L(0, 1) + L(1, 1)) - (L(-1, -1) + 2 * L(0, -1) + L(1, -1));
const LAPLACIAN = (L) => 4 * L(0, 0) - L(-1, 0) - L(1, 0) - L(0, -1) - L(0, 1);
const EMBOSS = (L) => 0.5 + L(-1, -1) - L(1, 1);
const SOBEL = (L) => Math.hypot(SOBELX(L), SOBELY(L));

function plane_sobelx(I, w, h, y0, y1) { return lumaOp(I, w, h, y0, y1, SOBELX); }
function plane_sobely(I, w, h, y0, y1) { return lumaOp(I, w, h, y0, y1, SOBELY); }
function plane_sobel(I, w, h, y0, y1) { return lumaOp(I, w, h, y0, y1, SOBEL); }
function plane_laplacian(I, w, h, y0, y1) { return lumaOp(I, w, h, y0, y1, LAPLACIAN); }
function plane_emboss(I, w, h, y0, y1) { return lumaOp(I, w, h, y0, y1, EMBOSS); }

// ---- the same at one pixel, for an argument that changes from pixel to pixel ---------------

function window2D(I, w, h, px, py, taps, weightOf, init, combine, out, finish) {
    for (let k = 0; k < 3; k++) {
        let acc = init;
        let total = 0;
        for (const i of taps) for (const j of taps) {
            const wt = weightOf ? weightOf(i, j) : 1;
            acc = combine(acc, I[(clampi(py + j, h - 1) * w + clampi(px + i, w - 1)) * 4 + k], wt);
            total += wt;
        }
        out[k] = finish ? finish(acc, total) : acc;
    }
    return out;
}

function window1D(I, w, h, px, py, axis, taps, weightOf, out) {
    for (let k = 0; k < 3; k++) {
        let acc = 0;
        let total = 0;
        for (const i of taps) {
            const wt = weightOf ? weightOf(i) : 1;
            const xx = axis === 'x' ? clampi(px + i, w - 1) : px;
            const yy = axis === 'y' ? clampi(py + i, h - 1) : py;
            acc += I[(yy * w + xx) * 4 + k] * wt;
            total += wt;
        }
        out[k] = acc / total;
    }
    return out;
}

const here = (I, w, px, py, out) => { const c = (py * w + px) * 4; out[0] = I[c]; out[1] = I[c + 1]; out[2] = I[c + 2]; return out; };

function at_blur(I, w, h, px, py, radius, out) {
    return window2D(I, w, h, px, py, offsets(radius, REACH.square, (i) => Math.abs(i) <= radius), null, 0, add, out, (a, n) => a / n);
}
function at_blurx(I, w, h, px, py, radius, out) { return window1D(I, w, h, px, py, 'x', offsets(radius, REACH.line, (i) => Math.abs(i) <= radius), null, out); }
function at_blury(I, w, h, px, py, radius, out) { return window1D(I, w, h, px, py, 'y', offsets(radius, REACH.line, (i) => Math.abs(i) <= radius), null, out); }
function at_gaussian(I, w, h, px, py, sigma, out) {
    if (!(sigma > 0)) return here(I, w, px, py, out);
    const limit = 3 * sigma;
    const g = (i, j) => Math.exp(-(i * i + j * j) / (2 * sigma * sigma));
    return window2D(I, w, h, px, py, offsets(limit, REACH.square, (i) => Math.abs(i) <= limit), g, 0, add, out, (a, n) => a / n);
}
function at_gaussianx(I, w, h, px, py, sigma, out) {
    if (!(sigma > 0)) return here(I, w, px, py, out);
    const limit = 3 * sigma;
    return window1D(I, w, h, px, py, 'x', offsets(limit, REACH.line, (i) => Math.abs(i) <= limit), (i) => Math.exp(-(i * i) / (2 * sigma * sigma)), out);
}
function at_gaussiany(I, w, h, px, py, sigma, out) {
    if (!(sigma > 0)) return here(I, w, px, py, out);
    const limit = 3 * sigma;
    return window1D(I, w, h, px, py, 'y', offsets(limit, REACH.line, (i) => Math.abs(i) <= limit), (i) => Math.exp(-(i * i) / (2 * sigma * sigma)), out);
}
function at_dilate(I, w, h, px, py, radius, out) { return window2D(I, w, h, px, py, offsets(radius, REACH.square, (i) => Math.abs(i) <= radius), null, 0, maxOf, out); }
function at_erode(I, w, h, px, py, radius, out) { return window2D(I, w, h, px, py, offsets(radius, REACH.square, (i) => Math.abs(i) <= radius), null, 1, minOf, out); }
function at_sharpen(I, w, h, px, py, amount, out) {
    const t = (xx, yy) => (clampi(yy, h - 1) * w + clampi(xx, w - 1)) * 4;
    const c = t(px, py), l = t(px - 1, py), r = t(px + 1, py), u = t(px, py - 1), d = t(px, py + 1);
    for (let k = 0; k < 3; k++) out[k] = I[c + k] + amount * (4 * I[c + k] - I[l + k] - I[r + k] - I[u + k] - I[d + k]);
    return out;
}

/** 3×3 kernel, row by row from the top-left (k00 at dx = -1, dy = -1). */
function convolve(I, w, h, px, py, k00, k01, k02, k10, k11, k12, k20, k21, k22, out) {
    const t = (dx, dy) => (clampi(py + dy, h - 1) * w + clampi(px + dx, w - 1)) * 4;
    const taps = [[k00, -1, -1], [k01, 0, -1], [k02, 1, -1], [k10, -1, 0], [k11, 0, 0], [k12, 1, 0], [k20, -1, 1], [k21, 0, 1], [k22, 1, 1]];
    for (let k = 0; k < 3; k++) { let s = 0; for (const [wt, dx, dy] of taps) s += wt * I[t(dx, dy) + k]; out[k] = s; }
    return out;
}

// ---- colour spaces: the shader's to<space> / from<space> (mathzetta render/glsl.js colourGlsl), sRGB on the other side ----
const toLin = (c) => (c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const fromLin = (c) => { c = Math.max(c, 0); return c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };
const hue = (r, g, b, v, d) => { const h = v === r ? (g - b) / d : v === g ? 2 + (b - r) / d : 4 + (r - g) / d; return h / 6 - Math.floor(h / 6); };
const tri = (h, o) => { const k = Math.abs(((h + o) - Math.floor(h + o)) * 6 - 3); return Math.min(Math.max(k - 1, 0), 1); };
function col_tolinear(r, g, b, out) { out[0] = toLin(r); out[1] = toLin(g); out[2] = toLin(b); return out; }
function col_fromlinear(r, g, b, out) { out[0] = fromLin(r); out[1] = fromLin(g); out[2] = fromLin(b); return out; }
function col_tohsv(r, g, b, out) {
    const v = Math.max(r, g, b), d = v - Math.min(r, g, b);
    out[0] = d > 0 ? hue(r, g, b, v, d) : 0; out[1] = v > 0 ? d / v : 0; out[2] = v;
    return out;
}
function col_fromhsv(h, s, v, out) {
    out[0] = v * (1 + (tri(h, 0) - 1) * s); out[1] = v * (1 + (tri(h, 2 / 3) - 1) * s); out[2] = v * (1 + (tri(h, 1 / 3) - 1) * s);
    return out;
}
function col_tohsl(r, g, b, out) {
    const v = Math.max(r, g, b), m = Math.min(r, g, b), d = v - m, l = (v + m) * 0.5;
    out[0] = d > 0 ? hue(r, g, b, v, d) : 0; out[1] = d > 0 ? d / (1 - Math.abs(2 * l - 1)) : 0; out[2] = l;
    return out;
}
function col_fromhsl(h, s, l, out) {
    const C = (1 - Math.abs(2 * l - 1)) * s;
    out[0] = l - C * 0.5 + C * tri(h, 0); out[1] = l - C * 0.5 + C * tri(h, 2 / 3); out[2] = l - C * 0.5 + C * tri(h, 1 / 3);
    return out;
}
function col_toycbcr(r, g, b, out) {
    const y = r * 0.299 + g * 0.587 + b * 0.114;
    out[0] = y; out[1] = 0.5 + (b - y) * 0.5643; out[2] = 0.5 + (r - y) * 0.7132;
    return out;
}
function col_fromycbcr(y, cb, cr, out) {
    cb -= 0.5; cr -= 0.5;
    out[0] = y + 1.402 * cr; out[1] = y - 0.344136 * cb - 0.714136 * cr; out[2] = y + 1.772 * cb;
    return out;
}
const labF = (t) => (t < 0.008856 ? 7.787 * t + 16 / 116 : Math.cbrt(t));
const labFinv = (f) => (f < 0.206893 ? (f - 16 / 116) / 7.787 : f * f * f);
function col_tolab(r, g, b, out) {
    const R = toLin(r), G = toLin(g), B = toLin(b);
    const fx = labF((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
    const fy = labF(0.2126729 * R + 0.7151522 * G + 0.0721750 * B);
    const fz = labF((0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883);
    out[0] = (116 * fy - 16) / 100; out[1] = 0.5 + 500 * (fx - fy) / 256; out[2] = 0.5 + 200 * (fy - fz) / 256;
    return out;
}
function col_fromlab(L, A, B, out) {
    const fy = (L * 100 + 16) / 116, fx = fy + (A - 0.5) * 256 / 500, fz = fy - (B - 0.5) * 256 / 200;
    const X = labFinv(fx) * 0.95047, Y = labFinv(fy), Z = labFinv(fz) * 1.08883;
    const lr = Math.min(Math.max(3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, 0), 1);
    const lg = Math.min(Math.max(-0.969266 * X + 1.8760108 * Y + 0.0415560 * Z, 0), 1);
    const lb = Math.min(Math.max(0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z, 0), 1);
    out[0] = fromLin(lr); out[1] = fromLin(lg); out[2] = fromLin(lb);
    return out;
}
function col_tooklab(r, g, b, out) {
    const R = toLin(r), G = toLin(g), B = toLin(b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    out[0] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    out[1] = 0.5 + 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    out[2] = 0.5 + 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    return out;
}
function col_fromoklab(L, A, B, out) {
    A -= 0.5; B -= 0.5;
    let l = L + 0.3963377774 * A + 0.2158037573 * B, m = L - 0.1055613458 * A - 0.0638541728 * B, s = L - 0.0894841775 * A - 1.2914855480 * B;
    l = l * l * l; m = m * m * m; s = s * s * s;
    const lr = Math.min(Math.max(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, 0), 1);
    const lg = Math.min(Math.max(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, 0), 1);
    const lb = Math.min(Math.max(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s, 0), 1);
    out[0] = fromLin(lr); out[1] = fromLin(lg); out[2] = fromLin(lb);
    return out;
}

var H = /*#__PURE__*/Object.freeze({
    __proto__: null,
    BLANK: BLANK,
    CLEAR: CLEAR,
    at: at,
    at_blur: at_blur,
    at_blurx: at_blurx,
    at_blury: at_blury,
    at_dilate: at_dilate,
    at_erode: at_erode,
    at_gaussian: at_gaussian,
    at_gaussianx: at_gaussianx,
    at_gaussiany: at_gaussiany,
    at_sharpen: at_sharpen,
    col_fromhsl: col_fromhsl,
    col_fromhsv: col_fromhsv,
    col_fromlab: col_fromlab,
    col_fromlinear: col_fromlinear,
    col_fromoklab: col_fromoklab,
    col_fromycbcr: col_fromycbcr,
    col_tohsl: col_tohsl,
    col_tohsv: col_tohsv,
    col_tolab: col_tolab,
    col_tolinear: col_tolinear,
    col_tooklab: col_tooklab,
    col_toycbcr: col_toycbcr,
    convolve: convolve,
    factorial: factorial,
    fmod: fmod,
    gcd: gcd,
    perm: perm,
    picture: picture,
    placeCode: placeCode,
    plane_blur: plane_blur,
    plane_blurx: plane_blurx,
    plane_blury: plane_blury,
    plane_dilate: plane_dilate,
    plane_emboss: plane_emboss,
    plane_erode: plane_erode,
    plane_gaussian: plane_gaussian,
    plane_gaussianx: plane_gaussianx,
    plane_gaussiany: plane_gaussiany,
    plane_laplacian: plane_laplacian,
    plane_sharpen: plane_sharpen,
    plane_sobel: plane_sobel,
    plane_sobelx: plane_sobelx,
    plane_sobely: plane_sobely,
    random: random,
    root: root,
    sample: sample,
    sampleOrZero: sampleOrZero,
    scratch: scratch,
    smoothstep: smoothstep
});

/**
 * Filter expressions → JavaScript, for running a filter without a GPU.
 *
 * The same language as the shaders (mathzetta/glsl's filterShader): the
 * same names (r g b a x y px py w h t gray rgb unchanged), the same
 * functions (pixel, blur, gaussian, sobel, zoom, the pictures a filter
 * names…), the same rules for turning a number or a colour into a pixel.
 * The GLSL is typed and so is this: every node of the expression gets a
 * type — float, bool, vec2, vec3 or vec4 — and becomes one local variable
 * per component inside a loop over the pixels. No vector objects exist at
 * run time; a filter is one straight-line loop body.
 *
 * Neighbourhood functions whose argument is the same for every pixel
 * (blur(radius) with radius a parameter) are worked out once per pass,
 * over the whole picture and separably — blur, gaussian, dilate and erode
 * over a square are a horizontal pass then a vertical one, the same sums
 * in a different order — then read per pixel. An argument that changes
 * per pixel falls back to computing that pixel's neighbourhood directly.
 *
 * The generated code is compiled with new Function only after mathzetta's
 * checkGeneratedJs has passed it: every name in it is one this file
 * generates ($-prefixed) or a Math member, it holds no strings, and only
 * the arrays made here can be indexed. A filter is user input — shared by
 * link, pasted as JSON — and can read the picture and write colours,
 * nothing else.
 */


const CUSTOM = '\\:';
const HELPERS = Object.keys(H).filter((k) => typeof H[k] === 'function');

/** Constants and leaves every expression has. */
const SCALARS = { r: '$r', g: '$g', b: '$b', a: '$a', x: '$x', y: '$y', px: '$px', py: '$py', w: '$w', h: '$h', t: '$t', gray: '$gray' };
const CONSTANTS = { pi: 'Math.PI', 'π': 'Math.PI', e: 'Math.E', tau: '(2 * Math.PI)', 'τ': '(2 * Math.PI)', '∞': 'Infinity', '-∞': '(-Infinity)' };

/** Functions applied to each component: name → (args as JS) => JS. */
const COMPONENTWISE = {
    sqrt: 1, abs: 1, floor: 1, ceil: 1, ln: 'log', sin: 1, cos: 1, tan: 1, arcsin: 'asin', arccos: 'acos', arctan: 'atan',
    sinh: 1, cosh: 1, tanh: 1, arcsinh: 'asinh', arccosh: 'acosh', arctanh: 'atanh', sign: 1, exp: 1, exp2: (x) => `Math.pow(2, ${x})`,
    log2: 1, expm1: (x) => `(Math.exp(${x}) - 1)`, loglog: (x) => `Math.log(Math.log(${x}))`, logloglog: (x) => `Math.log(Math.log(Math.log(${x})))`,
    csc: (x) => `(1 / Math.sin(${x}))`, sec: (x) => `(1 / Math.cos(${x}))`, cot: (x) => `(1 / Math.tan(${x}))`,
    fract: (x) => `(${x} - Math.floor(${x}))`, radians: (x) => `(${x} * 0.017453292519943295)`, degrees: (x) => `(${x} * 57.29577951308232)`,
    inversesqrt: (x) => `(1 / Math.sqrt(${x}))`,
    atan2: (y, x) => `Math.atan2(${y}, ${x})`, pow: (x, y) => `Math.pow(${x}, ${y})`,
    mod: (x, y) => `(${x} - ${y} * Math.floor(${x} / ${y}))`,
    step: (edge, x) => `(${x} < ${edge} ? 0 : 1)`,
    clamp: (x, lo, hi) => `Math.min(Math.max(${x}, ${lo}), ${hi})`,
    mix: (a, b, k) => `(${a} + (${b} - ${a}) * ${k})`,
    smoothstep: (e0, e1, x) => `$h_smoothstep(${e0}, ${e1}, ${x})`,
};
const FIXED_ARITY = { atan2: 2, pow: 2, mod: 2, step: 2, clamp: 3, mix: 3, smoothstep: 3 };

/** Neighbourhood functions: the result kind, and whether the per-pass plane is computed once for a constant argument. */
const PLANES = {
    blur: 3, blurx: 3, blury: 3, gaussian: 3, gaussianx: 3, gaussiany: 3, dilate: 3, erode: 3, sharpen: 3,
    sobel: 1, sobelx: 1, sobely: 1, laplacian: 1, emboss: 1,
};

/** A value: a kind ('f' number, 'b' true/false, 'v' vector) and one JS expression per component. */
const val = (kind, c) => ({ kind, c });
const f = (e) => val('f', [e]);
const bool = (e) => val('b', [e]);
const vec = (c) => (c.length === 1 ? f(c[0]) : val('v', c));
/** A component as a number: true/false count as 1/0, as when GLSL converts. */
const num = (v, k = 0) => (v.kind === 'b' ? `(${v.c[0]} ? 1 : 0)` : v.kind === 'f' ? v.c[0] : v.c[k] ?? v.c[0]);
const size = (v) => (v.kind === 'v' ? v.c.length : 1);

class CompileError extends Error {}

/**
 * Compile one pass of a compiled filter (compileFilter().passes[i]) for the CPU.
 * @returns {{ run: (ctx) => void, source: string }}
 */
function compileCpuPass(pass) {
    if (pass.blendKept) return { blend: true, source: '' };
    const params = pass.params ?? {};
    const pictures = new Set([...Object.keys(pass.placements ?? {}), 'source', 'selection']);
    const g = new Generator(params, pictures, pass.space ?? 'srgb');
    g.graphics = new Set(Object.keys(pass.graphics ?? {}));        // drawn by the caller; transparent until they are
    g.bind = pass.bind ?? {};                                         // a graphic's name here → the key its picture is bound under
    const channels = typeof pass.color === 'string' ? { rgba: pass.color } : pass.color;
    const parse = (text, whole) => {
        const names = [...FILTER_FUNCTIONS, ...Object.keys(pass.placements ?? {})];
        const values = [...FILTER_VALUES, ...Object.keys(params)];
        return filterPictureCalls(parseTree(text, { names, values, blocks: null }), pictures, { whole });
    };
    for (const ch of ['rgba', 'rgb', 'r', 'g', 'b', 'a']) {
        if (!channels[ch]) continue;
        let tree;
        try { tree = parse(channels[ch], ch === 'rgba'); } catch (e) { throw new CompileError(e.message); }
        g.channel(ch, tree);
    }
    const source = g.source();
    // the gate: only names made here, Math, operators and numbers; no strings; only our arrays indexed
    checkGeneratedJs(source, { variables: /^\$\w+$/, indexable: /^\$[A-Z]\w*$/, strings: false });
    const fn = new Function(...g.parameters(), source);
    return {
        source,
        uses: g.uses,
        pictures: [...g.pictureNames],
        run(ctx) { fn(...g.arguments(ctx)); },
    };
}

class Generator {
    constructor(params, pictures, space = 'srgb') {
        this.params = params;
        this.pictures = pictures;
        this.space = space === 'srgb' ? null : space;    // the frame holds this space: pictures are converted as read
        this.pre = [];               // before the loop: params, planes
        this.body = [];              // per pixel
        this.n = 0;
        this.uses = new Set();       // 'source', picture names, 'random' …
        this.pictureNames = new Set();
        this.perPixel = new Map();   // picture sample at this pixel: name → vec4 value (computed once)
        this.planes = new Map();     // key → plane variable
        this.scratch = 0;
    }

    temp(expr, into = this.body) {
        const name = `$v${this.n++}`;
        into.push(`let ${name} = ${expr};`);
        return name;
    }

    /** A value whose components are temps (so an expression used twice is computed once). */
    keep(v, into = this.body) {
        return val(v.kind, v.c.map((e) => (/^[\w$.]+$|^\(?-?[\d.e+]+\)?$/.test(e) ? e : this.temp(e, into))));
    }

    fail(why) { throw new CompileError(why); }

    // ---- leaves ------------------------------------------------------------------

    leaf(node) {
        if (node.type === 'number') return f(`(${node.value.replace(/\.+$/, '')})`);
        if (node.type === 'string') this.fail('a filter has no text: numbers and colours only');
        const v = node.value;
        if (v === 't') this.uses.add('t');           // the filter animates (the page hides time for a still one)
        if (SCALARS[v]) return f(SCALARS[v]);
        if (v === 'rgb') return vec(['$r', '$g', '$b']);
        if (v === 'unchanged') return f('$u');   // the kept value; as a whole if/else branch it takes the other branch's type (ternary)
        if (v === 'selected') return f(this.pictureHere('selection').c[0]);   // the selection mask: white = 1; white everywhere when none
        if (CONSTANTS[v]) return f(CONSTANTS[v]);
        if (v === 'true' || v === 'false') return bool(v);
        if (Object.prototype.hasOwnProperty.call(this.params, v)) {
            const name = `$p_${v}`;
            return this.params[v].type === 'color' ? vec([`${name}_0`, `${name}_1`, `${name}_2`]) : f(name);
        }
        if (this.pictures.has(v)) { const p = this.pictureHere(v); return vec(p.c.slice(0, 3)); }
        if (v.startsWith('mz_px_') && this.pictures.has(v.slice(6))) return this.pictureHere(v.slice(6));
        this.fail(`unknown name "${v}"`);
    }

    /** A named picture's colour at this pixel (vec4), sampled once per pixel. */
    pictureHere(name) {
        if (!this.perPixel.has(name)) {
            const s = this.sampler(name, '$px', '$py');
            this.perPixel.set(name, this.keep(s));
        }
        return this.perPixel.get(name);
    }

    /** vec4 of picture `name` at frame position (X, Y) — `source`, or a placed picture, transparent outside. */
    sampler(name, X, Y) {
        const out = this.scratchArray();
        if (name === 'source') {
            this.uses.add('source');
            this.body.push(`$h_sample($S, $w, $h, ${X}, ${Y}, ${out});`);
        } else {
            this.pictureNames.add(name);
            this.body.push(`$h_picture($Q_${name}, $qw_${name}, $qh_${name}, $w, $h, $qz_${name}, $qx_${name}, $qy_${name}, $qa_${name}, $qm_${name}, ${X}, ${Y}, ${out});`);
        }
        if (this.space && name !== 'selection') this.body.push(`$h_col_to${this.space}(${out}[0], ${out}[1], ${out}[2], ${out});`);   // a mask is not a colour
        return vec([0, 1, 2, 3].map((k) => `${out}[${k}]`));
    }

    scratchArray() {
        const name = `$T${this.scratch++}`;
        this.pre.push(`let ${name} = $h_scratch();`);
        return name;
    }

    // ---- operations -------------------------------------------------------------

    value(node) {
        return node.type === 'op' ? this.op(node) : this.leaf(node);
    }

    op(node) {
        const { op, args } = node;
        const custom = op.startsWith(CUSTOM) ? op.slice(CUSTOM.length) : null;
        if (custom !== null) return this.call(custom, args, node);
        const A = () => args.map((a) => this.value(a));
        switch (op) {
            case '+': case '-': case '*': case '/': {
                const [a, b] = A();
                return this.componentwise([a, b], (x, y) => `(${x} ${op} ${y})`);
            }
            case 'neg': return this.componentwise(A(), (x) => `(-${x})`);
            case '^': return this.power(args);
            case 'mod': return this.componentwise(A(), COMPONENTWISE.mod);
            case '<': case '>': case '≤': case '≥': {
                const [a, b] = A();
                const sym = { '≤': '<=', '≥': '>=' }[op] ?? op;
                return bool(`(${num(a)} ${sym} ${num(b)})`);
            }
            case '=': case '===': case '≠': case '≠=': case '≡': {
                const [a, b] = A();
                const n = Math.max(size(a), size(b));
                const all = Array.from({ length: n }, (_, k) => `${num(a, k)} === ${num(b, k)}`).join(' && ');
                return bool(op === '≠' || op === '≠=' ? `!(${all})` : `(${all})`);
            }
            case '≈': { const [a, b] = A(); return bool(`(Math.abs(${num(a)} - ${num(b)}) < 1e-5)`); }
            case '&': { const [a, b] = A(); return bool(`(${this.truth(a)} && ${this.truth(b)})`); }
            case '|': { const [a, b] = A(); return bool(`(${this.truth(a)} || ${this.truth(b)})`); }
            case '\\xor': { const [a, b] = A(); return bool(`(${this.truth(a)} !== ${this.truth(b)})`); }
            case '\\nand': { const [a, b] = A(); return bool(`!(${this.truth(a)} && ${this.truth(b)})`); }
            case '\\nor': { const [a, b] = A(); return bool(`!(${this.truth(a)} || ${this.truth(b)})`); }
            case '\\not': { const [a] = A(); return bool(`!${this.truth(a)}`); }
            case '?:': return this.ternary(args);
            case 'max': case 'min': return this.componentwise(A(), (...xs) => `Math.${op}(${xs.join(', ')})`);
            case 'sum': return this.componentwise(A(), (...xs) => `(${xs.join(' + ')})`);
            case 'prod': return this.componentwise(A(), (...xs) => `(${xs.join(' * ')})`);
            case 'mean': return this.componentwise(A(), (...xs) => `((${xs.join(' + ')}) / ${xs.length})`);
            case '()': case '[]': case '{}': case '(]': case '[)': {
                const parts = A().flatMap((v) => (v.kind === 'b' ? [num(v)] : v.c.map((_, k) => num(v, k))));
                if (parts.length > 4) this.fail('a colour has at most 4 values (r, g, b, a)');
                return vec(parts);
            }
            case '!': return this.componentwise(A(), (x) => `$h_factorial(${x})`);
            case 'perm': return this.componentwise(A(), (n, k) => `$h_perm(${n}, ${k})`);
            case 'comb': return this.componentwise(A(), (n, k) => `($h_perm(${n}, ${k}) / $h_factorial(${k}))`);
            case 'gcd': return this.componentwise(A(), (...xs) => xs.reduce((acc, x) => `$h_gcd(${acc}, ${x})`));
            case 'round': {
                const [v, d] = A();
                return this.componentwise([v, d], (x, digits) => `(Math.floor(${x} * Math.pow(10, ${digits}) + 0.5) / Math.pow(10, ${digits}))`);
            }
            case 'log': { const [base, x] = A(); return this.componentwise([base, x], (b, xx) => `(Math.log(${xx}) / Math.log(${b}))`); }
            case 'root': { const [n, x] = A(); return this.componentwise([n, x], (nn, xx) => `$h_root(${nn}, ${xx})`); }
            case '∈': case '∉': return this.membership(node);
            case 'random': return this.random();
            case '_': {
                const [a, b] = args;
                if (a.type === 'symbol' && (b.type === 'number' || b.type === 'symbol')) return this.leaf({ type: 'symbol', value: `${a.value}_${b.value}` });
                break;
            }
        }
        if (COMPONENTWISE[op]) return this.builtin(op, A());
        this.fail(`"${op}" isn't available in a filter`);
    }

    truth(v) { return v.kind === 'b' ? v.c[0] : `(${num(v)} !== 0)`; }

    /** Apply fn to each component; a number (or true/false) is used for every component of a vector. */
    componentwise(values, fn) {
        const sizes = values.map(size);
        const n = Math.max(...sizes);
        const vectors = new Set(sizes.filter((s) => s > 1));
        if (vectors.size > 1) this.fail(`can't combine vectors of ${[...vectors].join(' and ')} values`);
        const out = Array.from({ length: n }, (_, k) => fn(...values.map((v) => num(v, k))));
        return this.keep(vec(out));
    }

    builtin(name, values) {
        const spec = COMPONENTWISE[name];
        if (FIXED_ARITY[name] && values.length !== FIXED_ARITY[name]) this.fail(`${name}() takes ${FIXED_ARITY[name]} values`);
        if (typeof spec === 'function') return this.componentwise(values, spec);
        const fn = spec === 1 ? name : spec;
        return this.componentwise(values, (...xs) => `Math.${fn}(${xs.join(', ')})`);
    }

    /** x^n as the shader writes it: products for small whole powers, exp for e^x, pow otherwise. */
    power([base, exp]) {
        const n = exp.type === 'number' && /^-?\d+$/.test(exp.value) ? Number(exp.value) : null;
        const b = this.keep(this.value(base));
        const times = (k) => this.componentwise([b], (x) => Array(k).fill(x).join(' * '));
        if (n === 0) return this.componentwise([b], () => '1');
        if (n !== null && n >= 1 && n <= 4) return times(n);
        if (n !== null && n <= -1 && n >= -4) return this.componentwise([times(-n)], (x) => `(1 / ${x})`);
        if (base.type === 'symbol' && base.value === 'e') return this.componentwise([this.value(exp)], (x) => `Math.exp(${x})`);
        if (base.type === 'number' && base.value === '2') return this.componentwise([this.value(exp)], (x) => `Math.pow(2, ${x})`);
        return this.componentwise([b, this.value(exp)], (x, y) => `Math.pow(${x}, ${y})`);
    }

    ternary([c, yes, no]) {
        const cond = this.truth(this.value(c));
        const isU = (n) => n.type === 'symbol' && n.value === 'unchanged';
        let a = isU(yes) ? null : this.value(yes);
        let b = isU(no) ? null : this.value(no);
        // `unchanged` in a branch takes the other branch's type (mz_unchanged in the shader)
        const unchangedLike = (other) => (other.kind === 'b' ? bool('($u > 0.5)') : other.kind === 'f' ? f('$u')
            : vec(['$k0', '$k1', '$k2', '$k3'].slice(0, other.c.length === 4 ? 4 : 3)));
        if (!a && !b) return f('$u');
        if (!a) a = unchangedLike(b);
        if (!b) b = unchangedLike(a);
        if (a.kind === 'b' && b.kind === 'b') return bool(this.temp(`(${cond} ? ${a.c[0]} : ${b.c[0]})`));
        const n = Math.max(size(a), size(b));
        const out = Array.from({ length: n }, (_, k) => this.temp(`(${cond} ? ${num(a, k)} : ${num(b, k)})`));
        return vec(out);
    }

    membership(node) {
        const [x, set] = node.args;
        const v = num(this.value(x));
        const negate = node.op === '∉';
        let test;
        if (set.type === 'op' && ['()', '[]', '(]', '[)'].includes(set.op) && set.args.length === 2) {
            const [lo, hi] = set.args.map((a) => num(this.value(a)));
            test = `(${v} ${set.op[0] === '[' ? '>=' : '>'} ${lo} && ${v} ${set.op[1] === ']' ? '<=' : '<'} ${hi})`;
        } else if (set.type === 'op' && set.op === '{}') {
            test = `(${set.args.map((item) => `${v} === ${num(this.value(item))}`).join(' || ')})`;
        } else if (set.type === 'symbol' && ['ℝ', 'ℤ', 'ℕ'].includes(set.value)) {
            test = { 'ℝ': `Number.isFinite(${v})`, 'ℤ': `Number.isInteger(${v})`, 'ℕ': `(Number.isInteger(${v}) && ${v} > 0)` }[set.value];
        } else this.fail('∈ needs an interval [a, b], a set {…}, ℝ, ℤ or ℕ');
        return bool(negate ? `!${test}` : test);
    }

    random() {
        this.uses.add('random');
        return f(this.temp('$h_random($px, $py, $h, ++$seed)'));
    }

    // ---- functions: pictures, geometry, neighbourhoods, GLSL built-ins ------------

    call(name, args, node) {
        const A = () => args.map((a) => this.value(a));
        if (name.startsWith('mz_sample_')) {                      // a picture read with its alpha: 0 outside it
            const picture = name.slice(10);
            const [p0, p1] = A();
            const [X, Y] = p1 ? [num(p0), num(p1)] : [num(p0, 0), num(p0, 1)];
            if (picture === 'image') {
                const out = this.scratchArray();
                this.body.push(`$h_sampleOrZero($I, $w, $h, ${X}, ${Y}, ${out});`);
                return this.keep(vec([0, 1, 2, 3].map((k) => `${out}[${k}]`)));
            }
            if (!this.pictures.has(picture)) this.fail(`unknown picture "${picture}"`);
            return this.keep(this.sampler(picture, X, Y));
        }
        if (name.startsWith('mz_at_')) {
            const picture = name.slice(6);
            const [p0, p1] = A();
            const [X, Y] = p1 ? [num(p0), num(p1)] : [num(p0, 0), num(p0, 1)];
            if (picture === 'image') {
                const out = this.scratchArray();
                this.body.push(`$h_sampleOrZero($I, $w, $h, ${X}, ${Y}, ${out});`);
                return vec([0, 1, 2].map((k) => `${out}[${k}]`));
            }
            if (!this.pictures.has(picture)) this.fail(`unknown picture "${picture}"`);
            return this.keep(vec(this.sampler(picture, X, Y).c.slice(0, 3)));
        }
        if (name.startsWith('mz_width_') || name.startsWith('mz_height_')) {
            const picture = name.replace(/^mz_(width|height)_/, '');
            this.pictureNames.add(picture);
            return f(name.startsWith('mz_width_') ? `$qw_${picture}` : `$qh_${picture}`);
        }
        switch (name) {
            case 'pixel': {
                const [X, Y] = A().map((v) => num(v));
                const out = this.scratchArray();
                this.body.push(`$h_sample($I, $w, $h, ${X}, ${Y}, ${out});`);
                return this.keep(vec([0, 1, 2, 3].map((k) => `${out}[${k}]`)));
            }
            case 'red': case 'green': case 'blue': case 'alpha': case 'luma': {
                let v;
                if (args.length === 2) v = this.call('pixel', args);
                else if (args.length === 1) v = this.value(args[0]);
                else this.fail(`${name}() takes a colour, or a position px, py`);
                const k = { red: 0, green: 1, blue: 2, alpha: 3 }[name];
                if (name === 'luma') return f(`(${num(v, 0)} * 0.299 + ${num(v, 1)} * 0.587 + ${num(v, 2)} * 0.114)`);
                if (name === 'alpha' && size(v) === 3) return f('1');
                return f(num(v, k));
            }
            case 'length': { const [v] = A(); return f(`Math.sqrt(${v.c.map((_, k) => `${num(v, k)} * ${num(v, k)}`).join(' + ')})`); }
            case 'distance': {
                const [a, b] = A();
                const d = this.componentwise([a, b], (x, y) => `(${x} - ${y})`);
                return f(`Math.sqrt(${d.c.map((e) => `${e} * ${e}`).join(' + ')})`);
            }
            case 'dot': {
                const [a, b] = A();
                const n = Math.max(size(a), size(b));
                return f(`(${Array.from({ length: n }, (_, k) => `${num(a, k)} * ${num(b, k)}`).join(' + ')})`);
            }
            case 'normalize': {
                const [v] = A();
                const len = this.temp(`Math.sqrt(${v.c.map((_, k) => `${num(v, k)} * ${num(v, k)}`).join(' + ')})`);
                return this.componentwise([v], (x) => `(${x} / ${len})`);
            }
            case 'cross': {
                const [a, b] = A();
                if (size(a) !== 3 || size(b) !== 3) this.fail('cross() takes two colours (3 values each)');
                const [x1, y1, z1] = a.c; const [x2, y2, z2] = b.c;
                return this.keep(vec([`(${y1} * ${z2} - ${z1} * ${y2})`, `(${z1} * ${x2} - ${x1} * ${z2})`, `(${x1} * ${y2} - ${y1} * ${x2})`]));
            }
            case 'convolve': {
                const ks = A().map((v) => num(v));
                if (ks.length !== 9) this.fail('convolve() takes 9 numbers: the 3×3 kernel, row by row');
                const out = this.scratchArray();
                this.body.push(`$h_convolve($I, $w, $h, $px, $py, ${ks.join(', ')}, ${out});`);
                return vec([0, 1, 2].map((k) => `${out}[${k}]`));
            }
            case 'mz_zoom': case 'mz_shift': case 'mz_rotate': case 'mz_crop': case 'mz_tile': case 'mz_flipx': case 'mz_flipy':
                return this.geometry(name.slice(3), A().map((v) => num(v)));
            case 'tolinear': case 'fromlinear': case 'tohsv': case 'fromhsv': case 'tohsl': case 'fromhsl':
            case 'tolab': case 'fromlab': case 'tooklab': case 'fromoklab': case 'toycbcr': case 'fromycbcr': {
                const a = A();
                const c = a.length === 3 ? a.map((v) => num(v)) : [0, 1, 2].map((k) => num(a[0], k));   // a colour, or three numbers
                if (a.length !== 1 && a.length !== 3) this.fail(`${name}() takes a colour`);
                const out = this.scratchArray();
                this.body.push(`$h_col_${name}(${c.join(', ')}, ${out});`);
                return this.keep(vec([0, 1, 2].map((k) => `${out}[${k}]`)));
            }
            case 'random': return this.random();
            case 'exp': case 'exp2': case 'log2': case 'sign': case 'fract': case 'radians': case 'degrees': case 'inversesqrt':
            case 'pow': case 'mod': case 'step': case 'clamp': case 'mix': case 'smoothstep':
            case 'abs': case 'floor': case 'ceil': case 'sqrt': case 'sin': case 'cos': case 'tan':
                return this.builtin(name, A());
            case 'asin': return this.builtin('arcsin', A());
            case 'acos': return this.builtin('arccos', A());
            case 'atan': return args.length === 2 ? this.builtin('atan2', A()) : this.builtin('arctan', A());
            case 'log': return this.builtin('ln', A());
            case 'max': case 'min': return this.componentwise(A(), (...xs) => `Math.${name}(${xs.join(', ')})`);
        }
        if (PLANES[name]) return this.neighbourhood(name, args);
        this.fail(`unknown function "${name}"`);
    }

    /** Where to read the picture from (vec2, pixels): the shader's mz_zoom … mz_flipy. */
    geometry(kind, a) {
        const P = (x, y) => this.keep(vec([x, y]));
        switch (kind) {
            case 'zoom': {
                const [s, cx = '0.5', cy = '0.5'] = a;
                const c = P(`(${cx} * $w - 0.5)`, `(${cy} * $h - 0.5)`);
                return P(`(${c.c[0]} + ($px - ${c.c[0]}) / ${s})`, `(${c.c[1]} + ($py - ${c.c[1]}) / ${s})`);
            }
            case 'shift': {
                const [dx, dy] = a;
                return P(`($h_fmod($px - ${dx} + 0.5, $w) - 0.5)`, `($h_fmod($py - ${dy} + 0.5, $h) - 0.5)`);
            }
            case 'rotate': {
                const [ang, cx = '0.5', cy = '0.5'] = a;
                const c = P(`(${cx} * $w - 0.5)`, `(${cy} * $h - 0.5)`);
                const d = P(`($px - ${c.c[0]})`, `($py - ${c.c[1]})`);
                const cs = this.keep(vec([`Math.cos(${ang})`, `Math.sin(${ang})`]));
                return P(`(${c.c[0]} + ${cs.c[0]} * ${d.c[0]} + ${cs.c[1]} * ${d.c[1]})`, `(${c.c[1]} + ${cs.c[0]} * ${d.c[1]} - ${cs.c[1]} * ${d.c[0]})`);
            }
            case 'crop': {
                const [x0, y0, x1, y1] = a;
                return P(`((${x0} + (${x1} - ${x0}) * ($px + 0.5) / $w) * $w - 0.5)`, `((${y0} + (${y1} - ${y0}) * ($py + 0.5) / $h) * $h - 0.5)`);
            }
            case 'tile': {
                const [nx, ny = nx] = a;
                return P(`($h_fmod(($px + 0.5) * ${nx}, $w) - 0.5)`, `($h_fmod(($py + 0.5) * ${ny}, $h) - 0.5)`);
            }
            case 'flipx': return P('($w - 1 - $px)', '$py');
            case 'flipy': return P('$px', '($h - 1 - $py)');
        }
        this.fail(`unknown geometry ${kind}`);
    }

    /**
     * blur(radius) and friends. With an argument the same for every pixel (numbers, params, t),
     * the whole plane is computed once before the loop; otherwise this pixel's neighbourhood is.
     */
    neighbourhood(name, args) {
        const kind = PLANES[name];
        const constant = args.every((a) => this.isUniform(a));
        if (constant) {
            const argJs = args.map((a) => num(this.uniformValue(a)));
            const key = `${name}(${argJs.join(',')})`;
            if (!this.planes.has(key)) {
                const plane = `$N${this.planes.size}`;
                this.pre.push(`let ${plane} = $h_plane_${name}($I, $w, $h, $y0, $y1${argJs.map((x) => `, ${x}`).join('')});`);
                this.planes.set(key, plane);
            }
            const plane = this.planes.get(key);
            return kind === 3 ? vec([0, 1, 2].map((k) => `${plane}[$j3 + ${k}]`)) : f(`${plane}[$j]`);
        }
        const argJs = args.map((a) => num(this.value(a)));
        if (kind === 1) return f(this.temp(`$h_at_${name}($I, $w, $h, $px, $py${argJs.map((x) => `, ${x}`).join('')})`));
        const out = this.scratchArray();
        this.body.push(`$h_at_${name}($I, $w, $h, $px, $py${argJs.map((x) => `, ${x}`).join('')}, ${out});`);
        return vec([0, 1, 2].map((k) => `${out}[${k}]`));
    }

    /** Does this subtree read nothing that changes from pixel to pixel? */
    isUniform(node) {
        if (node.type === 'number') return true;
        if (node.type === 'symbol') {
            return ['w', 'h', 't'].includes(node.value) || Boolean(CONSTANTS[node.value])
                || (Object.prototype.hasOwnProperty.call(this.params, node.value) && this.params[node.value].type !== 'color');
        }
        if (node.type !== 'op' || node.op.startsWith(CUSTOM) || node.op === 'random') return false;
        return node.args.every((a) => this.isUniform(a));
    }

    /** A uniform subtree, generated before the loop. */
    uniformValue(node) {
        const saved = this.body;
        this.body = this.pre;
        try { return this.value(node); } finally { this.body = saved; }
    }

    // ---- assembling the pass ------------------------------------------------------

    /** One channel line of the colour, as filterShader writes it (mz_keep, then mz_rgba / mz_rgb / mz_ch_*). */
    channel(ch, tree) {
        const keepValue = ch === 'rgba' || ch === 'rgb' ? '$gray' : `$c${'rgba'.indexOf(ch)}`;
        this.body.push(`$u = ${keepValue}; $k0 = $c0; $k1 = $c1; $k2 = $c2; $k3 = $c3;`);
        const v = this.value(tree);
        const n = size(v);
        const comp = (k) => num(v, k);
        if (ch === 'rgba') {
            if (n === 2) this.fail('a colour is one number (grey), three (r, g, b) or four (r, g, b, a) — not two');
            const c = n === 1 ? [comp(0), comp(0), comp(0), '1'] : n === 3 ? [comp(0), comp(1), comp(2), '1'] : [0, 1, 2, 3].map(comp);
            this.body.push(`$c0 = ${c[0]}; $c1 = ${c[1]}; $c2 = ${c[2]}; $c3 = ${c[3]};`);
        } else if (ch === 'rgb') {
            if (n === 2) this.fail('a colour is one number (grey), three (r, g, b) or four — not two');
            const c = n === 1 ? [comp(0), comp(0), comp(0)] : [comp(0), comp(1), comp(2)];
            this.body.push(`$c0 = ${c[0]}; $c1 = ${c[1]}; $c2 = ${c[2]};`);
        } else {
            const k = 'rgba'.indexOf(ch);
            const x = n === 1 ? comp(0) : n === 3 ? (ch === 'a' ? '1' : comp(k)) : comp(k);
            this.body.push(`$c${k} = ${x};`);
        }
    }

    parameters() {
        const pictures = [...this.pictureNames];
        return ['$I', '$O', '$S', '$w', '$h', '$t', '$P', '$op', '$y0', '$y1',
            ...pictures.flatMap((p) => [`$Q_${p}`, `$qw_${p}`, `$qh_${p}`, `$qz_${p}`, `$qx_${p}`, `$qy_${p}`, `$qa_${p}`, `$qm_${p}`]),
            ...HELPERS.map((k) => `$h_${k}`)];
    }

    arguments(ctx) {
        const pictures = [...this.pictureNames];
        return [ctx.input, ctx.output, ctx.source, ctx.width, ctx.height, ctx.t, ctx.params, ctx.opacity, ctx.y0 ?? 0, ctx.y1 ?? ctx.height,
            ...pictures.flatMap((p) => {
                const pic = ctx.pictures[this.bind?.[p] ?? p] ?? (this.graphics?.has(p) ? CLEAR : BLANK);
                const pl = ctx.placements[p] ?? {};
                return [pic.data, pic.width, pic.height, Number(pl.zoom ?? 1), Number(pl.x ?? 0.5), Number(pl.y ?? 0.5), Number(pl.angle ?? 0), placeCode(pl.place)];
            }),
            ...HELPERS.map((k) => H[k])];
    }

    source() {
        const paramLines = Object.entries(this.params).map(([name, p], i) => (p.type === 'color'
            ? `let $p_${name}_0 = $P[${i}][0], $p_${name}_1 = $P[${i}][1], $p_${name}_2 = $P[${i}][2];`
            : `let $p_${name} = $P[${i}];`));
        return [
            ...paramLines.map((l) => l.replace(/\$P\[(\d+)\]\[(\d)\]/g, '$h_at($P, $1, $2)')),
            'let $u = 0, $k0 = 0, $k1 = 0, $k2 = 0, $k3 = 0, $seed = 0, $CS = $h_scratch();',
            ...this.pre,
            'for (let $py = $y0; $py < $y1; $py++) {',
            '  for (let $px = 0; $px < $w; $px++) {',
            '    let $j = $py * $w + $px, $j3 = $j * 3, $j4 = $j * 4;',
            '    let $r = $I[$j4], $g = $I[$j4 + 1], $b = $I[$j4 + 2], $a = $I[$j4 + 3];',
            '    let $c0 = $r, $c1 = $g, $c2 = $b, $c3 = $a;',
            '    let $x = ($px + 0.5) / $w, $y = ($py + 0.5) / $h;',
            this.space
                ? `    $h_col_from${this.space}($r, $g, $b, $CS); let $gray = $CS[0] * 0.299 + $CS[1] * 0.587 + $CS[2] * 0.114;`   // the brightness as seen
                : '    let $gray = $r * 0.299 + $g * 0.587 + $b * 0.114;',
            '    $seed = $t;',
            ...this.body.map((l) => `    ${l}`),
            '    $O[$j4] = $r + ($c0 - $r) * $op;',
            '    $O[$j4 + 1] = $g + ($c1 - $g) * $op;',
            '    $O[$j4 + 2] = $b + ($c2 - $b) * $op;',
            '    $O[$j4 + 3] = $a + ($c3 - $a) * $op;',
            '  }',
            '}',
        ].join('\n');
    }
}

/**
 * Runs a compiled filter (compileFilter()) on the CPU — no GPU, no WebGL —
 * with the same interface as createFilterRunner:
 *
 *   const runner = createCpuRunner(compileFilter(def));
 *   runner.setImage(imageData);                 // ImageData, { data, width, height }, or in a browser an <img>/<canvas>/<video>
 *   runner.setImage('mask', maskImage);
 *   const out = runner.draw({ t: 0 });          // { data: Uint8ClampedArray, width, height }
 *   runner.draw({ t: 0, canvas });              // …and put it on a canvas
 *   runner.passes[0].values.cutoff = 0.3;       // knobs change without recompiling
 *
 * Works in Node too (thumbnails, servers, tests without a browser).
 *
 * draw() runs on the calling thread. drawAsync() spreads each pass's rows
 * over a pool of workers when the picture is large enough to be worth it
 * (≥ options.parallelFrom pixels, 250k by default); with SharedArrayBuffer
 * (Node, or a cross-origin isolated page) the workers read and write the
 * pictures in place, otherwise each gets a copy of the input and sends its
 * rows back. Both give the same pixels. The worker is cpu-worker.js beside this
 * module (options.workerUrl to put it elsewhere); from another origin — a CDN —
 * it is started through a same-origin blob: module that imports it. When no
 * worker can start, drawAsync() draws on the calling thread instead.
 *
 * Between passes the picture is rounded to 8 bits, as the GPU runner's
 * textures are, so both give the same pixels; { precision: 'float' } keeps
 * full precision instead (like 'float' textures on the GPU).
 */


function createCpuRunner(compiled, options = {}) {
    const precision = options.precision === 'float' || options.precision === 'half' ? 'float' : 'byte';
    const programs = compiled.passes.map((pass) => compileCpuPass(pass));
    const pictures = {};
    let source = null;
    const parallelFrom = options.parallelFrom ?? 250000;
    const wanted = options.workers === undefined || options.workers === 'auto' ? defaultWorkers() : Number(options.workers);
    let pool = null;           // created on the first drawAsync() that needs it
    let sent = new Map();      // picture name → the object last sent to the pool

    const runner = {
        passes: compiled.passes,
        get precision() { return precision; },
        /** The generated JavaScript of each pass, for the curious (and the tests). */
        sources: programs.map((p) => p.source),

        setImage(name, image) {
            if (typeof name !== 'string') { image = name; name = null; }
            const picture = toPicture(image);
            if (!name || name === 'source') source = picture;
            else pictures[name] = picture;
            return runner;
        },

        /** Runs every pass; returns the result as 8-bit RGBA (and draws it on `canvas` when given). */
        draw({ t = 0, canvas = null } = {}) {
            if (!source) throw new Error('setImage() first');
            const { width, height } = source;
            const n = width * height * 4;
            let input = source.data;
            const kept = [];
            compiled.passes.forEach((pass, i) => {
                for (let k = 0; k < pass.keepInput; k++) kept.push(input);
                const output = new Float32Array(n);
                if (pass.blendKept) {
                    const base = kept.pop();
                    const o = pass.opacity;
                    for (let j = 0; j < n; j++) output[j] = base[j] + (input[j] - base[j]) * o;
                } else {
                    programs[i].run({
                        input, output, source: source.data, width, height, t,
                        params: Object.keys(pass.params ?? {}).map((name) => pass.values[name]),
                        opacity: pass.opacity, pictures, placements: pass.placements ?? {},
                    });
                }
                if (precision === 'byte') quantize(output);
                input = output;
            });
            const data = new Uint8ClampedArray(n);
            for (let j = 0; j < n; j++) {
                const v = input[j];
                data[j] = v > 0 ? (v < 1 ? Math.round(v * 255) : 255) : 0;   // NaN → 0, as a GPU writes it
            }
            const out = { data, width, height };
            if (canvas) {
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
            }
            return out;
        },

        /**
         * As draw(), with each pass's rows spread over workers when the picture is large;
         * smaller pictures (or no workers available) run here, as draw().
         */
        async drawAsync({ t = 0, canvas = null } = {}) {
            if (!source) throw new Error('setImage() first');
            const { width, height } = source;
            if (wanted < 2 || width * height < parallelFrom) return runner.draw({ t, canvas });
            if (pool === null) pool = await createPool(wanted, compiled.passes, options.workerUrl).catch(() => false);   // false: workers can't start here
            if (!pool) return runner.draw({ t, canvas });
            const n = width * height * 4;
            const alloc = () => (pool.shared ? new Float32Array(new SharedArrayBuffer(n * 4)) : new Float32Array(n));
            // pictures the workers haven't seen (as shared copies when we can share)
            for (const [name, picture] of [['source', source], ...Object.entries(pictures)]) {
                if (sent.get(name) === picture) continue;
                await pool.broadcast({ type: 'picture', name, picture: pool.shared ? sharedPicture(picture) : picture });
                sent.set(name, picture);
            }
            let input = pool.shared ? sharedPicture(source).data : source.data;
            const kept = [];
            for (let i = 0; i < compiled.passes.length; i++) {
                const pass = compiled.passes[i];
                for (let k = 0; k < pass.keepInput; k++) kept.push(input);
                const output = alloc();
                if (pass.blendKept) {
                    const base = kept.pop();
                    for (let j = 0; j < n; j++) output[j] = base[j] + (input[j] - base[j]) * pass.opacity;
                    if (precision === 'byte') quantize(output);
                } else {
                    const params = Object.keys(pass.params ?? {}).map((name) => pass.values[name]);
                    const bands = splitRows(height, pool.size);
                    const replies = await Promise.all(bands.map(([y0, y1], k) => pool.ask(k, {
                        type: 'run', pass: i, input, output: pool.shared ? output : null, width, height, t, params,
                        opacity: pass.opacity, placements: pass.placements ?? {}, y0, y1, quantize: precision === 'byte',
                    })));
                    if (!pool.shared) replies.forEach((r, k) => output.set(r.band, bands[k][0] * width * 4));
                }
                input = output;
            }
            const data = new Uint8ClampedArray(n);
            for (let j = 0; j < n; j++) { const v = input[j]; data[j] = v > 0 ? (v < 1 ? Math.round(v * 255) : 255) : 0; }
            const out = { data, width, height };
            if (canvas) {
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
            }
            return out;
        },

        /** How many workers drawAsync() uses (0 until it first needs them). */
        get workers() { return pool ? pool.size : 0; },

        dispose() {
            source = null;
            for (const k of Object.keys(pictures)) delete pictures[k];
            if (pool) pool.close();
            pool = null;
            sent = new Map();
        },
    };
    return runner;
}

/** Clamp to 0–1 and round to 1/255: what an 8-bit texture keeps. */
function quantize(a) {
    for (let j = 0; j < a.length; j++) {
        const v = a[j];
        a[j] = v > 0 ? (v < 1 ? Math.round(v * 255) / 255 : 1) : 0;
    }
}

/** ImageData, { data, width, height } (8-bit or float), or a drawable in a browser → { data: Float32Array 0–1, width, height }. */
function toPicture(image) {
    if (image && image.data && image.width && image.height) {
        const src = image.data;
        const scale = src instanceof Float32Array || src instanceof Float64Array ? 1 : 1 / 255;
        const data = new Float32Array(image.width * image.height * 4);
        for (let j = 0; j < data.length; j++) data[j] = src[j] * scale;
        return { data, width: image.width, height: image.height };
    }
    if (typeof document !== 'undefined' || typeof OffscreenCanvas !== 'undefined') {
        const width = image.naturalWidth || image.videoWidth || image.width;
        const height = image.naturalHeight || image.videoHeight || image.height;
        if (!width || !height) throw new Error('setImage: the picture has no size yet (not loaded?)');
        const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, width, height);
        return toPicture(ctx.getImageData(0, 0, width, height));
    }
    throw new Error('setImage: give ImageData or { data, width, height }');
}

// ---- the worker pool -------------------------------------------------------------------

function defaultWorkers() {
    const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
    return Math.max(0, Math.min(8, cores - 1));
}

/** Row bands [y0, y1) of about equal size, one per worker. */
function splitRows(height, parts) {
    const out = [];
    for (let k = 0; k < parts; k++) {
        const y0 = Math.floor((height * k) / parts);
        const y1 = Math.floor((height * (k + 1)) / parts);
        if (y1 > y0) out.push([y0, y1]);
    }
    return out;
}

const canShare = () => typeof SharedArrayBuffer !== 'undefined' && (typeof crossOriginIsolated === 'undefined' || crossOriginIsolated === true);

function sharedPicture(picture) {
    if (picture.data.buffer instanceof (globalThis.SharedArrayBuffer ?? Object)) return picture;
    const data = new Float32Array(new SharedArrayBuffer(picture.data.byteLength));
    data.set(picture.data);
    picture.shared ??= { data, width: picture.width, height: picture.height };
    return picture.shared;
}

/** Workers that each compiled the filter; null when this platform can't start them. */
async function createPool(size, passes, workerUrl) {
    const url = new URL(workerUrl ?? './cpu-worker.js', import.meta.url);
    let make;
    if (typeof Worker !== 'undefined' && typeof window !== 'undefined') {
        // a worker script must come from the page's own origin: from a CDN, a blob: module that imports it does
        const start = url.origin === location.origin ? url
            : URL.createObjectURL(new Blob([`import ${JSON.stringify(url.href)};`], { type: 'text/javascript' }));
        make = () => {
            const w = new Worker(start, { type: 'module' });
            return { send: (m) => w.postMessage(m), on: (fn) => { w.onmessage = (e) => fn(e.data); w.onerror = (e) => fn({ id: -1, ok: false, error: e.message }); }, close: () => w.terminate() };
        };
    } else {
        try {
            const { Worker: NodeWorker } = await import('node:worker_threads');
            make = () => {
                const w = new NodeWorker(url);
                return { send: (m) => w.postMessage(m), on: (fn) => { w.on('message', fn); w.on('error', (e) => fn({ id: -1, ok: false, error: e.message })); }, close: () => w.terminate() };
            };
        } catch {
            return null;
        }
    }
    const workers = Array.from({ length: size }, make);
    let next = 1;
    const waiting = workers.map(() => new Map());
    workers.forEach((w, k) => w.on((m) => {
        if (m.id === -1) { for (const [, cb] of waiting[k]) cb.reject(new Error(m.error)); waiting[k].clear(); return; }
        const cb = waiting[k].get(m.id);
        if (!cb) return;
        waiting[k].delete(m.id);
        if (m.ok) cb.resolve(m); else cb.reject(new Error(m.error));
    }));
    const ask = (k, message) => new Promise((resolve, reject) => {
        const id = next++;
        waiting[k].set(id, { resolve, reject });
        workers[k].send({ ...message, id });
    });
    const pool = {
        size, shared: canShare(), ask,
        broadcast: (message) => Promise.all(workers.map((_, k) => ask(k, message))),
        close: () => workers.forEach((w) => w.close()),
    };
    await pool.broadcast({ type: 'init', passes: passes.map(({ fragment, ...rest }) => rest) });
    return pool;
}

/**
 * GPU or CPU? One call that picks, and says why.
 *
 *   const { runner, engine, reason } = createRunner(compileFilter(def), { gl });
 *   runner.setImage(img);  runner.draw({ t, canvas });   // canvas: where the CPU draws (the GPU draws on gl's)
 *
 * The GPU whenever WebGL is there: a filter's shaders are compiled once and
 * then reused for every picture and every frame, so the compile is paid once
 * per filter, and after that the GPU is the faster engine. The CPU when
 * there is no WebGL (some browsers, Node, servers), when the GPU refuses the
 * shader, or when asked for (prefer: 'cpu'). Both give the same pixels
 * (tools/check.mjs --cpu compares them on every library filter).
 */


/** @returns {{ engine: 'gpu' | 'cpu', reason: string }} */
function chooseEngine({ webgl = false, prefer = 'auto' } = {}) {
    if (prefer === 'cpu') return { engine: 'cpu', reason: 'asked for the CPU' };
    if (!webgl) return { engine: 'cpu', reason: 'no WebGL here' };
    return { engine: 'gpu', reason: prefer === 'gpu' ? 'asked for the GPU' : 'WebGL is here' };
}

/**
 * @param {object} compiled compileFilter() output
 * @param {object} [o] { gl, prefer: 'auto' | 'gpu' | 'cpu', precision, workers }
 * @returns {{ runner, engine: 'gpu' | 'cpu', reason: string }}
 */
function createRunner(compiled, o = {}) {
    const choice = chooseEngine({ webgl: Boolean(o.gl), prefer: o.prefer });
    if (choice.engine === 'gpu') {
        try {
            return { runner: createFilterRunner(o.gl, compiled, { precision: o.precision }), ...choice };
        } catch (e) {
            if (o.prefer === 'gpu') throw e;
            return { runner: createCpuRunner(compiled, o), engine: 'cpu', reason: `the GPU refused the shader (${e.message.split('\n')[0]})` };
        }
    }
    return { runner: createCpuRunner(compiled, o), ...choice };
}

/**
 * The built-in filters: what the editor offers, and a catalogue anyone
 * embedding the runner can show. Each is a filter document (docs/filters.md)
 * plus a `group` for display (not part of the format; sharing drops it);
 * `npm test` checks that every one validates, compiles and survives a link.
 */

const FILTERS = [
  { name: 'Wave', group: 'Shape & motion', description: 'Rows slide back and forth as t advances',
    params: { amplitude: { default: 8, min: 0, max: 40 }, wavelength: { default: 10, min: 1, max: 60 }, speed: { default: 5, min: 1, max: 30 } },
    color: 'pixel(px + amplitude sin(py / wavelength + t / speed), py)' },
  { name: 'Invert', group: 'Colour & tone', color: '(1 - r, 1 - g, 1 - b)' },
  { name: 'Grayscale', group: 'Colour & tone', color: 'gray' },
  { name: 'Threshold', group: 'Colour & tone', params: { cutoff: 0.5 }, color: 'if gray > cutoff then 1 else 0' },
  { name: 'Posterize', group: 'Colour & tone', params: { levels: { default: 4, min: 2, max: 16, step: 1 } }, color: 'min(floor(rgb * levels) / (levels - 1), 1)' },
  { name: 'Brightness & contrast', group: 'Colour & tone',
    params: { brightness: { default: 0, min: -0.5, max: 0.5 }, contrast: { default: 1, min: 0, max: 3 } },
    color: '(rgb - 0.5) contrast + 0.5 + brightness' },
  { name: 'Tint', group: 'Colour & tone', params: { tint: [1, 0.85, 0.7] }, color: 'rgb * tint' },
  { name: 'Sepia', group: 'Colour & tone', color: '(0.393r + 0.769g + 0.189b, 0.349r + 0.686g + 0.168b, 0.272r + 0.534g + 0.131b)' },
  { name: 'Colour circle', group: 'Colour & tone', description: 'Black and white, except a soft circle that keeps its colour',
    params: { across: { default: 0.5, min: 0, max: 1, label: 'where, across' }, down: { default: 0.5, min: 0, max: 1, label: 'where, down' },
      radius: { default: 0.3, min: 0, max: 1 }, softness: { default: 0.08, min: 0, max: 0.5 } },
    notes: ['The colour stays inside a circle and fades to grey over the softness. Sizes are parts of the picture\'s shorter side, so it stays round.',
      { param: 'across' }, { param: 'down' }, { param: 'radius' }, { param: 'softness' }],
    color: 'mix((gray, gray, gray), rgb, 1 - smoothstep(radius, radius + softness, distance((px, py), (across w, down h)) / min(w, h)))' },
  { name: 'Vignette', group: 'Colour & tone', params: { strength: { default: 1.6, min: 0, max: 4 } }, color: 'rgb * (1 - strength ((x - 0.5)^2 + (y - 0.5)^2))' },
  { name: 'Sobel edges', group: 'Blur & edges', description: 'How fast the brightness changes', params: { gain: { default: 2, min: 0.2, max: 10 } }, color: 'gain sobel()' },
  { name: 'Edge map', group: 'Blur & edges', description: 'White where an edge is stronger than the cutoff', params: { cutoff: { default: 0.3, min: 0, max: 2 } }, color: 'if sobel() > cutoff then 1 else 0' },
  { name: 'Outline', group: 'Blur & edges', description: 'Ink lines over the colour', params: { gain: { default: 3, min: 0, max: 10 } }, color: 'rgb (1 - gain sobel())' },
  { name: 'Box blur', group: 'Blur & edges', params: { radius: { default: 2, min: 0, max: 8, step: 1 } }, color: 'blur(radius)' },
  { name: 'Gaussian blur', group: 'Blur & edges', description: 'Computed in two passes, across then down, so it can be wide', params: { sigma: { default: 3, min: 0, max: 8 } }, color: 'gaussian(sigma)' },
  { name: 'Canny edges', group: 'Blur & edges', description: 'Thin, clean edge lines: smooth, gradient, thinning, two thresholds, hysteresis — a chain',
    steps: [
      { params: { sigma: { default: 1.4, min: 0.5, max: 4 } }, color: 'gaussian(sigma)' },
      // gradient strength (r) and its direction as one of four buckets (g: 0, ¼, ½, ¾ for 0°, 45°, 90°, 135°)
      { color: '(min(sobel() / 4, 1), floor(fract((atan2(sobely(), sobelx()) + π/8) / π) 4) / 4, 0)' },
      // non-maximum suppression: keep a pixel only if it is at least as strong as its two neighbours along the gradient
      { color: 'if green(px, py) < 0.125 then (if r >= red(px - 1, py) & r >= red(px + 1, py) then r else 0)'
        + ' else if green(px, py) < 0.375 then (if r >= red(px + 1, py + 1) & r >= red(px - 1, py - 1) then r else 0)'
        + ' else if green(px, py) < 0.625 then (if r >= red(px, py - 1) & r >= red(px, py + 1) then r else 0)'
        + ' else (if r >= red(px - 1, py + 1) & r >= red(px + 1, py - 1) then r else 0)' },
      { params: { low: { default: 0.08, min: 0, max: 0.5 }, high: { default: 0.2, min: 0, max: 1 } }, color: 'if r > high then 1 else if r > low then 0.5 else 0' },
      // hysteresis: a weak edge next to a strong one becomes strong (three rounds), the rest goes
      'if r > 0.9 then 1 else if r > 0.4 then (if red(dilate(1)) > 0.9 then 1 else 0.5) else 0',
      'if r > 0.9 then 1 else if r > 0.4 then (if red(dilate(1)) > 0.9 then 1 else 0.5) else 0',
      'if r > 0.9 then 1 else if r > 0.4 then (if red(dilate(1)) > 0.9 then 1 else 0.5) else 0',
      'if r > 0.9 then 1 else 0',
    ] },
  { name: 'Sharpen', group: 'Blur & edges', params: { amount: { default: 0.6, min: 0, max: 3 } }, color: 'sharpen(amount)' },
  { name: 'Unsharp mask', group: 'Blur & edges', description: 'The picture plus what a blur removes', params: { amount: { default: 1.5, min: 0, max: 5 }, sigma: { default: 2, min: 0.5, max: 4 } }, color: 'rgb + amount (rgb - gaussian(sigma))' },
  { name: 'Bloom', group: 'Blur & edges', description: 'Bright parts glow', params: { amount: { default: 0.8, min: 0, max: 3 }, sigma: { default: 3, min: 0.5, max: 4 }, cutoff: { default: 0.6, min: 0, max: 1 } },
    color: 'rgb + amount max(gaussian(sigma) - cutoff, 0)' },
  { name: 'Emboss', group: 'Blur & edges', color: 'emboss()' },
  { name: 'Dilate', group: 'Blur & edges', description: 'Light areas grow', params: { radius: { default: 2, min: 0, max: 8, step: 1 } }, color: 'dilate(radius)' },
  { name: 'Erode', group: 'Blur & edges', description: 'Dark areas grow', params: { radius: { default: 2, min: 0, max: 8, step: 1 } }, color: 'erode(radius)' },
  { name: '3×3 kernel', group: 'Blur & edges', description: 'Your own convolution; the default is a sharpen',
    params: { k1: { default: 0, min: -8, max: 8 }, k2: { default: -1, min: -8, max: 8 }, k3: { default: 0, min: -8, max: 8 }, k4: { default: -1, min: -8, max: 8 }, k5: { default: 5, min: -8, max: 8 }, k6: { default: -1, min: -8, max: 8 }, k7: { default: 0, min: -8, max: 8 }, k8: { default: -1, min: -8, max: 8 }, k9: { default: 0, min: -8, max: 8 } },
    color: 'convolve(k1, k2, k3, k4, k5, k6, k7, k8, k9)' },
  { name: 'Pixelate', group: 'Shape & motion', params: { size: { default: 8, min: 1, max: 32, step: 1 } }, color: 'pixel(floor(px / size) size, floor(py / size) size)' },
  { name: 'Mirror', group: 'Shape & motion', color: 'pixel(w - px, py)' },
  { name: 'Scanlines', group: 'Shape & motion', params: { period: { default: 4, min: 2, max: 16, step: 1 } }, color: 'if py mod period < period / 2 then rgb else rgb * 0.6' },
  { name: 'Pulse', group: 'Shape & motion', description: 'Brightness breathes with t', params: { speed: { default: 6, min: 1, max: 30 }, depth: { default: 0.25, min: 0, max: 1 } },
    color: 'rgb (1 - depth + depth sin(t / speed))' },
  { name: 'Chroma key', group: 'Colour & tone', description: 'Replaces one colour with another',
    params: { key: [0.22, 0.71, 0.29], tolerance: { default: 0.35, min: 0, max: 1 }, background: [0.1, 0.1, 0.4] },
    color: 'if distance(rgb, key) < tolerance then background else rgb' },
  { name: 'Through a mask', group: 'Other pictures', description: 'Put this last: the steps above show only where the mask is light',
    images: { mask: { description: 'light where the effect shows' } }, color: 'mix(source, rgb, luma(mask))' },
  { name: 'Mix', group: 'Other pictures', description: 'Fade towards another picture', images: ['overlay'], params: { amount: 0.5 }, color: 'mix(rgb, overlay, amount)' },
  { name: 'Masked mix', group: 'Other pictures', images: { overlay: {}, mask: { description: 'light where the overlay shows' } }, color: 'mix(rgb, overlay, luma(mask))' },
  { name: 'Multiply', group: 'Other pictures', images: ['overlay'], color: 'rgb * overlay' },
  { name: 'Screen', group: 'Other pictures', images: ['overlay'], color: '1 - (1 - rgb)(1 - overlay)' },
  { name: 'Overlay blend', group: 'Other pictures', images: ['overlay'], color: 'if gray < 0.5 then 2 rgb overlay else 1 - 2 (1 - rgb)(1 - overlay)' },
  { name: 'Difference', group: 'Other pictures', images: ['overlay'], color: 'abs(rgb - overlay)' },
  { name: 'Alpha over', group: 'Other pictures', description: 'A picture with transparency laid on top', images: ['overlay'], color: 'mix(rgb, overlay, alpha(overlay))' },
  { name: 'Chroma key onto a picture', group: 'Other pictures', images: { background: {} },
    params: { key: [0.22, 0.71, 0.29], tolerance: { default: 0.35, min: 0, max: 1 } }, color: 'if distance(rgb, key) < tolerance then background else rgb' },
  { name: 'Only inside the selection', group: 'Other pictures', description: 'Put this last: the steps above show only inside what you selected on the picture (everywhere, without a selection)',
    color: 'mix(source, rgb, selected)' },
  { name: 'Only outside the selection', group: 'Other pictures', description: 'Put this last: the steps above show only outside what you selected', color: 'mix(rgb, source, selected)' },
  { name: 'Caption', group: 'Text & shapes', description: 'Words along the bottom, with a soft shadow; change them under the step',
    graphics: { title: { text: 'Your caption here', y: 0.88 } }, color: 'mix(rgb, title, alpha(title))' },
  { name: 'Poster title', group: 'Text & shapes', description: 'Big outlined letters across the top',
    graphics: { title: { text: 'BIG TITLE', font: 'Impact, Haettenschweiler, sans-serif', weight: 'normal', size: 0.16, y: 0.14, outline: { color: '#000000', width: 0.08 }, shadow: null } },
    color: 'mix(rgb, title, alpha(title))' },
  { name: 'Gradient text', group: 'Text & shapes', description: 'The letters coloured by maths: a sunset from left to right',
    graphics: { title: { text: 'Golden hour', font: 'Georgia, serif', size: 0.13, y: 0.5, shadow: { color: 'rgba(0,0,0,0.5)', blur: 0.2, dx: 0, dy: 0.05 } } },
    color: 'mix(rgb, mix((1, 0.35, 0.3), (1, 0.85, 0.25), x), alpha(title))' },
  { name: 'Neon sign', group: 'Text & shapes', description: 'White letters with a coloured glow',
    graphics: { title: { text: 'OPEN', font: 'Trebuchet MS, sans-serif', size: 0.18, y: 0.5, shadow: { color: '#00e5ff', blur: 0.45, dx: 0, dy: 0 } } },
    color: 'mix(rgb * 0.6, title, alpha(title))' },
  { name: 'Layered shadow', group: 'Text & shapes', description: 'Two shadow layers, each with its own filter: a soft glow that darkens and breathes with t, and a hard offset coloured by a gradient',
    graphics: { title: { text: 'LAYERS', font: 'Impact, Haettenschweiler, sans-serif', weight: 'normal', size: 0.17, y: 0.5, shadow: null,
      shadows: [{ color: '#000000', blur: 0.7, dx: 0, dy: 0.08 }, { color: '#000000', blur: 0, dx: 0.07, dy: 0.07 }] } },
    color: 'mix(mix(mix(rgb, rgb * 0.25, alpha(title_shadow1) (0.7 + 0.3 sin(t / 10))), mix((1, 0.2, 0.6), (0.2, 0.6, 1), x), alpha(title_shadow2)), title, alpha(title))' },
  { name: 'Ink brush', group: 'Brushes', description: 'Paint in a colour; draw on the picture with "draw" under the step',
    graphics: { brush: { type: 'strokes', brush: 'round', size: 0.025 } }, params: { ink: [0.95, 0.2, 0.25] }, color: 'mix(rgb, ink, alpha(brush))' },
  { name: 'Blur brush', group: 'Brushes', description: 'Paint a blur in — stronger every time a stroke goes over the same place',
    graphics: { brush: { type: 'strokes', brush: 'soft', size: 0.08 } }, color: 'mix(rgb, gaussian(2 + 3 min(4 green(brush), 3)), alpha(brush))' },
  { name: 'Darken brush', group: 'Brushes', description: 'Each pass darkens a little more, like layers of a wash',
    graphics: { brush: { type: 'strokes', brush: 'soft', size: 0.07, flow: 0.7 } }, color: 'rgb (1 - 0.22 min(4 green(brush), 4))' },
  { name: 'Colour reveal brush', group: 'Brushes', description: 'The picture starts grey; the brush paints its colour back',
    graphics: { brush: { type: 'strokes', brush: 'soft', size: 0.1 } }, color: 'mix((gray, gray, gray), rgb, alpha(brush))' },
  { name: 'Fuse brush', group: 'Brushes', description: 'Paint glows as it goes down, then cools to charcoal (red(brush) is its age)',
    graphics: { brush: { type: 'strokes', brush: 'round', size: 0.02, age: 40 } },
    color: 'mix(rgb, mix((1, 0.9, 0.5), (0.1, 0.07, 0.06), red(brush)), alpha(brush)) + (1, 0.5, 0.1) alpha(brush) max(0, 1 - 3 red(brush)) 0.6' },
  { name: 'Rainbow brush', group: 'Brushes', description: 'The colour runs round the wheel along the drawing (blue(brush) is how far through it)',
    graphics: { brush: { type: 'strokes', brush: 'marker', size: 0.035 } }, color: 'mix(rgb, fromhsv(blue(brush), 0.85, 1), alpha(brush))' },
  { name: 'Chalk outline', group: 'Brushes', description: 'Chalk round an object: select it, then "outline the selection" under the step',
    graphics: { brush: { type: 'strokes', brush: 'chalk', size: 0.018, timing: 'even', speed: 2 } }, color: 'mix(rgb, (0.97, 0.97, 0.92), alpha(brush))' },
  { name: 'Frosted panel', group: 'Text & shapes', description: 'A rounded panel that blurs and darkens what is behind it — a shape with its own filter',
    graphics: { panel: { type: 'rect', y: 0.86, w: 0.9, h: 0.2, radius: 0.25 } }, color: 'mix(rgb, gaussian(5) * 0.7, alpha(panel))' },
  { name: 'Spotlight oval', group: 'Text & shapes', description: 'Darkens everything but a soft oval',
    graphics: { spot: { type: 'ellipse', x: 0.5, y: 0.45, w: 0.45, h: 0.55, shadow: { color: '#ffffff', blur: 0.12, dx: 0, dy: 0 } } }, color: 'mix(rgb * 0.3, rgb, alpha(spot))' },
  { name: 'Scrolling banner', group: 'Text & shapes', description: 'Text that slides across and wraps round (animated with t)',
    graphics: { title: { text: 'Breaking news · scrolling text · ', size: 0.07, y: 0.92 } }, params: { speed: { default: 3, min: -10, max: 10 } },
    color: 'mix(rgb, shift(title, -speed t, 0), alpha(shift(title, -speed t, 0)))' },
  { name: 'Pulsing title', group: 'Text & shapes', description: 'Text that grows and shrinks a little (animated with t)',
    graphics: { title: { text: 'Hello!', size: 0.14, y: 0.5 } }, params: { amount: { default: 0.06, min: 0, max: 0.3 } },
    color: 'mix(rgb, zoom(title, 1 + amount sin(t / 8)), alpha(zoom(title, 1 + amount sin(t / 8))))' },
  { name: 'Fade-in title', group: 'Text & shapes', description: 'Text that fades in over the first frames (animated with t)',
    graphics: { title: { text: 'Once upon a time', font: 'Georgia, serif', style: 'italic', weight: 'normal', size: 0.09, y: 0.5 } }, params: { frames: { default: 40, min: 1, max: 200 } },
    color: 'mix(rgb, title, alpha(title) clamp(t / frames, 0, 1))' },
  { name: 'Zoom', group: 'Shape & motion', params: { scale: { default: 1.5, min: 0.25, max: 4 }, cx: 0.5, cy: 0.5 }, color: 'zoom(scale, cx, cy)' },
  { name: 'Ken Burns', group: 'Shape & motion', description: 'A slow zoom that drifts across — a still picture that moves',
    params: { speed: { default: 0.002, min: 0, max: 0.01 }, drift: { default: 0.0003, min: -1e-3, max: 0.001 } }, color: 'zoom(1 + speed t, 0.5 + drift t, 0.45)' },
  { name: 'Scroll', group: 'Shape & motion', description: 'Slides and wraps around', params: { dx: { default: 1, min: -5, max: 5 }, dy: { default: 0, min: -5, max: 5 } }, color: 'shift(dx t, dy t)' },
  { name: 'Spin', group: 'Shape & motion', params: { speed: { default: 0.01, min: -0.05, max: 0.05 } }, color: 'rotate(speed t)' },
  { name: 'Tile', group: 'Shape & motion', params: { n: { default: 2, min: 1, max: 8, step: 1 } }, color: 'tile(n)' },
  { name: 'Crop', group: 'Shape & motion', description: 'A part of the picture, filling the frame', params: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 }, color: 'crop(left, top, right, bottom)' },
  { name: 'Flip', group: 'Shape & motion', color: 'flipx()' },
  { name: 'Picture in picture', group: 'Other pictures', description: 'Another picture, fitted small in a corner',
    images: { inset: { description: 'any size: it is fitted whole', place: 'fit', zoom: 0.35, x: 0.8, y: 0.78 } }, color: 'mix(rgb, inset, alpha(inset))' },
  { name: 'Moving overlay', group: 'Other pictures', description: 'Another picture scrolling across at half strength', images: ['overlay'], params: { speed: { default: 2, min: -10, max: 10 } },
    color: 'mix(rgb, shift(overlay, speed t, 0), 0.5)' },
  { name: 'Hue shift', group: 'Colour & tone', description: 'Turns every colour around the hue wheel (in HSV)', space: 'hsv',
    params: { amount: { default: 0.1, min: -0.5, max: 0.5 } }, color: '(fract(r + amount), g, b)' },
  { name: 'Saturation', group: 'Colour & tone', description: 'More or less colour (in HSV)', space: 'hsv',
    params: { amount: { default: 1.5, min: 0, max: 3 } }, color: '(r, clamp(g amount, 0, 1), b)' },
  { name: 'Lightness', group: 'Colour & tone', description: 'Lighter or darker without changing the colours (in Lab)', space: 'lab',
    params: { amount: { default: 1.15, min: 0.5, max: 2 } }, color: '(clamp(r amount, 0, 1), g, b)' },
  { name: 'Vivid', group: 'Colour & tone', description: 'Colourfulness, perceptually even (in OKLab)', space: 'oklab',
    params: { amount: { default: 1.6, min: 0, max: 3 } }, color: '(r, 0.5 + (g - 0.5) amount, 0.5 + (b - 0.5) amount)' },
  { name: 'Linear-light blur', group: 'Blur & edges', description: 'A Gaussian in linear light: bright spots stay bright, as a lens does', space: 'linear',
    params: { sigma: { default: 3, min: 0, max: 8 } }, color: 'gaussian(sigma)' },
  { name: 'Film grain', group: 'Colour & tone', description: 'Noise that changes every frame', params: { amount: { default: 0.15, min: 0, max: 0.6 } }, color: 'rgb + amount (random() - 0.5)' },
  { name: 'Swirl', group: 'Shape & motion', params: { strength: { default: 0.02, min: 0, max: 0.1 } },
    color: 'pixel(w/2 + (px - w/2) cos(strength t gray) - (py - h/2) sin(strength t gray), h/2 + (px - w/2) sin(strength t gray) + (py - h/2) cos(strength t gray))' },
];
const byName$1 = (name) => FILTERS.find((f) => f.name === name);
FILTERS.push(
  { name: 'Old film', group: 'Chains', description: 'Sepia, a vignette and faint scanlines — a chain of three',
    steps: [byName$1('Sepia'), { filter: byName$1('Vignette'), with: { strength: 1.2 } }, { filter: byName$1('Scanlines'), opacity: 0.5 }] },
  { name: 'Comic', group: 'Chains', description: 'Bold flat colours with ink lines: a small blur first, so a photo\'s fine texture isn\'t inked — a chain of four',
    steps: [{ filter: byName$1('Gaussian blur'), with: { sigma: 1.6 } }, { filter: byName$1('Vivid'), with: { amount: 1.5 } },
      { filter: byName$1('Posterize'), with: { levels: 4 } }, { filter: byName$1('Outline'), with: { gain: 1.2 } }] },
  { name: 'Cartoon', group: 'Chains', description: 'Blur, then flatten the colours, then outline — a chain of three',
    steps: [{ filter: byName$1('Gaussian blur'), with: { sigma: 1.5 } }, { filter: byName$1('Posterize'), with: { levels: 6 } }, { filter: byName$1('Outline'), with: { gain: 2 } }] },
  { name: 'Dreamy', group: 'Chains', description: 'A soft glow mixed over the picture',
    steps: [{ filter: byName$1('Bloom'), with: { amount: 1.2 } }, { filter: byName$1('Gaussian blur'), with: { sigma: 2 }, opacity: 0.4 }] },
  { name: 'Tilt shift', group: 'Chains', description: 'Blurred where the mask is light — a chain',
    steps: [{ filter: byName$1('Gaussian blur'), with: { sigma: 4 } }, byName$1('Through a mask')] },
  { name: 'Title card', group: 'Chains', description: 'A frosted panel with a caption on it — a chain of two',
    steps: [byName$1('Frosted panel'), { filter: byName$1('Caption'), with: { title: { text: 'A title on a panel', y: 0.86 } } }] },
  { name: 'Colour spotlight', group: 'Chains', description: 'Grey except where the mask is dark — a chain',
    steps: [byName$1('Grayscale'), byName$1('Through a mask')] },
);

const LIBRARY = FILTERS;

/**
 * What the small apps (demo/avatar/, demo/splash/, demo/move/) share: a picture in, a filter run on
 * it (the GPU, or the CPU without WebGL), a file out. Each app is one page with a few choices; the
 * editor (demo/index.html) is where everything else lives.
 *
 *   import { openFile, samplePhotos, loadPicture, createView, download, saveGif, ROOT } from '../kit.js';
 *   const view = createView(box, 512, 512);          // a result canvas of that size, inside `box`
 *   view.set(chain);                                  // a filter: an expression, a library filter, { steps }
 *   view.setImage('source', canvas);                  // the picture (and 'selection', other pictures by name)
 *   view.draw(t);                                     // draws; view.canvas is what is on screen
 *
 * Paths are relative to the folder above the app, so the same code runs in demo/ (development: the
 * runtimes from node_modules) and in the built site (site/<app>/, the runtimes in site/ort/).
 */
/** The editor's folder: photos/, models/ and the editor itself are there. */
const ROOT = new URL('../', location.href).href;
const DEV = location.pathname.includes('/demo/');
const ORT_URL$1 = DEV ? '/node_modules/onnxruntime-web/dist/' : new URL('ort/', ROOT).href;
const MEDIAPIPE_URL$1 = DEV ? '/node_modules/@mediapipe/tasks-vision/wasm/' : new URL('mediapipe/', ROOT).href;
const byName = (name) => LIBRARY.find((f) => f.name === name);

/** A picture as a canvas, at most `max` pixels on its long side. */
function toCanvas(image, max = 1600) {
    const w = image.naturalWidth || image.videoWidth || image.width, h = image.naturalHeight || image.videoHeight || image.height;
    const s = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d').drawImage(image, 0, 0, c.width, c.height);
    return c;
}

/** A picture from an address, as a canvas. */
async function loadPicture(url, max) {
    const img = new Image();
    img.src = url;
    await img.decode();
    return toCanvas(img, max);
}

/** A file the user chose (an image), as a canvas; it never leaves the computer. */
async function openFile(file, max) {
    if (!file || !file.type.startsWith('image/')) throw new Error('That isn\'t a picture — choose a JPEG, PNG, WebP or GIF.');
    const url = URL.createObjectURL(file);
    try { return await loadPicture(url, max); } finally { URL.revokeObjectURL(url); }
}

/** The editor's sample photos (not the videos): [{ title, url, credit, personUrl }] (personUrl: the person's outline, worked out ahead). */
async function samplePhotos() {
    try {
        const list = await (await fetch(new URL('photos/index.json', ROOT))).json();
        return list.filter((p) => !/\.(mp4|webm|mov)$/i.test(p.file)).map((p) => ({ ...p, url: new URL(`photos/${p.file}`, ROOT).href, personUrl: p.person ? new URL(`photos/${p.person}`, ROOT).href : '' }));
    } catch { return []; }
}

/** A photo credit with [text](https://…) links, rendered safely into `el`. */
function showCredit(el, credit = '') {
    el.textContent = '';
    for (const part of String(credit).split(/(\[[^\]]+\]\(https?:\/\/[^)\s]+\))/)) {
        const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
        if (link) el.append(Object.assign(document.createElement('a'), { textContent: link[1], href: link[2], target: '_blank', rel: 'noopener' }));
        else if (part) el.append(part);
    }
}

/**
 * The result: a filter run on pictures, drawn into a canvas of a fixed size inside `box`. The GPU
 * when there is WebGL; otherwise the CPU (the same pixels, slower).
 */
function createView(box, width, height, { label = 'the result' } = {}) {
    const glCanvas = Object.assign(document.createElement('canvas'), { width, height });
    const cpuCanvas = Object.assign(document.createElement('canvas'), { width, height, hidden: true });
    for (const c of [glCanvas, cpuCanvas]) { c.setAttribute('role', 'img'); c.setAttribute('aria-label', label); }
    box.append(glCanvas, cpuCanvas);
    const gl = glCanvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false });
    const images = new Map();
    let runner = null, engine = gl ? 'gpu' : 'cpu', compiled = null;

    const view = {
        get canvas() { return engine === 'cpu' ? cpuCanvas : glCanvas; },
        get engine() { return engine; },
        get compiled() { return compiled; },
        /** The filter to run, and knob values by step: [{ name: value }, …] (or one object for a single filter). */
        set(def, values = null) {
            if (runner) runner.dispose();
            runner = null;
            compiled = compileFilter(def, { version: 100 });
            const made = createRunner(compiled, { gl, prefer: gl ? 'auto' : 'cpu' });
            runner = made.runner;
            engine = made.engine;
            glCanvas.hidden = engine === 'cpu';
            cpuCanvas.hidden = engine !== 'cpu';
            for (const [name, image] of images) runner.setImage(name, image);
            if (values) view.knobs(values);
            return view;
        },
        /** Change knobs without recompiling: { name: value } for every pass that has that knob. */
        knobs(values) {
            if (!compiled) return;
            for (const pass of compiled.passes) for (const [k, v] of Object.entries(values)) if (k in pass.params) pass.values[k] = v;
        },
        setImage(name, image) {
            images.set(name, image);
            if (runner) runner.setImage(name, image);
            return view;
        },
        draw(t = 0) {
            if (!runner) return;
            if (engine === 'cpu') runner.draw({ t, canvas: cpuCanvas });
            else runner.draw({ t });
        },
        /** A 2D copy of what is drawn (to draw on, or to save). */
        snapshot() {
            const c = Object.assign(document.createElement('canvas'), { width, height });
            c.getContext('2d').drawImage(view.canvas, 0, 0);
            return c;
        },
        resize(w, h) {
            width = w; height = h;
            for (const c of [glCanvas, cpuCanvas]) { c.width = w; c.height = h; }
        },
    };
    return view;
}

/** Save a blob (or a canvas, as PNG) under `name`. */
async function download(what, name) {
    const blob = what instanceof Blob ? what : await new Promise((r) => what.toBlob(r, 'image/png'));
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return blob;
}

/** Drag on `el` to move something: onMove(dx, dy) in CSS pixels; a wheel or pinch calls onZoom(factor). */
function dragAndZoom(el, { onMove, onZoom = () => {}, onStart = () => {} }) {
    const pointers = new Map();
    let pinch = 0;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
        pointers.set(e.pointerId, [e.clientX, e.clientY]);
        el.setPointerCapture(e.pointerId);
        onStart();
    });
    el.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        const [x0, y0] = pointers.get(e.pointerId);
        pointers.set(e.pointerId, [e.clientX, e.clientY]);
        if (pointers.size === 1) onMove(e.clientX - x0, e.clientY - y0);
        else if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
            if (pinch) onZoom(d / pinch);
            pinch = d;
        }
    });
    const end = (e) => { pointers.delete(e.pointerId); pinch = 0; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => { e.preventDefault(); onZoom(Math.exp(-e.deltaY / 500)); }, { passive: false });
}

/**
 * RF-DETR segmentation (Roboflow's RF-DETR-Seg, Apache-2.0: Small exported
 * to ONNX at 576 × 576, Nano at 312 × 312, both int8 — tools/export-model.py):
 * every object of the 80 COCO kinds in a picture, with its box, label,
 * score and outline, in one pass.
 *
 *   const model = await loadDetector(ort, url, { size }); // ort: onnxruntime-web (browser) or onnxruntime-node; size: the export's
 *   const found = await model.find(rgba, w, h);          // [{ label, score, box: [x0, y0, x1, y1], mask: Uint8Array(w × h) }]
 *
 * In: `input` [1, 3, size, size], the picture stretched to the square (no
 * letterbox), ImageNet-normalized. Out: `dets` [1, 100, 4] boxes as centre
 * x, y, width, height in 0…1 of the picture; `labels` [1, 100, 91] class
 * logits (COCO's own ids, 1…90 with gaps); `masks` [1, 100, size/4, size/4]
 * mask logits over the whole picture (> 0 is inside). A DETR needs no NMS: each of
 * the 100 queries is one object or nothing.
 */

/** COCO's category ids (as the model numbers them) → names. */
const COCO = {
    1: 'person', 2: 'bicycle', 3: 'car', 4: 'motorcycle', 5: 'airplane', 6: 'bus', 7: 'train', 8: 'truck', 9: 'boat',
    10: 'traffic light', 11: 'fire hydrant', 13: 'stop sign', 14: 'parking meter', 15: 'bench', 16: 'bird', 17: 'cat',
    18: 'dog', 19: 'horse', 20: 'sheep', 21: 'cow', 22: 'elephant', 23: 'bear', 24: 'zebra', 25: 'giraffe', 27: 'backpack',
    28: 'umbrella', 31: 'handbag', 32: 'tie', 33: 'suitcase', 34: 'frisbee', 35: 'skis', 36: 'snowboard', 37: 'sports ball',
    38: 'kite', 39: 'baseball bat', 40: 'baseball glove', 41: 'skateboard', 42: 'surfboard', 43: 'tennis racket',
    44: 'bottle', 46: 'wine glass', 47: 'cup', 48: 'fork', 49: 'knife', 50: 'spoon', 51: 'bowl', 52: 'banana', 53: 'apple',
    54: 'sandwich', 55: 'orange', 56: 'broccoli', 57: 'carrot', 58: 'hot dog', 59: 'pizza', 60: 'donut', 61: 'cake',
    62: 'chair', 63: 'couch', 64: 'potted plant', 65: 'bed', 67: 'dining table', 70: 'toilet', 72: 'tv', 73: 'laptop',
    74: 'mouse', 75: 'remote', 76: 'keyboard', 77: 'cell phone', 78: 'microwave', 79: 'oven', 80: 'toaster', 81: 'sink',
    82: 'refrigerator', 84: 'book', 85: 'clock', 86: 'vase', 87: 'scissors', 88: 'teddy bear', 89: 'hair drier', 90: 'toothbrush',
};

const SIZE$1 = 576;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

/** The picture stretched to size × size (bilinear), normalized, as planes R G B. */
function prepare(rgba, w, h, size = SIZE$1) {
    const plane = size * size;
    const data = new Float32Array(3 * plane);
    for (let y = 0; y < size; y++) {
        const fy = Math.max(0, Math.min(h - 1, ((y + 0.5) * h) / size - 0.5));
        const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ay = fy - y0;
        for (let x = 0; x < size; x++) {
            const fx = Math.max(0, Math.min(w - 1, ((x + 0.5) * w) / size - 0.5));
            const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), ax = fx - x0;
            const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
            for (let k = 0; k < 3; k++) {
                const v = ((rgba[a + k] * (1 - ax) + rgba[b + k] * ax) * (1 - ay) + (rgba[c + k] * (1 - ax) + rgba[d + k] * ax) * ay) / 255;
                data[k * plane + y * size + x] = (v - MEAN[k]) / STD[k];
            }
        }
    }
    return data;
}

/**
 * Objects from the model's three outputs, in the picture's own pixels.
 * @param {Float32Array} dets 100 × 4   @param {Float32Array} logits 100 × classes   @param {Float32Array} masks 100 × m × m
 */
function decode(dets, logits, masks, w, h, { threshold = 0.4, classes = logits.length / 100, maskSize = Math.sqrt(masks.length / 100) } = {}) {
    const found = [];
    for (let q = 0; q < 100; q++) {
        let best = -Infinity, id = 0;
        for (let c = 0; c < classes; c++) if (logits[q * classes + c] > best) { best = logits[q * classes + c]; id = c; }
        const score = 1 / (1 + Math.exp(-best));
        if (score < threshold || !COCO[id]) continue;
        const [cx, cy, bw, bh] = dets.subarray(q * 4, q * 4 + 4);
        const clamp = (v, max) => Math.min(max, Math.max(0, v));
        const box = [clamp((cx - bw / 2) * w, w), clamp((cy - bh / 2) * h, h), clamp((cx + bw / 2) * w, w), clamp((cy + bh / 2) * h, h)];
        if (box[2] - box[0] < 2 || box[3] - box[1] < 2) continue;
        const mask = maskFor(masks.subarray(q * maskSize * maskSize, (q + 1) * maskSize * maskSize), maskSize, w, h);
        if (!mask.some(Boolean)) continue;
        found.push({ label: COCO[id], score, box, mask });
    }
    return found.sort((a, b) => b.score - a.score);
}

/** One object's outline: its m × m logits, bilinear at the picture's size (so the outline isn't blocky), > 0 inside. */
function maskFor(logits, m, w, h) {
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const fy = Math.max(0, Math.min(m - 1, ((y + 0.5) * m) / h - 0.5));
        const y0 = Math.min(m - 2, Math.floor(fy)), ay = fy - y0;
        for (let x = 0; x < w; x++) {
            const fx = Math.max(0, Math.min(m - 1, ((x + 0.5) * m) / w - 0.5));
            const x0 = Math.min(m - 2, Math.floor(fx)), ax = fx - x0;
            const i = y0 * m + x0;
            const v = (logits[i] * (1 - ax) + logits[i + 1] * ax) * (1 - ay) + (logits[i + m] * (1 - ax) + logits[i + m + 1] * ax) * ay;
            if (v > 0) mask[y * w + x] = 1;
        }
    }
    return mask;
}

/** @param ort onnxruntime-web or onnxruntime-node   @param source a URL, a path, or the model's bytes   size: the side it was exported at */
async function loadDetector(ort, source, { size = SIZE$1, ...options } = {}) {
    const session = await ort.InferenceSession.create(source, options);
    return {
        session,
        async find(rgba, w, h, opts = {}) {
            const out = await session.run({ input: new ort.Tensor('float32', prepare(rgba, w, h, size), [1, 3, size, size]) });
            return decode(out.dets.data, out.labels.data, out.masks.data, w, h, opts);
        },
    };
}

/**
 * MobileSAM (Segment Anything with a small image encoder; Apache-2.0, ONNX
 * from Acly/MobileSAM, int8 — tools/export-model.py): outlines whatever is
 * under a click, label or not.
 *
 *   const sam = await loadSam(ort, encoderUrl, decoderUrl);   // ort: onnxruntime-web or onnxruntime-node
 *   await sam.look(rgba, w, h);                                // the heavy part, once per picture
 *   const mask = await sam.mask({ points: [[x, y]], labels: [1], box });   // Uint8Array(w × h), fast
 *
 * The encoder takes the picture scaled so its longer side is 1024, as
 * [h, w, 3] RGB 0…255 (it normalizes and pads itself) and gives a 256 × 64 ×
 * 64 embedding. The decoder is Segment Anything's: points in that scaled
 * picture (label 1 in, 0 out; a box is two points labelled 2 and 3; without
 * a box a padding point labelled -1), and it returns four masks at the
 * picture's size with a predicted quality for each: one click is ambiguous
 * (a shirt or the person?), so masks 1–3 are the guesses and the surest is
 * taken; with more to go on, mask 0.
 */

const LONG = 1024;

/** The picture scaled (bilinear) so its longer side is 1024: [h, w, 3] floats 0…255. */
function scaled(rgba, w, h) {
    const s = LONG / Math.max(w, h);
    const nw = Math.round(w * s), nh = Math.round(h * s);
    const data = new Float32Array(nw * nh * 3);
    for (let y = 0; y < nh; y++) {
        const fy = Math.max(0, Math.min(h - 1, (y + 0.5) / s - 0.5));
        const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ay = fy - y0;
        for (let x = 0; x < nw; x++) {
            const fx = Math.max(0, Math.min(w - 1, (x + 0.5) / s - 0.5));
            const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), ax = fx - x0;
            const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
            for (let k = 0; k < 3; k++) data[(y * nw + x) * 3 + k] = (rgba[a + k] * (1 - ax) + rgba[b + k] * ax) * (1 - ay) + (rgba[c + k] * (1 - ax) + rgba[d + k] * ax) * ay;
        }
    }
    return { data, nw, nh, s };
}

/** The decoder's prompt: points (and a box) in the scaled picture. */
function prompt({ points = [], labels = [], box = null }, s) {
    const coords = points.map(([x, y]) => [x * s, y * s]);
    const kinds = [...labels];
    if (box) { coords.push([box[0] * s, box[1] * s], [box[2] * s, box[3] * s]); kinds.push(2, 3); }
    else { coords.push([0, 0]); kinds.push(-1); }
    return { coords: Float32Array.from(coords.flat()), labels: Float32Array.from(kinds), n: kinds.length };
}

/** @param ort onnxruntime-web or onnxruntime-node   @param encoder, decoder URLs, paths or bytes */
async function loadSam(ort, encoder, decoder, options = {}) {
    const enc = await ort.InferenceSession.create(encoder, options);
    const dec = await ort.InferenceSession.create(decoder, options);
    let picture = null;                    // { embedding, w, h, s }
    return {
        async look(rgba, w, h) {
            const { data, nw, nh, s } = scaled(rgba, w, h);
            const out = await enc.run({ input_image: new ort.Tensor('float32', data, [nh, nw, 3]) });
            picture = { embedding: out.image_embeddings, w, h, s };
        },
        async mask(ask) {
            const { embedding, w, h, s } = picture;
            const p = prompt(ask, s);
            const out = await dec.run({
                image_embeddings: embedding,
                point_coords: new ort.Tensor('float32', p.coords, [1, p.n, 2]),
                point_labels: new ort.Tensor('float32', p.labels, [1, p.n]),
                mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
                has_mask_input: new ort.Tensor('float32', new Float32Array(1), [1]),
                orig_im_size: new ort.Tensor('float32', Float32Array.from([h, w]), [2]),
            });
            const quality = out.iou_predictions.data;
            const single = (ask.points ?? []).length === 1 && !ask.box;
            let k = 0;
            if (single) { k = 1; for (let j = 2; j < 4; j++) if (quality[j] > quality[k]) k = j; }
            const logits = out.masks.data.subarray(k * w * h, (k + 1) * w * h);
            const mask = new Uint8Array(w * h);
            for (let i = 0; i < mask.length; i++) if (logits[i] > 0) mask[i] = 1;
            return mask;
        },
    };
}

/**
 * Finding objects with a neural network, in the browser — served by this
 * site itself: no Hugging Face, no CDN. Several models, to compare (all
 * Apache-2.0, demo/models/NOTICE):
 *
 *   rfdetr-small   RF-DETR-Seg Small: every object of 80 common kinds (people, cars, dogs, cups…),
 *                  labelled and outlined, in one pass; click one to take it
 *   rfdetr-nano    the same, smaller input: faster, a little less sure, finer things missed
 *   mobilesam      MobileSAM (Segment Anything): no list — click anything and it is outlined
 *   magictouch     MediaPipe's MagicTouch: click anything (small)
 *   magictouch2    MagicTouch 2: looks at the picture once, then clicks are quick
 *
 * The ONNX models run in ONNX Runtime Web (its WebAssembly build: ort/ on
 * the site), MagicTouch in MediaPipe's runtime (mediapipe/). Nothing loads
 * until "find objects" is used; then the browser caches it.
 *
 *   const ai = setupAI({ source: () => canvas, onProgress });
 *   ai.setModel('mobilesam');
 *   const boxes = await ai.detect();                                   // [{ label, score, box }] — [] for the click-anything models
 *   await ai.embed(otherFrame);                                         // look at another picture (a frame of a video)
 *   const mask = await ai.mask({ points: [[x, y]], labels: [1], box }); // Uint8Array, 1 inside, at the picture's size
 *
 * mask(): points labelled 1 are in the object, 0 are not; a box says
 * roughly where it is (the tracker's "fix red frames" uses that).
 */

const AI_MODELS = {
    'rfdetr-small': { name: 'RF-DETR Small', kind: 'objects', about: 'finds 80 kinds of thing, labelled — 41 MB', files: ['models/rfdetr-seg-small.onnx'], size: 576 },
    'rfdetr-nano': { name: 'RF-DETR Nano', kind: 'objects', about: 'the same, faster, less detail — 37 MB', files: ['models/rfdetr-seg-nano.onnx'], size: 312 },
    mobilesam: { name: 'MobileSAM', kind: 'anything', about: 'click anything — 19 MB', files: ['models/mobilesam-encoder.onnx', 'models/mobilesam-decoder.onnx'] },
    magictouch: { name: 'MagicTouch', kind: 'anything', about: 'click anything, small — 6 MB', files: ['models/magic_touch.tflite'] },
    magictouch2: { name: 'MagicTouch 2', kind: 'anything', about: 'click anything — 31 MB', files: ['models/magic_touch_2.task'] },
};
/**
 * What the built site carries (tools/build.mjs copies only these models; the first is the default): MobileSAM, as every
 * file must stay under 25 MiB to be hosted on Cloudflare Pages (RF-DETR Small is 39 MB). The others stay in demo/models/
 * to compare in development.
 */
const SHIPPED_MODELS = ['mobilesam'];
const DEFAULT_MODEL = SHIPPED_MODELS[0];
/** Where the runtimes are, relative to the page (node_modules in development, beside the page on the site). */
const ORT_URL = 'ort/';
const MEDIAPIPE_URL = 'mediapipe/';

function setupAI({ source, onProgress = () => {}, model = DEFAULT_MODEL, ortUrl = ORT_URL, mediapipeUrl = MEDIAPIPE_URL, base = location.href }) {   // base: where models/ is (the small apps live a folder down)
    let key = AI_MODELS[model] ? model : DEFAULT_MODEL;
    const backends = {};                // key → Promise<backend>
    const ready = {};                   // key → backend, once loaded
    let looked = false;                 // the current backend has looked at the picture
    let lookMs = 0;

    async function fetchWithProgress(url, what) {
        url = new URL(url, base).href;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${what} is not on this site (${url}: ${response.status}).`);
        const total = Number(response.headers.get('content-length')) || 0;
        if (!total || !response.body) return new Uint8Array(await response.arrayBuffer());
        const reader = response.body.getReader();
        const bytes = new Uint8Array(total);
        let got = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes.set(value, got);
            got += value.length;
            onProgress(`${what}: ${Math.round((got / total) * 100)}%`);
        }
        return bytes;
    }

    let ortPromise = null;
    const onnx = () => (ortPromise ??= import('onnxruntime-web').then((ort) => {   // the import map: node_modules in development, ort/ on the site
        ort.env.wasm.wasmPaths = new URL(ortUrl, location.href).href;
        // threads need a cross-origin-isolated page; elsewhere one thread, which still works
        ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
        return ort;
    }));
    let visionPromise = null;
    const mediapipe = () => (visionPromise ??= import('@mediapipe/tasks-vision').then(async (mp) => ({
        mp, fileset: await mp.FilesetResolver.forVisionTasks(new URL(mediapipeUrl, location.href).href.replace(/\/$/, '')),
    })));

    const pixels = (canvas) => canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;

    /** Two outlines that mostly agree are the same object found twice: keep the surer. */
    function merge(list) {
        const kept = [];
        for (const o of list) {
            const area = o.mask.reduce((a, b) => a + b, 0);
            const same = kept.some((k) => {
                let both = 0;
                for (let i = 0; i < o.mask.length; i++) if (o.mask[i] && k.mask[i]) both++;
                return both / Math.max(1, Math.min(area, k.area)) > 0.8;
            });
            if (!same) kept.push({ ...o, area });
        }
        return kept;
    }

    /** Each backend: look(canvas) once per picture, objects() (labelled, if it finds any), mask(prompt). */
    const makers = {
        async objects(spec, what) {
            const ort = await onnx();
            const model = await loadDetector(ort, await fetchWithProgress(spec.files[0], what), { size: spec.size, executionProviders: ['wasm'] });
            let found = [], w = 0, h = 0;
            return {
                async look(c) { w = c.width; h = c.height; found = merge(await model.find(pixels(c), w, h, { threshold: 0.4 })); },
                objects: () => found.map(({ label, score, box }) => ({ label, score, box })),
                async mask({ points = [], labels = [], box = null }) {
                    const result = new Uint8Array(w * h);
                    const add = (o, on) => { for (let i = 0; i < o.mask.length; i++) if (o.mask[i]) result[i] = on ? 1 : 0; };
                    if (box) {
                        // the object whose box overlaps this one most
                        const iou = (b) => {
                            const ix = Math.max(0, Math.min(b[2], box[2]) - Math.max(b[0], box[0])), iy = Math.max(0, Math.min(b[3], box[3]) - Math.max(b[1], box[1]));
                            const inter = ix * iy;
                            return inter / ((b[2] - b[0]) * (b[3] - b[1]) + (box[2] - box[0]) * (box[3] - box[1]) - inter);
                        };
                        const best = [...found].sort((a, b) => iou(b.box) - iou(a.box))[0];
                        if (best && iou(best.box) > 0.1) add(best, true);
                    }
                    const under = ([x, y]) => found
                        .filter((o) => o.mask[Math.round(y) * w + Math.round(x)])
                        .sort((a, b) => a.area - b.area)[0];                      // the smallest object there: a cup on a table, not the table
                    points.forEach((p, k) => { if (labels[k] === 1) { const o = under(p); if (o) add(o, true); } });
                    points.forEach((p, k) => { if (labels[k] === 0) { const o = under(p); if (o) add(o, false); } });
                    if (!result.some(Boolean) && points.some((_, k) => labels[k] === 1)) throw new Error('Nothing this model knows is there — try a click-anything model (MobileSAM, MagicTouch), or "trace the edge" or "fill a colour".');
                    return result;
                },
            };
        },
        async mobilesam(spec, what) {
            const ort = await onnx();
            const encoder = await fetchWithProgress(spec.files[0], what + ' (1 of 2)');
            const decoder = await fetchWithProgress(spec.files[1], what + ' (2 of 2)');
            const sam = await loadSam(ort, encoder, decoder, { executionProviders: ['wasm'] });
            return { look: (c) => sam.look(pixels(c), c.width, c.height), objects: () => [], mask: (p) => sam.mask(p) };
        },
        async magictouch(spec, what) {
            // the first MagicTouch: one keypoint per run of the whole model — each click is a run
            const { mp, fileset } = await mediapipe();
            const bytes = await fetchWithProgress(spec.files[0], what);
            const seg = await mp.InteractiveSegmenterLegacy.createFromOptions(fileset, { baseOptions: { modelAssetBuffer: bytes, delegate: 'CPU' }, outputCategoryMask: false, outputConfidenceMasks: true });
            let picture = null;
            const one = ([x, y]) => {
                const { width: w, height: h } = picture;
                const result = seg.segment(picture, { keypoint: { x: (x + 0.5) / w, y: (y + 0.5) / h } });
                const conf = result.confidenceMasks[0];
                const mask = resample(conf.getAsFloat32Array(), conf.width, conf.height, w, h, 0.5);
                result.close();
                return mask;
            };
            return {
                async look(c) { picture = copy(c); },
                objects: () => [],
                async mask({ points = [], labels = [], box = null }) {
                    const result = new Uint8Array(picture.width * picture.height);
                    const asks = points.map((p, k) => [p, labels[k]]);
                    if (box) asks.unshift([[(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], 1]);   // a box: its middle
                    for (const [p] of asks.filter(([, l]) => l === 1)) one(p).forEach((v, i) => { if (v) result[i] = 1; });
                    for (const [p] of asks.filter(([, l]) => l === 0)) one(p).forEach((v, i) => { if (v) result[i] = 0; });
                    return result;
                },
            };
        },
        async magictouch2(spec, what) {
            // MagicTouch 2: setImage runs its encoder once; each set of strokes runs only the decoder
            const { mp, fileset } = await mediapipe();
            const bytes = await fetchWithProgress(spec.files[0], what);
            const seg = await mp.InteractiveSegmenter.createFromOptions(fileset, { baseOptions: { modelAssetBuffer: bytes } });
            const POSITIVE = 1, NEGATIVE = 2, LASSO = 3;            // its BrushMode (a type only: the bundle doesn't export it)
            let w = 0, h = 0;
            return {
                async look(c) { w = c.width; h = c.height; seg.setImage(copy(c)); },
                objects: () => [],
                async mask({ points = [], labels = [], box = null }) {
                    const at = ([x, y]) => ({ x: (x + 0.5) / w, y: (y + 0.5) / h });
                    const strokes = points.map((p, k) => ({ brushMode: labels[k] ? POSITIVE : NEGATIVE, point: [at(p)], isCompleted: true }));
                    if (box) strokes.unshift({ brushMode: LASSO, point: [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]], [box[0], box[1]]].map(at), isCompleted: true });
                    const m = seg.segment(strokes);
                    const values = m.hasFloat32Array() ? m.getAsFloat32Array() : Float32Array.from(m.getAsUint8Array(), (v) => v / 255);
                    const mask = resample(values, m.width, m.height, w, h, 0.5);
                    m.close();
                    return mask;
                },
            };
        },
    };

    async function load() {
        const k = key;
        if (ready[k]) return ready[k];
        const spec = AI_MODELS[k];
        backends[k] ??= (async () => {
            onProgress(`Loading ${spec.name}…`);
            const backend = await (spec.kind === 'objects' ? makers.objects : makers[k])(spec, spec.name);
            onProgress('');
            return backend;
        })().catch((e) => { delete backends[k]; throw new Error(`Finding objects with ${spec.name} is not available: ${e.message}`); });
        ready[k] = await backends[k];
        return ready[k];
    }

    return {
        get loaded() { return Boolean(ready[key]); },
        get device() { return ready[key] ? 'wasm' : null; },
        get model() { return key; },
        get spec() { return AI_MODELS[key]; },
        /** How long the last look at a picture took, in ms. */
        get lookMs() { return lookMs; },
        setModel(k) { if (AI_MODELS[k] && k !== key) { key = k; looked = false; } },
        load,

        /** Look at the picture (or `canvas`). */
        async embed(canvas) {
            const backend = await load();
            const c = canvas ?? source();
            onProgress('Looking…');
            const t0 = performance.now();
            await backend.look(c);
            lookMs = performance.now() - t0;
            looked = true;
            onProgress('');
        },
        invalidate() { looked = false; },

        /** What is in the picture: labels and boxes ([] for the click-anything models). */
        async detect() {
            if (!looked) await this.embed();
            return ready[key].objects();
        },

        /** An outline from a box and/or points (1: this object, 0: not this one), at the picture's size. */
        async mask(prompt = {}) {
            if (!looked) await this.embed();
            return ready[key].mask(prompt);
        },
    };
}

/** A copy of a canvas (MediaPipe may keep it; the source canvas changes as a video plays). */
function copy(c) {
    const out = document.createElement('canvas');
    out.width = c.width; out.height = c.height;
    out.getContext('2d').drawImage(c, 0, 0);
    return out;
}

/** values (sw × sh) → a 0/1 mask (w × h), bilinear, above `cut`. */
function resample(values, sw, sh, w, h, cut) {
    const mask = new Uint8Array(w * h);
    if (sw === w && sh === h) { for (let i = 0; i < mask.length; i++) mask[i] = values[i] > cut ? 1 : 0; return mask; }
    for (let y = 0; y < h; y++) {
        const fy = Math.max(0, Math.min(sh - 1, ((y + 0.5) * sh) / h - 0.5));
        const y0 = Math.min(sh - 2, Math.floor(fy)), ay = fy - y0;
        for (let x = 0; x < w; x++) {
            const fx = Math.max(0, Math.min(sw - 1, ((x + 0.5) * sw) / w - 0.5));
            const x0 = Math.min(sw - 2, Math.floor(fx)), ax = fx - x0;
            const i = y0 * sw + x0;
            const v = (values[i] * (1 - ax) + values[i + 1] * ax) * (1 - ay) + (values[i + sw] * (1 - ax) + values[i + sw + 1] * ax) * ay;
            if (v > cut) mask[y * w + x] = 1;
        }
    }
    return mask;
}

/**
 * Profile picture: a photo, framed on the person in it, in a style, with the background kept,
 * blurred, replaced or removed, cut to a circle, saved as a 1024 × 1024 PNG — or cut out round the
 * person as a sticker (a transparent PNG, an outline round the silhouette if wanted).
 *
 * The frame is a square of the photo (centre and side, in the photo's pixels) drawn into a 1024
 * canvas — or, cut out, the person's box with a margin, 1024 on its long side; the filter runs on that. The person is outlined by MobileSAM (../ai.js):
 * a guess from two clicks where a portrait's subject is (face, chest), then the user's own marks —
 * with "Mark me" / "Mark not me" (a toggle under the photo), each click adds a point in or out, shown
 * as a dot; "Keep as is" paints over areas that are right, which later answers don't change. The outline is the `selection`, so the background step is `mix(…, rgb, selected)`.
 */

const $ = (id) => document.getElementById(id);
const SIZE = 1024;                     // what is saved
const THUMB = 112;                     // the style previews

/** The styles: steps for a filter chain; `s` is the output's size over 1024, for effects measured in pixels. */
const STYLES = [
  { id: 'natural', name: 'Natural', steps: () => [] },
  { id: 'bw', name: 'Black & white', steps: () => [byName('Grayscale'), { filter: byName('Brightness & contrast'), with: { contrast: 1.15 } }] },
  { id: 'warm', name: 'Warm', steps: () => ['rgb * (1.1, 1.0, 0.86)'] },
  { id: 'cool', name: 'Cool', steps: () => ['rgb * (0.9, 1.0, 1.12)'] },
  { id: 'vivid', name: 'Vivid', steps: () => [byName('Vivid')] },
  { id: 'vintage', name: 'Vintage', steps: () => [byName('Sepia'), { filter: byName('Vignette'), with: { strength: 1.2 } }] },
  { id: 'duotone', name: 'Duotone', steps: () => [{ name: 'Duotone', params: { dark: [0.12, 0.09, 0.35], light: [1, 0.78, 0.45] }, color: 'mix(dark, light, gray)' }] },
  { id: 'pop', name: 'Pop art', steps: () => [byName('Vivid'), { filter: byName('Posterize'), with: { levels: 4 } }] },
  { id: 'comic', name: 'Comic', steps: () => [byName('Comic')] },
  { id: 'cartoon', name: 'Cartoon', steps: () => [byName('Cartoon')] },
  { id: 'sketch', name: 'Sketch', steps: (s) => [`gaussian(${(2.2 * s).toFixed(2)})`, '(1 - smoothstep(0.06, 0.3, sobel())) * (1, 1, 1)'] },
  { id: 'dreamy', name: 'Dreamy', steps: () => [byName('Dreamy')] },
  { id: 'pixel', name: 'Pixel', steps: (s) => [{ filter: byName('Pixelate'), with: { size: Math.max(2, Math.round(28 * s)) } }] },
];
/** The background, applied after the style: `selected` is 1 on the person. */
const BACKGROUNDS = {
  keep: null,
  blur: (s) => ({ name: 'Blurred background', color: `mix(gaussian(${(10 * s).toFixed(1)}), rgb, selected)` }),
  colour: () => ({ name: 'Colour background', params: { c1: [0.16, 0.44, 0.86] }, color: 'mix(c1, rgb, selected)' }),
  gradient: () => ({ name: 'Gradient background', params: { c1: [0.16, 0.44, 0.86], c2: [0.96, 0.64, 0.78] }, color: 'mix(mix(c1, c2, y), rgb, selected)' }),
  none: () => ({ name: 'No background', color: { rgb: 'rgb', a: 'a selected' } }),
};
/** A cut-out's outline: `outline` is the person's shape grown a little; where it is and the person isn't, the ring colour. */
const OUTLINE = { name: 'Sticker outline', images: { outline: {} }, params: { ringc: [1, 1, 1] }, color: { rgb: 'mix(ringc, rgb, selected)', a: 'max(a, luma(outline))' } };

const state = { picture: null, person: null, frame: null, style: 'natural', bg: 'keep', moved: false, found: undefined, shape: 'circle' };
const framed = Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
const framedMask = Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
const outline = Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
const WHITE = Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
WHITE.getContext('2d').fillStyle = '#fff'; WHITE.getContext('2d').fillRect(0, 0, 1, 1);

const view = createView($('frame'), SIZE, SIZE, { label: 'your profile picture' });
const thumbBox = document.createElement('div');                      // the previews are drawn here, then copied to the tiles
const thumbs = createView(thumbBox, THUMB, THUMB);
const status = (text, bad = false) => { $('status').textContent = text; $('status').classList.toggle('bad', bad); };
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

const ai = setupAI({
  source: () => state.picture, model: 'mobilesam', base: ROOT, ortUrl: ORT_URL$1, mediapipeUrl: MEDIAPIPE_URL$1,
  onProgress: (text) => { if (text) status(text.replace(/^(Loading )?MobileSAM( \(\d of 2\))?/, 'Getting ready to find you')); },
});

// ---- the frame ------------------------------------------------------------------
function clampFrame() {
  const { width: w, height: h } = state.picture;
  const f = state.frame;
  f.size = Math.min(f.size, w, h);
  f.cx = Math.min(w - f.size / 2, Math.max(f.size / 2, f.cx));
  f.cy = Math.min(h - f.size / 2, Math.max(f.size / 2, f.cy));
  $('zoom').value = String(Math.min(w, h) / f.size);
}
/** The part of the photo that is drawn: the square frame, or (cut out) the person's box with a margin. */
function region() {
  if (state.shape === 'cutout' && state.personBox) {
    const [x0, y0, x1, y1] = state.personBox, m = 0.06 * Math.max(x1 - x0, y1 - y0);
    const x = Math.max(0, x0 - m), y = Math.max(0, y0 - m);
    return { x, y, w: Math.min(state.picture.width, x1 + m) - x, h: Math.min(state.picture.height, y1 + m) - y };
  }
  const f = state.frame;
  return { x: f.cx - f.size / 2, y: f.cy - f.size / 2, w: f.size, h: f.size };
}
function drawFramed() {
  const r = region();
  const k = SIZE / Math.max(r.w, r.h);
  const W = Math.round(r.w * k), H = Math.round(r.h * k);
  if (framed.width !== W || framed.height !== H) {
    for (const c of [framed, framedMask, outline]) { c.width = W; c.height = H; }
    view.resize(W, H);
    shape = '';                                                    // the passes are sized to the canvas: build them again
  }
  framed.getContext('2d').drawImage(state.picture, r.x, r.y, r.w, r.h, 0, 0, W, H);
  if (state.person) {
    const m = framedMask.getContext('2d');
    m.clearRect(0, 0, W, H);
    m.filter = 'blur(2px)';                                       // a soft edge: the model's outline is a little coarse
    m.drawImage(state.person, r.x, r.y, r.w, r.h, 0, 0, W, H);
    m.filter = 'none';
    if (state.shape === 'cutout' && $('ring').checked) drawOutline(W, H);
  }
}
/** The person's shape grown by the outline's width (a blur, then everything it reached). */
function drawOutline(W, H) {
  const g = outline.getContext('2d', { willReadFrequently: true });
  const width = Math.round(0.022 * Math.max(W, H));
  g.clearRect(0, 0, W, H);
  g.filter = `blur(${width / 2}px)`;
  g.drawImage(framedMask, 0, 0);
  g.filter = 'none';
  const img = g.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const v = Math.min(255, Math.max(0, (d[i + 3] - 8) * 12)); d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = v; }
  g.putImageData(img, 0, 0);
}

// ---- the filter -------------------------------------------------------------------
function chainFor(styleId, bg, s = 1, sticker = false) {
  const steps = [...STYLES.find((st) => st.id === styleId).steps(s)];
  if (bg !== 'keep' && state.person) steps.push(BACKGROUNDS[bg](s));
  if (sticker && state.person) steps.push(OUTLINE);
  return steps.length ? { steps } : 'rgb';
}
const sticker = () => state.shape === 'cutout' && $('ring').checked;
function bgKnobs() { return { c1: hex($('bg1').value), c2: hex($('bg2').value), ringc: hex($('ring-colour').value) }; }
let shape = '';
function rebuild() {
  try {
    view.set(chainFor(state.style, state.bg, 1, sticker()), bgKnobs());
    shape = JSON.stringify([state.style, state.bg, Boolean(state.person), sticker(), framed.width, framed.height]);
  } catch (e) { status(e.message, true); }
  render();
}
function render() {
  if (!state.picture) return;
  drawFramed();
  if (shape !== JSON.stringify([state.style, state.bg, Boolean(state.person), sticker(), framed.width, framed.height])) { rebuild(); return; }
  view.setImage('source', framed);
  view.setImage('selection', state.person ? framedMask : WHITE);
  view.setImage('outline', outline);
  view.knobs(bgKnobs());
  view.draw(0);
  const ring = $('ring').checked && state.shape !== 'cutout';      // a cut-out's outline is drawn by the filter
  $('frame').style.setProperty('--ring', ring ? $('ring-colour').value : 'transparent');
  $('frame').style.setProperty('--ring-w', `${(ring ? 0.035 : 0) * $('frame').clientWidth}px`);
  drawMarks();
}

/** The style tiles: each style on a small copy of the frame (redrawn a moment after the frame stops moving). */
function makeTiles() {
  const box = $('styles');
  for (const st of STYLES) {
    const tile = Object.assign(document.createElement('button'), { type: 'button', className: 'tile' });
    tile.dataset.style = st.id;
    tile.setAttribute('aria-pressed', String(st.id === state.style));
    const c = Object.assign(document.createElement('canvas'), { width: THUMB, height: THUMB });
    c.setAttribute('aria-hidden', 'true');
    tile.append(c, st.name);
    tile.onclick = () => {
      state.style = st.id;
      for (const t of box.children) t.setAttribute('aria-pressed', String(t === tile));
      render();
    };
    box.append(tile);
  }
}
let thumbTimer = null;
function updateTiles() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    const small = Object.assign(document.createElement('canvas'), { width: THUMB, height: THUMB });
    small.getContext('2d').drawImage(framed, 0, 0, THUMB, THUMB);
    thumbs.setImage('source', small);
    for (const tile of $('styles').children) {
      try {
        thumbs.set(chainFor(tile.dataset.style, 'keep', THUMB / SIZE));
        thumbs.draw(0);
        tile.querySelector('canvas').getContext('2d').drawImage(thumbs.canvas, 0, 0);
      } catch { /* a preview is a nicety */ }
    }
  }, 250);
}

// ---- finding the person -------------------------------------------------------------
/** The model's copy of the photo: at most 1024 across (the outline is as good, and the masks much smaller). */
function smallCopy() {
  const { width: w, height: h } = state.picture, k = Math.min(1, 1024 / Math.max(w, h));
  state.small = Object.assign(document.createElement('canvas'), { width: Math.round(w * k), height: Math.round(h * k) });
  state.small.getContext('2d').drawImage(state.picture, 0, 0, state.small.width, state.small.height);
}
/** A mask over state.small (1 = the person) becomes the person: the outline, its box, the frame. */
function useMask(mask, { reframe, prompt = null }) {
  const { width: w, height: h } = state.picture;
  const sw = state.small.width, sh = state.small.height, k = sw / w;
  state.found = state.picture;
  let area = 0, x0 = sw, y0 = sh, x1 = 0, y1 = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    area++;
    const x = i % sw, y = (i - x) / sw;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  // a guess that takes almost nothing or almost everything isn't a person in the middle: ask instead
  if (!area || (!prompt && (area < 0.04 * sw * sh || area > 0.85 * sw * sh))) {
    state.person = null;
    state.personMask = new Uint8Array(sw * sh);
    state.prompt = { points: [], labels: [] };
    status(prompt ? 'Nothing there — choose "Mark me" and click on yourself.' : 'Choose "Mark me" under the photo and click on yourself to show where you are.');
    render();
    return false;
  }
  state.prompt = prompt ?? { points: GUESS(w, h).points, labels: [1, 1] };
  state.personMask = Uint8Array.from(mask);
  const small = Object.assign(document.createElement('canvas'), { width: sw, height: sh });
  const img = new ImageData(sw, sh);
  for (let i = 0; i < mask.length; i++) if (mask[i]) img.data.set([255, 255, 255, 255], i * 4);
  small.getContext('2d').putImageData(img, 0, 0);
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  c.getContext('2d').drawImage(small, 0, 0, w, h);          // smoothed on the way up
  state.person = c;
  state.personBox = [x0 / k, y0 / k, (x1 + 1) / k, (y1 + 1) / k];
  if (reframe) frameOn(state.personBox);
  status('');
  render();
  return true;
}
/** A sample's outline worked out ahead of time (photos/index.json "person": a PNG the size of the model's copy, white = the
 *  person), so opening the page doesn't download the model; it loads when the user marks or opens their own photo. */
async function usePrecomputed(url) {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    smallCopy();
    const sw = state.small.width, sh = state.small.height;
    const g = Object.assign(document.createElement('canvas'), { width: sw, height: sh }).getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, sw, sh);
    const d = g.getImageData(0, 0, sw, sh).data, mask = new Uint8Array(sw * sh);
    for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4] > 127 ? 1 : 0;
    return useMask(mask, { reframe: true });
  } catch { return false; }
}
/** The person: MobileSAM's outline from a guess (where a portrait's subject is) or the user's clicks; the frame goes to head and shoulders. */
const GUESS = (w, h) => ({ points: [[w * 0.5, h * 0.35], [w * 0.5, h * 0.65]], labels: [1, 1] });
async function findPerson({ reframe, prompt = null }) {
  if (!prompt && state.found === state.picture) { if (reframe && state.person) frameOn(state.personBox); return Boolean(state.person); }
  status('Finding you in the photo…');
  try {
    const { width: w } = state.picture;
    if (state.looked !== state.picture) {
      smallCopy();
      ai.invalidate();
      await ai.embed(state.small);
      state.looked = state.picture;
    }
    const sw = state.small.width, sh = state.small.height, k = sw / w;
    const ask = prompt ? { points: prompt.points.map(([x, y]) => [x * k, y * k]), labels: prompt.labels } : GUESS(sw, sh);
    const mask = await ai.mask(ask);
    if (state.lock) for (let i = 0; i < mask.length; i++) if (state.lock[i]) mask[i] = state.kept[i];   // what was kept stays as it was
    return useMask(mask, { reframe, prompt });
  } catch (e) {
    status(e.message, true);
    return false;
  }
}
// ---- marking: a point on the person (Mark me) or not (Mark not me) per click; areas kept as they are --------
// MobileSAM is given only the points clicked (and its first guess): a few well-placed points work best.
// "Keep as is" paints over an area that is right: there the outline stays as it was when painted,
// whatever the model answers after (state.lock: 1 where kept; state.kept: the outline there then).
let dragged = 0;
const tool = () => document.querySelector('input[name=tool]:checked').value;
/** A point of the photo under the pointer. */
function photoPoint(e) {
  const rect = view.canvas.getBoundingClientRect(), r = region();
  return [r.x + ((e.clientX - rect.left) / rect.width) * r.w, r.y + ((e.clientY - rect.top) / rect.height) * r.h];
}
/** The marks start from the guess (or the points that made the outline), so a first mark refines it rather than starting over. */
function marks() {
  if (!state.marks) state.marks = state.person && state.prompt ? { points: [...state.prompt.points], labels: [...state.prompt.labels] } : { points: [], labels: [] };
  return state.marks;
}
function addMark(point, label) {
  const m = marks();
  m.points.push(point);
  m.labels.push(label);
  drawMarks();
  runMarks();
}
/** The model on the marks; a click made while it works waits for the next run, so it never falls behind. */
let running = false, again = false;
async function runMarks() {
  if (running) { again = true; return; }
  if (!state.marks.labels.includes(1)) { status('Mark yourself first ("Mark me"), then what isn\'t you.'); return; }
  running = true;
  do {
    again = false;
    await findPerson({ reframe: false, prompt: { points: [...state.marks.points], labels: [...state.marks.labels] } });
  } while (again);
  running = false;
}
/** Paint "keep" round a point of the photo: a disc a twentieth of what is in view, in the model's (small) picture. */
function keepAt([x, y]) {
  if (!state.small || !state.personMask) return false;
  const sw = state.small.width, sh = state.small.height, k = sw / state.picture.width;
  if (!state.lock) {
    state.lock = new Uint8Array(sw * sh);
    state.kept = new Uint8Array(sw * sh);
    state.lockCanvas = Object.assign(document.createElement('canvas'), { width: sw, height: sh });
  }
  const r = region(), R = 0.05 * Math.max(r.w, r.h) * k, cx = x * k, cy = y * k;
  for (let j = Math.max(0, Math.floor(cy - R)); j <= Math.min(sh - 1, Math.ceil(cy + R)); j++) {
    for (let i = Math.max(0, Math.floor(cx - R)); i <= Math.min(sw - 1, Math.ceil(cx + R)); i++) {
      const at = j * sw + i;
      if ((i - cx) ** 2 + (j - cy) ** 2 > R * R || state.lock[at]) continue;
      state.lock[at] = 1;
      state.kept[at] = state.personMask[at];
    }
  }
  const g = state.lockCanvas.getContext('2d');
  g.fillStyle = '#3d7bff';
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fill();
  return true;
}
/** What is used, over the photo: the points (green on you, red not) and the kept areas (blue). */
function drawMarks() {
  const c = $('marks'), dpr = devicePixelRatio || 1;
  const w = Math.round($('frame').clientWidth * dpr), h = Math.round($('frame').clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (!state.picture || !$('show-marks').checked) return;
  const r = region();
  if (state.lock) {
    const k = state.small.width / state.picture.width;
    g.globalAlpha = 0.35;
    g.drawImage(state.lockCanvas, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, w, h);
    g.globalAlpha = 1;
  }
  const used = state.marks ?? (state.person ? state.prompt : null);
  if (!used) return;
  used.points.forEach(([x, y], k) => {
    const px = ((x - r.x) / r.w) * w, py = ((y - r.y) / r.h) * h;
    g.beginPath();
    g.arc(px, py, 6 * dpr, 0, Math.PI * 2);
    g.fillStyle = used.labels[k] ? '#2fbf4a' : '#e0313b';
    g.fill();
    g.lineWidth = 2 * dpr;
    g.strokeStyle = '#fff';
    g.stroke();
  });
}
{
  let keeping = null;                                             // the last point of a "keep" drag
  const pointers = new Set();
  $('frame').addEventListener('pointerdown', (e) => {
    pointers.add(e.pointerId);
    keeping = null;
    if (tool() === 'move' || !state.picture || pointers.size > 1) return;   // two fingers: a pinch, not a mark
    const p = photoPoint(e);
    if (tool() === 'keep') {
      if (!keepAt(p)) { status('Wait until you are outlined, then paint over what is right.'); return; }
      keeping = p;
      drawMarks();
    } else addMark(p, tool() === 'add' ? 1 : 0);
  });
  $('frame').addEventListener('pointermove', (e) => {
    if (!keeping || !pointers.has(e.pointerId)) return;
    const p = photoPoint(e), r = region(), step = 0.02 * Math.max(r.w, r.h);
    const n = Math.ceil(Math.hypot(p[0] - keeping[0], p[1] - keeping[1]) / step);
    for (let s = 1; s <= n; s++) keepAt([keeping[0] + ((p[0] - keeping[0]) * s) / n, keeping[1] + ((p[1] - keeping[1]) * s) / n]);
    keeping = p;
    drawMarks();
  });
  const end = (e) => { pointers.delete(e.pointerId); keeping = null; };
  $('frame').addEventListener('pointerup', end);
  $('frame').addEventListener('pointercancel', end);
}
for (const r of document.querySelectorAll('input[name=tool]')) r.onchange = () => {
  $('frame').classList.toggle('grab', tool() === 'move' && state.shape !== 'cutout');
  $('frame').classList.toggle('pick', tool() !== 'move');
  $('frame').title = { move: 'drag to move, scroll or pinch to zoom', add: 'click on yourself', remove: 'click on what isn\'t you', keep: 'paint over what is outlined right, to keep it as it is' }[tool()];
  if (tool() !== 'move' && state.picture && !state.person && !state.marks) status('Click on yourself to show where you are.');
  drawMarks();
};
$('show-marks').onchange = drawMarks;
$('clear-marks').onclick = () => {
  state.marks = null;
  state.lock = state.kept = state.lockCanvas = null;
  state.found = undefined;                                       // look again from the guess
  drawMarks();
  findPerson({ reframe: false });
};

/** Head and shoulders: a square on the upper part of the person's box. */
function frameOn([x0, y0, x1, y1]) {
  const bw = x1 - x0, bh = y1 - y0;
  const size = Math.max(bw * 1.15, Math.min(bh, bw * 1.6) * 0.85);
  state.frame = { cx: (x0 + x1) / 2, cy: y0 + size * 0.46, size };
  clampFrame();
  render();
  updateTiles();
}

// ---- the photo ------------------------------------------------------------------------
async function usePicture(canvas, credit = '', person = '') {
  state.picture = canvas;
  state.person = null;
  state.found = undefined;
  state.prompt = null;
  state.marks = null;
  state.lock = state.kept = state.lockCanvas = null;
  state.personMask = null;
  state.moved = false;
  const side = Math.min(canvas.width, canvas.height);
  state.frame = { cx: canvas.width / 2, cy: canvas.height / 2, size: side };
  clampFrame();
  showCredit($('credit'), credit);
  shape = '';
  render();
  updateTiles();
  if (person && await usePrecomputed(person)) return;           // a sample with its outline ready: no model yet
  findPerson({ reframe: true });                              // centred on you, as soon as the model has looked
}

$('file').onchange = async () => {
  try { await usePicture(await openFile($('file').files[0], 2048)); $('sample').value = ''; }
  catch (e) { status(e.message, true); }
};
const samples = await samplePhotos();
$('sample').append(new Option('a sample photo', ''), ...samples.map((p, i) => new Option(p.title || p.file, String(i))));
$('sample').onchange = async () => {
  const p = samples[Number($('sample').value)];
  if (p) await usePicture(await loadPicture(p.url, 2048), p.credit, p.personUrl);
};

// ---- the controls ------------------------------------------------------------------------
makeTiles();
dragAndZoom($('frame'), {
  onStart: () => { dragged = 0; },
  onMove: (dx, dy) => {
    dragged += Math.hypot(dx, dy);
    if (dragged > 5) state.moved = true;
    if (!state.picture || state.shape === 'cutout' || tool() !== 'move' || dragged <= 5) return;
    const k = state.frame.size / $('frame').clientWidth;
    state.frame.cx -= dx * k;
    state.frame.cy -= dy * k;
    clampFrame(); render(); updateTiles();
  },
  onZoom: (f) => {
    if (!state.picture || state.shape === 'cutout') return;
    state.frame.size /= f;
    clampFrame(); render(); updateTiles();
  },
});
$('zoom').oninput = () => {
  state.frame.size = Math.min(state.picture.width, state.picture.height) / Number($('zoom').value);
  clampFrame(); render(); updateTiles();
};
$('centre').onclick = () => findPerson({ reframe: true });
for (const r of document.querySelectorAll('input[name=bg]')) r.onchange = async () => {
  state.bg = r.value;
  $('bg-colours').hidden = !(r.value === 'colour' || r.value === 'gradient');
  $('bg2').hidden = r.value !== 'gradient';
  if (r.value !== 'keep' && !state.person) await findPerson({ reframe: !state.moved });
  render();
};
for (const id of ['bg1', 'bg2', 'ring', 'ring-colour']) $(id).oninput = render;
for (const r of document.querySelectorAll('input[name=shape]')) r.onchange = async () => {
  if (!r.checked) return;
  if (r.value === 'cutout' && !state.person && !(await findPerson({ reframe: false }))) {
    status('A cut-out needs a person in the photo.', true);
    document.querySelector('input[name=shape][value=circle]').checked = true;
    return;
  }
  state.shape = r.value;
  $('frame').classList.toggle('round', r.value === 'circle');
  $('frame').classList.toggle('grab', r.value !== 'cutout' && tool() === 'move');
  if (r.value === 'cutout' && state.bg !== 'none') document.querySelector('input[name=bg][value=none]').click();   // a sticker: nothing round it
  $('ring-label').textContent = r.value === 'cutout' ? 'outline' : 'ring';
  render();
};
addEventListener('resize', render);

$('download').onclick = async () => {
  if (!state.picture) return;
  render();
  const out = Object.assign(document.createElement('canvas'), { width: view.canvas.width, height: view.canvas.height });
  const g = out.getContext('2d');
  if (state.shape === 'cutout') {
    g.drawImage(view.canvas, 0, 0);
    if (!window.qblurNoDownload) await download(out, 'sticker.png');
    status(`Saved a ${out.width} × ${out.height} PNG${state.bg === 'none' ? ' with a transparent background' : ''}.`);
    return;
  }
  const circle = state.shape === 'circle';
  if (circle) { g.beginPath(); g.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2); g.clip(); }
  g.drawImage(view.canvas, 0, 0);
  if ($('ring').checked) {
    const w = SIZE * 0.035;
    g.strokeStyle = $('ring-colour').value;
    g.lineWidth = w;
    if (circle) { g.beginPath(); g.arc(SIZE / 2, SIZE / 2, SIZE / 2 - w / 2, 0, Math.PI * 2); g.stroke(); }
    else g.strokeRect(w / 2, w / 2, SIZE - w, SIZE - w);
  }
  if (!window.qblurNoDownload) await download(out, 'profile-picture.png');
  status(`Saved a ${SIZE} × ${SIZE} PNG${circle || state.bg === 'none' ? ' (transparent where there is nothing)' : ''}.`);
};

// start on the portrait sample
const first = Math.max(0, samples.findIndex((p) => /portrait/i.test(p.title || p.file)));
if (samples[first]) { $('sample').value = String(first); await usePicture(await loadPicture(samples[first].url, 2048), samples[first].credit, samples[first].personUrl); }

window.qblurApp = { state, view, ai, findPerson, render, STYLES, addMark, keepAt, runMarks };     // for tools/check.mjs
