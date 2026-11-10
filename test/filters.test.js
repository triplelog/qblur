import { suite, test, eq, throws } from './harness.js';
import {
    normalizeFilter, validateFilter, compileFilter, filterParams, filterImages, filterToJSON, filterFromJSON,
    filterToLink, filterFromLink, readFilter, FILTER_FORMAT, PLACEMENT,
} from '../src/index.js';
import { filterShader, GLSL_HELPERS } from 'mathzetta/glsl';

const has = (text, part) => { if (!text.includes(part)) throw new Error(`missing ${JSON.stringify(part)} in:\n${text}`); };
const lacks = (text, part) => { if (text.includes(part)) throw new Error(`unexpected ${JSON.stringify(part)}`); };

const threshold = { name: 'Threshold', author: 'Ada', params: { cutoff: 0.5 }, color: 'if gray > cutoff then 1 else 0' };
const vignette = { name: 'Vignette', author: 'MathZetta', params: { strength: { default: 1.6, min: 0, max: 4 } }, color: 'rgb * (1 - strength ((x - 0.5)^2 + (y - 0.5)^2))' };
const tint = { name: 'Tint', author: 'Cy', params: { tint: [1, 0.8, 0.6] }, color: 'rgb * tint' };
const oldFilm = { name: 'Old film', author: 'Bo', steps: [{ filter: threshold, with: { cutoff: 0.3 } }, vignette] };

suite('filter format', () => {
    test('an expression is a filter', () => {
        eq(normalizeFilter('gray'), { format: FILTER_FORMAT, color: 'gray' });
    });
    test('params get a type and a range', () => {
        const f = normalizeFilter({ params: { k: 0.5, big: 30, down: -2, c1: [1, 0, 0], full: { default: 2, min: 1, max: 3, step: 1, label: 'Full' } }, color: 'k' });
        eq(f.params.k, { type: 'number', default: 0.5, min: 0, max: 1 });
        eq(f.params.big, { type: 'number', default: 30, min: 0, max: 60 });
        eq(f.params.down, { type: 'number', default: -2, min: -4, max: 1 });
        eq(f.params.c1, { type: 'color', default: [1, 0, 0] });
        eq(f.params.full, { type: 'number', default: 2, min: 1, max: 3, step: 1, label: 'Full' });
    });
    test('steps get their defaults', () => {
        const f = normalizeFilter({ steps: ['gray', { filter: threshold, with: { cutoff: 0.2 }, opacity: 0.5 }, { ...vignette, opacity: 0.25 }] });
        eq(f.steps[0], { filter: { format: FILTER_FORMAT, color: 'gray' }, with: {}, opacity: 1, skip: false });
        eq(f.steps[1].with, { cutoff: 0.2 });
        eq(f.steps[1].opacity, 0.5);
        eq(f.steps[2].filter.name, 'Vignette');
        eq(f.steps[2].opacity, 0.25);
    });
    test('bad shapes are refused with a reason', () => {
        throws(() => normalizeFilter({}), /needs "color"/);
        throws(() => normalizeFilter({ color: 'x', steps: ['y'] }), /either "color" or "steps"/);
        throws(() => normalizeFilter({ steps: [] }), /at least one step/);
        throws(() => normalizeFilter({ format: 'other/9', color: 'x' }), /Unknown filter format/);
        throws(() => normalizeFilter({ color: { q: 'x' } }), /not "q"/);
        throws(() => normalizeFilter({ params: { gray: 1 }, color: 'x' }), /already defined/);
        throws(() => normalizeFilter({ params: { 'bad name': 1 }, color: 'x' }), /letters, digits/);
        throws(() => normalizeFilter({ params: { k: { default: 5, max: 2 } }, color: 'k' }), /outside/);
        throws(() => normalizeFilter({ steps: [{ filter: 'x', opacity: 2 }] }), /0 to 1/);
    });
    test('every parameter in a chain, first one wins', () => {
        const names = Object.keys(filterParams(normalizeFilter({ steps: [oldFilm, tint, { filter: threshold, with: { cutoff: 0.9 } }] })));
        eq(names, ['cutoff', 'strength', 'tint']);
    });
});

