/**
 * RF-DETR segmentation (Roboflow's RF-DETR-Seg, Apache-2.0: Small exported
 * to ONNX at 576 × 576, Nano at 312 × 312, both int8 — tools/export-model.py):
 * every object of the 80 COCO kinds in a picture, with its box, label,
 * score and outline, in one pass.
 *
 *   const model = await loadDetector(ort, url, { size }); // ort: onnxruntime-web (browser) or onnxruntime-node; size: the export's
 *   const found = await model.find(rgba, w, h);          // [{ label, score, box: [x0, y0, x1, y1], mask: Uint8Array(w × h) }]
 *
 * In: `input` [1, 3, size, size], the picture stretched to the square (no
 * letterbox), ImageNet-normalized. Out: `dets` [1, 100, 4] boxes as centre
 * x, y, width, height in 0…1 of the picture; `labels` [1, 100, 91] class
 * logits (COCO's own ids, 1…90 with gaps); `masks` [1, 100, size/4, size/4]
 * mask logits over the whole picture (> 0 is inside). A DETR needs no NMS: each of
 * the 100 queries is one object or nothing.
 */

/** COCO's category ids (as the model numbers them) → names. */
export const COCO = {
    1: 'person', 2: 'bicycle', 3: 'car', 4: 'motorcycle', 5: 'airplane', 6: 'bus', 7: 'train', 8: 'truck', 9: 'boat',
    10: 'traffic light', 11: 'fire hydrant', 13: 'stop sign', 14: 'parking meter', 15: 'bench', 16: 'bird', 17: 'cat',
    18: 'dog', 19: 'horse', 20: 'sheep', 21: 'cow', 22: 'elephant', 23: 'bear', 24: 'zebra', 25: 'giraffe', 27: 'backpack',
    28: 'umbrella', 31: 'handbag', 32: 'tie', 33: 'suitcase', 34: 'frisbee', 35: 'skis', 36: 'snowboard', 37: 'sports ball',
    38: 'kite', 39: 'baseball bat', 40: 'baseball glove', 41: 'skateboard', 42: 'surfboard', 43: 'tennis racket',
    44: 'bottle', 46: 'wine glass', 47: 'cup', 48: 'fork', 49: 'knife', 50: 'spoon', 51: 'bowl', 52: 'banana', 53: 'apple',
    54: 'sandwich', 55: 'orange', 56: 'broccoli', 57: 'carrot', 58: 'hot dog', 59: 'pizza', 60: 'donut', 61: 'cake',
    62: 'chair', 63: 'couch', 64: 'potted plant', 65: 'bed', 67: 'dining table', 70: 'toilet', 72: 'tv', 73: 'laptop',
    74: 'mouse', 75: 'remote', 76: 'keyboard', 77: 'cell phone', 78: 'microwave', 79: 'oven', 80: 'toaster', 81: 'sink',
    82: 'refrigerator', 84: 'book', 85: 'clock', 86: 'vase', 87: 'scissors', 88: 'teddy bear', 89: 'hair drier', 90: 'toothbrush',
};

export const SIZE = 576;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

/** The picture stretched to size × size (bilinear), normalized, as planes R G B. */
export function prepare(rgba, w, h, size = SIZE) {
    const plane = size * size;
    const data = new Float32Array(3 * plane);
    for (let y = 0; y < size; y++) {
        const fy = Math.max(0, Math.min(h - 1, ((y + 0.5) * h) / size - 0.5));
        const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ay = fy - y0;
        for (let x = 0; x < size; x++) {
            const fx = Math.max(0, Math.min(w - 1, ((x + 0.5) * w) / size - 0.5));
            const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), ax = fx - x0;
            const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
            for (let k = 0; k < 3; k++) {
                const v = ((rgba[a + k] * (1 - ax) + rgba[b + k] * ax) * (1 - ay) + (rgba[c + k] * (1 - ax) + rgba[d + k] * ax) * ay) / 255;
                data[k * plane + y * size + x] = (v - MEAN[k]) / STD[k];
            }
        }
    }
    return data;
}

/**
 * Objects from the model's three outputs, in the picture's own pixels.
 * @param {Float32Array} dets 100 × 4   @param {Float32Array} logits 100 × classes   @param {Float32Array} masks 100 × m × m
 */
export function decode(dets, logits, masks, w, h, { threshold = 0.4, classes = logits.length / 100, maskSize = Math.sqrt(masks.length / 100) } = {}) {
    const found = [];
    for (let q = 0; q < 100; q++) {
        let best = -Infinity, id = 0;
        for (let c = 0; c < classes; c++) if (logits[q * classes + c] > best) { best = logits[q * classes + c]; id = c; }
        const score = 1 / (1 + Math.exp(-best));
        if (score < threshold || !COCO[id]) continue;
        const [cx, cy, bw, bh] = dets.subarray(q * 4, q * 4 + 4);
        const clamp = (v, max) => Math.min(max, Math.max(0, v));
        const box = [clamp((cx - bw / 2) * w, w), clamp((cy - bh / 2) * h, h), clamp((cx + bw / 2) * w, w), clamp((cy + bh / 2) * h, h)];
        if (box[2] - box[0] < 2 || box[3] - box[1] < 2) continue;
        const mask = maskFor(masks.subarray(q * maskSize * maskSize, (q + 1) * maskSize * maskSize), maskSize, w, h);
        if (!mask.some(Boolean)) continue;
        found.push({ label: COCO[id], score, box, mask });
    }
    return found.sort((a, b) => b.score - a.score);
}

/** One object's outline: its m × m logits, bilinear at the picture's size (so the outline isn't blocky), > 0 inside. */
function maskFor(logits, m, w, h) {
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const fy = Math.max(0, Math.min(m - 1, ((y + 0.5) * m) / h - 0.5));
        const y0 = Math.min(m - 2, Math.floor(fy)), ay = fy - y0;
        for (let x = 0; x < w; x++) {
            const fx = Math.max(0, Math.min(m - 1, ((x + 0.5) * m) / w - 0.5));
            const x0 = Math.min(m - 2, Math.floor(fx)), ax = fx - x0;
            const i = y0 * m + x0;
            const v = (logits[i] * (1 - ax) + logits[i + 1] * ax) * (1 - ay) + (logits[i + m] * (1 - ax) + logits[i + m + 1] * ax) * ay;
            if (v > 0) mask[y * w + x] = 1;
        }
    }
    return mask;
}

/** @param ort onnxruntime-web or onnxruntime-node   @param source a URL, a path, or the model's bytes   size: the side it was exported at */
export async function loadDetector(ort, source, { size = SIZE, ...options } = {}) {
    const session = await ort.InferenceSession.create(source, options);
    return {
        session,
        async find(rgba, w, h, opts = {}) {
            const out = await session.run({ input: new ort.Tensor('float32', prepare(rgba, w, h, size), [1, 3, size, size]) });
            return decode(out.dets.data, out.labels.data, out.masks.data, w, h, opts);
        },
    };
}
