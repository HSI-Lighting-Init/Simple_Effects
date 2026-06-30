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
import type { Project } from "../bindings/Project";
import type { Layer } from "../bindings/Layer";
import type { ResolvedLayer } from "../bindings/ResolvedLayer";
import type { ResolvedTransition } from "../bindings/ResolvedTransition";
import type { Rgba } from "../bindings/Rgba";
import type { BlendMode } from "../bindings/BlendMode";
import type { TransformEdit } from "../bindings/TransformEdit";
import type { ShapedText } from "../bindings/ShapedText";
import type { LetterOverride } from "../bindings/LetterOverride";

function rgbaCss(c: Rgba): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a / 255})`;
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
  fill,
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
  fill: string;
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

  useEffect(() => {
    let alive = true;
    getShaped(layerId).then((s) => {
      if (alive) setShaped(s);
    });
    return () => {
      alive = false;
    };
  }, [layerId, content, size]);

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
      {shaped.glyphs.map((g, i) => {
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
                    fill={rgbaCss(k.color)}
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
                // With effects it goes through the effect renderer.
                const src = k.kind === "image" ? images[k.src] : undefined;
                node =
                  r.effects.length > 0 ? (
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
              // Wrap in a transition group (dissolve/slide/wipe) when active.
              const tp = transitionGroupProps(r.transition, project.width, project.height);
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
