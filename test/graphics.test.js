import { suite, test, eq, throws } from './harness.js';
import { normalizeGraphic, drawGraphic, layeredExpression, shadowLayerNames, googleFontUrl, googleFontFamily, fontFileFromCss, cssFont, familyFor, compileFilter, normalizeFilter, validateFilter, filterToJSON, filterFromLink, filterToLink } from '../src/index.js';

const has = (text, part) => { if (!text.includes(part)) throw new Error(`missing ${JSON.stringify(part)}`); };

/** A 2D context that records what is drawn. */
function recorder() {
    const calls = [];
    const state = {};
    const ctx = new Proxy(state, {
        get(target, key) {
            if (key in target) return target[key];
            return (...args) => { calls.push([key, ...args]); };
        },
        set(target, key, value) { target[key] = value; calls.push(['set', key, value]); return true; },
    });
    return { ctx, calls };
}

suite('graphics: text and shapes', () => {
    test('a spec gets its defaults; null switches a shadow off', () => {
        const t = normalizeGraphic('title', { text: 'Hi' });
        eq([t.type, t.text, t.align, t.size, t.outline], ['text', 'Hi', 'center', 0.08, null]);
        eq(t.shadow.color, 'rgba(0,0,0,0.6)');
        eq(normalizeGraphic('title', { text: 'Hi', shadow: null }).shadow, null);
        const r = normalizeGraphic('box', { type: 'rect', w: 0.5 });
        eq([r.type, r.w, r.h, r.radius], ['rect', 0.5, 0.18, 0.15]);
        eq('text' in r, false);
    });
    test('bad settings are named', () => {
        throws(() => normalizeGraphic('t', { type: 'star' }), /text, rect, ellipse or strokes/);
        throws(() => normalizeGraphic('t', { colour: 'red' }), /no such setting "colour"/);
        throws(() => normalizeGraphic('t', { color: 'url(evil)' }), /"color" is a colour/);
        throws(() => normalizeGraphic('t', { font: '12px a; } body { x' }), /font family/);
        throws(() => normalizeGraphic('t', { fontUrl: 'http://x.org/a.woff2' }), /https/);
        throws(() => normalizeGraphic('b', { type: 'rect', fontUrl: 'https://x.org/a.woff2' }), /for text/);
        throws(() => normalizeGraphic('t', { text: 'x'.repeat(501) }), /500/);
        eq(normalizeGraphic('t', { fontUrl: 'https://fonts.example/a.woff2' }).fontUrl, 'https://fonts.example/a.woff2');
    });
    test('the font names a loaded font first, sized by the frame', () => {
        const g = normalizeGraphic('t', { font: 'Georgia, serif', size: 0.1, fontUrl: 'https://fonts.example/a.woff2' });
        eq(cssFont(g, 400), `normal bold 40px "${familyFor(g.fontUrl)}", Georgia, serif`);
    });
    test('text is drawn at its place, outline under the fill, each line of several', () => {
        const { ctx, calls } = recorder();
        drawGraphic(ctx, normalizeGraphic('t', { text: 'one\ntwo', x: 0.25, y: 0.5, outline: { color: '#000', width: 0.1 } }), 400, 200);
        eq(calls.find((c) => c[0] === 'translate').slice(1), [100, 100]);
        const draws = calls.filter((c) => c[0] === 'strokeText' || c[0] === 'fillText').map((c) => c.slice(0, 2));
        eq(draws, [['strokeText', 'one'], ['fillText', 'one'], ['strokeText', 'two'], ['fillText', 'two']]);
        eq(calls.find((c) => c[0] === 'set' && c[1] === 'lineWidth')[2], 0.1 * 0.08 * 200);
    });
    test('shapes: a rounded rectangle and an oval, sized by the frame', () => {
        const { ctx, calls } = recorder();
        ctx.roundRect = (...a) => calls.push(['roundRect', ...a]);
        drawGraphic(ctx, normalizeGraphic('b', { type: 'rect', w: 0.5, h: 0.25, radius: 0.2 }), 400, 200);
        eq(calls.find((c) => c[0] === 'roundRect').slice(1), [-100, -25, 200, 50, 10]);
        const oval = recorder();
        drawGraphic(oval.ctx, normalizeGraphic('o', { type: 'ellipse', w: 0.5, h: 0.5 }), 400, 200);
        eq(oval.calls.find((c) => c[0] === 'ellipse').slice(1, 5), [0, 0, 100, 50]);
    });
});

suite('graphics in filters', () => {
    const caption = { name: 'Caption', graphics: { title: { text: 'Hello', y: 0.9 } }, color: 'mix(rgb, title, alpha(title))' };
    test('a graphic is a stretched picture the shader reads; compiled.graphics has it as drawn', () => {
        const c = compileFilter(caption);
        eq(c.passes[0].images, ['title']);
        eq(c.passes[0].placements.title.place, 'stretch');
        has(c.passes[0].fragment, 'uniform sampler2D mz_img_title;');
        has(c.passes[0].fragment, 'mz_rgba(mix(rgb, title, alpha(mz_px_title)))');
        eq(c.graphics.title.text, 'Hello');
        eq(Object.keys(c.images), []);                 // not a picture the user has to supply
    });
    test('a chain changes a graphic with "with"; the change is checked', () => {
        const c = compileFilter({ steps: [{ filter: caption, with: { title: { text: 'Bye', color: '#ffcc00' } } }] });
        eq([c.graphics.title.text, c.graphics.title.color, c.graphics.title.y], ['Bye', '#ffcc00', 0.9]);
        has(validateFilter({ steps: [{ filter: caption, with: { title: { size: 'huge' } } }] })[0], '"Caption": Graphic "title": "size" is a number');
    });
    test('names may not clash, and graphics survive JSON and links', () => {
        throws(() => normalizeFilter({ params: { title: 1 }, graphics: { title: {} }, color: 'rgb' }), /both a graphic/);
        throws(() => normalizeFilter({ graphics: { source: {} }, color: 'rgb' }), /already defined/);
        eq(JSON.parse(filterToJSON(caption)).graphics.title.text, 'Hello');
        eq(filterFromLink(filterToLink(caption)), normalizeFilter(caption));
    });
    test('two steps with a text called title draw two texts', () => {
        const c = compileFilter({ steps: [caption, { filter: caption, with: { title: { text: 'Second' } } }, caption] });
        eq(c.passes.map((p) => p.bind.title), ['title', 'title~2', 'title']);     // the third is the same as the first: one picture
        eq([c.graphics.title.text, c.graphics['title~2'].text], ['Hello', 'Second']);
    });
    test('animated through the maths: shift and zoom read the graphic like any picture', () => {
        has(compileFilter({ graphics: { title: {} }, color: 'mix(rgb, shift(title, 3 t, 0), alpha(shift(title, 3 t, 0)))' }).passes[0].fragment, 'alpha(mz_sample_title(mz_shift(3.0 * t, 0.0)))');
    });
});

