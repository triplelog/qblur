/** applyFilter, toBlob, encodeGif and the element's module, in Node (the CPU). The browser side is in tools/check-docs.mjs. */
import * as gifenc from 'gifenc/dist/gifenc.esm.js';
import { suite, test, eq } from './harness.js';
import { applyFilter, toCompiled, toBlob, encodeGif, pictureData, MAX_SIZE, MAX_SIZE_CPU } from '../src/apply.js';
import { compileFilter, filterToLink, LIBRARY } from '../src/index.js';
import * as main from '../src/index.js';

// The harness is synchronous: everything async happens up here, the tests look at the results.
const W = 4, H = 2;
const photo = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
for (let p = 0; p < W * H; p++) photo.data.set([p * 30, 255 - p * 30, 100, 255], p * 4);
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

const maths = await settle(applyFilter(photo, '1 - rgb'));
const named = await settle(applyFilter(photo, 'invert'));
const doc = await settle(applyFilter(photo, { name: 'Mine', params: { k: 0.2 }, color: 'rgb * k' }));
const link = await settle(applyFilter(photo, filterToLink('1 - rgb')));
const threshold = compileFilter(LIBRARY.find((f) => f.name === 'Threshold'));
const low = await settle(applyFilter(photo, threshold, { params: { cutoff: 0.1 } }));
const high = await settle(applyFilter(photo, threshold, { params: { cutoff: 0.9 } }));
const again = await settle(applyFilter(photo, threshold));
const colour = await settle(applyFilter(photo, 'Tint', { params: { tint: [1, 0, 0] } }));
const moving = await Promise.all([0, 5].map((t) => settle(applyFilter(photo, 'pixel(px + t, py)', { t }))));
const badKnob = await settle(applyFilter(photo, 'Threshold', { params: { nope: 1 } }));
const noGpu = await settle(applyFilter(photo, '1 - rgb', { engine: 'gpu' }));
const badEngine = await settle(applyFilter(photo, '1 - rgb', { engine: 'fast' }));
const noPicture = await settle(applyFilter({ width: 0, height: 0, data: new Uint8ClampedArray(0) }, '1 - rgb'));

const png = await settle(toBlob(maths.value).then(async (b) => ({ type: b.type, bytes: new Uint8Array(await b.arrayBuffer()) })));
const jpeg = await settle(toBlob(photo, { type: 'image/jpeg' }));
const gif = await settle(encodeGif([photo, maths.value], { gifenc, delay: 50 }).then(async (b) => ({ type: b.type, bytes: new Uint8Array(await b.arrayBuffer()) })));
async function* frames() { for (const t of [0, 1, 2]) yield applyFilter(photo, 'pixel(px + t, py)', { t }); }
const gifAsync = await settle(encodeGif(frames(), { gifenc }).then((b) => b.size));
const gifBare = await settle(encodeGif([photo]));
const gifSizes = await settle(encodeGif([photo, { width: 2, height: 2, data: new Uint8ClampedArray(16) }], { gifenc }));
const element = await import('../src/element.js');

const px = (result, p) => [...result.value.data.subarray(p * 4, p * 4 + 4)];
const inverted = (p) => [255 - p * 30, p * 30, 155, 255];

suite('applyFilter (Node: the CPU)', () => {
    test('maths: a picture { data, width, height } of the same size', () => {
        if (maths.error) throw maths.error;
        eq([maths.value.width, maths.value.height, maths.value.data.constructor.name], [W, H, 'Uint8ClampedArray']);
        eq(px(maths, 0), inverted(0));
        eq(px(maths, 7), inverted(7));
    });
    test('a built-in filter by name, any case', () => eq(px(named, 3), inverted(3)));
    test('a filter document, its knob at its default', () => eq(px(doc, 1), [6, 45, 20, 255]));
    test('a share link', () => eq(px(link, 2), inverted(2)));
    test('params change the knobs; the next call is back at the defaults', () => {
        eq(px(low, 0).slice(0, 3), [255, 255, 255]);
        eq(px(high, 0).slice(0, 3), [0, 0, 0]);
        eq(px(again, 0), [255, 255, 255, 255]);                      // gray 0.63 against the default 0.5
    });
    test('the caller\'s compiled filter is left as it was', () => eq(threshold.passes[0].values.cutoff, 0.5));
    test('a colour knob', () => eq(px(colour, 1), [30, 0, 0, 255]));
    test('t moves a moving filter', () => {
        eq(px(moving[0], 0), [...photo.data.subarray(0, 4)]);
        eq(px(moving[1], 0), [...photo.data.subarray(12, 16)]);   // 5 to the right, clamped to the last column
    });
    test('an unknown knob names the ones there are', () => eq(/no knob called "nope".*cutoff/.test(badKnob.error?.message), true));
    test('engine "gpu" without WebGL says so', () => eq(/no WebGL/.test(noGpu.error?.message), true));
    test('a wrong engine name', () => eq(/engine is/.test(badEngine.error?.message), true));
    test('a picture with no size', () => eq(/no size/.test(noPicture.error?.message), true));
    test('toCompiled: every form', () => {
        eq(toCompiled(threshold), threshold);
        eq(toCompiled('Sepia').name, 'Sepia');
        eq(toCompiled('gray').passes.length, 1);
        eq(toCompiled({ steps: ['gray', '1 - rgb'] }).passes.length, 2);
    });
});

