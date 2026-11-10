# The object models

MobileSAM (`mobilesam-encoder.onnx`, `mobilesam-decoder.onnx`) is the one the site ships (`SHIPPED_MODELS` in
`demo/ai.js`) and the only one in git. The others are for comparing in development — the editor's model menu
offers them under `demo/`, and `npm run check:ai`, `npm run test:ai` and `tools/compare-ai.mjs` run them —
and are ignored by git (`.gitignore`) because of their size. The pages and tests work without them: choosing a
missing one in the menu says it "is not on this site", and test/ai.test.js then tests only the decoding.

To have them again:

| file | size | how |
| --- | --- | --- |
| `rfdetr-seg-small.onnx`, `rfdetr-seg-nano.onnx` | 41 MB, 37 MB | `python3 tools/export-model.py small nano` (its first lines say how to set up Python) |
| `magic_touch.tflite` | 6 MB | MediaPipe's file as published: https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite |
| `magic_touch_2.task` | 31 MB | MediaPipe's MagicTouch 2 as published (int8), from the interactive segmenter's page: https://ai.google.dev/edge/mediapipe/solutions/vision/interactive_segmenter |

`tools/export-model.py mobilesam` remakes MobileSAM's files. Licences: LICENSE and NOTICE in this folder.
