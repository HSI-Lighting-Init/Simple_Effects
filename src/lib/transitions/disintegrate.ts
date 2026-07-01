// Category 9 — Particles, Disintegration & Elements (Stage 4).
//
// Two mechanisms share this file:
//  1. CellFly — divides clip A into a grid of textured cells and flies each away
//     with a closed-form ballistic path (position = v·t + ½·a·t²). Closed-form so
//     it is frame-independent (scrubbable) and deterministic from a seed. Powers
//     dissolve / explosion / sandstorm / shatter / crumble / low-poly / leaves.
//  2. ParticleSystem (particles.ts) point particles for the "element" looks —
//     bubbles, magic dust, smoke, embers, constellation — re-simulated from the
//     seed each render so scrubbing stays deterministic.
//
// Photoreal fire/smoke/glass fracture are approximated with these primitives and
// documented as stylised; a Voronoi shatter and GPU point-sprite path (for the
// 10k+/60fps budget) are the intended follow-ups.

import { TransitionEffect } from "./base";
import type { BaseParams } from "./types";
import { scratch } from "./xform";
import { clamp01 } from "./easing";
import { hash2, mulberry32 } from "./rng";
import { ParticleSystem } from "./particles";

export interface DisParams extends BaseParams {
  seed?: number;
  density?: number; // grid resolution / particle count driver
  gravity?: number;
  wind?: number;
  direction?: "left" | "right" | "up" | "down";
}

type Spread = "radial" | "directional" | "random" | "down";

interface CellConfig {
  grid: number;
  speed: number; // base velocity (frame-fractions at t=1)
  gravity: number; // accel down (frame-fractions/t²)
  wind: number; // accel sideways
  spread: Spread;
  dir: { x: number; y: number };
  spin: number;
  stagger: number; // 0..1 per-cell start delay spread
  fade: number; // opacity fade rate
  scaleAway: boolean;
  rowStagger?: "top" | "bottom" | null; // crumble-style ordering
}

export abstract class Disintegrate<P extends DisParams = DisParams> extends TransitionEffect<P> {
  protected seed(): number {
    const s = this.params.seed;
    return Math.max(1, Math.floor(typeof s === "number" ? s : 1));
  }
  protected density(): number {
    const d = this.params.density;
    return typeof d === "number" ? d : 0;
  }

  // Cached small colour grid sampled from A, for point-particle colours.
  private _colors?: { gw: number; gh: number; data: Uint8ClampedArray };
  protected sampleColors(gw: number, gh: number): { gw: number; gh: number; data: Uint8ClampedArray } {
    if (this._colors && this._colors.gw === gw && this._colors.gh === gh) return this._colors;
    const c = scratch("dis-sample", gw, gh);
    const cx = c.getContext("2d");
    let data = new Uint8ClampedArray(gw * gh * 4).fill(255);
    if (cx) {
      cx.clearRect(0, 0, gw, gh);
      cx.drawImage(this.frameA, 0, 0, gw, gh);
      try {
        data = cx.getImageData(0, 0, gw, gh).data;
      } catch {
        /* tainted / unavailable — keep white fallback */
      }
    }
    this._colors = { gw, gh, data };
    return this._colors;
  }

