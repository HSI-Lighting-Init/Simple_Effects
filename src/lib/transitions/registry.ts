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
import {
  Glitch, PixelSort, BadTV, DigitalBlockWipe, DataMosh, WaveWarp, Ripple, Swirl,
  Liquify, Melt, Stretch, MotionTile, RetroVHS, Flicker, LightLeakTransition, Prism,
} from "./glitch";
import {
  ParticleDissolve, Shatter, Explosion, Sandstorm, Confetti, Crumble, LowPolyExplode,
  MorphingParticles, SmokeBurst, Bubbles, MagicDust, Fire, WaterWash, Constellation,
} from "./disintegrate";
import {
  WhipPan, TiltWhip, DollyIn, DollyOut, Truck, ZoomShake, ParallaxCamera, KenBurns,
  DollyZoom, RackFocus, AerialFlyover, FlyThrough, Orbital, Room3D, Spin360, PerspectiveSlide,
} from "./camera";

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
  /**
   * Which clip the transition FEATURES (animates on screen):
   *  - "b" (default): it builds up / reveals clip B (B slides/fades/wipes in).
   *  - "a": it animates or destroys clip A to reveal B (disintegration, fold,
   *    page-peel). Applied to a single clip these must run with the clip as A
   *    (played in reverse), or A is empty and there's nothing to animate — so
   *    they collapse to a plain fade.
   */
  feature?: "a" | "b";
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

