// The Konva preview + direct manipulation.
//
// It draws the project's layers from the Rust-resolved transforms, and lets you
// SELECT a layer and move/scale/rotate it with a Transformer. When a drag or
// transform ends, the changed properties are committed as keyframes at the
// current playhead time (via onCommit) — that's what turns a manual edit into
// animation. The component still owns no interpolation math.
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
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
import { drawSurface } from "../lib/surface3d";
import type { Texture } from "../lib/surface3d";
import { applyEffects } from "../lib/effects";
import { createTransition } from "../lib/transitions";
import type { Clip } from "../lib/transitions";
import type { Project } from "../bindings/Project";
import type { Layer } from "../bindings/Layer";
import type { ResolvedLayer } from "../bindings/ResolvedLayer";
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
  onDragEnd: () => void;
  onTransformEnd: () => void;
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
        // B = the clip (its effect stack baked in); A = empty (reveals beneath).
        const bcv = bRef.current ?? (bRef.current = document.createElement("canvas"));
        const texB: CanvasImageSource = r.effects.length > 0 ? applyEffects(bcv, img, w, h, r.effects) : img;
        const B: Clip = { source: texB, width: w, height: h };
        const A: Clip = { source: null, width: 0, height: 0 };
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
            ...userParams,
          });
          tr.render(off, f);
          c.globalAlpha = fromEmpty;
          c.drawImage(off, 0, 0);
          if (toPlain > 0) {
            c.globalAlpha = toPlain; // converge onto the exact resting frame
            c.drawImage(texB, 0, 0);
          }
          c.globalAlpha = 1;
        } catch {
          // Unknown/failed transition → fall back to a plain opacity fade.
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

type DrawCtx = Parameters<typeof drawSurface>[0];

/** Stroke a closed polygon of comp-space points on a Konva context. */
function strokePoly(ctx: DrawCtx, pts: { x: number; y: number }[]) {
  if (pts.length < 2) return;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
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
    layer.kind.kind === "text" ? layer.kind.color : { r: 255, g: 255, b: 255, a: 255 };
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
  decompose: boolean;
  selectedPart: number | null;
  handleScale: number;
  onSelectPart: (i: number | null) => void;
  onCommitPart: (layerId: number, index: number, part: LetterOverride) => void;
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
          ? { dx: p?.dx ?? 0, dy: p?.dy ?? 0, rotation: p?.rotation ?? 0, scale: p?.scale ?? 1, opacity: 1 }
          : {
              dx: lt?.dx ?? 0,
              dy: lt?.dy ?? 0,
              rotation: lt?.rotation ?? 0,
              scale: lt?.scale ?? 1,
              opacity: lt?.opacity ?? 1,
            };
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
            fill={fill}
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
  selectedId: number | null;
  playing: boolean;
  decomposeId: number | null;
  selectedPart: number | null;
  onSelect: (id: number | null) => void;
  onCommit: (id: number, edit: TransformEdit) => void;
  onSelectPart: (i: number | null) => void;
  onCommitPart: (layerId: number, index: number, part: LetterOverride) => void;
  onImageDrop: (layerId: number, x: number, y: number) => void;
  onDecalScale: (layerId: number, scale: number) => void;
  onShapeContextMenu: (layerId: number, x: number, y: number) => void;
  exporting?: boolean;
  /** When set (during export with "show FPS" on), burn this fps value into the
   *  rendered frames as a corner label. Null = no overlay. */
  fpsOverlay?: number | null;
}

export default function Preview({
  project,
  resolved,
  images,
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
  exporting = false,
  fpsOverlay = null,
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

  const pad = 24;
  const fitScale =
    box.w > 0 && box.h > 0
      ? Math.min((box.w - pad) / project.width, (box.h - pad) / project.height)
      : 0;
  // During export render at full comp resolution (1:1) for a crisp video.
  const scale = exporting ? 1 : fitScale;
  const stageW = project.width * scale;
  const stageH = project.height * scale;

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

  const interaction = (id: number): Interaction => ({
    listening: !playing,
    draggable: selectedId === id && !playing,
    onClick: (e) => {
      e.cancelBubble = true;
      onSelect(id);
    },
    onDragEnd: () => commit(id),
    onTransformEnd: () => commit(id),
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

  return (
    <div ref={wrapRef} className="preview-wrap">
      {scale > 0 && (
        <Stage
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
          <KLayer scaleX={scale} scaleY={scale}>
            {project.layers.map((layer) => {
              const r = resolved[layer.id];
              if (!r || !r.visible) return null;
              const k = layer.kind;
              let node: ReactElement;
              // Pinned to a shape (image or text) → render as a decal on its
              // surface, regardless of the layer kind.
              if (r.surface) {
                node = (
                  <DecalNode
                    layer={layer}
                    src={k.kind === "image" ? images[k.src] : undefined}
                    r={r}
                    listening={!playing}
                    selected={selectedId === layer.id}
                    screenScale={h}
                    onSelect={onSelect}
                    onImageDrop={onImageDrop}
                    onDecalScale={onDecalScale}
                  />
                );
              } else if (k.kind === "colorpatch") {
                node = (
                  <Rect
                    ref={register(layer.id)}
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
                    {...interaction(layer.id)}
                  />
                );
              } else if (k.kind === "text") {
                node = (
                  <TextGlyphs
                    layerId={layer.id}
                    content={k.content}
                    size={k.size}
                    font={k.font}
                    fill={rgbaCss(k.color)}
                    color={k.color}
                    style={k.style}
                    layerStyles={k.layerStyles}
                    perChar3d={k.perChar3d}
                    r={r}
                    interaction={interaction(layer.id)}
                    registerRef={register(layer.id)}
                    parts={k.parts}
                    decompose={decomposeId === layer.id}
                    selectedPart={decomposeId === layer.id ? selectedPart : null}
                    handleScale={h}
                    onSelectPart={onSelectPart}
                    onCommitPart={onCommitPart}
                  />
                );
              } else if (k.kind === "shape3d") {
                node = (
                  <ShapeNode
                    layerId={layer.id}
                    r={r}
                    selected={selectedId === layer.id}
                    interaction={interaction(layer.id)}
                    registerRef={register(layer.id)}
                    screenScale={h}
                    onContextMenu={onShapeContextMenu}
                    exporting={exporting}
                  />
                );
              } else {
                // A flat image (not pinned) — draggable onto a shape to pin it.
                // With effects it goes through the effect renderer. An in/out
                // transition-engine effect renders through TransitionImageNode.
                const src = k.kind === "image" ? images[k.src] : undefined;
                node =
                  r.transition?.engine && src ? (
                    <TransitionImageNode
                      src={src}
                      r={r}
                      transition={r.transition}
                      interaction={flatImageInteraction(layer.id)}
                      registerRef={register(layer.id)}
                    />
                  ) : r.effects.length > 0 ? (
                    <EffectImageNode
                      src={src}
                      r={r}
                      interaction={flatImageInteraction(layer.id)}
                      registerRef={register(layer.id)}
                    />
                  ) : (
                    <ImageNode
                      src={src}
                      r={r}
                      interaction={flatImageInteraction(layer.id)}
                      registerRef={register(layer.id)}
                    />
                  );
              }
              // Wrap in a transition group for the legacy (non-engine) kinds.
              // Engine transitions on a flat image are already baked into the
              // node above, so skip the group wrap for those.
              const engineHandled =
                !!r.transition?.engine && !r.surface && k.kind === "image";
              const tp = engineHandled
                ? null
                : transitionGroupProps(r.transition, project.width, project.height);
              return tp ? (
                <Group key={layer.id} {...tp}>
                  {node}
                </Group>
              ) : (
                <Group key={layer.id}>{node}</Group>
              );
            })}

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