  /** Fly grid cells of A away over B. Shared by most disintegration looks. */
  protected flyCells(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number, cfg: CellConfig) {
    const w = this.outW, h = this.outH;
    const seed = this.seed();
    ctx.drawImage(b, 0, 0);
    const g = cfg.grid;
    const cw = w / g, ch = h / g;
    for (let j = 0; j < g; j++) {
      for (let i = 0; i < g; i++) {
        let delay = hash2(i, j, seed) * cfg.stagger;
        if (cfg.rowStagger === "top") delay = (j / g) * cfg.stagger + hash2(i, j, seed) * 0.1;
        else if (cfg.rowStagger === "bottom") delay = (1 - j / g) * cfg.stagger + hash2(i, j, seed) * 0.1;
        const denom = 1 - delay || 1;
        const tt = clamp01((p - delay) / denom);
        const cx = i * cw + cw / 2;
        const cy = j * ch + ch / 2;
        if (tt <= 0) {
          ctx.drawImage(a, i * cw, j * ch, cw, ch, i * cw, j * ch, cw, ch);
          continue;
        }
        const alpha = clamp01(1 - tt * cfg.fade);
        if (alpha <= 0) continue;
        // initial velocity by spread mode
        let vx = 0, vy = 0;
        const jit = hash2(i, j, seed + 3) - 0.5;
        const jit2 = hash2(i, j, seed + 7) - 0.5;
        if (cfg.spread === "radial") {
          let nx = (i + 0.5) / g - 0.5, ny = (j + 0.5) / g - 0.5;
          const l = Math.hypot(nx, ny) || 1;
          vx = (nx / l) * cfg.speed * (0.6 + hash2(i, j, seed + 1) * 0.8);
          vy = (ny / l) * cfg.speed * (0.6 + hash2(i, j, seed + 1) * 0.8);
        } else if (cfg.spread === "directional") {
          vx = cfg.dir.x * cfg.speed + jit * cfg.speed * 0.4;
          vy = cfg.dir.y * cfg.speed + jit2 * cfg.speed * 0.4;
        } else if (cfg.spread === "down") {
          vx = jit * cfg.speed * 0.5;
          vy = Math.abs(jit2) * cfg.speed * 0.4;
        } else {
          const ang = hash2(i, j, seed + 5) * Math.PI * 2;
          vx = Math.cos(ang) * cfg.speed;
          vy = Math.sin(ang) * cfg.speed;
        }
        const T = tt;
        const dx = (vx * T + 0.5 * cfg.wind * T * T) * w;
        const dy = (vy * T + 0.5 * cfg.gravity * T * T) * h;
        const rot = jit * cfg.spin * T;
        const scale = cfg.scaleAway ? 1 - 0.6 * T : 1;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(cx + dx, cy + dy);
        if (rot) ctx.rotate(rot);
        if (scale !== 1) ctx.scale(scale, scale);
        ctx.drawImage(a, i * cw, j * ch, cw, ch, -cw / 2 - 1, -ch / 2 - 1, cw + 2, ch + 2);
        ctx.restore();
      }
    }
  }
}

const dirVec = (d?: string) => {
  switch (d) {
    case "left": return { x: -1, y: 0 };
    case "right": return { x: 1, y: 0 };
    case "up": return { x: 0, y: -1 };
    default: return { x: 0, y: 1 };
  }
};

/** Particle Dissolve: A breaks into fine cells that drift/blow away. */
export class ParticleDissolve extends Disintegrate {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const grid = Math.max(6, Math.round(this.density() || 28));
    this.flyCells(ctx, a, b, p, {
      grid, speed: 0.15, gravity: 0.3, wind: (this.params.wind as number) ?? 0.1,
      spread: "random", dir: { x: 0, y: 0 }, spin: 1, stagger: 0.5, fade: 1.4, scaleAway: true,
    });
  }
}

/** Shatter / Glass: A cracks into shards that spin outward (stylised fracture). */
export class Shatter extends Disintegrate {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const grid = Math.max(5, Math.round(this.density() || 10));
    this.flyCells(ctx, a, b, p, {
      grid, speed: 0.4, gravity: 0.9, wind: 0, spread: "radial",
      dir: { x: 0, y: 0 }, spin: 3, stagger: 0.15, fade: 0.8, scaleAway: false,
    });
  }
}

/** Explosion: A blasts outward from the centre, revealing B. */
export class Explosion extends Disintegrate {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const grid = Math.max(8, Math.round(this.density() || 18));
    this.flyCells(ctx, a, b, p, {
      grid, speed: 0.9, gravity: 0.7, wind: 0, spread: "radial",
      dir: { x: 0, y: 0 }, spin: 4, stagger: 0.05, fade: 1.1, scaleAway: false,
    });
    // central flash
    if (p < 0.35) {
      const g = 1 - p / 0.35;
      const grd = ctx.createRadialGradient(this.outW / 2, this.outH / 2, 0, this.outW / 2, this.outH / 2, this.outW * 0.4);
      grd.addColorStop(0, `rgba(255,240,200,${0.7 * g})`);
      grd.addColorStop(1, "rgba(255,200,120,0)");
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, this.outW, this.outH);
      ctx.restore();
    }
  }
}

