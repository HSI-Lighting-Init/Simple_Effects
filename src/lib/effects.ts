// Turns the evaluator's resolved effect stack into things a 2D canvas can do:
// a CSS-style `filter` string for the colour/blur effects, and a gradient-mask
// step for each `wipe` (the directional fade / reveal). Applied to an offscreen
// canvas so a wipe masks only this layer, not the whole scene.
import type { ResolvedEffect } from "../bindings/ResolvedEffect";
import type { Project } from "../bindings/Project";
import type { Layer } from "../bindings/Layer";
import type { Texture } from "./surface3d";
import { gpuFxPass, getGpuStats, runPasses, type GpuPass } from "./gpuFx";
import { shinePass } from "./shinyClouds";
import { ultraKeyPasses } from "./ultraKey";

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

type GpuFx = Extract<ResolvedEffect, { kind: "gpuoverlay" }>;
export function gpuFxEffects(effects: ResolvedEffect[]): GpuFx[] {
  return effects.filter((e): e is GpuFx => e.kind === "gpuoverlay");
}

type UltraKey = Extract<ResolvedEffect, { kind: "ultrakey" }>;
type GpuEffect = Shine | GpuFx | UltraKey;

/**
 * The GPU passes a single effect needs, ready for the shared chain. `offset` is
 * the index of this effect's first pass in the whole run (multi-pass effects
 * use it for their internal source references); `radiusScale` is the effect
 * texture's width ÷ its source's native width (Ultra Key's cleanup radii).
 */
function gpuPassesFor(e: GpuEffect, offset: number, radiusScale: number): GpuPass[] {
  if (e.kind === "ultrakey") return ultraKeyPasses(e, offset, radiusScale);
  if (e.kind === "shinyclouds") {
    return [
      shinePass({
        time: e.time,
        intensity: e.intensity,
        scale: e.scale,
        speed: e.speed,
        complexity: e.complexity,
        contrast: e.contrast,
        brightness: e.brightness,
        tint: [e.tint.r / 255, e.tint.g / 255, e.tint.b / 255],
        blend: e.blend,
        opacity: e.opacity,
      }),
    ];
  }
  return [
    gpuFxPass({
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
    }),
  ];
}

/** The effect kinds that render on the shared GPU chain. */
export type GpuEffectKind = GpuEffect["kind"];

/** True for every effect kind whose render runs on the GPU. */
export function isGpuEffect(kind: string): kind is GpuEffectKind {
  return kind === "shinyclouds" || kind === "gpuoverlay" || kind === "ultrakey";
}

/** True for the kinds that become a CSS/canvas `filter` step. */
function isCssFilter(e: ResolvedEffect): boolean {
  return (
    e.kind === "grayscale" ||
    e.kind === "brightness" ||
    e.kind === "contrast" ||
    e.kind === "saturate" ||
    e.kind === "blur" ||
    e.kind === "hue" ||
    e.kind === "invert"
  );
}

/** True for the kinds that are an alpha mask (a `destination-in` fill). */
function isMaskEffect(e: ResolvedEffect): e is Wipe | TornEdge | Crop {
  return e.kind === "wipe" || e.kind === "tornedge" || e.kind === "crop";
}

/**
 * Split the stack into runs of consecutive GPU effects. Each run becomes one
 * pass chain: one upload and one readback, however many effects it holds.
 */
export function gpuRuns(effects: ResolvedEffect[]): GpuEffect[][] {
  const runs: GpuEffect[][] = [];
  let run: GpuEffect[] | null = null;
  for (const e of effects) {
    if (isGpuEffect(e.kind)) {
      if (!run) {
        run = [];
        runs.push(run);
      }
      run.push(e as GpuEffect);
    } else {
      run = null;
    }
  }
  return runs;
}

/**
 * Does anything in the project run on the GPU? Only then is a failed GPU health
 * check a reason to refuse the export (a project with no GPU effects must still
 * export on a machine without WebGL2).
 */
export function projectUsesGpu(p: Project): boolean {
  const layerUses = (l: Layer): boolean => {
    if (l.effects.some((e) => isGpuEffect(e.kind))) return true;
    const k = l.kind;
    if (k.kind === "group") return k.children.some(layerUses);
    if (k.kind === "framegrid")
      return (
        k.cells.some((c) => c.effects.some((e) => isGpuEffect(e.kind))) ||
        k.linked.some((g) => g.effects.some((e) => isGpuEffect(e.kind)))
      );
    return false;
  };
  return p.layers.some(layerUses);
}

