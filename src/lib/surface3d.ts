// Perspective-correct texture painter for the 3D-surface effect.
//
// The Rust evaluator does ALL the geometry — it hands us quads whose corners are
// homogeneous screen coords (screen = hx/hw, hy/hw) already culled and sorted
// back-to-front. Here we just paint: subdivide each quad, and affine-fill each
// little triangle with a slice of the texture. Because we interpolate the
// corners in homogeneous space (then divide), the subdivision is
// perspective-correct, not an affine smear.
//
// `ctx` is a Konva context (proxies the 2D canvas methods). We use `transform`
// (multiply), never `setTransform`, so the layer's own position/scale — applied
// by the enclosing Konva Group — is preserved.

import type { ResolvedSurface } from "../bindings/ResolvedSurface";
import type { SurfaceQuad } from "../bindings/SurfaceQuad";
import type { QuadVertex } from "../bindings/QuadVertex";
import type { Vec2 } from "../bindings/Vec2";

type KCtx = {
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  clip(): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  drawImage(img: CanvasImageSource, dx: number, dy: number): void;
  globalAlpha: number;
};

/** A screen-space point with its texture coordinate, ready to rasterise. */
type SP = { x: number; y: number; u: number; v: number };

/** Linear blend of two quad vertices in homogeneous space (don't divide yet). */
function mix(a: QuadVertex, b: QuadVertex, f: number): QuadVertex {
  return {
    hx: a.hx + (b.hx - a.hx) * f,
    hy: a.hy + (b.hy - a.hy) * f,
    hw: a.hw + (b.hw - a.hw) * f,
    u: a.u + (b.u - a.u) * f,
    v: a.v + (b.v - a.v) * f,
  };
}

/** Bilinear sample of a quad at (s,t), then perspective-divide to screen. */
function sample(q: SurfaceQuad, s: number, t: number): SP {
  const [tl, tr, br, bl] = q.corners;
  const top = mix(tl, tr, s);
  const bot = mix(bl, br, s);
  const m = mix(top, bot, t);
  const w = m.hw || 1e-6;
  return { x: m.hx / w, y: m.hy / w, u: m.u, v: m.v };
}

