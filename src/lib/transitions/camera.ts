// Category 10 — Camera Movement & Depth (Stage 4).
//
// Two families:
//  - Planar "camera" moves (whip pan, dolly, truck, ken burns, rack focus …)
//    are done as 2D transforms of the two frames plus post-processing (motion
//    blur, defocus blur, shake) — robust and cheap.
//  - Genuinely 3D moves (orbital, fly-through, 3D room, 360 spin, perspective
//    slide) place the frames as quads in the Stage-3 software 3D pipeline
//    (mesh3d.ts) and animate a keyframed CameraPath.
//
// CameraPath is the reusable, keyframe-driven camera used by the 3D family and
// is exported for external/authored moves.

import { TransitionEffect } from "./base";
import type { BaseParams } from "./types";
import { clamp01 } from "./easing";
import { scratch } from "./xform";
import { motionBlur, vignette } from "./postfx";
import { mulberry32 } from "./rng";
import { renderQuads, frameQuad, rot as rot3, type V3, type Quad, type Camera } from "./mesh3d";

export interface CameraParams extends BaseParams {
  seed?: number;
  amount?: number; // move intensity 0..1
  blur?: number; // motion/defocus blur strength
  depth?: number; // parallax / dolly depth
}

// ---------------------------------------------------------------------------
// CameraPath framework
// ---------------------------------------------------------------------------

export interface CamState {
  pos: V3;
  rot: V3;
  fov: number;
}
export interface CamKey {
  t: number;
  pos?: V3;
  rot?: V3;
  fov?: number;
}

/** A keyframed camera: interpolates position, rotation (radians) and fov. */
export class CameraPath {
  private ks: (CamState & { t: number })[];
  constructor(keys: CamKey[]) {
    if (!keys.length) throw new Error("CameraPath needs at least one keyframe");
    this.ks = keys
      .map((k) => ({ t: clamp01(k.t), pos: k.pos ?? [0, 0, 0], rot: k.rot ?? [0, 0, 0], fov: k.fov ?? 0.6 }))
      .sort((a, b) => a.t - b.t);
  }
  sample(t: number): CamState {
    const tt = clamp01(t);
    const ks = this.ks;
    if (tt <= ks[0].t) return { pos: ks[0].pos, rot: ks[0].rot, fov: ks[0].fov };
    const last = ks[ks.length - 1];
    if (tt >= last.t) return { pos: last.pos, rot: last.rot, fov: last.fov };
    let i = 0;
    while (i < ks.length - 1 && ks[i + 1].t < tt) i++;
    const k0 = ks[i], k1 = ks[i + 1];
    const f = (tt - k0.t) / ((k1.t - k0.t) || 1);
    const lp = (a: V3, b: V3): V3 => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    return { pos: lp(k0.pos, k1.pos), rot: lp(k0.rot, k1.rot), fov: k0.fov + (k1.fov - k0.fov) * f };
  }
}

/** Transform a world point into camera/view space (inverse camera transform). */
function view(v: V3, cam: CamState): V3 {
  let p: V3 = [v[0] - cam.pos[0], v[1] - cam.pos[1], v[2] - cam.pos[2]];
  p = rot3(p, 0, 0, -cam.rot[2]);
  p = rot3(p, 0, -cam.rot[1], 0);
  p = rot3(p, -cam.rot[0], 0, 0);
  return p;
}

interface SceneQuad {
  tex: HTMLCanvasElement;
  world: (c: V3) => V3;
  shade?: number;
  shadow?: boolean;
  alpha?: number;
}
interface Scene {
  quads: SceneQuad[]; // back-to-front draw order
  cam: CamState;
  ambient?: number;
  light?: V3;
  bg?: string;
  post?: (ctx: CanvasRenderingContext2D) => void;
}

/** Base for the 3D camera family: subclasses return a Scene per progress. */
export abstract class Camera3DTransition<P extends CameraParams = CameraParams> extends TransitionEffect<P> {
  protected abstract scene(a: HTMLCanvasElement, b: HTMLCanvasElement, p: number): Scene;
  protected seed(): number {
    const s = this.params.seed;
    return Math.max(1, Math.floor(typeof s === "number" ? s : 1));
  }
  protected bump(p: number): number {
    return 1 - Math.abs(2 * p - 1);
  }
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    const s = this.scene(a, b, p);
    ctx.fillStyle = s.bg ?? "#000";
    ctx.fillRect(0, 0, w, h);
    const fov = Math.min(2.4, Math.max(0.12, s.cam.fov));
    const cam: Camera = { w, h, dist: (h / 2) / Math.tan(fov / 2) };
    for (const q of s.quads) {
      const quad: Quad = frameQuad(q.tex, w, h, { x: 0, y: 0, w, h }, (c) => view(q.world(c), s.cam), {
        shade: q.shade,
        shadow: q.shadow,
      });
      ctx.save();
      ctx.globalAlpha = clamp01(q.alpha ?? 1);
      renderQuads(ctx, [quad], cam, { light: s.light, ambient: s.ambient ?? 0.7 });
      ctx.restore();
    }
    s.post?.(ctx);
  }
}

