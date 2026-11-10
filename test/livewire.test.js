import { suite, test, eq } from './harness.js';
import { costMap, shortestPaths, pathTo, snap, floodFill, coolPath } from '../demo/livewire.js';

// A dark disc on a light, slightly noisy background: the one shape every tool must find.
const W = 240, H = 200, CX = 120, CY = 100, R = 60;
const rgba = new Uint8ClampedArray(W * H * 4);
let seed = 7;
const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % 21) - 10; };
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const inside = Math.hypot(x - CX, y - CY) < R;
        const v = (inside ? 60 : 200) + noise();
        rgba.set([v, v, v, 255], (y * W + x) * 4);
    }
}
const cost = costMap(rgba, W, H);
const onCircle = (angle) => [Math.round(CX + R * Math.cos(angle)), Math.round(CY + R * Math.sin(angle))];

suite('livewire: intelligent scissors', () => {
    test('the cost is low on the edge and high on flat colour', () => {
        const edge = cost[CY * W + (CX + R)], flat = cost[CY * W + CX], outside = cost[10 * W + 10];
        if (!(edge < 40 && flat > 150 && outside > 150)) throw new Error(`edge ${edge}, inside ${flat}, outside ${outside}`);
    });
    test('the cheapest path between two points on the edge follows the edge', () => {
        const [ax, ay] = onCircle(0), [bx, by] = onCircle(-Math.PI / 2);
        const tree = shortestPaths(cost, W, H, ay * W + ax);
        const path = pathTo(tree, by * W + bx);
        if (!path) throw new Error('no path');
        let off = 0;
        for (const p of path) if (Math.abs(Math.hypot(p % W - CX, Math.floor(p / W) - CY) - R) > 2.5) off++;
        if (off > path.length * 0.05) throw new Error(`${off} of ${path.length} path pixels leave the edge`);
        if (path.length < R * 1.4) throw new Error(`path of ${path.length} pixels cut across the disc (the arc is ~${Math.round(R * Math.PI / 2)})`);
        eq(path[0], ay * W + ax);
        eq(path[path.length - 1], by * W + bx);
    });
    test('a point placed near the edge snaps onto it', () => {
        const [x, y] = snap(cost, W, H, CX + R + 4, CY + 3, 6);
        const d = Math.hypot(x - CX, y - CY);
        if (Math.abs(d - R) > 1.5) throw new Error(`snapped to distance ${d.toFixed(1)}, radius ${R}`);
    });
    test('the colour fill takes the disc and nothing else', () => {
        const mask = floodFill(rgba, W, H, [[CX, CY]], 0.15);
        let n = 0;
        for (let i = 0; i < mask.length; i++) n += mask[i];
        const expected = Math.PI * R * R;
        if (Math.abs(n - expected) > expected * 0.04) throw new Error(`filled ${n} pixels, the disc has ~${Math.round(expected)}`);
        eq(mask[10 * W + 10], 0);
    });
    test('several colours: the fill grows through any of them; "anywhere" takes every match', () => {
        // a two-tone shape: the disc plus a red square touching it on the right, and a red island far away
        const two = rgba.slice();
        const paint = (x0, y0, x1, y1, [r, g, b]) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) two.set([r, g, b, 255], (y * W + x) * 4); };
        paint(CX + R - 2, CY - 20, CX + R + 40, CY + 20, [200, 40, 40]);
        paint(10, 10, 30, 30, [200, 40, 40]);
        const count = (m) => m.reduce((a, b) => a + b, 0);
        const disc = count(floodFill(two, W, H, [[CX, CY]], 0.15));
        const both = floodFill(two, W, H, [[CX, CY], [CX + R + 20, CY]], 0.15);
        eq(both[(CY) * W + CX + R + 20], 1);                                   // the square
        eq(both[20 * W + 20], 0);                                              // not the island: it touches nothing selected
        if (count(both) < disc + 40 * 40 * 0.9) throw new Error(`disc ${disc}, with the square ${count(both)}`);
        const anywhere = floodFill(two, W, H, [[CX, CY], [CX + R + 20, CY]], 0.15, { contiguous: false });
        eq(anywhere[20 * W + 20], 1);
        const named = floodFill(two, W, H, [[CX, CY]], 0.15, { colours: [[200, 40, 40]] });   // the seed's colour isn't in the set: nothing grows from it
        eq(count(named), 0);
    });
    test('path cooling freezes a stretch that stayed put, never near the cursor', () => {
        const wire = (n) => Int32Array.from({ length: n }, (_, i) => i);      // pixel ids along a path
        let rec = null, frozen = -1;
        for (let step = 0; step < 20 && frozen < 0; step++) {                    // the cursor moves on, the first 100 pixels stay
            const path = wire(100 + step * 5);
            ({ record: rec, freeze: frozen } = coolPath(rec, path, step * 50));
        }
        if (frozen < 25 || frozen >= 100 + 19 * 5 - 40) throw new Error(`froze at ${frozen}`);
        // a wire that keeps changing near its start never cools
        rec = null; frozen = -1;
        for (let step = 0; step < 30; step++) {
            const path = wire(150); path[5] = 1000 + step;
            ({ record: rec, freeze: frozen } = coolPath(rec, path, step * 50));
        }
        eq(frozen, -1);
        // nor does one that is stable but too short for the margin
        rec = null;
        for (let step = 0; step < 30; step++) ({ record: rec, freeze: frozen } = coolPath(rec, wire(60), step * 50));
        eq(frozen, -1);
    });
    test('a 480 × 360 search is fast enough to run on every click', () => {
        const w = 480, h = 360, big = new Uint16Array(w * h).fill(200);
        const t0 = performance.now();
        shortestPaths(big, w, h, (h / 2) * w + w / 2);
        const ms = performance.now() - t0;
        if (ms > 400) throw new Error(`${ms.toFixed(0)} ms`);       // typically 30–60 ms; the limit is only a tripwire for a regression
    });
});

