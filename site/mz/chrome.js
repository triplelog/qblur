/**
 * The header and footer every MathZetta site shares ("the chrome"): the site's name, its pages,
 * a menu of the whole family, and a footer that says it is made with MathZetta and links the rest.
 * Built from sites.js, so a changed domain reaches every page.
 *
 * In a page (site.css linked first):
 *   import { mountChrome } from 'mathzetta-sites/chrome.js';
 *   mountChrome({ site: 'code', page: 'tabc' });
 *     options  site, page      which site this is, and which of its pages (marks the current link)
 *              base            links to this site's own pages relative to here ('./', '../') instead of
 *                              absolute — for a site's own pages, so they work before its domain exists
 *              title           the brand text (default: the site's name); subtitle after it
 *              nav             false: no page links in the header (one-page sites)
 *              footer          false: no footer (full-screen apps put a link elsewhere)
 *              compact         true: a slimmer header for app pages
 *              main            the element the skip link goes to (default: the page's <main>, else
 *                              the element after the header)
 *   mountShowcase(el)          the "what it's used for" list, for MathZetta's home
 *
 * A site whose registry entry says look: 'shioh' (tabdn.com) gets the Shioh frame instead
 * (shioh-style.css, the skill's base unchanged, then shioh-frame.css and shioh.js, all loaded from
 * beside this file): a sticky sidebar with the wordmark and the site's pages, then a cell with
 * "Made with MathZetta", the other sites, privacy and terms; the page's <main> becomes the main
 * column, its content one coloured cell (or the cells it marks itself with .ss-cell). On phones the
 * sidebar is a slim bar with a Menu button and the "Made with" cell comes after the page.
 * shioh.js also gives the page window.ssToast() and window.ssConfirm().
 *
 * Without a DOM (a build script): headerHtml(options), footerHtml(options), showcaseHtml() give the
 * same markup as strings; frameHtml(options, mainHtml) the whole body for either look, and
 * headLinksHtml(siteId, mzBase) the stylesheets it needs.
 */

import { SITES, site, showcase, pageHref, MATHZETTA_URL, MATHZETTA_TAGLINE, SOURCE_URL } from './sites.js';

// the sites the family menu and the footers link: not a separate project, not one that isn't public yet
const listed = () => SITES.filter((s) => !s.external && !s.unlisted);

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function familyMenuHtml(current) {
    return `<ul class="mz-family-menu">${listed().map((s) => `<li><a href="${esc(s.url)}"${s.id === current ? ' aria-current="true"' : ''}>${esc(s.name)}<small>${esc(s.tagline)}</small></a></li>`).join('')}</ul>`;
}

/** The header as HTML. `home` overrides the brand link (default: the site's url). */
export function headerHtml({ site: siteId = 'math', page: pageId = null, base = null, title = null, subtitle = null, nav = true, compact = false, home = null } = {}) {
    const s = site(siteId) || site('math');
    const href = (p) => pageHref(base === null ? s.url : base, p);
    const brand = `<a class="mz-brand" href="${esc(home ?? (base === null ? s.url : base))}">${esc(title ?? s.name)}${subtitle ? `<small>${esc(subtitle)}</small>` : ''}</a>`;
    const pages = nav && s.pages.length > 1
        ? `<nav class="mz-nav" aria-label="${esc(s.name)} pages">${s.pages.filter((p) => p.path !== '').map((p) => `<a href="${esc(href(p))}"${p.id === pageId ? ' aria-current="page"' : ''}>${esc(p.name)}</a>`).join('')}</nav>`
        : '';
    const family = `<details class="mz-family"><summary>${s.id === 'math' ? 'All the sites' : 'More from MathZetta'} <span aria-hidden="true">▾</span></summary>${familyMenuHtml(s.id)}</details>`;
    return `<header class="mz-top${compact ? ' mz-compact' : ''}" role="banner">${brand}${pages}${family}</header>`;
}