/**
 * Run one chain. On success the result is drawn back into `off`; on failure the
 * typed error is recorded (the export guard reads it) and reported to the
 * caller's badge hook, while `off` keeps the unprocessed pixels — never a dead
 * GL canvas.
 */
function applyGpuRun(
  off: HTMLCanvasElement,
  w: number,
  h: number,
  run: GpuEffect[],
  onGpuFailure?: (message: string) => void,
  radiusScale = 1
) {
  const oc = off.getContext("2d");
  if (!oc) return;
  const passes: GpuPass[] = [];
  for (const e of run) passes.push(...gpuPassesFor(e, passes.length, radiusScale));
  const res = runPasses(off, w, h, passes);
  if (!res.ok) {
    onGpuFailure?.(res.error);
    return;
  }
  oc.clearRect(0, 0, w, h);
  oc.drawImage(res.canvas, 0, 0, w, h);
}

/** A scratch canvas for a CSS filter run that follows a non-filter step (WP3).
 *  Lazily created; sized to the layer being rendered. */
let stackScratch: HTMLCanvasElement | null = null;
function scratchFor(w: number, h: number): HTMLCanvasElement {
  const c = stackScratch ?? (stackScratch = document.createElement("canvas"));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c;
}

/**
 * Render a source texture (image or canvas) through its effect stack into the
 * scratch canvas `off` and return it. With no effects, returns `src` unchanged
 * (no allocation). Used by both the flat-image renderer and the decal renderer,
 * so effects apply whether or not the layer is pinned to a 3D shape.
 *
 * WP3: the stack runs top to bottom, like Premiere. Each run of consecutive CSS
 * filters is one `drawImage` through a merged filter string; each mask (wipe,
 * torn edge, crop) is one `destination-in` fill where it sits in the stack;
 * each run of consecutive GPU effects is one WP1 chain. Adjustment layers keep
 * their own path (AdjustmentNode).
 */
export function applyEffects(
  off: HTMLCanvasElement,
  src: Texture,
  srcW: number,
  srcH: number,
  effects: ResolvedEffect[],
  onGpuFailure?: (message: string) => void,
  radiusScale = 1
): Texture {
  if (effects.length === 0 || srcW <= 0 || srcH <= 0) return src;
  if (off.width !== srcW || off.height !== srcH) {
    off.width = srcW;
    off.height = srcH;
  }
  const oc = off.getContext("2d");
  if (!oc) return src;
  const t0 = performance.now();
  const kinds = effects.map((e) => e.kind);
  const usesGpu = effects.some((e) => isGpuEffect(e.kind));
  const gpuStart = usesGpu ? t0 : 0;
  const gpuBefore = usesGpu ? getGpuStats() : null;

  // `drawn` is true once `off` holds the stack result so far; until then the
  // source texture is still the current image and no copy has been made.
  let drawn = false;
  const begin = () => {
    if (drawn) return;
    oc.clearRect(0, 0, srcW, srcH);
    oc.filter = "none";
    oc.drawImage(src, 0, 0, srcW, srcH);
    drawn = true;
  };

  let i = 0;
  while (i < effects.length) {
    const e = effects[i];

    if (isGpuEffect(e.kind)) {
      begin();
      const run: GpuEffect[] = [];
      while (i < effects.length && isGpuEffect(effects[i].kind)) {
        run.push(effects[i] as GpuEffect);
        i++;
      }
      applyGpuRun(off, srcW, srcH, run, onGpuFailure, radiusScale);
      continue;
    }

    if (isMaskEffect(e)) {
      begin();
      if (e.kind === "wipe") applyWipe(oc, srcW, srcH, e);
      else if (e.kind === "tornedge") applyTornEdge(oc, srcW, srcH, e);
      else applyCrop(oc, srcW, srcH, e, radiusScale);
      i++;
      continue;
    }

    // A run of consecutive CSS filters (the only kinds left at this point).
    const parts: string[] = [];
    while (i < effects.length && isCssFilter(effects[i])) parts.push(filterPart(effects[i++]));
    if (parts.length === 0) {
      // Defensive: an unknown kind must not stall the walk.
      i++;
      continue;
    }
    const filter = parts.join(" ");
    if (!drawn) {
      oc.clearRect(0, 0, srcW, srcH);
      oc.filter = filter;
      oc.drawImage(src, 0, 0, srcW, srcH);
      oc.filter = "none";
      drawn = true;
    } else {
      // Re-filter the current result. A scratch copy is needed because drawing a
      // canvas onto itself while filtered is not reliable.
      const scratch = scratchFor(srcW, srcH);
      const sc = scratch.getContext("2d");
      if (!sc) break;
      sc.clearRect(0, 0, srcW, srcH);
      sc.drawImage(off, 0, 0, srcW, srcH);
      oc.clearRect(0, 0, srcW, srcH);
      oc.filter = filter;
      oc.drawImage(scratch, 0, 0, srcW, srcH);
      oc.filter = "none";
    }
  }

  if (gpuBefore) {
    const after = getGpuStats();
    const timing: ApplyEffectsTiming = {
      ms: performance.now() - gpuStart,
      uploads: after.uploads - gpuBefore.uploads,
      readbacks: after.readbacks - gpuBefore.readbacks,
      passes: after.passes - gpuBefore.passes,
    };
    lastApplyEffectsTiming = timing;
  }
  noteEffectCall(kinds, performance.now() - t0);
  return off;
}

