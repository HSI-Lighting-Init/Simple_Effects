// Base architecture for transition effects.
//
// Every transition extends `TransitionEffect`. It is constructed with the two
// clips + parameters, validates them, and exposes `render(target, progress)`
// which paints the eased, blended output frame at any progress point. Subclasses
// implement `composeCpu(ctx, a, b, p)` where `a`/`b` are the two clips already
// fitted into full output-size frames (so aspect-ratio, transparency and empty
// inputs are handled once, here).

import type { BaseParams, Clip, Direction, FitMode, RGBA } from "./types";
import { DIRECTIONS, FIT_MODES } from "./types";
import { ease, clamp01 } from "./easing";
import { glBlend } from "./gl";

export class TransitionError extends Error {}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new TransitionError(msg);
}

/** Validate + normalise a colour, clamping channels to 0..255 (alpha default 255). */
export function normColor(c: RGBA | undefined, fallback: RGBA): Required<RGBA> {
  const src = c ?? fallback;
  const ch = (v: number, d: number) => (Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : d);
  return { r: ch(src.r, fallback.r), g: ch(src.g, fallback.g), b: ch(src.b, fallback.b), a: ch(src.a ?? 255, 255) };
}

export function assertDirection(d: Direction): Direction {
  assert(DIRECTIONS.includes(d), `direction must be one of ${DIRECTIONS.join(", ")} (got "${d}")`);
  return d;
}

export const colorCss = (c: Required<RGBA>): string => `rgba(${c.r},${c.g},${c.b},${c.a / 255})`;

export abstract class TransitionEffect<P extends BaseParams = BaseParams> {
  readonly id: string;
  protected fromClip: Clip;
  protected toClip: Clip;
  protected params: P;
  protected easingName: BaseParams["easing"];
  protected fit: FitMode;
  protected preferGpu: boolean;
  protected outW: number;
  protected outH: number;
  /** WebGL blend mode for this transition, or null for CPU-only. */
  protected glMode: number | null = null;

  constructor(id: string, fromClip: Clip, toClip: Clip, params: P) {
    this.id = id;
    assert(fromClip != null && toClip != null, "fromClip and toClip are required (use an empty Clip, not undefined)");
    this.fromClip = fromClip;
    this.toClip = toClip;
    this.params = params;

    this.easingName = params.easing ?? "linear";
    assert(
      ["linear", "easeIn", "easeOut", "easeInOut"].includes(this.easingName),
      `unknown easing "${this.easingName}"`
    );
    this.fit = params.fit ?? "cover";
    assert(FIT_MODES.includes(this.fit), `unknown fit "${this.fit}"`);
    if (params.durationMs != null) assert(params.durationMs >= 0, "durationMs must be >= 0");
    this.preferGpu = !!params.preferGpu;

    // Output size: explicit, else first non-empty clip, else a sane default.
    const w = params.outWidth ?? fromClip.width ?? toClip.width ?? 1280;
    const h = params.outHeight ?? fromClip.height ?? toClip.height ?? 720;
    assert(w > 0 && h > 0, "output size must be positive");
    this.outW = Math.round(w);
    this.outH = Math.round(h);
  }

  /** Draw one clip fitted into an (outW × outH) frame with the chosen fit mode. */
  protected drawFitted(ctx: CanvasRenderingContext2D, clip: Clip, dx = 0, dy = 0, alpha = 1) {
    if (!clip.source || clip.width <= 0 || clip.height <= 0) return; // empty/transparent input
    const { outW, outH, fit } = this;
    ctx.save();
    ctx.globalAlpha = clamp01(alpha);
    if (fit === "stretch") {
      ctx.drawImage(clip.source, dx, dy, outW, outH);
    } else {
      const s =
        fit === "cover"
          ? Math.max(outW / clip.width, outH / clip.height)
          : Math.min(outW / clip.width, outH / clip.height);
      const dw = clip.width * s;
      const dh = clip.height * s;
      ctx.drawImage(clip.source, dx + (outW - dw) / 2, dy + (outH - dh) / 2, dw, dh);
    }
    ctx.restore();
  }

  /** A full-frame offscreen canvas with the clip fitted in (transparent if empty). */
  protected prepareFrame(clip: Clip): HTMLCanvasElement {
    const cv = document.createElement("canvas");
    cv.width = this.outW;
    cv.height = this.outH;
    const ctx = cv.getContext("2d");
    if (ctx) this.drawFitted(ctx, clip);
    return cv;
  }

  /** Compose the output at eased progress `p` (0..1). Subclasses implement this. */
  protected abstract composeCpu(
    ctx: CanvasRenderingContext2D,
    a: HTMLCanvasElement,
    b: HTMLCanvasElement,
    p: number
  ): void;

  /**
   * Render the transition at `progress` (0..1) into `target`. Sizes the target
   * to the output frame, applies easing, and picks GPU (if opted-in and this
   * transition supports it) or the CPU path.
   */
  render(target: HTMLCanvasElement, progress: number): void {
    const p = ease(this.easingName ?? "linear", progress);
    if (target.width !== this.outW) target.width = this.outW;
    if (target.height !== this.outH) target.height = this.outH;
    const ctx = target.getContext("2d");
    assert(ctx, "could not get a 2D context on the target canvas");
    const a = this.prepareFrame(this.fromClip);
    const b = this.prepareFrame(this.toClip);
    if (this.preferGpu && this.glMode != null) {
      if (glBlend(ctx, a, b, this.outW, this.outH, p, this.glMode)) return;
    }
    ctx.clearRect(0, 0, this.outW, this.outH);
    this.composeCpu(ctx, a, b, p);
  }

  /** Output frame size (after fitting), for callers sizing their canvas. */
  get size(): { width: number; height: number } {
    return { width: this.outW, height: this.outH };
  }
}
