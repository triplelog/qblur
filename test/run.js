/** npm test — the filter format, compiler and sharing, and the CPU runner; WebGL is checked by tools/check.mjs. */
import { report, test, suite } from './harness.js';
await import('./filters.test.js');
await import('./knobs.test.js');
await import('./library.test.js');
await import('./help.test.js');
await import('./gif.test.js');
await import('./png.test.js');
await import('./apply.test.js');
await import('./types.test.js');
await import('./livewire.test.js');
await import('./graphics.test.js');
await import('./examples.test.js');
await import('./strokes.test.js');
await import('./tracker.test.js');
await import('./ai.test.js');
const cpu = await import('./cpu.test.js');
let asyncError = null;
try { await cpu.asyncTests(); } catch (e) { asyncError = e; }
suite('CPU filters: workers', () => {
    test('drawAsync on 3 workers gives draw()\'s pixels', () => { if (asyncError) throw asyncError; });
});
process.exit(report() ? 0 : 1);