export interface ApplyEffectsTiming {
  ms: number;
  uploads: number;
  readbacks: number;
  passes: number;
}

let lastApplyEffectsTiming: ApplyEffectsTiming | null = null;

/** The GPU part of the most recent applyEffects call (timer + I/O counts). */
export function lastApplyEffectsStats(): ApplyEffectsTiming | null {
  return lastApplyEffectsTiming;
}

// ---- WP9: per-layer effect cost -------------------------------------------
// applyEffects runs once per layer per rendered frame. These totals are reset
// at play/export start and read back by the FPS and export timing logs, so the
// keyer's cost shows up next to them without a profiler.

export interface EffectCallTiming {
  /** performance.now() when the call finished. */
  at: number;
  /** Effect kinds in that layer's stack, in order. */
  kinds: string[];
  ms: number;
}

let recentEffectCalls: EffectCallTiming[] = [];
let effectTotals = { ms: 0, calls: 0, byStack: {} as Record<string, number> };

function noteEffectCall(kinds: string[], ms: number) {
  const at = performance.now();
  recentEffectCalls.push({ at, kinds, ms });
  // Two seconds at 60 fps with two effect layers is 240 calls; keep that much.
  if (recentEffectCalls.length > 240) recentEffectCalls.splice(0, recentEffectCalls.length - 240);
  effectTotals.ms += ms;
  effectTotals.calls += 1;
  const key = kinds.join("+");
  effectTotals.byStack[key] = (effectTotals.byStack[key] ?? 0) + ms;
}

/** Forget the accumulated per-layer effect cost (call at play/export start). */
export function resetEffectTiming() {
  recentEffectCalls = [];
  effectTotals = { ms: 0, calls: 0, byStack: {} };
}

/** Totals since the last reset, grouped by the layer's effect stack. */
export function effectTiming(): {
  totalMs: number;
  calls: number;
  byStack: Record<string, number>;
} {
  return {
    totalMs: effectTotals.ms,
    calls: effectTotals.calls,
    byStack: { ...effectTotals.byStack },
  };
}

/** Effect calls in the last `windowMs`, for the live preview FPS log. */
export function effectTimingWindow(windowMs = 1000): {
  calls: number;
  ms: number;
  byStack: Record<string, number>;
} {
  const now = performance.now();
  const calls = recentEffectCalls.filter((c) => now - c.at <= windowMs);
  const byStack: Record<string, number> = {};
  let ms = 0;
  for (const c of calls) {
    ms += c.ms;
    const key = c.kinds.join("+");
    byStack[key] = (byStack[key] ?? 0) + c.ms;
  }
  return {
    calls: calls.length,
    ms: +ms.toFixed(1),
    byStack: Object.fromEntries(Object.entries(byStack).map(([k, v]) => [k, +v.toFixed(1)])),
  };
}

/** One effect's CSS filter function, or "" for a non-filter effect. */
function filterPart(e: ResolvedEffect): string {
  switch (e.kind) {
    case "grayscale":
      return `grayscale(${clamp01(e.amount)})`;
    case "brightness":
      return `brightness(${Math.max(0, e.amount)})`;
    case "contrast":
      return `contrast(${Math.max(0, e.amount)})`;
    case "saturate":
      return `saturate(${Math.max(0, e.amount)})`;
    case "blur":
      return `blur(${Math.max(0, e.radius)}px)`;
    case "hue":
      return `hue-rotate(${e.degrees}deg)`;
    case "invert":
      return `invert(${clamp01(e.amount)})`;
    // wipe/crop/torn edges are masks and GPU effects use the pass chain —
    // both are handled separately.
    default:
      return "";
  }
}

