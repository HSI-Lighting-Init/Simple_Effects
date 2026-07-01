// Category 5 (extension) — Advanced 3D rotations, built on the mesh3d pipeline.
//   Cube Rotation, Card Flip (thickness), Tumble (physics), Doors (3D),
//   Curtains (3D), Fly-Through Flip.

import type { BaseParams, Clip, Direction } from "./types";
import { TransitionEffect, assertDirection } from "./base";
import { rot, add, frameQuad, renderQuads, type V3, type Quad, type Camera } from "./mesh3d";

export interface Rotate3DParams extends BaseParams {
  direction?: Direction;
  /** 3D perspective strength 0..1. */
  perspective?: number;
  /** Card/fly thickness as a fraction of width. */
  thickness?: number;
  /** Tumble rotations. */
  spins?: number;
  /** Curtain strip count. */
  segments?: number;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scaleV = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];

abstract class Rotate3D extends TransitionEffect<Rotate3DParams> {
  protected perspective: number;
  constructor(id: string, from: Clip, to: Clip, params: Rotate3DParams) {
    super(id, from, to, params);
    const p = params.perspective;
    this.perspective = Number.isFinite(p) ? Math.max(0, Math.min(1, p as number)) : 0.5;
  }
  protected camera(distScale = 1): Camera {
    const base = Math.max(this.outW, this.outH);
    return { w: this.outW, h: this.outH, dist: base * (1.4 + (1 - this.perspective) * 2.6) * distScale };
  }
  /** Rotate a corner about a pivot. */
  protected pivotRot(v: V3, pivot: V3, rx: number, ry: number, rz: number): V3 {
    return add(rot(sub(v, pivot), rx, ry, rz), pivot);
  }
}

/** Cube Rotation — A and B are adjacent faces of a cube that turns 90°. */
export class CubeRotation extends Rotate3D {
  private dir: Direction;
  constructor(from: Clip, to: Clip, params: Rotate3DParams = {}) {
    super("cube", from, to, params);
    this.dir = assertDirection(params.direction ?? "left");
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const W = this.outW, H = this.outH;
    const horiz = this.dir === "left" || this.dir === "right";
    const sign = this.dir === "right" || this.dir === "down" ? -1 : 1;
    const D = horiz ? W : H;
    const ang = sign * (Math.PI / 2) * p;
    const rc = (c: V3): V3 => rot(c, horiz ? 0 : ang, horiz ? ang : 0, 0);
    const front: [V3, V3, V3, V3] = [
      [-W / 2, -H / 2, D / 2],
      [W / 2, -H / 2, D / 2],
      [W / 2, H / 2, D / 2],
      [-W / 2, H / 2, D / 2],
    ];
    let side: [V3, V3, V3, V3];
    if (this.dir === "right") side = [[W / 2, -H / 2, D / 2], [W / 2, -H / 2, -D / 2], [W / 2, H / 2, -D / 2], [W / 2, H / 2, D / 2]];
    else if (this.dir === "left") side = [[-W / 2, -H / 2, -D / 2], [-W / 2, -H / 2, D / 2], [-W / 2, H / 2, D / 2], [-W / 2, H / 2, -D / 2]];
    else if (this.dir === "up") side = [[-W / 2, -H / 2, -D / 2], [W / 2, -H / 2, -D / 2], [W / 2, -H / 2, D / 2], [-W / 2, -H / 2, D / 2]];
    else side = [[-W / 2, H / 2, D / 2], [W / 2, H / 2, D / 2], [W / 2, H / 2, -D / 2], [-W / 2, H / 2, -D / 2]];
    const quads: Quad[] = [
      { tex: a, sx: 0, sy: 0, sw: W, sh: H, c: front.map(rc) as [V3, V3, V3, V3] },
      { tex: b, sx: 0, sy: 0, sw: W, sh: H, c: side.map(rc) as [V3, V3, V3, V3] },
    ];
    renderQuads(ctx, quads, this.camera());
  }
}

/** Card Flip — A and B back-to-back with thickness, flipping over. */
export class CardFlip3D extends Rotate3D {
  private dir: Direction;
  private thickness: number;
  constructor(from: Clip, to: Clip, params: Rotate3DParams = {}) {
    super("cardFlip3d", from, to, params);
    this.dir = assertDirection(params.direction ?? "left");
    this.thickness = (params.thickness ?? 0.03) * this.outW;
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const W = this.outW, H = this.outH, t = this.thickness;
    const horiz = this.dir === "left" || this.dir === "right";
    const sign = this.dir === "right" || this.dir === "down" ? -1 : 1;
    const ang = sign * Math.PI * p;
    const rc = (c: V3): V3 => rot(c, horiz ? 0 : ang, horiz ? ang : 0, 0);
    const front: [V3, V3, V3, V3] = [[-W / 2, -H / 2, t / 2], [W / 2, -H / 2, t / 2], [W / 2, H / 2, t / 2], [-W / 2, H / 2, t / 2]];
    const back: [V3, V3, V3, V3] = [[W / 2, -H / 2, -t / 2], [-W / 2, -H / 2, -t / 2], [-W / 2, H / 2, -t / 2], [W / 2, H / 2, -t / 2]];
    const quads: Quad[] = [
      { tex: a, sx: 0, sy: 0, sw: W, sh: H, c: front.map(rc) as [V3, V3, V3, V3], shadow: true },
      { tex: b, sx: 0, sy: 0, sw: W, sh: H, c: back.map(rc) as [V3, V3, V3, V3] },
    ];
    renderQuads(ctx, quads, this.camera());
  }
}

