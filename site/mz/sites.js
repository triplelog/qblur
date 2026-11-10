/**
 * The MathZetta family of sites: where each one lives and what is on it. A domain is written in
 * urls.js (this file reads it from there): mathzetta.com, inlinemath.com, qblur.com and tabdn.com are final;
 * a site whose domain isn't gets a stand-in `url` and `placeholder: true`; a site that isn't public
 * yet is `unlisted: true`. Every page, header, footer and the "used for" list on MathZetta's home
 * read their links from here.
 *
 *   import { SITES, site, pageUrl, showcase } from 'mathzetta-sites';
 *   pageUrl('code', 'tabc')   →  'https://tabdn.com/tabc/'
 *
 * A site: { id, name, url, tagline, placeholder?, unlisted?, external?, pages: [ { id, name, path, what, uses? } ] }.
 *   path      relative to the site's url ('' is the site's home), or a full address for a page served
 *             elsewhere (tabdn's hosted tables, on the data server): pageHref()
 *   what      what a visitor can do there (the site's own index and the headers use it)
 *   uses      how it uses MathZetta — the pages with one appear on MathZetta's home as examples
 *   unlisted  not public yet: its own pages mount the chrome as usual, but the family menu, the
 *             footers and MathZetta's home leave it out until the flag goes
 *   external  built on MathZetta but a separate project: shown among the examples on MathZetta's
 *             home, not in the family menu or the footers (it doesn't use this chrome)
 */

import { MATHZETTA_URL, SITE_URLS, EXTERNAL_URLS, DATA_URL } from './urls.js';
export { MATHZETTA_URL, SITE_URLS };
export const MATHZETTA_TAGLINE = 'Maths written any way, read into one form, written out every way.';
export const SOURCE_URL = 'https://github.com/triplelog/mathzetta';

// a stand-in for a site whose domain isn't chosen: change the URL here, nothing else
const placeholder = (name) => `https://${name}.mathzetta.com/`;

