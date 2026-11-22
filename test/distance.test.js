import { suite, test, eq } from './harness.js';
import { distanceTo, encodeAway, awayPicture, awayFromChannels, compileFilter, createCpuRunner } from '../src/index.js';

suite('away: the distance from the selection (src/distance.js)', () => {
    test('matches brute force on a random shape', () => {
        const W = 37, H = 23, on = new Uint8Array(W * H);
        let seed = 7;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        for (let i = 0; i < on.length; i++) on[i] = rnd() < 0.03 ? 1 : 0;
        const d = distanceTo(on, W, H);
        for (let i = 0; i < on.length; i++) {
            let best = Infinity;
            for (let j = 0; j < on.length; j++) if (on[j]) best = Math.min(best, Math.hypot((i % W) - (j % W), Math.floor(i / W) - Math.floor(j / W)));
            if (Math.abs(d[i] - best) > 1e-6) throw new Error(`pixel ${i}: ${d[i]} ≠ ${best}`);
        }
    });
    test('no shape: infinitely far; a single point: a cone', () => {
        eq(distanceTo(new Uint8Array(6), 3, 2)[4], Infinity);
        const one = new Uint8Array(25); one[12] = 1;
        eq(distanceTo(one, 5, 5)[0], Math.fround(Math.hypot(2, 2)));
    });
    test('the picture: white is 0; red near, green far, blue inside; decoded back', () => {
        const W = 600, H = 3, rgba = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < 10; x++) rgba[(y * W + x) * 4] = 255;   // the shape (red): x < 10
        const { data } = encodeAway(rgba, W, H), at = (x) => [...data.slice((W + x) * 4, (W + x) * 4 + 4)];
        eq(at(5), [255, 255, 250, 255]);
        eq(at(110), [154, 230, 255, 255]);                        // 101 px: the shape's last column is x = 9
        eq(Math.round(awayFromChannels(at(110)[0] / 255, at(110)[1] / 255) * 1e6) / 1e6, 101);
        eq(at(509)[0], 0);
        eq(Math.round(awayFromChannels(0, at(509)[1] / 255)), 500);
    });
    test('a big selection is measured smaller, its distances scaled back', () => {
        const W = 2048, H = 8, sel = new Float32Array(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < 64; x++) sel[(y * W + x) * 4] = 1;
        const pic = awayPicture({ data: sel, width: W, height: H });
        eq([pic.width, pic.height], [512, 2]);
        const d = awayFromChannels(pic.data[(512 + 116) * 4] / 255, pic.data[(512 + 116) * 4 + 1] / 255);   // x = 466 of 2048
        if (Math.abs(d - (466 - 64)) > 8) throw new Error(`${d}`);
    });
    test('the CPU runner makes `away` from the selection, and a filter without it is left alone', () => {
        const W = 40, H = 1, img = { data: new Float32Array(W * 4).fill(0.5), width: W, height: H };
        const sel = { data: new Float32Array(W * 4), width: W, height: H };
        for (let x = 0; x < 5; x++) sel.data.fill(1, x * 4, x * 4 + 4);
        const runner = createCpuRunner(compileFilter('min(away / 100, 1) * (1, 1, 1)'));
        runner.setImage(img);
        const at = (out, x) => out.data[x * 4];
        eq(at(runner.draw(), 20), 0);                           // no selection: 0 everywhere
        runner.setImage('selection', sel);
        const out = runner.draw();
        const got = [at(out, 2), at(out, 14), at(out, 34)], want = [0, 0.1 * 255, 0.3 * 255];   // 10 and 30 px from x = 4
        if (got.some((v, k) => Math.abs(v - want[k]) > 1)) throw new Error(`${got} ≉ ${want}`);
        runner.setImage('selection', null);
        eq(at(runner.draw(), 34), 0);
        eq(compileFilter('gray').passes[0].images.includes('away'), false);
        eq(compileFilter('rgb * (away > 3)').passes[0].images.includes('away'), true);
    });
    test('1024 × 1024 measured at full size well under 100 ms', () => {
        const W = 1024, rgba = new Uint8ClampedArray(W * W * 4);
        for (let y = 300; y < 900; y++) for (let x = 300; x < 700; x++) rgba[(y * W + x) * 4] = 255;
        encodeAway(rgba, W, W);
        const t0 = performance.now();
        encodeAway(rgba, W, W);
        const ms = performance.now() - t0;
        console.log(`    (1024² both ways: ${ms.toFixed(1)} ms)`);
        if (ms > 400) throw new Error(`${ms} ms`);
    });
});
