/**
 * Just enough Markdown for docs/filters.md → site/guide.html: headings
 * (with GitHub-style ids, so links to the guide work on GitHub and on the
 * site alike), paragraphs, fenced code, tables, bullet lists, > notes, and inline
 * code / bold / italic / links. No dependencies.
 */

/** A heading's id the way GitHub makes it: "Results: numbers, colours, true/false" → results-numbers-colours-truefalse */
export function slug(text) {
    return text.toLowerCase().replace(/`/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(text) {
    const codes = [];
    let s = esc(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

export function markdownToHtml(md) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) { i++; continue; }
        if (line.startsWith('```')) {                                   // fenced code
            const block = [];
            for (i++; i < lines.length && !lines[i].startsWith('```'); i++) block.push(lines[i]);
            i++;
            out.push(`<pre><code>${esc(block.join('\n'))}</code></pre>`);
            continue;
        }
        const heading = /^(#{1,4}) (.+)$/.exec(line);
        if (heading) {
            const level = heading[1].length;
            out.push(`<h${level} id="${slug(heading[2])}">${inline(heading[2])}</h${level}>`);
            i++;
            continue;
        }
        if (line.startsWith('|')) {                                     // table: header, separator, rows
            const rows = [];
            for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i]);
            const cells = (row) => row.replace(/^\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map((c) => inline(c.replace(/\\\|/g, '|').trim()));
            const [head, , ...body] = rows;
            out.push('<table>', `<tr>${cells(head).map((c) => `<th>${c}</th>`).join('')}</tr>`,
                ...body.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`), '</table>');
            continue;
        }
        if (/^[-*] /.test(line)) {                                      // bullets, continued by indented lines
            const items = [];
            while (i < lines.length && /^[-*] /.test(lines[i])) {
                let item = lines[i].slice(2);
                for (i++; i < lines.length && /^\s{2,}\S/.test(lines[i]); i++) item += ' ' + lines[i].trim();
                items.push(item);
            }
            out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
            continue;
        }
        if (line.startsWith('>')) {                                     // a note: > lines, one paragraph
            const quote = [];
            for (; i < lines.length && lines[i].startsWith('>'); i++) quote.push(lines[i].replace(/^>\s?/, ''));
            out.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`);
            continue;
        }
        const para = [];                                                // a paragraph: lines until a blank or a block
        while (i < lines.length && lines[i].trim() && !/^(#{1,4} |```|\||[-*] |>)/.test(lines[i])) para.push(lines[i++].trim());
        out.push(`<p>${inline(para.join(' '))}</p>`);
    }
    return out.join('\n');
}

/** The guide as the site shows it: the parts between `<!-- dev -->` and `<!-- /dev -->` (for people working on qblur or using
 *  the package: repo paths, npm scripts, the API) left out; on GitHub the markers are invisible and everything shows. */
export const forSite = (md) => md.replace(/^<!-- dev -->\n[\s\S]*?^<!-- \/dev -->\n*/gm, '');

/** A complete page around the guide, in the family's style (mathzetta-sites: mz/ beside the page). */
export function guidePage(md, { title = 'qblur · the guide', back = 'index.html', page = 'guide' } = {}) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Open+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<script>document.documentElement.classList.add('ss-js')</script>
<link rel="stylesheet" href="shioh-style.css">
<link rel="stylesheet" href="site-theme.css">
<style>
  h2, h3 { scroll-margin-top: 1rem; }
  main p a { color: var(--mz-accent); }
  blockquote { margin: 1rem 0; padding: .6rem 1rem; border-left: 4px solid var(--mz-accent); background: var(--mz-soft); border-radius: 0 var(--ss-radius-sm) var(--ss-radius-sm) 0; }
  blockquote p { margin: 0; }
  p code, li code, td code { overflow-wrap: anywhere; }      /* a long address or name wraps on a phone */
</style>
</head>
<body class="ss">
<main>
<article class="ss-cell qb-doc">
<p><a href="${esc(back)}">← the editor</a></p>
${markdownToHtml(md).replace(/<table>/g, '<div class="scroll" tabindex="0"><table>').replace(/<\/table>/g, '</table></div>')}
</article>
</main>
<script type="module">
import { mountShell } from './shell.js';
mountShell({ page: '${page}', base: './' });
</script>
<script src="shioh.js" defer></script>
</body>
</html>
`;
}
