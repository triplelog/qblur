/**
 * GPU or CPU? One call that picks, and says why.
 *
 *   const { runner, engine, reason } = createRunner(compileFilter(def), { gl });
 *   runner.setImage(img);  runner.draw({ t, canvas });   // canvas: where the CPU draws (the GPU draws on gl's)
 *
 * The GPU whenever WebGL is there: a filter's shaders are compiled once and
 * then reused for every picture and every frame, so the compile is paid once
 * per filter, and after that the GPU is the faster engine. The CPU when
 * there is no WebGL (some browsers, Node, servers), when the GPU refuses the
 * shader, or when asked for (prefer: 'cpu'). Both give the same pixels
 * (tools/check.mjs --cpu compares them on every library filter).
 */

import { createFilterRunner } from './runtime.js';
import { createCpuRunner } from './cpu-runner.js';

/** @returns {{ engine: 'gpu' | 'cpu', reason: string }} */
export function chooseEngine({ webgl = false, prefer = 'auto' } = {}) {
    if (prefer === 'cpu') return { engine: 'cpu', reason: 'asked for the CPU' };
    if (!webgl) return { engine: 'cpu', reason: 'no WebGL here' };
    return { engine: 'gpu', reason: prefer === 'gpu' ? 'asked for the GPU' : 'WebGL is here' };
}

/**
 * @param {object} compiled compileFilter() output
 * @param {object} [o] { gl, prefer: 'auto' | 'gpu' | 'cpu', precision, workers }
 * @returns {{ runner, engine: 'gpu' | 'cpu', reason: string }}
 */
export function createRunner(compiled, o = {}) {
    const choice = chooseEngine({ webgl: Boolean(o.gl), prefer: o.prefer });
    if (choice.engine === 'gpu') {
        try {
            return { runner: createFilterRunner(o.gl, compiled, { precision: o.precision }), ...choice };
        } catch (e) {
            if (o.prefer === 'gpu') throw e;
            return { runner: createCpuRunner(compiled, o), engine: 'cpu', reason: `the GPU refused the shader (${e.message.split('\n')[0]})` };
        }
    }
    return { runner: createCpuRunner(compiled, o), ...choice };
}