// ---------------------------------------------------------------------------
// Planar camera family
// ---------------------------------------------------------------------------

interface Place {
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  tx?: number;
  ty?: number;
  rot?: number;
  alpha?: number;
  blur?: number;
}

export abstract class Camera2DTransition<P extends CameraParams = CameraParams> extends TransitionEffect<P> {
  protected seed(): number {
    const s = this.params.seed;
    return Math.max(1, Math.floor(typeof s === "number" ? s : 1));
  }
  protected amount(): number {
    const a = this.params.amount;
    return clamp01(typeof a === "number" ? a : 1);
  }
  protected bump(p: number): number {
    return 1 - Math.abs(2 * p - 1);
  }
  /** Draw a full frame with scale/translate/rotate/alpha and optional blur. */
  protected place(ctx: CanvasRenderingContext2D, img: CanvasImageSource, o: Place) {
    const w = this.outW, h = this.outH;
    const alpha = clamp01(o.alpha ?? 1);
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (o.blur && o.blur > 0.1) ctx.filter = `blur(${o.blur.toFixed(1)}px)`;
    ctx.translate(w / 2 + (o.tx ?? 0), h / 2 + (o.ty ?? 0));
    if (o.rot) ctx.rotate(o.rot);
    ctx.scale(o.scaleX ?? o.scale ?? 1, o.scaleY ?? o.scale ?? 1);
    ctx.translate(-w / 2, -h / 2);
    ctx.drawImage(img, 0, 0);
    ctx.filter = "none";
    ctx.restore();
  }
}

/** Whip Pan: fast horizontal pan with heavy motion blur masking the cut. */
export class WhipPan extends Camera2DTransition {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW;
    const blur = 40 + 120 * this.bump(p) * ((this.params.blur as number) ?? 1);
    const streak = scratch("whip", w, this.outH);
    const sx = streak.getContext("2d");
    if (sx) {
      sx.clearRect(0, 0, w, this.outH);
      this.place2(sx, a, -p * w * 2, 1);
      this.place2(sx, b, (1 - p) * w * 2, 1);
    }
    motionBlur(ctx, streak, blur, 0, 8, 1);
  }
  private place2(ctx: CanvasRenderingContext2D, img: CanvasImageSource, tx: number, alpha: number) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, tx, 0);
    ctx.restore();
  }
}

/** Tilt Whip: fast vertical pan with heavy vertical motion blur. */
export class TiltWhip extends Camera2DTransition {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const h = this.outH;
    const blur = 40 + 120 * this.bump(p) * ((this.params.blur as number) ?? 1);
    const streak = scratch("tilt", this.outW, h);
    const sx = streak.getContext("2d");
    if (sx) {
      sx.clearRect(0, 0, this.outW, h);
      sx.drawImage(a, 0, -p * h * 2);
      sx.drawImage(b, 0, (1 - p) * h * 2);
    }
    motionBlur(ctx, streak, 0, blur, 8, 1);
  }
}

/** Dolly In: the camera trucks forward into A, arriving on B. */
export class DollyIn extends Camera2DTransition {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const depth = 0.6 * ((this.params.depth as number) ?? 1);
    this.place(ctx, a, { scale: 1 + depth * p, alpha: 1, blur: this.bump(p) * 4 * ((this.params.blur as number) ?? 0) });
    this.place(ctx, b, { scale: 1 + depth * (1 - p) * 0.5, alpha: clamp01((p - 0.4) / 0.6) });
  }
}

/** Dolly Out: the camera pulls back off A, revealing B behind. */
export class DollyOut extends Camera2DTransition {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const depth = 0.6 * ((this.params.depth as number) ?? 1);
    this.place(ctx, b, { scale: 1 + depth * (1 - p), alpha: 1 });
    this.place(ctx, a, { scale: 1 - depth * p, alpha: clamp01(1 - p * 1.3) });
  }
}

