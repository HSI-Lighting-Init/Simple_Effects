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
  Transformer,
} from "react-konva";
import Konva from "konva";

import { getShaped } from "../lib/api";
import type { Project } from "../bindings/Project";
import type { ResolvedLayer } from "../bindings/ResolvedLayer";
import type { Rgba } from "../bindings/Rgba";
import type { BlendMode } from "../bindings/BlendMode";
import type { TransformEdit } from "../bindings/TransformEdit";
import type { ShapedText } from "../bindings/ShapedText";

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
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) return;
    const im = new window.Image();
    im.onload = () => setImg(im);
    im.src = src;
    return () => {
      im.onload = null;
    };
  }, [src]);
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

// Renders text as shaped vector glyphs (so Arabic/Persian joins correctly) and
// applies per-letter transforms from the evaluator. The whole run is one Group
// — that's the selectable/draggable node; the per-glyph Paths animate within it.
function TextGlyphs({
  layerId,
  content,
  size,
  fill,
  r,
  interaction,
  registerRef,
}: {
  layerId: number;
  content: string;
  size: number;
  fill: string;
  r: ResolvedLayer;
  interaction: Interaction;
  registerRef: NodeRef;
}) {
  const [shaped, setShaped] = useState<ShapedText | null>(null);
  useEffect(() => {
    let alive = true;
    getShaped(layerId).then((s) => {
      if (alive) setShaped(s);
    });
    return () => {
      alive = false;
    };
  }, [layerId, content, size]);

  if (!shaped || shaped.glyphs.length === 0) return null;
  // Centre the run on the layer origin; baseline so it's vertically centred too.
  const left = -shaped.width / 2;
  const baseline = (shaped.ascender - shaped.descender) / 2;

  return (
    <Group
      ref={registerRef}
      x={r.x}
      y={r.y}
      scaleX={r.scaleX}
      scaleY={r.scaleY}
      rotation={r.rotation}
      opacity={r.opacity}
      {...interaction}
    >
      {shaped.glyphs.map((g, i) => {
        if (!g.d) return null; // whitespace: advance only, no outline
        const lt = r.letters[i] ?? { dx: 0, dy: 0, scale: 1, opacity: 1, rotation: 0 };
        return (
          <Path
            key={i}
            data={g.d}
            fill={fill}
            x={left + g.x + g.cx + lt.dx}
            y={baseline + g.cy + lt.dy}
            offsetX={g.cx}
            offsetY={g.cy}
            scaleX={lt.scale}
            scaleY={lt.scale}
            rotation={lt.rotation}
            opacity={lt.opacity}
            perfectDrawEnabled={false}
          />
        );
      })}
    </Group>
  );
}

interface Props {
  project: Project;
  resolved: Record<number, ResolvedLayer>;
  images: Record<string, string>;
  selectedId: number | null;
  playing: boolean;
  onSelect: (id: number | null) => void;
  onCommit: (id: number, edit: TransformEdit) => void;
}

export default function Preview({
  project,
  resolved,
  images,
  selectedId,
  playing,
  onSelect,
  onCommit,
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

  // Keep the Transformer attached to the selected node. Re-run when anything
  // that could replace nodes changes.
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const node = selectedId != null ? nodeRefs.current[selectedId] ?? null : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedId, resolved, images, playing, scale, project]);

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
            if (e.target === e.target.getStage()) onSelect(null);
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
                  />
                );
              }
              return (
                <ImageNode
                  key={layer.id}
                  src={images[k.src]}
                  r={r}
                  interaction={interaction(layer.id)}
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
