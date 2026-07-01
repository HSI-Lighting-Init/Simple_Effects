// Registry of all Stage-1 transitions: metadata + a factory. Drives the demo UI
// and the generated documentation, and is the single place to look up a
// transition by id.

import type { Clip } from "./types";
import { DIRECTIONS, FIT_MODES } from "./types";
import type { TransitionEffect } from "./base";
import { TransitionError } from "./base";
import { Fade, CrossDissolve, DipToBlack, DipToWhite, FadeToColor, FlashToWhite, FlashToColor } from "./blend";
import { Slide, Push, Cover, Uncover } from "./motion";

export interface ParamSpec {
  name: string;
  label: string;
  type: "enum" | "number" | "color" | "bool";
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
  description: string;
}

export interface TransitionMeta {
  id: string;
  label: string;
  category: "Opacity & Blend" | "Slide, Push & Cover";
  description: string;
  create: (from: Clip, to: Clip, params: Record<string, unknown>) => TransitionEffect;
  params: ParamSpec[];
}

const EASING: ParamSpec = {
  name: "easing",
  label: "Easing",
  type: "enum",
  options: ["linear", "easeIn", "easeOut", "easeInOut"],
  default: "linear",
  description: "Timing curve applied to progress before rendering.",
};
const FIT: ParamSpec = {
  name: "fit",
  label: "Fit",
  type: "enum",
  options: FIT_MODES,
  default: "cover",
  description: "How each clip is fitted into the output frame (contain letterboxes, cover fills+crops, stretch distorts).",
};
const GPU: ParamSpec = {
  name: "preferGpu",
  label: "Prefer GPU",
  type: "bool",
  default: false,
  description: "Try the WebGL blend path; automatically falls back to CPU if unavailable.",
};
const COLOR = (def: unknown): ParamSpec => ({
  name: "color",
  label: "Colour",
  type: "color",
  default: def,
  description: "The colour dipped/flashed through (0–255 RGBA).",
});
const INTENSITY: ParamSpec = {
  name: "intensity",
  label: "Intensity",
  type: "number",
  min: 0,
  max: 1,
  step: 0.05,
  default: 1,
  description: "Peak flash strength, 0 (none) to 1 (full colour).",
};
const DIRECTION: ParamSpec = {
  name: "direction",
  label: "Direction",
  type: "enum",
  options: DIRECTIONS,
  default: "left",
  description: "For Slide/Cover/Push, the edge the incoming clip enters from; for Uncover, the way the outgoing clip slides off.",
};

export const REGISTRY: TransitionMeta[] = [
  {
    id: "fade",
    label: "Fade",
    category: "Opacity & Blend",
    description: "Straight opacity crossfade: A fades out as B fades in (both ~50% at the midpoint).",
    create: (f, t, p) => new Fade(f, t, p),
    params: [EASING, FIT, GPU],
  },
  {
    id: "crossDissolve",
    label: "Cross Dissolve",
    category: "Opacity & Blend",
    description: "A stays fully opaque while B dissolves in on top; both are visible through the middle.",
    create: (f, t, p) => new CrossDissolve(f, t, p),
    params: [EASING, FIT, GPU],
  },
  {
    id: "dipToBlack",
    label: "Dip to Black",
    category: "Opacity & Blend",
    description: "A fades to solid black over the first half, then black fades to B.",
    create: (f, t, p) => new DipToBlack(f, t, p),
    params: [EASING, FIT],
  },
  {
    id: "dipToWhite",
    label: "Dip to White",
    category: "Opacity & Blend",
    description: "A fades to solid white over the first half, then white fades to B.",
    create: (f, t, p) => new DipToWhite(f, t, p),
    params: [EASING, FIT],
  },
  {
    id: "fadeToColor",
    label: "Fade to Color",
    category: "Opacity & Blend",
    description: "Dip transition through any customisable solid colour.",
    create: (f, t, p) => new FadeToColor(f, t, p),
    params: [COLOR({ r: 0, g: 0, b: 0 }), EASING, FIT],
  },
  {
    id: "flashToWhite",
    label: "Flash to White",
    category: "Opacity & Blend",
    description: "A quick bright white flash peaks at the midpoint and masks the cut from A to B.",
    create: (f, t, p) => new FlashToWhite(f, t, p),
    params: [INTENSITY, EASING, FIT],
  },
  {
    id: "flashToColor",
    label: "Flash to Color",
    category: "Opacity & Blend",
    description: "Flash transition through any customisable colour, with adjustable intensity.",
    create: (f, t, p) => new FlashToColor(f, t, p),
    params: [COLOR({ r: 255, g: 255, b: 255 }), INTENSITY, EASING, FIT],
  },
  {
    id: "slide",
    label: "Slide",
    category: "Slide, Push & Cover",
    description: "The incoming clip slides in over a stationary outgoing clip.",
    create: (f, t, p) => new Slide(f, t, p),
    params: [DIRECTION, EASING, FIT],
  },
  {
    id: "push",
    label: "Push",
    category: "Slide, Push & Cover",
    description: "The incoming clip pushes the outgoing clip out of frame (both move together).",
    create: (f, t, p) => new Push(f, t, p),
    params: [DIRECTION, EASING, FIT],
  },
  {
    id: "cover",
    label: "Cover",
    category: "Slide, Push & Cover",
    description: "The incoming clip slides in over the stationary outgoing clip, with a soft leading-edge shadow.",
    create: (f, t, p) => new Cover(f, t, p),
    params: [DIRECTION, EASING, FIT],
  },
  {
    id: "uncover",
    label: "Uncover",
    category: "Slide, Push & Cover",
    description: "The outgoing clip slides away on top to reveal the stationary incoming clip underneath.",
    create: (f, t, p) => new Uncover(f, t, p),
    params: [DIRECTION, EASING, FIT],
  },
];

const BY_ID = new Map(REGISTRY.map((m) => [m.id, m]));

/** Look up a transition's metadata by id. */
export function getTransitionMeta(id: string): TransitionMeta | undefined {
  return BY_ID.get(id);
}

/** Create a transition instance by id. Throws if the id is unknown. */
export function createTransition(
  id: string,
  from: Clip,
  to: Clip,
  params: Record<string, unknown> = {}
): TransitionEffect {
  const meta = BY_ID.get(id);
  if (!meta) throw new TransitionError(`unknown transition "${id}"`);
  return meta.create(from, to, params);
}
