#!/usr/bin/env node
/**
 * `node tools/filters-page.mjs` — writes demo/filters.html, the page for writing, changing and saving filters, from
 * demo/editor.html: the same editor (demo/app.js) with `data-mode="write"`, which shows the filter's controls large
 * beside a smaller preview, and its own title, description and heading. Edit editor.html, never filters.html:
 * `npm run build` runs this first, and test/pages.test.js fails when filters.html is out of date.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** editor.html → filters.html (each change must find its place, so a change to editor.html can't slip past it). */
export function filtersPage(editor) {
    let html = editor;
    const swap = (from, to) => {
        if (!html.includes(from)) throw new Error(`filters-page: editor.html no longer has ${JSON.stringify(from.slice(0, 80))}`);
        html = html.replace(from, to);
    };
    swap('<!DOCTYPE html>\n', '<!DOCTYPE html>\n<!-- Made from editor.html by tools/filters-page.mjs: edit that file, then run it (npm run build does). -->\n');
    swap(/<title>[^<]*<\/title>/.exec(html)?.[0] ?? '<title>', '<title>Filters — qblur</title>');
    swap(/<meta name="description" content="[^"]*">/.exec(html)?.[0] ?? '<meta name="description"',
        '<meta name="description" content="Write image filters as maths: steps, knobs and notes, with a live preview — save them in your browser, share them as a link, then use them in the qblur editor.">');
    swap(/<meta property="og:title" content="[^"]*">/.exec(html)?.[0] ?? '<meta property="og:title"', '<meta property="og:title" content="Write an image filter as maths">');
    swap(/<meta property="og:description" content="[^"]*">/.exec(html)?.[0] ?? '<meta property="og:description"',
        '<meta property="og:description" content="Steps, knobs and notes with a live preview; save it, share it as a link, use it on your photos.">');
    swap('<body class="still qb-editor" data-mode="use">', '<body class="still qb-editor" data-mode="write">');
    swap('<h1>Editor</h1>', '<h1>Filters</h1>');
    swap(/<span class="hint bar-what">[\s\S]*?<\/span>\n/.exec(html)?.[0] ?? '<span class="hint bar-what">',
        '<span class="hint bar-what">a filter is maths run on every pixel — <a href="#help" class="help-link" title="how to write a filter">how do I write one?</a></span>\n');
    swap("mountShell({ page: 'editor',", "mountShell({ page: 'filters',");
    return html;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await writeFile(join(ROOT, 'demo/filters.html'), filtersPage(await readFile(join(ROOT, 'demo/editor.html'), 'utf8')));
    console.log('demo/filters.html');
}
