/**
 * The sites' addresses, alone. A domain is written here and nowhere else: sites.js (the registry:
 * pages, descriptions) builds on this. A bundle that only needs a link — tabview's embed badge —
 * imports this file, not the registry, so it carries no descriptions.
 */
export const MATHZETTA_URL = 'https://mathzetta.com/';
export const SITE_URLS = {
    math: MATHZETTA_URL,
    inlinemath: 'https://inlinemath.com/',
    code: 'https://tabdn.com/',
    qblur: 'https://qblur.com/',
};
/** Projects built on MathZetta that aren't family sites (they don't use this chrome): MathZetta's home links their examples. */
export const EXTERNAL_URLS = {
    train: 'https://onemorestation.com/',
    ballmonitor: 'https://ballmonitor.com/',
};
/** tabdn's data server (tools/deploy/Caddyfile): hosted tables at /<name>/, databases at /db/<name>/. */
export const DATA_URL = 'https://data.tabdn.com/';
