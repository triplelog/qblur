#!/usr/bin/env node
/**
 * `npm run build` — the library for a CDN, and the editor as a folder any static host can serve:
 *
 *   dist/qblur.js             the package as one ES module, minified, MathZetta inside (what a page imports from jsDelivr)
 *   dist/qblur.global.min.js  a classic <script>: window.QBlur (everything, qblur/apply too)
 *   dist/qblur.core.js        compile a filter and run it on the GPU, nothing else (no CPU runner, strokes,
 *                             graphics or the built-in library): 60% of the size
 *   dist/qblur.external.js    everything, MathZetta left out (bare imports 'mathzetta', 'mathzetta/glsl',
 *                             'mathzetta/formulas' remain for an import map): half the size
 *   dist/qblur-apply.js       qblur/apply: applyFilter and saving (src/apply.js), MathZetta inside
 *   dist/qblur-element.js     <qblur-image>: the custom element (src/element.js), MathZetta inside
 *   dist/cpu-worker.js        the CPU runner's worker (drawAsync on big pictures), MathZetta inside; found beside the bundle
 *   dist/qblur.external.global.min.js
 *                             the classic <script> without MathZetta: reads window.MathZetta, which a
 *                             MathZetta <script> put there first (mathzetta.min.js or the glsl flavour)
 *
 *   site/index.html     demo/index.html without the import map
 *   site/app.js         demo/app.js and this package bundled; MathZetta and Inline Math (the knobs and notes) from jsDelivr
 *   site/cpu-worker.js  the CPU runner's worker, bundled the same way
 *   site/guide.html     docs/filters.md rendered (tools/markdown.mjs), heading ids as on GitHub
 *   site/library.html   docs/library.md rendered the same way: qblur on your own pages (the CDN, the API)
 *   site/avatar/, splash/, move/, text/   the small apps (demo/<app>/): each page with its app.js bundled
 *                       (demo/kit.js inside), sharing site/apps.css, photos/, models/ and ort/
 *   site/photos/        demo/photos/, when there is one
 *   site/models/        the shipped object model (SHIPPED_MODELS in demo/ai.js: MobileSAM, Apache-2.0; every file
 *                       under Cloudflare Pages' 25 MiB) with its LICENSE and NOTICE; the other models in demo/models/ are for comparing in development only
 *   site/ort/           ONNX Runtime Web's WebAssembly build, which runs it
 *
 * Bare imports are resolved exactly as the page's own import map says, so
 * the dev page (demo/, import map + node_modules) and the built page run
 * the same code.
 */
import { rollup } from 'rollup';
import { libraries, isLibrary, cdnUrl, fileUrl, replaceImportMap, checkCdn, cdnUrlsIn } from 'mathzetta-sites/cdn.mjs';
import terser from '@rollup/plugin-terser';
import { cp, mkdir, readFile, writeFile, readdir, access, rm } from 'node:fs/promises';
import { guidePage, forSite } from './markdown.mjs';
import { AI_MODELS, SHIPPED_MODELS } from '../demo/ai.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const html = await readFile(join(ROOT, 'demo/index.html'), 'utf8');
// Where the site will live, for the absolute URLs link previews need: SITE_URL, or "homepage" in package.json.
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const siteUrl = (process.env.SITE_URL || pkg.homepage || '').replace(/\/*$/, '/').replace(/^\/$/, '');
const importMap = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]).imports;
const v = libraries(ROOT);   // the site loads these versions of mathzetta from jsDelivr
const cdnUsed = [];

const resolveLikeThePage = {
    name: 'import-map',
    resolveId: (id) => (importMap[id] ? join(ROOT, importMap[id]) : null),
};

// The site's bundles: qblur's code alone. MathZetta stays an import by name, which the page's import map
// points at the CDN; a worker sees no import map, so there the names are written as the CDN addresses.
async function bundle(input, file, { worker = false } = {}) {
    const build = await rollup({
        input: join(ROOT, input),
        plugins: [resolveLikeThePage],
        external: (id) => isLibrary(id) || id.startsWith('node:') || id === 'onnxruntime-web' || id === '@mediapipe/tasks-vision',   // Node branches never taken in a browser; the object models' runtimes load from ort/ and mediapipe/ when first used
        onwarn: (warning, warn) => { if (warning.code !== 'CIRCULAR_DEPENDENCY') warn(warning); },
    });
    await build.write({ file: join(ROOT, 'site', file), format: 'es', banner: '/* qblur — MIT licence; mathzetta loads from jsDelivr */',
        ...(worker ? { paths: (id) => cdnUrl(id, v) ?? id } : {}) });
    await build.close();
    if (worker) cdnUsed.push(...cdnUrlsIn(await readFile(join(ROOT, 'site', file), 'utf8')));
}
/** A page's import map: its own entries (the object model's runtime) and mathzetta from the CDN. */
const siteMap = (page, ort) => {
    const out = replaceImportMap(page.replace(/<script type="importmap">[\s\S]*?<\/script>/, `<script type="importmap">\n{ "imports": { "onnxruntime-web": "${ort}" } }\n</script>`), v);
    cdnUsed.push(...cdnUrlsIn(out));
    return out;
};

