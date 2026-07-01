// Category 6 — Page, Fold & Curl.
//   Fold, Accordion Fold, Unfold, Page Turn (cylinder mesh), Page Roll,
//   Page Curl / Peel Off / Sticky Peel (corner peel with gradient shadow).
//
// Fold family uses flat panels through the mesh3d pipeline. Page Turn/Roll wrap
// A's columns around a cylinder. The corner peels are a stylised 2D approximation
// (diagonal reveal + gradient curl shadow), not a full 3D curl mesh.

import type { BaseParams, Clip } from "./types";
import { TransitionEffect } from "./base";
import { clamp01 } from "./easing";
import { rot, add, frameQuad, renderQuads, type V3, type Quad, type Camera } from "./mesh3d";

export interface FoldParams extends BaseParams {
  orientation?: "horizontal" | "vertical";
  perspective?: number;
  /** Accordion panel count. */
  segments?: number;
  /** Page curl radius as a fraction of width. */
  radius?: number;
  /** Peel corner. */
  corner?: "tl" | "tr" | "bl" | "br";
}

function cam(W: number, H: number, persp: number): Camera {
  return { w: W, h: H, dist: Math.max(W, H) * (1.4 + (1 - persp) * 2.6) };
}
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const pr = (v: V3, pivot: V3, rx: number, ry: number, rz: number): V3 => add(rot(sub(v, pivot), rx, ry, rz), pivot);

abstract class FoldBase extends TransitionEffect<FoldParams> {
  protected persp: number;
  constructor(id: string, from: Clip, to: Clip, params: FoldParams) {
    super(id, from, to, params);
    const p = params.perspective;
    this.persp = Number.isFinite(p) ? clamp01(p as number) : 0.5;
  }
}

/** Fold — A folds along its centre line (away from the viewer), revealing B. */
export class Fold extends FoldBase {
  private vertical: boolean;
  constructor(from: Clip, to: Clip, params: FoldParams = {}) {
    super("fold", from, to, params);
    this.vertical = (params.orientation ?? "horizontal") === "vertical";
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    ctx.drawImage(b, 0, 0);
    const W = this.outW, H = this.outH;
    const ang = (Math.PI / 2) * p;
    const quads: Quad[] = [];
    if (!this.vertical) {
      quads.push(frameQuad(a, W, H, { x: 0, y: 0, w: W, h: H / 2 }, (v) => pr(v, [0, 0, 0], -ang, 0, 0), { shadow: true }));
      quads.push(frameQuad(a, W, H, { x: 0, y: H / 2, w: W, h: H / 2 }, (v) => pr(v, [0, 0, 0], ang, 0, 0), { shadow: true }));
    } else {
      quads.push(frameQuad(a, W, H, { x: 0, y: 0, w: W / 2, h: H }, (v) => pr(v, [0, 0, 0], 0, ang, 0), { shadow: true }));
      quads.push(frameQuad(a, W, H, { x: W / 2, y: 0, w: W / 2, h: H }, (v) => pr(v, [0, 0, 0], 0, -ang, 0), { shadow: true }));
    }
    renderQuads(ctx, quads, cam(W, H, this.persp));
  }
}

/** Accordion Fold — parallel panels fold alternately and compress, revealing B. */
export class AccordionFold extends FoldBase {
  private segments: number;
  constructor(from: Clip, to: Clip, params: FoldParams = {}) {
    super("accordionFold", from, to, params);
    this.segments = Math.max(2, Math.round(params.segments ?? 6));
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    ctx.drawImage(b, 0, 0);
    const W = this.outW, H = this.outH, N = this.segments;
    const sw = W / N;
    const ang = (Math.PI / 2.2) * p;
    const quads: Quad[] = [];
    for (let i = 0; i < N; i++) {
      const alt = i % 2 === 0 ? 1 : -1;
      const centerX = i * sw + sw / 2 - W / 2;
      const compress = -centerX * p * 0.9; // pull panels toward the centre as they fold
      quads.push(
        frameQuad(a, W, H, { x: i * sw, y: 0, w: sw, h: H }, (v) => add(rot(sub(v, [centerX, 0, 0]), 0, alt * ang, 0), [centerX + compress, 0, 0]), {
          shade: 1 - 0.4 * ((i % 2) * 0.5 + 0.25),
        })
      );
    }
    renderQuads(ctx, quads, cam(W, H, this.persp));
  }
}

/** Unfold — B unfolds from edge-on to flat over A (reverse of a fold). */
export class Unfold extends FoldBase {
  private vertical: boolean;
  constructor(from: Clip, to: Clip, params: FoldParams = {}) {
    super("unfold", from, to, params);
    this.vertical = (params.orientation ?? "horizontal") === "vertical";
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    ctx.drawImage(a, 0, 0);
    const W = this.outW, H = this.outH;
    const ang = (Math.PI / 2) * (1 - p);
    const quads: Quad[] = [];
    if (!this.vertical) {
      quads.push(frameQuad(b, W, H, { x: 0, y: 0, w: W, h: H / 2 }, (v) => pr(v, [0, 0, 0], -ang, 0, 0)));
      quads.push(frameQuad(b, W, H, { x: 0, y: H / 2, w: W, h: H / 2 }, (v) => pr(v, [0, 0, 0], ang, 0, 0)));
    } else {
      quads.push(frameQuad(b, W, H, { x: 0, y: 0, w: W / 2, h: H }, (v) => pr(v, [0, 0, 0], 0, ang, 0)));
      quads.push(frameQuad(b, W, H, { x: W / 2, y: 0, w: W / 2, h: H }, (v) => pr(v, [0, 0, 0], 0, -ang, 0)));
    }
    renderQuads(ctx, quads, cam(W, H, this.persp));
  }
}

