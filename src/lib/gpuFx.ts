// GPU pass for the "GPU Overlay" effect family (gpuOverlay.frag): 9 procedural
// overlays selected by an effect index. Mirrors shinyClouds.ts — one lazily
// created, reused WebGL2 canvas + program; each call renders one effect over a
// source texture (or, in adjustment mode, emits the pattern with alpha) and
// returns the canvas. Returns null (→ effect skipped) if WebGL2 is unavailable.
import fragSrc from "../shaders/gpuOverlay.frag?raw";
import vertSrc from "../shaders/fullscreen.vert?raw";
import type { Texture } from "./surface3d";

export interface GpuFxParams {
  effect: number; // 0..9
  time: number; // seconds — comp playhead (deterministic)
  intensity: number;
  scale: number;
  speed: number;
  detail: number;
  softness: number;
  extra: number;
  opacity: number;
  tint: [number, number, number]; // 0..1
  tint2: [number, number, number]; // 0..1
  pos: [number, number]; // 0..1
  blend: number; // 0 Add · 1 Screen · 2 Overlay · 3 Soft Light
  adjustment?: boolean;
}

interface GL {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  program: WebGLProgram;
  tex: WebGLTexture;
  u: Record<string, WebGLUniformLocation | null>;
}

let cache: GL | null | undefined;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("gpuOverlay shader compile failed:", gl.getShaderInfoLog(sh));
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
      console.error("gpuOverlay link failed:", gl.getProgramInfoLog(program));
      return null;
    }

    const quad = new Float32Array([
      -1, -1, 0, 0,  1, -1, 1, 0,  -1, 1, 0, 1,
      -1,  1, 0, 1,  1, -1, 1, 0,   1, 1, 1, 1,
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

    const u = (n: string) => gl.getUniformLocation(program, n);
    cache = {
      gl, canvas, program, tex,
      u: {
        image: u("u_inputImage"), resolution: u("u_resolution"), time: u("u_time"),
        effect: u("u_effect"), intensity: u("u_intensity"), scale: u("u_scale"),
        speed: u("u_speed"), detail: u("u_detail"), softness: u("u_softness"),
        extra: u("u_extra"), opacity: u("u_opacity"), tint: u("u_tint"),
        tint2: u("u_tint2"), pos: u("u_pos"), blend: u("u_blend"),
        adjustment: u("u_adjustment"),
      },
    };
    // 1×1 opaque pixel kept bound so adjustment draws always have a complete tex.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    return cache;
  } catch (e) {
    console.error("gpuOverlay init failed:", e);
    cache = null;
    return null;
  }
}

/** Render one GPU-overlay effect. Returns the (shared, reused) canvas or null. */
export function renderGpuFx(src: Texture | null, w: number, h: number, p: GpuFxParams): HTMLCanvasElement | null {
  const g = init();
  if (!g || w <= 0 || h <= 0) return null;
  const { gl, canvas, program, tex, u } = g;

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);

  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (!p.adjustment && src) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
    } catch (e) {
      console.error("gpuOverlay texUpload failed:", e);
      return null;
    }
  }

  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(u.image, 0);
  gl.uniform1i(u.adjustment, p.adjustment ? 1 : 0);
  gl.uniform2f(u.resolution, w, h);
  gl.uniform1f(u.time, p.time);
  gl.uniform1i(u.effect, p.effect | 0);
  gl.uniform1f(u.intensity, p.intensity);
  gl.uniform1f(u.scale, p.scale);
  gl.uniform1f(u.speed, p.speed);
  gl.uniform1f(u.detail, p.detail);
  gl.uniform1f(u.softness, p.softness);
  gl.uniform1f(u.extra, p.extra);
  gl.uniform1f(u.opacity, p.opacity);
  gl.uniform3f(u.tint, p.tint[0], p.tint[1], p.tint[2]);
  gl.uniform3f(u.tint2, p.tint2[0], p.tint2[1], p.tint2[2]);
  gl.uniform2f(u.pos, p.pos[0], p.pos[1]);
  gl.uniform1i(u.blend, p.blend | 0);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
  return canvas;
}

/** Effects that emit a compositable overlay (usable on adjustment layers). The
 *  displacement/darkening effects (Heat Haze 4, Vignette 6) need the underlying
 *  pixels and are per-image only. */
export function gpuFxIsOverlay(effect: number): boolean {
  return effect !== 4 && effect !== 6;
}
