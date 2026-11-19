// GPU pass for the "Shiny Clouds" effect. It now runs on the shared pass chain
// in gpuFx.ts (one WebGL2 context for every GPU effect, one upload/readback per
// stack), so consecutive GPU effects ping-pong on the GPU instead of making a
// GPU→2D→GPU round trip per effect.
import fragSrc from "../shaders/shinyClouds.frag?raw";
import { registerGpuProgram, runPasses, type GpuPass, type GpuResult } from "./gpuFx";
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

registerGpuProgram("shinyClouds", fragSrc);

/** The shine as a chain pass (for use inside a multi-pass GPU stack). */
export function shinePass(p: ShineParams): GpuPass {
  return {
    name: "shinyClouds",
    frag: fragSrc,
    uniforms: {
      u_time: { type: "1f", value: p.time },
      u_intensity: { type: "1f", value: p.intensity },
      u_scale: { type: "1f", value: p.scale },
      u_speed: { type: "1f", value: p.speed },
      u_complexity: { type: "1f", value: p.complexity },
      u_contrast: { type: "1f", value: p.contrast },
      u_brightness: { type: "1f", value: p.brightness },
      u_tintColor: { type: "3f", value: p.tint },
      u_blendMode: { type: "1i", value: p.blend },
      u_opacity: { type: "1f", value: p.opacity },
      u_adjustment: { type: "1i", value: p.adjustment ? 1 : 0 },
    },
  };
}

/** True if the GPU pass is available (used to decide whether to attempt it). */
export function shineSupported(): boolean {
  return runPasses(null, 1, 1, [shinePass({ time: 0, intensity: 0, scale: 1, speed: 0, complexity: 1, contrast: 1, brightness: 0, tint: [0, 0, 0], blend: 0, opacity: 0, adjustment: true })]).ok;
}

/**
 * Composite the shine over `src` (size w×h) into the shared GL canvas, or
 * return a typed failure. The returned canvas is shared/reused — draw it out
 * before calling again.
 */
export function renderShine(src: Texture | null, w: number, h: number, p: ShineParams): GpuResult {
  return runPasses(src, w, h, [shinePass(p)]);
}
