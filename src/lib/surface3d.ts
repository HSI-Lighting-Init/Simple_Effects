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

/**
 * Affine-fill one textured triangle. Solves the affine map (u,v)→(x,y) from the
 * three correspondences (Cramer's rule), clips to the triangle, and draws the
 * image through that transform. The triangle is nudged outward a hair to hide
 * the hairline seams between neighbours.
 */
function drawTriangle(ctx: KCtx, img: CanvasImageSource, iw: number, ih: number, p0: SP, p1: SP, p2: SP) {
  const u0 = p0.u * iw, v0 = p0.v * ih;
  const u1 = p1.u * iw, v1 = p1.v * ih;
  const u2 = p2.u * iw, v2 = p2.v * ih;

  // Source-triangle determinant; skip degenerate slices (e.g. cylinder cap
  // centre triangles, or zero-area cells).
  const denom = det3(u0, v0, 1, u1, v1, 1, u2, v2, 1);
  if (Math.abs(denom) < 1e-6) return;

  // x = a*u + c*v + e  (Cramer), and likewise y = b*u + d*v + f.
  const a = det3(p0.x, v0, 1, p1.x, v1, 1, p2.x, v2, 1) / denom;
  const c = det3(u0, p0.x, 1, u1, p1.x, 1, u2, p2.x, 1) / denom;
  const e = det3(u0, v0, p0.x, u1, v1, p1.x, u2, v2, p2.x) / denom;
  const b = det3(p0.y, v0, 1, p1.y, v1, 1, p2.y, v2, 1) / denom;
  const d = det3(u0, p0.y, 1, u1, p1.y, 1, u2, p2.y, 1) / denom;
  const f = det3(u0, v0, p0.y, u1, v1, p1.y, u2, v2, p2.y) / denom;

  // Outset the clip triangle ~0.4px around its centroid to overlap neighbours.
  const gx = (p0.x + p1.x + p2.x) / 3;
  const gy = (p0.y + p1.y + p2.y) / 3;
  const out = (x: number, y: number): [number, number] => {
    const dx = x - gx, dy = y - gy;
    const len = Math.hypot(dx, dy) || 1;
    const k = (len + 0.4) / len;
    return [gx + dx * k, gy + dy * k];
  };
  const [x0, y0] = out(p0.x, p0.y);
  const [x1, y1] = out(p1.x, p1.y);
  const [x2, y2] = out(p2.x, p2.y);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/** Paint one quad: subdivide into a grid and fill two triangles per cell. */
function drawQuad(ctx: KCtx, img: CanvasImageSource, iw: number, ih: number, q: SurfaceQuad, baseAlpha: number) {
  const n = Math.max(1, Math.min(16, q.subdiv | 0));
  const alpha = baseAlpha * q.opacity;
  if (alpha <= 0) return;
  ctx.save();
  // Compose with whatever alpha the enclosing Group already set (layer opacity).
  ctx.globalAlpha = alpha;
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
export function drawSurface(
  ctx: KCtx,
  img: HTMLImageElement,
  surface: ResolvedSurface,
  layerOpacity = 1
) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  // The Group already set globalAlpha for the layer opacity; multiply into it
  // rather than clobbering it.
  const base = (typeof ctx.globalAlpha === "number" ? ctx.globalAlpha : 1) * layerOpacity;
  for (const q of surface.quads) drawQuad(ctx, img, iw, ih, q, base);
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
