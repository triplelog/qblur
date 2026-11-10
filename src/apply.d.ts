/** `import { applyFilter, toBlob } from '@mathzetta/qblur/apply'` — one call to filter a picture, and the ways to save the result. */
import type { CompiledFilter, FilterInput, Picture, Picture8, PictureSource, Colour, Engine } from './index.js';

// ---- one call ------------------------------------------------------------------------------

export interface ApplyOptions {
    /** Knob values; a colour is [r, g, b], 0–1. The rest keep their defaults. */
    params?: Record<string, number | Colour>;
    /** The frame, for filters that move. */
    t?: number;
    /** The other pictures the filter asks for (compiled.images). */
    images?: Record<string, PictureSource>;
    engine?: 'auto' | Engine;
    /** A 2D canvas to draw on (resized to the picture); otherwise a new one. */
    canvas?: HTMLCanvasElement | OffscreenCanvas | null;
    /** The longest side drawn (default MAX_SIZE on the GPU, MAX_SIZE_CPU on the CPU, never more than the GPU holds);
     *  a bigger picture — and any of `images` — is scaled down to it first, keeping its shape. */
    maxSize?: number;
}

/** The longest side applyFilter draws by default: on the GPU (4096) and on the CPU (2048). */
export const MAX_SIZE: number;
export const MAX_SIZE_CPU: number;

/**
 * A picture and a filter in, the filtered picture out (the picture's size, up to `maxSize`): a 2D canvas in a page,
 * an OffscreenCanvas in a worker, a picture { data, width, height } in Node.
 * `filter`: maths, a document, JSON, a share link, a compiled filter, or a LIBRARY filter's name.
 */
export function applyFilter(image: PictureSource, filter: FilterInput | CompiledFilter, options?: ApplyOptions): Promise<HTMLCanvasElement | OffscreenCanvas | Picture8>;
/** A filter in any of the forms applyFilter takes → compiled. */
export function toCompiled(filter: FilterInput | CompiledFilter): CompiledFilter;

// ---- saving --------------------------------------------------------------------------------

/** PNG anywhere (the package's own writer); JPEG and WebP in a browser. */
export function toBlob(what: HTMLCanvasElement | OffscreenCanvas | Picture, options?: {
    type?: 'image/png' | 'image/jpeg' | 'image/webp' | string;
    quality?: number;
    /** PNG: 'auto' writes an indexed PNG when there are at most 256 colours. */
    palette?: 'auto' | 'none';
}): Promise<Blob>;
/** An animated GIF; pass gifenc (`import * as gifenc from 'gifenc'`). */
export function encodeGif(frames: Iterable<HTMLCanvasElement | OffscreenCanvas | Picture> | AsyncIterable<HTMLCanvasElement | OffscreenCanvas | Picture>, options: {
    gifenc: object;
    /** ms per frame (33). */
    delay?: number;
    /** 0: loop for ever (the default); -1: play once. */
    repeat?: number;
    colours?: number;
}): Promise<Blob>;
/** The RGBA bytes of a 2D canvas or a picture. */
export function pictureData(what: HTMLCanvasElement | OffscreenCanvas | Picture): Picture8 | ImageData;
/** The PNG writer: indexed when few colours, RGB when opaque; null without CompressionStream. */
export function encodePng(options: {
    width: number;
    height: number;
    data: Uint8ClampedArray | Uint8Array;
    palette?: 'auto' | 'none' | 'force';
    colours?: number;
    dither?: boolean;
    /** Needed for palette 'force' on a picture with more than `colours` colours. */
    quantize?: (data: Uint8ClampedArray | Uint8Array, colours: number, options: { dither: boolean; width: number }) => { palette: number[][]; indices: Uint8Array };
}): Promise<{ blob: Blob; kind: 'palette' | 'rgb' | 'rgba'; colours: number; bits: number } | null>;