/** Tumble — A tumbles away in 3D (falls + spins + shrinks) revealing B. */
export class Tumble extends Rotate3D {
  private spins: number;
  constructor(from: Clip, to: Clip, params: Rotate3DParams = {}) {
    super("tumble", from, to, params);
    this.spins = params.spins ?? 1.5;
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    ctx.drawImage(b, 0, 0);
    const W = this.outW, H = this.outH;
    const ry = p * this.spins * Math.PI * 2;
    const rx = ry * 0.6;
    const s = 1 - 0.35 * p;
    const ty = p * p * H * 1.3; // gravity fall
    const tz = -p * this.camera().dist * 0.35;
    const rc = (c: V3): V3 => add(rot(scaleV(c, s), rx, ry, 0), [0, ty, tz]);
    const corners: [V3, V3, V3, V3] = [[-W / 2, -H / 2, 0], [W / 2, -H / 2, 0], [W / 2, H / 2, 0], [-W / 2, H / 2, 0]];
    renderQuads(ctx, [{ tex: a, sx: 0, sy: 0, sw: W, sh: H, c: corners.map(rc) as [V3, V3, V3, V3], shadow: true }], this.camera());
  }
}

/** Doors (3D) — A splits into two panels that swing open, revealing B. */
export class Doors3D extends Rotate3D {
  private vertical: boolean;
  constructor(from: Clip, to: Clip, params: Rotate3DParams = {}) {
    super("doors3d", from, to, params);
    this.vertical = params.direction === "up" || params.direction === "down";
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    ctx.drawImage(b, 0, 0);
    const W = this.outW, H = this.outH;
    const ang = Math.PI * 0.55 * p;
    const quads: Quad[] = [];
    if (!this.vertical) {
      const pl: V3 = [-W / 2, 0, 0];
      const pr: V3 = [W / 2, 0, 0];
      quads.push(frameQuad(a, W, H, { x: 0, y: 0, w: W / 2, h: H }, (v) => this.pivotRot(v, pl, 0, ang, 0), { shadow: true }));
      quads.push(frameQuad(a, W, H, { x: W / 2, y: 0, w: W / 2, h: H }, (v) => this.pivotRot(v, pr, 0, -ang, 0), { shadow: true }));
    } else {
      const pt: V3 = [0, -H / 2, 0];
      const pb: V3 = [0, H / 2, 0];
      quads.push(frameQuad(a, W, H, { x: 0, y: 0, w: W, h: H / 2 }, (v) => this.pivotRot(v, pt, -ang, 0, 0), { shadow: true }));
      quads.push(frameQuad(a, W, H, { x: 0, y: H / 2, w: W, h: H / 2 }, (v) => this.pivotRot(v, pb, ang, 0, 0), { shadow: true }));
    }
    renderQuads(ctx, quads, this.camera());
  }
}

/** Curtains (3D) — A parts into strips that gather to the sides with folds. */
export class Curtains3D extends Rotate3D {
  private segments: number;
  constructor(from: Clip, to: Clip, params: Rotate3DParams = {}) {
    super("curtains3d", from, to, params);
    this.segments = Math.max(2, Math.round(params.segments ?? 10));
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    ctx.drawImage(b, 0, 0);
    const W = this.outW, H = this.outH, N = this.segments;
    const sw = W / N;
    const quads: Quad[] = [];
    for (let i = 0; i < N; i++) {
      const leftHalf = i < N / 2;
      const gather = leftHalf ? -p * (i + 1) * sw : p * (N - i) * sw; // slide toward side
      const fold = Math.sin(((i % 2) + 1) * Math.PI * 0.5) * p * 0.6 * (leftHalf ? 1 : -1); // alternating fold
      quads.push(
        frameQuad(
          a,
          W,
          H,
          { x: i * sw, y: 0, w: sw, h: H },
          (v) => add(rot(v, 0, fold, 0), [gather, 0, 0]),
          { shade: 1 - 0.35 * Math.abs(fold) }
        )
      );
    }
    renderQuads(ctx, quads, this.camera());
  }
}

/** Fly-Through Flip — the camera pushes in as A flips, flying "through" to B. */
export class FlyThroughFlip extends Rotate3D {
  private thickness: number;
  constructor(from: Clip, to: Clip, params: Rotate3DParams = {}) {
    super("flyThroughFlip", from, to, params);
    this.thickness = (params.thickness ?? 0.03) * this.outW;
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const W = this.outW, H = this.outH, t = this.thickness;
    const ang = Math.PI * p;
    const push = Math.sin(Math.PI * p); // 0 → 1 → 0
    const tz = push * this.camera().dist * 0.5; // fly toward camera at the mid-flip
    const rc = (c: V3): V3 => add(rot(c, 0, ang, 0), [0, 0, tz]);
    const front: [V3, V3, V3, V3] = [[-W / 2, -H / 2, t / 2], [W / 2, -H / 2, t / 2], [W / 2, H / 2, t / 2], [-W / 2, H / 2, t / 2]];
    const back: [V3, V3, V3, V3] = [[W / 2, -H / 2, -t / 2], [-W / 2, -H / 2, -t / 2], [-W / 2, H / 2, -t / 2], [W / 2, H / 2, -t / 2]];
    const quads: Quad[] = [
      { tex: a, sx: 0, sy: 0, sw: W, sh: H, c: front.map(rc) as [V3, V3, V3, V3], shadow: true },
      { tex: b, sx: 0, sy: 0, sw: W, sh: H, c: back.map(rc) as [V3, V3, V3, V3] },
    ];
    renderQuads(ctx, quads, this.camera(1 - 0.3 * push));
  }
}
