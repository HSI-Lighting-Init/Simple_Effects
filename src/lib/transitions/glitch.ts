// Category 8 — Distortion, Glitch & Digital transitions (Stage 4).
//
// These lean on the post-processing stack (postfx.ts) and seeded RNG (rng.ts).
// Warps are band-based (drawImage sub-rects) rather than per-pixel, so they stay
// fast at 1080p and don't depend on getImageData. Anything genuinely per-pixel
// (true pixel sorting, optical-flow datamoshing) is approximated with band
// smears / displacement and noted as stylised.

import { TransitionEffect } from "./base";
import type { BaseParams } from "./types";
import { scratch } from "./xform";
import { clamp01 } from "./easing";
import { hash2, valueNoise2D } from "./rng";
import { chromaticAberration, noiseOverlay, scanlines, lightLeak, vignette } from "./postfx";

export interface GlitchParams extends BaseParams {
  seed?: number;
  amount?: number; // 0..1 overall strength
  amplitude?: number; // px-ish, for warps
  frequency?: number; // cycles, for warps
  hue?: number; // for light leak
}

/** Draw `src` as horizontal bands, each shifted in X by off(normalizedY). */
function warpH(ctx: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number, bands: number, off: (ny: number, i: number) => number) {
  const bh = Math.max(1, Math.ceil(h / bands));
  for (let y = 0, i = 0; y < h; y += bh, i++) {
    const hh = Math.min(bh, h - y);
    ctx.drawImage(src, 0, y, w, hh, off((y + hh / 2) / h, i), y, w, hh);
  }
}

/** Draw `src` as vertical bands, each shifted in Y by off(normalizedX). */
function warpV(ctx: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number, bands: number, off: (nx: number, i: number) => number) {
  const bw = Math.max(1, Math.ceil(w / bands));
  for (let x = 0, i = 0; x < w; x += bw, i++) {
    const ww = Math.min(bw, w - x);
    ctx.drawImage(src, x, 0, ww, h, x, off((x + ww / 2) / w, i), ww, h);
  }
}

export abstract class GlitchBase<P extends GlitchParams = GlitchParams> extends TransitionEffect<P> {
  protected seed(): number {
    const s = this.params.seed;
    return Math.max(1, Math.floor(typeof s === "number" ? s : 1));
  }
  protected amount(): number {
    const a = this.params.amount;
    return clamp01(typeof a === "number" ? a : 1);
  }
  /** 0→1→0, peaking at the midpoint. */
  protected bump(p: number): number {
    return 1 - Math.abs(2 * p - 1);
  }
  /** Crossfaded base of A→B at p into a reusable scratch canvas. */
  protected base(a: HTMLCanvasElement, b: HTMLCanvasElement, p: number): HTMLCanvasElement {
    const c = scratch("glitch-base", this.outW, this.outH);
    const cx = c.getContext("2d");
    if (cx) {
      cx.clearRect(0, 0, this.outW, this.outH);
      cx.globalAlpha = 1;
      cx.drawImage(a, 0, 0);
      cx.globalAlpha = clamp01(p);
      cx.drawImage(b, 0, 0);
      cx.globalAlpha = 1;
    }
    return c;
  }
  /** Render `img` with RGB split into a fresh scratch (returns the canvas). */
  protected split(img: CanvasImageSource, offset: number): HTMLCanvasElement {
    const c = scratch("glitch-split", this.outW, this.outH);
    const cx = c.getContext("2d");
    if (cx) {
      cx.clearRect(0, 0, this.outW, this.outH);
      chromaticAberration(cx, img, this.outW, this.outH, offset);
    }
    return c;
  }
}

/** Glitch: RGB split, block displacement and digital noise crossing into B. */
export class Glitch extends GlitchBase {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const g = this.bump(p) * this.amount();
    const src = p < 0.5 ? a : b;
    const seed = this.seed() + Math.floor(p * 32);
    ctx.drawImage(src, 0, 0);
    const bands = 16;
    const bh = h / bands;
    for (let i = 0; i < bands; i++) {
      if (hash2(i, seed, 7) > 0.55) {
        const dx = (hash2(i, seed, 3) - 0.5) * g * 0.18 * w;
        ctx.drawImage(src, 0, i * bh, w, bh, dx, i * bh, w, bh);
      }
    }
    if (g > 0.02) {
      ctx.save();
      ctx.globalAlpha = 0.65;
      ctx.drawImage(this.split(src, g * 16), 0, 0);
      ctx.restore();
    }
    noiseOverlay(ctx, w, h, g * 0.3, seed);
  }
}

/** Pixel Sorting (stylised): bright bands stretch/smear along the sort axis. */
export class PixelSort extends GlitchBase {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const base = this.base(a, b, p);
    const g = this.bump(p) * this.amount();
    const seed = this.seed();
    ctx.drawImage(base, 0, 0);
    // Smear columns downward by a seeded amount to mimic a vertical sort.
    const cols = 64;
    const bw = w / cols;
    ctx.save();
    ctx.globalAlpha = 0.85;
    for (let i = 0; i < cols; i++) {
      const stretch = hash2(i, seed, 11) * g;
      if (stretch < 0.02) continue;
      const sy = h * 0.5 * (1 - stretch);
      ctx.drawImage(base, i * bw, sy, bw, 2, i * bw, sy, bw, h - sy);
    }
    ctx.restore();
  }
}

