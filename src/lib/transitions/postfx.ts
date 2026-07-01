// Post-processing helpers for Stage-4 transitions: chromatic aberration, glow,
// motion blur, scanlines, noise, vignette, light leaks. All operate on canvases
// / 2D contexts and reuse the scratch pool for speed.

import { scratch } from "./xform";
import { hash2 } from "./rng";
import { clamp01 } from "./easing";

/** Draw one colour channel of `img` (tinted) additively at an offset. */
function channel(ctx: CanvasRenderingContext2D, img: CanvasImageSource, name: "r" | "g" | "b", dx: number, dy: number, w: number, h: number) {
  const t = scratch("chan-" + name, w, h);
  const tc = t.getContext("2d");
  if (!tc) return;
  tc.globalCompositeOperation = "source-over";
  tc.clearRect(0, 0, w, h);
  tc.drawImage(img, 0, 0);
  tc.globalCompositeOperation = "multiply";
  tc.fillStyle = name === "r" ? "#ff0000" : name === "g" ? "#00ff00" : "#0000ff";
  tc.fillRect(0, 0, w, h);
  tc.globalCompositeOperation = "source-over";
  ctx.globalCompositeOperation = "lighter";
  ctx.drawImage(t, dx, dy);
}

/** Chromatic aberration / RGB split: recombine R,G,B channels at offsets. */
export function chromaticAberration(ctx: CanvasRenderingContext2D, img: CanvasImageSource, w: number, h: number, offset: number, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  channel(ctx, img, "r", offset, 0, w, h);
  channel(ctx, img, "g", 0, 0, w, h);
  channel(ctx, img, "b", -offset, 0, w, h);
  ctx.restore();
  ctx.globalCompositeOperation = "source-over";
}

/** Bloom/glow: the image plus a blurred, brightened copy screened over it. */
export function glow(ctx: CanvasRenderingContext2D, img: CanvasImageSource, _w: number, _h: number, radius: number, amount: number) {
  ctx.drawImage(img, 0, 0);
  if (amount <= 0 || radius <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = clamp01(amount);
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(img, 0, 0);
  ctx.filter = "none";
  ctx.restore();
}

/** Accumulate `img` along a vector with fading alpha for a motion-blur streak. */
export function motionBlur(ctx: CanvasRenderingContext2D, img: CanvasImageSource, vx: number, vy: number, samples: number, alpha = 1) {
  const n = Math.max(1, Math.round(samples));
  ctx.save();
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0 : i / (n - 1) - 0.5;
    ctx.globalAlpha = alpha / n;
    ctx.drawImage(img, vx * f, vy * f);
  }
  ctx.restore();
}

/** Horizontal scanlines. */
export function scanlines(ctx: CanvasRenderingContext2D, w: number, h: number, alpha: number, gap = 3) {
  ctx.save();
  ctx.globalAlpha = clamp01(alpha);
  ctx.fillStyle = "#000";
  for (let y = 0; y < h; y += gap) ctx.fillRect(0, y, w, 1);
  ctx.restore();
}

/** Blocky digital noise (seeded). `cells` = block resolution. */
export function noiseOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number, seed: number, cells = 80) {
  if (amount <= 0) return;
  const bw = Math.max(1, Math.round(w / cells));
  const bh = bw;
  ctx.save();
  ctx.globalAlpha = clamp01(amount);
  for (let y = 0, r = 0; y < h; y += bh, r++) {
    for (let x = 0, c = 0; x < w; x += bw, c++) {
      const n = hash2(c, r, seed);
      const v = Math.round(n * 255);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      if (n > 0.5) ctx.fillRect(x, y, bw, bh);
    }
  }
  ctx.globalCompositeOperation = "overlay";
  ctx.restore();
}

/** Radial vignette darkening the edges. */
export function vignette(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number) {
  if (amount <= 0) return;
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.7);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${clamp01(amount)})`);
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** A warm organic light-leak gradient, screened over. `t` sweeps its position. */
export function lightLeak(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, hue = 30, intensity = 1) {
  const cx = w * (t * 1.4 - 0.2);
  const g = ctx.createRadialGradient(cx, h * 0.3, 0, cx, h * 0.3, Math.max(w, h) * 0.8);
  g.addColorStop(0, `hsla(${hue},100%,60%,${0.55 * intensity})`);
  g.addColorStop(0.5, `hsla(${hue + 20},100%,55%,${0.25 * intensity})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
