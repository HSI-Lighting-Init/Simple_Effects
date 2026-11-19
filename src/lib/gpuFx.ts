// Shared GPU pass chain for the "GPU Overlay" effect family (gpuOverlay.frag)
// and the Shiny Clouds effect (shinyClouds.frag), plus any later GPU effect.
//
// One lazily created, reused WebGL2 context owns:
//   - a program cache keyed by fragment-shader source,
//   - a size-keyed pool of RGBA8 textures + framebuffers,
//   - a fullscreen-quad buffer.
//
// `runPasses` uploads the source once, runs every pass back to back on the GPU
// (ping-ponging through the pooled textures), and draws the last pass to the
// canvas once — so a whole GPU stack costs one upload and one readback.
// Pooled targets use bilinear filtering, so the shipped effect shaders keep
// their existing look; a pass that needs exact pixels (the future keyer) can
// still use `texelFetch`, which ignores the filter. Blending is off.
//
// Failures are typed. A missing WebGL2 context, a compile/link error, a lost
// context or a GL error returns `{ ok: false, error }` and is recorded for the
// export guard (`takeGpuFailure`). The caller never receives a canvas that may
// hold a stale frame.
import fragSrc from "../shaders/gpuOverlay.frag?raw";
import vertSrc from "../shaders/fullscreen.vert?raw";
import type { Texture } from "./surface3d";

