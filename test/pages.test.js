import { readFile } from 'node:fs/promises';
import { suite, test } from './harness.js';
import { filtersPage } from '../tools/filters-page.mjs';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

suite('the editor and the filters page', () => {
    test('demo/filters.html is made from demo/editor.html (run node tools/filters-page.mjs)', async () => {
        if (filtersPage(await read('demo/editor.html')) !== await read('demo/filters.html')) throw new Error('demo/filters.html is out of date: node tools/filters-page.mjs');
    });
    test('each page says which it is', async () => {
        const editor = await read('demo/editor.html'), filters = await read('demo/filters.html');
        if (!editor.includes('data-mode="use"') || !filters.includes('<body class="still qb-editor" data-mode="write">')) throw new Error('data-mode');
        if (!filters.includes("mountShell({ page: 'filters',")) throw new Error('the shell\'s page');
    });
});
