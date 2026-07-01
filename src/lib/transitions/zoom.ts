// Category 4 — Zoom, Scale & Pan.
//
// All are transforms of the two prepared frames: zoom = scale about an anchor,
// pan = translate, plus a motion-blur option (accumulated samples along the
// motion vector) and a spring-driven Scale Bounce.

import type { BaseParams, Clip, Direction } from "./types";
import { TransitionEffect, assertDirection } from "./base";
import { clamp01 } from "./easing";
import { drawXform } from "./xform";

export interface ZoomParams extends BaseParams {
  /** Zoom/scale anchor as a fraction of the frame (0..1). Default centre. */
  anchorX?: number;
  anchorY?: number;
  /** Zoom strength (extra scale). Class-specific default. */
  zoom?: number;
  /** Motion-blur amount 0..1 (0 = off). */
  motionBlur?: number;
  /** Pan direction. */
  direction?: Direction;
  /** Scale Bounce spring — tension (stiffness) and friction (bounce damping). */
  tension?: number;
  friction?: number;
}

abstract class ZoomBase extends TransitionEffect<ZoomParams> {
  protected ax: number;
  protected ay: number;
  protected zoom: number;
  protected motionBlur: number;
  constructor(id: string, from: Clip, to: Clip, params: ZoomParams, defZoom = 1) {
    super(id, from, to, params);
    const nn = (v: number | undefined, d: number) => (Number.isFinite(v) ? (v as number) : d);
    this.ax = clamp01(nn(params.anchorX, 0.5));
    this.ay = clamp01(nn(params.anchorY, 0.5));
    this.zoom = Math.max(0, nn(params.zoom, defZoom));
    this.motionBlur = clamp01(nn(params.motionBlur, 0));
  }
  /** Draw `img` scaled about the anchor, with optional radial zoom-blur streaks. */
  protected drawScaled(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, scale: number, alpha: number, spread = 0) {
    const base = { w: this.outW, h: this.outH, anchorX: this.ax, anchorY: this.ay };
    if (spread > 0 && this.motionBlur > 0) {
      const n = 8;
      for (let i = 0; i < n; i++) {
        const f = i / (n - 1);
        drawXform(ctx, img, { ...base, scale: scale * (1 + spread * this.motionBlur * f), alpha: alpha / n });
      }
    } else {
      drawXform(ctx, img, { ...base, scale, alpha });
    }
  }
}

/** Zoom In — camera pushes into A, then B settles in from an over-zoom. */
export class ZoomIn extends ZoomBase {
  constructor(from: Clip, to: Clip, params: ZoomParams = {}) {
    super("zoomIn", from, to, params, 1);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    this.drawScaled(ctx, a, 1 + this.zoom * p, 1 - p, this.zoom);
    this.drawScaled(ctx, b, 1 + this.zoom * (1 - p), p);
  }
}

/** Zoom Out — A shrinks away to reveal B growing behind it. */
export class ZoomOut extends ZoomBase {
  constructor(from: Clip, to: Clip, params: ZoomParams = {}) {
    super("zoomOut", from, to, params, 0.5);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    this.drawScaled(ctx, b, 1 - this.zoom * (1 - p), 1);
    this.drawScaled(ctx, a, 1 - this.zoom * p, 1 - p, this.zoom);
  }
}

/** Zoom with Motion Blur — a fast zoom-in whose streaks mask the cut. */
export class ZoomMotionBlur extends ZoomBase {
  constructor(from: Clip, to: Clip, params: ZoomParams = {}) {
    super("zoomMotionBlur", from, to, { motionBlur: 0.6, ...params }, 1.4);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    this.drawScaled(ctx, a, 1 + this.zoom * p, 1 - p, this.zoom * 1.5);
    this.drawScaled(ctx, b, 1 + this.zoom * (1 - p) * 0.6, p, this.zoom);
  }
}

function panVec(dir: Direction, p: number, w: number, h: number): { ax: number; bx: number; ay: number; by: number } {
  // The incoming enters from `dir`; the outgoing leaves the opposite way.
  switch (dir) {
    case "left":
      return { ax: p * w, bx: -(1 - p) * w, ay: 0, by: 0 };
    case "right":
      return { ax: -p * w, bx: (1 - p) * w, ay: 0, by: 0 };
    case "up":
      return { ax: 0, bx: 0, ay: p * h, by: -(1 - p) * h };
    default:
      return { ax: 0, bx: 0, ay: -p * h, by: (1 - p) * h }; // down
  }
}

/** Pan — the camera pans directionally from A to the adjacent clip B. */
export class Pan extends ZoomBase {
  protected direction: Direction;
  constructor(from: Clip, to: Clip, params: ZoomParams = {}) {
    super("pan", from, to, params, 0);
    this.direction = assertDirection(params.direction ?? "left");
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const v = panVec(this.direction, p, this.outW, this.outH);
    drawXform(ctx, a, { w: this.outW, h: this.outH, tx: v.ax, ty: v.ay });
    drawXform(ctx, b, { w: this.outW, h: this.outH, tx: v.bx, ty: v.by });
  }
}

/** Zoom & Pan — a directional pan combined with a push-in zoom. */
export class ZoomAndPan extends ZoomBase {
  protected direction: Direction;
  constructor(from: Clip, to: Clip, params: ZoomParams = {}) {
    super("zoomAndPan", from, to, params, 0.4);
    this.direction = assertDirection(params.direction ?? "left");
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const v = panVec(this.direction, p, this.outW, this.outH);
    drawXform(ctx, a, { w: this.outW, h: this.outH, tx: v.ax, ty: v.ay, scale: 1 + this.zoom * p, anchorX: this.ax, anchorY: this.ay, alpha: 1 - p });
    drawXform(ctx, b, { w: this.outW, h: this.outH, tx: v.bx, ty: v.by, scale: 1 + this.zoom * (1 - p), anchorX: this.ax, anchorY: this.ay, alpha: p });
  }
}

/** Scale Up — B scales up from nothing over a stationary A. */
export class ScaleUp extends ZoomBase {
  constructor(from: Clip, to: Clip, params: ZoomParams = {}) {
    super("scaleUp", from, to, params, 0);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    drawXform(ctx, a, { w: this.outW, h: this.outH });
    drawXform(ctx, b, { w: this.outW, h: this.outH, scale: p, anchorX: this.ax, anchorY: this.ay });
  }
}

/** Scale Down — A scales down to nothing, revealing a stationary B. */
export class ScaleDown extends ZoomBase {
  constructor(from: Clip, to: Clip, params: ZoomParams = {}) {
    super("scaleDown", from, to, params, 0);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    drawXform(ctx, b, { w: this.outW, h: this.outH });
    drawXform(ctx, a, { w: this.outW, h: this.outH, scale: 1 - p, anchorX: this.ax, anchorY: this.ay });
  }
}

/** Scale Bounce — B scales in with spring overshoot (configurable bounce). */
export class ScaleBounce extends ZoomBase {
  constructor(from: Clip, to: Clip, params: ZoomParams = {}) {
    // Drive the scale via a spring on progress (may overshoot 1 → bounce).
    const easing = params.easing ?? { type: "spring" as const, tension: params.tension ?? 180, friction: params.friction ?? 12 };
    super("scaleBounce", from, to, { ...params, easing }, 0);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    drawXform(ctx, a, { w: this.outW, h: this.outH });
    drawXform(ctx, b, { w: this.outW, h: this.outH, scale: Math.max(0, p), anchorX: this.ax, anchorY: this.ay });
  }
}
