// Category 1 — Opacity & Blend transitions.
//   Fade, CrossDissolve, DipToColor (Black/White/custom), FlashToColor.

import type { BaseParams, Clip, RGBA } from "./types";
import { TransitionEffect, normColor, colorCss } from "./base";
import { clamp01 } from "./easing";

function fill(ctx: CanvasRenderingContext2D, w: number, h: number, css: string, alpha: number) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function draw(ctx: CanvasRenderingContext2D, img: CanvasImageSource, alpha: number) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/** Fade — a straight opacity crossfade: A fades out as B fades in (both at 50% mid). */
export class Fade extends TransitionEffect {
  constructor(from: Clip, to: Clip, params: BaseParams = {}) {
    super("fade", from, to, params);
    this.glMode = 0; // crossfade shader
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    draw(ctx, a, 1 - p);
    draw(ctx, b, p);
  }
}

/** Cross Dissolve — A stays fully opaque while B dissolves in over it (both visible at mid). */
export class CrossDissolve extends TransitionEffect {
  constructor(from: Clip, to: Clip, params: BaseParams = {}) {
    super("crossDissolve", from, to, params);
    this.glMode = 1; // source-over dissolve shader
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    draw(ctx, a, 1);
    draw(ctx, b, p);
  }
}

export interface DipParams extends BaseParams {
  /** The colour to dip through. Default black. */
  color?: RGBA;
}

/**
 * Dip to Color — A fades to a solid colour over the first half, then the colour
 * fades to B over the second half. Presets: Dip to Black / Dip to White; the
 * general form ("Fade to Color") takes any `color`.
 */
export class DipToColor extends TransitionEffect<DipParams> {
  private color: Required<RGBA>;
  constructor(from: Clip, to: Clip, params: DipParams = {}, id = "dipToColor", defaultColor: RGBA = { r: 0, g: 0, b: 0 }) {
    super(id, from, to, params);
    this.color = normColor(params.color, defaultColor);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const css = colorCss(this.color);
    const { width: w, height: h } = this.size;
    if (p < 0.5) {
      const t = p * 2; // A → colour
      draw(ctx, a, 1);
      fill(ctx, w, h, css, t);
    } else {
      const t = (p - 0.5) * 2; // colour → B
      fill(ctx, w, h, css, 1);
      draw(ctx, b, t);
    }
  }
}

export class DipToBlack extends DipToColor {
  constructor(from: Clip, to: Clip, params: DipParams = {}) {
    super(from, to, params, "dipToBlack", { r: 0, g: 0, b: 0 });
  }
}
export class DipToWhite extends DipToColor {
  constructor(from: Clip, to: Clip, params: DipParams = {}) {
    super(from, to, params, "dipToWhite", { r: 255, g: 255, b: 255 });
  }
}
/** "Fade to Color" is Dip to Color with an explicit colour (default black). */
export class FadeToColor extends DipToColor {
  constructor(from: Clip, to: Clip, params: DipParams = {}) {
    super(from, to, params, "fadeToColor", { r: 0, g: 0, b: 0 });
  }
}

export interface FlashParams extends BaseParams {
  /** Flash colour. Default white. */
  color?: RGBA;
  /** Peak flash strength 0..1. Default 1. */
  intensity?: number;
}

/**
 * Flash to Color — a quick bright flash that masks the cut. B replaces A under a
 * colour flash that peaks at the midpoint (sin curve), scaled by `intensity`.
 * Preset: Flash to White.
 */
export class FlashToColor extends TransitionEffect<FlashParams> {
  private color: Required<RGBA>;
  private intensity: number;
  constructor(from: Clip, to: Clip, params: FlashParams = {}, id = "flashToColor", defaultColor: RGBA = { r: 255, g: 255, b: 255 }) {
    super(id, from, to, params);
    this.color = normColor(params.color, defaultColor);
    const i = params.intensity ?? 1;
    this.intensity = clamp01(Number.isFinite(i) ? i : 1);
  }
  protected composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    // Hard cut at the midpoint, hidden under the flash; a touch of crossfade for softness.
    draw(ctx, a, 1 - p);
    draw(ctx, b, p);
    const flash = this.intensity * Math.sin(Math.PI * clamp01(p));
    fill(ctx, this.size.width, this.size.height, colorCss(this.color), flash);
  }
}

export class FlashToWhite extends FlashToColor {
  constructor(from: Clip, to: Clip, params: FlashParams = {}) {
    super(from, to, params, "flashToWhite", { r: 255, g: 255, b: 255 });
  }
}
