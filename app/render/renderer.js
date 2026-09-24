// WebGL2 renderer shared by preview and export. Rendering is a pure function of
// (source frame, frame index, overlay, output size) → pixels; it keeps no per-frame state.
//
//   renderer.render(frame, (o) => { o.rect(...); o.text(...); })
//
// At source size the frame is copied texel for texel (no filtering), so everything the
// overlay doesn't touch leaves the renderer bit-identical to the decoded frame.
// All full-resolution pixels stay on the GPU. No readback happens here.
import { UserError } from "../errors.js";
import { buildAtlas, textWidth } from "./glyphs.js";
import { paletteLUT } from "./palettes.js";

const ATLAS_CHARS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("") + "°·×→←";

const VS_FULL = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const FS_SOURCE = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_size;     // output size in pixels
uniform bool u_exact;    // output size == source size: copy texels 1:1
out vec4 o;
void main() {
  vec2 p = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);   // top-left origin, pixel centres at .5
  o = vec4(u_exact ? texelFetch(u_src, ivec2(p), 0).rgb : texture(u_src, p / u_size).rgb, 1.0);
}`;
const VS_2D = `#version 300 es
uniform vec2 u_size;
in vec2 a_pos; in vec2 a_uv; in vec4 a_col;
out vec2 v_uv; out vec4 v_col;
void main() {
  v_uv = a_uv; v_col = a_col;
  gl_Position = vec4(a_pos.x / u_size.x * 2.0 - 1.0, 1.0 - a_pos.y / u_size.y * 2.0, 0.0, 1.0);
}`;
const FS_2D = `#version 300 es
precision highp float;
uniform sampler2D u_atlas;
in vec2 v_uv; in vec4 v_col;
out vec4 o;
void main() {
  float a = v_col.a * (v_uv.x < 0.0 ? 1.0 : texture(u_atlas, v_uv).a);
  o = vec4(v_col.rgb * a, a);   // premultiplied
}`;
// Thermal: the source's luma through gain and contrast into a 256×1 palette, inside a rectangle.
// Rows above the wipe line show thermal; faint scan rows give it a sensor texture.
const FS_THERMAL = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform sampler2D u_lut;
uniform vec2 u_size;
uniform vec4 u_rect;      // x, y, w, h in output pixels, top-left origin
uniform float u_gain, u_contrast, u_wipe, u_alpha, u_lines;
out vec4 o;
void main() {
  vec2 p = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  if (p.x < u_rect.x || p.y < u_rect.y || p.x > u_rect.x + u_rect.z || p.y > u_rect.y + u_rect.w) discard;
  if (p.y > u_rect.y + u_rect.w * u_wipe) discard;
  vec3 c = texture(u_src, p / u_size).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float v = clamp((l * u_gain - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  vec3 t = texture(u_lut, vec2(v, 0.5)).rgb;
  float row = mod(floor(p.y / max(1.0, u_lines)), 2.0);
  t *= 1.0 - 0.08 * row;
  o = vec4(t * u_alpha, u_alpha);
}`;
const FLOATS_PER_VERTEX = 8; // pos.xy, uv.xy, rgba

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("Shader: " + gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("Program: " + gl.getProgramInfoLog(p));
  return p;
}