/** The footer as HTML: made with MathZetta, and the family. */
export function footerHtml({ site: siteId = 'math' } = {}) {
    const s = site(siteId) || site('math');
    const made = s.id === 'math'
        ? `<p><a class="mz-brand" href="${esc(MATHZETTA_URL)}">MathZetta</a> — ${esc(MATHZETTA_TAGLINE)} <a href="${esc(SOURCE_URL)}">Source</a>.</p>`
        : `<p>Made with <a href="${esc(MATHZETTA_URL)}">MathZetta</a> — ${esc(MATHZETTA_TAGLINE.replace(/\.$/, ''))}. The maths you type here is read by it.</p>`;
    const links = listed().map((x) => `<a href="${esc(x.url)}"${x.id === s.id ? ' aria-current="true"' : ''}>${esc(x.name)}</a>`).join('');
    return `<footer class="mz-foot" role="contentinfo">${made}<nav aria-label="MathZetta sites">${links}</nav></footer>`;
}

/** The "what MathZetta is used for" cards, for its home: every page with a `uses`. */
export function showcaseHtml() {
    return `<ul class="mz-showcase">${showcase().map((p) => `<li><a class="mz-card" href="${esc(p.url)}"><strong>${esc(p.name)}</strong>${p.site.id !== 'math' && p.site.name !== p.name ? `<span class="mz-tag">${esc(p.site.name)}</span>` : ''}<span class="mz-what">${esc(p.what)}</span><span class="mz-uses">${esc(p.uses)}</span></a></li>`).join('')}</ul>`;
}

/**
 * A site's own index page as HTML: its pages as cards (in the site's look). A site with more to say
 * passes `main(cards)` (the main column's HTML, given the cards as <li>s; its own .ss-cell sections),
 * and `title`, `description`, `head` (extra <head> markup).
 */
