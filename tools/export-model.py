"""
Remake the ONNX object models in demo/models/ (see demo/models/NOTICE):

  rfdetr-seg-small.onnx   Roboflow's RF-DETR-Seg Small, exported at 576 x 576, int8 (41 MB)
  rfdetr-seg-nano.onnx    RF-DETR-Seg Nano at its own 312 x 312, int8 (37 MB: the same backbone as Small)
  mobilesam-*.onnx        MobileSAM (Acly/MobileSAM's ONNX), int8: the encoder's MatMuls only (14 + 5 MB)

    python3 -m venv /tmp/rfx && /tmp/rfx/bin/pip install "rfdetr[onnx]" onnx
    /tmp/rfx/bin/python tools/export-model.py [small] [nano] [mobilesam]

Small at 576 rather than its own 384: more objects found, surer, 144 x 144 masks instead of
96 x 96 (about 2.5x the time). The int8 masks match fp32's (IoU 0.86-1.0). MobileSAM's encoder
quantized whole (Conv too) gives masks that cover everything, so only its MatMuls are (IoU 0.99).
magic_touch.tflite is MediaPipe's file as published:
https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite
"""
import os, sys, shutil, tempfile, urllib.request
from onnxruntime.quantization import quantize_dynamic, QuantType

MODELS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'demo', 'models')
which = sys.argv[1:] or ['small', 'nano', 'mobilesam']
work = tempfile.mkdtemp()
try:
    for name in which:
        if name in ('small', 'nano'):
            from rfdetr import RFDETRSegSmall, RFDETRSegNano
            model, size = (RFDETRSegSmall(), 576) if name == 'small' else (RFDETRSegNano(), 312)
            fp32 = model.export(output_dir=os.path.join(work, name), shape=(size, size))
            out = os.path.join(MODELS, f'rfdetr-seg-{name}.onnx')
            quantize_dynamic(str(fp32), out, weight_type=QuantType.QUInt8)
        elif name == 'mobilesam':
            base = 'https://huggingface.co/Acly/MobileSAM/resolve/main/'
            enc, dec = os.path.join(work, 'enc.onnx'), os.path.join(work, 'dec.onnx')
            urllib.request.urlretrieve(base + 'mobile_sam_image_encoder.onnx', enc)
            urllib.request.urlretrieve(base + 'sam_mask_decoder_multi.onnx', dec)
            quantize_dynamic(enc, os.path.join(MODELS, 'mobilesam-encoder.onnx'), weight_type=QuantType.QInt8, op_types_to_quantize=['MatMul'], per_channel=True)
            quantize_dynamic(dec, os.path.join(MODELS, 'mobilesam-decoder.onnx'), weight_type=QuantType.QUInt8)
            out = os.path.join(MODELS, 'mobilesam-*.onnx')
        else:
            sys.exit(f'unknown model {name}: small, nano or mobilesam')
        print('made', out)
finally:
    shutil.rmtree(work)
