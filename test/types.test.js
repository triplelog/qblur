/** The declarations: every runtime export of an entry is declared in its .d.ts, and nothing declared is missing at runtime. */
import { readFileSync } from 'node:fs';
import { suite, test, eq } from './harness.js';

const ENTRIES = [['src/index.js', 'src/index.d.ts'], ['src/apply.js', 'src/apply.d.ts'], ['src/element.js', 'src/element.d.ts']];
const loaded = await Promise.all(ENTRIES.map(async ([js, dts]) => ({
    js, dts,
    runtime: Object.keys(await import(`../${js}`)).sort(),
    declared: [...readFileSync(new URL(`../${dts}`, import.meta.url), 'utf8')
        .matchAll(/^export (?:declare )?(?:function|const|class|let) (\w+)/gm)].map((m) => m[1]),
})));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

suite('types', () => {
    for (const { js, dts, runtime, declared } of loaded) {
        test(`${dts} declares every export of ${js}`, () => eq(runtime.filter((name) => !declared.includes(name)), []));
        test(`${dts} declares nothing ${js} lacks`, () => eq([...new Set(declared)].filter((name) => !runtime.includes(name)), []));
    }
    test('package.json points at them', () => {
        eq(pkg.types, './src/index.d.ts');
        eq(pkg.exports['.'].types, './src/index.d.ts');
        eq(pkg.exports['./apply'].types, './src/apply.d.ts');
        eq(pkg.exports['./element'].types, './src/element.d.ts');
    });
});