suite('saving: toBlob and encodeGif', () => {
    test('toBlob(picture) is a PNG in Node', () => {
        if (png.error) throw png.error;
        eq(png.value.type, 'image/png');
        eq([...png.value.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    });
    test('JPEG needs a browser, and says so', () => eq(/needs a browser/.test(jpeg.error?.message), true));
    test('encodeGif with gifenc: a GIF89a', () => {
        if (gif.error) throw gif.error;
        eq(gif.value.type, 'image/gif');
        eq(String.fromCharCode(...gif.value.bytes.subarray(0, 6)), 'GIF89a');
        eq([gif.value.bytes[6] | (gif.value.bytes[7] << 8), gif.value.bytes[8] | (gif.value.bytes[9] << 8)], [W, H]);
    });
    test('encodeGif takes an async iterable of frames', () => { if (gifAsync.error) throw gifAsync.error; eq(gifAsync.value > 30, true); });
    test('encodeGif without gifenc explains', () => eq(/needs gifenc/.test(gifBare.error?.message), true));
    test('frames of different sizes are refused', () => eq(/Frame 2 is 2 × 2/.test(gifSizes.error?.message), true));
    test('pictureData: 0–1 floats become bytes', () => {
        eq([...pictureData({ width: 1, height: 1, data: new Float32Array([1, 0.5, 0, 1]) }).data], [255, 128, 0, 255]);
    });
});

// what a review before 0.1.0 found: values checked, graphics in Node, calls in order
const badColour = await settle(applyFilter(photo, { params: { tint: [1, 0, 0] }, color: 'tint' }, { params: { tint: '#ff0000' } }));
const badNumber = await settle(applyFilter(photo, { params: { k: 0.5 }, color: 'rgb * k' }, { params: { k: 'abc' } }));
const textInNode = await settle(applyFilter(photo, { graphics: { title: { type: 'text', text: 'Hi' } }, color: 'mix(rgb, title, alpha(title))' }));
const strokesInNode = await settle(applyFilter(photo, { graphics: { ink: { type: 'strokes', brush: 'round', size: 0.5, strokes: [{ points: [[0.1, 0.5], [0.9, 0.5]] }] } }, color: 'mix(rgb, (1, 0, 0), alpha(ink))' }));
const knob = { params: { k: 0 }, color: '(k, k, k)' };
const together = await Promise.all([0.2, 0.4, 0.6, 0.8].map((k) => applyFilter(photo, knob, { params: { k } })));
const changing = compileFilter({ params: { k: 0 }, color: '(k, k, k)' });
const first = (await applyFilter(photo, changing)).data[0];
changing.passes[0].values.k = 1;
const second = (await applyFilter(photo, changing)).data[0];

suite('applyFilter: what the review before 0.1.0 found', () => {
    test('a colour knob given as text is refused, by name', () => eq(/knob "tint" needs a colour/.test(badColour.error?.message), true));
    test('a number knob given as text is refused', () => eq(/knob "k" needs a number/.test(badNumber.error?.message), true));
    test('text in Node says it needs a canvas (not a picture without it)', () => eq(/title.*needs a canvas/.test(textInNode.error?.message), true));
    test('brush strokes are drawn in Node', () => { if (strokesInNode.error) throw strokesInNode.error; eq(strokesInNode.value.data.some((v, i) => i % 4 === 0 && v > 200), true); });
    test('calls made together each keep their own knob values', () => eq(together.map((p) => p.data[0]), [51, 102, 153, 204]));
    test('a compiled filter\'s knob values are read on every call', () => eq([first, second], [0, 255]));
});

// the size limit: a picture longer than maxSize is scaled down first (on the CPU, MAX_SIZE_CPU by default)
const wide = { width: 3000, height: 10, data: new Uint8ClampedArray(3000 * 10 * 4).fill(200) };
const capped = await settle(applyFilter(wide, 'rgb'));
const cappedSmall = await settle(applyFilter(wide, '1 - rgb', { maxSize: 300 }));
const badMax = await settle(applyFilter(photo, 'rgb', { maxSize: 'big' }));
const stripes = { width: 4, height: 1, data: Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]) };
const halved = await settle(applyFilter(stripes, 'rgb', { maxSize: 2 }));

suite('applyFilter: the size limit', () => {
    test('the defaults', () => eq([MAX_SIZE, MAX_SIZE_CPU], [4096, 2048]));
    test('a picture longer than the CPU limit comes back at it, its shape kept', () => { if (capped.error) throw capped.error; eq([capped.value.width, capped.value.height], [2048, 7]); });
    test('maxSize sets it', () => { if (cappedSmall.error) throw cappedSmall.error; eq([cappedSmall.value.width, cappedSmall.value.height, cappedSmall.value.data[0]], [300, 1, 55]); });
    test('scaling down averages what each new pixel covers', () => { if (halved.error) throw halved.error; eq([...halved.value.data], [128, 128, 128, 255, 128, 128, 128, 255]); });
    test('a maxSize that is not a number is refused', () => eq(/maxSize is a number/.test(badMax.error?.message), true));
});

suite('entries', () => {
    test('applyFilter and saving are in qblur/apply, not the main entry', () => eq(['applyFilter', 'toCompiled', 'toBlob', 'encodeGif', 'pictureData', 'encodePng'].filter((n) => n in main), []));
});

suite('qblur/element', () => {
    test('loads in Node without defining anything', () => eq(typeof element.QBlurImage, 'function'));
    test('watches its attributes', () => eq(element.QBlurImage.observedAttributes.includes('filter'), true));
});
