/**
 * Text and shapes as pictures.
 *
 * A filter's `graphics` names things to draw — text, rectangles, ovals —
 * each rasterized into a transparent picture the size of the frame under
 * its name. The maths then treats it like any picture: `title` is its
 * colour, `alpha(title)` where it is, so
 *
 *   mix(rgb, title, alpha(title))                      lays the text on
 *   mix(rgb, gaussian(6) * 0.8, alpha(panel))          frosts the picture behind a panel
 *   mix(rgb, shift(title, 3t, 0), alpha(shift(title, 3t, 0)))   scrolls it
 *
 * A graphic's `shadow` is drawn into it. Its `shadows` — a list, back to
 * front — are drawn each into a picture of its own, `title_shadow1`,
 * `title_shadow2`…, so every shadow layer can have its own maths:
 *
 *   mix(mix(rgb, gaussian(4), alpha(title_shadow1)), title, alpha(title))
 *   mix(mix(rgb, (1, 0.3, 0.6) , alpha(shift(title_shadow1, 2 sin(t / 9), 0))), title, alpha(title))
 *
 * Positions and sizes are fractions of the frame (x, y 0–1; sizes of its
 * height), so a graphic drawn again at export size is crisp and in the
 * same place. Angles are radians, like everything else here.
 *
 *   normalizeGraphic(name, spec)        the full spec, or an error naming what is wrong
 *   drawGraphic(ctx, spec, w, h)        onto any 2D context (canvas, OffscreenCanvas)
 *   await loadGraphicFonts(graphics)    web fonts named by fontUrl, before drawing
 *   await renderGraphics(compiled, w, h) → { key: canvas } for runner.setImage(key, canvas)
 *   (keys are the names, made unique across a chain: `title`, `title~2`…)
 */

import { normalizeStrokes, rasterizeStrokes } from './strokes.js';

export const GRAPHIC_TYPES = ['text', 'rect', 'ellipse', 'strokes'];

/** What each kind of graphic is, unless said otherwise. */
export const GRAPHIC_DEFAULTS = {
    text: {
        type: 'text', text: 'Text', font: 'sans-serif', weight: 'bold', style: 'normal', size: 0.08,
        x: 0.5, y: 0.85, align: 'center', angle: 0, lineHeight: 1.2, color: '#ffffff',
        outline: null, shadow: { color: 'rgba(0,0,0,0.6)', blur: 0.15, dx: 0.04, dy: 0.06 }, shadows: [],
    },
    rect: { type: 'rect', x: 0.5, y: 0.85, w: 0.8, h: 0.18, radius: 0.15, angle: 0, color: '#ffffff', outline: null, shadow: null, shadows: [] },
    ellipse: { type: 'ellipse', x: 0.5, y: 0.5, w: 0.4, h: 0.4, angle: 0, color: '#ffffff', outline: null, shadow: null, shadows: [] },
};

/** At most this many separate shadow layers per graphic. */
export const MAX_SHADOW_LAYERS = 8;

/**
 * The picture names of a graphic's separate shadow layers, back to front:
 * title_shadow1, title_shadow2… Each is a picture of that shadow alone, so
 * the maths can treat it on its own (blur it, colour it, move it with t).
 */
export const shadowLayerNames = (name, spec) => (spec.shadows ?? []).map((_, k) => `${name}_shadow${k + 1}`);

/** The maths that lays a graphic on with its shadow layers, back to front — what a new text step starts with. */
export function layeredExpression(name, spec) {
    let base = 'rgb';
    for (const layer of shadowLayerNames(name, spec)) base = `mix(${base}, ${layer}, alpha(${layer}))`;
    return `mix(${base}, ${name}, alpha(${name}))`;
}

const COLOUR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d.,\s%deg/]+\)|[a-z]{3,20}|transparent)$/i;
const FAMILY = /^[\w\s,'"-]{1,80}$/;
const WEIGHTS = ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'];

function colour(name, key, value) {
    if (typeof value !== 'string' || !COLOUR.test(value.trim())) throw new Error(`Graphic "${name}": "${key}" is a colour like "#ffcc00", "rgba(0,0,0,0.5)" or "white"`);
    return value.trim();
}

function number(name, key, value, min = -Infinity, max = Infinity) {
    const v = Number(value);
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`Graphic "${name}": "${key}" is a number${Number.isFinite(min) ? ` from ${min} to ${max}` : ''}`);
    return v;
}

