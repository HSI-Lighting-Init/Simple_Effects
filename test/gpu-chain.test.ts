import { describe, it, expect, afterEach } from "vitest";
import { makeCanvas } from "./setup";
import type { ResolvedEffect } from "../src/bindings/ResolvedEffect";
import type { Texture } from "../src/lib/surface3d";
import {
  runPasses,
  renderGpuFx,
  gpuFxPass,
  gpuHealthCheck,
  getGpuStats,
  gpuPoolIds,
  resetGpuFx,
  takeGpuFailure,
  gpuFailurePeek,
  isGpuFailure,
  GpuFailureError,
  registerGpuProgram,
  type GpuPass,
} from "../src/lib/gpuFx";
import { applyEffects, gpuRuns } from "../src/lib/effects";

// A scripted WebGL2 stand-in. The pass-chain code only needs a context that
// accepts the calls and reports success; assertions use the module's own
// counters (uploads, readbacks, passes, texture allocations), so this fake only
// has to be faithful about context loss and compile/link status.
function makeFakeGL() {
  const counts = { draws: 0, texImage2D: 0, programsLinked: 0, shadersCompiled: 0 };
  let lost = false;
  const gl: Record<string, unknown> = {
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    NO_ERROR: 0,
    TRIANGLES: 4,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    RGBA: 0x1908,
    RGBA8: 0x8058,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    CLAMP_TO_EDGE: 0x812f,
    NEAREST: 0x2600,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    BLEND: 0x0be2,
    DEPTH_TEST: 0x0b71,
    SCISSOR_TEST: 0x0c11,
    CULL_FACE: 0x0b44,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
  };
  const noop = () => {};
  Object.assign(gl, {
    createShader: () => ({}),
    shaderSource: (sh: { src?: string }, src: string) => { sh.src = src; },
    compileShader: () => {},
    getShaderParameter: (sh: { src?: string }) => !(sh?.src ?? "").includes("COMPILE_FAIL"),
    getShaderInfoLog: () => "fake compile log",
    deleteShader: noop,
    createProgram: () => ({}),
    attachShader: noop,
    linkProgram: () => { counts.programsLinked++; },
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    deleteProgram: noop,
    useProgram: noop,
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    enableVertexAttribArray: noop,
    disableVertexAttribArray: noop,
    vertexAttribPointer: noop,
    createBuffer: () => ({}),
    bindBuffer: noop,
    bufferData: noop,
    createTexture: () => ({}),
    bindTexture: noop,
    texParameteri: noop,
    texImage2D: () => { counts.texImage2D++; },
    createFramebuffer: () => ({}),
    bindFramebuffer: noop,
    framebufferTexture2D: noop,
    checkFramebufferStatus: () => 0x8cd5,
    deleteTexture: noop,
    deleteFramebuffer: noop,
    viewport: noop,
    enable: noop,
    disable: noop,
    colorMask: noop,
    clearColor: noop,
    clear: noop,
    drawArrays: () => { counts.draws++; },
    pixelStorei: noop,
    activeTexture: noop,
    uniform1i: noop,
    uniform1f: noop,
    uniform2f: noop,
    uniform3f: noop,
    getError: () => 0,
    isContextLost: () => lost,
  });
  return { gl: gl as unknown as WebGL2RenderingContext, counts, lose: () => { lost = true; } };
}

function installFakeDocument(fake: ReturnType<typeof makeFakeGL>, webgl2: boolean) {
  const doc = globalThis.document as unknown as { createElement: (tag: string) => unknown };
  const original = doc.createElement;
  doc.createElement = (tag: string) => {
    const canvas = makeCanvas(4, 4) as Record<string, unknown>;
    canvas.getContext = (type: string) =>
      type === "webgl2" && webgl2 ? fake.gl : type === "2d" ? makeCanvas(4, 4).getContext("2d") : null;
    canvas.addEventListener = () => {};
    return canvas;
  };
  return () => { doc.createElement = original; };
}

const gpuFxEffect = (over: Partial<Extract<ResolvedEffect, { kind: "gpuoverlay" }>> = {}) =>
  ({
    kind: "gpuoverlay",
    effect: 1,
    time: 0,
    intensity: 1,
    scale: 1,
    speed: 0,
    detail: 2,
    softness: 0.5,
    extra: 0.4,
    opacity: 1,
    tint: { r: 255, g: 255, b: 255, a: 255 },
    tint2: { r: 0, g: 0, b: 0, a: 255 },
    posX: 0.5,
    posY: 0.5,
    blend: 1,
    ...over,
  }) as Extract<ResolvedEffect, { kind: "gpuoverlay" }>;