/** Truck / Crab: the camera slides laterally from A to B. */
export class Truck extends Camera2DTransition {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW;
    this.place(ctx, a, { tx: -p * w, blur: this.bump(p) * 10 * ((this.params.blur as number) ?? 0.3) });
    this.place(ctx, b, { tx: (1 - p) * w, blur: this.bump(p) * 10 * ((this.params.blur as number) ?? 0.3) });
  }
}

/** Zoom with Camera Shake: rough zoom-in with seeded handheld shake. */
export class ZoomShake extends Camera2DTransition {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const rng = mulberry32(this.seed() + Math.floor(p * 60));
    const amp = 26 * this.bump(p) * this.amount();
    const sx = (rng() - 0.5) * amp;
    const sy = (rng() - 0.5) * amp;
    const rot = (rng() - 0.5) * 0.05 * this.bump(p);
    this.place(ctx, a, { scale: 1 + 0.5 * p, tx: sx, ty: sy, rot, alpha: 1 });
    this.place(ctx, b, { scale: 1.5 - 0.5 * p, tx: sx, ty: sy, rot, alpha: clamp01((p - 0.5) * 2) });
  }
}

/** Parallax Camera: foreground (A) and background move at different rates. */
export class ParallaxCamera extends Camera2DTransition {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW;
    // Background B slides slowly and scales gently; foreground A slides fast + fades.
    this.place(ctx, b, { tx: (1 - p) * w * 0.5, scale: 1.1 - 0.1 * p, alpha: 1 });
    this.place(ctx, a, { tx: -p * w * 1.2, scale: 1.15, alpha: clamp01(1 - p * 1.2) });
  }
}

/** Ken Burns: slow pan-and-zoom across A, crossfading into a pan on B. */
export class KenBurns extends Camera2DTransition {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    this.place(ctx, a, { scale: 1.05 + 0.2 * p, tx: -w * 0.05 * p, ty: -h * 0.04 * p, alpha: 1 });
    this.place(ctx, b, { scale: 1.25 - 0.2 * p, tx: w * 0.05 * (1 - p), ty: h * 0.03 * (1 - p), alpha: clamp01((p - 0.5) * 2) });
  }
}

/** Dolly Zoom (Vertigo): subject scale held while the background warps. */
export class DollyZoom extends Camera2DTransition {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    // Opposing scale on A (zoom in) vs framing (scale down) → disorienting warp.
    const z = 0.8 * ((this.params.depth as number) ?? 1);
    this.place(ctx, a, { scaleX: 1 + z * p, scaleY: 1 + z * p * 0.4, alpha: clamp01(1 - p * 1.2) });
    this.place(ctx, b, { scaleX: 1 + z * (1 - p), scaleY: 1 + z * (1 - p) * 0.4, alpha: clamp01((p - 0.3) / 0.7) });
  }
}

/** Rack Focus: defocus A, then pull focus onto B (depth-of-field shift). */
export class RackFocus extends Camera2DTransition {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const max = 18 * ((this.params.blur as number) ?? 1);
    this.place(ctx, a, { blur: p * max, alpha: clamp01(1 - p * 1.3) });
    this.place(ctx, b, { blur: (1 - p) * max, alpha: clamp01((p - 0.2) / 0.8) });
  }
}

/** Aerial Flyover: a drone-like diagonal sweep across both clips. */
export class AerialFlyover extends Camera2DTransition {
  composeCpu(ctx: CanvasRenderingContext2D, a: HTMLCanvasElement, b: HTMLCanvasElement, p: number) {
    const w = this.outW, h = this.outH;
    this.place(ctx, a, { scale: 1.15, tx: -p * w * 0.6, ty: -p * h * 0.3, alpha: clamp01(1 - p * 1.2) });
    this.place(ctx, b, { scale: 1.15, tx: (1 - p) * w * 0.6, ty: (1 - p) * h * 0.3, alpha: clamp01((p - 0.4) / 0.6) });
    vignette(ctx, w, h, 0.25);
  }
}

// ---------------------------------------------------------------------------
// 3D camera family
// ---------------------------------------------------------------------------

const shift = (v: V3, dx: number, dy: number, dz: number): V3 => [v[0] + dx, v[1] + dy, v[2] + dz];

// Rotate a centred local corner about a vertical hinge line at x = hingeX.
const hingeY = (c: V3, hingeX: number, ang: number): V3 => {
  const r = rot3([c[0] - hingeX, c[1], c[2]], 0, ang, 0);
  return [r[0] + hingeX, r[1], r[2]];
};