// --- Stage 4 parameter specs ---
const AMOUNT: ParamSpec = { name: "amount", label: "Amount", type: "number", min: 0, max: 1, step: 0.05, default: 1, description: "Overall effect strength (glitch/shake intensity)." };
const AMPLITUDE: ParamSpec = { name: "amplitude", label: "Amplitude", type: "number", min: 0, max: 120, step: 2, default: 40, description: "Distortion amplitude in pixels (waves/ripple/prism split)." };
const FREQUENCY: ParamSpec = { name: "frequency", label: "Frequency", type: "number", min: 1, max: 12, step: 0.5, default: 3, description: "Number of wave cycles / repeats / strobe steps." };
const HUE: ParamSpec = { name: "hue", label: "Hue", type: "number", min: 0, max: 360, step: 5, default: 30, description: "Light-leak colour hue." };
const DENSITY: ParamSpec = { name: "density", label: "Density", type: "number", min: 0, max: 40, step: 1, default: 0, description: "Particle / cell resolution (0 = the preset default)." };
const BLUR: ParamSpec = { name: "blur", label: "Blur", type: "number", min: 0, max: 2, step: 0.1, default: 1, description: "Motion / defocus blur strength." };
const DEPTH: ParamSpec = { name: "depth", label: "Depth", type: "number", min: 0, max: 2, step: 0.1, default: 1, description: "Dolly / parallax depth intensity." };

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

  // --- Category 8: Distortion, Glitch & Digital ---
  { id: "glitch", label: "Glitch", category: "Distortion, Glitch & Digital", description: "RGB split, block displacement and digital noise crossing into B.", create: (f, t, p) => new Glitch("glitch", f, t, p), params: [SEED, AMOUNT, EASING, FIT] },
  { id: "pixelSort", label: "Pixel Sorting", category: "Distortion, Glitch & Digital", description: "Bright bands stretch and smear along the sort axis (stylised).", create: (f, t, p) => new PixelSort("pixelSort", f, t, p), params: [SEED, AMOUNT, EASING, FIT] },
  { id: "badTV", label: "Bad TV / Signal", category: "Distortion, Glitch & Digital", description: "Rolling scanlines, noise and signal-loss interference.", create: (f, t, p) => new BadTV("badTV", f, t, p), params: [SEED, AMOUNT, EASING, FIT] },
  { id: "digitalBlockWipe", label: "Digital Block Wipe", category: "Distortion, Glitch & Digital", description: "Blocky compression-artifact reveal of B over A.", create: (f, t, p) => new DigitalBlockWipe("digitalBlockWipe", f, t, p), params: [SEED, AMOUNT, EASING, FIT] },
  { id: "dataMosh", label: "Data Moshing", category: "Distortion, Glitch & Digital", description: "Motion-smeared block displacement bleeding A into B (stylised).", create: (f, t, p) => new DataMosh("dataMosh", f, t, p), params: [SEED, AMOUNT, EASING, FIT] },
  { id: "waveWarp", label: "Wave Warp", category: "Distortion, Glitch & Digital", description: "A travelling sine distortion sweeps across as A crossfades to B.", create: (f, t, p) => new WaveWarp("waveWarp", f, t, p), params: [AMPLITUDE, FREQUENCY, EASING, FIT] },
  { id: "ripple", label: "Ripple", category: "Distortion, Glitch & Digital", description: "Concentric water-droplet ripples radiate as B resolves in.", create: (f, t, p) => new Ripple("ripple", f, t, p), params: [AMPLITUDE, FREQUENCY, EASING, FIT] },
  { id: "swirl", label: "Swirl / Twirl", category: "Distortion, Glitch & Digital", description: "The frame twists into a vortex mid-transition.", create: (f, t, p) => new Swirl("swirl", f, t, p), params: [AMPLITUDE, EASING, FIT] },
  { id: "liquify", label: "Liquify", category: "Distortion, Glitch & Digital", description: "Fluid noise-driven distortion that settles as B resolves.", create: (f, t, p) => new Liquify("liquify", f, t, p), params: [AMPLITUDE, SEED, EASING, FIT] },
  { id: "melt", label: "Melt", category: "Distortion, Glitch & Digital", description: "The clip drips downward in columns, revealing B beneath.", create: (f, t, p) => new Melt("melt", f, t, p), params: [SEED, EASING, FIT] },
  { id: "stretch", label: "Stretch", category: "Distortion, Glitch & Digital", description: "The frame whips by stretching along an axis into the next clip.", create: (f, t, p) => new Stretch("stretch", f, t, p), params: [ORIENTATION, AMOUNT, EASING, FIT] },
  { id: "motionTile", label: "Motion Tile", category: "Distortion, Glitch & Digital", description: "The clip repeats as tiles and slides like a scrolling pattern.", create: (f, t, p) => new MotionTile("motionTile", f, t, p), params: [FREQUENCY, EASING, FIT] },
  { id: "retroVHS", label: "Retro VHS", category: "Distortion, Glitch & Digital", description: "Tracking lines, colour bleed and temporal wobble.", create: (f, t, p) => new RetroVHS("retroVHS", f, t, p), params: [SEED, EASING, FIT] },
  { id: "flicker", label: "Flicker", category: "Distortion, Glitch & Digital", description: "Rapid strobe/flicker between the two clips, with white flashes.", create: (f, t, p) => new Flicker("flicker", f, t, p), params: [SEED, FREQUENCY, EASING, FIT] },
  { id: "lightLeak", label: "Light Leak", category: "Distortion, Glitch & Digital", description: "An organic warm light-leak overlay blends A into B.", create: (f, t, p) => new LightLeakTransition("lightLeak", f, t, p), params: [HUE, EASING, FIT] },
  { id: "prism", label: "Prism / Chromatic", category: "Distortion, Glitch & Digital", description: "Colour-fringing chromatic-aberration crossfade.", create: (f, t, p) => new Prism("prism", f, t, p), params: [AMPLITUDE, EASING, FIT] },

  // --- Category 9: Particles & Disintegration ---
  { id: "particleDissolve", label: "Particle Dissolve", category: "Particles & Disintegration", description: "A breaks into fine particles that drift and blow away.", create: (f, t, p) => new ParticleDissolve("particleDissolve", f, t, p), params: [DENSITY, SEED, EASING, FIT] },
  { id: "shatter", label: "Shatter / Glass", category: "Particles & Disintegration", description: "A cracks into shards that spin outward (stylised fracture).", create: (f, t, p) => new Shatter("shatter", f, t, p), params: [DENSITY, SEED, EASING, FIT] },
  { id: "explosion", label: "Explosion", category: "Particles & Disintegration", description: "A blasts outward from the centre with a flash, revealing B.", create: (f, t, p) => new Explosion("explosion", f, t, p), params: [DENSITY, SEED, EASING, FIT] },
  { id: "smokeBurst", label: "Smoke / Fog Burst", category: "Particles & Disintegration", description: "A rises and diffuses into a soft cloud, revealing B.", create: (f, t, p) => new SmokeBurst("smokeBurst", f, t, p), params: [DENSITY, SEED, EASING, FIT] },
  { id: "sandstorm", label: "Sandstorm", category: "Particles & Disintegration", description: "A disintegrates and streaks off in a wind direction.", create: (f, t, p) => new Sandstorm("sandstorm", f, t, p), params: [DIRECTION, DENSITY, SEED, EASING, FIT] },
  { id: "bubbles", label: "Bubbles", category: "Particles & Disintegration", description: "A breaks into rising translucent bubbles with highlights.", create: (f, t, p) => new Bubbles("bubbles", f, t, p), params: [DENSITY, SEED, EASING, FIT] },
  { id: "confetti", label: "Leaves / Confetti", category: "Particles & Disintegration", description: "A scatters as tumbling coloured flakes falling under gravity.", create: (f, t, p) => new Confetti("confetti", f, t, p), params: [DENSITY, SEED, EASING, FIT] },
  { id: "fire", label: "Fire", category: "Particles & Disintegration", description: "A burns away along a rising flame edge, revealing B.", create: (f, t, p) => new Fire("fire", f, t, p), params: [SEED, EASING, FIT] },
  { id: "waterWash", label: "Water / Wave Wash", category: "Particles & Disintegration", description: "A water wave sweeps across with foam and refraction, revealing B.", create: (f, t, p) => new WaterWash("waterWash", f, t, p), params: [SEED, EASING, FIT] },
  { id: "magicDust", label: "Magic Dust", category: "Particles & Disintegration", description: "A gentle dissolve trailed by sparkling magic particles.", create: (f, t, p) => new MagicDust("magicDust", f, t, p), params: [DENSITY, SEED, EASING, FIT] },
  { id: "morphingParticles", label: "Morphing Particles", category: "Particles & Disintegration", description: "Particles scatter from A, then converge into B.", create: (f, t, p) => new MorphingParticles("morphingParticles", f, t, p), params: [DENSITY, SEED, EASING, FIT] },
  { id: "constellation", label: "Constellation", category: "Particles & Disintegration", description: "Dots connect and rearrange like stars from A into B.", create: (f, t, p) => new Constellation("constellation", f, t, p), params: [DENSITY, SEED, EASING, FIT] },
  { id: "lowPolyExplode", label: "Low Poly Explode", category: "Particles & Disintegration", description: "A bursts into coarse angular shards.", create: (f, t, p) => new LowPolyExplode("lowPolyExplode", f, t, p), params: [DENSITY, SEED, EASING, FIT] },
  { id: "crumble", label: "Crumble", category: "Particles & Disintegration", description: "A cracks and falls away from the top down under gravity.", create: (f, t, p) => new Crumble("crumble", f, t, p), params: [DENSITY, SEED, EASING, FIT] },

  // --- Category 10: Camera Movement & Depth ---
  { id: "whipPan", label: "Whip Pan", category: "Camera Movement & Depth", description: "Fast horizontal pan with heavy motion blur masking the cut.", create: (f, t, p) => new WhipPan("whipPan", f, t, p), params: [BLUR, EASING, FIT] },
  { id: "tiltWhip", label: "Tilt Whip", category: "Camera Movement & Depth", description: "Fast vertical pan with heavy vertical motion blur.", create: (f, t, p) => new TiltWhip("tiltWhip", f, t, p), params: [BLUR, EASING, FIT] },
  { id: "dollyIn", label: "Dolly In", category: "Camera Movement & Depth", description: "The camera trucks forward into A, arriving on B.", create: (f, t, p) => new DollyIn("dollyIn", f, t, p), params: [DEPTH, BLUR, EASING, FIT] },
  { id: "dollyOut", label: "Dolly Out", category: "Camera Movement & Depth", description: "The camera pulls back off A, revealing B behind.", create: (f, t, p) => new DollyOut("dollyOut", f, t, p), params: [DEPTH, EASING, FIT] },
  { id: "truck", label: "Truck / Crab", category: "Camera Movement & Depth", description: "The camera slides laterally from A to B.", create: (f, t, p) => new Truck("truck", f, t, p), params: [BLUR, EASING, FIT] },
  { id: "zoomShake", label: "Zoom with Camera Shake", category: "Camera Movement & Depth", description: "Rough zoom-in with seeded handheld camera shake.", create: (f, t, p) => new ZoomShake("zoomShake", f, t, p), params: [AMOUNT, SEED, EASING, FIT] },
  { id: "parallaxCamera", label: "Parallax Camera", category: "Camera Movement & Depth", description: "Foreground and background move at different rates for depth.", create: (f, t, p) => new ParallaxCamera("parallaxCamera", f, t, p), params: [DEPTH, EASING, FIT] },
  { id: "kenBurns", label: "Ken Burns", category: "Camera Movement & Depth", description: "Slow pan-and-zoom across A, crossfading into a pan on B.", create: (f, t, p) => new KenBurns("kenBurns", f, t, p), params: [EASING, FIT] },
  { id: "dollyZoom", label: "Dolly Zoom (Vertigo)", category: "Camera Movement & Depth", description: "Opposing zoom/dolly for a disorienting vertigo warp.", create: (f, t, p) => new DollyZoom("dollyZoom", f, t, p), params: [DEPTH, EASING, FIT] },
  { id: "rackFocus", label: "Rack Focus", category: "Camera Movement & Depth", description: "Defocus A then pull focus onto B (depth-of-field shift).", create: (f, t, p) => new RackFocus("rackFocus", f, t, p), params: [BLUR, EASING, FIT] },
  { id: "aerialFlyover", label: "Aerial Flyover", category: "Camera Movement & Depth", description: "A drone-like diagonal sweep across both clips.", create: (f, t, p) => new AerialFlyover("aerialFlyover", f, t, p), params: [EASING, FIT] },
  { id: "flyThrough", label: "Fly Through", category: "Camera Movement & Depth", description: "The camera flies past A into B waiting in depth behind it (3D).", create: (f, t, p) => new FlyThrough("flyThrough", f, t, p), params: [EASING, FIT] },
  { id: "orbital", label: "Orbital / Arc", category: "Camera Movement & Depth", description: "The frames turn on a turntable as the view arcs across (3D).", create: (f, t, p) => new Orbital("orbital", f, t, p), params: [EASING, FIT] },
  { id: "room3d", label: "3D Room", category: "Camera Movement & Depth", description: "A and B are walls of a room; the camera yaws from one to the other (3D).", create: (f, t, p) => new Room3D("room3d", f, t, p), params: [EASING, FIT] },
  { id: "spin360", label: "360 Spin", category: "Camera Movement & Depth", description: "A full turn swaps the front (A) for the back (B) (3D).", create: (f, t, p) => new Spin360("spin360", f, t, p), params: [EASING, FIT] },
  { id: "perspectiveSlide", label: "Perspective Slide", category: "Camera Movement & Depth", description: "Tilted-in-perspective frames slide across (3D).", create: (f, t, p) => new PerspectiveSlide("perspectiveSlide", f, t, p), params: [EASING, FIT] },
];

