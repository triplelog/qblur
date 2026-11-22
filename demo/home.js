/**
 * The home page's one example (demo/index.html): a small photo, a filter written as math, the result.
 * Light on purpose — one 50 KB picture, no library list, no object model, no Inline Math; the editor
 * (editor.html) is where everything else lives, and "Open this filter in the editor" carries the math there
 * as a link. "Use your own photo or video" (or a file dropped on the picture) puts the same line of math on
 * the visitor's own picture — it never leaves the computer — and Download saves a photo's result.
 */
import { filterToLink, compileCpuPass } from '@mathzetta/qblur';
import { createView, loadPicture, openFile, download } from './kit.js';
import { explain } from './help.js';

const $ = (id) => document.getElementById(id);
const PICTURE = 'photos/home.jpg';
const OWN_MAX = 1600;        // a photo of one's own: at most this on its long side (the download's size)
const CLIP_MAX = 960;        // a video's frames: smaller, so even the CPU keeps up
/** Filters to try: each a line of math (test/examples.test.js compiles them). */
export const PRESETS = [
    ['Vignette', 'rgb * (1 - 1.6 ((x - 0.5)^2 + (y - 0.5)^2))'],
    ['Invert', '1 - rgb'],
    ['Black and white', 'gray'],
    ['Warmer', '(1.15 r, g, 0.8 b)'],
    ['Two tones', 'if gray > 0.5 then (1, 0.9, 0.6) else (0.1, 0.15, 0.4)'],
    ['Edges', 'sobel()'],
    ['Blur', 'gaussian(4)'],
    ['Mirror', 'pixel(w - px, py)'],
    ['Wave', 'pixel(px + 8 sin(py / 20 + t / 8), py)'],
];

const stillOnly = matchMedia('(prefers-reduced-motion: reduce)');
let view = null, moving = false, t = 0, original = false, good = $('math').value;
let clip = null, clipCanvas = null;          // a video of one's own, and the canvas its frames are drawn into

/** Does this filter change with time? Then it is redrawn every frame. */
const moves = (compiled) => compiled.passes.some((p) => { try { const uses = compileCpuPass(p).uses; return uses.has('t') || uses.has('random'); } catch { return false; } });

function show(math) {
    if (!view) return;                                   // the photo is still loading: it opens on what the box says then
    const box = $('error');
    try {
        view.set(original ? 'rgb' : math);
        good = math;
        box.textContent = '';
        $('math').removeAttribute('aria-invalid');
        $('open-editor').href = filterToLink(math, 'editor.html');
    } catch (e) {                                        // the last filter that worked stays on the picture
        const { text, hint } = explain(e.message);
        box.textContent = hint ? `${text} — ${hint}` : text;
        $('math').setAttribute('aria-invalid', 'true');
        return;
    }
    moving = Boolean(clip) || (!original && !stillOnly.matches && moves(view.compiled));
    view.draw(t);
    for (const b of $('presets').children) b.setAttribute('aria-pressed', String(b.dataset.math === math.trim()));
}

for (const [name, math] of PRESETS) {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: name });
    b.dataset.math = math;
    b.onclick = () => { $('math').value = math; show(math); };
    $('presets').append(b);
}
let timer = 0;
$('math').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => show($('math').value), 200); });
$('compare').onclick = () => {
    original = !original;
    $('compare').setAttribute('aria-pressed', String(original));
    show(good);
};

// expanded: the picture over the whole window; Esc, the button or a click beside the picture closes it
function expand(on) {
    $('picture').classList.toggle('expanded', on);
    document.body.classList.toggle('picture-expanded', on);
    $('expand').setAttribute('aria-pressed', String(on));
    $('expand').textContent = on ? '✕ Close' : '⤢ Expand';
    for (const el of document.querySelectorAll('.ss-sidebar, .home > :not(:has(#picture)), .try-side')) el.inert = on;   // the keyboard stays with the picture
}
$('expand').onclick = () => expand(!$('picture').classList.contains('expanded'));
$('picture').addEventListener('click', (e) => { if (e.target === $('picture')) expand(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') expand(false); });

/** The picture under the filter: a canvas (a photo) or a playing video; the frame takes its shape. */
function setPicture(canvas, width, height) {
    view.resize(width, height);
    $('frame').style.setProperty('--ratio', `${width} / ${height}`);
    view.setImage('source', canvas);
    t = 0;
    show(good);
}
function stopClip() {
    if (!clip) return;
    clip.pause();
    URL.revokeObjectURL(clip.src);
    clip = null;
}
async function useFile(file) {
    if (!file) return;
    const box = $('error');
    let url = null;
    try {
        await ready;                                     // (a file chosen or dropped while the sample photo loads waits for it)
        if (file.type.startsWith('video/')) {
            url = URL.createObjectURL(file);
            const v = Object.assign(document.createElement('video'), { src: url, muted: true, loop: true, playsInline: true });
            await new Promise((resolve, reject) => { v.onloadedmetadata = resolve; v.onerror = () => reject(new Error('That video can\'t be played here — try an MP4 or WebM.')); });
            stopClip();
            const s = Math.min(1, CLIP_MAX / Math.max(v.videoWidth, v.videoHeight));
            clipCanvas = Object.assign(document.createElement('canvas'), { width: Math.round(v.videoWidth * s), height: Math.round(v.videoHeight * s) });
            await v.play();
            clip = v;
            url = null;                                  // the clip's now: stopClip revokes it
            clipCanvas.getContext('2d').drawImage(v, 0, 0, clipCanvas.width, clipCanvas.height);
            setPicture(clipCanvas, clipCanvas.width, clipCanvas.height);
            $('save').hidden = true;                     // a video's result is the editor's to record
        } else {
            const canvas = await openFile(file, OWN_MAX);
            stopClip();
            setPicture(canvas, canvas.width, canvas.height);
            $('save').hidden = false;
        }
        $('credit').textContent = `Your ${clip ? 'video' : 'photo'}: it stays on your computer.`;
    } catch (e) {
        if (url) URL.revokeObjectURL(url);
        box.textContent = e.message;
    }
}
$('file').addEventListener('change', () => useFile($('file').files[0]));
// a file dropped on the picture is used the same way
$('frame').addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $('frame').classList.add('dropping'); } });
$('frame').addEventListener('dragleave', () => $('frame').classList.remove('dropping'));
$('frame').addEventListener('drop', (e) => { e.preventDefault(); $('frame').classList.remove('dropping'); useFile(e.dataTransfer.files[0]); });
$('save').onclick = () => { if (!view) return; view.draw(t); download(view.snapshot(), 'qblur.png'); };

// (the handlers above are wired first, so the page answers at once; until the photo is in, show() waits and useFile awaits this)
const ready = loadPicture(PICTURE, 800).then((picture) => {
    view = createView($('frame'), picture.width, picture.height, { label: 'the photo with the filter applied' });
    view.setImage('source', picture);
    show($('math').value);
});
await ready;
(function tick() {
    if (clip && !document.hidden && clip.readyState >= 2) {     // the video's next frame, through the filter
        clipCanvas.getContext('2d').drawImage(clip, 0, 0, clipCanvas.width, clipCanvas.height);
        view.setImage('source', clipCanvas);
    }
    if (moving && !document.hidden) { t += 1; view.draw(t); }
    requestAnimationFrame(tick);
})();

window.qblurHome = { get view() { return view; }, show, expand, useFile, PRESETS };   // for the checks