export class Renderer {
  /** @param {HTMLCanvasElement|OffscreenCanvas} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: "high-performance",
    });
    if (!gl) throw new UserError("WebGL2 isn't available, so frames can't be rendered. Turn on hardware acceleration in the browser settings and reload.");
    this.gl = gl;
    this.srcProg = compile(gl, VS_FULL, FS_SOURCE);
    this.u = {
      src: gl.getUniformLocation(this.srcProg, "u_src"),
      size: gl.getUniformLocation(this.srcProg, "u_size"),
      exact: gl.getUniformLocation(this.srcProg, "u_exact"),
    };
    this.prog2d = compile(gl, VS_2D, FS_2D);
    this.thermalProg = compile(gl, VS_FULL, FS_THERMAL);
    this.ut = Object.fromEntries(["u_src", "u_lut", "u_size", "u_rect", "u_gain", "u_contrast", "u_wipe", "u_alpha", "u_lines"]
      .map(n => [n, gl.getUniformLocation(this.thermalProg, n)]));
    this.luts = new Map();
    this.u2d = { size: gl.getUniformLocation(this.prog2d, "u_size"), atlas: gl.getUniformLocation(this.prog2d, "u_atlas") };

    this.srcTex = gl.createTexture();
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = FLOATS_PER_VERTEX * 4;
    [["a_pos", 2, 0], ["a_uv", 2, 8], ["a_col", 4, 16]].forEach(([name, n, off]) => {
      const loc = gl.getAttribLocation(this.prog2d, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride, off);
    });
    gl.bindVertexArray(null);
    this.verts = new Float32Array(FLOATS_PER_VERTEX * 6 * 256);
    this.count = 0;
    this.atlases = new Map();   // px → { atlas, tex }
    this.boundAtlas = null;
    this.whiteTex = this.#texture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  }

  get width() { return this.canvas.width; }
  get height() { return this.canvas.height; }

  setSize(width, height) {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  /**
   * Draws `frame` (VideoFrame or Mediabunny VideoSample) at the canvas size, then the overlay.
   * `overlay(o)` receives the drawing API; coordinates are output pixels, top-left origin.
   */
  render(frame, overlay) {
    const gl = this.gl;
    if (gl.isContextLost()) throw new UserError("The GPU reset while rendering. Close other GPU-heavy apps and try again.");
    const W = this.canvas.width, H = this.canvas.height;
    const vf = frame instanceof VideoFrame ? frame : frame.toVideoFrame();
    const fw = vf.displayWidth, fh = vf.displayHeight;
    const exact = fw === W && fh === H;
    try {
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, vf);
    } finally {
      if (vf !== frame) vf.close();
    }
    const minify = !exact && (W < fw * 0.5 || H < fh * 0.5);
    if (minify) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, exact ? gl.NEAREST : minify ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, exact ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.useProgram(this.srcProg);
    gl.uniform1i(this.u.src, 0);
    gl.uniform2f(this.u.size, W, H);
    gl.uniform1i(this.u.exact, exact ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (overlay) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.prog2d);
      gl.uniform2f(this.u2d.size, W, H);
      gl.uniform1i(this.u2d.atlas, 0);
      gl.bindVertexArray(this.vao);
      this.boundAtlas = null;
      this.#bindAtlas(this.whiteTex);
      overlay(this.#api(W, H));
      this.#flush();
      gl.bindVertexArray(null);
    }
    if (gl.isContextLost()) throw new UserError("The GPU reset while rendering. Close other GPU-heavy apps and try again.");
  }

  /**
   * Copies the last rendered picture into an ImageBitmap that outlives the renderer. Call it
   * straight after render(). transferToImageBitmap() isn't used because its bitmap stays tied to
   * the GL context, so dispose() blanks it.
   */
  snapshot() { return createImageBitmap(this.canvas); }

  /** Releases GPU resources. The renderer can't be used afterwards. */
  dispose() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.atlases.clear();
  }

  #api(W, H) {
    return {
      width: W, height: H,
      rect: (x, y, w, h, col) => this.#quad(x, y, w, h, -1, -1, -1, -1, col),
      strokeRect: (x, y, w, h, lw, col) => {
        this.#quad(x, y, w, lw, -1, -1, -1, -1, col);
        this.#quad(x, y + h - lw, w, lw, -1, -1, -1, -1, col);
        this.#quad(x, y + lw, lw, h - 2 * lw, -1, -1, -1, -1, col);
        this.#quad(x + w - lw, y + lw, lw, h - 2 * lw, -1, -1, -1, -1, col);
      },
      line: (x0, y0, x1, y1, lw, col) => this.#line(x0, y0, x1, y1, lw, col),
      thermal: (x, y, w, h, opts) => this.#thermal(x, y, w, h, opts, W, H),
      text: (str, x, y, px, col) => this.#text(str, x, y, px, col),
      textWidth: (str, px) => textWidth(this.#atlas(px).atlas, str),
    };
  }

  #atlas(px) {
    px = Math.max(6, Math.round(px));
    let a = this.atlases.get(px);
    if (!a) {
      this.#flush(); // pending quads belong to the currently bound texture
      const atlas = buildAtlas(ATLAS_CHARS, px);
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.boundAtlas = null;
      a = { atlas, tex };
      this.atlases.set(px, a);
    }
    return a;
  }

  // Thermal pass over a rectangle. Flushes pending 2D quads first so drawing order holds, then
  // restores the 2D program for whatever the overlay draws next.
  #thermal(x, y, w, h, { palette = "inferno", gain = 1, contrast = 1, wipe = 1, alpha = 1, lines = 2 } = {}, W, H) {
    if (w <= 0 || h <= 0 || wipe <= 0 || alpha <= 0) return;
    this.#flush();
    const gl = this.gl;
    let lut = this.luts.get(palette);
    if (!lut) {
      lut = this.#texture(paletteLUT(palette), 256, 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      this.luts.set(palette, lut);
    }
    gl.useProgram(this.thermalProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, lut);
    gl.uniform1i(this.ut.u_src, 0); gl.uniform1i(this.ut.u_lut, 1);
    gl.uniform2f(this.ut.u_size, W, H);
    gl.uniform4f(this.ut.u_rect, x, y, w, h);
    gl.uniform1f(this.ut.u_gain, gain); gl.uniform1f(this.ut.u_contrast, contrast);
    gl.uniform1f(this.ut.u_wipe, Math.min(1, wipe)); gl.uniform1f(this.ut.u_alpha, Math.min(1, alpha));
    gl.uniform1f(this.ut.u_lines, lines);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(this.prog2d);
    gl.bindVertexArray(this.vao);
    this.boundAtlas = null;
    this.#bindAtlas(this.whiteTex);
  }

  #text(str, x, y, px, col) {
    const { atlas, tex } = this.#atlas(px);
    this.#bindAtlas(tex);
    let pen = x;
    for (const c of str) {
      const g = atlas.glyphs.get(c) ?? atlas.glyphs.get("?");
      this.#quad(pen - atlas.pad, y - atlas.pad, g.w, g.h,
        g.x / atlas.width, g.y / atlas.height, (g.x + g.w) / atlas.width, (g.y + g.h) / atlas.height, col);
      pen += g.advance;
    }
  }

  #bindAtlas(tex) {
    if (this.boundAtlas === tex) return;
    this.#flush();
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
    this.boundAtlas = tex;
  }

  // A line as a rotated quad (two triangles).
  #line(x0, y0, x1, y1, lw, [r, g, b, a]) {
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * lw / 2, ny = dx / len * lw / 2;
    if ((this.count + 6) * FLOATS_PER_VERTEX > this.verts.length) this.#flush();
    const v = this.verts;
    let k = this.count * FLOATS_PER_VERTEX;
    const put = (px, py) => { v[k++] = px; v[k++] = py; v[k++] = -1; v[k++] = -1; v[k++] = r; v[k++] = g; v[k++] = b; v[k++] = a; };
    put(x0 + nx, y0 + ny); put(x1 + nx, y1 + ny); put(x0 - nx, y0 - ny);
    put(x0 - nx, y0 - ny); put(x1 + nx, y1 + ny); put(x1 - nx, y1 - ny);
    this.count += 6;
  }

  #quad(x, y, w, h, u0, v0, u1, v1, [r, g, b, a]) {
    if ((this.count + 6) * FLOATS_PER_VERTEX > this.verts.length) this.#flush();
    const v = this.verts;
    let k = this.count * FLOATS_PER_VERTEX;
    const put = (px, py, u, t) => { v[k++] = px; v[k++] = py; v[k++] = u; v[k++] = t; v[k++] = r; v[k++] = g; v[k++] = b; v[k++] = a; };
    put(x, y, u0, v0); put(x + w, y, u1, v0); put(x, y + h, u0, v1);
    put(x, y + h, u0, v1); put(x + w, y, u1, v0); put(x + w, y + h, u1, v1);
    this.count += 6;
  }

  #flush() {
    if (!this.count) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.subarray(0, this.count * FLOATS_PER_VERTEX), gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    this.count = 0;
  }

  #texture(data, w, h) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return t;
  }
}
