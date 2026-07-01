// A small software 3D pipeline on 2D canvas, for Stage-3 transitions.
//
// Transitions build a list of textured Quads (planar, 4 corners in a local 3D
// space centred at the frame origin), and `renderQuads` projects them through a
// simple perspective camera, sorts back-to-front (painter's algorithm), shades
// each by its surface normal (Lambert) for lighting, and draws the texture
// warped onto the projected quad via two affine-mapped triangles. Optional drop
// shadows are projected silhouettes.

export type V3 = [number, number, number];

/** Rotate a point about the X, then Y, then Z axes (radians). */
export function rot(p: V3, rx: number, ry: number, rz: number): V3 {
  let [x, y, z] = p;
  if (rx) {
    const c = Math.cos(rx), s = Math.sin(rx);
    const yy = y * c - z * s, zz = y * s + z * c;
    y = yy; z = zz;
  }
  if (ry) {
    const c = Math.cos(ry), s = Math.sin(ry);
    const xx = x * c + z * s, zz = -x * s + z * c;
    x = xx; z = zz;
  }
  if (rz) {
    const c = Math.cos(rz), s = Math.sin(rz);
    const xx = x * c - y * s, yy = x * s + y * c;
    x = xx; y = yy;
  }
  return [x, y, z];
}

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export interface Camera {
  w: number;
  h: number;
  /** Camera distance from the z=0 plane; larger = weaker perspective. */
  dist: number;
}

interface P2 {
  x: number;
  y: number;
  z: number;
}
function project(p: V3, cam: Camera): P2 {
  const denom = cam.dist - p[2];
  const f = cam.dist / (Math.abs(denom) < 1e-3 ? 1e-3 : denom);
  return { x: cam.w / 2 + p[0] * f, y: cam.h / 2 + p[1] * f, z: p[2] };
}

export interface Quad {
  tex: CanvasImageSource;
  /** Source rect in the texture. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** World corners TL, TR, BR, BL (local, centred at origin). */
  c: [V3, V3, V3, V3];
  /** Extra brightness multiplier 0..1 (e.g. dim a back/curled face). */
  shade?: number;
  /** Draw a projected drop shadow beneath this quad. */
  shadow?: boolean;
}

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
function faceNormal(c: V3[]): V3 {
  const ux = c[1][0] - c[0][0], uy = c[1][1] - c[0][1], uz = c[1][2] - c[0][2];
  const vx = c[3][0] - c[0][0], vy = c[3][1] - c[0][1], vz = c[3][2] - c[0][2];
  return norm([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
}
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Map a source triangle onto a destination triangle (affine) with clipping. */
function drawTexTri(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  u0: number, v0: number, u1: number, v1: number, u2: number, v2: number,
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number
) {
  const det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
  if (Math.abs(det) < 1e-6) return;
  const a = ((x1 - x0) * (v2 - v0) - (x2 - x0) * (v1 - v0)) / det;
  const c = ((x2 - x0) * (u1 - u0) - (x1 - x0) * (u2 - u0)) / det;
  const e = x0 - a * u0 - c * v0;
  const b = ((y1 - y0) * (v2 - v0) - (y2 - y0) * (v1 - v0)) / det;
  const d = ((y2 - y0) * (u1 - u0) - (y1 - y0) * (u2 - u0)) / det;
  const f = y0 - b * u0 - d * v0;
  ctx.save();
  ctx.beginPath();
  // Expand the triangle a hair to hide seams between the two halves.
  const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3;
  const ex = (x: number, y: number) => {
    const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1;
    return [x + (dx / l) * 0.6, y + (dy / l) * 0.6] as const;
  };
  const p0 = ex(x0, y0), p1 = ex(x1, y1), p2 = ex(x2, y2);
  ctx.moveTo(p0[0], p0[1]);
  ctx.lineTo(p1[0], p1[1]);
  ctx.lineTo(p2[0], p2[1]);
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function drawTexQuad(ctx: CanvasRenderingContext2D, q: Quad, P: P2[]) {
  const { sx, sy, sw, sh, tex } = q;
  drawTexTri(ctx, tex, sx, sy, sx + sw, sy, sx + sw, sy + sh, P[0].x, P[0].y, P[1].x, P[1].y, P[2].x, P[2].y);
  drawTexTri(ctx, tex, sx, sy, sx + sw, sy + sh, sx, sy + sh, P[0].x, P[0].y, P[2].x, P[2].y, P[3].x, P[3].y);
}

export interface RenderOpts {
  light?: V3;
  /** Ambient floor for lighting (0..1). Default 0.4. */
  ambient?: number;
}

/** Project, depth-sort, shade and draw all quads into `ctx`. */
export function renderQuads(ctx: CanvasRenderingContext2D, quads: Quad[], cam: Camera, opts: RenderOpts = {}) {
  const light = norm(opts.light ?? [0.3, -0.4, 1]);
  const ambient = opts.ambient ?? 0.4;
  const items = quads.map((q) => {
    const P = q.c.map((v) => project(v, cam));
    const avgZ = (q.c[0][2] + q.c[1][2] + q.c[2][2] + q.c[3][2]) / 4;
    return { q, P, avgZ };
  });
  items.sort((m, n) => m.avgZ - n.avgZ); // far first
  for (const it of items) {
    const { q, P } = it;
    if (q.shadow) {
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.moveTo(P[0].x + 8, P[0].y + 10);
      ctx.lineTo(P[1].x + 8, P[1].y + 10);
      ctx.lineTo(P[2].x + 8, P[2].y + 10);
      ctx.lineTo(P[3].x + 8, P[3].y + 10);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    drawTexQuad(ctx, q, P);
    const n = faceNormal(q.c);
    const lambert = ambient + (1 - ambient) * Math.max(0, Math.abs(dot(n, light)));
    const shade = Math.min(1, Math.max(0, lambert * (q.shade ?? 1)));
    if (shade < 0.999) {
      ctx.save();
      ctx.globalAlpha = 1 - shade;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.moveTo(P[0].x, P[0].y);
      ctx.lineTo(P[1].x, P[1].y);
      ctx.lineTo(P[2].x, P[2].y);
      ctx.lineTo(P[3].x, P[3].y);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
}

/** Build a quad for a sub-rectangle of a frame, transformed by `xform`. `rect`
 *  is in pixels (0..w, 0..h); corners are placed in a centred local space. */
export function frameQuad(
  tex: CanvasImageSource,
  w: number,
  h: number,
  rect: { x: number; y: number; w: number; h: number },
  xform: (localCorner: V3) => V3,
  extra: Partial<Quad> = {}
): Quad {
  const l = rect.x - w / 2;
  const r = rect.x + rect.w - w / 2;
  const t = rect.y - h / 2;
  const bo = rect.y + rect.h - h / 2;
  const corners: [V3, V3, V3, V3] = [
    xform([l, t, 0]),
    xform([r, t, 0]),
    xform([r, bo, 0]),
    xform([l, bo, 0]),
  ];
  return { tex, sx: rect.x, sy: rect.y, sw: rect.w, sh: rect.h, c: corners, ...extra };
}
