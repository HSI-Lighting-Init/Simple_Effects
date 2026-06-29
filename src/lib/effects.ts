// Turns the evaluator's resolved effect stack into things a 2D canvas can do:
// a CSS-style `filter` string for the colour/blur effects, and a gradient-mask
// step for each `wipe` (the directional fade / reveal). Applied to an offscreen
// canvas so a wipe masks only this layer, not the whole scene.
import type { ResolvedEffect } from "../bindings/ResolvedEffect";
import type { Texture } from "./surface3d";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

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