/**
 * What a page's <head> needs for search and link previews, filled in from the page itself (its <title> and description):
 * the canonical address, og:/twitter: tags with the page's card (demo/share/<card>.jpg, made by tools/share-cards.mjs), and
 * the icons (favicon.svg, favicon.ico, apple-touch-icon.png at the site's root). A page's own og:/twitter:/icon tags are
 * replaced (a page's own og:title / og:description are kept), so every page says the same things the same way. Addresses that aren't absolute stay relative to the page
 * (`path` is where it is, as the sitemap writes it), so the site also works under a sub-path.
 */
function head(page, { path, card, description }) {
    const up = '../'.repeat(path.split('/').length - 1);
    const attr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const unattr = (t) => t.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    const ownOg = (k) => { const m = new RegExp(`<meta property="og:${k}" content="([^"]+)">`).exec(page); return m && unattr(m[1]); };
    let html = page.replace(/[ \t]*<meta (?:property="og:|name="twitter:)[^>]*>\n?/g, '').replace(/[ \t]*<link rel="(?:icon|apple-touch-icon)"[^>]*>\n?/g, '');
    const title = unattr(/<title>([^<]*)<\/title>/.exec(html)[1]);
    const own = /<meta name="description" content="([^"]*)">/.exec(html)?.[1];
    if (!own && !description) throw new Error(`${path || 'index.html'}: no description`);
    const text = own ? unattr(own) : description;
    const url = siteUrl ? siteUrl + path : '';
    const lines = [
        ...(own ? [] : [`<meta name="description" content="${attr(text)}">`]),
        ...(url ? [`<link rel="canonical" href="${attr(url)}">`] : []),
        '<meta property="og:type" content="website">',
        '<meta property="og:site_name" content="qblur">',
        `<meta property="og:title" content="${attr(ownOg('title') ?? title.replace(/^qblur · /, '').replace(/ — qblur$/, '').replace(/^./, (c) => c.toUpperCase()))}">`,
        `<meta property="og:description" content="${attr(ownOg('description') ?? text)}">`,
        ...(url ? [`<meta property="og:url" content="${attr(url)}">`] : []),
        `<meta property="og:image" content="${attr(siteUrl ? `${siteUrl}share/${card}.jpg` : `${up}share/${card}.jpg`)}">`,
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        '<meta name="twitter:card" content="summary_large_image">',
        `<link rel="icon" href="${up}favicon.svg" type="image/svg+xml">`,
        `<link rel="icon" href="${up}favicon.ico" sizes="32x32">`,
        `<link rel="apple-touch-icon" href="${up}apple-touch-icon.png">`,
    ];
    return html.replace(/(<meta name="viewport"[^>]*>\n)/, (m) => m + lines.join('\n') + '\n');
}

