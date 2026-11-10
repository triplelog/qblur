/** `import 'qblur/element'` defines <qblur-image>; the class is exported for subclassing. */
export declare class QBlurImage extends HTMLElement {
    static readonly observedAttributes: string[];
    /** The drawing, a 2D canvas the picture's size (for toBlob). */
    readonly canvas: HTMLCanvasElement;
    /** Maths, a built-in filter's name, filter JSON or a share link (the `filter` attribute). */
    filter: string;
    /** Knob values; set an object, or the `params` attribute as JSON. */
    params: Record<string, number | [number, number, number]>;
    /** Draws again; resolves when drawn. */
    redraw(): Promise<void>;
}

declare global {
    interface HTMLElementTagNameMap { 'qblur-image': QBlurImage }
}
