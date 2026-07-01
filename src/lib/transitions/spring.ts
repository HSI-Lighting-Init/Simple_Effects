// Spring physics + cubic-bezier easing for transitions (Stage 2).
//
// A spring is integrated numerically from rest (x=0, v=0) toward 1 under the
// given tension/friction/mass, and its time axis is normalised so it settles at
// progress = 1. Low friction overshoots and oscillates (bounce); high friction
// is smooth. Results are cached per parameter set.

export interface SpringParams {
  /** Stiffness (higher = faster, snappier). Default 170. */
  tension?: number;
  /** Damping / bounce control (higher = less bounce). Default 26. */
  friction?: number;
  /** Mass (higher = slower, heavier). Default 1. */
  mass?: number;
}

export type Curve = (t: number) => number;

const cache = new Map<string, Curve>();

/** Build a normalised spring curve `(t:0..1) -> position` (may overshoot 1). */
export function makeSpring(p: SpringParams = {}): Curve {
  const tension = p.tension ?? 170;
  const friction = p.friction ?? 26;
  const mass = p.mass ?? 1;
  const key = `${tension}|${friction}|${mass}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const dt = 1 / 600;
  const maxT = 12;
  const xs: number[] = [0];
  let x = 0;
  let v = 0;
  let t = 0;
  while (t < maxT) {
    const a = (tension * (1 - x) - friction * v) / mass;
    v += a * dt;
    x += v * dt;
    t += dt;
    xs.push(x);
    if (Math.abs(1 - x) < 0.0008 && Math.abs(v) < 0.0008) break;
  }
  const settle = t || dt;
  const last = xs[xs.length - 1];

  const curve: Curve = (u) => {
    if (u <= 0) return 0;
    if (u >= 1) return last;
    const tt = u * settle;
    const i = Math.min(xs.length - 2, Math.floor(tt / dt));
    const frac = (tt - i * dt) / dt;
    return xs[i] + (xs[i + 1] - xs[i]) * frac;
  };
  cache.set(key, curve);
  return curve;
}

/** Cubic-bezier timing `(t) -> y`, like CSS cubic-bezier(x1,y1,x2,y2). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Curve {
  const ax = 3 * x1 - 3 * x2 + 1;
  const bx = 3 * x2 - 6 * x1;
  const cx = 3 * x1;
  const ay = 3 * y1 - 3 * y2 + 1;
  const by = 3 * y2 - 6 * y1;
  const cy = 3 * y1;
  const bx3 = (t: number) => ((ax * t + bx) * t + cx) * t;
  const by3 = (t: number) => ((ay * t + by) * t + cy) * t;
  const dbx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Solve bx3(t) = x for t (Newton, then bisection fallback).
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = bx3(t) - x;
      if (Math.abs(err) < 1e-5) break;
      const d = dbx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    t = Math.min(1, Math.max(0, t));
    return by3(t);
  };
}
