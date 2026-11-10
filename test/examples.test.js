import { readFile } from 'node:fs/promises';
import { suite, test, eq } from './harness.js';
import { EXAMPLES, resolveExample } from '../demo/examples.js';
import { LIBRARY, validateFilter, compileFilter } from '../src/index.js';

const photos = JSON.parse(await readFile(new URL('../demo/photos/index.json', import.meta.url), 'utf8')).map((p) => p.file);

suite('the examples', () => {
    test('every example compiles, on a picture that exists, and is explained', () => {
        for (const example of EXAMPLES) {
            const def = resolveExample(example, LIBRARY);
            const problems = validateFilter(def);
            if (problems.length) throw new Error(`${example.title}: ${problems.join('; ')}`);
            compileFilter(def);
            if (example.picture !== 'test' && !photos.includes(example.picture)) throw new Error(`${example.title}: no photo ${example.picture}`);
            if (!example.how.length || !example.shows.length) throw new Error(`${example.title}: not explained`);
        }
    });
    test('ids are unique, and explanations\' code spans close', () => {
        eq(new Set(EXAMPLES.map((e) => e.id)).size, EXAMPLES.length);
        for (const e of EXAMPLES) for (const line of e.how) if ((line.match(/`/g) ?? []).length % 2) throw new Error(`${e.title}: unbalanced backticks in "${line}"`);
    });
});
