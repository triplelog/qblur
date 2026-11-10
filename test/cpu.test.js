// The CPU runner, without a browser: pixels, bands, workers, the engine choice, and safety.
// (tools/check.mjs --cpu compares it with WebGL on every library filter.)
import { suite, test, eq, throws } from './harness.js';
import { compileFilter, createCpuRunner, compileCpuPass, chooseEngine } from '../src/index.js';
import * as H from '../src/cpu-helpers.js';

function picture(w, h, seed = 1) {
    const data = new Uint8ClampedArray(w * h * 4);
    let x = seed;
    for (let i = 0; i < data.length; i++) data[i] = (i % 4 === 3) ? 255 : (x = (x * 1103515245 + 12345) % 2147483648) % 256;
    return { data, width: w, height: h };
}
const run = (def, img, opts) => createCpuRunner(compileFilter(def), opts).setImage(img).draw();
const px = (out, x, y) => Array.from(out.data.slice((y * out.width + x) * 4, (y * out.width + x) * 4 + 4));
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const img = picture(9, 7);

suite('CPU filters: pixels', () => {
    test('per-pixel formulas', () => {
        const at = px(img, 4, 3);
        eq(px(run('(1 - r, 1 - g, 1 - b)', img), 4, 3), [255 - at[0], 255 - at[1], 255 - at[2], 255]);
        const g = Math.round((at[0] * 0.299 + at[1] * 0.587 + at[2] * 0.114));
        eq(px(run('gray', img), 4, 3).slice(0, 3).every((v) => Math.abs(v - g) <= 1), true);
        eq(px(run({ params: { cutoff: 2 }, color: 'if gray > cutoff then 1 else 0' }, img), 0, 0), [0, 0, 0, 255]);
        eq(px(run({ color: { r: 'g', g: 'r' } }, img), 2, 2), [px(img, 2, 2)[1], px(img, 2, 2)[0], px(img, 2, 2)[2], 255]);
    });
    test('sampling: mirror, clamp at the edge, bilinear between pixels', () => {
        eq(px(run('pixel(w - 1 - px, py)', img), 0, 1), px(img, 8, 1));
        eq(px(run('pixel(px - 100, py)', img), 5, 2), px(img, 0, 2));
        const half = px(run('pixel(px + 0.5, py)', img), 2, 2);
        const want = [0, 1, 2].map((k) => Math.round((px(img, 2, 2)[k] + px(img, 3, 2)[k]) / 2));
        eq(half.slice(0, 3).every((v, k) => Math.abs(v - want[k]) <= 1), true);
    });
    test('unchanged, as a number and as a branch', () => {
        eq(same(run('if x < 2 then unchanged else 1 - rgb', img).data, img.data), true);   // x is 0–1, so always unchanged
        eq(same(run('if x > 2 then unchanged else 1 - rgb', img).data, run('1 - rgb', img).data), true);
        // as in the shader, `unchanged` takes the other branch's type: beside a number it is the grey value, beside a colour the colour
        const p = px(img, 0, 0);
        const grey = Math.round(p[0] * 0.299 + p[1] * 0.587 + p[2] * 0.114);
        eq(px(run('if x < 0.5 then unchanged else 0', img), 0, 0).slice(0, 3).every((v) => Math.abs(v - grey) <= 1), true);
        eq(px(run('if x < 0.5 then unchanged else (0, 0, 0)', img), 0, 0), p);
        eq(px(run({ color: { r: 'unchanged * 0' } }, img), 1, 1)[0], 0);
    });
    test('chains, opacity and the blend pass', () => {
        const half = run({ steps: [{ filter: '1 - rgb', opacity: 0.5 }] }, img);
        const p = px(img, 3, 3);
        eq(px(half, 3, 3).slice(0, 3).every((v, k) => Math.abs(v - (p[k] + (255 - 2 * p[k]) * 0.5)) <= 1), true);
        const blended = run({ steps: [{ filter: { steps: ['1 - rgb', 'rgb * 0.5'] }, opacity: 0.25 }] }, img);
        eq(blended.width, 9);
    });
});

suite('CPU filters: bands and workers give the same pixels', () => {
    const big = picture(40, 37, 5);
    for (const name of ['blur', 'blurx', 'blury', 'gaussian', 'gaussianx', 'gaussiany', 'dilate', 'erode', 'sharpen']) {
        test(`plane_${name} by bands`, () => {
            const I = Float32Array.from(big.data, (v) => v / 255);
            const full = H[`plane_${name}`](I, 40, 37, 0, 37, 2.5);
            const parts = [[0, 5], [5, 19], [19, 37]].map(([a, b]) => [a, b, H[`plane_${name}`](I, 40, 37, a, b, 2.5)]);
            let ok = true;
            for (const [a, b, plane] of parts) for (let j = a * 40 * 3; j < b * 40 * 3; j++) if (Math.abs(plane[j] - full[j]) > 1e-6) ok = false;
            eq(ok, true);
        });
    }
    test('sobel by bands', () => {
        const I = Float32Array.from(big.data, (v) => v / 255);
        const full = H.plane_sobel(I, 40, 37, 0, 37);
        const top = H.plane_sobel(I, 40, 37, 0, 20);
        const bottom = H.plane_sobel(I, 40, 37, 20, 37);
        let ok = true;
        for (let j = 0; j < 40 * 37; j++) if ((j < 800 ? top : bottom)[j] !== full[j]) ok = false;
        eq(ok, true);
    });
});

