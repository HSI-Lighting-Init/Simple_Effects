// GPU pass for the "Shiny Clouds" effect: runs shinyClouds.frag over a source
// texture (image or 2D canvas) and returns a canvas holding the composited
// result. A single hidden WebGL2 canvas + program is created lazily and reused
// for every layer/frame — the caller draws the result out synchronously before
// the next call, so sharing one target is safe.
//
// If WebGL2 (or shader compilation) is unavailable, every call returns null and
// the effect pipeline simply skips the shine (graceful degradation).
import fragSrc from "../shaders/shinyClouds.frag?raw";
import vertSrc from "../shaders/fullscreen.vert?raw";
import type { Texture } from "./surface3d";

export interface ShineParams {
  time: number; // seconds — drives drift/morph (comp playhead → deterministic)
  intensity: number;
  scale: number;
  speed: number;
  complexity: number;
  contrast: number;
  brightness: number;
  tint: [number, number, number]; // 0..1
  blend: number; // 0 Add · 1 Screen · 2 Overlay · 3 Soft Light
  opacity: number;
  // When true, emit the shine as a straight-alpha pattern (no input image); the
  // caller composites it over the layers below with a canvas blend mode. Used by
  // whole-comp adjustment layers.
  adjustment?: boolean;
}

interface GL {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  program: WebGLProgram;
  tex: WebGLTexture;
  u: Record<string, WebGLUniformLocation | null>;
}

// undefined = not yet tried, null = tried and unavailable, GL = ready.
let cache: GL | null | undefined;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("shinyClouds shader compile failed:", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function init(): GL | null {
  if (cache !== undefined) return cache;
  cache = null;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, alpha: true });
    if (!gl) return null;

    const vs = compile(gl, gl.VERTEX_SHADER, vertSrc);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return null;
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("shinyClouds link failed:", gl.getProgramInfoLog(program));
      return null;
    }

    // Fullscreen quad: interleaved (pos.xy, uv). Y is flipped on texture upload,
    // so the mapping here (pos.y -1→+1 ↔ uv.v 0→1) keeps the output upright.
    const quad = new Float32Array([
      -1, -1, 0, 0,
       1, -1, 1, 0,
      -1,  1, 0, 1,
      -1,  1, 0, 1,
       1, -1, 1, 0,
       1,  1, 1, 1,
    ]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "a_position");
    const aUv = gl.getAttribLocation(program, "a_texCoord");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);

    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const u = (name: string) => gl.getUniformLocation(program, name);
    cache = {
      gl,
      canvas,
      program,
      tex,
      u: {
        image: u("u_inputImage"),
        resolution: u("u_resolution"),
        time: u("u_time"),
        intensity: u("u_intensity"),
        scale: u("u_scale"),
        speed: u("u_speed"),
        complexity: u("u_complexity"),
        contrast: u("u_contrast"),
        brightness: u("u_brightness"),
        tintColor: u("u_tintColor"),
        blendMode: u("u_blendMode"),
        opacity: u("u_opacity"),
        adjustment: u("u_adjustment"),
      },
    };
    // A 1×1 opaque pixel kept bound to unit 0 so adjustment-mode draws (which
    // never sample the image) always have a complete texture bound.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    return cache;
  } catch (e) {
    console.error("shinyClouds init failed:", e);
    cache = null;
    return null;
  }
}

/** True if the GPU pass is available (used to decide whether to attempt it). */
export function shineSupported(): boolean {
  return init() !== null;
}

/**
 * Composite the shine over `src` (size w×h) and return the WebGL canvas holding
 * the result, or null if the GPU pass is unavailable. The returned canvas is
 * shared/reused — draw it out before calling again.
 */
export function renderShine(src: Texture | null, w: number, h: number, p: ShineParams): HTMLCanvasElement | null {
  const g = init();
  if (!g || w <= 0 || h <= 0) return null;
  const { gl, canvas, program, tex, u } = g;

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);

  gl.bindTexture(gl.TEXTURE_2D, tex);
  // Adjustment mode never samples the image (the 1×1 dummy stays bound); only
  // upload the real source for the self-compositing per-image path. Flip Y so the
  // result reads upright when drawn back to a 2D canvas.
  if (!p.adjustment && src) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
    } catch (e) {
      console.error("shinyClouds texUpload failed:", e);
      return null;
    }
  }

  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(u.image, 0);
  gl.uniform1i(u.adjustment, p.adjustment ? 1 : 0);
  gl.uniform2f(u.resolution, w, h);
  gl.uniform1f(u.time, p.time);
  gl.uniform1f(u.intensity, p.intensity);
  gl.uniform1f(u.scale, p.scale);
  gl.uniform1f(u.speed, p.speed);
  gl.uniform1f(u.complexity, p.complexity);
  gl.uniform1f(u.contrast, p.contrast);
  gl.uniform1f(u.brightness, p.brightness);
  gl.uniform3f(u.tintColor, p.tint[0], p.tint[1], p.tint[2]);
  gl.uniform1i(u.blendMode, p.blend | 0);
  gl.uniform1f(u.opacity, p.opacity);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
  return canvas;
}