/** Build the canvas `filter` string from the colour/blur effects, in order. */
export function buildFilter(effects: ResolvedEffect[]): string {
  const parts: string[] = [];
  for (const e of effects) {
    const part = filterPart(e);
    if (part) parts.push(part);
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

type Crop = Extract<ResolvedEffect, { kind: "crop" }>;

/**
 * Mask a drawn layer (on canvas `oc`, w×h) to a Crop rect: Left/Top/Right/Bottom
 * are percentages cut from the edges and `feather` softens each CROPPED edge, in
 * source pixels. `radiusScale` is the texture width ÷ source-native width (the
 * factor Ultra Key's cleanup radii use), so a preview-capped texture feathers
 * by the same amount of source pixels as the full-resolution export.
 *
 * One mask pass: two full-canvas `destination-in` gradients (one per axis,
 * multiplied), each opaque inside the crop rect and transparent outside it.
 */
export function applyCrop(
  oc: CanvasRenderingContext2D,
  w: number,
  h: number,
  crop: Crop,
  radiusScale = 1
) {
  if (w <= 0 || h <= 0) return;
  const frac = (v: number) => Math.min(100, Math.max(0, v)) / 100;
  const left = frac(crop.left);
  const top = frac(crop.top);
  const right = frac(crop.right);
  const bottom = frac(crop.bottom);
  if (left === 0 && top === 0 && right === 0 && bottom === 0) return;

  const x0 = left * w;
  const x1 = w - right * w;
  const y0 = top * h;
  const y1 = h - bottom * h;
  if (x1 <= x0 || y1 <= y0) {
    // Cropped entirely away.
    oc.clearRect(0, 0, w, h);
    return;
  }

  // Feather only applies to an edge that is actually cropped, and never more
  // than half of that axis (so the two ramps cannot cross).
  const feather = Math.max(0, crop.feather) * radiusScale;
  const fx = Math.min(feather, (x1 - x0) / 2);
  const fy = Math.min(feather, (y1 - y0) / 2);

  oc.save();
  oc.globalCompositeOperation = "destination-in";
  if (left > 0 || right > 0) {
    const stops: [number, number][] = [];
    if (left > 0) {
      stops.push([0, 0], [x0 / w, 0]);
      // A zero feather is a hard step at the crop edge; with a feather it ramps.
      stops.push([(fx > 0 ? x0 + fx : x0) / w, 1]);
    } else {
      stops.push([0, 1]);
    }
    if (right > 0) {
      stops.push([(fx > 0 ? x1 - fx : x1) / w, 1], [x1 / w, 0], [1, 0]);
    } else {
      stops.push([1, 1]);
    }
    const grad = oc.createLinearGradient(0, 0, w, 0);
    addMaskStops(grad, stops);
    oc.fillStyle = grad;
    oc.fillRect(0, 0, w, h);
  }
  if (top > 0 || bottom > 0) {
    const stops: [number, number][] = [];
    if (top > 0) {
      stops.push([0, 0], [y0 / h, 0]);
      stops.push([(fy > 0 ? y0 + fy : y0) / h, 1]);
    } else {
      stops.push([0, 1]);
    }
    if (bottom > 0) {
      stops.push([(fy > 0 ? y1 - fy : y1) / h, 1], [y1 / h, 0], [1, 0]);
    } else {
      stops.push([1, 1]);
    }
    const grad = oc.createLinearGradient(0, 0, 0, h);
    addMaskStops(grad, stops);
    oc.fillStyle = grad;
    oc.fillRect(0, 0, w, h);
  }
  oc.restore();
}

/** Add sorted, clamped black stops with the given alpha (the mask's coverage). */
function addMaskStops(grad: CanvasGradient, stops: [number, number][]) {
  let last = 0;
  for (const [at, alpha] of stops) {
    last = Math.max(last, Math.min(1, Math.max(0, at)));
    grad.addColorStop(last, `rgba(0,0,0,${alpha})`);
  }
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

// Dev-only bridge for the CDP checks (docs �5): a plain module import from the
// page can resolve to a different HMR-timestamped instance than the app's.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __sefxFx?: unknown }).__sefxFx = {
    applyEffects,
    gpuRuns,
    lastStats: lastApplyEffectsStats,
    stats: getGpuStats,
    effectTiming,
    effectTimingWindow,
    resetEffectTiming,
  };
}
