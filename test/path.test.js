import { suite, test, eq } from './harness.js';
import { makePath, pointAt, progress } from '../demo/path.js';

const near = (a, b, d = 1e-6) => { if (Math.abs(a - b) > d) throw new Error(`${a} ≉ ${b}`); };

suite('Make it move: the Ken Burns path (demo/path.js)', () => {
    test('evenly spaced along the drawn line, ends kept', () => {
        const path = makePath([[0, 0], [0.1, 0], [0.2, 0], [0.9, 0], [1, 0]], { n: 11 });
        eq(path.length, 11);
        eq(path[0], [0, 0]);
        near(path[10][0], 1);
        for (let k = 1; k < 11; k++) near(path[k][0] - path[k - 1][0], 0.1, 0.02);
    });
    test('pointAt: the ends at 0 and 1, the middle at 0.5, gentle near the ends', () => {
        const path = makePath([[0.2, 0.5], [0.8, 0.5]], { n: 32 });
        eq(pointAt(path, 0), [0.2, 0.5]);
        near(pointAt(path, 1)[0], 0.8);
        near(pointAt(path, 0.5)[0], 0.5, 0.01);
        if (pointAt(path, 0.05)[0] - 0.2 > 0.05 * 0.6 * 0.5) throw new Error('not eased');
        eq(pointAt([], 0.3), [0.5, 0.5]);
        eq(makePath([[0.3, 0.3]]), [[0.3, 0.3], [0.3, 0.3]]);
    });
    test('progress: there and back over two periods, or round again', () => {
        near(progress(0, 100), 0); near(progress(50, 100), 0.5); near(progress(100, 100), 1); near(progress(150, 100), 0.5); near(progress(200, 100), 0);
        near(progress(50, 100, false), 0.5); near(progress(130, 100, false), 0.3);
    });
});