/** Bad TV / signal interference: scanlines, rolling noise and signal loss. */
export class BadTV extends GlitchBase {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const g = this.bump(p) * this.amount();
    const src = p < 0.5 ? a : b;
    const seed = this.seed() + Math.floor(p * 20);
    warpH(ctx, src, w, h, 48, (_ny, i) => {
      const roll = valueNoise2D(i * 0.3, p * 8, seed) - 0.5;
      return roll * g * 0.15 * w;
    });
    ctx.drawImage(this.split(src, g * 6), 0, 0);
    ctx.save();
    ctx.globalAlpha = 0.35 * g;
    ctx.drawImage(src, 0, 0);
    ctx.restore();
    noiseOverlay(ctx, w, h, g * 0.25, seed, 120);
    scanlines(ctx, w, h, 0.15 + 0.2 * g, 3);
  }
}

/** Digital Block Wipe: blocky compression-artifact reveal of B over A. */
export class DigitalBlockWipe extends GlitchBase {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const seed = this.seed();
    ctx.drawImage(a, 0, 0);
    const cols = 24, rows = 14;
    const cw = w / cols, ch = h / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const t = hash2(c, r, seed);
        if (t <= p) {
          // occasional macroblock offset for a compression-glitch feel
          const jump = hash2(c, r, seed + 5) < 0.15 * this.amount() ? (hash2(c, r, seed + 9) - 0.5) * cw : 0;
          ctx.drawImage(b, c * cw, r * ch, cw, ch, c * cw + jump, r * ch, cw, ch);
        }
      }
    }
  }
}

/** Data Moshing (stylised): motion-smeared displacement bleeding A into B. */
export class DataMosh extends GlitchBase {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const g = this.bump(p) * this.amount();
    const seed = this.seed();
    ctx.drawImage(p < 0.5 ? a : b, 0, 0);
    const cols = 20, rows = 12;
    const cw = w / cols, ch = h / rows;
    const smear = p < 0.5 ? a : b;
    ctx.save();
    ctx.globalAlpha = 0.55;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const ang = valueNoise2D(c * 0.5, r * 0.5, seed) * Math.PI * 2;
        const d = g * 22;
        ctx.drawImage(smear, c * cw, r * ch, cw, ch, c * cw + Math.cos(ang) * d, r * ch + Math.sin(ang) * d, cw, ch);
      }
    }
    ctx.restore();
    noiseOverlay(ctx, w, h, g * 0.12, seed, 60);
  }
}

/** Wave Warp: a travelling sine distortion sweeps across as A crossfades to B. */
export class WaveWarp extends GlitchBase {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const base = this.base(a, b, p);
    const amp = ((this.params.amplitude as number) ?? 40) * this.bump(p);
    const freq = (this.params.frequency as number) ?? 3;
    warpH(ctx, base, w, h, 80, (ny) => Math.sin((ny * freq + p) * Math.PI * 2) * amp);
  }
}

/** Ripple: concentric water-droplet ripples radiate as B resolves in. */
export class Ripple extends GlitchBase {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const base = this.base(a, b, p);
    const amp = ((this.params.amplitude as number) ?? 30) * this.bump(p);
    const freq = (this.params.frequency as number) ?? 6;
    const rings = 60;
    ctx.save();
    for (let i = 0; i < rings; i++) {
      const r0 = (i / rings) * Math.hypot(w, h) * 0.5;
      const r1 = ((i + 1) / rings) * Math.hypot(w, h) * 0.5;
      const disp = Math.sin((i / rings) * freq * Math.PI * 2 - p * Math.PI * 4) * amp * (1 - p * 0.5);
      const s = 1 + disp / (r1 + 1);
      ctx.save();
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, r1, 0, Math.PI * 2);
      ctx.arc(w / 2, h / 2, r0, 0, Math.PI * 2, true);
      ctx.clip();
      ctx.translate(w / 2, h / 2);
      ctx.scale(s, s);
      ctx.translate(-w / 2, -h / 2);
      ctx.drawImage(base, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }
}

/** Swirl / Twirl: the frame twists into a vortex mid-transition. */
export class Swirl extends GlitchBase {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const base = this.base(a, b, p);
    const twist = ((this.params.amplitude as number) ?? 6) * this.bump(p);
    const rings = 48;
    const maxR = Math.hypot(w, h) * 0.5;
    ctx.save();
    for (let i = 0; i < rings; i++) {
      const r0 = (i / rings) * maxR;
      const r1 = ((i + 1) / rings) * maxR;
      const ang = (1 - i / rings) * twist;
      ctx.save();
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, r1, 0, Math.PI * 2);
      ctx.arc(w / 2, h / 2, r0, 0, Math.PI * 2, true);
      ctx.clip();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(ang);
      ctx.translate(-w / 2, -h / 2);
      ctx.drawImage(base, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }
}

