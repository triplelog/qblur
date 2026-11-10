/**
 * qblur — image filters written as maths. Types for `import … from '@mathzetta/qblur'`
 * (and dist/qblur.js, dist/qblur.external.js, window.QBlur in the classic builds).
 * The format itself is described in docs/filters.md; these follow src/.
 */

// ---- the filter document (mathzetta-filter/1) ----------------------------------------------

export type Colour = [number, number, number];

/** A knob: `0.5` (a number 0–1), `[1, 0, 0]` (a colour), or in full. */
export type ParamSpec = number | Colour | {
    type?: 'number' | 'color';
    default?: number | Colour;
    min?: number;
    max?: number;
    step?: number;
    label?: string;
    /** A menu of these values. */
    options?: number[];
    /** "box": typed in, as maths; the default is a slider. */
    input?: 'slider' | 'box';
};

export interface NormalizedParam {
    type: 'number' | 'color';
    default: number | Colour;
    min?: number;
    max?: number;
    step?: number;
    label?: string;
    options?: number[];
    input?: 'box';
}

/** How a picture sits over the frame. */
export interface Placement {
    place: 'cover' | 'fit' | 'stretch' | 'tile';
    zoom: number;
    x: number;
    y: number;
    angle: number;
}

export interface ImageSpec extends Partial<Placement> {
    description?: string;
}

/** A text, rectangle, ellipse or brush-strokes graphic (src/graphics.js, src/strokes.js). */
export interface GraphicSpec {
    type?: 'text' | 'rect' | 'ellipse' | 'strokes';
    [setting: string]: unknown;
}

/** One expression for every channel, or one per channel. */
export type ColorExpression = string | Partial<Record<'r' | 'g' | 'b' | 'a' | 'rgb' | 'rgba', string>>;

export type ColourSpace = 'srgb' | 'linear' | 'hsv' | 'hsl' | 'lab' | 'oklab' | 'ycbcr';

/** A step of a chain: an expression, a filter, or a filter with settings. */
export type Step = string | FilterDocument | {
    filter: string | FilterDocument;
    /** Knob values, picture placements and graphic settings for this step. */
    with?: Record<string, unknown>;
    /** How much of the step's result shows over its input, 0–1. */
    opacity?: number;
    skip?: boolean;
};

/** A filter as published: maths plus a name, an author, its knobs and the pictures it needs. */
export interface FilterDocument {
    format?: 'mathzetta-filter/1';
    name?: string;
    author?: string;
    description?: string;
    /** The filter's page: Markdown, and where each knob goes. */
    notes?: Array<string | { param: string }>;
    params?: Record<string, ParamSpec>;
    images?: string[] | Record<string, ImageSpec>;
    graphics?: Record<string, GraphicSpec>;
    space?: ColourSpace | { in?: ColourSpace; out?: ColourSpace };
    /** A filter has either `color` or `steps`. */
    color?: ColorExpression;
    steps?: Step[];
    [extra: string]: unknown;
}

/** Anything a filter can be given as: an expression or a document. */
export type FilterInput = string | FilterDocument;

export interface NormalizedStep {
    filter: NormalizedFilter;
    with: Record<string, unknown>;
    opacity: number;
    skip: boolean;
}

export interface NormalizedFilter {
    format: 'mathzetta-filter/1';
    name?: string;
    author?: string;
    description?: string;
    notes?: Array<string | { param: string }>;
    params?: Record<string, NormalizedParam>;
    images?: Record<string, ImageSpec>;
    graphics?: Record<string, GraphicSpec>;
    space?: { in: ColourSpace; out: ColourSpace };
    color?: string | Partial<Record<'r' | 'g' | 'b' | 'a' | 'rgb' | 'rgba', string>>;
    steps?: NormalizedStep[];
}

// ---- compiled ------------------------------------------------------------------------------