export interface GpuFxParams {
  effect: number; // 0..10
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

export type GpuUniform =
  | { type: "1f"; value: number }
  | { type: "2f"; value: readonly [number, number] }
  | { type: "3f"; value: readonly [number, number, number] }
  | { type: "1i"; value: number };

export interface GpuPass {
  /** Label used in error messages (and by the health check). */
  name: string;
  /**
   * GLSL ES 3.00 fragment shader. `u_inputImage` and `u_resolution` are bound by
   * the chain, plus `u_inputImage2` (unit 1) when `source2` is set.
   */
  frag: string;
  /** Extra uniforms, set after `u_inputImage`/`u_resolution` on every pass. */
  uniforms?: Record<string, GpuUniform>;
  /** Sample the output of an earlier pass (index) instead of the chain input / previous pass. */
  source?: number;
  /**
   * Sample a second earlier pass (index) as `u_inputImage2` on texture unit 1.
   * Used by the Ultra Key final pass, which needs the key result and the
   * cleaned matte together.
   */
  source2?: number;
}

export type GpuResult = { ok: true; canvas: HTMLCanvasElement } | { ok: false; error: string };

export type GpuHealth = { ok: true; programs: number } | { ok: false; error: string };

/** A GPU failure that must abort an export (never fall back to another renderer). */
export class GpuFailureError extends Error {
  readonly gpuFailure = true;
  constructor(message: string) {
    super(message);
    this.name = "GpuFailureError";
  }
}

export function isGpuFailure(e: unknown): e is GpuFailureError {
  return e instanceof GpuFailureError || (typeof e === "object" && e !== null && (e as { gpuFailure?: boolean }).gpuFailure === true);
}

export interface GpuStats {
  uploads: number;
  readbacks: number;
  passes: number;
  chains: number;
  textureAllocs: number;
  programsLinked: number;
}

const stats: GpuStats = {
  uploads: 0,
  readbacks: 0,
  passes: 0,
  chains: 0,
  textureAllocs: 0,
  programsLinked: 0,
};

/** Snapshot of the cumulative GPU work counters (used by the applyEffects timer). */
export function getGpuStats(): GpuStats {
  return { ...stats };
}

interface ProgramInfo {
  program: WebGLProgram;
  posLoc: number;
  uvLoc: number;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

interface PooledTex {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  /** True while the texture sits in the pool; guards against double releases. */
  released: boolean;
}

interface GL {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  vbo: WebGLBuffer;
  dummy: WebGLTexture;
  vert: WebGLShader | null;
  programs: Map<string, ProgramInfo>;
  pool: Map<string, PooledTex[]>;
  lost: boolean;
}

// undefined = not yet tried, null = tried and unavailable, GL = ready.
let cache: GL | null | undefined;

// Every shader the health check must compile before an export. Registered at
// module load by the modules that own a shader; keyed by a stable label.
const programSources = new Map<string, string>();

export function registerGpuProgram(name: string, frag: string): void {
  programSources.set(name, frag);
}

registerGpuProgram("gpuOverlay", fragSrc);

// Last failure, for the export guard and the preview badge.
let lastFailure: string | null = null;

function fail(message: string, record = true): { ok: false; error: string } {
  if (record) lastFailure = message;
  return { ok: false, error: message };
}

export function noteGpuFailure(message: string): void {
  lastFailure = message;
}

export function gpuFailurePeek(): string | null {
  return lastFailure;
}

/** Read (and clear) the pending failure — the export loop calls this per frame. */
export function takeGpuFailure(): string | null {
  const f = lastFailure;
  lastFailure = null;
  return f;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): { ok: true; shader: WebGLShader } | { ok: false; error: string } {
  const sh = gl.createShader(type);
  if (!sh) return { ok: false, error: "could not create a shader" };
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    return { ok: false, error: "shader compile failed: " + (log || "no log") };
  }
  return { ok: true, shader: sh };
}

function init(): { ok: true; g: GL } | { ok: false; error: string } {
  if (cache !== undefined) {
    if (!cache) return { ok: false, error: "WebGL2 is unavailable" };
    if (cache.lost || cache.gl.isContextLost()) {
      cache.lost = true;
      cache = undefined;
      return { ok: false, error: "GPU context lost" };
    }
    return { ok: true, g: cache };
  }
  cache = null;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, alpha: true });
    if (!gl) return { ok: false, error: "WebGL2 is unavailable" };
    if (gl.isContextLost()) return { ok: false, error: "GPU context lost" };

    // A lost context makes every subsequent WebGL call a silent no-op, so a
    // canvas would keep showing its last frame. Drop the cache and record the
    // loss: the current call fails loudly and export aborts.
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      console.error("gpuFx: WebGL context lost");
      lastFailure = "GPU context lost";
      if (cache && cache.canvas === canvas) cache = undefined;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      cache = undefined; // rebuild from scratch on the next use
    });

    const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    if (!vs.ok) return { ok: false, error: vs.error };

    // Fullscreen quad: interleaved (pos.xy, uv). Uploads flip Y, passes sample
    // with texelFetch at gl_FragCoord, so every stage stays upright.
    const quad = new Float32Array([
      -1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1,
      -1, 1, 0, 1, 1, -1, 1, 0, 1, 1, 1, 1,
    ]);
    const vbo = gl.createBuffer();
    if (!vbo) return { ok: false, error: "could not create the quad buffer" };
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    const dummy = gl.createTexture();
    if (!dummy) return { ok: false, error: "could not create the fallback texture" };
    gl.bindTexture(gl.TEXTURE_2D, dummy);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

    cache = { gl, canvas, vbo, dummy, vert: vs.shader, programs: new Map(), pool: new Map(), lost: false };
    return { ok: true, g: cache };
  } catch (e) {
    console.error("gpuFx init failed:", e);
    cache = null;
    return { ok: false, error: "GPU init failed: " + String(e) };
  }
}

function getProgram(g: GL, frag: string): { ok: true; info: ProgramInfo } | { ok: false; error: string } {
  const cached = g.programs.get(frag);
  if (cached) return { ok: true, info: cached };
  const { gl } = g;
  if (!g.vert) return { ok: false, error: "vertex shader missing" };
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, frag);
  if (!fs.ok) return fs;
  const program = gl.createProgram();
  if (!program) return { ok: false, error: "could not create a program" };
  gl.attachShader(program, g.vert);
  gl.attachShader(program, fs.shader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    gl.deleteShader(fs.shader);
    return { ok: false, error: "program link failed: " + (log || "no log") };
  }
  const info: ProgramInfo = {
    program,
    posLoc: gl.getAttribLocation(program, "a_position"),
    uvLoc: gl.getAttribLocation(program, "a_texCoord"),
    uniforms: new Map(),
  };
  g.programs.set(frag, info);
  stats.programsLinked++;
  return { ok: true, info };
}