export const SITES = [
    {
        id: 'math', name: 'MathZetta', url: MATHZETTA_URL, tagline: MATHZETTA_TAGLINE,
        pages: [
            { id: 'home', name: 'MathZetta', path: '', what: 'what it reads, what it writes, the API' },
            { id: 'playground', name: 'Playground', path: 'demos/', what: 'type maths and see the postfix, the tree and every output' },
            { id: 'convert', name: 'Convert', path: 'convert/', what: 'maths in any notation — text, LaTeX, JavaScript, Python, SQL, GLSL — to every format, copyable',
                uses: 'every outputter at once, and each output read back to check it means the same' },
            { id: 'operators', name: 'Operators', path: 'demos/operations.html', what: 'what each operator reads and writes as' },
            { id: 'quiz', name: 'Postfix quiz', path: 'quiz.html', what: 'learn the postfix algorithm: turn an expression into postfix one move at a time, with hints',
                uses: 'the quiz’s precedences come from the operator table and every answer is checked against parse()' },
            { id: 'rules', name: 'CAS', path: 'cas/', what: 'MathZetta CAS: derivatives and simplification as rules you can read and change',
                uses: 'rewriting the postfix with YAML rules: differentiation, simplification, an exact CAS (@mathzetta/cas)' },
            { id: 'api', name: 'API', path: 'api.html', what: 'the functions, with live examples' },
            { id: 'cdn', name: 'CDN', path: 'cdn.html', what: 'tick the outputs a page needs and get the tag, the imports or an import map from jsDelivr, with the size' },
            { id: 'tests', name: 'Test runner', path: 'demos/test-runner.html', what: 'the checks, run in your browser' },
        ],
    },
    {
        // the Inline Math library's site
        id: 'inlinemath', name: 'Inline Math', url: SITE_URLS.inlinemath,
        tagline: 'Maths drawn as HTML and CSS, every part of it addressable.',
        pages: [
            { id: 'home', name: 'Inline Math', path: '', what: 'a gallery of drawn maths, each part findable, colourable, animated between steps',
                uses: 'draws anything MathZetta reads; node ids are postfix positions, so a spoken word or a rule step lights up the part it means' },
            { id: 'markdown', name: 'Markdown', path: 'markdown.html', what: 'Markdown with maths, {{…}} worked out, definitions remembered' },
            { id: 'cas', name: 'CAS', path: 'cas.html', what: 'simplify, solve and differentiate, the steps drawn as maths' },
            { id: 'print', name: 'Print', path: 'print.html', what: 'quizzes, tests and worksheets to print or save as PDF, with answer keys and step-by-step solutions' },
        ],
    },
    {
        // tabdn: data tables only — a CSV becomes a .com table server (tabc), tables in the browser (tabview),
        // the examples. sqldn, pyslots and the Sheets sidebar are kept in their repos but are off this site
        // (pyslots' charts are on Ball Monitor, below).
        id: 'code', name: 'tabdn', url: SITE_URLS.code, look: 'shioh',
        tagline: 'Data tables of any size: a CSV becomes one file that serves it, or a table that runs in the page — filters written as maths.',
        pages: [
            { id: 'home', name: 'tabdn', path: '', what: 'everything here' },
            { id: 'tabc', name: 'Build a table server', path: 'tabc/', what: 'a CSV becomes one file that serves it: filter, sort, group and pivot millions of rows; built in your browser',
                uses: 'a filter typed as maths becomes tabc’s query grammar (mathzetta/formulas)' },
            { id: 'tables', name: 'Hosted tables', path: DATA_URL, what: 'tables served by tabc: every Retrosheet batting and pitching line, and more' },
            { id: 'examples', name: 'Tables in a web page', path: 'examples/', what: '2025 batting and pitching, running entirely in the browser' },
            { id: 'weather', name: 'Population and weather', path: 'examples/population-and-weather/', what: 'a world map coloured by your formulas over each place’s climate, similar climates, and the outlines of regions that match your criteria',
                uses: 'each formula becomes a checked JavaScript function (tabview’s compiler) run over 41,141 cells; the cells are also a tabview table' },
            { id: 'generator', name: 'Make an embeddable table', path: 'tabview/generator/', what: 'a CSV becomes a table you paste into any page',
                uses: 'formulas compiled to JavaScript loops over the columns, in the visitor’s browser' },
            { id: 'tabview', name: 'Table demo', path: 'tabview/demo/', what: 'batting data in the browser: filter, add columns, group, pivot, export to .xlsx with live formulas' },
            { id: 'help', name: 'Help', path: 'help.html', what: 'how to write a filter, add and arrange columns, group and export; running and hosting your own table server' },
        ],
    },
    {
        // qblur' site
        id: 'qblur', name: 'qblur', url: SITE_URLS.qblur,
        tagline: 'Image filters written as maths.',
        pages: [
            { id: 'home', name: 'qblur', path: '', what: 'write a filter as a formula, see it on a picture, share it',
                uses: 'a formula over pixel values compiled to a WebGL shader (mathzetta/glsl), with a CPU fallback from the same formula' },
            { id: 'avatar', name: 'Profile picture', path: 'avatar/', what: 'a profile picture from any photo: centred on you, in a style, the background blurred, replaced or removed (a cut-out sticker)' },
            { id: 'splash', name: 'Colour splash', path: 'splash/', what: 'click a colour to keep it; the rest of the photo turns grey' },
            { id: 'move', name: 'Make it move', path: 'move/', what: 'a photo with a wave, a ripple, a slow zoom or a glitch, saved as a GIF or a video' },
            { id: 'text', name: 'Fancy text', path: 'text/', what: 'words as a picture: gold, chrome, fire, a photo inside the letters, or any formula for the letters and their border' },
            { id: 'guide', name: 'Guide', path: 'guide.html', what: 'how filters are written' },
            { id: 'library', name: 'On your site', path: 'library.html', what: 'qblur on your own pages: one script from a CDN, the API, examples' },
        ],
    },
    {
        // not public yet (mathtutor and calcvidnew stay private for now): its pages mount the chrome,
        // the rest of the family doesn't link it
        id: 'learn', name: 'Learn', url: placeholder('learn'), placeholder: true, unlisted: true,
        tagline: 'Practice with explained steps, and videos that talk you through them.',
        pages: [
            { id: 'practice', name: 'Practice', path: '', what: 'algebra practice that names the mistake, with classes and reports for teachers',
                uses: 'every step a student types is read by MathZetta and matched against the course’s rules; mastered steps are done for them' },
            { id: 'videos', name: 'Videos', path: 'videos/', what: 'a derivative worked out step by step, narrated',
                uses: 'the narration comes from mathzetta/speech, each spoken word tied to the part of the maths it describes' },
        ],
    },
    {
        // a separate project (../../simplewebapps/onemorestation): an example of use, not a family site
        id: 'train', name: 'One More Station', url: EXTERNAL_URLS.train, external: true,
        tagline: 'A train-network game on a real map.',
        pages: [
            { id: 'home', name: 'One More Station', path: '', what: 'build a network, run the trains',
                uses: 'the game’s numbers come from formulas written as maths, read and evaluated by MathZetta' },
            { id: 'help', name: 'How to play', path: 'help.html', what: 'the rules' },
        ],
    },
    {
        // a separate project (../other/ballmonitor): sports forecasts; its Python charts are pyslots'
        // embeddable form (ballmonitor scripts/sync-charts.sh copies it in)
        id: 'ballmonitor', name: 'Ball Monitor', url: EXTERNAL_URLS.ballmonitor, external: true,
        tagline: 'Sports odds in plain numbers.',
        pages: [
            { id: 'charts', name: 'Baseball charts', path: '#/charts', what: 'charts of 150 years of baseball seasons, from formulas you write; Python runs in your browser',
                uses: 'each formula fills a slot of a Python (matplotlib) program as a checked Python function (mathzetta/python), drawn as maths while you type' },
        ],
    },
];

/** A site by id, or undefined. */
export const site = (id) => SITES.find((s) => s.id === id);

/** A page's link from `base` (the site's url, or a relative base): base + path, or the path itself when it is a full address. */
export const pageHref = (base, p) => (/^https?:\/\//.test(p.path) ? p.path : base + p.path);

/** A page's full URL: the site's url + the page's path. */
export function pageUrl(siteId, pageId = 'home') {
    const s = site(siteId);
    if (!s) throw new Error(`no site ${siteId}`);
    const p = s.pages.find((x) => x.id === pageId);
    if (!p) throw new Error(`no page ${pageId} on ${siteId}`);
    return pageHref(s.url, p);
}

/** The pages that show what MathZetta is used for, with their site: MathZetta's home lists them (not an unlisted site's). */
export const showcase = () => SITES.filter((s) => !s.unlisted).flatMap((s) => s.pages.filter((p) => p.uses).map((p) => ({ ...p, site: s, url: pageHref(s.url, p) })));
