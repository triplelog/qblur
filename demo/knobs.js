/**
 * A filter's knobs written as Inline Math variables, and the page each filter has in the editor.
 * No DOM: test/knobs.test.js.
 *
 *   cutoff := [[0..1 step 0.01 = 0.5]]    a slider (min..max, its step, where it starts)
 *   radius := [[3]]                        a box: any maths that works out to a number
 *   levels := [[2 | 4 | 8]]                a menu of values
 *   tint := #ff8800                        a colour
 *
 * Each line is what the editor shows in a knob's box; Inline Math draws the same line (but for a
 * colour) as `cutoff ≔` and its input. A filter's page (`notes` in the format) is Markdown text and
 * `{ param }` entries for where each knob goes; knobs it doesn't place come first.
 */
import { calculate } from 'mathzetta/calculate';

const NUMBER = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)';
const SLIDER = new RegExp(`^(${NUMBER})\\s*\\.\\.\\s*(${NUMBER})(?:\\s+step\\s+(${NUMBER}))?(?:\\s*=\\s*(${NUMBER}))?$`);
const DEFINITION = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:=\s*(.*?)\s*$/;
export const HOW = 'Write a knob as name := [[0..1 step 0.01 = 0.5]] (a slider), [[0.5]] (a box), [[2 | 4 | 8]] (a menu) or #ff8800 (a colour)';

/** A number as the editor writes it: at most 4 decimals. */
export const trim = (n) => String(Math.round(Number(n) * 1e4) / 1e4);
export const toHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
export const fromHex = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/** The step a slider moves by when the knob doesn't say: about 200 steps, rounded to 1, 2 or 5 of a power of ten. */
export function sliderStep(param) {
    if (param.step) return param.step;
    const raw = (param.max - param.min) / 200;
    if (!(raw > 0)) return 0.01;
    const power = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw * 0.999);
}

/** The knob as a line: `cutoff := [[0..1 step 0.005 = 0.5]]`. */
export function definitionOf(name, param) {
    if (param.type === 'color') return `${name} := ${toHex(param.default)}`;
    if (param.options) return `${name} := [[${param.options.map(trim).join(' | ')}]]`;
    if (param.input === 'box') return `${name} := [[${trim(param.default)}]]`;
    return `${name} := [[${trim(param.min)}..${trim(param.max)} step ${trim(sliderStep(param))} = ${trim(param.default)}]]`;
}

/** What Inline Math is given for a knob's input: its line with the value it starts at (a menu starts on its first option). */
export function inlineDefinition(name, param) {
    if (param.options) return `${name} := [[${[param.default, ...param.options.filter((o) => o !== param.default)].map(trim).join(' | ')}]]`;
    return definitionOf(name, param);
}

/** A number from what an input holds: `0.5`, or maths such as `1/3` or `2 pi`; null when it isn't one. */
export function numberOf(text) {
    const plain = Number(text);
    if (String(text).trim() !== '' && Number.isFinite(plain)) return plain;
    try {
        const { value } = calculate(String(text), {});
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * A knob's line → `{ name, spec }`, the spec as the format has it (params). Throws, saying how to
 * write one, when it isn't. `label` carries over the knob's label, if it had one.
 */
export function parseDefinition(text, label) {
    const m = DEFINITION.exec(String(text));
    if (!m || !m[2]) throw new Error(HOW);
    const [, name, rhs] = m;
    const keep = label ? { label } : {};
    if (/^#[0-9a-f]{6}$/i.test(rhs)) return { name, spec: { type: 'color', ...keep, default: fromHex(rhs) } };
    const boxed = /^\[\[([\s\S]*)\]\]$/.exec(rhs);
    const inner = (boxed ? boxed[1] : rhs).trim();
    const range = SLIDER.exec(inner);
    if (range) {
        const [min, max] = [Number(range[1]), Number(range[2])];
        if (!(max > min)) throw new Error(`A slider goes from a smaller number to a larger one: ${inner}`);
        const step = range[3] !== undefined ? Number(range[3]) : undefined;
        if (step !== undefined && !(step > 0)) throw new Error('A slider\'s step is more than 0');
        const start = range[4] !== undefined ? Number(range[4]) : min;
        if (!(start >= min && start <= max)) throw new Error(`The slider starts at ${start}, outside ${min} to ${max}`);
        return { name, spec: { type: 'number', ...keep, default: start, min, max, ...(step !== undefined ? { step } : {}) } };
    }
    if (inner.includes('|')) {
        const options = inner.split('|').map((o) => o.trim()).filter(Boolean).map(numberOf);
        if (!options.length || options.some((o) => o === null)) throw new Error(`A menu is numbers between | marks: [[2 | 4 | 8]]`);
        return { name, spec: { type: 'number', ...keep, default: options[0], options } };
    }
    const value = numberOf(inner);
    if (value === null) throw new Error(`${inner} is not a number. ${HOW}`);
    return { name, spec: { type: 'number', ...keep, default: value, input: 'box' } };
}

/** The filter's page in order: every knob ({ param }) and every text (a string). */
export function blocksOf(params, notes = []) {
    const names = Object.keys(params);
    const placed = new Set(notes.filter((b) => typeof b === 'object').map((b) => b.param));
    return [...names.filter((n) => !placed.has(n)).map((param) => ({ param })), ...notes.filter((b) => typeof b === 'string' || names.includes(b.param))];
}

/** The page as the format keeps it: nothing when it is only the knobs in their own order. */
export function notesOf(blocks) {
    return blocks.some((b) => typeof b === 'string') ? blocks.map((b) => (typeof b === 'string' ? b : { param: b.param })) : undefined;
}

/** A name for a new knob: k1, k2 … one not taken. */
export function freeName(taken, prefix = 'k') {
    for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

/** `old` renamed to `name` everywhere it is a whole word in the maths (not inside other names, nor after a dot). */
export function renameInMaths(color, old, name) {
    const swap = (text) => text.replace(new RegExp(`(?<![\\w.])${old}(?![\\w])`, 'g'), name);
    if (typeof color === 'string') return swap(color);
    return Object.fromEntries(Object.entries(color).map(([k, v]) => [k, swap(v)]));
}

/**
 * A step as a filter of its own, to save or share: a filter's knobs start where the step has
 * them, its pictures and graphics as the step places them; a chain keeps the step's settings in
 * a step of its own.
 */
export function bakeStep(step) {
    const f = JSON.parse(JSON.stringify(step.filter));
    const settings = step.with ?? {};
    if (f.steps) {
        if (!Object.keys(settings).length) return f;
        const { name, author, description, notes, ...inner } = f;
        const out = { name, author, description, notes, steps: [{ filter: inner, with: settings }] };
        for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
        return out;
    }
    for (const [key, value] of Object.entries(settings)) {
        const param = f.params?.[key];
        if (param) {
            if (param.type === 'color') param.default = value.map(Number);
            else {
                const v = Number(value);
                param.default = v;
                if (param.options && !param.options.includes(v)) param.options = [...param.options, v];
                if (v < param.min) param.min = v;
                if (v > param.max) param.max = v;
            }
        } else if (f.graphics?.[key]) f.graphics[key] = { ...f.graphics[key], ...value };
        else if (f.images?.[key]) f.images[key] = { ...f.images[key], ...value };
    }
    return f;
}