function uniformLoc(g: GL, info: ProgramInfo, name: string): WebGLUniformLocation | null {
  if (!info.uniforms.has(name)) info.uniforms.set(name, g.gl.getUniformLocation(info.program, name));
  return info.uniforms.get(name) ?? null;
}

function poolKey(w: number, h: number): string {
  return w + "x" + h;
}

let texId = 0;

function acquireTex(g: GL, w: number, h: number): PooledTex | null {
  const key = poolKey(w, h);
  const list = g.pool.get(key);
  const reused = list?.pop();
  if (reused) {
    reused.released = false;
    return reused;
  }
  const { gl } = g;
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo = gl.createFramebuffer();
  if (!fbo) {
    gl.deleteTexture(tex);
    return null;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    return null;
  }
  stats.textureAllocs++;
  (tex as unknown as { __id?: number }).__id = ++texId;
  return { tex, fbo, released: false };
}

function releaseTex(g: GL, w: number, h: number, item: PooledTex): void {
  if (item.released) return; // a chain must never put the same texture in twice
  item.released = true;
  const key = poolKey(w, h);
  const list = g.pool.get(key);
  if (list) list.push(item);
  else g.pool.set(key, [item]);
}

function uploadTex(g: GL, w: number, h: number, src: Texture): PooledTex | null {
  const item = acquireTex(g, w, h);
  if (!item) return null;
  const { gl } = g;
  gl.bindTexture(gl.TEXTURE_2D, item.tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
  } catch (e) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    releaseTex(g, w, h, item);
    console.error("gpuFx texture upload failed:", e);
    return null;
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  stats.uploads++;
  return item;
}

function bindQuad(g: GL, info: ProgramInfo): void {
  const { gl } = g;
  gl.bindBuffer(gl.ARRAY_BUFFER, g.vbo);
  if (info.posLoc >= 0) {
    gl.enableVertexAttribArray(info.posLoc);
    gl.vertexAttribPointer(info.posLoc, 2, gl.FLOAT, false, 16, 0);
  }
  if (info.uvLoc >= 0) {
    gl.enableVertexAttribArray(info.uvLoc);
    gl.vertexAttribPointer(info.uvLoc, 2, gl.FLOAT, false, 16, 8);
  }
}

/**
 * Run `passes` over `input` and return the shared GL canvas holding the result.
 * One upload, one readback (the final pass draws to the canvas). Passes sample
 * the chain input (pass 0), the previous pass (default), or a named earlier
 * pass via `source`.
 */