/** Sandstorm: A disintegrates and streaks off in a wind direction. */
export class Sandstorm extends Disintegrate {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const grid = Math.max(10, Math.round(this.density() || 30));
    const dir = dirVec((this.params.direction as string) ?? "right");
    this.flyCells(ctx, a, b, p, {
      grid, speed: 1.1, gravity: 0.05, wind: dir.x * 1.2, spread: "directional",
      dir, spin: 0.5, stagger: 0.6, fade: 1.6, scaleAway: true,
    });
  }
}

/** Leaves / Confetti: A scatters as tumbling coloured flakes. */
export class Confetti extends Disintegrate {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const grid = Math.max(10, Math.round(this.density() || 22));
    this.flyCells(ctx, a, b, p, {
      grid, speed: 0.3, gravity: 0.8, wind: 0.15, spread: "down",
      dir: { x: 0, y: 1 }, spin: 6, stagger: 0.5, fade: 0.9, scaleAway: false,
    });
  }
}

/** Crumble: A cracks and falls away from the top down. */
export class Crumble extends Disintegrate {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const grid = Math.max(10, Math.round(this.density() || 20));
    this.flyCells(ctx, a, b, p, {
      grid, speed: 0.1, gravity: 1.4, wind: 0.05, spread: "down",
      dir: { x: 0, y: 1 }, spin: 2, stagger: 0.5, fade: 0.8, scaleAway: false, rowStagger: "top",
    });
  }
}

/** Low Poly Explode: A bursts into coarse angular shards. */
export class LowPolyExplode extends Disintegrate {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const grid = Math.max(4, Math.round(this.density() || 8));
    this.flyCells(ctx, a, b, p, {
      grid, speed: 0.7, gravity: 0.6, wind: 0, spread: "radial",
      dir: { x: 0, y: 0 }, spin: 5, stagger: 0.1, fade: 0.9, scaleAway: false,
    });
  }
}

/** Morphing Particles: A's cells scatter, then converge as B (crossfading). */
export class MorphingParticles extends Disintegrate {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const seed = this.seed();
    const g = Math.max(10, Math.round(this.density() || 24));
    const cw = w / g, ch = h / g;
    ctx.clearRect(0, 0, w, h);
    const bump = Math.sin(p * Math.PI); // 0→1→0 scatter amount
    for (let j = 0; j < g; j++) {
      for (let i = 0; i < g; i++) {
        const ang = hash2(i, j, seed) * Math.PI * 2;
        const rad = (0.15 + 0.35 * hash2(i, j, seed + 2)) * bump;
        const dx = Math.cos(ang) * rad * w;
        const dy = Math.sin(ang) * rad * h;
        const cx = i * cw + cw / 2 + dx;
        const cy = j * ch + ch / 2 + dy;
        const src = p < 0.5 ? a : b;
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.translate(cx, cy);
        const s = 1 - 0.3 * bump;
        ctx.scale(s, s);
        ctx.drawImage(src, i * cw, j * ch, cw, ch, -cw / 2 - 1, -ch / 2 - 1, cw + 2, ch + 2);
        ctx.restore();
      }
    }
  }
}