suite('shadow layers and fonts', () => {
    const layered = { graphics: { title: { text: 'Hi', shadow: null, shadows: [{ color: '#000', blur: 0.4 }, { color: '#f0f', dx: 0.05 }] } }, color: '' };
    test('each shadow layer is a picture of its own, back to front', () => {
        const g = normalizeGraphic('title', layered.graphics.title);
        eq(shadowLayerNames('title', g), ['title_shadow1', 'title_shadow2']);
        const expr = layeredExpression('title', g);
        eq(expr, 'mix(mix(mix(rgb, title_shadow1, alpha(title_shadow1)), title_shadow2, alpha(title_shadow2)), title, alpha(title))');
        const c = compileFilter({ ...layered, color: expr });
        eq(c.passes[0].images, ['title', 'title_shadow1', 'title_shadow2']);
        eq([c.graphics.title_shadow1.onlyShadow, c.graphics.title_shadow2.onlyShadow], [0, 1]);
        has(c.passes[0].fragment, 'uniform sampler2D mz_img_title_shadow2;');
    });
    test('a layer gets its own maths; a chain may add layers', () => {
        has(compileFilter({ ...layered, color: 'mix(rgb, gaussian(4), alpha(title_shadow1))' }).passes[0].fragment, 'alpha(mz_px_title_shadow1)');
        const added = { steps: [{ filter: { graphics: { title: { text: 'x' } }, color: 'mix(rgb, title_shadow1, alpha(title_shadow1))' }, with: { title: { shadows: [{ blur: 0.2 }] } } }] };
        eq(validateFilter(added), []);
        eq(compileFilter(added).passes[0].images, ['title', 'title_shadow1']);
    });
    test('a layer is drawn alone: the shape far off the frame, its shadow thrown back onto it', () => {
        const { ctx, calls } = recorder();
        const g = { ...normalizeGraphic('title', { text: 'Hi', x: 0.5, y: 0.5, shadows: [{ color: '#f00', blur: 0, dx: 0.1, dy: 0 }] }), onlyShadow: 0 };
        drawGraphic(ctx, g, 400, 200);
        const tx = calls.find((c) => c[0] === 'translate')[1];
        const ox = calls.find((c) => c[0] === 'set' && c[1] === 'shadowOffsetX')[2];
        if (Math.abs(tx + ox - (200 + 0.1 * 0.08 * 200)) > 1e-9) throw new Error(`the shadow lands at ${tx + ox}`);                         // where the shadow lands: the text's place plus its offset
        if (tx > -400) throw new Error('the text itself is on the frame');
        eq(calls.find((c) => c[0] === 'set' && c[1] === 'shadowColor')[2], '#f00');
    });
    test('names: layers may not clash; at most eight', () => {
        throws(() => normalizeFilter({ params: { title_shadow1: 1 }, graphics: { title: {} }, color: 'rgb' }), /shadow layer/);
        throws(() => normalizeGraphic('t', { shadows: Array(9).fill({}) }), /up to 8/);
    });
    test('Google Fonts: a name becomes an address; the stylesheet gives the file of the weight and style', () => {
        const url = googleFontUrl('Playfair Display');
        eq(googleFontFamily(url), 'Playfair Display');
        eq(normalizeGraphic('t', { fontUrl: url }).fontUrl.startsWith('https://fonts.googleapis.com/css2?family=Playfair+Display'), true);
        throws(() => googleFontUrl('x; } body'), /letters, digits and spaces/);
        const css = `/* cyrillic */ @font-face { font-family: 'P'; font-style: normal; font-weight: 400; src: url(https://f.example/cyr-400.woff2) format('woff2'); }
/* latin */ @font-face { font-family: 'P'; font-style: normal; font-weight: 400; src: url(https://f.example/latin-400.woff2) format('woff2'); }
/* latin */ @font-face { font-family: 'P'; font-style: normal; font-weight: 700; src: url(https://f.example/latin-700.woff2) format('woff2'); }
/* latin */ @font-face { font-family: 'P'; font-style: italic; font-weight: 400; src: url(https://f.example/latin-400i.woff2) format('woff2'); }`;
        eq(fontFileFromCss(css, { weight: 'normal', style: 'normal' }), 'https://f.example/latin-400.woff2');
        eq(fontFileFromCss(css, { weight: 'bold', style: 'normal' }), 'https://f.example/latin-700.woff2');
        eq(fontFileFromCss(css, { weight: 'normal', style: 'italic' }), 'https://f.example/latin-400i.woff2');
    });
});