export function runPasses(input: Texture | null, w: number, h: number, passes: GpuPass[]): GpuResult {
  const t = init();
  if (!t.ok) return fail(t.error);
  const g = t.g;
  const { gl, canvas } = g;
  if (w <= 0 || h <= 0) return fail("GPU pass chain needs a positive size");
  if (passes.length === 0) return fail("GPU pass chain has no passes");
  if (gl.isContextLost()) {
    g.lost = true;
    cache = undefined;
    return fail("GPU context lost");
  }

  // Validate references before touching GL.
  for (let i = 0; i < passes.length; i++) {
    const s = passes[i].source;
    if (s != null && (s < 0 || s >= i)) {
      return fail(`GPU pass "${passes[i].name}" samples pass ${s}, which is not an earlier pass`);
    }
    const s2 = passes[i].source2;
    if (s2 != null && (s2 < 0 || s2 >= i)) {
      return fail(
        `GPU pass "${passes[i].name}" samples pass ${s2} as its second input, which is not an earlier pass`
      );
    }
  }

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, w, h);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.CULL_FACE);
  gl.colorMask(true, true, true, true);

  const owned: PooledTex[] = [];
  const sourceTex = input ? uploadTex(g, w, h, input) : null;
  if (input && !sourceTex) return fail("GPU texture upload failed");
  if (sourceTex) {
    owned.push(sourceTex);
    const upErr = gl.getError();
    if (upErr !== gl.NO_ERROR) {
      const msg = `GPU error 0x${upErr.toString(16)} uploading the chain input`;
      console.error(msg);
      owned.pop();
      releaseTex(g, w, h, sourceTex);
      return fail(msg);
    }
  }

  const outputs: (PooledTex | null)[] = new Array(passes.length).fill(null);
  // Last pass that reads each output (or the chain input, index -1).
  const lastUse: number[] = new Array(passes.length).fill(-1);
  let inputLastUse = -1;
  for (let i = 0; i < passes.length; i++) {
    const s = passes[i].source;
    if (s != null) lastUse[s] = Math.max(lastUse[s], i);
    else if (i === 0) inputLastUse = Math.max(inputLastUse, i);
    else lastUse[i - 1] = Math.max(lastUse[i - 1], i);
    const s2 = passes[i].source2;
    if (s2 != null) lastUse[s2] = Math.max(lastUse[s2], i);
  }

  const release = (item: PooledTex | null, index: number) => {
    if (!item) return;
    releaseTex(g, w, h, item);
    const slot = owned.indexOf(item);
    if (slot >= 0) owned.splice(slot, 1);
    if (index >= 0) outputs[index] = null;
  };

  try {
    for (let i = 0; i < passes.length; i++) {
      const p = passes[i];
      const prog = getProgram(g, p.frag);
      if (!prog.ok) return fail(`GPU pass "${p.name}": ${prog.error}`);
      const info = prog.info;

      let src: WebGLTexture;
      if (p.source != null) {
        const out = outputs[p.source];
        if (!out) return fail(`GPU pass "${p.name}": source pass ${p.source} is unavailable`);
        src = out.tex;
      } else if (i === 0) {
        src = sourceTex ? sourceTex.tex : g.dummy;
      } else {
        const out = outputs[i - 1];
        if (!out) return fail(`GPU pass "${p.name}": previous pass is unavailable`);
        src = out.tex;
      }

      const last = i === passes.length - 1;
      if (last) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        stats.readbacks++;
      } else {
        const dst = acquireTex(g, w, h);
        if (!dst) return fail(`GPU pass "${p.name}": could not allocate a ${w}x${h} RGBA8 target`);
        outputs[i] = dst;
        owned.push(dst);
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      }
      gl.viewport(0, 0, w, h);

      gl.useProgram(info.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(uniformLoc(g, info, "u_inputImage"), 0);
      if (p.source2 != null) {
        const out2 = outputs[p.source2];
        if (!out2) return fail(`GPU pass "${p.name}": second source pass ${p.source2} is unavailable`);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, out2.tex);
        gl.uniform1i(uniformLoc(g, info, "u_inputImage2"), 1);
        gl.activeTexture(gl.TEXTURE0);
      }
      gl.uniform2f(uniformLoc(g, info, "u_resolution"), w, h);
      if (p.uniforms) {
        for (const [name, u] of Object.entries(p.uniforms)) {
          const loc = uniformLoc(g, info, name);
          if (u.type === "1f") gl.uniform1f(loc, u.value);
          else if (u.type === "1i") gl.uniform1i(loc, u.value | 0);
          else if (u.type === "2f") gl.uniform2f(loc, u.value[0], u.value[1]);
          else gl.uniform3f(loc, u.value[0], u.value[1], u.value[2]);
        }
      }
      bindQuad(g, info);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      // Read after every pass so the message names the pass that went wrong.
      const err = gl.getError();
      if (err !== gl.NO_ERROR) {
        const msg = `GPU error 0x${err.toString(16)} in pass "${p.name}"`;
        console.error(msg);
        return fail(msg);
      }
      stats.passes++;

      if (sourceTex && i === inputLastUse) release(sourceTex, -1);
      for (let j = 0; j <= i; j++) {
        if (outputs[j] && lastUse[j] <= i) release(outputs[j], j);
      }
    }
  } finally {
    for (const item of owned.splice(0)) releaseTex(g, w, h, item);
  }

  if (gl.isContextLost()) {
    g.lost = true;
    cache = undefined;
    return fail("GPU context lost");
  }
  const err = gl.getError();
  if (err !== gl.NO_ERROR) return fail(`GPU error 0x${err.toString(16)}`);

  stats.chains++;
  return { ok: true, canvas };
}

