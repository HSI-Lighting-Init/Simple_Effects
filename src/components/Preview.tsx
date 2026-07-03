// The Konva preview + direct manipulation.
//
// It draws the project's layers from the Rust-resolved transforms, and lets you
// SELECT a layer and move/scale/rotate it with a Transformer. When a drag or
// transform ends, the changed properties are committed as keyframes at the
// current playhead time (via onCommit) — that's what turns a manual edit into
// animation. The component still owns no interpolation math.
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type Ref } from "react";
import {
  Stage,
  Layer as KLayer,
  Rect,
  Group,
  Path,
  Image as KImage,
  Shape,
  Circle,
  Line,
  Text,
  Transformer,
} from "react-konva";
import Konva from "konva";

import { getShaped } from "../lib/api";
import type { LetterPose } from "../lib/api";
import { sampleTrack, sampleColor } from "../lib/track";
import { drawSurface, drawTexturedQuad } from "../lib/surface3d";
import type { Texture } from "../lib/surface3d";
import { applyEffects } from "../lib/effects";
import { renderShine } from "../lib/shinyClouds";
import { renderGpuFx, gpuFxIsOverlay } from "../lib/gpuFx";
import { getMediaUrl, registerVideoEl } from "../lib/media";
import { createTransition, getTransitionMeta } from "../lib/transitions";
import type { Clip } from "../lib/transitions";
import type { Project } from "../bindings/Project";
import type { Layer } from "../bindings/Layer";
import type { ResolvedLayer } from "../bindings/ResolvedLayer";
import type { ResolvedEffect } from "../bindings/ResolvedEffect";
import type { ResolvedTransition } from "../bindings/ResolvedTransition";
import type { Rgba } from "../bindings/Rgba";
import type { BlendMode } from "../bindings/BlendMode";
import type { TransformEdit } from "../bindings/TransformEdit";
import type { ShapedText } from "../bindings/ShapedText";
import type { LetterOverride } from "../bindings/LetterOverride";
import type { TextStyle } from "../bindings/TextStyle";
import type { TextLayerStyles } from "../bindings/TextLayerStyles";

