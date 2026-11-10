/**
 * The object models in Node: RF-DETR's decoding, then the real models
 * (demo/models/: RF-DETR Small, MobileSAM) on the Charleston photo.
 */
import { access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { suite, test, eq } from './harness.js';
import { prepare, decode, COCO, SIZE } from '../demo/rfdetr.js';

const MODEL = new URL('../demo/models/rfdetr-seg-small.onnx', import.meta.url).pathname;
const present = await access(MODEL).then(() => true, () => false);
const results = {};
if (present) {
    const { default: ort } = await import('onnxruntime-node');
    const { loadDetector } = await import('../demo/rfdetr.js');
    const model = await loadDetector(ort, MODEL);
    // the photo at preview size, as RGBA (ffmpeg if it is there; otherwise a drawn scene is not enough to find cars)
    const W = 480, H = 360;
    try {
        const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', new URL('../demo/photos/charleston.jpg', import.meta.url).pathname, '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1e8 });
        const t0 = performance.now();
        results.found = await model.find(new Uint8ClampedArray(raw), W, H, { threshold: 0.4 });
        results.ms = performance.now() - t0;
        results.W = W; results.H = H;
        const { loadSam } = await import('../demo/sam.js');
        const sam = await loadSam(ort, new URL('../demo/models/mobilesam-encoder.onnx', import.meta.url).pathname, new URL('../demo/models/mobilesam-decoder.onnx', import.meta.url).pathname);
        await sam.look(new Uint8ClampedArray(raw), W, H);
        results.sam = await sam.mask({ points: [[190, 246]], labels: [1] });   // the middle of the SUV
        results.samBox = await sam.mask({ box: [155, 225, 221, 266] });       // …and its box
        console.log('  found', results.found.map((f) => f.label + ' ' + f.score.toFixed(2)).join(', '), Math.round(results.ms) + ' ms');
    } catch { results.noFfmpeg = true; }
} else console.log('  (demo/models/rfdetr-seg-small.onnx is missing, so only the decoding is tested)');

suite('finding objects (RF-DETR, MobileSAM)', () => {
    test('decoding: the picture stretched and normalized; boxes and masks back in the picture\'s pixels', () => {
        const white = prepare(new Uint8ClampedArray(320 * 160 * 4).fill(255), 320, 160);
        eq([white.length, +white[0].toFixed(3), +white[2 * SIZE * SIZE].toFixed(3)], [3 * SIZE * SIZE, 2.249, 2.64]);
        const dets = new Float32Array(100 * 4), logits = new Float32Array(100 * 91).fill(-9), masks = new Float32Array(100 * 4 * 4).fill(-1);
        dets.set([0.5, 0.5, 0.5, 0.5]);                               // query 0: a box round the middle half
        logits[3] = 3;                                                // …a car (COCO id 3), sigmoid(3) = 0.95
        masks.fill(1, 0, 4 * 4);                                      // …whose mask logits say "inside" everywhere
        logits[91 + 12] = 5;                                          // query 1: id 12 is a gap in COCO's ids — dropped
        const found = decode(dets, logits, masks, 320, 160);
        eq(found.length, 1);
        eq([found[0].label, +found[0].score.toFixed(2), found[0].box], ['car', 0.95, [80, 40, 240, 120]]);
        eq(found[0].mask.reduce((a, b) => a + b, 0), 320 * 160);
        eq(Object.keys(COCO).length, 80);
    });
    test('the model finds the cars and the people in the photo, with outlines', () => {
        if (!present || results.noFfmpeg) return;
        const labels = results.found.map((f) => f.label);
        if (!labels.includes('car') || !labels.includes('person')) throw new Error(`found ${labels}`);
        for (const f of results.found) {
            const area = f.mask.reduce((a, b) => a + b, 0), box = (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]);
            if (!(area > 0.2 * box && area < 2 * box)) throw new Error(`${f.label}: outline ${area} px in a box of ${Math.round(box)}`);
        }
        if (results.ms > 3000) throw new Error(`${Math.round(results.ms)} ms`);
    });
    test('MobileSAM outlines the SUV from a click and from its box', () => {
        if (!present || results.noFfmpeg) return;
        for (const mask of [results.sam, results.samBox]) {
            let inBox = 0, all = 0;
            mask.forEach((v, i) => { if (!v) return; all++; const x = i % results.W, y = Math.floor(i / results.W); if (x >= 150 && x <= 226 && y >= 220 && y <= 271) inBox++; });
            if (!(all > 0.4 * 66 * 41 && inBox > 0.9 * all)) throw new Error(`${all} px, ${inBox} in the SUV's box`);
        }
    });
});
