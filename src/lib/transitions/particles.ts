// Particle-system framework for Stage-4 disintegration transitions.
//
// A structure-of-arrays (Float32/Uint8 typed arrays) particle pool with a
// configurable force field (gravity, wind, turbulence, drag) integrated with
// semi-implicit Euler. Deterministic when seeded. The point renderer draws
// dots/squares/sparks; textured "cell" transitions (shatter, dissolve) reuse
// `stepBody` for their fragment physics.
//
// Scale note: the pool is designed for ~10k point particles at 1080p. Canvas-2D
// fill is the bottleneck at that count; a WebGL point-sprite renderer is the
// intended path for a true 10k+/60fps budget and is left as a follow-up.

import { mulberry32, valueNoise2D } from "./rng";
import { clamp01 } from "./easing";

export interface Forces {
  /** Constant downward accel (px/s²). */
  gravityX?: number;
  gravityY?: number;
  /** Constant lateral accel (px/s²), e.g. wind for sandstorm. */
  windX?: number;
  windY?: number;
  /** Curl/turbulence acceleration amplitude (px/s²). */
  turbulence?: number;
  /** Spatial frequency of the turbulence field. */
  turbScale?: number;
  /** Velocity damping per second (0 = none, 1 = strong). */
  drag?: number;
  /** Seed for the (spatial) turbulence field. */
  seed?: number;
}

export interface SpawnSpec {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  ttl?: number; // seconds; <=0 means "never expires"
  size?: number;
  rot?: number;
  vrot?: number;
  r?: number;
  g?: number;
  b?: number;
}

export type ParticleDrawMode = "dot" | "square" | "spark";

/** Integrate a single body one step under `forces`. Mutates the passed object. */
export function stepBody(b: { x: number; y: number; vx: number; vy: number }, f: Forces, dt: number) {
  const seed = f.seed ?? 1;
  if (f.turbulence) {
    const sc = f.turbScale ?? 0.004;
    const ang = valueNoise2D(b.x * sc, b.y * sc, seed) * Math.PI * 4;
    b.vx += Math.cos(ang) * f.turbulence * dt;
    b.vy += Math.sin(ang) * f.turbulence * dt;
  }
  b.vx += (f.windX ?? 0) * dt + (f.gravityX ?? 0) * dt;
  b.vy += (f.windY ?? 0) * dt + (f.gravityY ?? 0) * dt;
  if (f.drag) {
    const k = Math.max(0, 1 - f.drag * dt);
    b.vx *= k;
    b.vy *= k;
  }
  b.x += b.vx * dt;
  b.y += b.vy * dt;
}

export class ParticleSystem {
  readonly capacity: number;
  count = 0;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly life: Float32Array; // elapsed seconds
  readonly ttl: Float32Array; // total lifetime seconds (<=0 = immortal)
  readonly size: Float32Array;
  readonly rot: Float32Array;
  readonly vrot: Float32Array;
  readonly r: Uint8Array;
  readonly g: Uint8Array;
  readonly b: Uint8Array;
  forces: Forces;

  constructor(capacity: number, forces: Forces = {}, seed = 1) {
    this.capacity = Math.max(1, Math.floor(capacity));
    const n = this.capacity;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.life = new Float32Array(n);
    this.ttl = new Float32Array(n);
    this.size = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.vrot = new Float32Array(n);
    this.r = new Uint8Array(n);
    this.g = new Uint8Array(n);
    this.b = new Uint8Array(n);
    this.forces = { seed, ...forces };
  }

  reset() {
    this.count = 0;
  }

  spawn(s: SpawnSpec): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.x[i] = s.x;
    this.y[i] = s.y;
    this.vx[i] = s.vx ?? 0;
    this.vy[i] = s.vy ?? 0;
    this.life[i] = 0;
    this.ttl[i] = s.ttl ?? 0;
    this.size[i] = s.size ?? 2;
    this.rot[i] = s.rot ?? 0;
    this.vrot[i] = s.vrot ?? 0;
    this.r[i] = s.r ?? 255;
    this.g[i] = s.g ?? 255;
    this.b[i] = s.b ?? 255;
    return i;
  }

  /** Advance every live particle by dt seconds. Immortal particles never die. */
  update(dt: number) {
    const f = this.forces;
    const seed = f.seed ?? 1;
    const sc = f.turbScale ?? 0.004;
    const turb = f.turbulence ?? 0;
    const wx = (f.windX ?? 0) + (f.gravityX ?? 0);
    const wy = (f.windY ?? 0) + (f.gravityY ?? 0);
    const drag = f.drag ?? 0;
    const k = drag ? Math.max(0, 1 - drag * dt) : 1;
    for (let i = 0; i < this.count; i++) {
      let vx = this.vx[i], vy = this.vy[i];
      if (turb) {
        const ang = valueNoise2D(this.x[i] * sc, this.y[i] * sc, seed) * Math.PI * 4;
        vx += Math.cos(ang) * turb * dt;
        vy += Math.sin(ang) * turb * dt;
      }
      vx = (vx + wx * dt) * k;
      vy = (vy + wy * dt) * k;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.x[i] += vx * dt;
      this.y[i] += vy * dt;
      this.rot[i] += this.vrot[i] * dt;
      this.life[i] += dt;
    }
  }

  /** Fraction of life remaining for particle i (1 → fresh, 0 → expired). */
  fade(i: number): number {
    if (this.ttl[i] <= 0) return 1;
    return clamp01(1 - this.life[i] / this.ttl[i]);
  }

  /** Draw all particles. `alphaFade` ties opacity to remaining life. */
  draw(ctx: CanvasRenderingContext2D, mode: ParticleDrawMode = "dot", alphaFade = true) {
    ctx.save();
    for (let i = 0; i < this.count; i++) {
      const a = alphaFade ? this.fade(i) : 1;
      if (a <= 0) continue;
      const s = this.size[i];
      ctx.globalAlpha = a;
      ctx.fillStyle = `rgb(${this.r[i]},${this.g[i]},${this.b[i]})`;
      if (mode === "square") {
        ctx.fillRect(this.x[i] - s / 2, this.y[i] - s / 2, s, s);
      } else if (mode === "spark") {
        ctx.beginPath();
        ctx.arc(this.x[i], this.y[i], s, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = a * 0.4;
        ctx.beginPath();
        ctx.arc(this.x[i], this.y[i], s * 2.2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(this.x[i], this.y[i], s, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** A seeded RNG bound to this system, for callers that need jitter. */
  static rng(seed: number) {
    return mulberry32(seed);
  }
}
