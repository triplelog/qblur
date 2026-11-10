/**
 * MobileSAM (Segment Anything with a small image encoder; Apache-2.0, ONNX
 * from Acly/MobileSAM, int8 — tools/export-model.py): outlines whatever is
 * under a click, label or not.
 *
 *   const sam = await loadSam(ort, encoderUrl, decoderUrl);   // ort: onnxruntime-web or onnxruntime-node
 *   await sam.look(rgba, w, h);                                // the heavy part, once per picture
 *   const mask = await sam.mask({ points: [[x, y]], labels: [1], box });   // Uint8Array(w × h), fast
 *
 * The encoder takes the picture scaled so its longer side is 1024, as
 * [h, w, 3] RGB 0…255 (it normalizes and pads itself) and gives a 256 × 64 ×
 * 64 embedding. The decoder is Segment Anything's: points in that scaled
 * picture (label 1 in, 0 out; a box is two points labelled 2 and 3; without
 * a box a padding point labelled -1), and it returns four masks at the
 * picture's size with a predicted quality for each: one click is ambiguous
 * (a shirt or the person?), so masks 1–3 are the guesses and the surest is
 * taken; with more to go on, mask 0.
 */

const LONG = 1024;

/** The picture scaled (bilinear) so its longer side is 1024: [h, w, 3] floats 0…255. */
export function scaled(rgba, w, h) {
    const s = LONG / Math.max(w, h);
    const nw = Math.round(w * s), nh = Math.round(h * s);
    const data = new Float32Array(nw * nh * 3);
    for (let y = 0; y < nh; y++) {
        const fy = Math.max(0, Math.min(h - 1, (y + 0.5) / s - 0.5));
        const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ay = fy - y0;
        for (let x = 0; x < nw; x++) {
            const fx = Math.max(0, Math.min(w - 1, (x + 0.5) / s - 0.5));
            const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), ax = fx - x0;
            const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
            for (let k = 0; k < 3; k++) data[(y * nw + x) * 3 + k] = (rgba[a + k] * (1 - ax) + rgba[b + k] * ax) * (1 - ay) + (rgba[c + k] * (1 - ax) + rgba[d + k] * ax) * ay;
        }
    }
    return { data, nw, nh, s };
}

/** The decoder's prompt: points (and a box) in the scaled picture. */
export function prompt({ points = [], labels = [], box = null }, s) {
    const coords = points.map(([x, y]) => [x * s, y * s]);
    const kinds = [...labels];
    if (box) { coords.push([box[0] * s, box[1] * s], [box[2] * s, box[3] * s]); kinds.push(2, 3); }
    else { coords.push([0, 0]); kinds.push(-1); }
    return { coords: Float32Array.from(coords.flat()), labels: Float32Array.from(kinds), n: kinds.length };
}

/** @param ort onnxruntime-web or onnxruntime-node   @param encoder, decoder URLs, paths or bytes */
export async function loadSam(ort, encoder, decoder, options = {}) {
    const enc = await ort.InferenceSession.create(encoder, options);
    const dec = await ort.InferenceSession.create(decoder, options);
    let picture = null;                    // { embedding, w, h, s }
    return {
        async look(rgba, w, h) {
            const { data, nw, nh, s } = scaled(rgba, w, h);
            const out = await enc.run({ input_image: new ort.Tensor('float32', data, [nh, nw, 3]) });
            picture = { embedding: out.image_embeddings, w, h, s };
        },
        async mask(ask) {
            const { embedding, w, h, s } = picture;
            const p = prompt(ask, s);
            const out = await dec.run({
                image_embeddings: embedding,
                point_coords: new ort.Tensor('float32', p.coords, [1, p.n, 2]),
                point_labels: new ort.Tensor('float32', p.labels, [1, p.n]),
                mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
                has_mask_input: new ort.Tensor('float32', new Float32Array(1), [1]),
                orig_im_size: new ort.Tensor('float32', Float32Array.from([h, w]), [2]),
            });
            const quality = out.iou_predictions.data;
            const single = (ask.points ?? []).length === 1 && !ask.box;
            let k = 0;
            if (single) { k = 1; for (let j = 2; j < 4; j++) if (quality[j] > quality[k]) k = j; }
            const logits = out.masks.data.subarray(k * w * h, (k + 1) * w * h);
            const mask = new Uint8Array(w * h);
            for (let i = 0; i < mask.length; i++) if (logits[i] > 0) mask[i] = 1;
            return mask;
        },
    };
}