/** Page Turn — A's page peels off a cylinder from the right edge, revealing B. */
export class PageTurn extends FoldBase {
  protected radiusFrac: number;
  protected columns = 34;
  constructor(from: Clip, to: Clip, params: FoldParams = {}, id = "pageTurn", defRadius = 0.12) {
    super(id, from, to, params);
    this.radiusFrac = Math.max(0.02, params.radius ?? defRadius);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    ctx.drawImage(b, 0, 0);
    const W = this.outW, H = this.outH, M = this.columns;
    const R = this.radiusFrac * W;
    const foldU = 1 - p;
    const xf = foldU * W - W / 2;
    const curl = (u: number): { x: number; z: number; sh: number } => {
      if (u <= foldU) return { x: u * W - W / 2, z: 0, sh: 1 };
      const s = (u - foldU) * W;
      const th = s / R;
      return { x: xf + R * Math.sin(th), z: R * (1 - Math.cos(th)), sh: clamp01(0.45 + 0.55 * Math.cos(th)) };
    };
    const quads: Quad[] = [];
    for (let i = 0; i < M; i++) {
      const u0 = i / M, u1 = (i + 1) / M;
      const L = curl(u0), Rr = curl(u1);
      const corners: [V3, V3, V3, V3] = [
        [L.x, -H / 2, L.z],
        [Rr.x, -H / 2, Rr.z],
        [Rr.x, H / 2, Rr.z],
        [L.x, H / 2, L.z],
      ];
      quads.push({ tex: a, sx: u0 * W, sy: 0, sw: (u1 - u0) * W, sh: H, c: corners, shade: (L.sh + Rr.sh) / 2, shadow: u0 > foldU });
    }
    renderQuads(ctx, quads, cam(W, H, this.persp));
  }
}

/** Page Roll — a tight page turn that rolls the clip up like a scroll. */
export class PageRoll extends PageTurn {
  constructor(from: Clip, to: Clip, params: FoldParams = {}) {
    super(from, to, params, "pageRoll", 0.05);
    this.columns = 48;
  }
}

/** Corner peel (Page Curl / Peel Off / Sticky Peel) — stylised 2D approximation:
 *  reveal B from a corner along a diagonal fold, with a soft gradient curl shadow. */
class CornerPeel extends FoldBase {
  protected corner: "tl" | "tr" | "bl" | "br";
  protected stretch: number;
  constructor(id: string, from: Clip, to: Clip, params: FoldParams, stretch = 0) {
    super(id, from, to, params);
    this.corner = params.corner ?? "br";
    this.stretch = stretch;
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const W = this.outW, H = this.outH;
    // Corner position and leg directions.
    const cxr = this.corner === "tr" || this.corner === "br" ? W : 0;
    const cyr = this.corner === "bl" || this.corner === "br" ? H : 0;
    const sxg = cxr === W ? -1 : 1; // toward interior along x
    const syg = cyr === H ? -1 : 1;
    const lx = 2 * p * W; // leg lengths along each edge
    const ly = 2 * p * H;
    // Fold triangle (revealed area) vertices.
    const vCorner = { x: cxr, y: cyr };
    const vX = { x: clamp(cxr + sxg * lx, 0, W), y: cyr };
    const vY = { x: cxr, y: clamp(cyr + syg * ly, 0, H) };

    ctx.drawImage(a, 0, 0);
    // Reveal B inside the corner triangle.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(vCorner.x, vCorner.y);
    ctx.lineTo(vX.x, vX.y);
    ctx.lineTo(vY.x, vY.y);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(b, 0, 0);
    ctx.restore();
    // Curl shadow along the fold hypotenuse (vX → vY).
    const mx = (vX.x + vY.x) / 2, my = (vX.y + vY.y) / 2;
    const nx = vCorner.x - mx, ny = vCorner.y - my;
    const nl = Math.hypot(nx, ny) || 1;
    const band = 18 + this.stretch * 30;
    const g = ctx.createLinearGradient(mx, my, mx + (nx / nl) * band, my + (ny / nl) * band);
    g.addColorStop(0, "rgba(0,0,0,0.45)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(vCorner.x, vCorner.y);
    ctx.lineTo(vX.x, vX.y);
    ctx.lineTo(vY.x, vY.y);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    // A subtle highlight ridge on the standing clip along the fold.
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(vX.x, vX.y);
    ctx.lineTo(vY.x, vY.y);
    ctx.stroke();
    ctx.restore();
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

export class PageCurl extends CornerPeel {
  constructor(from: Clip, to: Clip, params: FoldParams = {}) {
    super("pageCurl", from, to, params, 0);
  }
}
export class PeelOff extends CornerPeel {
  constructor(from: Clip, to: Clip, params: FoldParams = {}) {
    super("peelOff", from, to, params, 0.4);
  }
}
export class StickyPeel extends CornerPeel {
  constructor(from: Clip, to: Clip, params: FoldParams = {}) {
    super("stickyPeel", from, to, params, 1);
  }
}