/** The gpuOverlay effect as a chain pass (for use inside a multi-pass chain). */
export function gpuFxPass(p: GpuFxParams): GpuPass {
  return {
    name: "gpuOverlay",
    frag: fragSrc,
    uniforms: {
      u_time: { type: "1f", value: p.time },
      u_effect: { type: "1i", value: p.effect },
      u_intensity: { type: "1f", value: p.intensity },
      u_scale: { type: "1f", value: p.scale },
      u_speed: { type: "1f", value: p.speed },
      u_detail: { type: "1f", value: p.detail },
      u_softness: { type: "1f", value: p.softness },
      u_extra: { type: "1f", value: p.extra },
      u_opacity: { type: "1f", value: p.opacity },
      u_tint: { type: "3f", value: p.tint },
      u_tint2: { type: "3f", value: p.tint2 },
      u_pos: { type: "2f", value: p.pos },
      u_blend: { type: "1i", value: p.blend },
      u_adjustment: { type: "1i", value: p.adjustment ? 1 : 0 },
    },
  };
}

/** Render one GPU-overlay effect through the shared chain. */
export function renderGpuFx(src: Texture | null, w: number, h: number, p: GpuFxParams): GpuResult {
  return runPasses(src, w, h, [gpuFxPass(p)]);
}

/**
 * Compile every registered program and render one 4×4 probe frame through
 * each. Run before an export that contains GPU effects: a failure means the
 * export must not start (it would ship unkeyed/unprocessed frames).
 */
export function gpuHealthCheck(): GpuHealth {
  const t = init();
  if (!t.ok) return { ok: false, error: t.error };
  const g = t.g;
  if (g.gl.isContextLost()) {
    g.lost = true;
    cache = undefined;
    return { ok: false, error: "GPU context lost" };
  }
  const probe = document.createElement("canvas");
  probe.width = 4;
  probe.height = 4;
  let programs = 0;
  for (const [name, frag] of programSources) {
    const prog = getProgram(g, frag);
    if (!prog.ok) return fail(`${name}: ${prog.error}`);
    programs++;
    const res = runPasses(probe, 4, 4, [{ name, frag }]);
    if (!res.ok) return res;
  }
  return { ok: true, programs };
}

/** Effects that emit a compositable overlay (usable on adjustment layers). */
export function gpuFxIsOverlay(effect: number): boolean {
  return effect !== 4 && effect !== 5 && effect !== 6 && effect !== 10;
}

/**
 * Dev-only harness hook: force WEBGL_lose_context on the shared context so the
 * export-abort path can be exercised from the live app (WP11). Returns false if
 * no context is alive yet.
 */
export function loseGpuContextForTest(): boolean {
  const g = cache;
  if (!g || g.lost) return false;
  const ext = g.gl.getExtension("WEBGL_lose_context");
  if (!ext) return false;
  ext.loseContext();
  return true;
}

/** Dev-only: the texture ids currently sitting in a size's pool (diagnostics). */
export function gpuPoolIds(w: number, h: number): number[] {
  const list = cache?.pool.get(poolKey(w, h)) ?? [];
  return list.map((it) => (it.tex as unknown as { __id?: number }).__id ?? -1);
}

// Dev-only bridge for the CDP checks (docs §5): imports of this module from the
// page can resolve to a second, HMR-timestamped instance, so expose the live
// one on `window` instead.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __sefxGpu?: unknown }).__sefxGpu = {
    stats: getGpuStats,
    failure: gpuFailurePeek,
    takeFailure: takeGpuFailure,
    health: gpuHealthCheck,
    loseContext: loseGpuContextForTest,
    runPasses,
    poolIds: gpuPoolIds,
    pass: gpuFxPass,
    reset: resetGpuFx,
  };
}

/**
 * Drop the context/counters (tests only — the live app keeps one context for
 * the whole session). The program registry is kept: it is static shader data.
 */
export function resetGpuFx(): void {
  cache = undefined;
  lastFailure = null;
  stats.uploads = 0;
  stats.readbacks = 0;
  stats.passes = 0;
  stats.chains = 0;
  stats.textureAllocs = 0;
  stats.programsLinked = 0;
}
