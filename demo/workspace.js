/**
 * The editor's workspace (demo/editor.html): the stage — the original and the result, as large as the
 * window allows — beside the controls, which are tabs. DOM only; app.js owns the pictures themselves.
 *
 *   const workspace = setupWorkspace({ $, toolActive, onPreviewSize, sharp });
 *   workspace.layout();              // after the pictures change size (app.js's fit())
 *   workspace.showOriginal();        // a tool that draws on the original needs it on screen
 *   workspace.showResult();          // …and cropping needs the result
 *   workspace.showTab('filter');     // 'filter' | 'tools' | 'export'
 *
 * What is shown (Result / Both / Original), the open tab and the preview's sharpness are kept in
 * localStorage. "Expand" puts the stage over the whole window (Esc closes; the rest of the page is
 * inert meanwhile). The pictures' size on screen is one number, --frame-w on #frames: the canvases
 * keep their own pixels (#preview-size chooses how many) and are scaled to it.
 */
export const PREVIEW_SIZES = { 480: [480, 360], 960: [960, 720], 1440: [1440, 1080] };
const VIEWS = ['result', 'both', 'original'];
const TABS = ['filter', 'tools', 'export'];
const GAP = 16;          // between the two pictures (.frames' gap)
const MAX_ZOOM = 3;      // a small picture is enlarged at most this much

export function setupWorkspace({ $, toolActive = () => false, onPreviewSize = () => {}, sharp = true }) {
    const body = document.body, stage = $('stage'), frames = $('frames');
    const kept = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
    const keep = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };
    const wide = matchMedia('(min-width: 1180px)');      // the stage beside the controls (the page's CSS has the same number)
    const phone = matchMedia('(max-width: 700px)');
    const expanded = () => body.classList.contains('stage-expanded');

    // ---- the pictures' size on screen ------------------------------------------------
    let view = VIEWS.includes(kept('qblur-view')) ? kept('qblur-view') : (phone.matches ? 'result' : 'both');
    function layout() {
        const w = $('source').width, h = $('source').height;
        if (!w || !h) return;
        const two = view === 'both';
        // the room there is, measured without the pictures: at their old size they would hold the column wide
        // (a phone turned upright, both pictures shown where one was)
        frames.style.setProperty('--frame-w', '0px');
        const W = frames.clientWidth - 1;      // its width is a fraction of a pixel less than the rounded number
        if (W < 1) return;
        // the height the pictures may take: beside the controls or expanded, what the window has left
        // after the stage's own bars; in one column, most of a screen (the page scrolls anyway)
        const fitsWindow = expanded() || wide.matches;
        // (measured from where the stage starts on the page, not where it has scrolled to: the pictures keep
        // their size as the page scrolls, and the whole stage is in view when the page opens)
        // (added up from the stage's other parts: expanded, the stage is the window's height whatever it holds, so its
        // scrollHeight would count the empty room as bars and leave the pictures the minimum)
        const px = (s, ...k) => k.reduce((sum, key) => sum + (parseFloat(s[key]) || 0), 0);
        let bars = px(getComputedStyle(stage), 'paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth')
            + px(getComputedStyle(frames), 'marginTop', 'marginBottom');
        for (const el of stage.children) {
            if (el === frames || !el.getClientRects().length) continue;      // hidden parts take no room
            bars += el.offsetHeight + px(getComputedStyle(el), 'marginTop', 'marginBottom');
        }
        const gap = parseFloat(getComputedStyle(stage).top) || 0;
        const above = expanded() ? 0 : stage.parentElement.getBoundingClientRect().top + scrollY + gap;
        const H = Math.max(200, fitsWindow ? innerHeight - above - bars - 2 : innerHeight * 0.7);
        const side = Math.min((W - (two ? GAP : 0)) / (two ? 2 : 1) / w, H / h);
        const stack = two ? Math.min(W / w, (fitsWindow ? (H - GAP) / 2 : H) / h) : 0;
        const stacked = stack > side * 1.15;      // side by side unless one above the other is clearly larger
        const width = `${Math.max(40, Math.floor(w * Math.min(MAX_ZOOM, stacked ? stack : side)))}px`;
        frames.classList.toggle('stacked', stacked);
        frames.style.setProperty('--frame-w', width);
    }
    let queued = false;
    const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; layout(); }); } };
    if (window.ResizeObserver) new ResizeObserver(later).observe(stage);
    addEventListener('resize', later);
    wide.addEventListener('change', later);

    // ---- what is shown ---------------------------------------------------------------
    function setView(next, remember = true) {
        view = VIEWS.includes(next) ? next : 'both';
        for (const v of VIEWS) {
            body.classList.toggle(`view-${v}`, v === view);
            $(`view-${v}`).setAttribute('aria-pressed', String(v === view));
        }
        if (remember) keep('qblur-view', view);
        layout();
    }
    for (const v of VIEWS) $(`view-${v}`).onclick = () => setView(v);
    const showOriginal = () => { if (view === 'result') setView('both', false); };
    const showResult = () => { if (view === 'original') setView('both', false); };

    // ---- expanded: the stage over the whole window -------------------------------------
    function expand(on) {
        body.classList.toggle('stage-expanded', on);
        $('expand').setAttribute('aria-pressed', String(on));
        $('expand').textContent = on ? '✕ Close' : '⤢ Expand';
        for (const el of document.querySelectorAll('.ss-sidebar, .qb-head, .controls, .qb-footer')) el.inert = on;
        layout();
        if (!on) stage.scrollIntoView({ block: 'nearest' });
    }
    $('expand').onclick = () => expand(!expanded());
    // Esc closes it — unless a selection tool is on, which uses Esc itself
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && expanded() && !toolActive() && !document.querySelector('dialog[open]')) expand(false); });

    // ---- the tabs ------------------------------------------------------------------------
    let tab = 'filter';
    function showTab(next, remember = true) {
        tab = TABS.includes(next) ? next : 'filter';
        for (const t of TABS) {
            const on = t === tab;
            $(`tab-${t}`).setAttribute('aria-selected', String(on));
            $(`tab-${t}`).tabIndex = on ? 0 : -1;
            $(`panel-${t}`).hidden = !on;
        }
        // the download options are open while their tab is (a drag on the result crops only then)
        $('export').open = tab === 'export';
        if (tab === 'export') showResult();
        if (tab === 'tools') showOriginal();
        if (remember) keep('qblur-tab', tab);
    }
    for (const t of TABS) {
        $(`tab-${t}`).onclick = () => showTab(t);
        $(`tab-${t}`).addEventListener('keydown', (e) => {
            const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
            if (!step) return;
            e.preventDefault();
            const to = TABS[(TABS.indexOf(t) + step + TABS.length) % TABS.length];
            showTab(to);
            $(`tab-${to}`).focus();
        });
    }

    // ---- how sharp the preview is ------------------------------------------------------------
    const size = $('preview-size');
    size.value = kept('qblur-preview') in PREVIEW_SIZES ? kept('qblur-preview') : (sharp && !phone.matches ? '960' : '480');
    size.addEventListener('change', () => { keep('qblur-preview', size.value); onPreviewSize(); });

    setView(view, false);
    showTab(kept('qblur-tab'), false);
    return { layout, setView, showOriginal, showResult, showTab, expand, get view() { return view; }, get tab() { return tab; }, get expanded() { return expanded(); } };
}
