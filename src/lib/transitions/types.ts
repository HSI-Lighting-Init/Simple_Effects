// Shared types for the transition-effects engine (Stage 1).
//
// A "clip" here is just a source frame to blend from/to at a given progress.
// Transitions are self-contained renderers: given fromClip, toClip and a
// progress in [0,1], render() paints the blended output into a target canvas.

export type Direction = "left" | "right" | "up" | "down";
export type FitMode = "contain" | "cover" | "stretch";
export type EasingName = "linear" | "easeIn" | "easeOut" | "easeInOut";

/** A source frame. `source` null = an empty / fully transparent input. */
export interface Clip {
  source: CanvasImageSource | null;
  width: number;
  height: number;
}

/** 8-bit colour; alpha optional (defaults to 255). */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a?: number;
}

/** Options common to every transition. */
export interface BaseParams {
  /** Informational (the engine renders from `progress`, not wall-clock). */
  durationMs?: number;
  easing?: EasingName;
  /** How each clip is fitted into the output frame. Default "cover". */
  fit?: FitMode;
  /** Output frame size. Defaults to the from-clip's size (then to-clip). */
  outWidth?: number;
  outHeight?: number;
  /** Try the WebGL path (blend transitions only); falls back to CPU. */
  preferGpu?: boolean;
}

export const DIRECTIONS: Direction[] = ["left", "right", "up", "down"];
export const FIT_MODES: FitMode[] = ["contain", "cover", "stretch"];
