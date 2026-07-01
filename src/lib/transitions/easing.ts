// Easing functions for transitions. Kept independent of the Rust evaluator's
// easing so the engine is self-contained; the curves match the common set.

import type { EasingName, EasingSpec } from "./types";
import { makeSpring, cubicBezier } from "./spring";

export type EasingFn = (t: number) => number;

export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

export const EASINGS: Record<EasingName, EasingFn> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  // smoothstep-style symmetric ease
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  // named spring presets (may overshoot 1 → bounce)
  spring: makeSpring({ tension: 170, friction: 22 }),
  bounce: makeSpring({ tension: 220, friction: 12 }),
};

export function ease(name: EasingName, t: number): number {
  const fn = EASINGS[name] ?? EASINGS.linear;
  return fn(clamp01(t));
}

/** Resolve any easing spec (named / bezier / spring) into a curve function. */
export function resolveEasing(spec: EasingSpec | undefined): EasingFn {
  if (spec == null) return EASINGS.linear;
  if (typeof spec === "string") {
    const fn = EASINGS[spec];
    if (!fn) throw new Error(`unknown easing "${spec}"`);
    return fn;
  }
  if (spec.type === "bezier") return cubicBezier(spec.x1, spec.y1, spec.x2, spec.y2);
  if (spec.type === "spring") return makeSpring(spec);
  throw new Error("invalid easing spec");
}
