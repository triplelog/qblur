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
import { filterShader } from 'mathzetta/glsl';
import { FILTER_NAMES, PLACES, COLOUR_SPACES } from 'mathzetta/glsl';
import { normalizeGraphic, shadowLayerNames, MAX_SHADOW_LAYERS } from './graphics.js';

export const FILTER_FORMAT = 'mathzetta-filter/1';

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
export const PLACEMENT = { place: 'cover', zoom: 1, x: 0.5, y: 0.5, angle: 0 };

// ---- the shape ------------------------------------------------------------

/**
 * The full form of a filter: a string becomes `{ color }`, params get
 * their type and range, every step gets `with` and `opacity`. Throws on
 * anything that isn't a filter.
 */
export function normalizeFilter(def) {
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
export function filterGraphics(filter) {
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
export function filterImages(filter) {
    if (filter.color) return { ...(filter.images ?? {}) };
    const out = {};
    for (const step of filter.steps) {
        for (const [name, image] of Object.entries(filterImages(step.filter))) if (!(name in out)) out[name] = image;
    }
    return out;
}

/** Every parameter a filter exposes, including those of the filters inside a chain (first one wins). */
export function filterParams(filter) {
    if (filter.color) return { ...(filter.params ?? {}) };
    const out = {};
    for (const step of filter.steps) {
        for (const [name, param] of Object.entries(filterParams(step.filter))) if (!(name in out)) out[name] = param;
    }
    return out;
}

// ---- checking -------------------------------------------------------------

/** Every problem with a filter, as messages; empty when it will compile. */
export function validateFilter(def) {
    let filter;
    try { filter = normalizeFilter(def); } catch (e) { return [e.message]; }
    const problems = [];
    check({ filter, with: {}, opacity: 1 }, [], problems, true);
    return problems;
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
        filter.steps.forEach((inner, i) => check(inner, [...path, i], problems, shaders));
        return;
    }
    if (shaders) try { makePass(filter, Object.fromEntries(Object.entries(step.with).filter(([k]) => k in (filter.graphics ?? {}))), 1, path, 100); } catch (e) { problems.push(`${where}: ${e.message}`); }   // with its settings: a "with" may add shadow layers
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
export function compileFilter(def, options = {}) {
    const filter = normalizeFilter(def);
    const problems = [];
    check({ filter, with: {}, opacity: 1 }, [], problems, false);
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

// ---- passing filters around ----------------------------------------------

/** The filter as JSON to publish: normalized, with defaults left out. */
export function filterToJSON(def) {
    return JSON.stringify(tidy(normalizeFilter(def), true), null, 2);
}

export function filterFromJSON(text) {
    let raw;
    try { raw = JSON.parse(text); } catch { throw new Error('Not valid JSON'); }
    return normalizeFilter(raw);
}

/** `base + '#' + the filter`, URL-safe; `base` is the page that opens it. */
export function filterToLink(def, base = '') {
    return `${base}#${toBase64Url(JSON.stringify(tidy(normalizeFilter(def), true)))}`;
}

export function filterFromLink(text) {
    const hash = text.includes('#') ? text.slice(text.lastIndexOf('#') + 1) : text;
    let raw;
    try { raw = JSON.parse(fromBase64Url(hash.trim())); } catch { throw new Error('Not a filter link'); }
    return normalizeFilter(raw);
}

/** A filter from whatever someone pasted: JSON, a share link, or a bare expression. */
export function readFilter(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) throw new Error('Nothing to read');
    if (trimmed.startsWith('{')) return filterFromJSON(trimmed);
    if (!/\s/.test(trimmed)) {
        const hash = trimmed.includes('#') ? trimmed.slice(trimmed.lastIndexOf('#') + 1) : trimmed;
        if (/^[A-Za-z0-9_-]{8,}$/.test(hash)) {
            try { return filterFromLink(hash); } catch (e) { if (trimmed.includes('#')) throw e; }
        }
    }
    return normalizeFilter(trimmed);
}

/** The normalized filter with defaults dropped: `with: {}`, `opacity: 1`, inner `format`s, and `{ color }` alone becomes its string. */
function tidy(filter, top) {
    const out = {};
    if (top) out.format = FILTER_FORMAT;
    for (const key of ['name', 'author', 'description']) if (filter[key]) out[key] = filter[key];
    if (filter.notes && filter.notes.length) out.notes = filter.notes;
    if (filter.steps) {
        out.steps = filter.steps.map((step) => {
            const inner = tidy(step.filter, false);
            const bare = Object.keys(inner).length === 1 && typeof inner.color === 'string' ? inner.color : inner;
            const extras = {};
            if (Object.keys(step.with).length) extras.with = step.with;
            if (step.opacity !== 1) extras.opacity = step.opacity;
            if (step.skip) extras.skip = true;
            return Object.keys(extras).length ? { filter: bare, ...extras } : bare;
        });
        return out;
    }
    if (filter.params) out.params = filter.params;
    if (filter.images) out.images = filter.images;
    if (filter.graphics) out.graphics = filter.graphics;
    if (filter.space) out.space = filter.space.in === filter.space.out ? filter.space.in : filter.space;
    out.color = filter.color;
    return out;
}

function toBase64Url(text) {
    let binary = '';
    for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
