/**
 * qblur's frame in the Shioh style (shioh-style.css + site-theme.css): a sticky sidebar — the wordmark
 * and qblur's pages from the family's registry, then a cell with "Made with MathZetta", the other
 * sites and the legal pages — beside the page's own <main>, which becomes the main column. On qblur
 * this takes the place of the family's shared header and footer (mathzetta-sites' mountChrome).
 * On a phone the first cell is a slim bar with a Menu button (shioh.js opens the nav under it), the
 * second cell is hidden, and a footer cell at the end of <main> repeats its essentials (the
 * MathZetta link, privacy, terms).
 *
 *   import { mountShell } from './shell.js';
 *   mountShell({ page: 'avatar', base: '../' });     // base: from this page to the site's root
 *
 * The registry import is the dev address; the build copies this file to site/shell.js with it
 * pointed at site/mz/ (tools/build.mjs).
 */
import { SITES, MATHZETTA_URL } from './mz/sites.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function mountShell({ page = 'home', base = './' } = {}) {
    const qblur = SITES.find((s) => s.id === 'qblur');
    const family = SITES.filter((s) => s.id !== 'qblur' && !s.external && !s.unlisted);
    const href = (p) => base + p.path;
    const nav = qblur.pages.map((p) => `<a href="${esc(href(p))}"${p.id === page ? ' aria-current="page"' : ''} title="${esc(p.what)}">${esc(p.id === 'home' ? 'Editor' : p.name)}</a>`).join('');

    document.body.classList.add('ss');
    const main = document.querySelector('main');
    const shell = document.createElement('div');
    shell.className = 'ss-shell';
    shell.innerHTML = `<aside class="ss-sidebar" aria-label="qblur">
  <section class="ss-cell ss-p1 ss-navcell">
    <a class="ss-logo" href="${esc(base)}">qblur</a>
    <button class="ss-btn ss-menu-btn" type="button" aria-controls="qb-nav">Menu</button>
    <nav class="ss-nav" id="qb-nav" aria-label="qblur's pages">${nav}</nav>
  </section>
  <footer class="ss-cell ss-p4 qb-footer ss-desktop-only">
    <p><b>Made with <a href="${esc(MATHZETTA_URL)}">MathZetta</a></b> — every filter here is maths it reads.</p>
    <p class="qb-family">${family.map((s) => `<a href="${esc(s.url)}" title="${esc(s.tagline)}">${esc(s.name)}</a>`).join('')}</p>
    <p class="qb-family"><a href="${esc(base)}privacy.html">Privacy</a><a href="${esc(base)}terms.html">Terms</a></p>
  </footer>
</aside>`;
    main.classList.add('ss-main');
    if (!main.id) main.id = 'main';
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    const phoneFooter = document.createElement('footer');
    phoneFooter.className = 'ss-cell ss-p4 qb-footer ss-phone-only';
    phoneFooter.innerHTML = `<p><b>Made with <a href="${esc(MATHZETTA_URL)}">MathZetta</a></b></p>
<p class="qb-family"><a href="${esc(base)}privacy.html">Privacy</a><a href="${esc(base)}terms.html">Terms</a></p>`;
    main.append(phoneFooter);
    main.replaceWith(shell);
    shell.append(main);
    const skip = Object.assign(document.createElement('a'), { className: 'qb-skip', href: '#' + main.id, textContent: 'Skip to content' });
    document.body.prepend(skip);
    // code and tables that scroll sideways (the documents, on a phone) must be reachable by keyboard
    for (const el of main.querySelectorAll('pre, .scroll')) if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
    return shell;
}
