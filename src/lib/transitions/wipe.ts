// Category 3 — Wipe, Reveal & Edge.
//
// Every wipe reveals B over A through an alpha mask; a subclass just paints the
// opaque "B region" for a given eased progress, and softness is applied as a
// blur on the mask edge (so any shape can be feathered). Gradient Wipe builds
// its mask by thresholding a luminance map.

import type { BaseParams, Clip, Direction } from "./types";
import { TransitionEffect, assertDirection, assert } from "./base";
import { clamp01 } from "./easing";
import { maskedCompose, scratch } from "./xform";

export interface WipeParams extends BaseParams {
  /** Edge softness 0..1 (feather width as a fraction of the frame). */
  softness?: number;
}

abstract class WipeBase extends TransitionEffect<WipeParams> {
  protected softness: number;
  constructor(id: string, from: Clip, to: Clip, params: WipeParams, defSoft = 0) {
    super(id, from, to, params);
    const s = params.softness ?? defSoft;
    this.softness = clamp01(Number.isFinite(s) ? s : defSoft);
  }
  protected featherPx(): number {
    return this.softness * 0.3 * Math.min(this.outW, this.outH);
  }
  protected abstract paintMask(m: CanvasRenderingContext2D, w: number, h: number, p: number): void;
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    maskedCompose(ctx, a, b, this.outW, this.outH, (m) => this.paintMask(m, this.outW, this.outH, p), this.featherPx());
  }
}

const DIR_ANGLE: Record<Direction, number> = { right: 0, left: Math.PI, down: Math.PI / 2, up: -Math.PI / 2 };

/** A straight-edge reveal perpendicular to `angle`, growing from one side. */
function linearMask(m: CanvasRenderingContext2D, w: number, h: number, p: number, angle: number) {
  const diag = Math.hypot(w, h);
  m.save();
  m.translate(w / 2, h / 2);
  m.rotate(angle);
  m.fillRect(-diag / 2, -diag / 2, p * diag, diag);
  m.restore();
}

/** Horizontal / Vertical / Edge-feather / Soft wipes (a linear edge). */
export class LinearWipe extends WipeBase {
  private dir: Direction;
  constructor(id: string, from: Clip, to: Clip, params: WipeParams & { direction?: Direction }, defDir: Direction, defSoft = 0) {
    super(id, from, to, params, defSoft);
    this.dir = assertDirection(params.direction ?? defDir);
  }
  protected paintMask(m: CanvasRenderingContext2D, w: number, h: number, p: number) {
    linearMask(m, w, h, p, DIR_ANGLE[this.dir]);
  }
}

export type Corner = "tl" | "tr" | "bl" | "br";

/** Diagonal wipe from a corner to the opposite corner. */
export class DiagonalWipe extends WipeBase {
  private corner: Corner;
  constructor(id: string, from: Clip, to: Clip, params: WipeParams & { corner?: Corner }, defSoft = 0) {
    super(id, from, to, params, defSoft);
    const c = params.corner ?? "tl";
    assert(["tl", "tr", "bl", "br"].includes(c), `corner must be tl|tr|bl|br (got "${c}")`);
    this.corner = c;
  }
  protected paintMask(m: CanvasRenderingContext2D, w: number, h: number, p: number) {
    const ang: Record<Corner, number> = {
      tl: Math.atan2(h, w),
      tr: Math.atan2(h, -w),
      bl: Math.atan2(-h, w),
      br: Math.atan2(-h, -w),
    };
    linearMask(m, w, h, p, ang[this.corner]);
  }
}

export type ShapeMode = "expand" | "contract";

function assertMode(mode: ShapeMode): ShapeMode {
  assert(mode === "expand" || mode === "contract", `mode must be expand|contract (got "${mode}")`);
  return mode;
}

