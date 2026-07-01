// Registry of all Stage-1 transitions: metadata + a factory. Drives the demo UI
// and the generated documentation, and is the single place to look up a
// transition by id.

import type { Clip } from "./types";
import { DIRECTIONS, FIT_MODES } from "./types";
import type { TransitionEffect } from "./base";
import { TransitionError } from "./base";
import { Fade, CrossDissolve, DipToBlack, DipToWhite, FadeToColor, FlashToWhite, FlashToColor } from "./blend";
import { Slide, Push, Cover, Uncover } from "./motion";
import {
  LinearWipe,
  DiagonalWipe,
  IrisWipe,
  DiamondWipe,
  BoxWipe,
  ClockWipe,
  RadialWipe,
  BarnDoors,
  GradientWipe,
} from "./wipe";
import { ZoomIn, ZoomOut, Pan, ZoomAndPan, ZoomMotionBlur, ScaleUp, ScaleDown, ScaleBounce } from "./zoom";
import { Spin2D, Swivel, FlipVertical, RotateAndScale } from "./rotate";
import { PatternTransition, Mosaic, Vortex, type PatternKind } from "./tiles";
import { CubeRotation, CardFlip3D, Tumble, Doors3D, Curtains3D, FlyThroughFlip } from "./rotate3d";
import { Fold, AccordionFold, Unfold, PageTurn, PageRoll, PageCurl, PeelOff, StickyPeel } from "./fold";

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
  category: string;
  description: string;
  create: (from: Clip, to: Clip, params: Record<string, unknown>) => TransitionEffect;
  params: ParamSpec[];
}

