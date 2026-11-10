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

import { parseTree } from 'mathzetta';
import { checkGeneratedJs } from 'mathzetta/formulas';
import { FILTER_VALUES, FILTER_FUNCTIONS, NEIGHBOURHOOD, COLOUR_FUNCTIONS, filterPictureCalls } from 'mathzetta/glsl';
import * as H from './cpu-helpers.js';

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
export function compileCpuPass(pass) {
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
                const pic = ctx.pictures[this.bind?.[p] ?? p] ?? (this.graphics?.has(p) ? H.CLEAR : H.BLANK);
                const pl = ctx.placements[p] ?? {};
                return [pic.data, pic.width, pic.height, Number(pl.zoom ?? 1), Number(pl.x ?? 0.5), Number(pl.y ?? 0.5), Number(pl.angle ?? 0), H.placeCode(pl.place)];
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

export { CompileError };
