import { suite, test, eq, throws } from './harness.js';
import { normalizeStrokes, strokeTimeline, rasterizeStrokes, traceContours, compileFilter, normalizeGraphic, validateFilter } from '../src/index.js';

const W = 200, H = 100;
const line = (x0, y0, x1, y1, ms = 1000, p = 1) => ({ points: [[x0, y0, 0, p], [x1, y1, ms, p]] });
const spec = (extra) => normalizeStrokes('brush', { strokes: [line(0.1, 0.5, 0.9, 0.5), line(0.5, 0.1, 0.5, 0.9)], ...extra });
const px = (r, x, y) => [...r.data.slice((y * W + x) * 4, (y * W + x) * 4 + 4)];

suite('brush strokes', () => {
    test('the channels: coverage, age, passes, progress', () => {
        const r = rasterizeStrokes(spec(), W, H);
        eq(px(r, 10, 10), [0, 0, 0, 0]);
        const once = px(r, 40, 50), twice = px(r, 100, 50);
        eq([once[3], once[1]], [255, 64]);                          // painted, one pass
        eq([twice[3], twice[1]], [255, 128]);                       // where they cross: two passes
        if (!(twice[2] > once[2])) throw new Error('the second stroke should be further through the drawing');
        if (!(once[0] > 200)) throw new Error('the first stroke should be old at the end');
    });
    test('timing: as recorded, by length, per stroke, with gap, start and fit', () => {
        eq(Math.round(strokeTimeline(spec(), 2).total), 30 + 6 + 30);                    // 1 s each at 30 fps, a 6-frame gap
        eq(Math.round(strokeTimeline(spec({ speed: 2 }), 2).total), 15 + 6 + 15);
        eq(Math.round(strokeTimeline(spec({ timing: 'per-stroke', gap: 0 }), 2).total), 40);
        eq(Math.round(strokeTimeline(spec({ timing: 'even', gap: 0 }), 2).total), Math.round((1.6 + 0.8) * 30));   // lengths in frame heights
        const fitted = strokeTimeline(spec({ start: 10, fit: 90 }), 2);
        eq([fitted.strokes[0].start, Math.round(fitted.total)], [10, 100]);
    });
    test('only what is painted by frame t shows, growing along the stroke', () => {
        const r = rasterizeStrokes(spec(), W, H, 15);
        eq(px(r, 40, 50)[3], 255);                                  // the first half of the first stroke
        eq(px(r, 160, 50)[3], 0);                                   // not yet
        eq(px(r, 100, 20)[3], 0);                                   // the second stroke hasn't started
        eq(rasterizeStrokes(spec({ start: 50 }), W, H, 40).data.some((v) => v), false);
    });
    test('a mask keeps the paint inside or outside it', () => {
        const mask = new Float32Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < 100; x++) mask[y * W + x] = 1;      // the left half
        eq(px(rasterizeStrokes(spec({ clip: 'inside' }), W, H, Infinity, { mask }), 160, 50)[3], 0);
        eq(px(rasterizeStrokes(spec({ clip: 'inside' }), W, H, Infinity, { mask }), 40, 50)[3], 255);
        eq(px(rasterizeStrokes(spec({ clip: 'outside' }), W, H, Infinity, { mask }), 40, 50)[3], 0);
    });
    test('brushes differ; build-up accumulates; pressure narrows', () => {
        const cover = (extra) => rasterizeStrokes(spec(extra), W, H).data.filter((v, i) => i % 4 === 3 && v > 0).length;
        const counts = ['round', 'soft', 'marker', 'chalk', 'spray'].map((brush) => cover({ brush, size: 0.1 }));
        if (new Set(counts).size < 4) throw new Error(`brushes look alike: ${counts}`);
        const soft = (buildUp) => px(rasterizeStrokes(spec({ brush: 'soft', size: 0.2, flow: 0.5, buildUp }), W, H), 100, 50)[3];
        if (!(soft(true) > soft(false))) throw new Error('build-up should add where strokes cross');
        const light = normalizeStrokes('b', { strokes: [line(0.1, 0.5, 0.9, 0.5, 1000, 0.1)], size: 0.2 });
        if (!(cover({ size: 0.2 }) > rasterizeStrokes(light, W, H).data.filter((v, i) => i % 4 === 3 && v > 0).length)) throw new Error('light pressure should be thinner');
    });
    test('outlines of a mask, for drawing round a selection', () => {
        const mask = new Float32Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) mask[y * W + x] = Math.hypot(x - 60, y - 50) < 30 || (x > 120 && x < 180 && y > 20 && y < 80) ? 1 : 0;
        const loops = traceContours(mask, W, H);
        eq(loops.length, 2);
        for (const [x, y] of loops[0]) if (Math.abs(Math.hypot(x - 60, y - 50) - 30) > 1.5) throw new Error(`off the disc's edge: ${x}, ${y}`);
        eq(loops[1].length, 5);                                     // a rectangle: four corners and back
    });
    test('a strokes graphic in a filter; its settings checked', () => {
        const c = compileFilter({ graphics: { brush: { type: 'strokes', strokes: [line(0.1, 0.1, 0.5, 0.5)] } }, color: 'mix(rgb, gaussian(2 + 3 min(4 green(brush), 3)), alpha(brush))' });
        eq(c.passes[0].images, ['brush']);
        eq(c.graphics.brush.strokes[0].points.length, 2);
        throws(() => normalizeGraphic('b', { type: 'strokes', brush: 'crayon' }), /"brush" is round, soft, marker, chalk, spray/);
        throws(() => normalizeGraphic('b', { type: 'strokes', strokes: [{ points: [[0, 'x']] }] }), /point 1/);
        eq(validateFilter({ graphics: { brush: { type: 'strokes', timing: 'even' } }, color: 'alpha(brush)' }), []);
    });
});
