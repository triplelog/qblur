/**
 * <qblur-image>: a picture with a filter on it, as an HTML element.
 *
 *   <script type="module" src="https://cdn.jsdelivr.net/npm/@mathzetta/qblur@0.1/dist/qblur-element.js"></script>
 *   <qblur-image src="photo.jpg" filter="Sepia" alt="The harbour at dusk"></qblur-image>
 *   <qblur-image src="photo.jpg" filter="if gray > cutoff then 1 else 0" params='{"cutoff": 0.4}'></qblur-image>
 *
 * Attributes (each change redraws):
 *   src          the picture's address (from another site it must allow CORS; add crossorigin)
 *   filter       maths, a built-in filter's name, filter JSON or a share link
 *   params       JSON of knob values, { "name": value } — or set the `params` property to an object
 *                (whichever was set last counts)
 *   t            the frame, for filters that move
 *   animate      present: t counts up while the element is in the page and in view (30 a second)
 *   engine       auto (default) | gpu | cpu
 *   alt          what the picture shows, for screen readers
 *   crossorigin  as on <img>
 *
 * The element draws on a canvas in its shadow root, the picture's size, scaled
 * down to fit (max-width: 100%). It fires `load` after each drawing and
 * `error` (event.detail: the Error) when the picture or the filter fails.
 * `element.canvas` is the drawing (for toBlob), `element.filter` / `params`
 * read and write the settings. Importing this module defines the element
 * (once); `QBlurImage` is the class.
 */

import { applyFilter } from './apply-filter.js';

const Base = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};
const FPS = 30;

export class QBlurImage extends Base {
    static get observedAttributes() { return ['src', 'filter', 'params', 't', 'engine', 'alt', 'crossorigin', 'animate']; }

    constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<style>:host{display:inline-block;max-width:100%}canvas{display:block;max-width:100%;height:auto}</style>';
        this.canvas = document.createElement('canvas');
        this.canvas.setAttribute('role', 'img');
        this.canvas.width = 0;
        this.canvas.height = 0;
        root.append(this.canvas);
        this._params = null;          // set by the property; otherwise the attribute
        this._image = null;           // the loaded picture, and its src
        this._loading = null;
        this._queued = false;
        this._drawn = null;
        this._frame = 0;
        this._timer = null;
        this._loop = 0;               // which animation loop is the current one
        this._visible = true;
        this._watch = typeof IntersectionObserver !== 'undefined'
            ? new IntersectionObserver((entries) => { this._visible = entries[entries.length - 1].isIntersecting; }) : null;
    }

    get filter() { return this.getAttribute('filter') ?? ''; }
    set filter(value) { this.setAttribute('filter', value); }

    get params() {
        if (this._params) return { ...this._params };
        const text = this.getAttribute('params');
        if (!text) return {};
        try { return JSON.parse(text); } catch { throw new Error(`params is not JSON: ${text}`); }
    }
    set params(value) { this._params = value ? { ...value } : null; this.redraw(); }

    connectedCallback() {
        // a property set before the element was defined (el.params = …) would hide the accessor: set it again through it
        for (const name of ['filter', 'params']) {
            if (Object.prototype.hasOwnProperty.call(this, name)) { const value = this[name]; delete this[name]; this[name] = value; }
        }
        this._watch?.observe(this);
        this.redraw();
        this._animate();
    }
    disconnectedCallback() { this._stop(); this._watch?.disconnect(); this._visible = true; }

    attributeChangedCallback(name, before, after) {
        if (before === after) return;
        if (name === 'alt') { this.canvas.setAttribute('aria-label', after ?? ''); return; }
        if (name === 'src' || name === 'crossorigin') { this._image = null; this._loading = null; }
        if (name === 'params') this._params = null;                       // the attribute was written last: it counts
        if (name === 'animate') { this._stop(); this._animate(); }
        this.redraw();
    }

    /** Draws again (soon, once, however many settings changed). Resolves when drawn. */
    redraw() {
        if (!this.isConnected) return Promise.resolve();
        if (this._queued) return this._drawn;                         // a drawing is already waiting: it will see this change
        this._queued = true;
        this._drawn = (this._drawn ?? Promise.resolve()).then(() => { this._queued = false; return this._draw(); });   // one at a time, in order
        return this._drawn;
    }

    async _draw() {
        const src = this.getAttribute('src');
        const filter = this.filter.trim();
        if (!src || !filter) return;
        try {
            const image = await this._load(src);
            if (this.getAttribute('src') !== src) return;                 // changed while loading
            const t = this.hasAttribute('animate') ? this._frame : Number(this.getAttribute('t') ?? 0) || 0;
            await applyFilter(image, filter, { params: this.params, t, engine: this.getAttribute('engine') || 'auto', canvas: this.canvas });
            this.dispatchEvent(new Event('load'));
            this._animate();                                              // back on, if an error had stopped it
        } catch (error) {
            this.dispatchEvent(new CustomEvent('error', { detail: error }));
            if (!this.hasAttribute('animate')) console.warn('<qblur-image>:', error.message);
            this._stop();
        }
    }

    _load(src) {
        if (this._image?.src === src) return Promise.resolve(this._image.image);
        if (this._loading?.src === src) return this._loading.promise;
        const img = new Image();
        const cors = this.getAttribute('crossorigin');
        if (cors !== null) img.crossOrigin = cors || 'anonymous';
        img.src = src;
        const loading = { src };
        loading.promise = img.decode().then(() => { if (this._loading === loading) this._image = { src, image: img }; return img; },
            () => { if (this._loading === loading) this._loading = null; throw new Error(`Could not load the picture ${src}`); });   // the next drawing asks again
        this._loading = loading;
        return loading.promise;
    }

    _animate() {
        if (!this.hasAttribute('animate') || !this.isConnected || this._timer) return;
        const loop = ++this._loop;                                        // a loop that was stopped while drawing must not go on
        const tick = async () => {
            if (this._visible) { this._frame++; await this.redraw(); }    // out of view: wait, don't draw
            if (loop === this._loop && this._timer) this._timer = setTimeout(tick, 1000 / FPS);
        };
        this._timer = setTimeout(tick, 1000 / FPS);
    }

    _stop() { clearTimeout(this._timer); this._timer = null; this._loop++; }
}

if (typeof customElements !== 'undefined' && !customElements.get('qblur-image')) customElements.define('qblur-image', QBlurImage);
