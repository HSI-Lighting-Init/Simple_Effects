// The timeline. One track per layer (top layer on top), so every image you add
// gets its own row. Blocks show each layer's [startMs, endMs] range; diamonds
// mark keyframes; the playhead is draggable to scrub.
import { useEffect, useRef, useState } from "react";
import type { Project } from "../bindings/Project";
import type { Layer } from "../bindings/Layer";

/** Smallest range a layer block may be trimmed to (ms) — matches the Rust floor. */
const MIN_SPAN_MS = 50;

/** Format `ms` as a ruler label. `frames` = show the frame field (M:SS:FF); else
 * a coarser M:SS / Ns depending on magnitude. */
function tcLabel(ms: number, fps: number, frames: boolean): string {
  const tf = Math.round(ms / (1000 / fps));
  const f = ((tf % fps) + fps) % fps;
  const totalSec = Math.floor(tf / fps);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60);
  if (frames) return `${m}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
  if (m > 0) return `${m}:${String(s).padStart(2, "0")}`;
  return `${s}s`;
}

/** A live drag of a layer block: moving the whole range or trimming one edge.
 *  In "move" mode every layer in `groupIds` shifts by `deltaMs` (multi-select
 *  group move); trims only affect the primary `id`. */
interface Drag {
  id: number;
  mode: "move" | "start" | "end";
  startMs: number;
  endMs: number;
  deltaMs: number;
  groupIds: number[];
  moved: boolean;
}

function kindColor(l: Layer): string {
  const k = l.kind;
  if (k.kind === "colorpatch") return `rgb(${k.color.r}, ${k.color.g}, ${k.color.b})`;
  if (k.kind === "text") return "#6c8cff";
  if (k.kind === "shape3d") return "#b06cff";
  if (k.kind === "video") return "#e08a3c";
  if (k.kind === "audio") return "#3ca0e0";
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
  /** Every selected layer id (multi-select) — all get highlighted. */
  selectedIds: number[];
  /** Select a layer. `additive` (Ctrl/⌘/Shift-click) toggles it in a multi-select. */
  onSelect: (id: number | null, additive?: boolean) => void;
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
  /** Cut tool: when true, clicking a block splits it at the click. */
  razor: boolean;
  /** Split a layer at a time (used by the cut tool). */
  onSplitLayer: (id: number, tMs: number) => void;
}

export default function Timeline({
  project,
  time,
  selectedId,
  selectedIds,
  onSelect,
  onToggleHidden,
  onSeek,
  onDeleteLayer,
  onDeleteKeyframe,
  onMoveKeyframe,
  onLayerContextMenu,
  onSetLayerRange,
  onReorder,
  razor,
  onSplitLayer,
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
  const rulerRef = useRef<HTMLDivElement>(null);
  const rulerInnerRef = useRef<HTMLDivElement>(null);
  const labelsInnerRef = useRef<HTMLDivElement>(null);
  const dur = project.durationMs || 1;
  const fps = project.fps || 30;

  // On-screen width of the ruler (the visible track area), tracked so the tick
  // scale can adapt to how many pixels a second/frame actually occupies.
  const [viewW, setViewW] = useState(800);
  useEffect(() => {
    const el = rulerRef.current;
    if (!el) return;
    const measure = () => setViewW(el.clientWidth || 800);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The tracks area scrolls both axes; the frozen ruler mirrors its horizontal
  // scroll and the frozen labels column mirrors its vertical scroll.
  const onTracksScroll = () => {
    const s = scrollRef.current;
    if (!s) return;
    if (rulerInnerRef.current) rulerInnerRef.current.style.transform = `translateX(${-s.scrollLeft}px)`;
    if (labelsInnerRef.current) labelsInnerRef.current.style.transform = `translateY(${-s.scrollTop}px)`;
  };
  // Wheeling over the labels column scrolls the tracks vertically (which syncs back).
  const onLabelsWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) return;
    if (scrollRef.current) scrollRef.current.scrollTop += e.deltaY;
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
    // Ctrl/⌘/Shift-click adds to the multi-selection; a plain click on an already
    // multi-selected row keeps the group (so it can be group-dragged).
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (additive) onSelect(layer.id, true);
    else if (!selectedIds.includes(layer.id)) onSelect(layer.id);
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
      else if (!moved && !additive && selectedIds.includes(layer.id) && selectedIds.length > 1) {
        // Plain click on a member of a multi-selection collapses to just it.
        onSelect(layer.id);
      }
      setRowDragId(null);
      setRowOverId(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Begin dragging a layer block (move it) or one of its trim edges. Converts
  // horizontal mouse motion into ms against the track width, clamps to the comp,
  // and commits the new range once on release (so it's a single undo step).
  // Cut the layer at the comp time under `clientX` (the razor tool).
  const splitAt = (clientX: number, layer: Layer) => {
    const el = tracksRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onSplitLayer(layer.id, Math.round(pct * dur));
  };

  const startBlockDrag = (
    e: React.MouseEvent,
    layer: Layer,
    mode: Drag["mode"]
  ) => {
    e.stopPropagation(); // this is a layer edit, not a playhead scrub
    if (razor) {
      splitAt(e.clientX, layer);
      return;
    }
    // Ctrl/⌘/Shift-click toggles multi-selection (no drag). A plain click on a
    // layer that isn't already part of a multi-selection selects just it.
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (additive) {
      onSelect(layer.id, true);
      return;
    }
    const inGroup = mode === "move" && selectedIds.includes(layer.id) && selectedIds.length > 1;
    if (!inGroup) onSelect(layer.id);

    const el = tracksRef.current;
    if (!el) return;
    const trackW = el.getBoundingClientRect().width || 1;
    const span = layer.endMs - layer.startMs;
    const startX = e.clientX;

    // The layers that move together, and their ranges at drag start.
    const groupIds = inGroup ? selectedIds.slice() : [layer.id];
    const orig = new Map<number, { s: number; e: number }>();
    let groupMinStart = Infinity;
    let groupMaxEnd = -Infinity;
    for (const gid of groupIds) {
      const L = project.layers.find((l) => l.id === gid);
      if (!L) continue;
      orig.set(gid, { s: L.startMs, e: L.endMs });
      groupMinStart = Math.min(groupMinStart, L.startMs);
      groupMaxEnd = Math.max(groupMaxEnd, L.endMs);
    }

    // Snap targets: the comp bounds, the playhead, and every non-moving layer's edges.
    const thresholdMs = (7 / trackW) * dur;
    const snapTargets = [0, dur, time];
    for (const o of project.layers) {
      if (!groupIds.includes(o.id)) snapTargets.push(o.startMs, o.endMs);
    }
    const snap = (v: number) => {
      let best = v;
      let bestD = thresholdMs;
      for (const tgt of snapTargets) {
        const d = Math.abs(v - tgt);
        if (d < bestD) {
          bestD = d;
          best = tgt;
        }
      }
      return best;
    };
    let next: Drag = {
      id: layer.id,
      mode,
      startMs: layer.startMs,
      endMs: layer.endMs,
      deltaMs: 0,
      groupIds,
      moved: false,
    };
    setDrag(next);

    const move = (ev: MouseEvent) => {
      const dMs = ((ev.clientX - startX) / trackW) * dur;
      let s = layer.startMs;
      let en = layer.endMs;
      let delta = 0;
      if (mode === "move") {
        let ns = layer.startMs + dMs;
        // Snap whichever edge lands closest to a target; move the whole group together.
        const snS = snap(ns);
        const snE = snap(ns + span);
        if (snS !== ns && (snE === ns + span || Math.abs(snS - ns) <= Math.abs(snE - (ns + span)))) {
          ns = snS;
        } else if (snE !== ns + span) {
          ns = snE - span;
        }
        delta = ns - layer.startMs;
        // Keep the rigid group inside the comp bounds.
        delta = Math.max(-groupMinStart, Math.min(dur - groupMaxEnd, delta));
        s = Math.round(layer.startMs + delta);
        en = Math.round(layer.endMs + delta);
      } else if (mode === "start") {
        s = Math.round(Math.max(0, Math.min(layer.endMs - MIN_SPAN_MS, snap(layer.startMs + dMs))));
        en = layer.endMs;
      } else {
        s = layer.startMs;
        en = Math.round(Math.min(dur, Math.max(layer.startMs + MIN_SPAN_MS, snap(layer.endMs + dMs))));
      }
      next = {
        ...next,
        startMs: s,
        endMs: en,
        deltaMs: delta,
        moved: next.moved || Math.abs(ev.clientX - startX) > 3,
      };
      setDrag(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (next.moved) {
        if (mode === "move" && next.groupIds.length > 1) {
          for (const gid of next.groupIds) {
            const o = orig.get(gid);
            if (o) onSetLayerRange(gid, Math.round(o.s + next.deltaMs), Math.round(o.e + next.deltaMs));
          }
        } else {
          onSetLayerRange(next.id, next.startMs, next.endMs);
        }
      } else if (inGroup) {
        // A plain click (no drag) on a member of a multi-selection collapses to
        // just that layer.
        onSelect(layer.id);
      }
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
    if (razor) {
      splitAt(e.clientX, layer);
      return;
    }
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
    const raw = pct * dur;
    // Snap the playhead onto layer edges (and comp bounds) — the mirror of how
    // layers snap onto the playhead when they're dragged.
    const thresholdMs = (7 / (r.width || 1)) * dur;
    let best = raw;
    let bestD = thresholdMs;
    for (const tgt of [0, dur, ...project.layers.flatMap((l) => [l.startMs, l.endMs])]) {
      const d = Math.abs(raw - tgt);
      if (d < bestD) {
        bestD = d;
        best = tgt;
      }
    }
    onSeek(Math.round(best));
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

  // Adaptive ruler: pick a labelled interval that keeps ticks ~64px apart at the
  // current zoom, snapping to a "nice" value (frame multiples when zoomed right
  // in, then seconds/minutes as you zoom out). When frames are wide enough, draw
  // thin minor ticks at each frame so you can read the timeline frame by frame.
  const frameMs = 1000 / fps;
  const pxPerMs = (viewW * zoom) / dur;
  const desiredMs = 64 / Math.max(pxPerMs, 1e-6);
  const niceMs = [
    ...[1, 2, 5, 10, 15, 30].map((n) => n * frameMs),
    ...[1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600].map((s) => s * 1000),
  ].sort((a, b) => a - b);
  const labelMs = niceMs.find((c) => c >= desiredMs) ?? niceMs[niceMs.length - 1];
  const showFrames = labelMs < 1000;
  const majorTicks: number[] = [];
  for (let t = 0; t <= dur + 0.5; t += labelMs) majorTicks.push(t);
  // Minor per-frame ticks — only when a frame is at least ~6px wide and the count
  // stays reasonable, so scrolling/DOM stays cheap.
  const pxPerFrame = pxPerMs * frameMs;
  const frameCount = dur / frameMs;
  const showMinors = pxPerFrame >= 6 && frameCount <= 2000;
  const minorTicks: number[] = [];
  if (showMinors) for (let t = 0; t <= dur + 0.5; t += frameMs) minorTicks.push(t);

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

        <div className="tl-ruler" ref={rulerRef} onMouseDown={onMouseDown} title="Click or drag to move the playhead">
          <div className="tl-ruler-inner" ref={rulerInnerRef} style={{ width: `${zoom * 100}%` }}>
            {minorTicks.map((t) => (
              <span
                key={`m${t}`}
                className="tl-tick-minor"
                style={{ left: `${(t / dur) * 100}%` }}
              />
            ))}
            {majorTicks.map((t) => (
              <span
                key={`M${t}`}
                className="tl-tick"
                style={{ left: `${(t / dur) * 100}%` }}
              >
                {tcLabel(t, fps, showFrames)}
              </span>
            ))}
          </div>
        </div>

        <div className="tl-labels" onWheel={onLabelsWheel}>
          <div className="tl-labels-inner" ref={labelsInnerRef}>
          {layers.map((l) => (
            <div
              key={l.id}
              data-layer-id={l.id}
              className={
                "tl-label" +
                (selectedIds.includes(l.id) ? " selected" : "") +
                (l.id === selectedId ? " primary" : "") +
                (l.hidden ? " hidden" : "") +
                (l.id === rowDragId ? " row-dragging" : "") +
                (l.id === rowOverId && rowDragId != null && rowOverId !== rowDragId
                  ? " row-over"
                  : "")
              }
              title="Click to select · Ctrl/Shift-click to multi-select · drag onto another layer to reorder"
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
        </div>

        <div
          className="tl-tracks-scroll"
          ref={scrollRef}
          onScroll={onTracksScroll}
          onWheel={onWheel}
        >
          <div
            className={"tl-tracks-inner" + (razor ? " razor" : "")}
            ref={tracksRef}
            style={{ width: `${zoom * 100}%` }}
            onMouseDown={(e) => {
              // Clicking empty track space clears the selection — it never scrubs
              // the playhead (that's the ruler's job).
              if (e.target === e.currentTarget) onSelect(null);
            }}
          >
          {layers.map((l) => {
            // While dragging, render from the live preview range. In a group move
            // every selected layer shifts by the same delta.
            let sMs = l.startMs;
            let eMs = l.endMs;
            if (drag && drag.groupIds.includes(l.id)) {
              if (drag.mode === "move") {
                sMs = Math.round(l.startMs + drag.deltaMs);
                eMs = Math.round(l.endMs + drag.deltaMs);
              } else if (drag.id === l.id) {
                sMs = drag.startMs;
                eMs = drag.endMs;
              }
            }
            const left = (sMs / dur) * 100;
            const width = ((eMs - sMs) / dur) * 100;
            const span = Math.max(1, eMs - sMs);
            return (
              <div key={l.id} className={"tl-track" + (l.hidden ? " hidden" : "")}>
                <div
                  className={"tl-block" + (selectedIds.includes(l.id) ? " selected" : "")}
                  style={{ left: `${left}%`, width: `${width}%`, background: kindColor(l) }}
                  title={`${(sMs / 1000).toFixed(2)}s – ${(eMs / 1000).toFixed(2)}s · drag to move, edges to trim · right-click for effects`}
                  onMouseDown={(e) => startBlockDrag(e, l, "move")}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.nativeEvent.stopPropagation();
                    if (!selectedIds.includes(l.id)) onSelect(l.id);
                    onLayerContextMenu(l.id, e.clientX, e.clientY);
                  }}
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