/** `{ color, width }` around the text or shape; width is a fraction of the text size (or of the frame height for shapes). */
function outline(name, value) {
    if (value === null || value === false) return null;
    if (typeof value !== 'object') throw new Error(`Graphic "${name}": "outline" is { "color", "width" } or null`);
    return { color: colour(name, 'outline.color', value.color ?? '#000000'), width: number(name, 'outline.width', value.width ?? 0.06, 0, 1) };
}

/** `{ color, blur, dx, dy }` behind it; blur and offsets are fractions of the text size (frame height for shapes). */
function shadow(name, value) {
    if (value === null || value === false) return null;
    if (typeof value !== 'object') throw new Error(`Graphic "${name}": "shadow" is { "color", "blur", "dx", "dy" } or null`);
    return {
        color: colour(name, 'shadow.color', value.color ?? 'rgba(0,0,0,0.6)'),
        blur: number(name, 'shadow.blur', value.blur ?? 0.15, 0, 2),
        dx: number(name, 'shadow.dx', value.dx ?? 0, -2, 2),
        dy: number(name, 'shadow.dy', value.dy ?? 0, -2, 2),
    };
}

/** The whole spec, defaults filled in; throws a message naming the graphic and the setting. */
export function normalizeGraphic(name, spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`Graphic "${name}": give { "type": "text" | "rect" | "ellipse", … }`);
    const type = spec.type ?? 'text';
    if (!GRAPHIC_TYPES.includes(type)) throw new Error(`Graphic "${name}": "type" is text, rect, ellipse or strokes — not "${type}"`);
    if (type === 'strokes') return normalizeStrokes(name, spec);         // brush strokes: src/strokes.js
    const base = GRAPHIC_DEFAULTS[type];
    for (const key of Object.keys(spec)) if (!(key in base) && key !== 'fontUrl' && key !== 'onlyShadow') throw new Error(`Graphic "${name}": no such setting "${key}" for ${type}`);
    const out = { type };
    for (const [key, fallback] of Object.entries(base)) {
        if (key === 'type') continue;
        const value = key in spec && spec[key] !== undefined ? spec[key] : fallback;     // null is a value: "no shadow"
        if (key === 'color') out.color = colour(name, key, value);
        else if (key === 'outline') out.outline = outline(name, value);
        else if (key === 'shadow') out.shadow = shadow(name, value);
        else if (key === 'shadows') {
            if (!Array.isArray(value) || value.length > MAX_SHADOW_LAYERS) throw new Error(`Graphic "${name}": "shadows" is a list of up to ${MAX_SHADOW_LAYERS} { "color", "blur", "dx", "dy" }`);
            out.shadows = value.map((layer, k) => {
                if (!layer || typeof layer !== 'object') throw new Error(`Graphic "${name}": shadow layer ${k + 1} is { "color", "blur", "dx", "dy" }`);
                return shadow(name, layer);
            });
        }
        else if (key === 'text') {
            if (typeof value !== 'string' || value.length > 500) throw new Error(`Graphic "${name}": "text" is up to 500 characters`);
            out.text = value;
        } else if (key === 'font') {
            if (typeof value !== 'string' || !FAMILY.test(value)) throw new Error(`Graphic "${name}": "font" is a font family, like "Georgia" or "sans-serif"`);
            out.font = value;
        } else if (key === 'weight') {
            if (!WEIGHTS.includes(String(value))) throw new Error(`Graphic "${name}": "weight" is normal, bold or 100–900`);
            out.weight = String(value);
        } else if (key === 'style') {
            if (!['normal', 'italic'].includes(value)) throw new Error(`Graphic "${name}": "style" is normal or italic`);
            out.style = value;
        } else if (key === 'align') {
            if (!['left', 'center', 'right'].includes(value)) throw new Error(`Graphic "${name}": "align" is left, center or right`);
            out.align = value;
        } else if (key === 'size') out.size = number(name, key, value, 0.005, 2);
        else if (key === 'w' || key === 'h') out[key] = number(name, key, value, 0, 4);
        else if (key === 'radius') out.radius = number(name, key, value, 0, 0.5);
        else if (key === 'lineHeight') out.lineHeight = number(name, key, value, 0.5, 4);
        else out[key] = number(name, key, value);                       // x, y, angle
    }
    if (spec.fontUrl !== undefined && spec.fontUrl !== null && spec.fontUrl !== '') {
        if (type !== 'text') throw new Error(`Graphic "${name}": "fontUrl" is for text`);
        let url;
        try { url = new URL(spec.fontUrl); } catch { url = null; }
        if (!url || url.protocol !== 'https:') throw new Error(`Graphic "${name}": "fontUrl" is an https:// address of a font file (.woff2, .woff, .ttf, .otf) or of a Google Fonts stylesheet`);
        out.fontUrl = url.href;
    }
    if (spec.onlyShadow !== undefined) out.onlyShadow = number(name, 'onlyShadow', spec.onlyShadow, 0, MAX_SHADOW_LAYERS - 1);   // set by the compiler for a layer's picture
    return out;
}

