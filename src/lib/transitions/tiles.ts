// Category 7 — Shape, Pattern & Mosaic.
//
// Most are a grid of cells, each revealing B over a stationary A with a per-cell
// delay (ordering) and a per-cell reveal (flip / grow / slide / fade). One
// configurable `PatternTransition` covers them; Mosaic and Vortex are special.

import type { BaseParams, Clip, Direction } from "./types";
import { TransitionEffect } from "./base";
import { clamp01 } from "./easing";
import { scratch } from "./xform";

export interface PatternParams extends BaseParams {
  /** Square grid size (rows = cols). */
  grid?: number;
  rows?: number;
  cols?: number;
  /** Stagger spread 0..1 (0 = all cells together, 1 = fully sequential). */
  spread?: number;
  /** Blinds/bars count. */
  count?: number;
  orientation?: "horizontal" | "vertical";
  direction?: Direction;
  seed?: number;
}

export type PatternKind =
  | "checkerboard"
  | "blinds"
  | "box"
  | "diamond"
  | "randomBars"
  | "strips"
  | "blockDissolve"
  | "spiral"
  | "wheel"
  | "tileFlip";

function hash(i: number, j: number, seed: number): number {
  let h = (i * 374761393 + j * 668265263 + seed * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Draw B's cell sub-rect into its cell, transformed about the cell centre. */
function drawCellB(
  ctx: CanvasRenderingContext2D,
  b: HTMLCanvasElement,
  rect: { x: number; y: number; w: number; h: number },
  o: { sx?: number; sy?: number; tx?: number; ty?: number; alpha?: number; shade?: number }
) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.globalAlpha = clamp01(o.alpha ?? 1);
  ctx.translate(cx + (o.tx ?? 0), cy + (o.ty ?? 0));
  ctx.scale(o.sx ?? 1, o.sy ?? 1);
  ctx.translate(-cx, -cy);
  ctx.drawImage(b, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
  if (o.shade != null && o.shade < 1) {
    ctx.globalAlpha = (1 - o.shade) * clamp01(o.alpha ?? 1);
    ctx.fillStyle = "#000";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  ctx.restore();
}

export class PatternTransition extends TransitionEffect<PatternParams> {
  private kind: PatternKind;
  private rows: number;
  private cols: number;
  private spread: number;
  private orientation: "horizontal" | "vertical";
  private seed: number;
  constructor(id: string, from: Clip, to: Clip, params: PatternParams, kind: PatternKind) {
    super(id, from, to, params);
    this.kind = kind;
    this.orientation = params.orientation ?? "horizontal";
    this.seed = Math.floor(params.seed ?? 1);
    this.spread = clamp01(params.spread ?? (kind === "blinds" || kind === "strips" ? 0 : 0.6));
    const grid = Math.max(2, Math.round(params.grid ?? 8));
    const count = Math.max(2, Math.round(params.count ?? 12));
    if (kind === "blinds" || kind === "randomBars" || kind === "strips") {
      const horiz = this.orientation === "horizontal";
      this.rows = horiz ? count : 1;
      this.cols = horiz ? 1 : count;
    } else {
      this.rows = Math.max(2, Math.round(params.rows ?? grid));
      this.cols = Math.max(2, Math.round(params.cols ?? grid));
    }
  }

  private order(r: number, c: number): number {
    const R = this.rows, C = this.cols;
    switch (this.kind) {
      case "checkerboard":
        return (r + c) & 1 ? 1 : 0;
      case "diamond": {
        const dr = Math.abs(r - (R - 1) / 2), dc = Math.abs(c - (C - 1) / 2);
        return (dr + dc) / ((R + C) / 2);
      }
      case "randomBars":
        return hash(this.orientation === "horizontal" ? r : c, 0, this.seed);
      case "blockDissolve":
        return hash(r, c, this.seed);
      case "tileFlip":
        return hash(r, c, this.seed * 7 + 3);
      case "spiral": {
        // Rank cells along an inward spiral.
        const rank = spiralRank(r, c, R, C);
        return rank / (R * C);
      }
      case "wheel": {
        const ang = Math.atan2(r - (R - 1) / 2, c - (C - 1) / 2) + Math.PI;
        return ang / (Math.PI * 2);
      }
      default:
        return 0; // blinds, box, strips move together
    }
  }

  private cell(ctx: CanvasRenderingContext2D, b: HTMLCanvasElement, rect: { x: number; y: number; w: number; h: number }, lp: number, r: number, c: number) {
    switch (this.kind) {
      case "checkerboard":
      case "tileFlip":
        drawCellB(ctx, b, rect, { sx: lp, shade: 0.45 + 0.55 * lp });
        break;
      case "blinds":
        if (this.orientation === "horizontal") drawCellB(ctx, b, rect, { sy: lp, shade: 0.5 + 0.5 * lp });
        else drawCellB(ctx, b, rect, { sx: lp, shade: 0.5 + 0.5 * lp });
        break;
      case "box":
      case "diamond":
      case "spiral":
      case "wheel":
        drawCellB(ctx, b, rect, { sx: lp, sy: lp });
        break;
      case "blockDissolve":
        drawCellB(ctx, b, rect, { alpha: lp });
        break;
      case "randomBars": {
        const from = (r + c + (this.orientation === "horizontal" ? 0 : 0)) % 2 === 0 ? -1 : 1;
        if (this.orientation === "horizontal") drawCellB(ctx, b, rect, { tx: from * (1 - lp) * rect.w });
        else drawCellB(ctx, b, rect, { ty: from * (1 - lp) * rect.h });
        break;
      }
      case "strips": {
        const alt = (this.orientation === "horizontal" ? r : c) % 2 === 0 ? -1 : 1;
        if (this.orientation === "horizontal") drawCellB(ctx, b, rect, { tx: alt * (1 - lp) * rect.w });
        else drawCellB(ctx, b, rect, { ty: alt * (1 - lp) * rect.h });
        break;
      }
    }
  }

  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    ctx.drawImage(a, 0, 0);
    const cw = this.outW / this.cols;
    const ch = this.outH / this.rows;
    const span = 1 - this.spread || 1e-6;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const lp = clamp01((p - this.order(r, c) * this.spread) / span);
        if (lp <= 0) continue;
        this.cell(ctx, b, { x: Math.floor(c * cw), y: Math.floor(r * ch), w: Math.ceil(cw), h: Math.ceil(ch) }, lp, r, c);
      }
    }
  }
}