// the library: one ES module and one classic script, with MathZetta's GLSL output bundled in
const libBanner = `/* qblur ${pkg.version} — MIT licence — https://qblur.com */`;
await rm(join(ROOT, 'dist'), { recursive: true, force: true });
await mkdir(join(ROOT, 'dist'), { recursive: true });
const minify = terser({ format: { comments: /MIT licence/ } });
const CORE = join(ROOT, 'src/core-entry.tmp.js');   // the GPU-only entry, written for the build and removed after
const GLOBAL = join(ROOT, 'src/global-entry.tmp.js');   // the classic scripts: everything on window.QBlur, qblur/apply too
await writeFile(GLOBAL, "export * from './index.js';\nexport * from './apply.js';\n");
await writeFile(CORE, "export { compileFilter, readFilter, filterToLink, normalizeFilter, FILTER_FORMAT } from './format.js';\nexport { createFilterRunner } from './runtime.js';\n");
const builds = [
    ['qblur.js', join(ROOT, 'src/index.js'), 'es', {}, (id) => id.startsWith('node:')],
    ['qblur.global.min.js', GLOBAL, 'iife', { name: 'QBlur' }, (id) => id.startsWith('node:')],
    ['qblur.core.js', CORE, 'es', {}, (id) => id.startsWith('node:')],
    ['qblur.external.js', join(ROOT, 'src/index.js'), 'es', { banner: libBanner.replace(' —', ' (MathZetta not included: map mathzetta, mathzetta/glsl and mathzetta/formulas with an import map) —') }, (id) => id.startsWith('node:') || id.startsWith('mathzetta')],
    ['qblur.external.global.min.js', GLOBAL, 'iife', { name: 'QBlur', globals: () => 'MathZetta', banner: libBanner.replace(' —', ' (MathZetta not included: load mathzetta.min.js or mathzetta.glsl.min.js first) —') }, (id) => id.startsWith('node:') || id.startsWith('mathzetta')],
    ['qblur-apply.js', join(ROOT, 'src/apply.js'), 'es', {}, (id) => id.startsWith('node:')],
    ['qblur-element.js', join(ROOT, 'src/element.js'), 'es', {}, (id) => id.startsWith('node:')],
];
try {
    for (const [file, input, format, extra, external] of builds) {
        const lib = await rollup({
            input,
            plugins: [resolveLikeThePage],
            external,
            onwarn: (warning, warn) => { if (warning.code !== 'CIRCULAR_DEPENDENCY') warn(warning); },
        });
        await lib.write({ file: join(ROOT, 'dist', file), format, banner: libBanner, plugins: [minify], ...extra });
        await lib.close();
    }
} finally { await rm(CORE, { force: true }); await rm(GLOBAL, { force: true }); }
// the CPU runner's worker, for drawAsync() on big pictures: beside the bundles, self-contained (a worker
// doesn't see the page's import map), started from a CDN through a blob: module (cpu-runner.js)
{
    const worker = await rollup({ input: join(ROOT, 'src/cpu-worker.js'), plugins: [resolveLikeThePage], external: (id) => id.startsWith('node:'),
        onwarn: (warning, warn) => { if (warning.code !== 'CIRCULAR_DEPENDENCY') warn(warning); } });
    await worker.write({ file: join(ROOT, 'dist/cpu-worker.js'), format: 'es', banner: libBanner, plugins: [minify] });
    await worker.close();
}

await mkdir(join(ROOT, 'site'), { recursive: true });
await bundle('demo/app.js', 'app.js');
await bundle('src/cpu-worker.js', 'cpu-worker.js', { worker: true });
await writeFile(join(ROOT, 'site/index.html'), head(siteMap(html, './ort/ort.wasm.min.mjs')
    .replaceAll('href="../docs/filters.md"', 'href="guide.html"')
    .replaceAll('href="../docs/library.md"', 'href="library.html"')
    .replaceAll('/node_modules/mathzetta-sites/src/', './mz/')
    .replace('/node_modules/@mathzetta/inlinemath/inlinemath.css', () => { const url = fileUrl('inlinemath', 'inlinemath.css', v); cdnUsed.push(url); return url; })   // the knobs and notes are drawn by Inline Math
    , { path: '', card: 'index' }));