/** 3x3 determinant. */
function det3(
  a: number, b: number, c: number,
  d: number, e: number, f: number,
  g: number, h: number, i: number
): number {
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

// How far (px, in the drawing's local space) to nudge a clip polygon outward so
// neighbouring pieces overlap and their shared hairline AA seam is covered.
const SEAM_OUTSET = 0.75;

/** Push each polygon vertex out from the centroid by `px` (overlaps neighbours). */
function outsetPoly(pts: { x: number; y: number }[], px: number): { x: number; y: number }[] {
  let gx = 0, gy = 0;
  for (const p of pts) {
    gx += p.x;
    gy += p.y;
  }
  gx /= pts.length;
  gy /= pts.length;
  return pts.map((p) => {
    const dx = p.x - gx, dy = p.y - gy;
    const len = Math.hypot(dx, dy) || 1;
    const k = (len + px) / len;
    return { x: gx + dx * k, y: gy + dy * k };
  });
}

/** Solve the affine map (u,v)→(x,y) from three correspondences (Cramer's rule).
 *  Returns null on a degenerate (zero-area) source triangle. */
function affineFrom3(p0: SP, p1: SP, p2: SP): [number, number, number, number, number, number] | null {
  const u0 = p0.u, v0 = p0.v, u1 = p1.u, v1 = p1.v, u2 = p2.u, v2 = p2.v;
  const denom = det3(u0, v0, 1, u1, v1, 1, u2, v2, 1);
  if (Math.abs(denom) < 1e-6) return null;
  const a = det3(p0.x, v0, 1, p1.x, v1, 1, p2.x, v2, 1) / denom;
  const c = det3(u0, p0.x, 1, u1, p1.x, 1, u2, p2.x, 1) / denom;
  const e = det3(u0, v0, p0.x, u1, v1, p1.x, u2, v2, p2.x) / denom;
  const b = det3(p0.y, v0, 1, p1.y, v1, 1, p2.y, v2, 1) / denom;
  const d = det3(u0, p0.y, 1, u1, p1.y, 1, u2, p2.y, 1) / denom;
  const f = det3(u0, v0, p0.y, u1, v1, p1.y, u2, v2, p2.y) / denom;
  return [a, b, c, d, e, f];
}

/**
 * Affine-fill one textured triangle: clip to it (outset a hair to hide the seam
 * against its neighbour) and draw the image through the solved transform.
 */
function drawTriangle(ctx: KCtx, img: CanvasImageSource, iw: number, ih: number, p0: SP, p1: SP, p2: SP) {
  const s0 = { ...p0, u: p0.u * iw, v: p0.v * ih };
  const s1 = { ...p1, u: p1.u * iw, v: p1.v * ih };
  const s2 = { ...p2, u: p2.u * iw, v: p2.v * ih };
  const m = affineFrom3(s0, s1, s2);
  if (!m) return; // degenerate slice (e.g. cylinder cap centre / zero-area cell)
  const poly = outsetPoly([p0, p1, p2], SEAM_OUTSET);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  ctx.lineTo(poly[1].x, poly[1].y);
  ctx.lineTo(poly[2].x, poly[2].y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/** True when a quad is a flat (no-perspective) parallelogram — it can be filled
 *  with a single affine draw, so there are no internal triangle seams. */
function isFlatParallelogram(q: SurfaceQuad): boolean {
  const c = q.corners;
  if (c.length !== 4) return false;
  // No perspective: every corner shares (near enough) the same homogeneous w.
  const w0 = c[0].hw || 1;
  for (const v of c) {
    if (Math.abs((v.hw || 1) - w0) > 1e-4 * Math.max(1, Math.abs(w0))) return false;
  }
  // Screen-space parallelogram: TL + BR == TR + BL.
  const p = c.map((v) => ({ x: v.hx / (v.hw || 1), y: v.hy / (v.hw || 1) }));
  const tol = 0.5;
  return (
    Math.abs(p[0].x + p[2].x - (p[1].x + p[3].x)) < tol &&
    Math.abs(p[0].y + p[2].y - (p[1].y + p[3].y)) < tol
  );
}

/** Fill a flat parallelogram quad with ONE affine draw (no subdivision, so no
 *  internal diagonal seams). Clip is outset a hair so adjacent cells overlap. */
function drawFlatQuad(ctx: KCtx, img: CanvasImageSource, iw: number, ih: number, q: SurfaceQuad) {
  const P: SP[] = q.corners.map((v) => ({
    x: v.hx / (v.hw || 1),
    y: v.hy / (v.hw || 1),
    u: v.u * iw,
    v: v.v * ih,
  }));
  // Solve from TL, TR, BL (indices 0,1,3) — a parallelogram's basis.
  const m = affineFrom3(P[0], P[1], P[3]);
  if (!m) return;
  const poly = outsetPoly(P, SEAM_OUTSET);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/** Paint one quad: subdivide into a grid and fill two triangles per cell. Flat
 *  (unwarped, non-perspective) quads take a single-draw fast path that has no
 *  internal seams — this is what kills the diagonal "grid lines" on flat grids. */
function drawQuad(ctx: KCtx, img: CanvasImageSource, iw: number, ih: number, q: SurfaceQuad, baseAlpha: number) {
  const alpha = baseAlpha * q.opacity;
  if (alpha <= 0) return;
  ctx.save();
  // Compose with whatever alpha the enclosing Group already set (layer opacity).
  ctx.globalAlpha = alpha;
  if (isFlatParallelogram(q)) {
    drawFlatQuad(ctx, img, iw, ih, q);
    ctx.restore();
    return;
  }
  const n = Math.max(1, Math.min(16, q.subdiv | 0));
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const s0 = i / n, s1 = (i + 1) / n;
      const t0 = j / n, t1 = (j + 1) / n;
      const a = sample(q, s0, t0);
      const b = sample(q, s1, t0);
      const c = sample(q, s1, t1);
      const d = sample(q, s0, t1);
      drawTriangle(ctx, img, iw, ih, a, b, c);
      drawTriangle(ctx, img, iw, ih, a, c, d);
    }
  }
  ctx.restore();
}

/**
 * Paint a whole resolved surface. `img` is the source texture; quads already
 * carry their UVs into it. `layerOpacity` lets per-face opacity stack under the
 * layer opacity (which the Group applies separately, so pass 1 there).
 */
/** A texture source: a loaded image or an offscreen canvas (rasterised text). */
export type Texture = HTMLImageElement | HTMLCanvasElement;

export function drawSurface(
  ctx: KCtx,
  img: Texture,
  surface: ResolvedSurface,
  layerOpacity = 1
) {
  const iw = img instanceof HTMLImageElement ? img.naturalWidth || img.width : img.width;
  const ih = img instanceof HTMLImageElement ? img.naturalHeight || img.height : img.height;
  if (!iw || !ih) return;
  // The Group already set globalAlpha for the layer opacity; multiply into it
  // rather than clobbering it.
  const base = (typeof ctx.globalAlpha === "number" ? ctx.globalAlpha : 1) * layerOpacity;
  for (const q of surface.quads) drawQuad(ctx, img, iw, ih, q, base);
}

/**
 * Paint a single textured quad (used by the multi-frame grid, where each cell is
 * one quad with its own image). Mirrors `drawSurface` but for a lone quad, and
 * multiplies into whatever alpha the enclosing Group already set.
 */
export function drawTexturedQuad(ctx: KCtx, img: Texture, quad: SurfaceQuad, alpha = 1) {
  const iw = img instanceof HTMLImageElement ? img.naturalWidth || img.width : img.width;
  const ih = img instanceof HTMLImageElement ? img.naturalHeight || img.height : img.height;
  if (!iw || !ih) return;
  const base = (typeof ctx.globalAlpha === "number" ? ctx.globalAlpha : 1) * alpha;
  drawQuad(ctx, img, iw, ih, quad, base);
}

/**
 * Inverse-map a comp-space point onto `(u, v)` of a projected face quad
 * (perspective-correct). `quad` is the face rectangle in UV order
 * `[TL(0,0), TR(1,0), BR(1,1), BL(0,1)]`. Returns null on a degenerate quad.
 * Used to turn a canvas drag of a decal into its placement on the face.
 */
export function mapScreenToUV(quad: Vec2[], qx: number, qy: number): { u: number; v: number } | null {
  if (quad.length !== 4) return null;
  const m = squareToQuad(quad);
  if (!m) return null;
  const inv = invert3(m);
  if (!inv) return null;
  const u = inv[0] * qx + inv[1] * qy + inv[2];
  const v = inv[3] * qx + inv[4] * qy + inv[5];
  const w = inv[6] * qx + inv[7] * qy + inv[8];
  if (Math.abs(w) < 1e-9) return null;
  return { u: u / w, v: v / w };
}

/** Heckbert unit-square → quad homography (row-major 3x3). */
function squareToQuad(q: Vec2[]): number[] | null {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  let a: number, b: number, d: number, e: number, g: number, h: number;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    a = p1.x - p0.x; b = p2.x - p1.x;
    d = p1.y - p0.y; e = p2.y - p1.y;
    g = 0; h = 0;
  } else {
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-9) return null;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
    a = p1.x - p0.x + g * p1.x;
    b = p3.x - p0.x + h * p3.x;
    d = p1.y - p0.y + g * p1.y;
    e = p3.y - p0.y + h * p3.y;
  }
  return [a, b, p0.x, d, e, p0.y, g, h, 1];
}

/** Inverse of a row-major 3x3 (null if singular). */
function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return [
    A * id, (c * h - b * i) * id, (b * f - c * e) * id,
    B * id, (a * i - c * g) * id, (c * d - a * f) * id,
    C * id, (b * g - a * h) * id, (a * e - b * d) * id,
  ];
}

/** Screen-space bounding box of all quad corners (for hit-testing). */
export function surfaceBBox(surface: ResolvedSurface) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of surface.quads) {
    for (const c of q.corners) {
      const w = c.hw || 1e-6;
      const x = c.hx / w, y = c.hy / w;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minX)) return { x: -1, y: -1, width: 2, height: 2 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