suite('filter validation', () => {
    test('a filter that will compile has no problems', () => eq(validateFilter(oldFilm), []));
    test('problems say which filter', () => {
        const problems = validateFilter({ steps: [{ filter: threshold, with: { nope: 1 } }, { name: 'Broken', color: '2 +' }, { filter: tint, with: { tint: 3 } }] });
        eq(problems.length, 3);
        has(problems[0], '"Threshold": "with" sets "nope"');
        has(problems[1], '"Broken": ');
        has(problems[2], '"Tint": "tint" should be a colour');
        has(validateFilter({ steps: ['gray', 'x +'] })[0], 'step 2: ');
    });
    test('compileFilter throws the problems', () => throws(() => compileFilter({ color: 'sin(' }), /the filter: /));
});

suite('filter compiling', () => {
    test('one filter is one pass with uniforms and a blend', () => {
        const { passes, credits } = compileFilter(threshold);
        eq(passes.length, 1);
        has(passes[0].fragment, 'uniform float cutoff;');
        has(passes[0].fragment, 'uniform float mz_opacity;');
        has(passes[0].fragment, 'color = mz_rgba((gray > cutoff ? 1.0 : 0.0));');
        has(passes[0].fragment, 'color = mix(c, color, mz_opacity);');
        eq(passes[0].values, { cutoff: 0.5 });
        eq(passes[0].opacity, 1);
        eq(credits, []);                                  // the filter itself is not a credit
    });
    test('a parameter next to a bracket is a product, not a call', () => {
        has(compileFilter(vignette).passes[0].fragment, 'rgb * (1.0 - strength * (mz_sq(x - 0.5) + mz_sq(y - 0.5)))');
    });
    test('colour parameters are vec3 uniforms', () => {
        const [pass] = compileFilter(tint).passes;
        has(pass.fragment, 'uniform vec3 tint;');
        has(pass.fragment, 'mz_rgba(rgb * tint)');
        eq(pass.values, { tint: [1, 0.8, 0.6] });
    });
    test('a chain is its passes in order, with settings and credits', () => {
        const { passes, credits } = compileFilter(oldFilm);
        eq(passes.map((p) => p.name), ['Threshold', 'Vignette']);
        eq(passes.map((p) => p.path), [[0], [1]]);
        eq(passes[0].values, { cutoff: 0.3 });
        eq(credits, [{ name: 'Threshold', author: 'Ada' }, { name: 'Vignette', author: 'MathZetta' }]);
    });
    test('outer settings win over inner ones', () => {
        const { passes } = compileFilter({ steps: [{ filter: oldFilm, with: { cutoff: 0.8, strength: 1 } }] });
        eq(passes[0].values, { cutoff: 0.8 });
        eq(passes[1].values, { strength: 1 });
    });
    test('a chain at partial opacity keeps its input and blends at the end', () => {
        const { passes } = compileFilter({ steps: [{ filter: oldFilm, opacity: 0.5 }, 'rgb * 0.9'] });
        eq(passes.map((p) => p.name), ['Threshold', 'Vignette', 'blend', '']);
        eq(passes[0].keepInput, 1);
        eq(passes[2].blendKept, true);
        eq(passes[2].opacity, 0.5);
        has(passes[2].fragment, 'mix(texture2D(base, uv), texture2D(image, uv), mz_opacity)');
        eq(passes[2].path, [0]);
    });
    test('a one-pass chain at partial opacity just fades more', () => {
        const { passes } = compileFilter({ steps: [{ filter: { steps: [{ filter: threshold, opacity: 0.5 }] }, opacity: 0.5 }] });
        eq(passes.length, 1);
        eq(passes[0].opacity, 0.25);
    });
    test('credits are not repeated, and a nested chain is credited too', () => {
        eq(compileFilter({ steps: [threshold, threshold, oldFilm] }).credits.map((c) => c.name), ['Threshold', 'Old film', 'Vignette']);
    });
    test('GLSL ES 3.0 throughout', () => {
        const { passes, version } = compileFilter({ steps: [{ filter: oldFilm, opacity: 0.5 }, 'gray'] }, { version: 300 });
        eq(version, 300);
        for (const pass of passes) { has(pass.fragment, '#version 300 es'); lacks(pass.fragment, 'texture2D'); }
    });
});