export function indexHtml(siteId, { title = null, description = null, head = '', main = null } = {}) {
    const s = site(siteId);
    if (!s) throw new Error(`no site ${siteId}`);
    const cards = s.pages.filter((p) => p.path !== '').map((p) => `<li><a class="mz-card" href="${esc(pageHref('', p))}"><strong>${esc(p.name)}</strong><span class="mz-what">${esc(p.what)}</span></a></li>`).join('');
    const frame = frameHtml({ site: siteId, page: 'home', base: './' }, main ? main(cards) : `<h1>${esc(s.name)}</h1>
<p class="lead">${esc(s.tagline)}</p>
<ul class="mz-showcase">${cards}</ul>`);
    return `<!doctype html>
<html lang="en"${frame.htmlClass ? ` class="${frame.htmlClass}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title ?? s.name)}</title>
<meta name="description" content="${esc(description ?? s.tagline)}">
${headLinksHtml(siteId)}${head ? `\n${head}` : ''}
</head>
<body class="${frame.bodyClass}">
${frame.body}
</body>
</html>
`;
}

const fromHtml = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

// ------------------------------------------------------------ the Shioh frame

export const isShioh = (siteId) => site(siteId)?.look === 'shioh';
const FONTS = 'https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Open+Sans:wght@400;600;700&display=swap';
/** The Shioh stylesheets beside this file, in order: the base (the shioh-style skill's, unchanged), then the frame's own rules. */
const SHIOH_CSS = ['shioh-style.css', 'shioh-frame.css'];

/** Each page of a site keeps one cell colour (its place in the registry), so people know where they are. */
export function pageCell(siteId, pageId) {
    const s = site(siteId);
    const i = Math.max(0, s?.pages.findIndex((p) => p.id === pageId) ?? 0);
    return `ss-p${[4, 2, 3, 5, 1][i % 5]}`;
}

/** "Made with MathZetta", the other sites, privacy and terms: the sidebar's last cell, and again after the page on phones. */
function frameFootHtml(s, home, where) {
    const family = listed().filter((x) => x.id !== s.id).map((x) => `<a href="${esc(x.url)}" title="${esc(x.tagline)}">${esc(x.name)}</a>`).join('');
    return `<footer class="ss-cell ss-p4 ss-frame-foot ${where}" role="contentinfo">
    <p>Made with <a href="${esc(MATHZETTA_URL)}">MathZetta</a> — ${esc(MATHZETTA_TAGLINE.replace(/\.$/, ''))}. The maths you type here is read by it.</p>
    <p class="ss-family">${family}</p>
    <p class="ss-family"><a href="${esc(home)}privacy.html">Privacy</a><a href="${esc(home)}terms.html">Terms</a></p>
  </footer>`;
}

/** The sidebar: the wordmark and the site's pages (a slim bar with a Menu button on phones), then "Made with MathZetta", the other sites, privacy and terms. */
export function sidebarHtml({ site: siteId = 'math', page: pageId = null, base = null } = {}) {
    const s = site(siteId) || site('math');
    const home = base === null ? s.url : base;
    const current = (id) => (id === pageId ? ' aria-current="page"' : '');
    const nav = [`<a href="${esc(home)}"${current('home')}>Home</a>`,
        ...s.pages.filter((p) => p.path !== '').map((p) => `<a href="${esc(pageHref(home, p))}"${current(p.id)} title="${esc(p.what)}">${esc(p.name)}</a>`)].join('');
    return `<aside class="ss-sidebar" aria-label="${esc(s.name)}">
  <section class="ss-cell ss-p1 ss-navcell"><a class="ss-logo" href="${esc(home)}">${esc(s.name)}</a><button class="ss-btn ss-menu-btn" type="button" aria-controls="ss-site-nav" aria-expanded="false">Menu</button><nav class="ss-nav" id="ss-site-nav" aria-label="${esc(s.name)} pages">${nav}</nav></section>
  ${frameFootHtml(s, home, 'ss-desktop-only')}
</aside>`;
}

/** The phone's copy of the sidebar's last cell, after the main column. */
export function phoneFootHtml({ site: siteId = 'math', base = null } = {}) {
    const s = site(siteId) || site('math');
    return frameFootHtml(s, base === null ? s.url : base, 'ss-phone-only');
}

/** The stylesheets a page of the site needs, for a build script: mzBase is where mz/ is from the page. */
export function headLinksHtml(siteId, mzBase = 'mz/') {
    const css = `<link rel="stylesheet" href="${esc(mzBase)}site.css">`;
    // ss-js before the stylesheets: the phone menu starts closed, without a flash of the open nav
    return isShioh(siteId)
        ? `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="${FONTS}">\n<script>document.documentElement.classList.add('ss-js')</script>\n${css}\n${SHIOH_CSS.map((f) => `<link rel="stylesheet" href="${esc(mzBase)}${f}">`).join('\n')}\n<script src="${esc(mzBase)}shioh.js" defer></script>`
        : css;
}

/**
 * A page's body for either look, for a build script: the header, <main> and the footer, or the Shioh
 * frame around <main>. mainHtml is the main content (one cell unless it has its own .ss-cell).
 * @returns {{ htmlClass, bodyClass, body }}
 */
export function frameHtml(options, mainHtml) {
    const { site: siteId = 'math', page: pageId = 'home' } = options;
    if (!isShioh(siteId)) {
        return { htmlClass: '', bodyClass: 'mz', body: `${headerHtml(options)}\n<main id="main" tabindex="-1">\n${mainHtml}\n</main>\n${footerHtml(options)}` };
    }
    const inner = /class="[^"]*\bss-cell\b/.test(mainHtml) ? mainHtml : `<section class="ss-cell ${pageCell(siteId, pageId)}">\n${mainHtml}\n</section>`;
    return {
        htmlClass: 'mz-light', bodyClass: 'mz ss',
        body: `<a class="mz-skip" href="#main">Skip to content</a>\n<div class="ss-shell">\n${sidebarHtml(options)}\n<main id="main" class="ss-main" tabindex="-1">\n${inner}\n</main>\n${phoneFootHtml(options)}\n</div>`,
    };
}

function mountShioh(options) {
    const { site: siteId, page: pageId = null } = options;
    // the fonts, the two stylesheets and shioh.js (beside this file), unless the page links them already
    const have = (re) => [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => re.test(l.href));
    if (!have(/fonts\.googleapis\.com/)) document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: FONTS }));
    for (const f of SHIOH_CSS) {
        if (!have(new RegExp(`(^|/)${f.replace('.', '\\.')}$`))) document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL(`./${f}`, import.meta.url).href }));
    }
    if (![...document.scripts].some((x) => /(^|\/)shioh\.js$/.test(x.src))) document.head.append(Object.assign(document.createElement('script'), { src: new URL('./shioh.js', import.meta.url).href }));
    // Shioh cells are light pastels: the page's own UI keeps the light palette, whatever the system's;
    // ss-js before the frame is in the page, so the phone menu starts closed
    document.documentElement.classList.add('mz-light', 'ss-js');
    document.body.classList.add('mz', 'ss');   // body.mz: site.css's controls; body.ss: the frame (the Shioh stylesheets, linked after, win)
    const main = options.main ?? document.querySelector('main');
    if (!main.id) main.id = 'main';
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    const shell = Object.assign(document.createElement('div'), { className: 'ss-shell' });
    const cell = Object.assign(document.createElement('section'), { className: `ss-cell ${pageCell(siteId, pageId)}` });
    // what the page shows: everything in <body> but scripts and styles
    const content = [...document.body.childNodes].filter((n) => (n.nodeType === 1 && !/^(SCRIPT|STYLE|TEMPLATE|LINK)$/.test(n.tagName)) || (n.nodeType === 3 && n.textContent.trim()));
    if (content.length === 1 && content[0] === main) {
        // the usual page: <main> becomes the column, its content one cell (unless it lays out its own)
        if (!main.querySelector(':scope > .ss-cell')) {
            cell.append(...main.childNodes);
            main.append(cell);
        }
        main.classList.add('ss-main');
        main.replaceWith(shell);
        shell.append(fromHtml(sidebarHtml(options)), main);
    } else {
        // an app page (its own header, lists, then <main>): all of it goes in one cell of the column
        const column = Object.assign(document.createElement('div'), { className: 'ss-main' });
        content[0].before(shell);
        cell.append(...content);
        column.append(cell);
        shell.append(fromHtml(sidebarHtml(options)), column);
    }
    shell.append(fromHtml(phoneFootHtml(options)));
    document.body.prepend(fromHtml(`<a class="mz-skip" href="#${main.id}">Skip to content</a>`));
    for (const el of main.querySelectorAll('pre, .scroll')) if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
    const aside = shell.querySelector('.ss-sidebar');
    menu(aside.querySelector('.ss-navcell'));
    return { header: aside, footer: aside.querySelector('footer') };
}

/**
 * The phone menu, wired here so it works however the page loads shioh.js (or before it arrives):
 * the same behaviour as shioh.js's, which skips a button marked data-ss-menu.
 */
function menu(cell) {
    const btn = cell.querySelector('.ss-menu-btn');
    btn.dataset.ssMenu = '1';
    const set = (open) => { cell.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open)); btn.textContent = open ? 'Close' : 'Menu'; };
    btn.addEventListener('click', () => set(!cell.classList.contains('open')));
    cell.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cell.classList.contains('open')) { set(false); btn.focus(); } });
    for (const a of cell.querySelectorAll('.ss-nav a')) a.addEventListener('click', () => set(false));
}

/** Put the header first in <body>, the footer last, and a skip link to the main content (or, for a Shioh site, its frame). */
export function mountChrome(options = {}) {
    if (isShioh(options.site)) return mountShioh(options);
    const { footer = true, main = null } = options;
    const head = fromHtml(headerHtml(options));
    document.body.prepend(head);
    const target = main ?? document.querySelector('main') ?? head.nextElementSibling;
    if (target) {
        if (!target.id) target.id = 'main';
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        const skip = fromHtml(`<a class="mz-skip" href="#${target.id}">Skip to content</a>`);
        document.body.prepend(skip);
    }
    // the family menu closes on Escape, or on a click elsewhere
    const details = head.querySelector('.mz-family');
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && details.open) { details.open = false; details.querySelector('summary').focus(); } });
    document.addEventListener('click', (e) => { if (details.open && !details.contains(e.target)) details.open = false; });
    let foot = null;
    if (footer) { foot = fromHtml(footerHtml(options)); document.body.append(foot); }
    // on a document page, code blocks and table wrappers that scroll sideways on a phone must be reachable by keyboard
    if (document.body.classList.contains('mz')) for (const el of document.querySelectorAll('pre, .scroll')) if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
    return { header: head, footer: foot };
}

/** Fill `el` with the showcase cards. */
export function mountShowcase(el) {
    el.innerHTML = showcaseHtml();
    return el;
}