/** Iris — circle expanding from / contracting to the centre. */
export class IrisWipe extends WipeBase {
  private mode: ShapeMode;
  constructor(id: string, from: Clip, to: Clip, params: WipeParams & { mode?: ShapeMode }, defSoft = 0) {
    super(id, from, to, params, defSoft);
    this.mode = assertMode(params.mode ?? "expand");
  }
  protected paintMask(m: CanvasRenderingContext2D, w: number, h: number, p: number) {
    const R = Math.hypot(w, h) / 2;
    const cx = w / 2;
    const cy = h / 2;
    if (this.mode === "contract") {
      m.fillRect(0, 0, w, h);
      m.globalCompositeOperation = "destination-out";
      m.beginPath();
      m.arc(cx, cy, (1 - p) * R, 0, Math.PI * 2);
      m.fill();
      m.globalCompositeOperation = "source-over";
    } else {
      m.beginPath();
      m.arc(cx, cy, p * R, 0, Math.PI * 2);
      m.fill();
    }
  }
}

/** Diamond — diamond (rotated square) opening or closing from the centre. */
export class DiamondWipe extends WipeBase {
  private mode: ShapeMode;
  constructor(id: string, from: Clip, to: Clip, params: WipeParams & { mode?: ShapeMode }, defSoft = 0) {
    super(id, from, to, params, defSoft);
    this.mode = assertMode(params.mode ?? "expand");
  }
  private diamond(m: CanvasRenderingContext2D, cx: number, cy: number, hd: number) {
    m.beginPath();
    m.moveTo(cx, cy - hd);
    m.lineTo(cx + hd, cy);
    m.lineTo(cx, cy + hd);
    m.lineTo(cx - hd, cy);
    m.closePath();
    m.fill();
  }
  protected paintMask(m: CanvasRenderingContext2D, w: number, h: number, p: number) {
    const R = (Math.abs(w) + Math.abs(h)) / 2; // half-diagonal to cover corners
    const cx = w / 2;
    const cy = h / 2;
    if (this.mode === "contract") {
      m.fillRect(0, 0, w, h);
      m.globalCompositeOperation = "destination-out";
      this.diamond(m, cx, cy, (1 - p) * R);
      m.globalCompositeOperation = "source-over";
    } else {
      this.diamond(m, cx, cy, p * R);
    }
  }
}

/** Rectangle / Box — centred rectangle expanding or contracting. */
export class BoxWipe extends WipeBase {
  private mode: ShapeMode;
  constructor(id: string, from: Clip, to: Clip, params: WipeParams & { mode?: ShapeMode }, defSoft = 0) {
    super(id, from, to, params, defSoft);
    this.mode = assertMode(params.mode ?? "expand");
  }
  protected paintMask(m: CanvasRenderingContext2D, w: number, h: number, p: number) {
    const cx = w / 2;
    const cy = h / 2;
    const q = this.mode === "contract" ? 1 - p : p;
    m.fillRect(cx - (q * w) / 2, cy - (q * h) / 2, q * w, q * h);
  }
}

/** Clock — radial sweep like a clock hand, from 12 o'clock. */
export class ClockWipe extends WipeBase {
  private ccw: boolean;
  constructor(id: string, from: Clip, to: Clip, params: WipeParams & { sweep?: "cw" | "ccw" }, defSoft = 0) {
    super(id, from, to, params, defSoft);
    this.ccw = (params.sweep ?? "cw") === "ccw";
  }
  protected paintMask(m: CanvasRenderingContext2D, w: number, h: number, p: number) {
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.hypot(w, h);
    const start = -Math.PI / 2;
    m.beginPath();
    m.moveTo(cx, cy);
    m.arc(cx, cy, R, start, start + (this.ccw ? -1 : 1) * Math.PI * 2 * p, this.ccw);
    m.closePath();
    m.fill();
  }
}