/** Rank of a cell along an inward clockwise spiral (0 = outermost start). */
function spiralRank(tr: number, tc: number, R: number, C: number): number {
  let top = 0, bottom = R - 1, left = 0, right = C - 1, rank = 0;
  while (top <= bottom && left <= right) {
    for (let c = left; c <= right; c++) if (top === tr && c === tc) return rank; else rank++;
    top++;
    for (let r = top; r <= bottom; r++) if (r === tr && right === tc) return rank; else rank++;
    right--;
    if (top <= bottom) { for (let c = right; c >= left; c--) if (bottom === tr && c === tc) return rank; else rank++; bottom--; }
    if (left <= right) { for (let r = bottom; r >= top; r--) if (r === tr && left === tc) return rank; else rank++; left++; }
  }
  return rank;
}

/** Mosaic / Pixelate — both frames pixelate into blocks and crossfade. */
export class Mosaic extends TransitionEffect<PatternParams> {
  private maxBlocks: number;
  constructor(from: Clip, to: Clip, params: PatternParams = {}) {
    super("mosaic", from, to, params);
    this.maxBlocks = Math.max(4, Math.round(params.grid ?? 48));
  }
  private pixelate(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, alpha: number, blocks: number) {
    if (alpha <= 0) return;
    const sw = Math.max(1, Math.round(this.outW / blocks));
    const sh = Math.max(1, Math.round(this.outH / blocks));
    const small = scratch("mosaic-small", sw, sh);
    const sc = small.getContext("2d")!;
    sc.clearRect(0, 0, sw, sh);
    sc.drawImage(img, 0, 0, sw, sh);
    ctx.save();
    ctx.globalAlpha = clamp01(alpha);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, sw, sh, 0, 0, this.outW, this.outH);
    ctx.restore();
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const t = Math.sin(Math.PI * p); // 0 → 1 → 0
    const blocks = Math.max(2, Math.round(this.maxBlocks - t * (this.maxBlocks - 3)));
    this.pixelate(ctx, a, 1 - p, blocks);
    this.pixelate(ctx, b, p, blocks);
  }
}

/** Vortex / Swirl — A twists into a spiral and dissolves out; B unwinds in.
 *  Approximated with concentric rings rotated by radius (stylised, not per-pixel). */
export class Vortex extends TransitionEffect<PatternParams & { twist?: number }> {
  private twist: number;
  private rings = 18;
  constructor(from: Clip, to: Clip, params: PatternParams & { twist?: number } = {}) {
    super("vortex", from, to, params);
    this.twist = Number.isFinite(params.twist) ? (params.twist as number) : 6;
  }
  private swirl(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, amount: number, dir: number, alpha: number, scale: number) {
    if (alpha <= 0) return;
    const cx = this.outW / 2, cy = this.outH / 2;
    const maxR = Math.hypot(cx, cy);
    for (let i = 0; i < this.rings; i++) {
      const r0 = (i / this.rings) * maxR;
      const r1 = ((i + 1) / this.rings) * maxR;
      const ang = dir * amount * this.twist * (1 - i / this.rings);
      ctx.save();
      ctx.globalAlpha = clamp01(alpha);
      ctx.beginPath();
      ctx.arc(cx, cy, r1, 0, Math.PI * 2);
      ctx.arc(cx, cy, r0, 0, Math.PI * 2, true);
      ctx.clip("evenodd");
      ctx.translate(cx, cy);
      ctx.rotate(ang);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    }
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    this.swirl(ctx, b, 1 - p, -1, p, 0.6 + 0.4 * p);
    this.swirl(ctx, a, p, 1, 1 - p, 1 - 0.4 * p);
  }
}
