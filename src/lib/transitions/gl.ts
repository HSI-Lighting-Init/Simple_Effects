// Optional WebGL blend path for the pixel-blend transitions (fade, dissolve).
// It renders two prepared, same-size frames into an offscreen GL canvas and the
// caller composites the result. Everything is defensive: any failure returns
// false so the transition falls back to the (always-correct) CPU path.

let glCanvas: HTMLCanvasElement | null = null;
let gl: WebGLRenderingContext | null = null;
let program: WebGLProgram | null = null;
let quad: WebGLBuffer | null = null;
let texA: WebGLTexture | null = null;
let texB: WebGLTexture | null = null;
let supported: boolean | null = null;

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = (aPos + 1.0) * 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// mode 0 = crossfade, mode 1 = dissolve (B source-over A, B alpha scaled by p).
const FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uP;
uniform int uMode;
void main() {
  vec4 a = texture2D(uA, vUv);
  vec4 b = texture2D(uB, vUv);
  if (uMode == 1) {
    float ba = b.a * uP;
    vec3 rgb = b.rgb * ba + a.rgb * (1.0 - ba);
    float al = ba + a.a * (1.0 - ba);
    gl_FragColor = vec4(rgb, al);
  } else {
    gl_FragColor = mix(a, b, uP);
  }
}`;

function compile(g: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = g.createShader(type);
  if (!s) return null;
  g.shaderSource(s, src);
  g.compileShader(s);
  if (!g.getShaderParameter(s, g.COMPILE_STATUS)) return null;
  return s;
}

function init(): boolean {
  if (supported != null) return supported;
  try {
    glCanvas = document.createElement("canvas");
    gl = (glCanvas.getContext("webgl", { premultipliedAlpha: false, alpha: true }) ||
      glCanvas.getContext("experimental-webgl", { premultipliedAlpha: false })) as
      | WebGLRenderingContext
      | null;
    if (!gl) throw new Error("no webgl");
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) throw new Error("shader compile failed");
    program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("link failed");
    quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    texA = gl.createTexture();
    texB = gl.createTexture();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    supported = true;
  } catch {
    supported = false;
  }
  return supported;
}

export function isGpuSupported(): boolean {
  return init();
}

function upload(g: WebGLRenderingContext, tex: WebGLTexture, src: TexImageSource) {
  g.bindTexture(g.TEXTURE_2D, tex);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, src);
}

/**
 * Blend prepared frames `a`,`b` (same size) into the 2D context `ctx` at (w,h).
 * `mode` 0 = crossfade, 1 = dissolve. Returns false on any failure (→ CPU).
 */
export function glBlend(
  ctx: CanvasRenderingContext2D,
  a: HTMLCanvasElement,
  b: HTMLCanvasElement,
  w: number,
  h: number,
  progress: number,
  mode: number
): boolean {
  if (!init() || !gl || !glCanvas || !program) return false;
  try {
    const g = gl;
    if (glCanvas.width !== w || glCanvas.height !== h) {
      glCanvas.width = w;
      glCanvas.height = h;
    }
    g.viewport(0, 0, w, h);
    g.clearColor(0, 0, 0, 0);
    g.clear(g.COLOR_BUFFER_BIT);
    g.useProgram(program);
    upload(g, texA!, a);
    upload(g, texB!, b);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, texA);
    g.uniform1i(g.getUniformLocation(program, "uA"), 0);
    g.activeTexture(g.TEXTURE1);
    g.bindTexture(g.TEXTURE_2D, texB);
    g.uniform1i(g.getUniformLocation(program, "uB"), 1);
    g.uniform1f(g.getUniformLocation(program, "uP"), progress);
    g.uniform1i(g.getUniformLocation(program, "uMode"), mode);
    const loc = g.getAttribLocation(program, "aPos");
    g.bindBuffer(g.ARRAY_BUFFER, quad);
    g.enableVertexAttribArray(loc);
    g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(glCanvas, 0, 0);
    return true;
  } catch {
    return false;
  }
}
