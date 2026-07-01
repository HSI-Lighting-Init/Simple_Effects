// Category 2 — Slide, Push, Cover & Uncover (each in 4 directions).
//
// Convention for `direction`:
//   Slide / Cover / Push : the edge the INCOMING clip enters from.
//   Uncover              : the direction the OUTGOING (top) clip slides away.

import type { BaseParams, Clip, Direction } from "./types";
import { TransitionEffect, assertDirection } from "./base";

export interface MotionParams extends BaseParams {
  /** left | right | up | down. Default "left". */
  direction?: Direction;
}

type Off = { x: number; y: number };

/** Offset for a clip entering from `dir` (off-frame at p=0 → centred at p=1). */
function enterOffset(dir: Direction, p: number, w: number, h: number): Off {
  const d = 1 - p;
  switch (dir) {
    case "left":
      return { x: -d * w, y: 0 };
    case "right":
      return { x: d * w, y: 0 };
    case "up":
      return { x: 0, y: -d * h };
    default:
      return { x: 0, y: d * h }; // down
  }
}

/** Offset for the outgoing clip being pushed out opposite the entry edge. */
function pushOutOffset(dir: Direction, p: number, w: number, h: number): Off {
  switch (dir) {
    case "left":
      return { x: p * w, y: 0 };
    case "right":
      return { x: -p * w, y: 0 };
    case "up":
      return { x: 0, y: p * h };
    default:
      return { x: 0, y: -p * h }; // down
  }
}

/** Offset for the outgoing clip sliding away toward `dir` (uncover). */
function leaveOffset(dir: Direction, p: number, w: number, h: number): Off {
  switch (dir) {
    case "left":
      return { x: -p * w, y: 0 };
    case "right":
      return { x: p * w, y: 0 };
    case "up":
      return { x: 0, y: -p * h };
    default:
      return { x: 0, y: p * h }; // down
  }
}

/** A soft shadow strip cast at the leading edge of the incoming clip (Cover). */
function coverShadow(ctx: CanvasRenderingContext2D, dir: Direction, p: number, w: number, h: number) {
  const band = Math.max(6, Math.round(0.05 * Math.max(w, h)));
  const dark = "rgba(0,0,0,0.35)";
  const clear = "rgba(0,0,0,0)";
  ctx.save();
  let grad: CanvasGradient;
  if (dir === "left") {
    const x = p * w; // leading edge advancing right
    grad = ctx.createLinearGradient(x, 0, x + band, 0);
    grad.addColorStop(0, dark);
    grad.addColorStop(1, clear);
    ctx.fillStyle = grad;
    ctx.fillRect(x, 0, band, h);
  } else if (dir === "right") {
    const x = (1 - p) * w; // leading edge advancing left
    grad = ctx.createLinearGradient(x, 0, x - band, 0);
    grad.addColorStop(0, dark);
    grad.addColorStop(1, clear);
    ctx.fillStyle = grad;
    ctx.fillRect(x - band, 0, band, h);
  } else if (dir === "up") {
    const y = p * h;
    grad = ctx.createLinearGradient(0, y, 0, y + band);
    grad.addColorStop(0, dark);
    grad.addColorStop(1, clear);
    ctx.fillStyle = grad;
    ctx.fillRect(0, y, w, band);
  } else {
    const y = (1 - p) * h;
    grad = ctx.createLinearGradient(0, y, 0, y - band);
    grad.addColorStop(0, dark);
    grad.addColorStop(1, clear);
    ctx.fillStyle = grad;
    ctx.fillRect(0, y - band, w, band);
  }
  ctx.restore();
}

abstract class MotionTransition extends TransitionEffect<MotionParams> {
  protected direction: Direction;
  constructor(id: string, from: Clip, to: Clip, params: MotionParams) {
    super(id, from, to, params);
    this.direction = assertDirection(params.direction ?? "left");
  }
}

/** Slide — the incoming clip slides in over a stationary outgoing clip. */
export class Slide extends MotionTransition {
  constructor(from: Clip, to: Clip, params: MotionParams = {}) {
    super("slide", from, to, params);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const { width: w, height: h } = this.size;
    const o = enterOffset(this.direction, p, w, h);
    ctx.drawImage(a, 0, 0);
    ctx.drawImage(b, o.x, o.y);
  }
}

/** Push — the incoming clip pushes the outgoing clip out of frame (both move). */
export class Push extends MotionTransition {
  constructor(from: Clip, to: Clip, params: MotionParams = {}) {
    super("push", from, to, params);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const { width: w, height: h } = this.size;
    const oa = pushOutOffset(this.direction, p, w, h);
    const ob = enterOffset(this.direction, p, w, h);
    ctx.drawImage(a, oa.x, oa.y);
    ctx.drawImage(b, ob.x, ob.y);
  }
}

/** Cover — the incoming clip slides in over a stationary outgoing clip, with a
 *  soft leading-edge shadow to sell the "covering" depth. */
export class Cover extends MotionTransition {
  constructor(from: Clip, to: Clip, params: MotionParams = {}) {
    super("cover", from, to, params);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const { width: w, height: h } = this.size;
    const o = enterOffset(this.direction, p, w, h);
    ctx.drawImage(a, 0, 0);
    if (p > 0 && p < 1) coverShadow(ctx, this.direction, p, w, h);
    ctx.drawImage(b, o.x, o.y);
  }
}

/** Uncover — the outgoing clip slides away (on top) to reveal the stationary
 *  incoming clip underneath. */
export class Uncover extends MotionTransition {
  constructor(from: Clip, to: Clip, params: MotionParams = {}) {
    super("uncover", from, to, params);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const { width: w, height: h } = this.size;
    const o = leaveOffset(this.direction, p, w, h);
    ctx.drawImage(b, 0, 0); // incoming, stationary underneath
    ctx.drawImage(a, o.x, o.y); // outgoing slides away on top
  }
}
