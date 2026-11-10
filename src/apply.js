/**
 * qblur/apply — one call to filter a picture, and the ways to save the result. Its own entry, so a page that
 * only compiles and runs filters (the main entry, `qblur`) doesn't carry it:
 *
 *   import { applyFilter, toBlob } from 'qblur/apply';
 *   const canvas = await applyFilter(img, 'Sepia');
 *   const png = await toBlob(canvas);
 *
 * dist/qblur-apply.js is this entry bundled with MathZetta; the classic scripts (qblur.global.min.js,
 * qblur.external.global.min.js) put it on window.QBlur with everything else.
 */
export { applyFilter, toCompiled, MAX_SIZE, MAX_SIZE_CPU } from './apply-filter.js';
export { toBlob, encodeGif, pictureData } from './save.js';
export { encodePng } from './png.js';