/** Smoke / Fog Burst: A rises and diffuses into a soft cloud, revealing B. */
export class SmokeBurst extends Disintegrate {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const h = this.outH;
    ctx.drawImage(b, 0, 0);
    // A rises + blurs + fades
    ctx.save();
    ctx.globalAlpha = 1 - p;
    ctx.filter = `blur(${(p * 24).toFixed(1)}px)`;
    ctx.translate(0, -p * h * 0.25);
    ctx.drawImage(a, 0, 0);
    ctx.filter = "none";
    ctx.restore();
    // grey puffs
    const sys = this.smokeSystem(p);
    sys.draw(ctx, "dot", true);
  }
  private smokeSystem(p: number): ParticleSystem {
    const w = this.outW, h = this.outH;
    const n = Math.max(60, Math.round(this.density() || 140));
    const sys = new ParticleSystem(n, { gravityY: -30, drag: 0.4, turbulence: 40, seed: this.seed() }, this.seed());
    const rng = mulberry32(this.seed() + 11);
    for (let i = 0; i < n; i++) {
      const gi = sys.spawn({
        x: rng() * w, y: h * (0.5 + rng() * 0.5), vx: (rng() - 0.5) * 40, vy: -rng() * 40,
        ttl: 1, size: 20 + rng() * 40,
        r: 180 + Math.round(rng() * 50), g: 180 + Math.round(rng() * 50), b: 190 + Math.round(rng() * 50),
      });
      if (gi < 0) break;
    }
    const steps = 8;
    for (let s = 0; s < steps; s++) sys.update((p * 1.0) / steps);
    return sys;
  }
}