suite('CPU filters: which engine', () => {
    test('the GPU whenever WebGL is there; the CPU without it or when asked', () => {
        eq(chooseEngine({ webgl: true }).engine, 'gpu');
        eq(chooseEngine({ webgl: false }).engine, 'cpu');
        eq(chooseEngine({ webgl: true, prefer: 'cpu' }).engine, 'cpu');
        eq(chooseEngine({ webgl: false, prefer: 'gpu' }).engine, 'cpu');
        eq(chooseEngine({ webgl: true, prefer: 'gpu' }).reason, 'asked for the GPU');
    });
});

suite('CPU filters: user input is only maths', () => {
    test('unknown names and functions are refused, and nothing is called', () => {
        let called = false;
        globalThis.pwnedForTest = () => { called = true; return 1; };
        for (const def of ['pwnedForTest()', 'alert(1)', 'fetch(1) + r', 'globalThis', 'constructor', 'pixel(pwnedForTest(), 0)', 'r.constructor', 'process']) {
            throws(() => compileCpuPass(compileFilter(def).passes[0]));
        }
        eq(called, false);
        delete globalThis.pwnedForTest;
    });
    test('a filter has no strings', () => throws(() => compileCpuPass({ color: '"x" + r', params: {}, placements: {} }), /no text|string/));
    test('the generated code uses only its own names', () => {
        const { source } = compileCpuPass(compileFilter({ params: { k: 0.5, tint: [1, 0.5, 0] }, color: 'mix(rgb, tint, k) + blur(2) - sobel()' }).passes[0]);
        const names = new Set(source.match(/[A-Za-z_$][\w$]*/g));
        const foreign = [...names].filter((n) => !n.startsWith('$') && !['let', 'for', 'Math', 'floor', 'min', 'max', 'sqrt', 'abs', 'Infinity', 'true', 'false', 'Number', 'isFinite', 'isInteger'].includes(n));
        eq(foreign, []);
    });
});

export async function asyncTests() {
    // drawAsync with workers, against draw on one thread
    const big = picture(300, 220, 9);
    for (const def of ['(1 - r, 1 - g, 1 - b)', 'gaussian(3)', { steps: ['gaussianx(6)', 'gaussiany(6)'] }, 'blur(x * 6)', '2 sobel()', { steps: [{ filter: { steps: ['blur(2)', 'rgb * 1.2'] }, opacity: 0.5 }, 'zoom(1.3)'] }]) {
        const r = createCpuRunner(compileFilter(def), { workers: 3, parallelFrom: 0 }).setImage(big);
        const a = r.draw();
        const b = await r.drawAsync();
        const ok = r.workers === 3 && same(a.data, b.data);
        r.dispose();
        if (!ok) throw new Error(`drawAsync differs from draw for ${JSON.stringify(def)} (workers: ${r.workers})`);
    }
}

suite('CPU colour spaces', () => {
    const picture = (w, h) => {
        const data = new Float32Array(w * h * 4);
        for (let i = 0; i < w * h; i++) data.set([(i % w) / (w - 1), Math.floor(i / w) / (h - 1), ((i * 7) % 11) / 10, 1], i * 4);
        return { data, width: w, height: h };
    };
    for (const space of ['linear', 'hsv', 'hsl', 'lab', 'oklab', 'ycbcr']) {
        test(`${space}: there and back is the same colour (float textures between passes)`, () => {
            const w = 23, h = 17, src = picture(w, h);
            const runner = createCpuRunner(compileFilter({ space, color: 'rgb' }), { workers: 0, precision: 'float' });
            runner.setImage(src);
            const out = runner.draw({ t: 0 }).data;
            let worst = 0;
            for (let i = 0; i < w * h * 4; i++) if (i % 4 !== 3) worst = Math.max(worst, Math.abs(out[i] / 255 - src.data[i]));
            if (worst > 0.51 / 255) throw new Error(`off by ${(worst * 255).toFixed(1)}/255`);     // 8-bit textures would lose up to ~20/255 in Lab's dark corners
        });
    }
    test('in HSV, r is the hue and gray is still the brightness', () => {
        const runner = createCpuRunner(compileFilter({ space: 'hsv', color: '(r, g, b * 0 + gray)' }), { workers: 0 });
        runner.setImage({ data: new Float32Array([1, 0, 0, 1]), width: 1, height: 1 });      // pure red: hue 0, saturation 1; gray 0.299 as the value
        const [r, g, b] = runner.draw({ t: 0 }).data;
        if (Math.abs(r / 255 - 0.299) > 1 / 255 || g !== 0 || b !== 0) throw new Error(`got ${[r, g, b]}`);   // (0, 1, 0.299) in HSV is dark red
    });
});

suite('CPU selection', () => {
    test('selected is 1 without a selection and the mask with one', () => {
        const runner = createCpuRunner(compileFilter('(selected, selected, selected)'), { workers: 0 });
        runner.setImage({ data: new Float32Array([0.2, 0.4, 0.6, 1, 0.2, 0.4, 0.6, 1]), width: 2, height: 1 });
        eq([...runner.draw({ t: 0 }).data].slice(0, 3), [255, 255, 255]);
        runner.setImage('selection', { data: new Float32Array([1, 1, 1, 1, 0, 0, 0, 1]), width: 2, height: 1 });
        const out = runner.draw({ t: 0 }).data;
        eq([out[0], out[4]], [255, 0]);
    });
});
