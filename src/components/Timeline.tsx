// The timeline. One track per layer (top layer on top), so every image you add
// gets its own row. Blocks show each layer's [startMs, endMs] range; diamonds
// mark keyframes; the playhead is draggable to scrub.
import { useRef, useState } from "react";
import type { Project } from "../bindings/Project";
import type { Layer } from "../bindings/Layer";

/** Smallest range a layer block may be trimmed to (ms) — matches the Rust floor. */
const MIN_SPAN_MS = 50;

/** A live drag of a layer block: moving the whole range or trimming one edge. */
interface Drag {
  id: number;
  mode: "move" | "start" | "end";
  startMs: number;
  endMs: number;
  moved: boolean;
}

function kindColor(l: Layer): string {
  const k = l.kind;
  if (k.kind === "colorpatch") return `rgb(${k.color.r}, ${k.color.g}, ${k.color.b})`;
  if (k.kind === "text") return "#6c8cff";
  if (k.kind === "shape3d") return "#b06cff";
  return "#3bb6a6"; // image
}

/** Unique keyframe times across a layer's transform tracks (+ text decompose,
 *  + 3D-shape rotations). */
function keyframeTimes(l: Layer): number[] {
  const t = l.transform;
  const tracks = [t.x, t.y, t.scaleX, t.scaleY, t.rotation, t.opacity];
  if (l.kind.kind === "text") tracks.push(l.kind.decompose);
  if (l.kind.kind === "shape3d")
    tracks.push(l.kind.rotation_x, l.kind.rotation_y, l.kind.rotation_z);
  if (l.attach) tracks.push(l.attach.u, l.attach.v, l.attach.scale, l.attach.rotation);
  for (const e of l.effects) {
    if (e.kind === "blur") tracks.push(e.radius);
    else if (e.kind === "hue") tracks.push(e.degrees);
    else if (e.kind === "wipe") tracks.push(e.position, e.softness);
    else tracks.push(e.amount);
  }
  const set = new Set<number>();
  for (const tr of tracks) for (const k of tr.keys) set.add(k.timeMs);
  return [...set];
}

interface Props {
  project: Project;
  time: number;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onToggleHidden: (id: number) => void;
  onSeek: (t: number) => void;
  onDeleteLayer: (id: number) => void;
  onDeleteKeyframe: (id: number, tMs: number) => void;
  /** Retime a keyframe (drag a diamond): move all keys at `fromMs` to `toMs`. */
  onMoveKeyframe: (id: number, fromMs: number, toMs: number) => void;
  onLayerContextMenu: (id: number, x: number, y: number) => void;
  onSetLayerRange: (id: number, startMs: number, endMs: number) => void;
  /** Commit a new z-order (full list of layer ids, bottom-first). */
  onReorder: (order: number[]) => void;
}