if (!siteUrl) console.log('note: set SITE_URL (or "homepage" in package.json) for absolute og:image / og:url / canonical in link previews');
// the two documents, linking each other by their site names
const siteLinks = (html) => html.replaceAll('href="filters.md', 'href="guide.html').replaceAll('href="library.md', 'href="library.html');
await writeFile(join(ROOT, 'site/guide.html'), head(siteLinks(guidePage(forSite(await readFile(join(ROOT, 'docs/filters.md'), 'utf8')))),
    { path: 'guide.html', card: 'docs', description: 'How to write an image filter as maths: what an expression can use — the pixel, its neighbours, where it is, time, other pictures — with examples to try in the editor.' }));
await writeFile(join(ROOT, 'site/library.html'), head(siteLinks(guidePage(await readFile(join(ROOT, 'docs/library.md'), 'utf8'), { title: 'qblur · on your own pages', page: 'library' })),
    { path: 'library.html', card: 'docs', description: 'qblur on your own pages: one script tag or an ES module from a CDN, filters on the GPU or the CPU (in Node too), knobs, video, text and sharing — with working examples.' }));
// the site's essentials: privacy and terms (drafts: the owner fills the {{…}}), a 404, robots.txt and a sitemap from the registry
// The owner's details (legal name, contact, dates…) are written once, in docs/site-details.json (Claude UI's Content
// page edits it), and fill the {{KEY}}s of both pages; an empty one stays {{KEY}}. When nothing is left to fill, the
// "Draft" note at the top goes.
const details = JSON.parse(await readFile(join(ROOT, 'docs/site-details.json'), 'utf8'));
for (const [name, title] of [['privacy', 'qblur · privacy'], ['terms', 'qblur · terms of use']]) {
    let md = (await readFile(join(ROOT, `docs/${name}.md`), 'utf8')).replace(/\{\{([A-Z_]+)\}\}/g, (all, key) => (details[key] ? String(details[key]) : all));
    const unfilled = [...md.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);
    if (!unfilled.length) md = md.replace(/^> \*\*Draft\.\*\*[^\n]*\n(>[^\n]*\n)*\n?/m, '');
    else console.log(`note: ${name}.html still has ${[...new Set(unfilled)].join(', ')} to fill (docs/site-details.json)`);
    await writeFile(join(ROOT, `site/${name}.html`), head(siteLinks(guidePage(md, { title, page: name })), {
        path: `${name}.html`, card: 'index',
        description: name === 'privacy' ? 'How qblur handles your data: your pictures stay in your browser — no accounts, no uploads.' : 'The terms for using qblur.com.' }));
}
await cp(join(ROOT, 'demo/404.html'), join(ROOT, 'site/404.html'));
{
    const { SITES } = await import(new URL('../node_modules/mathzetta-sites/src/sites.js', import.meta.url));
    const qblur = SITES.find((s) => s.id === 'qblur');
    const urls = [...qblur.pages.map((p) => qblur.url + p.path), qblur.url + 'privacy.html', qblur.url + 'terms.html'];
    await writeFile(join(ROOT, 'site/robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${qblur.url}sitemap.xml\n`);
    await writeFile(join(ROOT, 'site/sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}\n</urlset>\n`);
}
// the small apps: a folder each, one level down, so their paths to photos/, models/ and ort/ start with ../
export const APPS = ['avatar', 'splash', 'move', 'text'];
for (const app of APPS) {
    await mkdir(join(ROOT, 'site', app), { recursive: true });
    await bundle(`demo/${app}/app.js`, `${app}/app.js`);
    const page = await readFile(join(ROOT, 'demo', app, 'index.html'), 'utf8');
    await writeFile(join(ROOT, 'site', app, 'index.html'), head(siteMap(page, '../ort/ort.wasm.min.mjs')
        .replaceAll('/node_modules/mathzetta-sites/src/', '../mz/'), { path: `${app}/`, card: app }));
}
await cp(join(ROOT, 'demo/apps.css'), join(ROOT, 'site/apps.css'));
// the link-preview cards and the icons (tools/share-cards.mjs makes them)
await cp(join(ROOT, 'demo/share'), join(ROOT, 'site/share'), { recursive: true });
for (const f of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) await cp(join(ROOT, 'demo', f), join(ROOT, 'site', f));
// the Shioh look and its sidebar (in place of the family's header and footer), the registry import pointed at site/mz/
for (const f of ['shioh-style.css', 'site-theme.css', 'shioh.js']) await cp(join(ROOT, 'demo', f), join(ROOT, 'site', f));
await rm(join(ROOT, 'site/shioh.css'), { force: true });   // the old one-file stylesheet (now shioh-style.css + site-theme.css)
await writeFile(join(ROOT, 'site/shell.js'), (await readFile(join(ROOT, 'demo/shell.js'), 'utf8')).replaceAll('/node_modules/mathzetta-sites/src/', './mz/'));
await cp(join(ROOT, 'node_modules/mathzetta-sites/src'), join(ROOT, 'site/mz'), { recursive: true });   // the family's look, header and footer
await cp(join(ROOT, 'demo/photos'), join(ROOT, 'site/photos'), { recursive: true, filter: (p) => !p.endsWith('README.md') && !p.includes('/originals') }).catch(() => {});
// the object model and the runtime that runs it, served from the site itself
await mkdir(join(ROOT, 'site/ort'), { recursive: true });
for (const f of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) await cp(join(ROOT, 'node_modules/onnxruntime-web/dist', f), join(ROOT, 'site/ort', f));
// only the shipped models (the MagicTouch ones were the only users of MediaPipe's runtime, so it isn't copied either)
await rm(join(ROOT, 'site/models'), { recursive: true, force: true });
await rm(join(ROOT, 'site/mediapipe'), { recursive: true, force: true });
await mkdir(join(ROOT, 'site/models'), { recursive: true });
const shipped = SHIPPED_MODELS.flatMap((key) => AI_MODELS[key].files.map((f) => f.replace(/^models\//, '')));
for (const f of [...shipped, 'LICENSE']) await cp(join(ROOT, 'demo/models', f), join(ROOT, 'site/models', f));
// the NOTICE: its heading and the paragraphs about the files shipped
const notice = (await readFile(join(ROOT, 'demo/models/NOTICE'), 'utf8')).split(/\n\n+/);
await writeFile(join(ROOT, 'site/models/NOTICE'), [notice[0], ...notice.slice(1).filter((p) => shipped.some((f) => p.includes(f)))].join('\n\n').trim() + '\n');
// How long browsers keep files (Cloudflare Pages reads _headers; its default makes them ask again on every visit). One rule
// per file, by its exact address — no patterns, so the list (photos/index.json), the pages and the bundles keep the default
// and a deploy shows at once. A model that changes gets a new file name (it is kept a month); the runtime, a day, so its
// .mjs and .wasm can't be from different releases for long; pictures, a week.
{
    const kept = [];
    for (const [dir, seconds, skip] of [['models', 2592000, /^(LICENSE|NOTICE)$/], ['ort', 86400, null], ['photos', 604800, /\.json$/], ['share', 604800, null]]) {
        for (const f of (await readdir(join(ROOT, 'site', dir))).sort()) if (!f.startsWith('.') && !(skip && skip.test(f))) kept.push([`/${dir}/${f}`, seconds]);
    }
    for (const f of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) kept.push([`/${f}`, 604800]);
    await writeFile(join(ROOT, 'site/_headers'), kept.map(([path, seconds]) => `${path}\n  Cache-Control: public, max-age=${seconds}\n`).join(''));
}
console.log(`site: mathzetta ${v.mathzetta} and Inline Math ${v.inlinemath} from the CDN (${await checkCdn(cdnUsed)} addresses checked)`);
console.log('dist/: qblur.js, qblur.global.min.js, qblur-apply.js, qblur-element.js, qblur.core.js, qblur.external.js, qblur.external.global.min.js · site/: index.html, app.js, cpu-worker.js, guide.html, library.html, privacy.html, terms.html, 404.html, robots.txt, sitemap.xml, shioh-style.css, site-theme.css, shioh.js, shell.js, avatar/, splash/, move/, text/, apps.css, mz/, photos/, ort/, models/ (' + shipped.join(', ') + ')');
