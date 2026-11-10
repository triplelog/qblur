import { suite, test, eq } from './harness.js';
import { LIBRARY, GROUPS, validateFilter, compileFilter, normalizeFilter, filterToLink, filterFromLink, filterToJSON } from '../src/index.js';

suite('the built-in library', () => {
    test('every filter validates and compiles', () => {
        for (const def of LIBRARY) {
            const problems = validateFilter(def);
            if (problems.length) throw new Error(`${def.name}: ${problems.join('; ')}`);
            compileFilter(def);
        }
    });
    test('names are unique, and every filter has a group (and no author: the built-in filters are nobody\'s in particular)', () => {
        const names = LIBRARY.map((f) => f.name);
        eq(new Set(names).size, names.length);
        for (const f of LIBRARY) if (f.author) throw new Error(`${f.name} is attributed to ${f.author}`);
        for (const f of LIBRARY) if (!GROUPS.includes(f.group)) throw new Error(`${f.name}: group "${f.group}" is not one of ${GROUPS.join(', ')}`);
        for (const g of GROUPS) if (!LIBRARY.some((f) => f.group === g)) throw new Error(`the group "${g}" is empty`);
    });
    test('each survives a share link and JSON unchanged', () => {
        for (const def of LIBRARY) {
            eq(filterFromLink(filterToLink(def)), normalizeFilter(def));
            eq(JSON.parse(filterToJSON(def)).format, 'mathzetta-filter/1');
        }
    });
});