export default function Timeline({
  project,
  time,
  selectedId,
  onSelect,
  onToggleHidden,
  onSeek,
  onDeleteLayer,
  onDeleteKeyframe,
  onMoveKeyframe,
  onLayerContextMenu,
  onSetLayerRange,
  onReorder,
}: Props) {
  const tracksRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Layer-row reorder (drag a layer onto the one you want it under).
  const [rowDragId, setRowDragId] = useState<number | null>(null);
  const [rowOverId, setRowOverId] = useState<number | null>(null);
  // Keyframe-diamond drag (retime). `fromMs` identifies which diamond is moving.
  const [kfDrag, setKfDrag] = useState<{ id: number; fromMs: number; toMs: number } | null>(null);
  // Horizontal zoom: content is `zoom * 100%` wide; the tracks area scrolls and
  // the ruler is kept in sync via transform.
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rulerInnerRef = useRef<HTMLDivElement>(null);
  const dur = project.durationMs || 1;

  // Keep the ruler aligned with the (separately clipped) horizontal scroll.
  const onTracksScroll = () => {
    const r = rulerInnerRef.current;
    if (r && scrollRef.current) r.style.transform = `translateX(${-scrollRef.current.scrollLeft}px)`;
  };
  const zoomBy = (factor: number) => setZoom((z) => Math.min(40, Math.max(1, z * factor)));
  // Ctrl/⌘ + wheel zooms the timeline; plain wheel scrolls (native).
  const onWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2);
  };
  const layers = [...project.layers].reverse();

  // Drop layer `dragId` so it sits just *under* `targetId` in z-order. Works in
  // array space (bottom-first), independent of the reversed row display.
  const commitReorder = (dragId: number, targetId: number) => {
    if (dragId === targetId) return;
    const arr = project.layers.map((l) => l.id).filter((id) => id !== dragId);
    const tIdx = arr.indexOf(targetId);
    if (tIdx < 0) return;
    arr.splice(tIdx, 0, dragId); // dragId at target's index → target moves above it
    onReorder(arr);
  };

  // Mouse-driven layer-row reordering. We don't use HTML5 drag-and-drop because
  // Tauri's WebView2 drag/drop handler swallows it on Windows; instead we track
  // the pointer and hit-test rows by their `data-layer-id`, committing on release
  // (so it's one undo step and a plain click still just selects).
  const startRowDrag = (e: React.MouseEvent, layer: Layer) => {
    // Let the eye/▼ and delete buttons handle their own clicks.
    if ((e.target as HTMLElement).closest("button")) return;
    onSelect(layer.id);
    const startY = e.clientY;
    let over: number | null = null;
    let moved = false;

    const rowIdAt = (x: number, y: number): number | null => {
      const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest(
        ".tl-label"
      ) as HTMLElement | null;
      const id = el?.getAttribute("data-layer-id");
      return id != null ? Number(id) : null;
    };

    const move = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) > 4) {
        moved = true;
        setRowDragId(layer.id);
      }
      if (!moved) return;
      const target = rowIdAt(ev.clientX, ev.clientY);
      over = target != null && target !== layer.id ? target : null;
      setRowOverId(over);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (moved && over != null) commitReorder(layer.id, over);
      setRowDragId(null);
      setRowOverId(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Begin dragging a layer block (move it) or one of its trim edges. Converts
  // horizontal mouse motion into ms against the track width, clamps to the comp,
  // and commits the new range once on release (so it's a single undo step).
  const startBlockDrag = (
    e: React.MouseEvent,
    layer: Layer,
    mode: Drag["mode"]
  ) => {
    e.stopPropagation(); // don't scrub the playhead
    onSelect(layer.id);
    const el = tracksRef.current;
    if (!el) return;
    const trackW = el.getBoundingClientRect().width || 1;
    const span = layer.endMs - layer.startMs;
    const startX = e.clientX;
    let next: Drag = {
      id: layer.id,
      mode,
      startMs: layer.startMs,
      endMs: layer.endMs,
      moved: false,
    };
    setDrag(next);

    const move = (ev: MouseEvent) => {
      const dMs = ((ev.clientX - startX) / trackW) * dur;
      let s = layer.startMs;
      let en = layer.endMs;
      if (mode === "move") {
        let ns = Math.max(0, Math.min(dur - span, layer.startMs + dMs));
        s = Math.round(ns);
        en = Math.round(ns + span);
      } else if (mode === "start") {
        s = Math.round(Math.max(0, Math.min(layer.endMs - MIN_SPAN_MS, layer.startMs + dMs)));
        en = layer.endMs;
      } else {
        s = layer.startMs;
        en = Math.round(Math.min(dur, Math.max(layer.startMs + MIN_SPAN_MS, layer.endMs + dMs)));
      }
      next = { ...next, startMs: s, endMs: en, moved: next.moved || Math.abs(ev.clientX - startX) > 3 };
      setDrag(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (next.moved) onSetLayerRange(next.id, next.startMs, next.endMs);
      setDrag(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Drag a keyframe diamond to retime it. A drag commits the new time; a plain
  // click (no movement) deletes the keyframe (the prior behaviour). The diamond's
  // x maps to absolute comp time, so it can be dragged anywhere in the track.
  const startKfDrag = (e: React.MouseEvent, layer: Layer, tm: number) => {
    e.stopPropagation(); // don't move the block or scrub the playhead
    const el = tracksRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    let toMs = tm;
    let moved = false;
    const move = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) > 3) moved = true;
      const pct = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      toMs = Math.round(pct * dur);
      if (moved) setKfDrag({ id: layer.id, fromMs: tm, toMs });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (moved && toMs !== tm) onMoveKeyframe(layer.id, tm, toMs);
      else if (!moved) onDeleteKeyframe(layer.id, tm);
      setKfDrag(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const seekFromX = (clientX: number) => {
    const el = tracksRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    onSeek(Math.round(pct * dur));
  };

  const onMouseDown = (e: React.MouseEvent) => {
    seekFromX(e.clientX);
    const move = (ev: MouseEvent) => seekFromX(ev.clientX);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const seconds = Math.ceil(dur / 1000);
  const ticks = Array.from({ length: seconds + 1 }, (_, i) => i);

  return (
    <div className="timeline">
      <div className="tl-grid">
        <div className="tl-corner">
          <span className="tl-corner-label">Layers</span>
          <span className="tl-zoom">
            <button onClick={() => zoomBy(1 / 1.5)} title="Zoom out (Ctrl+wheel)">−</button>
            <button onClick={() => setZoom(1)} title="Reset zoom">
              {Math.round(zoom * 100)}%
            </button>
            <button onClick={() => zoomBy(1.5)} title="Zoom in (Ctrl+wheel)">＋</button>
          </span>
        </div>

        <div className="tl-ruler">
          <div className="tl-ruler-inner" ref={rulerInnerRef} style={{ width: `${zoom * 100}%` }}>
            {ticks.map((s) => (
              <span
                key={s}
                className="tl-tick"
                style={{ left: `${((s * 1000) / dur) * 100}%` }}
              >
                {s}s
              </span>
            ))}
          </div>
        </div>

        <div className="tl-labels">
          {layers.map((l) => (
            <div
              key={l.id}
              data-layer-id={l.id}
              className={
                "tl-label" +
                (l.id === selectedId ? " selected" : "") +
                (l.hidden ? " hidden" : "") +
                (l.id === rowDragId ? " row-dragging" : "") +
                (l.id === rowOverId && rowDragId != null && rowOverId !== rowDragId
                  ? " row-over"
                  : "")
              }
              title="Drag onto another layer to drop this one under it"
              onClick={() => onSelect(l.id)}
              onMouseDown={(e) => startRowDrag(e, l)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.nativeEvent.stopPropagation();
                onLayerContextMenu(l.id, e.clientX, e.clientY);
              }}
            >
              <button
                className={"dot" + (l.hidden ? "" : " on")}
                title={l.hidden ? "Show layer" : "Hide layer"}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleHidden(l.id);
                }}
              />
              <span className="tl-label-name">{l.name}</span>
              <span className="tl-label-kind">{l.kind.kind}</span>
              <button
                className="tl-del"
                title="Delete layer"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteLayer(l.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <div
          className="tl-tracks-scroll"
          ref={scrollRef}
          onScroll={onTracksScroll}
          onWheel={onWheel}
        >
          <div
            className="tl-tracks-inner"
            ref={tracksRef}
            style={{ width: `${zoom * 100}%` }}
            onMouseDown={onMouseDown}
          >
          {layers.map((l) => {
            // While dragging this layer, render from the live preview range.
            const sMs = drag?.id === l.id ? drag.startMs : l.startMs;
            const eMs = drag?.id === l.id ? drag.endMs : l.endMs;
            const left = (sMs / dur) * 100;
            const width = ((eMs - sMs) / dur) * 100;
            const span = Math.max(1, eMs - sMs);
            return (
              <div key={l.id} className={"tl-track" + (l.hidden ? " hidden" : "")}>
                <div
                  className="tl-block"
                  style={{ left: `${left}%`, width: `${width}%`, background: kindColor(l) }}
                  title={`${(sMs / 1000).toFixed(2)}s – ${(eMs / 1000).toFixed(2)}s · drag to move, edges to trim`}
                  onMouseDown={(e) => startBlockDrag(e, l, "move")}
                >
                  <span
                    className="tl-trim tl-trim-l"
                    title="Trim start"
                    onMouseDown={(e) => startBlockDrag(e, l, "start")}
                  />
                  <span className="tl-block-name">{l.name}</span>
                  <span
                    className="tl-trim tl-trim-r"
                    title="Trim end"
                    onMouseDown={(e) => startBlockDrag(e, l, "end")}
                  />
                  {keyframeTimes(l).map((tm, i) => {
                    const effTm =
                      kfDrag && kfDrag.id === l.id && kfDrag.fromMs === tm ? kfDrag.toMs : tm;
                    return (
                      <button
                        key={i}
                        className={
                          "tl-kf" +
                          (kfDrag && kfDrag.id === l.id && kfDrag.fromMs === tm ? " dragging" : "")
                        }
                        title="Drag to retime · click to delete"
                        style={{ left: `${((effTm - sMs) / span) * 100}%` }}
                        onMouseDown={(e) => startKfDrag(e, l, tm)}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
            <div className="tl-playhead" style={{ left: `${(time / dur) * 100}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}
