// Transition-effects engine (Stage 1) — public API.
//
// Quick start:
//   import { createTransition } from "./lib/transitions";
//   const tr = createTransition("fade", fromClip, toClip, { easing: "easeInOut" });
//   tr.render(targetCanvas, 0.5); // paint the midpoint frame
//
// A `Clip` is `{ source, width, height }` where `source` is any CanvasImageSource
// (image, video, canvas) or null for an empty/transparent input.

export type { Clip, RGBA, Direction, FitMode, EasingName, BaseParams } from "./types";
export { DIRECTIONS, FIT_MODES } from "./types";
export { EASINGS, ease, clamp01 } from "./easing";
export { TransitionEffect, TransitionError } from "./base";
export * from "./blend";
export * from "./motion";
export {
  REGISTRY,
  getTransitionMeta,
  createTransition,
  type TransitionMeta,
  type ParamSpec,
} from "./registry";
export { isGpuSupported } from "./gl";