/** A Google Fonts stylesheet address for a family name: "Lobster" → https://fonts.googleapis.com/css2?family=Lobster:… */
export function googleFontUrl(family) {
    const name = String(family).trim().replace(/\s+/g, ' ');
    if (!/^[A-Za-z0-9 ]{1,60}$/.test(name)) throw new Error('A Google Fonts name is letters, digits and spaces, like "Lobster" or "Playfair Display"');
    return `https://fonts.googleapis.com/css2?family=${name.replace(/ /g, '+')}:ital,wght@0,400;0,700;1,400;1,700&display=swap`;
}

/** The family a Google Fonts address names ("Playfair Display"), or null. */
export function googleFontFamily(url) {
    try {
        const u = new URL(url);
        if (u.hostname !== 'fonts.googleapis.com') return null;
        return (u.searchParams.get('family') ?? '').split(':')[0].replace(/\+/g, ' ') || null;
    } catch { return null; }
}

/**
 * The font file a stylesheet points at — for a Google Fonts css2 address, the
 * latin face of the weight and style wanted (its last block for that face).
 */
export function fontFileFromCss(css, { weight = '400', style = 'normal' } = {}) {
    const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
    const prop = (block, key) => (new RegExp(`${key}\\s*:\\s*([^;]+);`).exec(block)?.[1] ?? '').trim();
    const want = String(weight === 'bold' ? 700 : weight === 'normal' ? 400 : weight);
    const pick = faces.filter((f) => prop(f, 'font-weight') === want && prop(f, 'font-style') === style);
    const block = (pick.length ? pick : faces).at(-1);
    return block ? (/url\(([^)]+)\)/.exec(block)?.[1] ?? '').replace(/^['"]|['"]$/g, '') || null : null;
}

/** The CSS font for a text graphic at frame height `h`. Fonts loaded from fontUrl are known by the url-derived family. */
export function cssFont(spec, h) {
    const family = spec.fontUrl ? `"${familyFor(spec.fontUrl)}", ${spec.font}` : spec.font;
    return `${spec.style} ${spec.weight} ${Math.max(1, spec.size * h)}px ${family}`;
}

/** A stable, safe family name for a font loaded from a URL. */
export function familyFor(url) {
    let hash = 0;
    for (const ch of url) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return `mz-font-${hash.toString(36)}`;
}

const loadedFonts = new Map();

/**
 * Loads every fontUrl among the graphics (once each per weight and style) and waits for
 * the families to be usable. A font file is used as it is; a stylesheet (Google Fonts)
 * is read for the file of the weight and style the text uses.
 * @returns {Promise<string[]>} the addresses that could not be loaded
 */
export async function loadGraphicFonts(graphics, h = 100) {
    if (typeof document === 'undefined' && typeof self === 'undefined') return [];
    const fonts = typeof document !== 'undefined' ? document.fonts : self.fonts;
    if (!fonts) return [];
    const failed = [];
    for (const spec of Object.values(graphics ?? {})) {
        if (spec.type !== 'text') continue;
        if (spec.fontUrl && typeof FontFace !== 'undefined') {
            const key = `${spec.fontUrl} ${spec.weight} ${spec.style}`;
            if (!loadedFonts.has(key)) loadedFonts.set(key, loadFace(spec, fonts));
            if (!(await loadedFonts.get(key))) failed.push(spec.fontUrl);
        }
        try { await fonts.load(cssFont(spec, h), spec.text); } catch { /* an unknown family falls back, as CSS does */ }
    }
    return [...new Set(failed)];
}

async function loadFace(spec, fonts) {
    try {
        let file = spec.fontUrl;
        if (!/\.(woff2?|ttf|otf)(\?|$)/i.test(new URL(file).pathname) || googleFontFamily(file)) {
            const css = await (await fetch(file)).text();
            file = fontFileFromCss(css, spec);
            if (!file || !file.startsWith('https://')) return null;
        }
        const face = new FontFace(familyFor(spec.fontUrl), `url(${JSON.stringify(file)})`, { weight: spec.weight, style: spec.style });
        fonts.add(await face.load());
        return face;
    } catch { return null; }
}

/** Draws one graphic onto a w × h context (cleared first by the caller). */
export function drawGraphic(ctx, spec, w, h) {
    ctx.save();
    const unit = spec.type === 'text' ? spec.size * h : h;            // shadow and outline sizes scale with this
    // A shadow layer alone: the shape is drawn far off to the left and only its shadow is thrown back onto the frame.
    const layer = spec.onlyShadow !== undefined ? spec.shadows[spec.onlyShadow] : null;
    const away = layer ? 2 * (w + h) + 1000 : 0;
    const cast = layer ?? spec.shadow;
    ctx.translate(spec.x * w - away, spec.y * h);
    if (spec.angle) ctx.rotate(spec.angle);
    if (cast) {
        ctx.shadowColor = cast.color;
        ctx.shadowBlur = cast.blur * unit;
        ctx.shadowOffsetX = cast.dx * unit + away;
        ctx.shadowOffsetY = cast.dy * unit;
    }
    ctx.fillStyle = layer ? '#000000' : spec.color;                    // an opaque body throws the full shadow
    if (spec.outline) {
        ctx.strokeStyle = spec.outline.color;
        ctx.lineWidth = spec.outline.width * unit;
        ctx.lineJoin = 'round';
    }
    if (spec.type === 'text') {
        ctx.font = cssFont(spec, h);
        ctx.textAlign = spec.align;
        ctx.textBaseline = 'middle';
        const lines = spec.text.split('\n');
        const step = spec.size * h * spec.lineHeight;
        lines.forEach((line, i) => {
            const y = (i - (lines.length - 1) / 2) * step;
            if (spec.outline) ctx.strokeText(line, 0, y);           // the outline under the fill, so the letters keep their shape
            if (spec.outline && cast && !layer) { ctx.shadowColor = 'transparent'; }
            ctx.fillText(line, 0, y);
            if (spec.outline && cast && !layer) ctx.shadowColor = cast.color;
        });
    } else {
        const W = spec.w * w, H = spec.h * h;
        ctx.beginPath();
        if (spec.type === 'ellipse') ctx.ellipse(0, 0, W / 2, H / 2, 0, 0, Math.PI * 2);
        else {
            const r = Math.min(W, H) * spec.radius;
            if (ctx.roundRect) ctx.roundRect(-W / 2, -H / 2, W, H, r);
            else ctx.rect(-W / 2, -H / 2, W, H);
        }
        ctx.fill();
        if (spec.outline) { if (!layer) ctx.shadowColor = 'transparent'; ctx.stroke(); }
    }
    ctx.restore();
}

/**
 * Every graphic of a compiled filter drawn at w × h, fonts loaded first: { name: canvas }.
 * Brush strokes are drawn as at frame `t` (all of them, by default), clipped by `mask`
 * (a w × h Float32Array, the selection) when they ask to be, as ImageData-like objects.
 */
export async function renderGraphics(compiled, w, h, { t = Infinity, mask = null } = {}) {
    const graphics = compiled.graphics ?? {};
    const failed = await loadGraphicFonts(graphics, h);
    const out = {};
    for (const [name, spec] of Object.entries(graphics)) {
        if (spec.type === 'strokes') {
            const r = rasterizeStrokes(spec, w, h, t, { mask });
            out[name] = typeof ImageData !== 'undefined' ? new ImageData(r.data, w, h) : r;   // not via a canvas: it would premultiply the data channels away
            continue;
        }
        const canvas = typeof OffscreenCanvas !== 'undefined' && typeof document === 'undefined'
            ? new OffscreenCanvas(w, h)
            : Object.assign(document.createElement('canvas'), { width: w, height: h });
        drawGraphic(canvas.getContext('2d'), spec, w, h);
        out[name] = canvas;
    }
    Object.defineProperty(out, 'failedFonts', { value: failed });   // addresses that could not be loaded (the text fell back to its family)
    return out;
}