const shineEffect = () =>
  ({
    kind: "shinyclouds",
    time: 0,
    intensity: 1,
    scale: 1,
    speed: 0,
    complexity: 2,
    contrast: 1,
    brightness: 0,
    opacity: 1,
    tint: { r: 255, g: 255, b: 255, a: 255 },
    blend: 1,
  }) as Extract<ResolvedEffect, { kind: "shinyclouds" }>;

const pass = (name = "probe", frag = "void main(){}"): GpuPass => ({ name, frag });

const delta = (before: ReturnType<typeof getGpuStats>) => {
  const after = getGpuStats();
  return {
    uploads: after.uploads - before.uploads,
    readbacks: after.readbacks - before.readbacks,
    passes: after.passes - before.passes,
    textureAllocs: after.textureAllocs - before.textureAllocs,
    programsLinked: after.programsLinked - before.programsLinked,
  };
};

afterEach(() => {
  resetGpuFx();
});

describe("WP2: typed GPU failure", () => {
  it("runPasses returns a typed failure when WebGL2 is unavailable, not null/dead canvas", () => {
    resetGpuFx();
    const res = runPasses(makeCanvas(4, 4) as unknown as Texture, 4, 4, [pass()]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/webgl2/i);
    expect(gpuFailurePeek()).toMatch(/webgl2/i);
    const first = takeGpuFailure();
    expect(first).toMatch(/webgl2/i);
    expect(takeGpuFailure()).toBeNull();
  });

  it("renderGpuFx also returns the typed failure", () => {
    resetGpuFx();
    const res = renderGpuFx(makeCanvas(4, 4) as unknown as Texture, 4, 4, {
      effect: 1,
      time: 0,
      intensity: 1,
      scale: 1,
      speed: 0,
      detail: 2,
      softness: 0.5,
      extra: 0.4,
      opacity: 1,
      tint: [1, 1, 1],
      tint2: [0, 0, 0],
      pos: [0.5, 0.5],
      blend: 1,
    });
    expect(res.ok).toBe(false);
  });

  it("a shader compile failure is a typed failure naming the pass", () => {
    resetGpuFx();
    const fake = makeFakeGL();
    const restore = installFakeDocument(fake, true);
    try {
      const res = runPasses(makeCanvas(4, 4) as unknown as Texture, 4, 4, [pass("broken", "COMPILE_FAIL")]);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/compile/i);
    } finally {
      restore();
    }
  });

  it("marks the chain failed after WEBGL_lose_context (no dead canvas)", () => {
    resetGpuFx();
    const fake = makeFakeGL();
    const restore = installFakeDocument(fake, true);
    try {
      const first = runPasses(makeCanvas(4, 4) as unknown as Texture, 4, 4, [pass()]);
      expect(first.ok).toBe(true);
      fake.lose();
      const lost = runPasses(makeCanvas(4, 4) as unknown as Texture, 4, 4, [pass()]);
      expect(lost.ok).toBe(false);
      if (!lost.ok) expect(lost.error).toMatch(/lost/i);
      expect(gpuFailurePeek()).toMatch(/lost/i);
    } finally {
      restore();
    }
  });

  it("GpuFailureError is detectable so export can abort instead of falling back", () => {
    const e = new GpuFailureError("GPU effect failed: boom");
    expect(isGpuFailure(e)).toBe(true);
    expect(isGpuFailure(new Error("other"))).toBe(false);
  });
});

