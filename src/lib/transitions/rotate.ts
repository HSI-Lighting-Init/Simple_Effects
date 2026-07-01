// Category 5 — Rotation & Flip (basic).
//
// Spin is a real 2D rotation. The "3D" flips are faked on 2D canvas by scaling
// the axis being rotated by cos(angle) (edge-on at 90°) with a small
// perspective squeeze on the other axis; the reverse side shows either the next
// clip (backface = the card's other face) or a dimmed mirror (backface culled).

import type { BaseParams, Clip } from "./types";
import { TransitionEffect } from "./base";
import { clamp01 } from "./easing";
import { drawXform } from "./xform";

export interface RotateParams extends BaseParams {
  /** Number of full turns for spins. Default 1. */
  spins?: number;
  /** 3D foreshortening 0..1 for flips. Default 0.5. */
  perspective?: number;
  /** Flips: show the next clip on the reverse (true) or a dimmed backface (false). */
  backface?: boolean;
  anchorX?: number;
  anchorY?: number;
}

abstract class RotateBase extends TransitionEffect<RotateParams> {
  protected spins: number;
  protected perspective: number;
  protected backface: boolean;
  protected ax: number;
  protected ay: number;
  constructor(id: string, from: Clip, to: Clip, params: RotateParams) {
    super(id, from, to, params);
    const nn = (v: number | undefined, d: number) => (Number.isFinite(v) ? (v as number) : d);
    this.spins = nn(params.spins, 1);
    this.perspective = clamp01(nn(params.perspective, 0.5));
    this.backface = params.backface ?? true;
    this.ax = clamp01(nn(params.anchorX, 0.5));
    this.ay = clamp01(nn(params.anchorY, 0.5));
  }

  /** 3D-flip renderer. `axis` "x" (swivel) squeezes width; "y" (flip) squeezes height. */
  protected flip3d(
    ctx: CanvasRenderingContext2D,
    a: HTMLCanvasElement,
    b: HTMLCanvasElement,
    p: number,
    axis: "x" | "y"
  ) {
    const ang = Math.PI * p; // 0 → 180°
    const c = Math.cos(ang); // 1 → -1
    const squeeze = 1 - this.perspective * 0.35 * Math.abs(Math.sin(ang));
    const front = ang < Math.PI / 2;
    const base = { w: this.outW, h: this.outH, anchorX: this.ax, anchorY: this.ay };
    if (axis === "x") {
      if (front) drawXform(ctx, a, { ...base, scaleX: c, scaleY: squeeze });
      else if (this.backface) drawXform(ctx, b, { ...base, scaleX: -c, scaleY: squeeze });
      else drawXform(ctx, a, { ...base, scaleX: c, scaleY: squeeze, alpha: 0.5 });
    } else {
      if (front) drawXform(ctx, a, { ...base, scaleX: squeeze, scaleY: c });
      else if (this.backface) drawXform(ctx, b, { ...base, scaleX: squeeze, scaleY: -c });
      else drawXform(ctx, a, { ...base, scaleX: squeeze, scaleY: c, alpha: 0.5 });
    }
  }
}

/** Spin (2D) — the clip rotates in the 2D plane while it crossfades. */
export class Spin2D extends RotateBase {
  constructor(from: Clip, to: Clip, params: RotateParams = {}) {
    super("spin2d", from, to, params);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const ang = this.spins * Math.PI * 2;
    const base = { w: this.outW, h: this.outH, anchorX: this.ax, anchorY: this.ay };
    drawXform(ctx, a, { ...base, rotate: ang * p, alpha: 1 - p });
    drawXform(ctx, b, { ...base, rotate: -ang * (1 - p), alpha: p });
  }
}

/** Swivel — 3D flip around the vertical axis (a card flip). */
export class Swivel extends RotateBase {
  constructor(from: Clip, to: Clip, params: RotateParams = {}) {
    super("swivel", from, to, params);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    this.flip3d(ctx, a, b, p, "x");
  }
}

/** Flip Vertical — 3D flip around the horizontal axis. */
export class FlipVertical extends RotateBase {
  constructor(from: Clip, to: Clip, params: RotateParams = {}) {
    super("flipVertical", from, to, params);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    this.flip3d(ctx, a, b, p, "y");
  }
}

/** Rotate & Scale — 2D rotation combined with a scale-in of B. */
export class RotateAndScale extends RotateBase {
  constructor(from: Clip, to: Clip, params: RotateParams = {}) {
    super("rotateAndScale", from, to, params);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const ang = this.spins * Math.PI * 2;
    const base = { w: this.outW, h: this.outH, anchorX: this.ax, anchorY: this.ay };
    drawXform(ctx, a, { ...base, rotate: ang * p * 0.5, scale: 1 + 0.4 * p, alpha: 1 - p });
    drawXform(ctx, b, { ...base, rotate: -ang * (1 - p), scale: p, alpha: p });
  }
}