/** Bubbles: A breaks into rising translucent bubbles. */
export class Bubbles extends Disintegrate {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    ctx.drawImage(b, 0, 0);
    ctx.save();
    ctx.globalAlpha = clamp01(1 - p * 1.3);
    ctx.drawImage(a, 0, 0);
    ctx.restore();
    const n = Math.max(40, Math.round(this.density() || 90));
    const gw = 16, gh = 12;
    const col = this.sampleColors(gw, gh);
    const rng = mulberry32(this.seed());
    ctx.save();
    for (let i = 0; i < n; i++) {
      const gx = Math.floor(rng() * gw), gy = Math.floor(rng() * gh);
      const idx = (gy * gw + gx) * 4;
      const bx = (gx + 0.5) / gw * w + Math.sin(p * 6 + i) * 20;
      const rise = p * h * (0.6 + rng() * 0.8);
      const by = (gy + 0.5) / gh * h - rise;
      const size = 10 + rng() * 28;
      const alpha = clamp01(1 - p) * 0.8;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = `rgb(${col.data[idx]},${col.data[idx + 1]},${col.data[idx + 2]})`;
      ctx.beginPath();
      ctx.arc(bx, by, size, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha * 0.6;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(bx - size * 0.3, by - size * 0.3, size * 0.18, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/** Magic Dust: a gentle dissolve trailed by sparkling particles. */
export class MagicDust extends Disintegrate {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    this.flyCells(ctx, a, b, p, {
      grid: Math.max(12, Math.round(this.density() || 26)), speed: 0.12, gravity: -0.1, wind: 0.05,
      spread: "random", dir: { x: 0, y: 0 }, spin: 1, stagger: 0.55, fade: 1.5, scaleAway: true,
    });
    const n = 220;
    const rng = mulberry32(this.seed() + 4);
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    for (let i = 0; i < n; i++) {
      const life = rng();
      if (Math.abs(life - p) > 0.28) continue;
      const x = rng() * w, y = rng() * h - p * h * 0.3;
      const hue = 40 + rng() * 80;
      const s = 1 + rng() * 3;
      const alpha = 1 - Math.abs(life - p) / 0.28;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = `hsl(${hue},100%,75%)`;
      ctx.beginPath();
      ctx.arc(x, y, s, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha * 0.4;
      ctx.beginPath();
      ctx.arc(x, y, s * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/** Fire: A burns away along a rising flame edge, revealing B. */
export class Fire extends Disintegrate {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const seed = this.seed();
    ctx.drawImage(b, 0, 0);
    // burn line rises bottom→top; A shown above it, with a wavy edge
    const edgeY = (1 - p) * h;
    const mask = scratch("fire-mask", w, h);
    const mx = mask.getContext("2d");
    if (mx) {
      mx.clearRect(0, 0, w, h);
      mx.drawImage(a, 0, 0);
      mx.globalCompositeOperation = "destination-in";
      mx.beginPath();
      mx.moveTo(0, 0);
      mx.lineTo(w, 0);
      const cols = 40;
      for (let i = cols; i >= 0; i--) {
        const x = (i / cols) * w;
        const wob = (hash2(i, Math.floor(p * 30), seed) - 0.5) * 40;
        mx.lineTo(x, edgeY + wob);
      }
      mx.closePath();
      mx.fillStyle = "#fff";
      mx.fill();
      mx.globalCompositeOperation = "source-over";
    }
    ctx.drawImage(mask, 0, 0);
    // flame band + embers at the edge
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    for (let i = 0; i <= 40; i++) {
      const x = (i / 40) * w;
      const wob = (hash2(i, Math.floor(p * 30), seed) - 0.5) * 40;
      const fy = edgeY + wob;
      const grd = ctx.createRadialGradient(x, fy, 0, x, fy, 60);
      grd.addColorStop(0, "rgba(255,240,180,0.9)");
      grd.addColorStop(0.4, "rgba(255,140,40,0.7)");
      grd.addColorStop(1, "rgba(200,30,0,0)");
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(x, fy, 60, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/** Water / Wave Wash: a water wave sweeps across and reveals B. */
export class WaterWash extends Disintegrate {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const seed = this.seed();
    ctx.drawImage(a, 0, 0);
    const crest = p * w * 1.25;
    // B revealed behind the crest, with a little vertical refraction
    const mb = scratch("water-b", w, h);
    const bc = mb.getContext("2d");
    if (bc) {
      bc.clearRect(0, 0, w, h);
      const bands = 60;
      const bh = h / bands;
      for (let i = 0; i < bands; i++) {
        const refract = Math.sin(i * 0.5 + p * 10) * 8 * (1 - p);
        bc.drawImage(b, 0, i * bh, w, bh, refract, i * bh, w, bh);
      }
      bc.globalCompositeOperation = "destination-in";
      bc.fillStyle = "#fff";
      bc.fillRect(0, 0, crest, h);
      bc.globalCompositeOperation = "source-over";
    }
    ctx.drawImage(mb, 0, 0);
    // foam crest
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = "#dff";
    ctx.lineWidth = 6;
    ctx.beginPath();
    for (let y = 0; y <= h; y += 8) {
      const x = crest + Math.sin(y * 0.05 + p * 8) * 18 * hash2(Math.floor(y), 1, seed);
      if (y === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }
}

/** Constellation: dots connect and rearrange like stars from A into B. */
export class Constellation extends Disintegrate {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const seed = this.seed();
    // dim crossfade background
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.drawImage(a, 0, 0);
    ctx.globalAlpha = 0.35 * p;
    ctx.drawImage(b, 0, 0);
    ctx.restore();
    ctx.save();
    ctx.fillStyle = "#000";
    ctx.globalAlpha = 0.35;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    const n = Math.max(30, Math.round(this.density() || 70));
    const rng = mulberry32(seed);
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const ax = rng() * w, ay = rng() * h;
      const bx = rng() * w, by = rng() * h;
      pts.push({ x: ax + (bx - ax) * p, y: ay + (by - ay) * p });
    }
    ctx.save();
    ctx.strokeStyle = "rgba(180,210,255,0.5)";
    ctx.lineWidth = 1;
    const maxD = w * 0.16;
    for (let i = 0; i < pts.length; i++) {
      for (let k = i + 1; k < pts.length; k++) {
        const dx = pts[i].x - pts[k].x, dy = pts[i].y - pts[k].y;
        const d = Math.hypot(dx, dy);
        if (d < maxD) {
          ctx.globalAlpha = (1 - d / maxD) * 0.6;
          ctx.beginPath();
          ctx.moveTo(pts[i].x, pts[i].y);
          ctx.lineTo(pts[k].x, pts[k].y);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#eaf2ff";
    for (const pt of pts) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