describe("WP1: pass chain", () => {
  it("a 3-pass chain uploads once, reads back once, and runs 3 passes", () => {
    resetGpuFx();
    const fake = makeFakeGL();
    const restore = installFakeDocument(fake, true);
    try {
      const input = makeCanvas(8, 8) as unknown as Texture;
      const before = getGpuStats();
      const res = runPasses(input, 8, 8, [pass("a"), pass("b"), pass("c")]);
      expect(res.ok).toBe(true);
      const d = delta(before);
      expect(d).toMatchObject({ uploads: 1, readbacks: 1, passes: 3 });
    } finally {
      restore();
    }
  });

  it("reuses the size-keyed texture/FBO pool and the program cache on the next frame", () => {
    resetGpuFx();
    const fake = makeFakeGL();
    const restore = installFakeDocument(fake, true);
    try {
      const run = () => runPasses(makeCanvas(8, 8) as unknown as Texture, 8, 8, [pass("a"), pass("b")]);
      expect(run().ok).toBe(true);
      const before = getGpuStats();
      expect(run().ok).toBe(true);
      const d = delta(before);
      expect(d.textureAllocs).toBe(0);
      expect(d.programsLinked).toBe(0);
      expect(d).toMatchObject({ uploads: 1, readbacks: 1, passes: 2 });
    } finally {
      restore();
    }
  });

  it("a 3-pass chain leaves each pooled texture once, so the next chain never self-samples", () => {
    resetGpuFx();
    const fake = makeFakeGL();
    const restore = installFakeDocument(fake, true);
    try {
      const run = () =>
        runPasses(makeCanvas(8, 8) as unknown as Texture, 8, 8, [pass("a"), pass("b"), pass("c")]);
      expect(run().ok).toBe(true);
      const ids = gpuPoolIds(8, 8);
      expect(ids.length).toBe(2);
      expect(new Set(ids).size).toBe(ids.length);
      expect(run().ok).toBe(true);
      const ids2 = gpuPoolIds(8, 8);
      expect(new Set(ids2).size).toBe(ids2.length);
    } finally {
      restore();
    }
  });

  it("a pass can sample a second earlier pass as u_inputImage2", () => {
    resetGpuFx();
    const fake = makeFakeGL();
    const restore = installFakeDocument(fake, true);
    try {
      const before = getGpuStats();
      const passes: GpuPass[] = [
        pass("key"),
        pass("cleanup"),
        { ...pass("final"), source: 0, source2: 1 },
      ];
      const res = runPasses(makeCanvas(8, 8) as unknown as Texture, 8, 8, passes);
      expect(res.ok).toBe(true);
      expect(delta(before)).toMatchObject({ uploads: 1, readbacks: 1, passes: 3 });
    } finally {
      restore();
    }
  });

  it("rejects a second source that is not an earlier pass", () => {
    resetGpuFx();
    const fake = makeFakeGL();
    const restore = installFakeDocument(fake, true);
    try {
      const res = runPasses(makeCanvas(8, 8) as unknown as Texture, 8, 8, [
        pass("a"),
        { ...pass("b"), source2: 1 },
      ]);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/second input/i);
    } finally {
      restore();
    }
  });

  it("gpuHealthCheck links every registered program and renders a probe frame for each", () => {
    resetGpuFx();
    registerGpuProgram("probeA", "// probe a\nvoid main(){}");
    registerGpuProgram("probeB", "// probe b\nvoid main(){}");
    const fake = makeFakeGL();
    const restore = installFakeDocument(fake, true);
    try {
      const health = gpuHealthCheck();
      expect(health.ok).toBe(true);
      if (health.ok) expect(health.programs).toBeGreaterThanOrEqual(2);
      expect(fake.counts.draws).toBeGreaterThanOrEqual(2);
    } finally {
      restore();
    }
  });

  it("gpuHealthCheck fails loudly on an unavailable context", () => {
    resetGpuFx();
    const health = gpuHealthCheck();
    expect(health.ok).toBe(false);
  });
});

describe("WP1: applyEffects shares one upload/readback per run", () => {
  it("groups consecutive GPU effects, splitting at a non-GPU effect", () => {
    const effects: ResolvedEffect[] = [
      gpuFxEffect(),
      shineEffect(),
      { kind: "blur", radius: 2 },
      gpuFxEffect(),
    ];
    expect(gpuRuns(effects).map((r) => r.map((e) => e.kind))).toEqual([
      ["gpuoverlay", "shinyclouds"],
      ["gpuoverlay"],
    ]);
    expect(gpuRuns([{ kind: "blur", radius: 2 }])).toEqual([]);
  });

  it("a [gpu, gpu, blur, gpu] stack costs two uploads and two readbacks", () => {
    resetGpuFx();
    const fake = makeFakeGL();
    const restore = installFakeDocument(fake, true);
    try {
      const off = makeCanvas(8, 8) as unknown as HTMLCanvasElement;
      const src = makeCanvas(8, 8) as unknown as Texture;
      const effects: ResolvedEffect[] = [gpuFxEffect(), shineEffect(), { kind: "blur", radius: 2 }, gpuFxEffect()];
      const before = getGpuStats();
      const seen: string[] = [];
      expect(() => applyEffects(off, src, 8, 8, effects, (m) => seen.push(m))).not.toThrow();
      expect(delta(before)).toMatchObject({ uploads: 2, readbacks: 2, passes: 3 });
      expect(seen).toEqual([]);
    } finally {
      restore();
    }
  });

  it("a failing GPU run leaves the layer drawable and reports through the callback", () => {
    resetGpuFx();
    // No WebGL in this environment: the run fails, but applyEffects must still
    // return a canvas (the unprocessed source), never a dead GL canvas.
    const off = makeCanvas(8, 8) as unknown as HTMLCanvasElement;
    const src = makeCanvas(8, 8) as unknown as Texture;
    const seen: string[] = [];
    const tex = applyEffects(off, src, 8, 8, [gpuFxEffect()], (m) => seen.push(m));
    expect(tex).toBe(off);
    expect(seen.length).toBe(1);
    expect(gpuFailurePeek()).toMatch(/webgl2/i);
  });
});