// Transitions that FEATURE clip A — they animate/destroy A (or crossfade a
// distortion through it) to reveal B, rather than building B up from nothing.
// Everything else reveals/builds B. See `TransitionMeta.feature`. This matters
// for a SINGLE-clip transition: those must put the clip on the correct side, or
// A is empty (nothing to animate / a translucent crossfade) and they collapse to
// a fade. (Applied between two real clips this flag is irrelevant.)
const FEATURE_A_IDS = new Set<string>([
  // Particles / disintegration (grid of A flies away over B).
  "particleDissolve", "shatter", "explosion", "smokeBurst", "sandstorm", "bubbles",
  "confetti", "fire", "magicDust", "lowPolyExplode", "crumble", "morphingParticles",
  // Page / fold / peel (A folds or peels off B).
  "fold", "accordionFold", "pageTurn", "pageRoll", "pageCurl", "peelOff", "stickyPeel",
  // 3D that animates A away over B.
  "tumble", "doors3d", "curtains3d",
  // Distortion / glitch — draw B under a warp of A, or crossfade a distortion
  // (which with an empty A would just show the clip translucent).
  "glitch", "pixelSort", "badTV", "dataMosh", "waveWarp", "ripple", "swirl",
  "liquify", "melt", "stretch", "motionTile", "retroVHS", "flicker", "lightLeak", "prism",
  // Motion / zoom where A slides or scales away to reveal B.
  "uncover", "scaleDown",
]);
for (const m of REGISTRY) m.feature = FEATURE_A_IDS.has(m.id) ? "a" : "b";

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
