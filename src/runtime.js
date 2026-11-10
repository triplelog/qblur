/**
 * Runs a compiled filter (compileFilter()) in WebGL: uploads the picture,
 * draws each pass into a texture, and the last one onto the canvas.
 *
 *   const runner = createFilterRunner(gl, compileFilter(def));
 *   runner.setImage(imageOrVideoOrCanvas);
 *   runner.setImage('mask', maskImage);          // each picture the filter names (compiled.images)
 *   runner.draw({ t: frameIndex });
 *   runner.passes[0].values.cutoff = 0.3;    // knobs change without recompiling
 *   runner.dispose();
 *
 * Works with WebGL 1 and 2 (`compileFilter(def, { version: 300 })` for
 * the latter). The output is the size of the canvas; the picture is
 * stretched to it, so size the canvas to the picture.
 *
 * Between passes the picture lives in 8-bit textures, so values clamp
 * to 0–1 and round to 1/255 at each step. `{ precision: 'half' }` or
 * `'float'` keeps more (bloom's bright spill, edge strengths over 1)
 * where the GPU can render to such textures; `runner.precision` says
 * what was granted.
 */
import { filterVertexShader } from 'mathzetta/glsl';

export function createFilterRunner(gl, compiled, options = {}) {
    if (gl.isContextLost()) throw new Error('The WebGL context is lost');
    const precision = texturePrecision(gl, options.precision);
    const vertex = filterVertexShader({ version: compiled.version });
    const programs = compiled.passes.map((pass) => link(gl, vertex, pass.fragment, pass.name));
    const locations = programs.map(() => new Map());
    const location = (i, name) => {
        if (!locations[i].has(name)) locations[i].set(name, gl.getUniformLocation(programs[i], name));
        return locations[i].get(name);
    };

    const triangle = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);   // one triangle covers the canvas

    const source = { texture: gl.createTexture(), framebuffer: null };
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    clampAndFilter(gl);
    const pictures = new Map();                                   // name → texture, for compiled.images
    const sizes = new Map();                                      // name → [width, height] of that picture
    const blank = gl.createTexture();                             // a picture not yet given: white, 1×1
    gl.bindTexture(gl.TEXTURE_2D, blank);
    clampAndFilter(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    const clear = gl.createTexture();                             // a graphic not yet drawn: transparent, 1×1
    gl.bindTexture(gl.TEXTURE_2D, clear);
    clampAndFilter(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    const pool = [];           // textures passes draw into, reused between frames
    let width = 0;
    let height = 0;

    function buffer(exclude) {
        let found = pool.find((b) => !exclude.includes(b));
        if (!found) {
            found = { texture: gl.createTexture(), framebuffer: gl.createFramebuffer() };
            gl.bindTexture(gl.TEXTURE_2D, found.texture);
            clampAndFilter(gl, precision.filter);
            gl.texImage2D(gl.TEXTURE_2D, 0, precision.internal, width, height, 0, gl.RGBA, precision.type, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, found.framebuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, found.texture, 0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE && precision.name !== 'byte') {
                Object.assign(precision, texturePrecision(gl, 'byte'));     // this GPU won't render to it after all
                gl.bindTexture(gl.TEXTURE_2D, found.texture);
                clampAndFilter(gl, precision.filter);
                gl.texImage2D(gl.TEXTURE_2D, 0, precision.internal, width, height, 0, gl.RGBA, precision.type, null);
            }
            pool.push(found);
        }
        return found;
    }

    const runner = {
        /** The passes with their live `values`; change one and the next draw uses it. */
        passes: compiled.passes,
        /** 'byte', 'half' or 'float': what the textures between passes hold. */
        get precision() { return precision.name; },

        /**
         * Uploads a picture: an <img>, <video>, <canvas> or ImageData. Call
         * again for each video frame. With a name first, it is one of the
         * pictures the filter asks for (`compiled.images`); `source` is the
         * main picture itself.
         */
        setImage(name, image) {
            if (typeof name !== 'string') { image = name; name = null; }
            let texture = source.texture;
            if (name && name !== 'source') {
                if (!pictures.has(name)) {
                    pictures.set(name, gl.createTexture());
                    gl.bindTexture(gl.TEXTURE_2D, pictures.get(name));
                    clampAndFilter(gl);
                }
                texture = pictures.get(name);
            }
            // a plain picture { data, width, height } (what the CPU runner and Node give; floats are 0–1): as ImageData
            if (image && image.data && image.width && image.height && typeof ImageData !== 'undefined' && !(image instanceof ImageData)) {
                const src = image.data, float = src instanceof Float32Array || src instanceof Float64Array;
                const bytes = src instanceof Uint8ClampedArray ? src : Uint8ClampedArray.from(src, float ? (v) => v * 255 : undefined);
                image = new ImageData(bytes, image.width, image.height);
            }
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);          // so y = 0 is the top, as in the picture
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            if (name) sizes.set(name, [image.naturalWidth || image.videoWidth || image.width || 1, image.naturalHeight || image.videoHeight || image.height || 1]);
            return runner;
        },

        /** Draws the filtered picture onto the canvas; `t` is the frame index. */
        draw({ t = 0 } = {}) {
            if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) {
                width = gl.drawingBufferWidth;
                height = gl.drawingBufferHeight;
                for (const b of pool) {
                    gl.bindTexture(gl.TEXTURE_2D, b.texture);
                    gl.texImage2D(gl.TEXTURE_2D, 0, precision.internal, width, height, 0, gl.RGBA, precision.type, null);
                }
            }
            let input = source;
            const kept = [];                   // inputs of chains still waiting for their blend pass
            compiled.passes.forEach((pass, i) => {
                for (let k = 0; k < pass.keepInput; k++) kept.push(input);
                const last = i === compiled.passes.length - 1;
                const target = last ? null : buffer([input, ...kept]);
                gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
                gl.viewport(0, 0, width, height);
                const program = programs[i];
                gl.useProgram(program);
                const position = gl.getAttribLocation(program, 'position');
                gl.bindBuffer(gl.ARRAY_BUFFER, triangle);
                gl.enableVertexAttribArray(position);
                gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, input.texture);
                gl.uniform1i(location(i, 'image'), 0);
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, pass.blendKept ? kept[kept.length - 1].texture : null);
                if (pass.blendKept) gl.uniform1i(location(i, 'base'), 1);
                pass.images.forEach((name, k) => {
                    gl.activeTexture(gl.TEXTURE2 + k);
                    gl.bindTexture(gl.TEXTURE_2D, name === 'source' ? source.texture : (pictures.get(pass.bind?.[name] ?? name) ?? (pass.graphics?.[name] ? clear : blank)));
                    gl.uniform1i(location(i, `mz_img_${name}`), 2 + k);
                    if (!pass.placements[name]) return;                              // source, selection: the frame's size, no placement
                    const size = sizes.get(pass.bind?.[name] ?? name) ?? [1, 1];
                    const place = pass.placements[name];
                    gl.uniform2f(location(i, `mz_size_${name}`), size[0], size[1]);
                    gl.uniform4f(location(i, `mz_place_${name}`), Number(place.zoom), Number(place.x), Number(place.y), Number(place.angle));
                });
                gl.uniform2f(location(i, 'resolution'), width, height);
                gl.uniform1f(location(i, 't'), t);
                gl.uniform1f(location(i, 'mz_opacity'), pass.opacity);
                for (const [name, param] of Object.entries(pass.params)) {
                    const value = pass.values[name];
                    if (param.type === 'color') gl.uniform3fv(location(i, name), value.map(Number));
                    else gl.uniform1f(location(i, name), Number(value));
                }
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                if (pass.blendKept) kept.pop();
                input = target;
            });
            return runner;
        },

        dispose() {
            for (const program of programs) gl.deleteProgram(program);
            gl.deleteTexture(source.texture);
            gl.deleteTexture(blank);
            gl.deleteTexture(clear);
            for (const texture of pictures.values()) gl.deleteTexture(texture);
            for (const b of pool) { gl.deleteTexture(b.texture); gl.deleteFramebuffer(b.framebuffer); }
            gl.deleteBuffer(triangle);
        },
    };
    return runner;
}

