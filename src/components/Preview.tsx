// The Konva preview + direct manipulation.
//
// It draws the project's layers from the Rust-resolved transforms, and lets you
// SELECT a layer and move/scale/rotate it with a Transformer. When a drag or
// transform ends, the changed properties are committed as keyframes at the
// current playhead time (via onCommit) — that's what turns a manual edit into
// animation. The component still owns no interpolation math.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Stage,
  Layer as KLayer,
  Rect,
  Group,
  Path,
  Image as KImage,
  Shape,
  Circle,
  Transformer,
} from "react-konva";
import Konva from "konva";

import { getShaped } from "../lib/api";
import { drawSurface } from "../lib/surface3d";
import type { Project } from "../bindings/Project";
import type { ResolvedLayer } from "../bindings/ResolvedLayer";
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

/** Interaction props shared by every layer node (everything except the ref). */
type Interaction = {
  listening: boolean;
  draggable: boolean;
  onClick: (e: Konva.KonvaEventObject<MouseEvent>) => void;
  onDragEnd: () => void;
  onTransformEnd: () => void;
};

type NodeRef = (n: Konva.Node | null) => void;

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

// An image pinned to a Shape3D: the evaluator already projected it to paint-ready
// quads in COMP space (the shape's placement baked in), so this renders with no
// transform of its own. When selected we show a drag handle at the decal centre;
// dragging it drops the decal at a new spot on the surface (Rust recomputes the
// face + u/v — so it slides across box faces and around the cylinder).
function DecalNode({
  layerId,
  src,
  r,
  listening,
  selected,
  screenScale,
  onSelect,
  onImageDrop,
}: {
  layerId: number;
  src?: string;
  r: ResolvedLayer;
  listening: boolean;
  selected: boolean;
  screenScale: number;
  onSelect: (id: number) => void;
  onImageDrop: (layerId: number, x: number, y: number) => void;
}) {
  const img = useImage(src);
  const surface = r.surface;
  if (!img || !surface || surface.quads.length === 0) return null;

  // A box decal is one quad; a cylinder decal is a curved band of many quads.
  const polys = surface.quads.map((q) =>
    q.corners.map((c) => ({ x: c.hx / c.hw, y: c.hy / c.hw }))
  );
  const allPts = polys.flat();
  const cx = allPts.reduce((s, p) => s + p.x, 0) / allPts.length;
  const cy = allPts.reduce((s, p) => s + p.y, 0) / allPts.length;

  return (
    <Group opacity={r.opacity}>
      <Shape
        listening={listening}
        fill="#000"
        sceneFunc={(ctx) => {
          drawSurface(ctx as DrawCtx, img, surface, 1);
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
      )}
    </Group>
  );
}

// An invisible Shape3D object (box/cylinder). The evaluator hands us its visible
// faces as local-space polygons (r.shape). The Group carries the shape's 2D
// transform, so it moves/scales/rotates and keyframes like any layer; the inner
// Shape strokes a wireframe when selected and provides the (otherwise invisible)
// hit area. The 3D spin is keyframed from the inspector.
function ShapeNode({
  r,
  selected,
  interaction,
  registerRef,
  screenScale,
}: {
  r: ResolvedLayer;
  selected: boolean;
  interaction: Interaction;
  registerRef: NodeRef;
  screenScale: number;
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
    >
      <Shape
        ref={shapeRef}
        listening={interaction.listening}
        fill="#000"
        sceneFunc={(ctx) => {
          if (!selected) return;
          ctx.save();
          (ctx as unknown as CanvasRenderingContext2D).strokeStyle = "rgba(108,140,255,0.85)";
          (ctx as unknown as CanvasRenderingContext2D).lineWidth = lw;
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
  const scale =
    box.w > 0 && box.h > 0
      ? Math.min((box.w - pad) / project.width, (box.h - pad) / project.height)
      : 0;
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
              if (k.kind === "colorpatch") {
                return (
                  <Rect
                    key={layer.id}
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
              }
              if (k.kind === "text") {
                return (
                  <TextGlyphs
                    key={layer.id}
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
              }
              if (k.kind === "shape3d") {
                return (
                  <ShapeNode
                    key={layer.id}
                    r={r}
                    selected={selectedId === layer.id}
                    interaction={interaction(layer.id)}
                    registerRef={register(layer.id)}
                    screenScale={h}
                  />
                );
              }
              // Image: a decal when pinned to a shape, otherwise a flat image
              // (draggable onto a shape to pin it).
              return r.surface ? (
                <DecalNode
                  key={layer.id}
                  layerId={layer.id}
                  src={images[k.src]}
                  r={r}
                  listening={!playing}
                  selected={selectedId === layer.id}
                  screenScale={h}
                  onSelect={onSelect}
                  onImageDrop={onImageDrop}
                />
              ) : (
                <ImageNode
                  key={layer.id}
                  src={images[k.src]}
                  r={r}
                  interaction={flatImageInteraction(layer.id)}
                  registerRef={register(layer.id)}
                />
              );
            })}

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
