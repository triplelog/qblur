import { readFile } from 'node:fs/promises';
import { suite, test, eq } from './harness.js';
import { HELP, explain } from '../demo/help.js';
import { markdownToHtml, slug, forSite } from '../tools/markdown.mjs';
import { validateFilter } from '../src/index.js';

const guide = await readFile(new URL('../docs/filters.md', import.meta.url), 'utf8');
const headings = new Set(guide.split('\n').filter((l) => /^#{1,4} /.test(l)).map((l) => slug(l.replace(/^#+ /, ''))));
const has = (text, part) => { if (!text.includes(part)) throw new Error(`missing ${JSON.stringify(part)}`); };

suite('the in-page help', () => {
    test('every section points at a heading the guide has', () => {
        for (const section of HELP) if (!headings.has(section.guide)) throw new Error(`${section.id}: no heading "${section.guide}" in docs/filters.md`);
    });
    test('every example is a filter that validates', () => {
        for (const section of HELP) {
            for (const example of section.examples) {
                const def = typeof example === 'string' || Array.isArray(example) ? (Array.isArray(example) ? example[0] : example) : example.def;
                const problems = validateFilter(def);
                if (problems.length) throw new Error(`${section.id}: ${JSON.stringify(def)}: ${problems.join('; ')}`);
            }
        }
    });
    test('errors get a hint and the right section', () => {
        const shader = explain("Threshold does not compile: ERROR: 0:117: 'foo' : undeclared identifier");
        eq(shader.id, 'pixel');
        eq(shader.text, "Threshold does not compile: 'foo' : undeclared identifier");     // line numbers mean nothing to a reader
        has(shader.hint, '"foo" isn\'t a name');
        eq(explain('unknown name "foo"').id, 'pixel');
        eq(explain("ERROR: 0:84: '?:' : mismatching ternary operator operand types").id, 'if');
        eq(explain("'mix' : no matching overloaded function found").id, 'maths');
        eq(explain('Failed to parse expression "2 +": An operator is missing an operand at the end').id, 'maths');
        eq(explain('"Threshold": "with" sets "nope", but there is no parameter called that').id, 'params');
        eq(explain('Image "pic": "place" is cover, fit, stretch, tile — not "huge"').id, 'pictures');
        eq(explain('The link is not a filter: Not a filter link').id, 'params');
        eq(explain('The WebGL context is lost').hint.includes('CPU'), true);
        eq(explain('something nobody foresaw').hint, undefined);
        for (const section of HELP) eq(explain('unknown name "x"').guide !== undefined, true);
    });
});

suite('the guide rendered for the site', () => {
    const html = markdownToHtml(guide);
    test('the developer parts are left out of the site\'s guide, nothing else', () => {
        const site = forSite(guide);
        if (/<!--|demo\/index\.html|npm run|tools\/export-model/.test(site)) throw new Error('a developer part is left in');
        has(site, '## What an expression can use');
        has(site, '## Running it');
        has(site, '## Format stability');
        for (const section of HELP) has(markdownToHtml(site), `id="${section.guide}"`);
    });
    test('every heading keeps its GitHub id', () => { for (const id of headings) has(html, `id="${id}"`); });
    test('code, tables and lists come through', () => {
        has(html, '<pre><code>');
        has(html, '<table>');
        has(html, '<ul><li>');
        if (/```|^\|/m.test(html)) throw new Error('raw markdown left in the HTML');
        has(html, '<code>gray</code>');
    });
    test('slugs match GitHub', () => {
        eq(slug('Results: numbers, colours, true/false'), 'results-numbers-colours-truefalse');
        eq(slug('Animation with `t`'), 'animation-with-t');
        eq(slug("What doesn't carry over to a shader"), 'what-doesnt-carry-over-to-a-shader');
    });
});