function clampAndFilter(gl, filter = gl.LINEAR) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
}

/** The texture format for the pictures between passes: 8-bit unless asked for and available. */
function texturePrecision(gl, wanted = 'byte') {
    const byte = { name: 'byte', internal: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR };
    if (wanted !== 'half' && wanted !== 'float') return byte;
    const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    if (webgl2) {
        if (!gl.getExtension('EXT_color_buffer_float')) return byte;
        const linear = gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST;
        return wanted === 'float'
            ? { name: 'float', internal: gl.RGBA32F, type: gl.FLOAT, filter: linear }
            : { name: 'half', internal: gl.RGBA16F, type: gl.HALF_FLOAT, filter: gl.LINEAR };
    }
    if (wanted === 'float' && gl.getExtension('OES_texture_float') && gl.getExtension('WEBGL_color_buffer_float')) {
        return { name: 'float', internal: gl.RGBA, type: gl.FLOAT, filter: gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST };
    }
    const half = gl.getExtension('OES_texture_half_float');
    if (half && gl.getExtension('EXT_color_buffer_half_float')) {
        return { name: 'half', internal: gl.RGBA, type: half.HALF_FLOAT_OES, filter: gl.getExtension('OES_texture_half_float_linear') ? gl.LINEAR : gl.NEAREST };
    }
    return byte;
}

function link(gl, vertex, fragment, name) {
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(`${name || 'The filter'} does not compile: ${gl.getShaderInfoLog(shader).trim()}`);
        }
        gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`${name || 'The filter'} does not link: ${gl.getProgramInfoLog(program).trim()}`);
    return program;
}