const EASING: ParamSpec = {
  name: "easing",
  label: "Easing",
  type: "enum",
  options: ["linear", "easeIn", "easeOut", "easeInOut", "spring", "bounce"],
  default: "linear",
  description: "Timing curve applied to progress (spring/bounce overshoot). Bezier/spring specs can also be passed in code.",
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

// --- Stage 2 parameter specs ---
const dirSpec = (options: string[], def: string, description: string): ParamSpec => ({
  name: "direction",
  label: "Direction",
  type: "enum",
  options,
  default: def,
  description,
});
const SOFTNESS: ParamSpec = {
  name: "softness",
  label: "Softness",
  type: "number",
  min: 0,
  max: 1,
  step: 0.02,
  default: 0,
  description: "Edge feather width (0 = hard edge, 1 = very soft).",
};
const CORNER: ParamSpec = {
  name: "corner",
  label: "Corner",
  type: "enum",
  options: ["tl", "tr", "bl", "br"],
  default: "tl",
  description: "Start corner (top-left, top-right, bottom-left, bottom-right).",
};
const SHAPE_MODE: ParamSpec = {
  name: "mode",
  label: "Mode",
  type: "enum",
  options: ["expand", "contract"],
  default: "expand",
  description: "Grow the shape from the centre or shrink it to the centre.",
};
const SWEEP: ParamSpec = {
  name: "sweep",
  label: "Sweep",
  type: "enum",
  options: ["cw", "ccw"],
  default: "cw",
  description: "Clock hand direction (clockwise / counter-clockwise).",
};
const ORIENTATION: ParamSpec = {
  name: "orientation",
  label: "Orientation",
  type: "enum",
  options: ["horizontal", "vertical"],
  default: "horizontal",
  description: "Barn-door axis.",
};
const BARN_MODE: ParamSpec = {
  name: "mode",
  label: "Mode",
  type: "enum",
  options: ["close", "open"],
  default: "close",
  description: "Doors close inward or open outward from the centre.",
};
const ANCHOR_X: ParamSpec = {
  name: "anchorX",
  label: "Anchor X",
  type: "number",
  min: 0,
  max: 1,
  step: 0.05,
  default: 0.5,
  description: "Zoom/scale anchor, X (0 = left, 1 = right).",
};
const ANCHOR_Y: ParamSpec = {
  name: "anchorY",
  label: "Anchor Y",
  type: "number",
  min: 0,
  max: 1,
  step: 0.05,
  default: 0.5,
  description: "Zoom/scale anchor, Y (0 = top, 1 = bottom).",
};
const ZOOM: ParamSpec = {
  name: "zoom",
  label: "Zoom amount",
  type: "number",
  min: 0,
  max: 3,
  step: 0.1,
  default: 1,
  description: "Extra scale applied during the zoom.",
};
const MOTION_BLUR: ParamSpec = {
  name: "motionBlur",
  label: "Motion blur",
  type: "number",
  min: 0,
  max: 1,
  step: 0.05,
  default: 0,
  description: "Directional/zoom blur streak strength (0 = off).",
};
const TENSION: ParamSpec = {
  name: "tension",
  label: "Spring tension",
  type: "number",
  min: 20,
  max: 400,
  step: 5,
  default: 180,
  description: "Spring stiffness (higher = snappier).",
};
const FRICTION: ParamSpec = {
  name: "friction",
  label: "Bounce damping",
  type: "number",
  min: 2,
  max: 60,
  step: 1,
  default: 12,
  description: "Spring friction (higher = less bounce).",
};
const SPINS: ParamSpec = {
  name: "spins",
  label: "Turns",
  type: "number",
  min: 0.25,
  max: 4,
  step: 0.25,
  default: 1,
  description: "Number of full rotations.",
};
const PERSPECTIVE: ParamSpec = {
  name: "perspective",
  label: "Perspective",
  type: "number",
  min: 0,
  max: 1,
  step: 0.05,
  default: 0.5,
  description: "3D foreshortening for flips (0 = flat, 1 = strong).",
};
const BACKFACE: ParamSpec = {
  name: "backface",
  label: "Backface = next clip",
  type: "bool",
  default: true,
  description: "Show the next clip on the reverse of a flip (off = a dimmed backface).",
};

// --- Stage 3 parameter specs ---
const GRID: ParamSpec = { name: "grid", label: "Grid size", type: "number", min: 2, max: 40, step: 1, default: 8, description: "Number of tiles per axis." };
const SPREAD: ParamSpec = { name: "spread", label: "Stagger", type: "number", min: 0, max: 1, step: 0.05, default: 0.6, description: "Per-tile delay spread (0 = together, 1 = sequential)." };
const COUNT: ParamSpec = { name: "count", label: "Count", type: "number", min: 2, max: 40, step: 1, default: 12, description: "Number of strips/bars." };
const SEED: ParamSpec = { name: "seed", label: "Seed", type: "number", min: 1, max: 99, step: 1, default: 1, description: "Random seed for randomised orders." };
const SEGMENTS: ParamSpec = { name: "segments", label: "Segments", type: "number", min: 2, max: 24, step: 1, default: 8, description: "Number of panels/strips." };
const RADIUS: ParamSpec = { name: "radius", label: "Curl radius", type: "number", min: 0.02, max: 0.4, step: 0.01, default: 0.12, description: "Page-curl cylinder radius (fraction of width)." };
const THICKNESS: ParamSpec = { name: "thickness", label: "Thickness", type: "number", min: 0, max: 0.1, step: 0.005, default: 0.03, description: "Card/page thickness (fraction of width)." };
const TWIST: ParamSpec = { name: "twist", label: "Twist", type: "number", min: 0, max: 12, step: 0.5, default: 6, description: "Vortex swirl amount." };

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

  // --- Category 3: Wipe, Reveal & Edge ---
  {
    id: "horizontalWipe",
    label: "Horizontal Wipe",
    category: "Wipe, Reveal & Edge",
    description: "A straight vertical edge sweeps left or right.",
    create: (f, t, p) => new LinearWipe("horizontalWipe", f, t, p, "right"),
    params: [dirSpec(["left", "right"], "right", "Direction the edge travels."), SOFTNESS, EASING, FIT],
  },
  {
    id: "verticalWipe",
    label: "Vertical Wipe",
    category: "Wipe, Reveal & Edge",
    description: "A straight horizontal edge sweeps up or down.",
    create: (f, t, p) => new LinearWipe("verticalWipe", f, t, p, "down"),
    params: [dirSpec(["up", "down"], "down", "Direction the edge travels."), SOFTNESS, EASING, FIT],
  },
  {
    id: "diagonalWipe",
    label: "Diagonal Wipe",
    category: "Wipe, Reveal & Edge",
    description: "A straight edge sweeps from one corner to the opposite corner.",
    create: (f, t, p) => new DiagonalWipe("diagonalWipe", f, t, p),
    params: [CORNER, SOFTNESS, EASING, FIT],
  },
  {
    id: "irisWipe",
    label: "Iris Wipe",
    category: "Wipe, Reveal & Edge",
    description: "A circle expanding from / contracting to the centre.",
    create: (f, t, p) => new IrisWipe("irisWipe", f, t, p),
    params: [SHAPE_MODE, SOFTNESS, EASING, FIT],
  },
  {
    id: "diamondWipe",
    label: "Diamond Wipe",
    category: "Wipe, Reveal & Edge",
    description: "A diamond shape opening or closing from the centre.",
    create: (f, t, p) => new DiamondWipe("diamondWipe", f, t, p),
    params: [SHAPE_MODE, SOFTNESS, EASING, FIT],
  },
  {
    id: "boxWipe",
    label: "Box Wipe",
    category: "Wipe, Reveal & Edge",
    description: "A rectangular shape expanding or contracting from the centre.",
    create: (f, t, p) => new BoxWipe("boxWipe", f, t, p),
    params: [SHAPE_MODE, SOFTNESS, EASING, FIT],
  },
  {
    id: "clockWipe",
    label: "Clock Wipe",
    category: "Wipe, Reveal & Edge",
    description: "A radial sweep like a clock hand, from 12 o'clock.",
    create: (f, t, p) => new ClockWipe("clockWipe", f, t, p),
    params: [SWEEP, SOFTNESS, EASING, FIT],
  },
  {
    id: "radialWipe",
    label: "Radial Wipe",
    category: "Wipe, Reveal & Edge",
    description: "A circular radius wipe growing from a chosen corner.",
    create: (f, t, p) => new RadialWipe("radialWipe", f, t, p),
    params: [CORNER, SOFTNESS, EASING, FIT],
  },
  {
    id: "gradientWipe",
    label: "Gradient Wipe",
    category: "Wipe, Reveal & Edge",
    description: "Soft-edge wipe driven by a luminance map (default diagonal). Pass a `gradientMap` image in code for custom patterns.",
    create: (f, t, p) => new GradientWipe("gradientWipe", f, t, p),
    params: [SOFTNESS, EASING, FIT],
  },
  {
    id: "edgeFeatherWipe",
    label: "Edge Feather Wipe",
    category: "Wipe, Reveal & Edge",
    description: "A linear wipe with an adjustable soft feather edge.",
    create: (f, t, p) => new LinearWipe("edgeFeatherWipe", f, t, p, "right", 0.2),
    params: [DIRECTION, SOFTNESS, EASING, FIT],
  },
  {
    id: "barnDoors",
    label: "Barn Doors",
    category: "Wipe, Reveal & Edge",
    description: "Two edges close inward (or open outward) like barn doors — horizontal or vertical.",
    create: (f, t, p) => new BarnDoors("barnDoors", f, t, p),
    params: [ORIENTATION, BARN_MODE, SOFTNESS, EASING, FIT],
  },
  {
    id: "softWipe",
    label: "Soft Wipe",
    category: "Wipe, Reveal & Edge",
    description: "A linear wipe with a large blur feather.",
    create: (f, t, p) => new LinearWipe("softWipe", f, t, p, "right", 0.6),
    params: [DIRECTION, SOFTNESS, EASING, FIT],
  },

  // --- Category 4: Zoom, Scale & Pan ---
  {
    id: "zoomIn",
    label: "Zoom In",
    category: "Zoom, Scale & Pan",
    description: "Camera pushes into A, then B settles in from an over-zoom.",
    create: (f, t, p) => new ZoomIn(f, t, p),
    params: [ZOOM, ANCHOR_X, ANCHOR_Y, MOTION_BLUR, EASING, FIT],
  },
  {
    id: "zoomOut",
    label: "Zoom Out",
    category: "Zoom, Scale & Pan",
    description: "A shrinks away to reveal B growing behind it.",
    create: (f, t, p) => new ZoomOut(f, t, p),
    params: [ZOOM, ANCHOR_X, ANCHOR_Y, MOTION_BLUR, EASING, FIT],
  },
  {
    id: "pan",
    label: "Pan",
    category: "Zoom, Scale & Pan",
    description: "The camera pans directionally from A to the adjacent clip B.",
    create: (f, t, p) => new Pan(f, t, p),
    params: [DIRECTION, EASING, FIT],
  },
  {
    id: "zoomAndPan",
    label: "Zoom & Pan",
    category: "Zoom, Scale & Pan",
    description: "A directional pan combined with a push-in zoom.",
    create: (f, t, p) => new ZoomAndPan(f, t, p),
    params: [DIRECTION, ZOOM, ANCHOR_X, ANCHOR_Y, EASING, FIT],
  },
  {
    id: "zoomMotionBlur",
    label: "Zoom with Motion Blur",
    category: "Zoom, Scale & Pan",
    description: "A fast zoom whose directional blur streaks mask the cut.",
    create: (f, t, p) => new ZoomMotionBlur(f, t, p),
    params: [ZOOM, MOTION_BLUR, ANCHOR_X, ANCHOR_Y, EASING, FIT],
  },
  {
    id: "scaleUp",
    label: "Scale Up",
    category: "Zoom, Scale & Pan",
    description: "B scales up from nothing over a stationary A.",
    create: (f, t, p) => new ScaleUp(f, t, p),
    params: [ANCHOR_X, ANCHOR_Y, EASING, FIT],
  },
  {
    id: "scaleDown",
    label: "Scale Down",
    category: "Zoom, Scale & Pan",
    description: "A scales down to nothing, revealing a stationary B.",
    create: (f, t, p) => new ScaleDown(f, t, p),
    params: [ANCHOR_X, ANCHOR_Y, EASING, FIT],
  },
  {
    id: "scaleBounce",
    label: "Scale Bounce",
    category: "Zoom, Scale & Pan",
    description: "B scales in with spring overshoot (configurable bounce).",
    create: (f, t, p) => new ScaleBounce(f, t, p),
    params: [TENSION, FRICTION, ANCHOR_X, ANCHOR_Y, FIT],
  },

  // --- Category 5: Rotation & Flip ---
  {
    id: "spin2d",
    label: "Spin (2D)",
    category: "Rotation & Flip",
    description: "The clip rotates in the 2D plane while it crossfades.",
    create: (f, t, p) => new Spin2D(f, t, p),
    params: [SPINS, EASING, FIT],
  },
  {
    id: "swivel",
    label: "Swivel (3D H-Flip)",
    category: "Rotation & Flip",
    description: "3D flip around the vertical axis (a card flip).",
    create: (f, t, p) => new Swivel(f, t, p),
    params: [PERSPECTIVE, BACKFACE, EASING, FIT],
  },
  {
    id: "flipVertical",
    label: "Flip Vertical (3D)",
    category: "Rotation & Flip",
    description: "3D flip around the horizontal axis.",
    create: (f, t, p) => new FlipVertical(f, t, p),
    params: [PERSPECTIVE, BACKFACE, EASING, FIT],
  },
  {
    id: "rotateAndScale",
    label: "Rotate & Scale",
    category: "Rotation & Flip",
    description: "2D rotation combined with a scale-in of B.",
    create: (f, t, p) => new RotateAndScale(f, t, p),
    params: [SPINS, ANCHOR_X, ANCHOR_Y, EASING, FIT],
  },

  // --- Category 7: Shape, Pattern & Mosaic ---
  ...(
    [
      ["checkerboard", "Checkerboard", "Tiles flip in a checker pattern.", "checkerboard", [GRID, SPREAD]],
      ["blinds", "Blinds", "Horizontal/vertical strips flip like venetian blinds.", "blinds", [ORIENTATION, COUNT]],
      ["boxTiles", "Box / Expanding Squares", "Rectangular tiles grow to reveal B.", "box", [GRID, SPREAD]],
      ["diamondTiles", "Diamond Pattern", "Diamond-ordered tiles reveal from the centre.", "diamond", [GRID, SPREAD]],
      ["randomBars", "Random Bars", "Bars slide in from the edges at random times.", "randomBars", [ORIENTATION, COUNT, SEED]],
      ["strips", "Strips", "Parallel strips slide in alternating directions.", "strips", [ORIENTATION, COUNT]],
      ["blockDissolve", "Block Dissolve", "Random blocks fade to reveal B.", "blockDissolve", [GRID, SPREAD, SEED]],
      ["spiralWipe", "Spiral Wipe", "Tiles reveal along an inward spiral.", "spiral", [GRID, SPREAD]],
      ["wheel", "Wheel", "Segments reveal around a wheel.", "wheel", [GRID, SPREAD]],
      ["tileFlip", "Tile Flip", "Tiles flip over like a tile wall.", "tileFlip", [GRID, SPREAD, SEED]],
    ] as [string, string, string, PatternKind, ParamSpec[]][]
  ).map(([id, label, description, kind, extra]) => ({
    id,
    label,
    category: "Shape, Pattern & Mosaic",
    description,
    create: (f: Clip, t: Clip, p: Record<string, unknown>) => new PatternTransition(id, f, t, p, kind),
    params: [...extra, EASING, FIT],
  })),
  {
    id: "mosaic",
    label: "Mosaic / Pixelate",
    category: "Shape, Pattern & Mosaic",
    description: "Both frames pixelate into blocks and crossfade.",
    create: (f, t, p) => new Mosaic(f, t, p),
    params: [GRID, EASING, FIT],
  },
  {
    id: "vortex",
    label: "Vortex / Swirl",
    category: "Shape, Pattern & Mosaic",
    description: "A twists into a spiral and dissolves as B unwinds in (stylised).",
    create: (f, t, p) => new Vortex(f, t, p),
    params: [TWIST, EASING, FIT],
  },

  // --- Category 5 (ext): Advanced 3D Rotation ---
  {
    id: "cube",
    label: "Cube Rotation",
    category: "Advanced 3D Rotation",
    description: "A and B are adjacent faces of a cube that turns 90°.",
    create: (f, t, p) => new CubeRotation(f, t, p),
    params: [DIRECTION, PERSPECTIVE, EASING, FIT],
  },
  {
    id: "cardFlip3d",
    label: "Card Flip (3D)",
    category: "Advanced 3D Rotation",
    description: "A and B back-to-back with thickness, flipping over.",
    create: (f, t, p) => new CardFlip3D(f, t, p),
    params: [DIRECTION, THICKNESS, PERSPECTIVE, EASING, FIT],
  },
  {
    id: "tumble",
    label: "Tumble",
    category: "Advanced 3D Rotation",
    description: "A tumbles away in 3D (falls, spins, shrinks) revealing B.",
    create: (f, t, p) => new Tumble(f, t, p),
    params: [SPINS, PERSPECTIVE, EASING, FIT],
  },
  {
    id: "doors3d",
    label: "Doors (3D)",
    category: "Advanced 3D Rotation",
    description: "A splits into two panels that swing open, revealing B.",
    create: (f, t, p) => new Doors3D(f, t, p),
    params: [dirSpec(DIRECTIONS as unknown as string[], "left", "Horizontal (left/right) or vertical (up/down) doors."), PERSPECTIVE, EASING, FIT],
  },
  {
    id: "curtains3d",
    label: "Curtains (3D)",
    category: "Advanced 3D Rotation",
    description: "A parts into strips that gather to the sides with 3D folds.",
    create: (f, t, p) => new Curtains3D(f, t, p),
    params: [SEGMENTS, PERSPECTIVE, EASING, FIT],
  },
  {
    id: "flyThroughFlip",
    label: "Fly-Through Flip",
    category: "Advanced 3D Rotation",
    description: "The camera pushes in as A flips, flying through to B.",
    create: (f, t, p) => new FlyThroughFlip(f, t, p),
    params: [THICKNESS, PERSPECTIVE, EASING, FIT],
  },

  // --- Category 6: Page, Fold & Curl ---
  {
    id: "fold",
    label: "Fold",
    category: "Page, Fold & Curl",
    description: "A folds along its centre line (away from the viewer), revealing B.",
    create: (f, t, p) => new Fold(f, t, p),
    params: [ORIENTATION, PERSPECTIVE, EASING, FIT],
  },
  {
    id: "accordionFold",
    label: "Accordion Fold",
    category: "Page, Fold & Curl",
    description: "Parallel panels fold alternately and compress, revealing B.",
    create: (f, t, p) => new AccordionFold(f, t, p),
    params: [SEGMENTS, PERSPECTIVE, EASING, FIT],
  },
  {
    id: "unfold",
    label: "Unfold",
    category: "Page, Fold & Curl",
    description: "B unfolds from edge-on to flat over A.",
    create: (f, t, p) => new Unfold(f, t, p),
    params: [ORIENTATION, PERSPECTIVE, EASING, FIT],
  },
  {
    id: "pageTurn",
    label: "Page Turn (3D)",
    category: "Page, Fold & Curl",
    description: "A's page peels off a cylinder from the right edge, revealing B.",
    create: (f, t, p) => new PageTurn(f, t, p),
    params: [RADIUS, PERSPECTIVE, EASING, FIT],
  },
  {
    id: "pageRoll",
    label: "Page Roll",
    category: "Page, Fold & Curl",
    description: "A tight page turn that rolls the clip up like a scroll.",
    create: (f, t, p) => new PageRoll(f, t, p),
    params: [PERSPECTIVE, EASING, FIT],
  },
  {
    id: "pageCurl",
    label: "Page Curl",
    category: "Page, Fold & Curl",
    description: "A corner peels back with a gradient curl shadow (stylised 2D).",
    create: (f, t, p) => new PageCurl(f, t, p),
    params: [CORNER, EASING, FIT],
  },
  {
    id: "peelOff",
    label: "Peel Off",
    category: "Page, Fold & Curl",
    description: "The clip peels away from a corner (stylised 2D).",
    create: (f, t, p) => new PeelOff(f, t, p),
    params: [CORNER, EASING, FIT],
  },
  {
    id: "stickyPeel",
    label: "Sticky Peel",
    category: "Page, Fold & Curl",
    description: "Like peeling a sticker, with extra stretch on the shadow (stylised 2D).",
    create: (f, t, p) => new StickyPeel(f, t, p),
    params: [CORNER, EASING, FIT],
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
