// Transition-effects engine (Stage 1) — public API.
//
// Quick start:
//   import { createTransition } from "./lib/transitions";
//   const tr = createTransition("fade", fromClip, toClip, { easing: "easeInOut" });
//   tr.render(targetCanvas, 0.5); // paint the midpoint frame
//
// A `Clip` is `{ source, width, height }` where `source` is any CanvasImageSource
// (image, video, canvas) or null for an empty/transparent input.

export type { Clip, RGBA, Direction, FitMode, EasingName, EasingSpec, BaseParams } from "./types";
export { DIRECTIONS, FIT_MODES } from "./types";
export { EASINGS, ease, resolveEasing, clamp01 } from "./easing";
export { makeSpring, cubicBezier, type SpringParams } from "./spring";
export { TransitionEffect, TransitionError } from "./base";
export * from "./blend";
export * from "./motion";
export * from "./wipe";
export * from "./zoom";
export * from "./rotate";
export {
  REGISTRY,
  getTransitionMeta,
  createTransition,
  type TransitionMeta,
  type ParamSpec,
} from "./registry";
export { isGpuSupported } from "./gl";
