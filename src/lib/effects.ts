// Turns the evaluator's resolved effect stack into things a 2D canvas can do:
// a CSS-style `filter` string for the colour/blur effects, and a gradient-mask
// step for each `wipe` (the directional fade / reveal). Applied to an offscreen
// canvas so a wipe masks only this layer, not the whole scene.
import type { ResolvedEffect } from "../bindings/ResolvedEffect";
import type { Texture } from "./surface3d";
import { renderShine } from "./shinyClouds";
import { renderGpuFx } from "./gpuFx";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// Per-GPU-effect schema: how the seven generic slots map to named, labelled
// params for each `effect` index (keyed to gpuOverlay.frag). Shared by the
// Inspector's sliders and the agent's add_effect tool so both stay in sync
// with the shader's actual parameter ranges.
export type GpuKey = "intensity" | "scale" | "speed" | "detail" | "softness" | "extra" | "opacity";
export type GpuSlider = { key: GpuKey; label: string; min: number; max: number; step: number };
export type GpuSchema = { name: string; sliders: GpuSlider[]; colors: 0 | 1 | 2; pos: boolean };
export const GPU_FX: Record<number, GpuSchema> = {
  1: { name: "Caustics", colors: 1, pos: false, sliders: [
    { key: "intensity", label: "Intensity", min: 0, max: 2, step: 0.01 },
    { key: "scale", label: "Scale", min: 0.5, max: 5, step: 0.01 },
    { key: "speed", label: "Speed", min: 0, max: 2, step: 0.01 },
    { key: "detail", label: "Sharpness", min: 1, max: 10, step: 0.1 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
  2: { name: "Lens flare", colors: 1, pos: true, sliders: [
    { key: "intensity", label: "Intensity", min: 0, max: 2, step: 0.01 },
    { key: "extra", label: "Size", min: 0.1, max: 1, step: 0.01 },
    { key: "speed", label: "Drift speed", min: 0, max: 2, step: 0.01 },
    { key: "softness", label: "Streak", min: 0, max: 1, step: 0.01 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
  3: { name: "Sparkle", colors: 1, pos: false, sliders: [
    { key: "intensity", label: "Intensity", min: 0, max: 2, step: 0.01 },
    { key: "detail", label: "Density", min: 5, max: 120, step: 1 },
    { key: "extra", label: "Size", min: 0.02, max: 0.4, step: 0.005 },
    { key: "speed", label: "Twinkle speed", min: 0, max: 5, step: 0.01 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
  4: { name: "Heat haze", colors: 0, pos: false, sliders: [
    { key: "extra", label: "Strength", min: 0, max: 0.1, step: 0.001 },
    { key: "scale", label: "Scale", min: 1, max: 20, step: 0.1 },
    { key: "speed", label: "Speed", min: 0, max: 3, step: 0.01 },
    { key: "detail", label: "Detail", min: 1, max: 5, step: 1 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
  5: { name: "Film grain", colors: 1, pos: false, sliders: [
    { key: "intensity", label: "Intensity", min: 0, max: 0.5, step: 0.005 },
    { key: "extra", label: "Grain size", min: 1, max: 10, step: 0.1 },
    { key: "speed", label: "Speed", min: 0, max: 1, step: 0.01 },
    { key: "softness", label: "Monochrome", min: 0, max: 1, step: 0.01 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
  6: { name: "Vignette", colors: 1, pos: false, sliders: [
    { key: "intensity", label: "Intensity", min: 0, max: 1, step: 0.01 },
    { key: "softness", label: "Radius", min: 0.5, max: 1.5, step: 0.01 },
    { key: "extra", label: "Edge softness", min: 0.05, max: 1, step: 0.01 },
    { key: "detail", label: "Pulse", min: 0, max: 0.3, step: 0.005 },
    { key: "speed", label: "Pulse speed", min: 0, max: 2, step: 0.01 },
  ] },
  7: { name: "Shimmer", colors: 2, pos: false, sliders: [
    { key: "intensity", label: "Intensity", min: 0, max: 2, step: 0.01 },
    { key: "speed", label: "Speed", min: 0, max: 2, step: 0.01 },
    { key: "detail", label: "Frequency", min: 1, max: 10, step: 0.1 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
  8: { name: "Aurora", colors: 2, pos: false, sliders: [
    { key: "intensity", label: "Intensity", min: 0, max: 2, step: 0.01 },
    { key: "scale", label: "Scale", min: 0.5, max: 5, step: 0.01 },
    { key: "speed", label: "Speed", min: 0, max: 2, step: 0.01 },
    { key: "extra", label: "Width", min: 0.05, max: 1, step: 0.01 },
    { key: "detail", label: "Complexity", min: 1, max: 5, step: 1 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
  9: { name: "Fog / smoke", colors: 1, pos: false, sliders: [
    { key: "intensity", label: "Intensity", min: 0, max: 2, step: 0.01 },
    { key: "scale", label: "Scale", min: 0.5, max: 5, step: 0.01 },
    { key: "speed", label: "Speed", min: 0, max: 2, step: 0.01 },
    { key: "softness", label: "Density", min: 0, max: 1, step: 0.01 },
    { key: "detail", label: "Complexity", min: 2, max: 6, step: 1 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
  10: { name: "Flap / 3D flip", colors: 0, pos: false, sliders: [
    { key: "detail", label: "Angle°", min: -360, max: 360, step: 1 },
    { key: "extra", label: "Perspective", min: 0, max: 1, step: 0.01 },
    { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
  ] },
};

type Shine = Extract<ResolvedEffect, { kind: "shinyclouds" }>;
export function shineEffects(effects: ResolvedEffect[]): Shine[] {
  return effects.filter((e): e is Shine => e.kind === "shinyclouds");
}

/**
 * Run each shiny-clouds effect as a GPU pass over the current 2D result held in
 * `off`, drawing the composited output back into `off`. Falls back to leaving
 * `off` untouched if WebGL is unavailable. Applied after the CSS-filter + wipe
 * passes (shine reads as a final light overlay).
 */
function applyShine(off: HTMLCanvasElement, w: number, h: number, shines: Shine[]) {
  const oc = off.getContext("2d");
  if (!oc) return;
  for (const s of shines) {
    const out = renderShine(off, w, h, {
      time: s.time,
      intensity: s.intensity,
      scale: s.scale,
      speed: s.speed,
      complexity: s.complexity,
      contrast: s.contrast,
      brightness: s.brightness,
      tint: [s.tint.r / 255, s.tint.g / 255, s.tint.b / 255],
      blend: s.blend,
      opacity: s.opacity,
    });
    if (!out) continue; // GPU unavailable → skip the shine, keep the base image
    oc.clearRect(0, 0, w, h);
    oc.drawImage(out, 0, 0, w, h);
  }
}

type GpuFx = Extract<ResolvedEffect, { kind: "gpuoverlay" }>;
export function gpuFxEffects(effects: ResolvedEffect[]): GpuFx[] {
  return effects.filter((e): e is GpuFx => e.kind === "gpuoverlay");
}

/** Run each GPU-overlay effect over the current 2D result (same seam as shine). */
function applyGpuFx(off: HTMLCanvasElement, w: number, h: number, fx: GpuFx[]) {
  const oc = off.getContext("2d");
  if (!oc) return;
  for (const e of fx) {
    const out = renderGpuFx(off, w, h, {
      effect: e.effect,
      time: e.time,
      intensity: e.intensity,
      scale: e.scale,
      speed: e.speed,
      detail: e.detail,
      softness: e.softness,
      extra: e.extra,
      opacity: e.opacity,
      tint: [e.tint.r / 255, e.tint.g / 255, e.tint.b / 255],
      tint2: [e.tint2.r / 255, e.tint2.g / 255, e.tint2.b / 255],
      pos: [e.posX, e.posY],
      blend: e.blend,
    });
    if (!out) continue;
    oc.clearRect(0, 0, w, h);
    oc.drawImage(out, 0, 0, w, h);
  }
}

/**
 * Render a source texture (image or canvas) through its effect stack into the
 * scratch canvas `off` and return it. With no effects, returns `src` unchanged
 * (no allocation). Used by both the flat-image renderer and the decal renderer,
 * so effects apply whether or not the layer is pinned to a 3D shape.
 */
export function applyEffects(
  off: HTMLCanvasElement,
  src: Texture,
  srcW: number,
  srcH: number,
  effects: ResolvedEffect[]
): Texture {
  if (effects.length === 0 || srcW <= 0 || srcH <= 0) return src;
  if (off.width !== srcW || off.height !== srcH) {
    off.width = srcW;
    off.height = srcH;
  }
  const oc = off.getContext("2d");
  if (!oc) return src;
  oc.clearRect(0, 0, srcW, srcH);
  oc.filter = buildFilter(effects);
  oc.drawImage(src, 0, 0, srcW, srcH);
  oc.filter = "none";
  for (const wp of wipeEffects(effects)) applyWipe(oc, srcW, srcH, wp);
  for (const te of tornEffects(effects)) applyTornEdge(oc, srcW, srcH, te);
  const shines = shineEffects(effects);
  if (shines.length) applyShine(off, srcW, srcH, shines);
  const fx = gpuFxEffects(effects);
  if (fx.length) applyGpuFx(off, srcW, srcH, fx);
  return off;
}

/** Build the canvas `filter` string from the colour/blur effects, in order. */
export function buildFilter(effects: ResolvedEffect[]): string {
  const parts: string[] = [];
  for (const e of effects) {
    switch (e.kind) {
      case "grayscale":
        parts.push(`grayscale(${clamp01(e.amount)})`);
        break;
      case "brightness":
        parts.push(`brightness(${Math.max(0, e.amount)})`);
        break;
      case "contrast":
        parts.push(`contrast(${Math.max(0, e.amount)})`);
        break;
      case "saturate":
        parts.push(`saturate(${Math.max(0, e.amount)})`);
        break;
      case "blur":
        parts.push(`blur(${Math.max(0, e.radius)}px)`);
        break;
      case "hue":
        parts.push(`hue-rotate(${e.degrees}deg)`);
        break;
      case "invert":
        parts.push(`invert(${clamp01(e.amount)})`);
        break;
      // wipe is a mask, not a filter — handled separately.
    }
  }
  return parts.length ? parts.join(" ") : "none";
}

type Wipe = Extract<ResolvedEffect, { kind: "wipe" }>;

/** The wipe effects in the stack, in order. */
export function wipeEffects(effects: ResolvedEffect[]): Wipe[] {
  return effects.filter((e): e is Wipe => e.kind === "wipe");
}

/**
 * Apply a directional alpha wipe to an offscreen canvas of size w×h. The image
 * must already be drawn; this masks it. `position` 0..1 sweeps the edge along
 * `angle` (0 = left→right); `softness` widens the fade; `invert` flips sides.
 */
export function applyWipe(oc: CanvasRenderingContext2D, w: number, h: number, wipe: Wipe) {
  const a = (wipe.angle * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  // Project the corners onto the wipe axis to get its extent across the image.
  let min = Infinity;
  let max = -Infinity;
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]] as const) {
    const p = x * dx + y * dy;
    if (p < min) min = p;
    if (p > max) max = p;
  }
  const len = Math.max(1, max - min);
  const edge = min + clamp01(wipe.position) * len;
  const soft = Math.max(0.5, clamp01(wipe.softness) * len);
  const p1 = edge - soft / 2;
  const p2 = edge + soft / 2;
  const grad = oc.createLinearGradient(p1 * dx, p1 * dy, p2 * dx, p2 * dy);
  const aStart = wipe.invert ? 0 : 1;
  const aEnd = wipe.invert ? 1 : 0;
  grad.addColorStop(0, `rgba(0,0,0,${aStart})`);
  grad.addColorStop(1, `rgba(0,0,0,${aEnd})`);
  oc.globalCompositeOperation = "destination-in";
  oc.fillStyle = grad;
  oc.fillRect(0, 0, w, h);
  oc.globalCompositeOperation = "source-over";
}

type TornEdge = Extract<ResolvedEffect, { kind: "tornedge" }>;

/** The torn-edge effects in the stack, in order. */
export function tornEffects(effects: ResolvedEffect[]): TornEdge[] {
  return effects.filter((e): e is TornEdge => e.kind === "tornedge");
}

// Deterministic seeded PRNG — same mulberry32 algorithm as src/lib/synthetic.ts
// (small, dependency-free, reproducible), duplicated locally rather than
// imported so this low-level renderer (shared by live preview + export)
// doesn't pull in synthetic.ts's Tauri/API dependencies. Same seed -> byte-
// identical torn silhouette every render.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The jagged boundary of a torn edge, as `toothCount + 1` points running from
 * one corner of the w×h rect to the adjacent corner along `side` (0=right,
 * 1=left, 2=top, 3=bottom). The two endpoints are flush with the rect's real
 * corners (depth 0); every interior point gets a deterministic random inward
 * depth (0..depth*relevantDimension) plus a little along-edge jitter, so the
 * line reads as ragged rather than a smooth wave. Deterministic from `seed`.
 */
function tornEdgePoints(w: number, h: number, t: TornEdge): { x: number; y: number }[] {
  const side = t.side;
  const vertical = side === 0 || side === 1; // right/left edges run top-to-bottom
  const count = Math.max(2, Math.round(t.toothCount));
  const rng = mulberry32(t.seed >>> 0);
  const edgeLen = vertical ? h : w;
  const maxDepth = clamp01(t.depth) * (vertical ? w : h);
  const step = edgeLen / count;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= count; i++) {
    const pinned = i === 0 || i === count;
    const depth = pinned ? 0 : rng() * maxDepth;
    const jitter = pinned ? 0 : (rng() - 0.5) * step * 0.6;
    const along = Math.min(edgeLen, Math.max(0, i * step + jitter));
    switch (side) {
      case 0: // right: corner (w,0) -> (w,h), notches cut inward (-x)
        pts.push({ x: w - depth, y: along });
        break;
      case 1: // left: corner (0,h) -> (0,0), notches cut inward (+x)
        pts.push({ x: depth, y: h - along });
        break;
      case 2: // top: corner (0,0) -> (w,0), notches cut inward (+y)
        pts.push({ x: along, y: depth });
        break;
      default: // bottom: corner (w,h) -> (0,h), notches cut inward (-y)
        pts.push({ x: w - along, y: h - depth });
        break;
    }
  }
  return pts;
}

/**
 * Clip an already-drawn layer to a static hand-torn paper edge on canvas `oc`
 * (w×h), optionally painting a visible paper-coloured strip along the tear.
 * Same masking idiom as `applyWipe` — a jagged fill shape instead of a
 * gradient rect.
 */
export function applyTornEdge(oc: CanvasRenderingContext2D, w: number, h: number, t: TornEdge) {
  if (w <= 0 || h <= 0) return;
  const torn = tornEdgePoints(w, h, t);

  oc.save();
  oc.beginPath();
  switch (t.side) {
    case 0: // right torn: TL -> [jagged TR..BR] -> BL -> close
      oc.moveTo(0, 0);
      for (const p of torn) oc.lineTo(p.x, p.y);
      oc.lineTo(0, h);
      break;
    case 1: // left torn: TR -> BR -> [jagged BL..TL] -> close
      oc.moveTo(w, 0);
      oc.lineTo(w, h);
      for (const p of torn) oc.lineTo(p.x, p.y);
      break;
    case 2: // top torn: [jagged TL..TR] -> BR -> BL -> close
      oc.moveTo(torn[0].x, torn[0].y);
      for (const p of torn) oc.lineTo(p.x, p.y);
      oc.lineTo(w, h);
      oc.lineTo(0, h);
      break;
    default: // bottom torn: TL -> TR -> [jagged BR..BL] -> close
      oc.moveTo(0, 0);
      oc.lineTo(w, 0);
      for (const p of torn) oc.lineTo(p.x, p.y);
      break;
  }
  oc.closePath();
  oc.globalCompositeOperation = "destination-in";
  oc.fillStyle = "#000";
  oc.fill();
  oc.restore();

  if (t.paperWidth > 0) {
    oc.globalCompositeOperation = "source-over";
    const c = t.paperColor;
    oc.strokeStyle = `rgba(${c.r},${c.g},${c.b},${c.a / 255})`;
    oc.lineWidth = t.paperWidth;
    oc.lineJoin = "round";
    oc.beginPath();
    oc.moveTo(torn[0].x, torn[0].y);
    for (let i = 1; i < torn.length; i++) oc.lineTo(torn[i].x, torn[i].y);
    oc.stroke();
    oc.globalCompositeOperation = "source-over";
  }
}
