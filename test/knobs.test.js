import { suite, test, eq, throws } from './harness.js';
import { normalizeFilter, compileFilter } from '../src/index.js';
import {
    definitionOf, inlineDefinition, parseDefinition, numberOf, blocksOf, notesOf, freeName, renameInMaths, bakeStep, sliderStep,
} from '../demo/knobs.js';

suite('knobs as Inline Math variables (demo/knobs.js)', () => {
    test('every kind of knob is written as a line and read back', () => {
        const f = normalizeFilter({ params: { cutoff: { default: 0.5, min: 0, max: 1, step: 0.01 }, radius: { default: 3, input: 'box' }, n: { options: [2, 4, 8] }, tint: [1, 0.5, 0] }, color: 'rgb' });
        eq(definitionOf('cutoff', f.params.cutoff), 'cutoff := [[0..1 step 0.01 = 0.5]]');
        eq(definitionOf('radius', f.params.radius), 'radius := [[3]]');
        eq(definitionOf('n', f.params.n), 'n := [[2 | 4 | 8]]');
        eq(definitionOf('tint', f.params.tint), 'tint := #ff8000');
        for (const [name, param] of Object.entries(f.params)) {
            const { name: back, spec } = parseDefinition(definitionOf(name, param));
            eq(back, name);
            const again = normalizeFilter({ params: { [name]: spec }, color: 'rgb' }).params[name];
            eq(definitionOf(name, again), definitionOf(name, param));
        }
    });
    test('a slider without a step gets a round one, written out (Inline Math would step by 1)', () => {
        eq(sliderStep({ min: 0, max: 1 }), 0.005);
        eq(sliderStep({ min: 0, max: 60 }), 0.5);
        eq(definitionOf('k', normalizeFilter({ params: { k: 0.5 }, color: 'k' }).params.k), 'k := [[0..1 step 0.005 = 0.5]]');
    });
    test('a menu is drawn starting on its value', () => {
        eq(inlineDefinition('n', { type: 'number', default: 4, min: 2, max: 8, options: [2, 4, 8] }), 'n := [[4 | 2 | 8]]');
    });
    test('boxes take maths; bad lines say how to write one', () => {
        eq(parseDefinition('k := [[1/4]]').spec, { type: 'number', default: 0.25, input: 'box' });
        eq(parseDefinition('k := 2').spec.default, 2);
        eq(parseDefinition('amount := [[0..2 = 1]]', 'Amount').spec, { type: 'number', label: 'Amount', default: 1, min: 0, max: 2 });
        eq(numberOf('2 pi').toFixed(4), '6.2832');
        eq(numberOf('x + 1'), null);
        throws(() => parseDefinition('k = 0.5'), /name := \[\[0\.\.1/);
        throws(() => parseDefinition('k := [[1..0]]'), /smaller number to a larger/);
        throws(() => parseDefinition('k := [[0..1 = 3]]'), /outside 0 to 1/);
        throws(() => parseDefinition('k := [[a | b]]'), /numbers between \| marks/);
        throws(() => parseDefinition('k := hello'), /not a number/);
    });
    test('the page: unplaced knobs first, texts kept, nothing stored for knobs alone', () => {
        const params = { a: {}, b: {}, c: {} };
        eq(blocksOf(params, ['intro', { param: 'b' }, { param: 'gone' }]), [{ param: 'a' }, { param: 'c' }, 'intro', { param: 'b' }]);
        eq(notesOf([{ param: 'a' }, { param: 'b' }]), undefined);
        eq(notesOf([{ param: 'a' }, 'text']), [{ param: 'a' }, 'text']);
        eq(freeName(new Set(['k1', 'k2'])), 'k3');
    });
    test('renaming a knob renames it in the maths, as a whole word', () => {
        eq(renameInMaths('if gray > k then k1 else k', 'k', 'cut'), 'if gray > cut then k1 else cut');
        eq(renameInMaths({ r: 'k', g: 'pk' }, 'k', 'm'), { r: 'm', g: 'pk' });
    });
    test('a step saved on its own keeps its settings', () => {
        const step = normalizeFilter({ steps: [{ filter: { name: 'T', params: { cutoff: 0.5, n: { options: [2, 4] }, tint: [1, 1, 1] }, color: 'rgb * tint * cutoff * n' }, with: { cutoff: 0.8, n: 3, tint: [1, 0, 0] } }] }).steps[0];
        const baked = normalizeFilter(bakeStep(step));
        eq(baked.params.cutoff.default, 0.8);
        eq(baked.params.n.options, [2, 4, 3]);
        eq(baked.params.tint.default, [1, 0, 0]);
        eq(step.filter.params.cutoff.default, 0.5);                             // the step itself is untouched
        const chain = normalizeFilter({ steps: [{ filter: { name: 'C', steps: [{ params: { k: 0.5 }, color: 'rgb * k' }] }, with: { k: 0.2 } }] }).steps[0];
        eq(compileFilter(bakeStep(chain)).passes[0].values.k, 0.2);
    });
});