function rgbaCss(c: Rgba): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a / 255})`;
}

// --- Transition runtime diagnostic (temporary) ------------------------------
// The image-transition sceneFunc writes here; the HUD reads it each React render.
// "OK …" = the engine ran; "CATCH …" = it threw and fell back to a fade. If a
// transition is set but this never shows OK/CATCH, the layer isn't an image and
// isn't using the engine at all (that path also just fades).
export let TRANSITION_DEBUG = "";
export function getTransitionDebug(): string {
  return TRANSITION_DEBUG;
}

// A small pool of reusable offscreen canvases for text compositing (keyed by
// name+size), so styled/animated text doesn't allocate canvases every frame.
const _scratchPool = new Map<string, HTMLCanvasElement>();
function scratch(name: string, w: number, h: number): HTMLCanvasElement {
  let cv = _scratchPool.get(name);
  if (!cv) {
    cv = document.createElement("canvas");
    _scratchPool.set(name, cv);
  }
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  return cv;
}

function composite(blend: BlendMode): GlobalCompositeOperation {
  switch (blend) {
    case "multiply":
      return "multiply";
    case "screen":
      return "screen";
    case "overlay":
      return "overlay";
    default:
      return "source-over";
  }
}

/** Group props that apply a layer's in/out transition (factor 0..1). Dissolve
 *  fades opacity; Slide offsets position from an edge; Wipe hard-clips a
 *  directional reveal. `direction`: 0=left,1=right,2=up,3=down. Comp pixels. */
type GroupTransitionProps = {
  opacity?: number;
  x?: number;
  y?: number;
  clipFunc?: (ctx: Konva.Context) => void;
};
function transitionGroupProps(
  t: ResolvedTransition | null | undefined,
  w: number,
  h: number
): GroupTransitionProps | null {
  if (!t) return null;
  const f = t.factor;
  if (t.kind === "dissolve") return { opacity: f };
  if (t.kind === "slide") {
    const d = 1 - f;
    if (t.direction === 0) return { x: -w * d };
    if (t.direction === 1) return { x: w * d };
    if (t.direction === 2) return { y: -h * d };
    return { y: h * d };
  }
  if (t.kind === "wipe") {
    return {
      clipFunc: (ctx: Konva.Context) => {
        let x = 0,
          y = 0,
          cw = w,
          ch = h;
        if (t.direction === 0) cw = w * f;
        else if (t.direction === 1) {
          x = w * (1 - f);
          cw = w * f;
        } else if (t.direction === 2) ch = h * f;
        else {
          y = h * (1 - f);
          ch = h * f;
        }
        (ctx as unknown as CanvasRenderingContext2D).rect(x, y, cw, ch);
      },
    };
  }
  return null;
}

/** Interaction props shared by every layer node (everything except the ref). */
type Interaction = {
  listening: boolean;
  draggable: boolean;
  onClick: (e: Konva.KonvaEventObject<MouseEvent>) => void;
  onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragEnd: () => void;
  onTransformEnd: () => void;
  onContextMenu: (e: Konva.KonvaEventObject<MouseEvent>) => void;
};

type NodeRef = (n: Konva.Node | null) => void;

// A surface decal maps its texture through hundreds of clipped triangles every
// frame, so a 10-megapixel photo wrapped on a small cylinder is what makes
// playback stall. Cap the texture at a sane size (cached per image — built once)
// so each per-triangle drawImage is cheap. The decal is shown small, so there's
// no visible quality loss.
const downscaleCache = new WeakMap<HTMLImageElement, HTMLCanvasElement>();
function cappedTexture(img: HTMLImageElement, max = 1280): HTMLImageElement | HTMLCanvasElement {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h || Math.max(w, h) <= max) return img;
  const cached = downscaleCache.get(img);
  if (cached) return cached;
  const s = max / Math.max(w, h);
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(w * s));
  cv.height = Math.max(1, Math.round(h * s));
  const ctx = cv.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
  }
  downscaleCache.set(img, cv);
  return cv;
}

/** Load a data: URL / path into an HTMLImageElement (null until ready). */
function useImage(src?: string): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) {
      setImg(null);
      return;
    }
    const im = new window.Image();
    im.onload = () => setImg(im);
    im.src = src;
    return () => {
      im.onload = null;
    };
  }, [src]);
  return img;
}

// A flat image with an effect stack. Renders the image through an offscreen
// canvas — colour/blur effects via the canvas `filter`, then each wipe as a
// gradient mask — and composites the result. Same transform contract as
// ImageNode, so it selects / drags / keyframes the same way.
function EffectImageNode({
  src,
  r,
  interaction,
  registerRef,
}: {
  src?: string;
  r: ResolvedLayer;
  interaction: Interaction;
  registerRef: NodeRef;
}) {
  const img = useImage(src);
  const offRef = useRef<HTMLCanvasElement | null>(null);
  if (!img) return null;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;

  return (
    <Shape
      ref={registerRef}
      x={r.x}
      y={r.y}
      width={w}
      height={h}
      offsetX={w / 2}
      offsetY={h / 2}
      scaleX={r.scaleX}
      scaleY={r.scaleY}
      rotation={r.rotation}
      opacity={r.opacity}
      sceneFunc={(ctx) => {
        const off = offRef.current ?? (offRef.current = document.createElement("canvas"));
        const tex = applyEffects(off, img, w, h, r.effects);
        (ctx as unknown as CanvasRenderingContext2D).drawImage(tex, 0, 0);
      }}
      hitFunc={(ctx, shape) => {
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        ctx.closePath();
        ctx.fillStrokeShape(shape);
      }}
      {...interaction}
    />
  );
}

// A flat image whose in/out window uses a transition-engine effect (fade, cube,
// shatter, glitch…). Renders the transition between an empty A (so lower layers
// show through) and B = this clip (with its effect stack applied) at the
// resolved progress `factor`, into an offscreen canvas. Same transform contract
// as ImageNode/EffectImageNode, so it selects/drags/keyframes identically. The
// instance is rebuilt per frame so keyframed effects on B stay current.
const DIRS: ("left" | "right" | "up" | "down")[] = ["left", "right", "up", "down"];
function TransitionImageNode({
  src,
  r,
  transition,
  interaction,
  registerRef,
}: {
  src?: string;
  r: ResolvedLayer;
  transition: ResolvedTransition;
  interaction: Interaction;
  registerRef: NodeRef;
}) {
  const img = useImage(src);
  const bRef = useRef<HTMLCanvasElement | null>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null);
  if (!img) return null;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  return (
    <Shape
      ref={registerRef}
      x={r.x}
      y={r.y}
      width={w}
      height={h}
      offsetX={w / 2}
      offsetY={h / 2}
      scaleX={r.scaleX}
      scaleY={r.scaleY}
      rotation={r.rotation}
      opacity={r.opacity}
      sceneFunc={(ctx) => {
        // The clip, with its effect stack baked in.
        const bcv = bRef.current ?? (bRef.current = document.createElement("canvas"));
        const texClip: CanvasImageSource = r.effects.length > 0 ? applyEffects(bcv, img, w, h, r.effects) : img;
        const clip: Clip = { source: texClip, width: w, height: h };
        const empty: Clip = { source: null, width: 0, height: 0 };
        // Most transitions build up clip B (reveal it in) → clip = B, A = empty.
        // But "feature A" transitions (disintegration/fold/peel) animate clip A to
        // reveal B; with an empty A there's nothing to animate, so they'd collapse
        // to a fade. For those, put the clip on A and play the transition in
        // reverse so the clip assembles in (or breaks apart on the way out).
        const featureA = getTransitionMeta(transition.engine ?? "")?.feature === "a";
        const A: Clip = featureA ? clip : empty;
        const B: Clip = featureA ? empty : clip;
        const texB = texClip; // the plain resting clip, for the seam hand-off
        const dir = DIRS[transition.direction] ?? "left";
        const off = offRef.current ?? (offRef.current = document.createElement("canvas"));
        // Per-clip variables (the math knobs), stored as a JSON object.
        let userParams: Record<string, unknown> = {};
        if (transition.params) {
          try {
            userParams = JSON.parse(transition.params) as Record<string, unknown>;
          } catch {
            userParams = {};
          }
        }
        const c = ctx as unknown as CanvasRenderingContext2D;
        const f = transition.factor;
        // Smooth the seams: many transitions (esp. the 3D camera moves) don't
        // land on an identity framing at f=1, so a hard hand-off to the plain
        // image node pops. Over the last EDGE of the window we crossfade the
        // engine output → the plain clip (so f=1 == the normal render), and over
        // the first EDGE we ramp up from fully transparent (so f=0 reveals what's
        // beneath). Both ends therefore match their neighbours exactly.
        const EDGE = 0.12;
        const fromEmpty = f <= EDGE ? f / EDGE : 1; // 0 at f=0 → 1 after the edge
        const toPlain = f >= 1 - EDGE ? (f - (1 - EDGE)) / EDGE : 0; // →1 as f→1
        try {
          const tr = createTransition(transition.engine ?? "fade", A, B, {
            outWidth: w,
            outHeight: h,
            direction: dir,
            // This is always a single-clip transition (the other side is empty),
            // so distortion transitions drive themselves instead of a crossfade.
            solo: true,
            ...userParams,
          });
          // Feature-A transitions run in reverse: the clip (on A) is fully present
          // at f=1 (progress 0) and gone at f=0 (progress 1), so it assembles in /
          // breaks apart with the window instead of just fading.
          tr.render(off, featureA ? 1 - f : f);
          TRANSITION_DEBUG = `OK engine=${transition.engine} f=${f.toFixed(2)} featureA=${featureA}`;
          if (featureA) {
            // The effect itself carries the transition (the clip disintegrates /
            // folds / distorts, or is opaque and resolves). Drawing it through the
            // seam alpha ramp would just fade it — which, on a long transition,
            // is ALL you'd see. So draw it straight; it already lands on the clean
            // clip at f=1 and on transparency/scramble at f=0.
            c.drawImage(off, 0, 0);
          } else {
            c.globalAlpha = fromEmpty;
            c.drawImage(off, 0, 0);
            if (toPlain > 0) {
              c.globalAlpha = toPlain; // converge onto the exact resting frame
              c.drawImage(texB, 0, 0);
            }
            c.globalAlpha = 1;
          }
        } catch (err) {
          // Unknown/failed transition → fall back to a plain opacity fade.
          TRANSITION_DEBUG = `CATCH engine=${transition.engine}: ${err instanceof Error ? err.message : String(err)}`;
          c.globalAlpha = f;
          c.drawImage(texB, 0, 0);
          c.globalAlpha = 1;
        }
      }}
      hitFunc={(ctx, shape) => {
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        ctx.closePath();
        ctx.fillStrokeShape(shape);
      }}
      {...interaction}
    />
  );
}

// Fetch a text layer's shaped glyphs (re-fetched when content/size/font change).
// Null for non-text layers.
function useShaped(layer: Layer): ShapedText | null {
  const k = layer.kind;
  const isText = k.kind === "text";
  const content = isText ? k.content : "";
  const size = isText ? k.size : 0;
  const font = isText ? k.font : "";
  const [shaped, setShaped] = useState<ShapedText | null>(null);

  useEffect(() => {
    if (!isText) {
      setShaped(null);
      return;
    }
    let alive = true;
    getShaped(layer.id).then((s: ShapedText | null) => {
      if (alive) setShaped(s && s.glyphs.length > 0 ? s : null);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.id, isText, content, size, font]);

  return shaped;
}

// Rasterise a text layer's shaped glyphs into `off`, applying each glyph's
// per-letter transform (`letters`) — so animation presets (ScatterIn, RiseUp…)
// and the decompose blend animate even when the text is pinned to a 3D shape.
// Supersampled for crispness. The box matches the Rust decal dims (so the wrap
// aspect is right); large offsets clip at the box edge.
function rasterizeText(
  off: HTMLCanvasElement,
  shaped: ShapedText,
  color: Rgba,
  letters: ResolvedLayer["letters"]
): HTMLCanvasElement {
  const SS = 2;
  const w = Math.max(1, Math.ceil(shaped.width));
  const h = Math.max(1, Math.ceil(shaped.ascender + shaped.descender));
  if (off.width !== w * SS || off.height !== h * SS) {
    off.width = w * SS;
    off.height = h * SS;
  }
  const ctx = off.getContext("2d");
  if (!ctx) return off;
  ctx.setTransform(SS, 0, 0, SS, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
  const baseAlpha = color.a / 255;
  const baseline = shaped.ascender;
  shaped.glyphs.forEach((g, i) => {
    if (!g.d) return;
    const lt = letters[i];
    ctx.save();
    ctx.globalAlpha = baseAlpha * (lt?.opacity ?? 1);
    // Same transform contract as the flat glyph renderer: position at (g.x), with
    // scale/rotation about the glyph centre (cx, cy), plus the per-letter offset.
    ctx.translate(g.x + g.cx + (lt?.dx ?? 0), baseline + g.cy + (lt?.dy ?? 0));
    ctx.rotate(((lt?.rotation ?? 0) * Math.PI) / 180);
    const sc = lt?.scale ?? 1;
    ctx.scale(sc, sc);
    ctx.translate(-g.cx, -g.cy);
    ctx.fill(new Path2D(g.d));
    ctx.restore();
  });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return off;
}

// Draw one glyph's ordered fill/stroke paint stack. `style` may be null (plain
// text with a per-letter colour animator); `letterFill` overrides the fill.
// Stroke `position` is honoured with clipping (inside = clip to glyph, outside =
// clip to its complement).
function paintGlyph(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  letterAlpha: number,
  style: TextStyle | null,
  base: Rgba,
  letterFill?: Rgba | null
) {
  const fills = letterFill
    ? [{ color: letterFill, opacity: 100 }]
    : style && style.fills.length
    ? style.fills
    : [{ color: base, opacity: 100 }];
  const strokes = style ? style.strokes : [];
  const drawFills = () => {
    for (const f of fills) {
      ctx.globalAlpha = letterAlpha * (f.color.a / 255) * (f.opacity / 100);
      ctx.fillStyle = `rgb(${f.color.r},${f.color.g},${f.color.b})`;
      ctx.fill(path);
    }
  };
  const drawStrokes = () => {
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const s of strokes) {
      if (s.width <= 0) continue;
      ctx.globalAlpha = letterAlpha * (s.color.a / 255) * (s.opacity / 100);
      ctx.strokeStyle = `rgb(${s.color.r},${s.color.g},${s.color.b})`;
      if (s.position === "center") {
        ctx.lineWidth = s.width;
        ctx.stroke(path);
      } else if (s.position === "inside") {
        ctx.save();
        ctx.clip(path);
        ctx.lineWidth = s.width * 2;
        ctx.stroke(path);
        ctx.restore();
      } else {
        const comp = new Path2D();
        comp.rect(-100000, -100000, 200000, 200000);
        comp.addPath(path);
        ctx.save();
        ctx.clip(comp, "evenodd");
        ctx.lineWidth = s.width * 2;
        ctx.stroke(path);
        ctx.restore();
      }
    }
  };
  if (style?.fillOverStroke) {
    drawStrokes();
    drawFills();
  } else {
    drawFills();
    drawStrokes();
  }
}

// Fill `src`'s alpha shape with `color`, optionally blurred — for shadows/glows.
function tintedAlpha(src: HTMLCanvasElement, w: number, h: number, color: Rgba, blurPx: number, name: string): HTMLCanvasElement {
  const t = scratch(name, w, h);
  const c = t.getContext("2d");
  if (c) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = "source-over";
    c.filter = "none";
    c.clearRect(0, 0, w, h);
    c.drawImage(src, 0, 0);
    c.globalCompositeOperation = "source-in";
    c.fillStyle = `rgb(${color.r},${color.g},${color.b})`;
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = "source-over";
  }
  if (blurPx <= 0.1) return t;
  const b = scratch(name + "-b", w, h);
  const bc = b.getContext("2d");
  if (bc) {
    bc.setTransform(1, 0, 0, 1, 0, 0);
    bc.clearRect(0, 0, w, h);
    bc.filter = `blur(${blurPx}px)`;
    bc.drawImage(t, 0, 0);
    bc.filter = "none";
  }
  return b;
}

// Composite the whole-layer styles (shadow → outer glow → text → gradient →
// inner glow → bevel) onto `ctx` from the plain `textCv`. All px are device px
// (already × SS). Stylised canvas-2D approximations of the AE layer styles.
function applyLayerStyles(ctx: CanvasRenderingContext2D, textCv: HTMLCanvasElement, w: number, h: number, ls: TextLayerStyles, ss: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (ls.dropShadow) {
    const d = ls.dropShadow;
    const rad = (d.angle * Math.PI) / 180;
    const ox = Math.cos(rad) * d.distance * ss;
    const oy = -Math.sin(rad) * d.distance * ss;
    const sh = tintedAlpha(textCv, w, h, d.color, d.size * ss, "ls-shadow");
    ctx.save();
    ctx.globalAlpha = (d.opacity / 100) * (d.color.a / 255);
    ctx.drawImage(sh, ox, oy);
    ctx.restore();
  }
  if (ls.outerGlow) {
    const g = ls.outerGlow;
    const gl = tintedAlpha(textCv, w, h, g.color, g.size * ss, "ls-oglow");
    ctx.save();
    ctx.globalCompositeOperation = composite(g.mode);
    ctx.globalAlpha = g.opacity / 100;
    ctx.drawImage(gl, 0, 0);
    if (g.range > 50) ctx.drawImage(gl, 0, 0); // denser glow
    ctx.restore();
  }
  // Base text.
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.drawImage(textCv, 0, 0);
  ctx.restore();
  if (ls.gradient && ls.gradient.stops.length >= 2) {
    const go = ls.gradient;
    const gcv = scratch("ls-grad", w, h);
    const gc = gcv.getContext("2d");
    if (gc) {
      gc.setTransform(1, 0, 0, 1, 0, 0);
      gc.clearRect(0, 0, w, h);
      const rad = (go.angle * Math.PI) / 180;
      const cx = w / 2, cy = h / 2, len = Math.max(w, h) / 2;
      const grad = gc.createLinearGradient(cx - Math.cos(rad) * len, cy - Math.sin(rad) * len, cx + Math.cos(rad) * len, cy + Math.sin(rad) * len);
      for (const st of [...go.stops].sort((a, b) => a.position - b.position)) {
        grad.addColorStop(Math.max(0, Math.min(1, st.position / 100)), `rgba(${st.color.r},${st.color.g},${st.color.b},${st.color.a / 255})`);
      }
      gc.fillStyle = grad;
      gc.fillRect(0, 0, w, h);
      gc.globalCompositeOperation = "destination-in";
      gc.drawImage(textCv, 0, 0);
      gc.globalCompositeOperation = "source-over";
    }
    ctx.save();
    ctx.globalCompositeOperation = composite(go.blend);
    ctx.globalAlpha = go.opacity / 100;
    ctx.drawImage(gcv, 0, 0);
    ctx.restore();
  }
  if (ls.innerGlow) {
    const ig = ls.innerGlow;
    const gl = tintedAlpha(textCv, w, h, ig.color, ig.size * ss, "ls-iglow");
    ctx.save();
    ctx.globalCompositeOperation = "source-atop"; // clip to the text
    ctx.globalAlpha = ig.opacity / 100;
    ctx.drawImage(gl, 0, 0);
    ctx.restore();
  }
  if (ls.bevel) {
    const b = ls.bevel;
    const rad = (b.angle * Math.PI) / 180;
    const off = (b.size * 0.3 + 1) * ss;
    const ox = Math.cos(rad) * off, oy = -Math.sin(rad) * off;
    const hi = tintedAlpha(textCv, w, h, { r: 255, g: 255, b: 255, a: 255 }, b.soften * ss, "ls-bevhi");
    const sh = tintedAlpha(textCv, w, h, { r: 0, g: 0, b: 0, a: 255 }, b.soften * ss, "ls-bevsh");
    const amt = Math.max(0, Math.min(1, (b.depth / 100) * 0.6));
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    ctx.globalAlpha = amt;
    ctx.drawImage(hi, -ox, -oy);
    ctx.drawImage(sh, ox, oy);
    ctx.restore();
  }
}

// Rasterise a text run with fills/strokes/order + typography (tracking, baseline)
// + per-letter animator properties (position/scale/rotation/opacity/skew/blur/
// tracking/fill + optional 2.5D per-char rotation) into a padded, supersampled
// canvas, then composite whole-layer styles. Returns placement so the caller can
// align it with the plain vector layout.
function rasterizeStyledText(
  off: HTMLCanvasElement,
  shaped: ShapedText,
  base: Rgba,
  letters: ResolvedLayer["letters"],
  style: TextStyle | null,
  layerStyles: TextLayerStyles | null,
  perChar3d: boolean
): { logicalW: number; logicalH: number; imageX: number; imageY: number } {
  const SS = 2;
  const count = shaped.glyphs.length;
  const baseTrack = style?.tracking ?? 0;
  const baselineShift = style?.baselineShift ?? 0;
  const perLetterTrack = letters.reduce((s, l) => s + (l?.tracking ?? 0), 0);
  const trackedWidth = Math.max(1, shaped.width + baseTrack * Math.max(0, count - 1) + perLetterTrack);
  const maxStroke = (style?.strokes ?? []).reduce((m, s) => Math.max(m, s.position === "center" ? s.width / 2 : s.width), 0);
  let maxBlur = 0, maxOff = 0, maxScale = 1;
  for (const l of letters) {
    if (!l) continue;
    maxBlur = Math.max(maxBlur, l.blur);
    maxOff = Math.max(maxOff, Math.abs(l.dx), Math.abs(l.dy));
    maxScale = Math.max(maxScale, l.scale);
  }
  // Extra room for layer styles (shadow reach, glow/bevel radius).
  let styleExtent = 0;
  if (layerStyles) {
    const d = layerStyles.dropShadow;
    styleExtent = Math.max(
      styleExtent,
      d ? d.distance + d.size : 0,
      layerStyles.outerGlow?.size ?? 0,
      layerStyles.bevel?.size ?? 0
    );
  }
  const pad = Math.ceil(maxStroke + Math.abs(baselineShift) + maxBlur + maxOff + (maxScale - 1) * shaped.ascender + styleExtent + 4);
  const logicalW = Math.ceil(trackedWidth) + pad * 2;
  const logicalH = Math.ceil(shaped.ascender + shaped.descender) + pad * 2;
  if (off.width !== logicalW * SS || off.height !== logicalH * SS) {
    off.width = logicalW * SS;
    off.height = logicalH * SS;
  }

  const baselineTop = shaped.ascender - baselineShift;
  const drawGlyphs = (ctx: CanvasRenderingContext2D) => {
    ctx.setTransform(SS, 0, 0, SS, 0, 0);
    ctx.clearRect(0, 0, logicalW, logicalH);
    let trackAcc = 0;
    shaped.glyphs.forEach((g, i) => {
      const lt = letters[i];
      if (g.d) {
        ctx.save();
        ctx.translate(pad + g.x + baseTrack * i + trackAcc + g.cx + (lt?.dx ?? 0), pad + baselineTop + g.cy + (lt?.dy ?? 0));
        ctx.rotate(((lt?.rotation ?? 0) * Math.PI) / 180);
        let sx = lt?.scale ?? 1, sy = lt?.scale ?? 1;
        const use3d = perChar3d && lt && (lt.rx !== 0 || lt.ry !== 0 || lt.dz !== 0);
        let shearY = 0, shearX = 0;
        if (use3d && lt) {
          const ryR = (lt.ry * Math.PI) / 180;
          const rxR = (lt.rx * Math.PI) / 180;
          const persp = lt.dz ? 800 / (800 - Math.max(-700, Math.min(700, lt.dz))) : 1;
          // Foreshorten along each axis + a perspective shear so it reads as a
          // real turn/tilt rather than a flat squash (stylised 2.5D).
          sx *= Math.cos(ryR) * persp;
          sy *= Math.cos(rxR) * persp;
          shearY = Math.sin(ryR) * 0.45;
          shearX = -Math.sin(rxR) * 0.45;
        }
        ctx.scale(sx, sy);
        if (use3d) ctx.transform(1, shearY, shearX, 1, 0, 0);
        if (lt?.skew) {
          const ax = ((lt.skewAxis ?? 0) * Math.PI) / 180;
          ctx.rotate(ax);
          ctx.transform(1, 0, Math.tan((lt.skew * Math.PI) / 180), 1, 0, 0);
          ctx.rotate(-ax);
        }
        if (lt?.blur) ctx.filter = `blur(${lt.blur}px)`;
        ctx.translate(-g.cx, -g.cy);
        paintGlyph(ctx, new Path2D(g.d), lt?.opacity ?? 1, style, base, lt?.fill ?? null);
        ctx.restore();
      }
      trackAcc += lt?.tracking ?? 0;
    });
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  const offCtx = off.getContext("2d");
  if (offCtx) {
    if (!layerStyles) {
      drawGlyphs(offCtx);
    } else {
      const textCv = scratch("ls-text", off.width, off.height);
      const tctx = textCv.getContext("2d");
      if (tctx) drawGlyphs(tctx);
      applyLayerStyles(offCtx, textCv, off.width, off.height, layerStyles, SS);
    }
  }
  const imageY = (shaped.ascender - shaped.descender) / 2 - shaped.ascender - pad;
  return { logicalW, logicalH, imageX: -pad - trackedWidth / 2, imageY };
}

function ImageNode({
  src,
  r,
  interaction,
  registerRef,
}: {
  src?: string;
  r: ResolvedLayer;
  interaction: Interaction;
  registerRef: NodeRef;
}) {
  const img = useImage(src);
  if (!img) return null;
  return (
    <KImage
      ref={registerRef}
      image={img}
      x={r.x}
      y={r.y}
      offsetX={img.width / 2}
      offsetY={img.height / 2}
      scaleX={r.scaleX}
      scaleY={r.scaleY}
      rotation={r.rotation}
      opacity={r.opacity}
      {...interaction}
    />
  );
}

// A video layer. Draws the current frame of an <HTMLVideoElement> whose source
// time tracks the playhead (comp time since the layer start). Selects/drags/
// keyframes exactly like ImageNode. During playback a Konva.Animation keeps the
// layer redrawing so frames flow; while paused we seek and redraw on 'seeked'.
// The element is registered so the deterministic export can seek it per frame.
function VideoNode({
  layerId,
  src,
  r,
  playing,
  timeMs,
  layerStartMs,
  durationMs,
  interaction,
  registerRef,
}: {
  layerId: number;
  src: string;
  r: ResolvedLayer;
  playing: boolean;
  timeMs: number;
  layerStartMs: number;
  durationMs: number;
  interaction: Interaction;
  registerRef: NodeRef;
}) {
  const [vid, setVid] = useState<HTMLVideoElement | null>(null);
  const imgRef = useRef<Konva.Image | null>(null);

  // Create the element once per source (blob URL is canvas-safe for export).
  useEffect(() => {
    let alive = true;
    let el: HTMLVideoElement | null = null;
    getMediaUrl(src).then((url) => {
      if (!alive) return;
      const v = document.createElement("video");
      v.playsInline = true;
      v.preload = "auto";
      v.src = url;
      v.onloadeddata = () => {
        registerVideoEl(layerId, v);
        setVid(v);
        imgRef.current?.getLayer()?.batchDraw();
      };
      v.onseeked = () => imgRef.current?.getLayer()?.batchDraw();
      el = v;
    });
    return () => {
      alive = false;
      registerVideoEl(layerId, null);
      if (el) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
    };
  }, [src, layerId]);

  // Sync the source time / play state to the playhead.
  useEffect(() => {
    const v = vid;
    if (!v) return;
    const durSec = durationMs > 0 ? durationMs / 1000 : Infinity;
    const localSec = Math.max(0, (timeMs - layerStartMs) / 1000);
    const target = Number.isFinite(durSec) ? Math.min(localSec, durSec - 0.001) : localSec;
    if (playing) {
      if (Math.abs(v.currentTime - target) > 0.3) v.currentTime = Math.max(0, target);
      // Play with sound; if the autoplay policy blocks unmuted playback, retry
      // muted so the frames still advance (video stays visible, just silent).
      if (v.paused)
        v.play().catch(() => {
          v.muted = true;
          v.play().catch(() => {});
        });
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - target) > 0.02) v.currentTime = Math.max(0, target);
    }
  }, [vid, playing, timeMs, layerStartMs, durationMs]);

  // While playing, keep the layer repainting so the moving frame shows.
  useEffect(() => {
    if (!playing || !vid) return;
    const layer = imgRef.current?.getLayer();
    if (!layer) return;
    const anim = new Konva.Animation(() => {}, layer);
    anim.start();
    return () => {
      anim.stop();
    };
  }, [playing, vid]);

  if (!vid) return null;
  const w = vid.videoWidth || 1;
  const h = vid.videoHeight || 1;
  return (
    <KImage
      ref={(n) => {
        imgRef.current = n;
        registerRef(n);
      }}
      image={vid}
      x={r.x}
      y={r.y}
      width={w}
      height={h}
      offsetX={w / 2}
      offsetY={h / 2}
      scaleX={r.scaleX}
      scaleY={r.scaleY}
      rotation={r.rotation}
      opacity={r.opacity}
      {...interaction}
    />
  );
}

// A nested composition (precomp). Renders its resolved children read-only inside
// a Konva Group carrying the group's own transform/opacity, so it moves/scales/
// keyframes as one unit and its transition/effects apply to the whole thing. An
// invisible hit rect (sized to the children's bounds) makes the group selectable
// and draggable; double-click enters it to edit the children.
function GroupNode({
  layer,
  r,
  screenScale,
  interaction,
  registerRef,
  selected,
  onEnter,
  renderChild,
}: {
  layer: Layer;
  r: ResolvedLayer;
  screenScale: number;
  interaction: Interaction;
  registerRef: NodeRef;
  selected: boolean;
  onEnter: (layerId: number) => void;
  renderChild: (child: Layer, cr: ResolvedLayer | undefined) => ReactElement | null;
}) {
  const groupRef = useRef<Konva.Group | null>(null);
  const [hit, setHit] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const resolvedChildren = r.group?.children ?? [];
  const childLayers = layer.kind.kind === "group" ? layer.kind.children : [];

  // Size the hit/selection rect to the children's bounding box after they render.
  // Bail out when unchanged so we don't loop (getClientRect returns a fresh box).
  useLayoutEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    const box = g.getClientRect({ relativeTo: g, skipStroke: true, skipShadow: true });
    if (box.width <= 0 || box.height <= 0) return;
    setHit((prev) =>
      prev.x === box.x && prev.y === box.y && prev.width === box.width && prev.height === box.height
        ? prev
        : box
    );
  });

  return (
    <Group
      ref={(n) => {
        groupRef.current = n;
        registerRef(n);
      }}
      x={r.x}
      y={r.y}
      scaleX={r.scaleX}
      scaleY={r.scaleY}
      rotation={r.rotation}
      opacity={r.opacity}
      listening={interaction.listening}
      draggable={interaction.draggable}
      onDragMove={interaction.onDragMove}
      onDragEnd={interaction.onDragEnd}
      onTransformEnd={interaction.onTransformEnd}
      onContextMenu={interaction.onContextMenu}
    >
      {/* Hit / drag area (children are read-only, so events fall through here). */}
      <Rect
        x={hit.x}
        y={hit.y}
        width={hit.width}
        height={hit.height}
        fill="#000"
        opacity={0.001}
        onClick={interaction.onClick}
        onDblClick={() => onEnter(layer.id)}
      />
      {resolvedChildren.map((cr, i) => renderChild(childLayers[i], cr))}
      {selected && (
        <Rect
          x={hit.x}
          y={hit.y}
          width={hit.width}
          height={hit.height}
          stroke="#e08a3c"
          strokeWidth={1.5 * screenScale}
          dash={[6 * screenScale, 4 * screenScale]}
          listening={false}
        />
      )}
    </Group>
  );
}

type DrawCtx = Parameters<typeof drawSurface>[0];

/** Stroke a closed polygon of comp-space points on a Konva context. */
function strokePoly(ctx: DrawCtx, pts: { x: number; y: number }[]) {
  if (pts.length < 2) return;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

/** Load a set of image URLs (data URLs) into decoded HTMLImageElements. Used by
 *  the multi-frame grid, where each cell has its own image. */
function useImageMap(urls: string[]): Map<string, HTMLImageElement> {
  const [map, setMap] = useState<Map<string, HTMLImageElement>>(new Map());
  const key = urls.join("|");
  useEffect(() => {
    const uniq = [...new Set(urls.filter(Boolean))];
    if (uniq.length === 0) {
      setMap(new Map());
      return;
    }
    let alive = true;
    const next = new Map<string, HTMLImageElement>();
    let pending = uniq.length;
    const done = () => {
      if (--pending === 0 && alive) setMap(next);
    };
    for (const u of uniq) {
      const im = new window.Image();
      im.onload = () => {
        next.set(u, im);
        done();
      };
      im.onerror = done;
      im.src = u;
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return map;
}

/** Render a cell's transition into `out` and return it as the cell's texture.
 *  `base` is the image (with its effects already baked). Mirrors the layer
 *  TransitionImageNode: feature-A engines animate the clip (played in reverse so
 *  it assembles in), others reveal the clip from empty. On failure returns base. */
function cellTransitionTexture(
  out: HTMLCanvasElement,
  base: Texture,
  iw: number,
  ih: number,
  transition: NonNullable<ResolvedLayer["frameGrid"]>["cells"][number]["transition"]
): Texture {
  if (!transition?.engine) return base;
  const featureA = getTransitionMeta(transition.engine)?.feature === "a";
  const clip: Clip = { source: base, width: iw, height: ih };
  const empty: Clip = { source: null, width: 0, height: 0 };
  const dir = DIRS[transition.direction] ?? "left";
  let userParams: Record<string, unknown> = {};
  if (transition.params) {
    try {
      userParams = JSON.parse(transition.params) as Record<string, unknown>;
    } catch {
      userParams = {};
    }
  }
  try {
    const tr = createTransition(transition.engine, featureA ? clip : empty, featureA ? empty : clip, {
      outWidth: iw,
      outHeight: ih,
      direction: dir,
      solo: true,
      ...userParams,
    });
    tr.render(out, featureA ? 1 - transition.factor : transition.factor);
    return out;
  } catch {
    return base;
  }
}

/** A quad's 4 corners as flat local-space points (grids use hw = 1). */
function quadPts(q: { corners: { hx: number; hy: number; hw: number }[] }): { x: number; y: number }[] {
  return q.corners.map((c) => ({ x: c.hx / (c.hw || 1), y: c.hy / (c.hw || 1) }));
}

/** Point-in-polygon (ray cast) for locating which cell was clicked. */
function pointInPoly(px: number, py: number, pts: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// A multi-frame grid: a warpable lattice of image cells. Each cell paints its own
// image (with its own effect stack) into its quad; the whole thing draws under the
// layer's transform like any other node. Clicking a cell selects the layer AND
// reports the clicked cell (so the inspector can set/clear that cell's image).
// Vertex-warp editing arrives in a later phase.
function FrameGridNode({
  layer,
  r,
  images,
  interaction,
  registerRef,
  selected,
  screenScale,
  onPickCell,
  onCellContextMenu,
  onMoveVertices,
}: {
  layer: Layer;
  r: ResolvedLayer;
  images: Record<string, string>;
  interaction: Interaction;
  registerRef: NodeRef;
  selected: boolean;
  screenScale: number;
  onPickCell: (layerId: number, cell: number) => void;
  onCellContextMenu?: (layerId: number, cell: number, x: number, y: number) => void;
  onMoveVertices: (layerId: number, updates: { index: number; x: number; y: number }[]) => Promise<void>;
}) {
  const grid = r.frameGrid;
  const bgUrl = grid?.background ? images[grid.background] : "";
  const cellUrls = (grid?.cells ?? []).map((c) => (c.src ? images[c.src] : "")).filter(Boolean);
  if (bgUrl) cellUrls.push(bgUrl);
  const loaded = useImageMap(cellUrls);
  const fxRefs = useRef<HTMLCanvasElement[]>([]);
  const trRefs = useRef<HTMLCanvasElement[]>([]);
  // Per-cell crop of the shared background image (its aligned slice).
  const cropRefs = useRef<HTMLCanvasElement[]>([]);
  // Offscreen canvases for a whole-grid transition: the grid rasterised into one
  // texture, and the transition engine's output.
  const gridRasterRef = useRef<HTMLCanvasElement | null>(null);
  const gridTransRef = useRef<HTMLCanvasElement | null>(null);
  // Live vertex positions while dragging a handle (index → local x/y). Kept in a
  // ref so a drag doesn't trigger React re-renders (which would fight Konva's own
  // drag position); we batchDraw manually instead.
  const liveRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const handleRefs = useRef<Map<number, Konva.Circle>>(new Map());
  const [selVerts, setSelVerts] = useState<Set<number>>(new Set());
  const constrain = layer.kind.kind === "framegrid" ? layer.kind.constrain : "freeform";
  const verts = grid?.vertices ?? [];
  const vcols = (grid?.cols ?? 0) + 1;

  // Fresh resolved data arrived (backend round-trip finished) → drop the live
  // override so we render the committed warp.
  const vertsRef = grid?.vertices;
  useEffect(() => {
    liveRef.current = new Map();
  }, [vertsRef]);

  if (!grid) return null;
  const layerId = layer.id;

  // A vertex's current position, preferring the live drag override.
  const vpos = (i: number) => liveRef.current.get(i) ?? { x: verts[i].x, y: verts[i].y };

  // The 4 lattice vertex indices for a cell's (possibly merged) block, in the
  // quad's UV corner order.
  const cellVerts = (i: number) => {
    const cell = grid.cells[i];
    const rr = cell.row;
    const cc = cell.col;
    const rs = cell.rowSpan;
    const cs = cell.colSpan;
    return [
      rr * vcols + cc,
      rr * vcols + (cc + cs),
      (rr + rs) * vcols + (cc + cs),
      (rr + rs) * vcols + cc,
    ];
  };

  // A cell's quad with any live-dragged corners overridden (keeps UVs).
  const liveQuad = (i: number) => {
    const q = grid.cells[i].quad;
    if (liveRef.current.size === 0) return q;
    const vi = cellVerts(i);
    return {
      ...q,
      corners: q.corners.map((corner, k) => {
        const lp = liveRef.current.get(vi[k]);
        return lp ? { ...corner, hx: lp.x, hy: lp.y, hw: 1 } : corner;
      }),
    };
  };

  // Which vertices move (and to where) when vertex `i` is dragged to (nx, ny).
  const computeUpdates = (i: number, nx: number, ny: number): { index: number; x: number; y: number }[] => {
    if (constrain === "rails") {
      const rr = Math.floor(i / vcols);
      const cc = i % vcols;
      const m = new Map<number, { index: number; x: number; y: number }>();
      for (let r2 = 0; r2 < grid.rows + 1; r2++) {
        const idx = r2 * vcols + cc;
        m.set(idx, { index: idx, x: nx, y: verts[idx].y });
      }
      for (let c2 = 0; c2 < vcols; c2++) {
        const idx = rr * vcols + c2;
        const ex = m.get(idx);
        m.set(idx, { index: idx, x: ex ? ex.x : verts[idx].x, y: ny });
      }
      return [...m.values()];
    }
    if (selVerts.has(i) && selVerts.size > 1) {
      const dx = nx - verts[i].x;
      const dy = ny - verts[i].y;
      return [...selVerts].map((j) => ({ index: j, x: verts[j].x + dx, y: verts[j].y + dy }));
    }
    return [{ index: i, x: nx, y: ny }];
  };

  return (
    <Group
      ref={registerRef}
      x={r.x}
      y={r.y}
      scaleX={r.scaleX}
      scaleY={r.scaleY}
      rotation={r.rotation}
      opacity={r.opacity}
      listening={interaction.listening}
      draggable={interaction.draggable}
      onDragMove={interaction.onDragMove}
      onDragEnd={interaction.onDragEnd}
      onTransformEnd={interaction.onTransformEnd}
      onContextMenu={interaction.onContextMenu}
    >
      <Shape
        fill="#000"
        sceneFunc={(ctx) => {
          const c = ctx as unknown as CanvasRenderingContext2D;
          // A whole-grid transition (engine set on the layer) rasterises every
          // cell into one texture and runs the transition engine on that, so the
          // grid transitions as a single image instead of falling back to a fade.
          const gridTransition = r.transition?.engine ? r.transition : null;

          // The shared background image (if any) — each cell shows its slice.
          const bgImg = bgUrl ? loaded.get(bgUrl) : undefined;

          // Crop the background to a cell's aligned slice (its grid region). The
          // regular grid subdivision maps the whole photo across the cells, so it
          // reads as one continuous image behind the frame.
          const bgSlice = (i: number): HTMLCanvasElement | null => {
            if (!bgImg) return null;
            const cell = grid.cells[i];
            const bw = bgImg.naturalWidth || bgImg.width;
            const bh = bgImg.naturalHeight || bgImg.height;
            const sx = (cell.col / grid.cols) * bw;
            const sy = (cell.row / grid.rows) * bh;
            const sw = Math.max(1, (cell.colSpan / grid.cols) * bw);
            const sh = Math.max(1, (cell.rowSpan / grid.rows) * bh);
            const crop = cropRefs.current[i] ?? (cropRefs.current[i] = document.createElement("canvas"));
            const cw = Math.max(1, Math.round(sw));
            const ch = Math.max(1, Math.round(sh));
            if (crop.width !== cw) crop.width = cw;
            if (crop.height !== ch) crop.height = ch;
            const cc = crop.getContext("2d");
            if (!cc) return null;
            cc.clearRect(0, 0, cw, ch);
            cc.drawImage(bgImg, sx, sy, sw, sh, 0, 0, cw, ch);
            return crop;
          };

          // A cell's final texture: its background slice (if a background is set)
          // or its own image, with effects baked and optionally its transition.
          // Returns null if the cell has no source to draw.
          const cellTex = (i: number, withCellTr: boolean): Texture | null => {
            const cell = grid.cells[i];
            let src: Texture | null = grid.background ? bgSlice(i) : null;
            if (!src) {
              const url = cell.src ? images[cell.src] : undefined;
              src = (url ? loaded.get(url) : undefined) ?? null;
            }
            if (!src) return null;
            const iw = src instanceof HTMLImageElement ? src.naturalWidth || src.width : src.width;
            const ih = src instanceof HTMLImageElement ? src.naturalHeight || src.height : src.height;
            const off = fxRefs.current[i] ?? (fxRefs.current[i] = document.createElement("canvas"));
            let tex: Texture = cell.effects.length > 0 ? applyEffects(off, src, iw, ih, cell.effects) : src;
            if (withCellTr && cell.transition?.engine) {
              const trc = trRefs.current[i] ?? (trRefs.current[i] = document.createElement("canvas"));
              tex = cellTransitionTexture(trc, tex, iw, ih, cell.transition);
            }
            return tex;
          };

          if (gridTransition) {
            // Bounding box of the (possibly warped) grid in layer-local space.
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            let any = false;
            grid.cells.forEach((cell, i) => {
              if (cell.covered) return;
              for (const p of quadPts(liveQuad(i))) {
                any = true;
                if (p.x < minX) minX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x;
                if (p.y > maxY) maxY = p.y;
              }
            });
            const bw = maxX - minX;
            const bh = maxY - minY;
            if (any && bw > 0 && bh > 0) {
              const RS = 2; // supersample for a crisp transition texture
              const cw = Math.max(1, Math.min(4096, Math.round(bw * RS)));
              const ch = Math.max(1, Math.min(4096, Math.round(bh * RS)));
              const raster = gridRasterRef.current ?? (gridRasterRef.current = document.createElement("canvas"));
              if (raster.width !== cw) raster.width = cw;
              if (raster.height !== ch) raster.height = ch;
              const rctx = raster.getContext("2d")!;
              rctx.setTransform(1, 0, 0, 1, 0, 0);
              rctx.clearRect(0, 0, cw, ch);
              // Map layer-local (minX,minY) → canvas (0,0) at RS scale.
              const sx = cw / bw, sy = ch / bh;
              rctx.setTransform(sx, 0, 0, sy, -minX * sx, -minY * sy);
              grid.cells.forEach((cell, i) => {
                if (cell.covered) return;
                const tex = cellTex(i, false);
                if (tex) drawTexturedQuad(rctx as unknown as DrawCtx, tex, liveQuad(i), 1);
              });
              rctx.setTransform(1, 0, 0, 1, 0, 0);
              const outCanvas = gridTransRef.current ?? (gridTransRef.current = document.createElement("canvas"));
              const outTex = cellTransitionTexture(outCanvas, raster, cw, ch, gridTransition);
              // Draw the transitioned raster back over the grid's bounding rect.
              const rectQuad = {
                corners: [
                  { hx: minX, hy: minY, hw: 1, u: 0, v: 0 },
                  { hx: maxX, hy: minY, hw: 1, u: 1, v: 0 },
                  { hx: maxX, hy: maxY, hw: 1, u: 1, v: 1 },
                  { hx: minX, hy: maxY, hw: 1, u: 0, v: 1 },
                ],
                opacity: 1,
                subdiv: 1,
              };
              drawTexturedQuad(ctx as DrawCtx, outTex, rectQuad, 1);
            }
          } else {
            grid.cells.forEach((cell, i) => {
              if (cell.covered) return; // absorbed into a merged block
              const quad = liveQuad(i);
              const tex = cellTex(i, true);
              if (tex) {
                drawTexturedQuad(ctx as DrawCtx, tex, quad, 1);
              } else if (selected) {
                c.save();
                strokePoly(ctx as DrawCtx, quadPts(quad));
                c.fillStyle = "rgba(108,140,255,0.10)";
                c.fill();
                c.restore();
              }
            });
          }

          // Styled grid lines (keyframeable colour + width). Drawn on top of the
          // cell images, but skipped during a whole-grid transition (the grid is a
          // single transitioning texture then).
          if (!gridTransition && grid.lineWidth > 0 && grid.lineColor.a > 0) {
            c.save();
            c.strokeStyle = rgbaCss(grid.lineColor);
            c.lineWidth = grid.lineWidth;
            c.lineJoin = "miter";
            for (let i = 0; i < grid.cells.length; i++) {
              if (grid.cells[i].covered) continue;
              strokePoly(ctx as DrawCtx, quadPts(liveQuad(i)));
              c.stroke();
            }
            c.restore();
          }

          // Editor-only cell outline overlay (shows the mesh when selected).
          if (selected && !gridTransition) {
            c.save();
            c.strokeStyle = "rgba(108,140,255,0.9)";
            c.lineWidth = 1.2 * screenScale;
            for (let i = 0; i < grid.cells.length; i++) {
              if (grid.cells[i].covered) continue;
              strokePoly(ctx as DrawCtx, quadPts(liveQuad(i)));
              c.stroke();
            }
            c.restore();
          }
        }}
        hitFunc={(ctx, shape) => {
          ctx.beginPath();
          for (const cell of grid.cells) {
            const pts = quadPts(cell.quad);
            pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            ctx.closePath();
          }
          ctx.fillStrokeShape(shape);
        }}
        listening={interaction.listening}
        onClick={(e) => {
          interaction.onClick?.(e); // select the layer
          const pos = e.target.getRelativePointerPosition?.();
          if (pos) {
            const hit = grid.cells.findIndex(
              (cell) => !cell.covered && pointInPoly(pos.x, pos.y, quadPts(cell.quad))
            );
            if (hit >= 0) onPickCell(layerId, hit);
          }
        }}
        onContextMenu={(e) => {
          // Right-click a cell → its copy/paste-effects menu. Falls through to
          // the layer menu if the click missed a cell or no handler is wired.
          const pos = e.target.getRelativePointerPosition?.();
          const hit = pos
            ? grid.cells.findIndex((cell) => !cell.covered && pointInPoly(pos.x, pos.y, quadPts(cell.quad)))
            : -1;
          if (onCellContextMenu && hit >= 0) {
            e.evt.preventDefault();
            e.cancelBubble = true; // suppress the layer-level context menu
            onCellContextMenu(layerId, hit, e.evt.clientX, e.evt.clientY);
          } else {
            interaction.onContextMenu(e);
          }
        }}
      />
      {selected &&
        verts.map((_, i) => {
          const p = vpos(i);
          const on = selVerts.has(i);
          return (
            <Circle
              key={i}
              ref={(n) => {
                if (n) handleRefs.current.set(i, n);
                else handleRefs.current.delete(i);
              }}
              x={p.x}
              y={p.y}
              radius={(on ? 7 : 5) * screenScale}
              fill={on ? "#fff" : "rgba(108,140,255,0.95)"}
              stroke="#1b1b28"
              strokeWidth={1.5 * screenScale}
              draggable
              onClick={(e) => {
                e.cancelBubble = true;
                const shift = e.evt.shiftKey;
                setSelVerts((prev) => {
                  const next = new Set(shift ? prev : []);
                  if (shift && prev.has(i)) next.delete(i);
                  else next.add(i);
                  return next;
                });
              }}
              onDragStart={(e) => {
                e.cancelBubble = true;
              }}
              onDragMove={(e) => {
                e.cancelBubble = true;
                const node = e.target;
                const updates = computeUpdates(i, node.x(), node.y());
                const live = new Map<number, { x: number; y: number }>();
                for (const u of updates) live.set(u.index, { x: u.x, y: u.y });
                liveRef.current = live;
                for (const u of updates) {
                  if (u.index === i) continue;
                  const h = handleRefs.current.get(u.index);
                  if (h) {
                    h.x(u.x);
                    h.y(u.y);
                  }
                }
                node.getLayer()?.batchDraw();
              }}
              onDragEnd={(e) => {
                e.cancelBubble = true;
                const node = e.target;
                const updates = computeUpdates(i, node.x(), node.y());
                void onMoveVertices(layerId, updates);
              }}
            />
          );
        })}
    </Group>
  );
}

// A layer (image or text) pinned to a Shape3D, rendered as a decal. The evaluator
// already projected it to paint-ready quads in COMP space. When selected we show
// two handles: the round one MOVES it on the surface (drops at a new u/v, keyed),
// the square one SCALES it (keyed) — both distinct from moving the shape itself.
function DecalNode({
  layer,
  src,
  r,
  listening,
  selected,
  screenScale,
  onSelect,
  onImageDrop,
  onDecalScale,
}: {
  layer: Layer;
  src?: string;
  r: ResolvedLayer;
  listening: boolean;
  selected: boolean;
  screenScale: number;
  onSelect: (id: number) => void;
  onImageDrop: (layerId: number, x: number, y: number) => void;
  onDecalScale: (layerId: number, scale: number) => void;
}) {
  const isText = layer.kind.kind === "text";
  const imgTex = useImage(isText ? undefined : src);
  const shaped = useShaped(layer);
  const textOffRef = useRef<HTMLCanvasElement | null>(null);
  const fxOffRef = useRef<HTMLCanvasElement | null>(null);
  const surface = r.surface;
  const ready = isText ? !!shaped : !!imgTex;
  if (!ready || !surface || surface.quads.length === 0) return null;

  const textColor: Rgba =
    layer.kind.kind === "text"
      ? r.color ?? layer.kind.color
      : { r: 255, g: 255, b: 255, a: 255 };
  const layerId = layer.id;
  // A box decal is one quad; a cylinder decal is a curved band of many quads.
  const polys = surface.quads.map((q) =>
    q.corners.map((c) => ({ x: c.hx / c.hw, y: c.hy / c.hw }))
  );
  const allPts = polys.flat();
  const cx = allPts.reduce((s, p) => s + p.x, 0) / allPts.length;
  const cy = allPts.reduce((s, p) => s + p.y, 0) / allPts.length;
  const K = 44 * screenScale; // resting offset of the scale handle

  return (
    <Group opacity={r.opacity}>
      <Shape
        listening={listening}
        fill="#000"
        sceneFunc={(ctx) => {
          // Build the base texture: an image, or text rasterised WITH its
          // per-letter animation (so ScatterIn / decompose move on the surface).
          let base: Texture | null;
          if (isText) {
            if (!shaped) return;
            const toff = textOffRef.current ?? (textOffRef.current = document.createElement("canvas"));
            base = rasterizeText(toff, shaped, textColor, r.letters);
          } else {
            base = imgTex ? cappedTexture(imgTex) : null;
          }
          if (!base) return;
          const bw = base instanceof HTMLImageElement ? base.naturalWidth || base.width : base.width;
          const bh = base instanceof HTMLImageElement ? base.naturalHeight || base.height : base.height;
          const off = fxOffRef.current ?? (fxOffRef.current = document.createElement("canvas"));
          const tex = applyEffects(off, base, bw, bh, r.effects);
          drawSurface(ctx as DrawCtx, tex, surface, 1);
          if (selected) {
            ctx.save();
            (ctx as unknown as CanvasRenderingContext2D).strokeStyle = "rgba(108,140,255,0.95)";
            (ctx as unknown as CanvasRenderingContext2D).lineWidth = 1.5 * screenScale;
            for (const poly of polys) {
              strokePoly(ctx as DrawCtx, poly);
              (ctx as unknown as CanvasRenderingContext2D).stroke();
            }
            ctx.restore();
          }
        }}
        hitFunc={(ctx, shape) => {
          for (const poly of polys) {
            strokePoly(ctx as unknown as DrawCtx, poly);
            ctx.fillStrokeShape(shape);
          }
        }}
        onClick={(e) => {
          e.cancelBubble = true;
          onSelect(layerId);
        }}
      />
      {selected && listening && (
        <>
          <Line points={[cx, cy, cx + K, cy]} stroke="rgba(255,255,255,0.4)" strokeWidth={1 * screenScale} listening={false} />
          {/* Move on the surface (keys u/v at the playhead). */}
          <Circle
            x={cx}
            y={cy}
            radius={7 * screenScale}
            fill="rgba(108,140,255,0.95)"
            stroke="#fff"
            strokeWidth={1.5 * screenScale}
            draggable
            onClick={(e) => {
              e.cancelBubble = true;
            }}
            onDragEnd={(e) => onImageDrop(layerId, e.target.x(), e.target.y())}
          />
          {/* Scale on the surface (keys scale at the playhead). */}
          <Rect
            x={cx + K - 6 * screenScale}
            y={cy - 6 * screenScale}
            width={12 * screenScale}
            height={12 * screenScale}
            fill="rgba(60,200,160,0.95)"
            stroke="#fff"
            strokeWidth={1.5 * screenScale}
            draggable
            onClick={(e) => {
              e.cancelBubble = true;
            }}
            onDragEnd={(e) => {
              const handleCenterX = e.target.x() + 6 * screenScale;
              const ratio = Math.max(0.05, (handleCenterX - cx) / K);
              onDecalScale(layerId, Math.min(4, surface.scale * ratio));
            }}
          />
        </>
      )}
    </Group>
  );
}

// A Shape3D object (box/cylinder). The evaluator hands us its visible faces as
// local-space polygons (r.shape). The Group carries the shape's 2D transform, so
// it moves/scales/rotates and keyframes like any layer; the inner Shape strokes
// the wireframe (always visible — bright when selected) and provides the hit
// area. Right-click opens the insert menu. The 3D spin is keyframed in the
// inspector.
function ShapeNode({
  layerId,
  r,
  selected,
  interaction,
  registerRef,
  screenScale,
  onContextMenu,
  exporting,
}: {
  layerId: number;
  r: ResolvedLayer;
  selected: boolean;
  interaction: Interaction;
  registerRef: NodeRef;
  screenScale: number;
  onContextMenu: (layerId: number, x: number, y: number) => void;
  exporting: boolean;
}) {
  const shapeRef = useRef<Konva.Shape | null>(null);
  const frame = r.shape;

  useEffect(() => {
    const s = shapeRef.current;
    if (!s || !frame) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const f of frame.faces)
      for (const p of f) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    s.getSelfRect = () =>
      isFinite(minX)
        ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
        : { x: -1, y: -1, width: 2, height: 2 };
  }, [frame]);

  if (!frame) return null;
  const lw = (1.5 * screenScale) / Math.max(0.05, r.scaleX);

  return (
    <Group
      ref={registerRef}
      x={r.x}
      y={r.y}
      scaleX={r.scaleX}
      scaleY={r.scaleY}
      rotation={r.rotation}
      {...interaction}
      onContextMenu={(e) => {
        e.evt.preventDefault();
        e.evt.stopPropagation();
        e.cancelBubble = true;
        onContextMenu(layerId, e.evt.clientX, e.evt.clientY);
      }}
    >
      <Shape
        ref={shapeRef}
        listening={interaction.listening}
        fill="#000"
        sceneFunc={(ctx) => {
          if (exporting) return; // the frame is an editor guide — not in the render
          ctx.save();
          (ctx as unknown as CanvasRenderingContext2D).strokeStyle = selected
            ? "rgba(108,140,255,0.95)"
            : "rgba(108,140,255,0.4)";
          (ctx as unknown as CanvasRenderingContext2D).lineWidth = selected ? lw : lw * 0.8;
          for (const f of frame.faces) {
            strokePoly(ctx as DrawCtx, f);
            (ctx as unknown as CanvasRenderingContext2D).stroke();
          }
          ctx.restore();
        }}
        hitFunc={(ctx, shape) => {
          for (const f of frame.faces) {
            strokePoly(ctx as unknown as DrawCtx, f);
            ctx.fillStrokeShape(shape);
          }
        }}
      />
    </Group>
  );
}

// Renders text as shaped vector glyphs (so Arabic/Persian joins correctly).
// Normal mode: the whole run is one Group (the selectable/draggable node) and the
// glyphs animate from the evaluator. Decompose mode: each glyph becomes its own
// draggable/rotatable/scalable node, edited against its manual `parts` override.
function TextGlyphs({
  layerId,
  content,
  size,
  font,
  fill,
  color,
  style,
  layerStyles,
  perChar3d,
  r,
  interaction,
  registerRef,
  parts,
  timeMs,
  decompose,
  selectedPart,
  handleScale,
  onSelectPart,
  onCommitPart,
}: {
  layerId: number;
  content: string;
  size: number;
  font: string;
  fill: string;
  color: Rgba;
  style: TextStyle | null;
  layerStyles: TextLayerStyles | null;
  perChar3d: boolean;
  r: ResolvedLayer;
  interaction: Interaction;
  registerRef: NodeRef;
  parts: LetterOverride[];
  timeMs: number;
  decompose: boolean;
  selectedPart: number | null;
  handleScale: number;
  onSelectPart: (i: number | null) => void;
  onCommitPart: (layerId: number, index: number, pose: LetterPose) => void;
}) {
  const [shaped, setShaped] = useState<ShapedText | null>(null);
  const glyphRefs = useRef<Record<number, Konva.Path>>({});
  const glyphTrRef = useRef<Konva.Transformer>(null);
  const styledOffRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let alive = true;
    getShaped(layerId).then((s) => {
      if (alive) setShaped(s);
    });
    return () => {
      alive = false;
    };
  }, [layerId, content, size, font]);

  // Attach the per-glyph Transformer to the selected glyph (decompose only).
  useEffect(() => {
    const tr = glyphTrRef.current;
    if (!tr) return;
    const node =
      decompose && selectedPart != null ? glyphRefs.current[selectedPart] ?? null : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [decompose, selectedPart, shaped, parts, r, fill]);

  if (!shaped || shaped.glyphs.length === 0) return null;
  // Centre the run on the layer origin; baseline so it's vertically centred too.
  const left = -shaped.width / 2;
  const baseline = (shaped.ascender - shaped.descender) / 2;
  // Styled (fills/strokes/tracking/baseline) text — or plain text whose animator
  // uses skew/blur/tracking/colour — rasterises to one image; everything else
  // (incl. position/scale/rotation/opacity animators) keeps crisp vector paths.
  const advanced =
    !decompose &&
    r.letters.some(
      (l) => !!l && (l.skew !== 0 || l.blur !== 0 || l.tracking !== 0 || !!l.fill || l.rx !== 0 || l.ry !== 0 || l.dz !== 0)
    );
  const styled =
    (style || layerStyles || advanced) && !decompose
      ? rasterizeStyledText(
          styledOffRef.current ?? (styledOffRef.current = document.createElement("canvas")),
          shaped,
          color,
          r.letters,
          style,
          layerStyles,
          perChar3d
        )
      : null;

  // In decompose mode the glyph sits at base + its manual override, so its node
  // transform IS the override — commit is a direct read.
  const commitGlyph = (i: number) => {
    const node = glyphRefs.current[i];
    if (!node) return;
    const g = shaped.glyphs[i];
    onCommitPart(layerId, i, {
      dx: node.x() - (left + g.x + g.cx),
      dy: node.y() - (baseline + g.cy),
      rotation: node.rotation(),
      scale: node.scaleX(),
    });
  };

  const gh = handleScale / Math.max(0.05, r.scaleX);

  return (
    <Group
      ref={registerRef}
      x={r.x}
      y={r.y}
      scaleX={r.scaleX}
      scaleY={r.scaleY}
      rotation={r.rotation}
      opacity={r.opacity}
      {...(decompose ? { listening: true } : interaction)}
    >
      {/* Invisible solid hit area so a click anywhere on the text selects/drags
          it — not just the thin glyph strokes. (Off in decompose mode so it
          doesn't swallow per-glyph clicks.) */}
      {!decompose && (
        <Rect
          x={left - 4}
          y={baseline - shaped.ascender - 4}
          width={shaped.width + 8}
          height={shaped.ascender + shaped.descender + 8}
          fill="#000"
          opacity={0}
          perfectDrawEnabled={false}
        />
      )}
      {styled && (
        // A Shape (not KImage): the fresh sceneFunc closure each render forces
        // Konva to repaint the styled/animated raster every preview frame — a
        // KImage keeps the same canvas ref, so it never re-draws during playback.
        <Shape
          sceneFunc={(ctx) => {
            const cv = styledOffRef.current;
            if (cv) (ctx as unknown as CanvasRenderingContext2D).drawImage(cv, styled.imageX, styled.imageY, styled.logicalW, styled.logicalH);
          }}
          listening={false}
          perfectDrawEnabled={false}
        />
      )}
      {!styled && shaped.glyphs.map((g, i) => {
        if (!g.d) return null; // whitespace: advance only, no outline
        const p = parts[i];
        const lt = r.letters[i];
        const off = decompose
          ? {
              // The letter's OWN keyframed pose at the current playhead — so
              // scrubbing shows it animate, and dragging keys a new pose here.
              dx: p ? sampleTrack(p.dx, timeMs) : 0,
              dy: p ? sampleTrack(p.dy, timeMs) : 0,
              rotation: p ? sampleTrack(p.rotation, timeMs) : 0,
              scale: p ? sampleTrack(p.scale, timeMs) : 1,
              opacity: 1,
            }
          : {
              dx: lt?.dx ?? 0,
              dy: lt?.dy ?? 0,
              rotation: lt?.rotation ?? 0,
              scale: lt?.scale ?? 1,
              opacity: lt?.opacity ?? 1,
            };
        // Per-letter colour: while decomposing, glyphs are plain vector Paths, so
        // colour each from its own keyframed fill (else the layer colour).
        const glyphFill =
          decompose && p && p.colorKeys.length
            ? rgbaCss(sampleColor(p.colorKeys, color, timeMs))
            : fill;
        return (
          <Path
            key={i}
            ref={
              decompose
                ? (n: Konva.Path | null) => {
                    if (n) glyphRefs.current[i] = n;
                    else delete glyphRefs.current[i];
                  }
                : undefined
            }
            data={g.d}
            fill={glyphFill}
            x={left + g.x + g.cx + off.dx}
            y={baseline + g.cy + off.dy}
            offsetX={g.cx}
            offsetY={g.cy}
            scaleX={off.scale}
            scaleY={off.scale}
            rotation={off.rotation}
            opacity={off.opacity}
            perfectDrawEnabled={false}
            draggable={decompose}
            onClick={
              decompose
                ? (e: Konva.KonvaEventObject<MouseEvent>) => {
                    e.cancelBubble = true;
                    onSelectPart(i);
                  }
                : undefined
            }
            onDragEnd={decompose ? () => commitGlyph(i) : undefined}
            onTransformEnd={decompose ? () => commitGlyph(i) : undefined}
            listening={decompose ? true : false}
          />
        );
      })}

      {decompose && (
        <Transformer
          ref={glyphTrRef}
          anchorSize={8 * gh}
          anchorStrokeWidth={1.5 * gh}
          borderStrokeWidth={1.5 * gh}
          rotateAnchorOffset={22 * gh}
          padding={2 * gh}
          ignoreStroke
          flipEnabled={false}
          rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]}
        />
      )}
    </Group>
  );
}

interface Props {
  project: Project;
  resolved: Record<number, ResolvedLayer>;
  images: Record<string, string>;
  /** Current playhead time (ms) — used to key decomposed glyphs at this instant. */
  timeMs: number;
  selectedId: number | null;
  playing: boolean;
  decomposeId: number | null;
  selectedPart: number | null;
  onSelect: (id: number | null) => void;
  onCommit: (id: number, edit: TransformEdit) => void;
  onSelectPart: (i: number | null) => void;
  onCommitPart: (layerId: number, index: number, pose: LetterPose) => void;
  onImageDrop: (layerId: number, x: number, y: number) => void;
  onDecalScale: (layerId: number, scale: number) => void;
  onShapeContextMenu: (layerId: number, x: number, y: number) => void;
  onLayerContextMenu: (layerId: number, x: number, y: number) => void;
  /** A grid cell was clicked (row-major index) — selects it for image editing. */
  onPickCell: (layerId: number, cell: number) => void;
  /** Right-click a grid cell → its effect copy/paste menu. */
  onCellContextMenu?: (layerId: number, cell: number, x: number, y: number) => void;
  /** Commit dragged grid vertices (new local positions, keyframed at playhead). */
  onMoveVertices: (layerId: number, updates: { index: number; x: number; y: number }[]) => Promise<void>;
  /** Double-click a group (precomp) to enter it and edit its children. */
  onEnterGroup: (layerId: number) => void;
  /** Move a Flap effect's hinge axis (drag the dashed line in the preview). */
  onSetFlapAxis?: (layerId: number, index: number, axis: number) => void;
  exporting?: boolean;
  /** When set (during export with "show FPS" on), burn this fps value into the
   *  rendered frames as a corner label. Null = no overlay. */
  fpsOverlay?: number | null;
  /** Receives the underlying Konva Stage so the export loop can force a
   *  synchronous redraw of THIS exact stage (Konva's global `Konva.stages` may be
   *  a different module instance under bundler dedup and come back empty). */
  stageRef?: Ref<Konva.Stage>;
}

// Canvas blend mode per shine blend index (0 Add · 1 Screen · 2 Overlay · 3 Soft).
const SHINE_GCO = ["lighter", "screen", "overlay", "soft-light"] as const;

// An adjustment layer: renders its shiny-clouds effect(s) as full-frame overlays
// that composite (via the canvas blend mode) over EVERY layer already drawn
// beneath it in this Konva layer. `listening={false}` so it never intercepts
// clicks meant for the content below — select it from the timeline instead.
function AdjustmentNode({
  r,
  width,
  height,
}: {
  r: ResolvedLayer;
  width: number;
  height: number;
}) {
  const offRef = useRef<HTMLCanvasElement | null>(null);
  // Overlay-type effects usable as whole-comp adjustments: shiny clouds + the
  // GPU-overlay effects that emit a compositable pattern (not haze/vignette).
  type Overlay = Extract<ResolvedEffect, { kind: "shinyclouds" | "gpuoverlay" }>;
  const overlays = r.effects.filter(
    (e): e is Overlay =>
      e.kind === "shinyclouds" ||
      (e.kind === "gpuoverlay" && gpuFxIsOverlay(e.effect))
  );
  if (overlays.length === 0) return null;
  return (
    <>
      {overlays.map((s, i) => {
        return (
          <Shape
            key={i}
            listening={false}
            opacity={r.opacity}
            globalCompositeOperation={SHINE_GCO[s.blend] ?? "screen"}
            perfectDrawEnabled={false}
            sceneFunc={(ctx) => {
              const pat =
                s.kind === "shinyclouds"
                  ? renderShine(null, width, height, {
                      time: s.time,
                      intensity: s.intensity,
                      scale: s.scale,
                      speed: s.speed,
                      complexity: s.complexity,
                      contrast: s.contrast,
                      brightness: s.brightness,
                      tint: [s.tint.r / 255, s.tint.g / 255, s.tint.b / 255],
                      blend: s.blend,
                      opacity: s.opacity,
                      adjustment: true,
                    })
                  : s.kind === "gpuoverlay"
                    ? renderGpuFx(null, width, height, {
                        effect: s.effect,
                        time: s.time,
                        intensity: s.intensity,
                        scale: s.scale,
                        speed: s.speed,
                        detail: s.detail,
                        softness: s.softness,
                        extra: s.extra,
                        opacity: s.opacity,
                        tint: [s.tint.r / 255, s.tint.g / 255, s.tint.b / 255],
                        tint2: [s.tint2.r / 255, s.tint2.g / 255, s.tint2.b / 255],
                        pos: [s.posX, s.posY],
                        blend: s.blend,
                        adjustment: true,
                      })
                    : null;
              if (!pat) return;
              // Copy the shared GL canvas into a per-node scratch so a second
              // adjustment layer's render can't overwrite it before this draws.
              const off = offRef.current ?? (offRef.current = document.createElement("canvas"));
              if (off.width !== pat.width || off.height !== pat.height) {
                off.width = pat.width;
                off.height = pat.height;
              }
              const oc = off.getContext("2d");
              if (!oc) return;
              oc.clearRect(0, 0, off.width, off.height);
              oc.drawImage(pat, 0, 0);
              (ctx as unknown as CanvasRenderingContext2D).drawImage(off, 0, 0, width, height);
            }}
          />
        );
      })}
    </>
  );
}

// Draggable dashed hinge line for a Flap effect on the selected image layer.
// Rendered in the image's own transform so it tracks position/scale/rotation.
function FlapAxisOverlay({
  layer,
  r,
  effIndex,
  axis,
  vertical,
  screenScale,
  onCommit,
}: {
  layer: Layer;
  r: ResolvedLayer;
  effIndex: number;
  axis: number;
  vertical: boolean;
  screenScale: number;
  onCommit: (layerId: number, index: number, axis: number) => void;
}) {
  const [live, setLive] = useState<number | null>(null);
  if (layer.kind.kind !== "image") return null;
  const w = layer.kind.width;
  const h = layer.kind.height;
  if (!w || !h) return null;
  const a = live ?? axis;
  const hw = w / 2;
  const hh = h / 2;
  const pts = vertical
    ? [(a - 0.5) * w, -hh, (a - 0.5) * w, hh]
    : [-hw, (a - 0.5) * h, hw, (a - 0.5) * h];
  const hx = vertical ? (a - 0.5) * w : 0;
  const hy = vertical ? 0 : (a - 0.5) * h;
  const sAvg = Math.max(0.05, (Math.abs(r.scaleX) + Math.abs(r.scaleY)) / 2);
  const rad = (8 * screenScale) / sAvg;
  const sw = (1.6 * screenScale) / sAvg;
  const readAxis = (n: Konva.Node) =>
    Math.min(1, Math.max(0, vertical ? n.x() / w + 0.5 : n.y() / h + 0.5));
  return (
    <Group x={r.x} y={r.y} scaleX={r.scaleX} scaleY={r.scaleY} rotation={r.rotation}>
      <Line points={pts} stroke="#ffd23c" strokeWidth={sw} dash={[sw * 4, sw * 3]} listening={false} />
      <Circle
        x={hx}
        y={hy}
        radius={rad}
        fill="#ffd23c"
        stroke="#1a1a1a"
        strokeWidth={sw * 0.6}
        draggable
        onDragMove={(e) => {
          const n = e.target;
          if (vertical) n.y(0);
          else n.x(0);
          setLive(readAxis(n));
        }}
        onDragEnd={(e) => {
          const na = readAxis(e.target);
          setLive(null);
          onCommit(layer.id, effIndex, na);
        }}
      />
    </Group>
  );
}

export default function Preview({
  project,
  resolved,
  images,
  timeMs,
  selectedId,
  playing,
  decomposeId,
  selectedPart,
  onSelect,
  onCommit,
  onSelectPart,
  onCommitPart,
  onImageDrop,
  onDecalScale,
  onShapeContextMenu,
  onLayerContextMenu,
  onPickCell,
  onCellContextMenu,
  onMoveVertices,
  onEnterGroup,
  onSetFlapAxis,
  exporting = false,
  fpsOverlay = null,
  stageRef,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const nodeRefs = useRef<Record<number, Konva.Node>>({});
  const trRef = useRef<Konva.Transformer>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      setBox({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = 48;
  const fitScale =
    box.w > 0 && box.h > 0
      ? Math.min((box.w - pad) / project.width, (box.h - pad) / project.height)
      : 0;
  // During export render at full comp resolution (1:1) for a crisp video.
  const scale = exporting ? 1 : fitScale;
  const compW = project.width * scale;
  const compH = project.height * scale;
  // In the editor the Stage fills the whole viewport (a "pasteboard") and the
  // comp is centred inside it, so a layer dragged past the frame stays visible
  // and grab-able instead of being clipped to the canvas edge. On export the
  // Stage is exactly the comp so nothing outside the frame is rendered.
  const stageW = exporting ? compW : Math.max(box.w, compW);
  const stageH = exporting ? compH : Math.max(box.h, compH);
  const originX = exporting ? 0 : Math.round((stageW - compW) / 2);
  const originY = exporting ? 0 : Math.round((stageH - compH) / 2);
  // Comp bounds expressed in the (scaled) layer's own coordinate space — used to
  // draw the pasteboard dimming around the frame.
  const pbL = -originX / (scale || 1);
  const pbT = -originY / (scale || 1);
  const pbR = (stageW - originX) / (scale || 1);
  const pbB = (stageH - originY) / (scale || 1);

  const register = (id: number): NodeRef => (n) => {
    if (n) nodeRefs.current[id] = n;
    else delete nodeRefs.current[id];
  };

  // Read a node's current transform, diff it against what the evaluator gave us,
  // and commit only the properties that actually changed.
  const commit = (id: number) => {
    const node = nodeRefs.current[id];
    const r = resolved[id];
    if (!node || !r) return;
    const edit: TransformEdit = {};
    if (Math.abs(node.x() - r.x) > 0.5) edit.x = node.x();
    if (Math.abs(node.y() - r.y) > 0.5) edit.y = node.y();
    if (Math.abs(node.scaleX() - r.scaleX) > 0.0005) edit.scaleX = node.scaleX();
    if (Math.abs(node.scaleY() - r.scaleY) > 0.0005) edit.scaleY = node.scaleY();
    if (Math.abs(node.rotation() - r.rotation) > 0.05) edit.rotation = node.rotation();
    if (Object.keys(edit).length) onCommit(id, edit);
  };

  // While dragging a layer, snap its anchor onto the composition centre when it
  // gets within ~8 screen px. Mutates the node position in place (no React state,
  // so it doesn't fight Konva's own drag). Works in comp coords: the frame centre
  // is (width/2, height/2) and every node is centre-anchored, so its x/y is where
  // its centre lands.
  const snapToCenter = (node: Konva.Node) => {
    const thr = 8 / (scale || 1);
    const cx = project.width / 2;
    const cy = project.height / 2;
    if (Math.abs(node.x() - cx) < thr) node.x(cx);
    if (Math.abs(node.y() - cy) < thr) node.y(cy);
  };

  const interaction = (id: number): Interaction => ({
    listening: !playing,
    draggable: selectedId === id && !playing,
    onClick: (e) => {
      e.cancelBubble = true;
      onSelect(id);
    },
    onDragMove: (e) => snapToCenter(e.target),
    onDragEnd: () => commit(id),
    onTransformEnd: () => commit(id),
    onContextMenu: (e) => {
      e.evt.preventDefault();
      e.cancelBubble = true;
      onLayerContextMenu(id, e.evt.clientX, e.evt.clientY);
    },
  });

  // Flat images: dragging the body either drops onto a shape (→ becomes a decal)
  // or, if not over one, falls back to a normal move. Transformer handles still
  // commit scale/rotation via the shared interaction.
  const flatImageInteraction = (id: number): Interaction => ({
    ...interaction(id),
    onDragEnd: () => {
      const node = nodeRefs.current[id];
      if (node) onImageDrop(id, node.x(), node.y());
    },
  });

  // Keep the Transformer attached to the selected node. Re-run when anything
  // that could replace nodes changes.
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    // While decomposing a layer, the per-glyph Transformer takes over — hide the
    // layer-level one.
    const node =
      decomposeId == null && selectedId != null ? nodeRefs.current[selectedId] ?? null : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedId, decomposeId, resolved, images, playing, scale, project]);

  // Counter-scale the handles so they stay a constant on-screen size despite the
  // fit-to-comp layer scale.
  const h = scale > 0 ? 1 / scale : 1;

  // Non-interactive handlers for read-only rendering (group children at rest).
  const readonlyInteraction: Interaction = {
    listening: false,
    draggable: false,
    onClick: () => {},
    onDragMove: () => {},
    onDragEnd: () => {},
    onTransformEnd: () => {},
    onContextMenu: () => {},
  };
  const noopRef: NodeRef = () => {};

  // Render one layer's visual node. `interactive` = the top-level scope (select /
  // drag / keyframe); `false` for a group's children, which draw read-only under
  // the group's transform. Recurses for nested groups.
  const renderLayer = (
    layer: Layer,
    r: ResolvedLayer | undefined,
    interactive: boolean
  ): ReactElement | null => {
    if (!r || !r.visible) return null;
    const k = layer.kind;
    const inter = interactive ? interaction(layer.id) : readonlyInteraction;
    const flatInter = interactive ? flatImageInteraction(layer.id) : readonlyInteraction;
    const reg = interactive ? register(layer.id) : noopRef;
    const isSel = interactive && selectedId === layer.id;
    let node: ReactElement;
    if (r.surface) {
      node = (
        <DecalNode
          layer={layer}
          src={k.kind === "image" ? images[k.src] : undefined}
          r={r}
          listening={interactive && !playing}
          selected={isSel}
          screenScale={h}
          onSelect={interactive ? onSelect : () => {}}
          onImageDrop={onImageDrop}
          onDecalScale={onDecalScale}
        />
      );
    } else if (k.kind === "colorpatch") {
      node = (
        <Rect
          ref={reg}
          x={r.x}
          y={r.y}
          width={k.width}
          height={k.height}
          offsetX={k.width / 2}
          offsetY={k.height / 2}
          fill={rgbaCss(k.color)}
          scaleX={r.scaleX}
          scaleY={r.scaleY}
          rotation={r.rotation}
          opacity={r.opacity}
          globalCompositeOperation={composite(k.blend)}
          {...inter}
        />
      );
    } else if (k.kind === "text") {
      node = (
        <TextGlyphs
          layerId={layer.id}
          content={k.content}
          size={k.size}
          font={k.font}
          fill={rgbaCss(r.color ?? k.color)}
          color={r.color ?? k.color}
          style={k.style}
          layerStyles={k.layerStyles}
          perChar3d={k.perChar3d}
          r={r}
          interaction={inter}
          registerRef={reg}
          parts={k.parts}
          timeMs={timeMs}
          decompose={interactive && decomposeId === layer.id}
          selectedPart={interactive && decomposeId === layer.id ? selectedPart : null}
          handleScale={h}
          onSelectPart={interactive ? onSelectPart : () => {}}
          onCommitPart={onCommitPart}
        />
      );
    } else if (k.kind === "shape3d") {
      node = (
        <ShapeNode
          layerId={layer.id}
          r={r}
          selected={isSel}
          interaction={inter}
          registerRef={reg}
          screenScale={h}
          onContextMenu={onShapeContextMenu}
          exporting={exporting}
        />
      );
    } else if (k.kind === "framegrid") {
      node = (
        <FrameGridNode
          layer={layer}
          r={r}
          images={images}
          interaction={inter}
          registerRef={reg}
          selected={isSel}
          screenScale={h}
          onPickCell={interactive ? onPickCell : () => {}}
          onCellContextMenu={interactive ? onCellContextMenu : undefined}
          onMoveVertices={onMoveVertices}
        />
      );
    } else if (k.kind === "video") {
      node = (
        <VideoNode
          layerId={layer.id}
          src={k.src}
          r={r}
          playing={playing}
          timeMs={timeMs}
          layerStartMs={layer.startMs}
          durationMs={k.durationMs ?? 0}
          interaction={inter}
          registerRef={reg}
        />
      );
    } else if (k.kind === "audio") {
      return null; // no visual
    } else if (k.kind === "adjustment") {
      return (
        <Group key={layer.id}>
          <AdjustmentNode r={r} width={project.width} height={project.height} />
        </Group>
      );
    } else if (k.kind === "group") {
      node = (
        <GroupNode
          layer={layer}
          r={r}
          screenScale={h}
          interaction={inter}
          registerRef={reg}
          selected={isSel}
          onEnter={interactive ? onEnterGroup : () => {}}
          renderChild={(child, cr) => renderLayer(child, cr, false)}
        />
      );
    } else {
      const src = k.kind === "image" ? images[k.src] : undefined;
      node =
        r.transition?.engine && src ? (
          <TransitionImageNode src={src} r={r} transition={r.transition} interaction={flatInter} registerRef={reg} />
        ) : r.effects.length > 0 ? (
          <EffectImageNode src={src} r={r} interaction={flatInter} registerRef={reg} />
        ) : (
          <ImageNode src={src} r={r} interaction={flatInter} registerRef={reg} />
        );
    }
    // A Flap effect on the selected image layer → a draggable dashed hinge line.
    const flapIdx =
      interactive && isSel && k.kind === "image" && !r.surface && onSetFlapAxis
        ? r.effects.findIndex((e) => e.kind === "gpuoverlay" && e.effect === 10)
        : -1;
    const flapEff = flapIdx >= 0 ? r.effects[flapIdx] : null;
    const flapOverlay =
      flapEff && flapEff.kind === "gpuoverlay" ? (
        <FlapAxisOverlay
          layer={layer}
          r={r}
          effIndex={flapIdx}
          axis={flapEff.posX}
          vertical={flapEff.blend === 1}
          screenScale={h}
          onCommit={onSetFlapAxis!}
        />
      ) : null;
    // Engine transitions on a flat image / grid bake themselves into the node
    // above; everything else uses the legacy transition group wrap.
    const engineHandled =
      !!r.transition?.engine && !r.surface && (k.kind === "image" || k.kind === "framegrid");
    const tp = engineHandled ? null : transitionGroupProps(r.transition, project.width, project.height);
    return tp ? (
      <Group key={layer.id} {...tp}>
        {node}
        {flapOverlay}
      </Group>
    ) : (
      <Group key={layer.id}>
        {node}
        {flapOverlay}
      </Group>
    );
  };

  return (
    <div ref={wrapRef} className="preview-wrap">
      {scale > 0 && (
        <Stage
          ref={stageRef}
          width={stageW}
          height={stageH}
          className="preview-stage"
          onMouseDown={(e) => {
            if (e.target === e.target.getStage()) {
              if (decomposeId != null) onSelectPart(null);
              else onSelect(null);
            }
          }}
        >
          <KLayer x={originX} y={originY} scaleX={scale} scaleY={scale}>
            {/* Pasteboard: dim everything outside the comp so the frame reads
                clearly, while off-frame layers still show on top of it. */}
            {!exporting && (
              <>
                <Rect x={pbL} y={pbT} width={pbR - pbL} height={-pbT} fill="rgba(0,0,0,0.5)" listening={false} />
                <Rect x={pbL} y={project.height} width={pbR - pbL} height={pbB - project.height} fill="rgba(0,0,0,0.5)" listening={false} />
                <Rect x={pbL} y={0} width={-pbL} height={project.height} fill="rgba(0,0,0,0.5)" listening={false} />
                <Rect x={project.width} y={0} width={pbR - project.width} height={project.height} fill="rgba(0,0,0,0.5)" listening={false} />
              </>
            )}
            {project.layers.map((layer) => renderLayer(layer, resolved[layer.id], true))}

            {/* Burned-in FPS label for the rendered video (export only). Placed
                in comp space so it scales with the frame; drawn last = on top. */}
            {fpsOverlay != null && (
              <Group x={project.width * 0.02} y={project.width * 0.02} listening={false}>
                <Rect
                  width={project.height * 0.16}
                  height={project.height * 0.06}
                  cornerRadius={project.height * 0.012}
                  fill="rgba(0,0,0,0.55)"
                />
                <Text
                  text={`${fpsOverlay} FPS`}
                  x={project.height * 0.02}
                  y={project.height * 0.013}
                  fontSize={project.height * 0.034}
                  fontStyle="bold"
                  fontFamily="Arial, sans-serif"
                  fill="#ffffff"
                />
              </Group>
            )}

            {/* The comp frame outline — always drawn on top so the boundary of
                the exported area is unmistakable (editor only). */}
            {!exporting && (
              <Rect
                x={0}
                y={0}
                width={project.width}
                height={project.height}
                stroke="#5b8cff"
                strokeWidth={1.5}
                dash={[6, 4]}
                strokeScaleEnabled={false}
                listening={false}
                perfectDrawEnabled={false}
              />
            )}

            {!playing && (
              <Transformer
                ref={trRef}
                anchorSize={9 * h}
                anchorStrokeWidth={1.5 * h}
                anchorCornerRadius={2 * h}
                borderStrokeWidth={1.5 * h}
                rotateAnchorOffset={26 * h}
                padding={2 * h}
                ignoreStroke
                flipEnabled={false}
                rotationSnaps={[0, 90, 180, 270]}
              />
            )}
          </KLayer>
        </Stage>
      )}
    </div>
  );
}