suite('filters passed around', () => {
    test('JSON leaves defaults out and keeps a bare expression bare', () => {
        const json = filterToJSON({ name: 'Mine', steps: [{ filter: oldFilm, opacity: 0.5 }, 'rgb * 0.9'] });
        const parsed = JSON.parse(json);
        eq(parsed.format, FILTER_FORMAT);
        eq(parsed.steps[1], 'rgb * 0.9');
        eq(parsed.steps[0].opacity, 0.5);
        eq(parsed.steps[0].filter.steps[0].with, { cutoff: 0.3 });
        lacks(json, '"opacity": 1');
        lacks(json, '"with": {}');
        eq((json.match(/"format"/g) || []).length, 1);
        eq(filterFromJSON(json), normalizeFilter({ name: 'Mine', steps: [{ filter: oldFilm, opacity: 0.5 }, 'rgb * 0.9'] }));
    });
    test('links round-trip, with any page in front', () => {
        const link = filterToLink(oldFilm, 'https://example.org/filters.html');
        if (!link.startsWith('https://example.org/filters.html#')) throw new Error(link);
        if (/[^A-Za-z0-9_#:/.-]/.test(link)) throw new Error('not URL-safe: ' + link);
        eq(filterFromLink(link), normalizeFilter(oldFilm));
        eq(filterFromLink(link.split('#')[1]), normalizeFilter(oldFilm));
        eq(filterFromLink(filterToLink({ name: 'Ünïcode ✓', color: 'π r' })).name, 'Ünïcode ✓');
        throws(() => filterFromLink('#nonsense'), /Not a filter link/);
        throws(() => filterFromJSON('{oops'), /Not valid JSON/);
    });
    test('readFilter takes JSON, a link or an expression', () => {
        eq(readFilter(filterToJSON(tint)).name, 'Tint');
        eq(readFilter(filterToLink(tint, 'x.html')).name, 'Tint');
        eq(readFilter('  gray > 0.5 '), { format: FILTER_FORMAT, color: 'gray > 0.5' });
        eq(readFilter('unchanged').color, 'unchanged');       // long enough to look like a link, but isn't one
        throws(() => readFilter('   '), /Nothing/);
    });
});

suite('filterShader options', () => {
    test('values are never calls; uniforms are declared', () => {
        const shader = filterShader('k (1 - r)', { values: ['k'], uniforms: { k: 'float' } });
        has(shader, 'uniform float k;');
        has(shader, 'mz_rgba(k * (1.0 - r))');
        lacks(shader, 'mz_opacity');
    });
});

suite('filters with several pictures', () => {
    const through = { name: 'Through a mask', images: { mask: { description: 'light where the effect shows' } }, color: 'mix(source, rgb, luma(mask))' };
    const multiply = { name: 'Multiply', images: ['overlay'], color: 'rgb * overlay' };
    test('images normalize from a list or an object', () => {
        eq(normalizeFilter(multiply).images, { overlay: {} });
        eq(normalizeFilter(through).images, { mask: { description: 'light where the effect shows' } });
        throws(() => normalizeFilter({ images: ['source'], color: 'rgb' }), /always available/);
        throws(() => normalizeFilter({ images: ['gray'], color: 'rgb' }), /already defined/);
        throws(() => normalizeFilter({ params: { k: 1 }, images: ['k'], color: 'rgb' }), /both a parameter and an image/);
        throws(() => normalizeFilter({ images: ['mz_x'], color: 'rgb' }), /letters, digits/);
    });
    test('a picture is a colour, a function, and a channel source', () => {
        const [pass] = compileFilter(through).passes;
        has(pass.fragment, 'uniform sampler2D mz_img_mask;');
        has(pass.fragment, 'uniform sampler2D mz_img_source;');
        has(pass.fragment, 'vec3 mz_at_mask(float px, float py)');
        has(pass.fragment, 'vec3 mask = mz_px_mask.rgb;');
        has(pass.fragment, 'mz_rgba(mix(source, rgb, luma(mz_px_mask)))');
        eq(pass.images, ['mask', 'source']);
        has(compileFilter({ images: ['bg'], color: 'mix(rgb, bg(px + 4, py), alpha(bg))' }).passes[0].fragment, 'mix(rgb, mz_at_bg(px + 4.0, py), alpha(mz_px_bg))');
    });
    test('source is only declared when used', () => {
        const [pass] = compileFilter(multiply).passes;
        lacks(pass.fragment, 'mz_img_source');
        eq(pass.images, ['overlay']);
    });
    test('a chain lists every picture it needs', () => {
        const compiled = compileFilter({ steps: ['gaussian(2)', through, multiply, through] });
        eq(Object.keys(compiled.images), ['mask', 'overlay']);
        eq(compiled.images.mask.description, 'light where the effect shows');
        eq(compiled.passes.map((p) => p.images), [[], [], ['mask', 'source'], ['overlay'], ['mask', 'source']]);   // gaussian(2) alone is two passes
        eq(Object.keys(filterImages(normalizeFilter(multiply))), ['overlay']);
    });
    test('images survive JSON', () => {
        eq(filterFromJSON(filterToJSON(through)).images, { mask: { description: 'light where the effect shows' } });
    });
});

suite('geometry and placement', () => {
    test('geometry functions read the picture from elsewhere', () => {
        has(filterShader('zoom(2)'), 'mz_rgba(mz_sample_image(mz_zoom(2.0)))');        // alone: with its alpha, transparent outside
        has(filterShader('zoom(2) * 0.5'), 'mz_rgba(mz_at_image(mz_zoom(2.0)) * 0.5)');
        has(filterShader('zoom(1 + 0.002 t, 0.5, 0.4)'), 'mz_sample_image(mz_zoom(1.0 + 0.002 * t, 0.5, 0.4))');
        has(filterShader('tile(3)'), 'vec2 mz_tile(float n)');
        has(filterShader('rotate(30°)'), 'mz_sample_image(mz_rotate(radians(30.0)))');
        lacks(filterShader('gray'), 'mz_at_image');
    });
    test('…and another picture', () => {
        const shader = filterShader('mix(rgb, shift(overlay, 2 t, 0), 0.5) + width(overlay) / width()', { images: ['overlay'] });
        has(shader, 'mz_at_overlay(mz_shift(2.0 * t, 0.0))');
        has(shader, 'mz_width_overlay() / w');
        has(shader, 'uniform vec2 mz_size_overlay;');
        has(shader, 'uniform vec4 mz_place_overlay;');
    });
    test('placement is declared, defaulted, and overridden by the chain', () => {
        const inset = { name: 'Inset', images: { inset: { place: 'fit', zoom: 0.35, x: 0.8, y: 0.8 } }, color: 'mix(rgb, inset, alpha(inset))' };
        eq(normalizeFilter(inset).images.inset, { place: 'fit', zoom: 0.35, x: 0.8, y: 0.8 });
        const [pass] = compileFilter(inset).passes;
        eq(pass.placements.inset, { place: 'fit', zoom: 0.35, x: 0.8, y: 0.8, angle: 0 });
        has(pass.fragment, 'vec2 scale = vec2(min(resolution.x / size.x, resolution.y / size.y)) * mz_place_inset.x;');
        const over = compileFilter({ steps: [{ filter: inset, with: { inset: { x: 0.2, place: 'tile' } } }] }).passes[0];
        eq(over.placements.inset, { place: 'tile', zoom: 0.35, x: 0.2, y: 0.8, angle: 0 });
        has(over.fragment, 'q = mod(q, size);');
        eq(compileFilter({ images: ['bg'], color: 'bg' }).passes[0].placements.bg, PLACEMENT);
    });
    test('bad placement is named', () => {
        throws(() => normalizeFilter({ images: { pic: { place: 'huge' } }, color: 'pic' }), /"place" is cover, fit, stretch, tile/);
        throws(() => normalizeFilter({ images: { pic: { size: 2 } }, color: 'pic' }), /no such setting "size"/);
        has(validateFilter({ steps: [{ filter: { name: 'B', images: ['pic'], color: 'pic' }, with: { pic: { zoom: 'big' } } }] })[0], '"B": Image "pic": "zoom" is a number');
    });
});

suite('filter compiling reports everything, once', () => {
    test('every shader problem is reported, named', () => {
        let message = '';
        try { compileFilter({ steps: [{ name: 'A', color: 'k +' }, { name: 'B', color: 'sin(' }] }); } catch (e) { message = e.message; }
        has(message, '"A": Failed to parse');
        has(message, '"B": Failed to parse');
        throws(() => compileFilter({ steps: [{ filter: { name: 'A', params: { k: 1 }, color: 'k' }, with: { nope: 2 } }] }), /"A": "with" sets "nope"/);
    });
    test('neighbourhood loops stop at the radius asked for', () => {
        const shader = filterShader('blur(2)');
        has(shader, 'float mz_r = min(max(ceil(radius), 0.0), 8.0);');
        has(shader, 'if (fi > mz_r) break;');
    });
    test('random() differs per pixel and per frame', () => {
        has(filterShader('rgb + 0.1 (random() - 0.5)'), 'mz_seed = t;');
        has(GLSL_HELPERS, 'float mz_random() { mz_seed += 1.0;');
    });
});

suite('format stability', () => {
    test('the format name is fixed; links made today open tomorrow', () => eq(FILTER_FORMAT, 'mathzetta-filter/1'));
    test('unknown top-level keys are ignored, so a newer document still opens', () => {
        const f = normalizeFilter({ format: FILTER_FORMAT, name: 'x', color: 'gray', future: { anything: 1 } });
        eq(f.color, 'gray');
        eq('future' in f, false);
    });
    test('another format version is refused with a clear message', () => {
        throws(() => normalizeFilter({ format: 'mathzetta-filter/2', color: 'gray' }), /Unknown filter format/);
    });
});

suite('skipping steps, separable blurs, transparency outside', () => {
    test('a skipped step compiles to nothing and shares as skip: true', () => {
        const chain = { steps: [{ filter: 'gray', skip: true }, '1 - rgb'] };
        const { passes } = compileFilter(chain);
        eq(passes.length, 1);
        eq(passes[0].path, [1]);
        eq(normalizeFilter(chain).steps.map((s) => s.skip), [true, false]);
        eq(JSON.parse(filterToJSON(chain)).steps[0], { filter: 'gray', skip: true });
        eq(JSON.parse(filterToJSON(chain)).steps[1], '1 - rgb');
    });
    test('with every step skipped, the picture passes through', () => {
        const { passes } = compileFilter({ steps: [{ filter: 'gray', skip: true }] });
        eq(passes.length, 1);
        has(passes[0].fragment, 'mz_rgba(pixel(px, py))');
    });
    test('gaussian(s) or blur(r) alone becomes an x pass and a y pass', () => {
        const { passes, credits } = compileFilter({ name: 'Soft', author: 'A', params: { sigma: 2 }, color: 'gaussian(sigma)' });
        eq(passes.length, 2);
        has(passes[0].fragment, 'mz_rgba(gaussianx(sigma))');
        has(passes[1].fragment, 'mz_rgba(gaussiany(sigma))');
        eq(passes.map((p) => p.values), [{ sigma: 2 }, { sigma: 2 }]);
        eq(passes.map((p) => p.path), [[0], [1]]);
        eq(credits, []);
        eq(compileFilter('blur(3)').passes.map((p) => p.color), ['blurx(3)', 'blury(3)']);
        eq(compileFilter({ steps: [{ filter: { params: { sigma: 1 }, color: 'gaussian(sigma)' }, with: { sigma: 4 }, opacity: 0.5 }] }).passes.map((p) => [p.name, p.values.sigma ?? null, p.opacity]), [['', 4, 1], ['', 4, 1], ['blend', null, 0.5]]);
    });
    test('…but not inside an expression, or with other brackets', () => {
        eq(compileFilter('gaussian(2) + 0.1').passes.length, 1);
        eq(compileFilter('gaussian(2) - blur(1)').passes.length, 1);
        eq(compileFilter('rgb - gaussian(2)').passes.length, 1);
    });
    test('a geometry read as the whole colour is transparent outside; alpha() says where the picture is', () => {
        has(compileFilter('zoom(0.5)').passes[0].fragment, 'mz_rgba(mz_sample_image(mz_zoom(0.5)))');
        has(compileFilter('mix(rgb, zoom(0.5), alpha(zoom(0.5)))').passes[0].fragment, 'alpha(mz_sample_image(mz_zoom(0.5)))');
        has(compileFilter({ images: ['inset'], color: 'inset' }).passes[0].fragment, 'mz_rgba(mz_px_inset)');
    });
    test("GLSL's own functions parse as calls", () => {
        has(compileFilter('fract(x * 4)').passes[0].fragment, 'mz_rgba(fract(x * 4.0))');
    });
});

suite('colour spaces', () => {
    test('"space" normalizes, validates and shares', () => {
        eq(normalizeFilter({ space: 'hsv', color: 'rgb' }).space, { in: 'hsv', out: 'hsv' });
        eq(normalizeFilter({ space: { in: 'lab' }, color: 'rgb' }).space, { in: 'lab', out: 'srgb' });
        eq('space' in normalizeFilter({ space: 'srgb', color: 'rgb' }), false);
        throws(() => normalizeFilter({ space: 'cmyk', color: 'rgb' }), /not a colour space/);
        eq(JSON.parse(filterToJSON({ space: 'hsv', color: 'rgb' })).space, 'hsv');
        eq(JSON.parse(filterToJSON({ space: { in: 'lab' }, color: 'rgb' })).space, { in: 'lab', out: 'srgb' });
    });
    test('a filter in a space is convert-in, the filter, convert-out; opacity blends in sRGB', () => {
        const { passes, credits } = compileFilter({ name: 'Hue', author: 'A', space: 'hsv', params: { amount: 0.1 }, color: '(fract(r + amount), g, b)' });
        eq(passes.map((p) => p.color), [{ rgb: 'tohsv(rgb)' }, '(fract(r + amount), g, b)', { rgb: 'fromhsv(rgb)' }]);
        eq(passes.map((p) => p.space), ['srgb', 'hsv', 'srgb']);
        eq(passes[1].values, { amount: 0.1 });
        has(passes[1].fragment, 'float gray = dot(fromhsv(rgb), vec3(0.299, 0.587, 0.114));');
        eq(credits, []);
        const half = compileFilter({ steps: [{ filter: { space: { in: 'lab' }, color: 'rgb' }, opacity: 0.5 }] }).passes;
        eq(half.map((p) => [p.name, p.opacity]), [['', 1], ['', 1], ['blend', 0.5]]);
    });
    test('a blur in linear light is separable too, and pictures are converted as read', () => {
        const { passes } = compileFilter({ space: 'linear', images: ['overlay'], color: 'mix(gaussian(2), overlay, 0.5)' });
        eq(passes.length, 3);
        has(passes[1].fragment, 'vec4 mz_sample_overlay(vec2 p) { vec4 v = mz_raw_overlay(p); v.rgb = tolinear(v.rgb); return v; }');
        eq(compileFilter({ space: 'linear', color: 'gaussian(2)' }).passes.map((p) => p.color), [{ rgb: 'tolinear(rgb)' }, 'gaussianx(2)', 'gaussiany(2)', { rgb: 'fromlinear(rgb)' }]);
    });
    test('conversion functions work in any expression', () => {
        has(compileFilter('fromhsv(fract(red(tohsv(rgb)) + 0.1), green(tohsv(rgb)), blue(tohsv(rgb)))').passes[0].fragment, 'vec3 tohsv(vec3 c)');
    });
});

suite('the selection', () => {
    test('selected binds the selection picture, implicitly, on both engines', () => {
        const [pass] = compileFilter('mix(source, rgb, selected)').passes;
        eq(pass.images, ['source', 'selection']);
        has(pass.fragment, 'float selected = mz_px_selection.r;');
        eq(compileFilter('gray').passes[0].images, []);
        eq(Object.keys(compileFilter('mix(source, rgb, selected)').images), []);     // not something the user has to supply
    });
});

suite('notes and knob inputs', () => {
    test('a knob can be a menu of values or a box to type in', () => {
        const f = normalizeFilter({ params: { n: { options: [2, 4, 8] }, k: { default: 0.3, input: 'box' }, s: { default: 0.5, input: 'slider' } }, color: 'rgb * k' });
        eq(f.params.n, { type: 'number', default: 2, min: 2, max: 8, options: [2, 4, 8] });
        eq(f.params.k, { type: 'number', default: 0.3, min: 0, max: 1, input: 'box' });
        eq(f.params.s, { type: 'number', default: 0.5, min: 0, max: 1 });
        eq(normalizeFilter({ params: { n: { options: ['1', 3], default: 3 } }, color: 'rgb' }).params.n.default, 3);
        throws(() => normalizeFilter({ params: { n: { options: [] } }, color: 'rgb' }), /"options" is a list of numbers/);
        throws(() => normalizeFilter({ params: { n: { options: [1, 'x'] } }, color: 'rgb' }), /"options" is a list of numbers/);
        throws(() => normalizeFilter({ params: { n: { default: 1, input: 'dial' } }, color: 'rgb' }), /"input" is "slider" or "box"/);
    });
    test('notes are Markdown and the places of the knobs', () => {
        const f = normalizeFilter({ params: { cutoff: 0.5 }, notes: ['Darker below $cutoff$:', { param: 'cutoff' }], color: 'if gray > cutoff then 1 else 0' });
        eq(f.notes, ['Darker below $cutoff$:', { param: 'cutoff' }]);
        eq(normalizeFilter({ ...oldFilm, notes: ['Both at once', { param: 'strength' }] }).notes[1], { param: 'strength' });   // a chain places its steps' knobs
        throws(() => normalizeFilter({ notes: [{ param: 'k' }], color: 'rgb' }), /no parameter called that/);
        throws(() => normalizeFilter({ notes: 'text', color: 'rgb' }), /"notes" is a list/);
        throws(() => normalizeFilter({ params: { k: 1 }, notes: [{ param: 'k', x: 1 }], color: 'rgb' }), /Markdown text or \{ "param": name \}/);
    });
    test('notes and inputs travel in links and JSON, and leave the shaders alone', () => {
        const def = { name: 'Posterize', params: { levels: { options: [2, 4, 8], default: 4 }, k: { default: 2, input: 'box' } }, notes: ['How many levels:', { param: 'levels' }, '**k** is typed'], color: 'floor(rgb * levels) / levels * k' };
        eq(filterFromLink(filterToLink(def)), normalizeFilter(def));
        eq(filterFromJSON(filterToJSON({ steps: [def, 'gray'] })).steps[0].filter.notes, def.notes);
        eq(compileFilter(def).passes[0].fragment, compileFilter({ ...def, notes: undefined }).passes[0].fragment);
        eq(validateFilter(def), []);
    });
});