/** Liquify: fluid noise-driven distortion that settles as B resolves. */
export class Liquify extends GlitchBase {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const base = this.base(a, b, p);
    const amp = ((this.params.amplitude as number) ?? 50) * this.bump(p);
    const seed = this.seed();
    warpH(ctx, base, w, h, 60, (_ny, i) => (valueNoise2D(i * 0.4, p * 3, seed) - 0.5) * amp * 2);
  }
}

/** Melt: the clip drips downward in columns, revealing B beneath. */
export class Melt extends GlitchBase {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const seed = this.seed();
    ctx.drawImage(b, 0, 0);
    ctx.save();
    warpV(ctx, a, w, h, 48, (_nx, i) => {
      const drip = (0.4 + 0.6 * hash2(i, seed, 4)) * p;
      return drip * h * 1.3;
    });
    ctx.restore();
  }
}

/** Stretch: the frame whips by stretching along an axis into the next clip. */
export class Stretch extends GlitchBase {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const horizontal = ((this.params.frequency as number) ?? 1) >= 0;
    const stretchA = 1 + this.bump(p) * 6 * (p < 0.5 ? 1 : 0);
    const stretchB = 1 + this.bump(p) * 6 * (p >= 0.5 ? 1 : 0);
    const draw = (img: CanvasImageSource, s: number, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(w / 2, h / 2);
      if (horizontal) ctx.scale(s, 1);
      else ctx.scale(1, s);
      ctx.translate(-w / 2, -h / 2);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    };
    if (p < 0.5) draw(a, stretchA, 1);
    else draw(b, stretchB, 1);
  }
}

/** Motion Tile: the clip repeats as tiles and slides like a scrolling pattern. */
export class MotionTile extends GlitchBase {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    ctx.drawImage(b, 0, 0);
    const tiles = Math.max(1, Math.round((this.params.frequency as number) ?? 3));
    const tw = w / tiles, th = h / tiles;
    const shift = p * w;
    const alpha = 1 - clamp01((p - 0.5) * 2);
    ctx.save();
    ctx.globalAlpha = alpha;
    for (let r = 0; r < tiles; r++) {
      for (let c = 0; c < tiles; c++) {
        const ox = ((c * tw + shift * (r % 2 === 0 ? 1 : -1)) % w + w) % w;
        ctx.drawImage(a, 0, 0, w, h, ox - w, r * th, tw, th);
        ctx.drawImage(a, 0, 0, w, h, ox, r * th, tw, th);
      }
    }
    ctx.restore();
  }
}

/** Retro VHS: tracking lines, colour bleed and temporal wobble. */
export class RetroVHS extends GlitchBase {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const base = this.base(a, b, p);
    const g = 0.5 + 0.5 * this.bump(p);
    const seed = this.seed() + Math.floor(p * 12);
    warpH(ctx, base, w, h, 40, (_ny, i) => (valueNoise2D(i * 0.5, p * 5, seed) - 0.5) * 10 * g);
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.35;
    ctx.drawImage(base, 6 * g, 0); // colour bleed
    ctx.restore();
    // tracking band
    const ty = ((p * 2) % 1) * h;
    ctx.save();
    ctx.globalAlpha = 0.4 * g;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, ty, w, 6);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, ty + 6, w, 10);
    ctx.restore();
    scanlines(ctx, w, h, 0.12, 3);
    noiseOverlay(ctx, w, h, 0.08 * g, seed, 140);
  }
}

/** Flicker: rapid strobe between the two clips (and white flashes). */
export class Flicker extends GlitchBase {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const seed = this.seed();
    const steps = Math.max(2, Math.round((this.params.frequency as number) ?? 10));
    const idx = Math.floor(p * steps);
    const on = hash2(idx, seed, 3);
    // Bias toward B as p grows.
    const showB = on < p;
    ctx.drawImage(showB ? b : a, 0, 0);
    if (hash2(idx, seed, 9) > 0.7) {
      ctx.save();
      ctx.globalAlpha = 0.5 * this.bump(p);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }
}

/** Light Leak: an organic warm light-leak overlay blends A into B. */
export class LightLeakTransition extends GlitchBase {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    ctx.drawImage(this.base(a, b, p), 0, 0);
    const hue = (this.params.hue as number) ?? 30;
    lightLeak(ctx, w, h, p, hue, 0.6 + 0.8 * this.bump(p));
    vignette(ctx, w, h, 0.15 * this.bump(p));
  }
}

/** Prism / Chromatic Aberration: colour-fringing separation crossfade. */
export class Prism extends GlitchBase {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const base = this.base(a, b, p);
    const offset = ((this.params.amplitude as number) ?? 24) * this.bump(p);
    chromaticAberration(ctx, base, w, h, offset);
  }
}