import { refineMask } from '../demo/livewire.js';

suite('the refine brush', () => {
    const inDisc = (i) => Math.hypot(i % W - CX, Math.floor(i / W) - CY) < R;
    const count = (m) => m.reduce((a, b) => a + b, 0);
    const disc = () => Uint8Array.from({ length: W * H }, (_, i) => (inDisc(i) ? 1 : 0));
    const strokeAt = (points, r) => {
        const s = new Uint8Array(W * H);
        for (const [x, y] of points) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) s[(y + dy) * W + x + dx] = 1;
        return s;
    };
    test('"inside" over a missing part fills it up to the object\'s edge, no further', () => {
        const mask = disc();
        for (let i = 0; i < mask.length; i++) if (i % W > CX + 20) mask[i] = 0;            // the right side of the disc is missing
        const stroke = strokeAt([[CX + 30, CY - 10], [CX + 35, CY], [CX + 30, CY + 10]], 3);
        const out = refineMask(rgba, W, H, mask, stroke, true, 30);
        let missed = 0, spilled = 0;
        for (let i = 0; i < out.length; i++) {
            const near = Math.abs(i % W - (CX + 35)) < 25 && Math.abs(Math.floor(i / W) - CY) < 25;
            if (!near) continue;
            if (inDisc(i) && !out[i]) missed++;
            if (!inDisc(i) && out[i] && Math.hypot(i % W - CX, Math.floor(i / W) - CY) > R + 2) spilled++;
        }
        if (missed > 40 || spilled > 40) throw new Error(`near the stroke: ${missed} disc pixels missed, ${spilled} outside it taken`);
        // far from the stroke, nothing changed
        eq(out[(CY + 50) * W + CX + 30], mask[(CY + 50) * W + CX + 30]);
    });
    test('"outside" over a leak takes it away, back to the edge', () => {
        const mask = disc();
        for (let y = CY - 15; y < CY + 15; y++) for (let x = CX + R; x < CX + R + 30; x++) mask[y * W + x] = 1;   // a leak to the right
        const out = refineMask(rgba, W, H, mask, strokeAt([[CX + R + 15, CY]], 4), false, 25);
        let leak = 0;
        for (let y = CY - 15; y < CY + 15; y++) for (let x = CX + R + 3; x < CX + R + 30; x++) leak += out[y * W + x];
        if (leak > 20) throw new Error(`${leak} pixels of the leak left`);
        if (count(out) < count(disc()) * 0.97) throw new Error('the disc itself was cut');
    });
    test('with nothing selected, an inside stroke selects the object round it, however small the stroke', () => {
        const out = refineMask(rgba, W, H, new Uint8Array(W * H), strokeAt([[CX, CY]], 4), true, 10);
        const got = count(out), want = Math.PI * R * R;
        if (Math.abs(got - want) > want * 0.08) throw new Error(`${got} pixels, the disc has ~${Math.round(want)}`);
    });
});