export interface Pass {
    name: string;
    author: string;
    /** Where the pass came from in the chain (step indexes). */
    path: number[];
    /** The fragment shader. */
    fragment: string;
    /** The filter's own expression(s), which the CPU runner compiles. */
    color?: NormalizedFilter['color'];
    space?: string;
    params: Record<string, NormalizedParam>;
    /** The knobs' values: change them and draw again, no recompiling. */
    values: Record<string, number | number[]>;
    opacity: number;
    images: string[];
    placements: Record<string, Placement>;
    graphics: Record<string, GraphicSpec>;
    /** Graphic names → their keys in compiled.graphics (`title` → `title~2`). */
    bind?: Record<string, string>;
    keepInput: number;
    blendKept: boolean;
}

export interface CompiledFilter {
    name: string;
    author: string;
    description: string;
    version: 100 | 300;
    passes: Pass[];
    /** The named filters used inside a chain, with their authors. */
    credits: Array<{ name: string; author: string }>;
    images: Record<string, ImageSpec>;
    graphics: Record<string, GraphicSpec>;
}

export const FILTER_FORMAT: 'mathzetta-filter/1';
export const PLACEMENT: Placement;

/** The full form of a filter; throws on anything that isn't one. */
export function normalizeFilter(def: FilterInput): NormalizedFilter;
/** Every problem with a filter, as messages; empty when it will compile. */
export function validateFilter(def: FilterInput): string[];
/** A filter flattened into shader passes. Throws with every problem found. */
export function compileFilter(def: FilterInput, options?: { version?: 100 | 300 }): CompiledFilter;
export function filterParams(filter: NormalizedFilter): Record<string, NormalizedParam>;
export function filterImages(filter: NormalizedFilter): Record<string, ImageSpec>;
export function filterGraphics(filter: NormalizedFilter): Record<string, GraphicSpec>;
/** The filter as JSON to publish (normalized, defaults left out). */
export function filterToJSON(def: FilterInput): string;
export function filterFromJSON(text: string): NormalizedFilter;
/** `base + '#' + the filter`, URL-safe. */
export function filterToLink(def: FilterInput, base?: string): string;
export function filterFromLink(text: string): NormalizedFilter;
/** JSON, a share link, or a bare expression. */
export function readFilter(text: string): NormalizedFilter;

// ---- running -------------------------------------------------------------------------------

/** What the CPU side reads and writes: RGBA, 8-bit (or 0–1 floats), row by row from the top. */
export interface Picture {
    data: Uint8ClampedArray | Uint8Array | Float32Array | Float64Array | number[];
    width: number;
    height: number;
}

export interface Picture8 {
    data: Uint8ClampedArray;
    width: number;
    height: number;
}

/** A picture the runners take: an <img>, <video>, canvas, ImageBitmap, ImageData, or { data, width, height }. */
export type PictureSource = CanvasImageSource | ImageData | Picture;

export type Precision = 'byte' | 'half' | 'float';

export interface FilterRunner {
    readonly passes: Pass[];
    /** What the GPU granted for the textures between passes. */
    readonly precision: Precision | string;
    /** The main picture; with a name first, one of compiled.images (or a graphic's key). */
    setImage(image: PictureSource): this;
    setImage(name: string, image: PictureSource): this;
    /** Draws onto gl's canvas; `t` is the frame. */
    draw(options?: { t?: number }): this;
    dispose(): void;
}

export interface CpuRunner {
    readonly passes: Pass[];
    readonly precision: 'byte' | 'float';
    /** The generated JavaScript of each pass. */
    readonly sources: string[];
    /** How many workers drawAsync() uses (0 until it needs them). */
    readonly workers: number;
    setImage(image: PictureSource): this;
    setImage(name: string, image: PictureSource): this;
    /** Runs every pass here; draws on `canvas` when given. */
    draw(options?: { t?: number; canvas?: HTMLCanvasElement | OffscreenCanvas | null }): Picture8;
    /** As draw(), with big pictures' rows spread over workers. */
    drawAsync(options?: { t?: number; canvas?: HTMLCanvasElement | OffscreenCanvas | null }): Promise<Picture8>;
    dispose(): void;
}

export interface CpuRunnerOptions {
    precision?: Precision;
    /** 'auto' (cores − 1, at most 8) or a number; below 2, drawAsync() runs here. */
    workers?: number | 'auto';
    /** Pixels from which drawAsync() uses workers (250 000). */
    parallelFrom?: number;
    /** Where cpu-worker.js is, when not beside the module. */
    workerUrl?: string | URL;
}