/** Radial — circular radius wipe growing from a chosen corner. */
export class RadialWipe extends WipeBase {
  private corner: Corner;
  constructor(id: string, from: Clip, to: Clip, params: WipeParams & { corner?: Corner }, defSoft = 0) {
    super(id, from, to, params, defSoft);
    const c = params.corner ?? "tl";
    assert(["tl", "tr", "bl", "br"].includes(c), `corner must be tl|tr|bl|br (got "${c}")`);
    this.corner = c;
  }
  protected paintMask(m: CanvasRenderingContext2D, w: number, h: number, p: number) {
    const pos: Record<Corner, [number, number]> = { tl: [0, 0], tr: [w, 0], bl: [0, h], br: [w, h] };
    const [cx, cy] = pos[this.corner];
    m.beginPath();
    m.arc(cx, cy, p * Math.hypot(w, h), 0, Math.PI * 2);
    m.fill();
  }
}

/** Barn Doors — two edges close inward (or open outward). */
export class BarnDoors extends WipeBase {
  private vertical: boolean;
  private open: boolean;
  constructor(
    id: string,
    from: Clip,
    to: Clip,
    params: WipeParams & { orientation?: "horizontal" | "vertical"; mode?: "close" | "open" },
    defSoft = 0
  ) {
    super(id, from, to, params, defSoft);
    this.vertical = (params.orientation ?? "horizontal") === "vertical";
    this.open = (params.mode ?? "close") === "open";
  }
  protected paintMask(m: CanvasRenderingContext2D, w: number, h: number, p: number) {
    if (!this.vertical) {
      const half = (p * w) / 2;
      if (this.open) {
        m.fillRect(w / 2 - half, 0, 2 * half, h); // grow outward from centre
      } else {
        m.fillRect(0, 0, half, h);
        m.fillRect(w - half, 0, half, h);
      }
    } else {
      const half = (p * h) / 2;
      if (this.open) {
        m.fillRect(0, h / 2 - half, w, 2 * half);
      } else {
        m.fillRect(0, 0, w, half);
        m.fillRect(0, h - half, w, half);
      }
    }
  }
}

/**
 * Gradient Wipe — soft-edge wipe driven by a luminance map (any image, default
 * a diagonal gradient). Reveals where map luminance ≤ progress, with `softness`
 * controlling the transition width. (Per-pixel; the heaviest wipe at 1080p.)
 */
export class GradientWipe extends WipeBase {
  private map?: CanvasImageSource;
  private lum?: Float32Array;
  private lumW = 0;
  private lumH = 0;
  constructor(id: string, from: Clip, to: Clip, params: WipeParams & { gradientMap?: CanvasImageSource }, defSoft = 0.15) {
    super(id, from, to, params, defSoft);
    this.map = params.gradientMap;
  }
  protected featherPx(): number {
    return 0; // softness is applied in the threshold, not as an extra blur
  }
  private buildLum(w: number, h: number) {
    const s = scratch("gw-src", w, h);
    const sc = s.getContext("2d")!;
    sc.clearRect(0, 0, w, h);
    if (this.map) {
      sc.drawImage(this.map, 0, 0, w, h);
    } else {
      const g = sc.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, "#000");
      g.addColorStop(1, "#fff");
      sc.fillStyle = g;
      sc.fillRect(0, 0, w, h);
    }
    const d = sc.getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    for (let i = 0; i < lum.length; i++) {
      const j = i * 4;
      lum[i] = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) / 255;
    }
    this.lum = lum;
    this.lumW = w;
    this.lumH = h;
  }
  protected paintMask(m: CanvasRenderingContext2D, w: number, h: number, p: number) {
    if (!this.lum || this.lumW !== w || this.lumH !== h) this.buildLum(w, h);
    const lum = this.lum!;
    const soft = Math.max(0.001, this.softness * 0.5);
    const out = m.createImageData(w, h);
    const data = out.data;
    for (let i = 0; i < lum.length; i++) {
      const a = clamp01((p - lum[i]) / soft + 0.5);
      const j = i * 4;
      data[j] = 255;
      data[j + 1] = 255;
      data[j + 2] = 255;
      data[j + 3] = a * 255;
    }
    m.putImageData(out, 0, 0);
  }
}