// The 3D camera transitions all CONVERGE to the identity framing: at p=0 clip A
// exactly fills the frame (world = identity), and at p=1 clip B exactly fills it.
// That way the clip physically lands flat and centred — no crossfade over a
// spatial gap — so the hand-off to the static image is seamless. The camera is
// held at identity and the planes carry the motion (a plane at z=0, unrotated,
// unoffset projects to a full-frame fill regardless of fov).

/** Fly Through: A rushes past the camera as B grows in from depth to fill. */
export class FlyThrough extends Camera3DTransition {
  scene(a: HTMLCanvasElement, b: HTMLCanvasElement, p: number): Scene {
    const dist = (this.outH / 2) / Math.tan(0.35);
    return {
      cam: { pos: [0, 0, 0], rot: [0, 0, 0], fov: 0.7 },
      quads: [
        // B: from far behind (p=0) to z=0 identity (p=1).
        { tex: b, world: (c) => shift(c, 0, 0, -1400 * (1 - p)), alpha: clamp01(p * 1.6) },
        // A: from z=0 identity (p=0) rushing toward/past the camera, fading out.
        { tex: a, world: (c) => shift(c, 0, 0, p * dist * 0.82), alpha: clamp01(1 - p * 1.4) },
      ],
    };
  }
}

/** Orbital / Arc: the clip arcs in on a turntable and settles flat. */
export class Orbital extends Camera3DTransition {
  scene(a: HTMLCanvasElement, b: HTMLCanvasElement, p: number): Scene {
    const w = this.outW;
    return {
      cam: { pos: [0, 0, 0], rot: [0, 0, 0], fov: 0.6 },
      quads: [
        // A: identity at p=0, arcs out to the left.
        { tex: a, world: (c) => shift(rot3(c, 0, p * 0.7, 0), -p * w * 0.6, 0, -p * 300), alpha: clamp01(1 - p * 1.3) },
        // B: arcs in from the right, identity at p=1.
        { tex: b, world: (c) => shift(rot3(c, 0, -(1 - p) * 0.7, 0), (1 - p) * w * 0.6, 0, -(1 - p) * 300), alpha: clamp01(p * 1.3) },
      ],
    };
  }
}

/** 3D Room: the frames swing like doors on opposite hinges. */
export class Room3D extends Camera3DTransition {
  scene(a: HTMLCanvasElement, b: HTMLCanvasElement, p: number): Scene {
    const half = this.outW / 2;
    return {
      cam: { pos: [0, 0, 0], rot: [0, 0, 0], fov: 0.7 },
      ambient: 0.7,
      quads: [
        // A: flat at p=0, swings back on the left hinge.
        { tex: a, world: (c) => hingeY(c, -half, p * (Math.PI / 2)) },
        // B: swings in on the right hinge, flat at p=1.
        { tex: b, world: (c) => hingeY(c, half, -(1 - p) * (Math.PI / 2)) },
      ],
    };
  }
}

/** 360 Spin: B spins a full turn and settles flat as A recedes. */
export class Spin360 extends Camera3DTransition {
  scene(a: HTMLCanvasElement, b: HTMLCanvasElement, p: number): Scene {
    return {
      cam: { pos: [0, 0, 0], rot: [0, 0, 0], fov: 0.6 },
      quads: [
        // A: identity at p=0, pushes back and fades.
        { tex: a, world: (c) => shift(c, 0, 0, -p * 500), alpha: clamp01(1 - p * 1.4) },
        // B: one full turn (−2π→0) ending flat at p=1.
        { tex: b, world: (c) => shift(rot3(c, 0, -(1 - p) * Math.PI * 2, 0), 0, 0, -(1 - p) * 400), alpha: clamp01(p * 1.4) },
      ],
    };
  }
}

/** Perspective Slide: tilted frames slide across, un-tilting as they land. */
export class PerspectiveSlide extends Camera3DTransition {
  scene(a: HTMLCanvasElement, b: HTMLCanvasElement, p: number): Scene {
    const w = this.outW;
    return {
      cam: { pos: [0, 0, 0], rot: [0, 0, 0], fov: 0.7 },
      quads: [
        // A: identity at p=0, tilts and slides out left.
        { tex: a, world: (c) => shift(rot3(c, 0, -p * 0.5, 0), -p * w * 1.1, 0, 0), alpha: clamp01(1 - p * 1.2) },
        // B: slides in from the right, un-tilts to identity at p=1.
        { tex: b, world: (c) => shift(rot3(c, 0, (1 - p) * 0.5, 0), (1 - p) * w * 1.1, 0, 0), alpha: clamp01(p * 1.2) },
      ],
    };
  }
}
