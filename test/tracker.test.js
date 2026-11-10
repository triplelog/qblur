import { suite, test, eq } from './harness.js';
import { createTracker, trackStep, boundedPath, resample, area, toGray, fillPolygon, frameData, colourModel, probabilityMap, contrast } from '../demo/tracker.js';
import { costFromGray } from '../demo/livewire.js';

// A dark disc that moves right 2.5 px a frame and grows a little, over a textured, noisy background.
const W = 240, H = 160, FRAMES = 30;
const disc = (k) => ({ cx: 60 + 2.5 * k, cy: 80 + 0.8 * k, r: 28 + 0.2 * k });
function frame(k, { hidden = false } = {}) {
    const g = new Uint8Array(W * H);
    let seed = k * 7919 + 1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const { cx, cy, r } = disc(k);
        const inside = !hidden && Math.hypot(x - cx, y - cy) < r;
        const texture = 20 * Math.sin(x / 7) * Math.sin(y / 5);
        g[y * W + x] = Math.max(0, Math.min(255, (inside ? 60 : 190) + texture + (seed % 15) - 7));
    }
    return g;
}
const circle = (k, n = 64) => { const { cx, cy, r } = disc(k); return Array.from({ length: n }, (_, i) => [cx + r * Math.cos(i / n * 2 * Math.PI), cy + r * Math.sin(i / n * 2 * Math.PI)]); };
/** The centre of the area an outline encloses (its corner points are spaced unevenly, so not their mean). */
const centre = (loop) => {
    let a = 0, x = 0, y = 0;
    for (let i = 0; i < loop.length; i++) {
        const [x0, y0] = loop[i], [x1, y1] = loop[(i + 1) % loop.length], c = x0 * y1 - x1 * y0;
        a += c; x += (x0 + x1) * c; y += (y0 + y1) * c;
    }
    return [x / (3 * a), y / (3 * a)];
};

const frames = Array.from({ length: FRAMES }, (_, k) => frame(k, { hidden: k === 20 }));   // frame 20: the object vanishes
const rgba = (g) => { const out = new Uint8ClampedArray(g.length * 4); for (let i = 0; i < g.length; i++) out.set([g[i], g[i], g[i], 255], i * 4); return out; };
const tracker = createTracker({ frames: FRAMES, w: W, h: H, getFrame: async (k) => rgba(frames[k]) });
await tracker.setKeyframe(0, circle(0));
const t0 = performance.now();
await tracker.track();
const ms = (performance.now() - t0) / (FRAMES - 1);
const flagged = tracker.flagged();
// a second keyframe after the gap
const second = createTracker({ frames: FRAMES, w: W, h: H, getFrame: async (k) => rgba(frames[k]) });
await second.setKeyframe(0, circle(0));
await second.setKeyframe(29, circle(29));
await second.track();

suite('the tracker', () => {
    test('the outline follows a moving, growing disc', () => {
        for (const k of [5, 10, 15, 19]) {
            const r = tracker.results[k];
            const [x, y] = centre(r.loop), d = disc(k);
            if (Math.hypot(x - d.cx, y - d.cy) > 2.5) throw new Error(`frame ${k}: centre ${x.toFixed(1)}, ${y.toFixed(1)}, the disc is at ${d.cx}, ${d.cy}`);
            const a = area(r.loop), want = Math.PI * d.r * d.r;
            if (Math.abs(a - want) > want * 0.1) throw new Error(`frame ${k}: area ${a.toFixed(0)}, the disc's ${want.toFixed(0)}`);
        }
        if (ms > 150) throw new Error(`${ms.toFixed(0)} ms a frame`);
    });
    test('a frame where the object vanishes is flagged', () => {
        if (!flagged.includes(20)) throw new Error(`flagged: ${flagged}`);
        if (flagged.some((k) => k < 19)) throw new Error(`frames before the gap flagged: ${flagged}`);
    });
    test('a keyframe on the other side repairs the frames after the gap', () => {
        for (const k of [22, 26]) {
            const [x, y] = centre(second.results[k].loop), d = disc(k);
            if (Math.hypot(x - d.cx, y - d.cy) > 3) throw new Error(`frame ${k}: centre ${x.toFixed(1)}, ${y.toFixed(1)} (${second.results[k].from}), the disc is at ${d.cx}, ${d.cy}`);
        }
        eq(second.results[26].from, 'backward');
    });
    test('pieces: resampling, a bounded edge path, area, grey', () => {
        eq(resample([[0, 0], [10, 0], [10, 10], [0, 10]], 4).map((p) => p.map(Math.round)), [[0, 0], [10, 0], [10, 10], [0, 10]]);
        eq(Math.round(area([[0, 0], [10, 0], [10, 10], [0, 10]])), 100);
        const cost = costFromGray(Float32Array.from(frames[0]), W, H);
        const path = boundedPath(cost, W, H, 80 * W + 32, 52 * W + 60);        // a quarter of the disc's edge, left to top
        for (const [x, y] of path) if (Math.abs(Math.hypot(x - 60, y - 80) - 28) > 3) throw new Error(`the path leaves the edge at ${x}, ${y}`);
        eq([...toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), 2, 1)], [255, 0]);
        eq(typeof trackStep, 'function');
    });
});

suite('the tracker: colours', () => {
    test('the inside of an outline, and a colour model that tells the object from what surrounds it', () => {
        const sq = fillPolygon([[2, 2], [8, 2], [8, 8], [2, 8]], 12, 12);
        eq(sq.reduce((a, b) => a + b, 0), 36);
        // a red square on a striped green and white background
        const w = 60, h = 60, rgba = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(x > 20 && x < 40 && y > 20 && y < 40 ? [210, 30, 30, 255] : (x >> 2) % 2 ? [40, 160, 60, 255] : [240, 240, 240, 255], (y * w + x) * 4);
        const { bins } = frameData(rgba, w, h);
        const loop = [[21, 21], [39, 21], [39, 39], [21, 39]];
        const prob = probabilityMap(bins, colourModel(bins, loop, w, h), w, h);
        if (!(prob[30 * w + 30] > 0.9 && prob[5 * w + 5] < 0.1)) throw new Error(`inside ${prob[30 * w + 30]}, outside ${prob[5 * w + 5]}`);
        const right = contrast(prob, loop, w, h), leaking = contrast(prob, [[10, 21], [39, 21], [39, 39], [10, 39]], w, h);
        if (!(right > 0.8 && leaking < right * 0.8)) throw new Error(`contrast ${right.toFixed(2)}, leaking ${leaking.toFixed(2)}`);
    });
});