export function createFilterRunner(gl: WebGLRenderingContext | WebGL2RenderingContext, compiled: CompiledFilter, options?: { precision?: Precision }): FilterRunner;
export function createCpuRunner(compiled: CompiledFilter, options?: CpuRunnerOptions): CpuRunner;
/** ImageData, { data, width, height }, or a drawable in a browser → 0–1 floats. */
export function toPicture(image: PictureSource): { data: Float32Array; width: number; height: number };
/** One pass compiled to JavaScript for the CPU (after the generated-code gate). */
export function compileCpuPass(pass: Pass): { source: string; uses: Set<string>; pictures: string[]; run(ctx: object): void };

export type Engine = 'gpu' | 'cpu';
export function chooseEngine(options?: { webgl?: boolean; prefer?: 'auto' | Engine }): { engine: Engine; reason: string };
/** The GPU when `gl` is given and takes the shaders, the CPU otherwise. */
export function createRunner(compiled: CompiledFilter, options?: CpuRunnerOptions & {
    gl?: WebGLRenderingContext | WebGL2RenderingContext | null;
    prefer?: 'auto' | Engine;
}): { runner: FilterRunner | CpuRunner; engine: Engine; reason: string };

// ---- the built-in library ------------------------------------------------------------------

export type LibraryFilter = FilterDocument & { name: string; group: string };
export const LIBRARY: LibraryFilter[];
export const GROUPS: string[];

// ---- brush strokes (src/strokes.js) --------------------------------------------------------

export const BRUSHES: string[];
export const TIMINGS: string[];
export const WIDTH_FROM: string[];
export const CLIPS: string[];
/** t counts frames at this rate. */
export const FPS: number;
export const STROKES_DEFAULTS: GraphicSpec;
export type Point = [number, number];
export function normalizeStrokes(name: string, spec: GraphicSpec): GraphicSpec;
export function strokeTimeline(spec: GraphicSpec, aspect?: number): { strokes: unknown[]; total: number; [key: string]: unknown };
export function rasterizeStrokes(spec: GraphicSpec, w: number, h: number, t?: number, options?: { mask?: Float32Array | null }): Picture8 & { total: number };
export function traceContours(mask: ArrayLike<number>, w: number, h: number, options?: { minArea?: number; tolerance?: number }): Point[][];
export function simplify(points: Point[], tolerance: number): Point[];
export function simplifyLoop(points: Point[], tolerance: number): Point[];

// ---- text and shapes (src/graphics.js) -----------------------------------------------------

export const GRAPHIC_TYPES: Array<'text' | 'rect' | 'ellipse' | 'strokes'>;
export const GRAPHIC_DEFAULTS: Record<'text' | 'rect' | 'ellipse', GraphicSpec>;
export const MAX_SHADOW_LAYERS: number;
export function normalizeGraphic(name: string, spec: GraphicSpec): GraphicSpec;
export function drawGraphic(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, spec: GraphicSpec, w: number, h: number): void;
/** Loads every fontUrl among the graphics; resolves with the addresses that failed. */
export function loadGraphicFonts(graphics: Record<string, GraphicSpec>, h?: number): Promise<string[]>;
/** Every graphic of a compiled filter drawn at w × h: { key: canvas or ImageData }, for runner.setImage(key, …). */
export function renderGraphics(compiled: CompiledFilter, w: number, h: number, options?: { t?: number; mask?: Float32Array | null }): Promise<Record<string, HTMLCanvasElement | OffscreenCanvas | ImageData | Picture8> & { readonly failedFonts: string[] }>;
export function cssFont(spec: GraphicSpec, h: number): string;
export function familyFor(url: string): string;
export function shadowLayerNames(name: string, spec: GraphicSpec): string[];
export function layeredExpression(name: string, spec: GraphicSpec): string;
export function googleFontUrl(family: string): string;
export function googleFontFamily(url: string): string | null;
export function fontFileFromCss(css: string, options?: { weight?: string; style?: string }): string | null;
