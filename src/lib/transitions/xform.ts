// Low-level drawing helpers shared by Stage-2 transitions.
//
// Performance: transitions re-render every frame, so we reuse a small pool of
// scratch canvases (keyed by name+size) instead of allocating per frame, which
// keeps wipes/zooms smooth at 1080p.

import { clamp01 } from "./easing";

const pool = new Map<string, HTMLCanvasElement>();

/** A reusable offscreen canvas sized to (w,h). Cleared by the caller. */
export function scratch(name: string, w: number, h: number): HTMLCanvasElement {
  let cv = pool.get(name);
  if (!cv) {
    cv = document.createElement("canvas");
    pool.set(name, cv);
  }
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  return cv;
}

export interface XformOpts {
  w: number;
  h: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  /** radians */
  rotate?: number;
  tx?: number;
  ty?: number;
  /** anchor as a fraction of the frame (0..1). Default centre. */
  anchorX?: number;
  anchorY?: number;
  alpha?: number;
}

/** Draw a full-frame image with scale/rotate/translate about an anchor + alpha. */
export function drawXform(ctx: CanvasRenderingContext2D, img: CanvasImageSource, o: XformOpts) {
  const alpha = clamp01(o.alpha ?? 1);
  if (alpha <= 0) return;
  const ax = (o.anchorX ?? 0.5) * o.w;
  const ay = (o.anchorY ?? 0.5) * o.h;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(ax + (o.tx ?? 0), ay + (o.ty ?? 0));
  if (o.rotate) ctx.rotate(o.rotate);
  ctx.scale(o.scaleX ?? o.scale ?? 1, o.scaleY ?? o.scale ?? 1);
  ctx.translate(-ax, -ay);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/** Draw a full-frame image at (0,0) with an alpha. */
export function fadeDraw(ctx: CanvasRenderingContext2D, img: CanvasImageSource, alpha: number) {
  const a = clamp01(alpha);
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/**
 * Reveal `b` over `a` through an alpha mask. `buildMask(mctx)` paints opaque
 * (white) where B should show; `featherPx` blurs the mask edge for softness.
 * Works for any wipe shape.
 */
export function maskedCompose(
  ctx: CanvasRenderingContext2D,
  a: HTMLCanvasElement,
  b: HTMLCanvasElement,
  w: number,
  h: number,
  buildMask: (mctx: CanvasRenderingContext2D) => void,
  featherPx = 0
) {
  const mask = scratch("wipe-mask", w, h);
  const mctx = mask.getContext("2d")!;
  mctx.clearRect(0, 0, w, h);
  mctx.save();
  mctx.fillStyle = "#fff";
  buildMask(mctx);
  mctx.restore();

  const mb = scratch("wipe-b", w, h);
  const mbctx = mb.getContext("2d")!;
  mbctx.clearRect(0, 0, w, h);
  mbctx.drawImage(b, 0, 0);
  mbctx.globalCompositeOperation = "destination-in";
  if (featherPx > 0) mbctx.filter = `blur(${featherPx}px)`;
  mbctx.drawImage(mask, 0, 0);
  mbctx.filter = "none";
  mbctx.globalCompositeOperation = "source-over";

  ctx.drawImage(a, 0, 0);
  ctx.drawImage(mb, 0, 0);
}
