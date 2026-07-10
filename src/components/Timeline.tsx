// The timeline. One track per layer (top layer on top), so every image you add
// gets its own row. Blocks show each layer's [startMs, endMs] range; diamonds
// mark keyframes; the playhead is draggable to scrub.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Project } from "../bindings/Project";
import type { Layer } from "../bindings/Layer";
import type { FrameCell } from "../bindings/FrameCell";
import type { Effect } from "../bindings/Effect";
import type { Track } from "../bindings/Track";

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
  if (k.kind === "group") return "#c9a227";
  if (k.kind === "adjustment") return "#9a6cff";
  return "#3bb6a6"; // image
}

/** Unique keyframe times across a layer's transform tracks (+ text decompose,
 *  + 3D-shape rotations). */
/** Push every keyframeable `Track` of an effect stack onto `tracks`. Shared by
 *  layer-level rows and per-cell child rows. */
function pushEffectTracks(effects: Effect[], tracks: Track[]) {
  for (const e of effects) {
    if (e.kind === "blur") tracks.push(e.radius);
    else if (e.kind === "hue") tracks.push(e.degrees);
    else if (e.kind === "wipe") tracks.push(e.position, e.softness);
    else if (e.kind === "shinyclouds")
      tracks.push(e.intensity, e.scale, e.speed, e.complexity, e.contrast, e.brightness, e.opacity);
    else if (e.kind === "gpuoverlay")
      tracks.push(e.intensity, e.scale, e.speed, e.detail, e.softness, e.extra, e.opacity);
    else tracks.push(e.amount);
  }
}

function keyframeTimes(l: Layer): number[] {
  const t = l.transform;
  const tracks = [t.x, t.y, t.scaleX, t.scaleY, t.rotation, t.opacity];
  const set = new Set<number>();
  if (l.kind.kind === "text") {
    tracks.push(l.kind.decompose);
    for (const k of l.kind.colorKeys) set.add(k.timeMs);
  }
  if (l.kind.kind === "shape3d")
    tracks.push(
      l.kind.width, l.kind.height, l.kind.depth,
      l.kind.rotation_x, l.kind.rotation_y, l.kind.rotation_z,
      l.kind.perspective, l.kind.focal_length, l.kind.coverage, l.kind.radius
    );
  if (l.kind.kind === "shape2d") {
    const s = l.kind.style;
    tracks.push(
      s.width, s.height, s.sides,
      s.cornerRadius, s.bend, s.borderWidth, s.glowSize, s.glowOpacity, s.glowIntensity,
      s.shadowBlur, s.shadowOffsetX, s.shadowOffsetY, s.shadowOpacity
    );
    // Keyframeable colours (fill / border / glow / shadow) carry their own key
    // lists, so collect their times too.
    for (const keys of [s.fillKeys, s.borderColorKeys, s.glowColorKeys, s.shadowColorKeys])
      for (const k of keys) set.add(k.timeMs);
  }
  if (l.attach) tracks.push(l.attach.u, l.attach.v, l.attach.scale, l.attach.rotation);
  pushEffectTracks(l.effects, tracks);
  for (const tr of tracks) for (const k of tr.keys) set.add(k.timeMs);
  return [...set];
}

/** Unique keyframe times for one grid cell (its zoom + effect stack) — drives the
 *  cell's child-timeline row. */
function cellKeyTimes(cell: FrameCell): number[] {
  const tracks: Track[] = [cell.zoom, cell.panX, cell.panY];
  pushEffectTracks(cell.effects, tracks);
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
  /** Replace the whole multi-selection at once (used by drag/marquee select). */
  onSelectMany: (ids: number[]) => void;
  onToggleHidden: (id: number) => void;
  onSeek: (t: number) => void;
  onDeleteLayer: (id: number) => void;
  onDeleteKeyframe: (id: number, tMs: number) => void;
  /** Retime a keyframe (drag a diamond): move all keys at `fromMs` to `toMs`. */
  onMoveKeyframe: (id: number, fromMs: number, toMs: number) => void;
  onLayerContextMenu: (id: number, x: number, y: number) => void;
  /** The selected grid cell (row-major) of the selected layer, if any. */
  selectedCell: number | null;
  /** Select a grid cell (click its child-timeline row). */
  onSelectCell: (layerId: number, cell: number) => void;
  /** Right-click a grid cell's row → its effect copy/paste menu. */
  onCellContextMenu: (layerId: number, cell: number, x: number, y: number) => void;
  /** Retime a grid cell's keyframe (drag a diamond in its child row). */
  onMoveCellKeyframe: (layerId: number, cell: number, fromMs: number, toMs: number) => void;
  /** Delete a grid cell's keyframe (click a diamond in its child row). */
  onDeleteCellKeyframe: (layerId: number, cell: number, tMs: number) => void;
  onSetLayerRange: (id: number, startMs: number, endMs: number) => void;
  /** Commit a new z-order (full list of layer ids, bottom-first). */
  onReorder: (order: number[]) => void;
  /** Cut tool: when true, clicking a block splits it at the click. */
  razor: boolean;
  /** Split a layer at a time (used by the cut tool). */
  onSplitLayer: (id: number, tMs: number) => void;
  /** Double-click a group layer to enter it and edit its children. */
  onEnterGroup: (id: number) => void;
  /** Width (px) of the layers/names column. */
  labelsW: number;
  /** Commit a new layers-column width (dragged the divider). */
  onResizeLabels: (w: number) => void;
  /** The section of the comp to export [inMs, outMs], or null for the whole comp. */
  exportRange: { inMs: number; outMs: number } | null;
  /** Set (or clear, with null) the export range. */
  onSetExportRange: (r: { inMs: number; outMs: number } | null) => void;
}

export default function Timeline({
  project,
  time,
  selectedId,
  selectedIds,
  onSelect,
  onSelectMany,
  onToggleHidden,
  onSeek,
  onDeleteLayer,
  onDeleteKeyframe,
  onMoveKeyframe,
  onLayerContextMenu,
  selectedCell,
  onSelectCell,
  onCellContextMenu,
  onMoveCellKeyframe,
  onDeleteCellKeyframe,
  onSetLayerRange,
  onReorder,
  razor,
  onSplitLayer,
  onEnterGroup,
  labelsW,
  onResizeLabels,
  exportRange,
  onSetExportRange,
}: Props) {
  const tracksRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Layer-row reorder (drag a layer onto the one you want it under).
  const [rowDragId, setRowDragId] = useState<number | null>(null);
  const [rowOverId, setRowOverId] = useState<number | null>(null);
  // Keyframe-diamond drag (retime). `fromMs` identifies which diamond is moving;
  // `cell` (row-major) is set when dragging a per-cell child-row diamond.
  const [kfDrag, setKfDrag] = useState<
    { id: number; cell?: number; fromMs: number; toMs: number } | null
  >(null);
  // Grid layers whose per-cell child rows are expanded in the timeline.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Auto-expand a grid's cell rows the first time it's selected (discoverable);
  // the chevron can still collapse it afterwards. Idempotent, so it won't fight
  // a manual collapse until the selection changes again.
  useEffect(() => {
    if (selectedId == null) return;
    const l = project.layers.find((x) => x.id === selectedId);
    if (l?.kind.kind !== "framegrid") return;
    setExpanded((prev) => (prev.has(selectedId) ? prev : new Set(prev).add(selectedId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  // Rubber-band (marquee) selection box, in tracks-inner content px. Non-null
  // only while dragging across empty track space.
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
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
  // Zoom while keeping one point fixed on screen. `zoomAnchorRef` records the
  // timeline fraction to pin and the screen x (px from the tracks' left edge) it
  // should stay at; a layout effect re-derives scrollLeft once the new width is in.
  const zoomAnchorRef = useRef<{ frac: number; screenX: number } | null>(null);
  const zoomAround = (factor: number, screenX?: number) => {
    const s = scrollRef.current;
    setZoom((z) => {
      const nz = Math.min(40, Math.max(1, z * factor));
      if (s && nz !== z) {
        const cw = s.clientWidth || 1;
        // Default anchor: the playhead's current on-screen position.
        const ax = screenX ?? (time / dur) * cw * z - s.scrollLeft;
        const frac = (s.scrollLeft + ax) / (cw * z);
        zoomAnchorRef.current = { frac, screenX: ax };
      }
      return nz;
    });
  };
  const zoomBy = (factor: number) => zoomAround(factor);
  // After a zoom, pin the recorded anchor by adjusting the horizontal scroll (so
  // zooming grows/shrinks around the playhead or cursor, not the left edge).
  useLayoutEffect(() => {
    const s = scrollRef.current;
    const a = zoomAnchorRef.current;
    if (!s || !a) return;
    zoomAnchorRef.current = null;
    const cw = s.clientWidth || 1;
    s.scrollLeft = a.frac * cw * zoom - a.screenX;
    onTracksScroll(); // keep the frozen ruler/labels in sync this frame
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);
  // Wheel over the tracks area: Ctrl/⌘ zooms; a plain vertical wheel scrolls the
  // timeline HORIZONTALLY (time) whenever it's zoomed/overflowing — that's the axis
  // you navigate. Shift-wheel or a horizontal wheel keeps native behaviour, and
  // when nothing overflows horizontally the wheel scrolls layers vertically as
  // usual. Attached natively (not via React's passive onWheel) so preventDefault
  // takes effect.
  useEffect(() => {
    const s = scrollRef.current;
    if (!s) return;
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // Anchor the zoom under the cursor (natural "zoom where you point").
        const cursorX = e.clientX - s.getBoundingClientRect().left;
        zoomAround(e.deltaY < 0 ? 1.2 : 1 / 1.2, cursorX);
        return;
      }
      if (e.shiftKey) return; // let the browser scroll the other axis
      const horiz = s.scrollWidth > s.clientWidth + 1;
      if (horiz && e.deltaY !== 0 && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        s.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    s.addEventListener("wheel", handler, { passive: false });
    return () => s.removeEventListener("wheel", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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

  // Drag/click a diamond in a grid cell's child row (retime on drag, delete on
  // click). Positions map over the full tracks width like the playhead, so cell
  // keys sit at their absolute comp time.
  const startCellKfDrag = (e: React.MouseEvent, layerId: number, cell: number, tm: number) => {
    e.stopPropagation();
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
      if (moved) setKfDrag({ id: layerId, cell, fromMs: tm, toMs });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (moved && toMs !== tm) onMoveCellKeyframe(layerId, cell, tm, toMs);
      else if (!moved) onDeleteCellKeyframe(layerId, cell, tm);
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
    // Snap the playhead onto keyframes, layer edges, and comp bounds — the mirror
    // of how layers snap onto the playhead when they're dragged. Keyframes are the
    // tightest target so scrubbing lands exactly on a diamond.
    const thresholdMs = (7 / (r.width || 1)) * dur;
    const kfTargets = project.layers.flatMap((l) => {
      const times = keyframeTimes(l);
      if (l.kind.kind === "framegrid") {
        for (const cell of l.kind.cells) times.push(...cellKeyTimes(cell));
      }
      return times;
    });
    let best = raw;
    let bestD = thresholdMs;
    // Keyframes first so they win ties against a coincident layer edge.
    for (const tgt of [...kfTargets, 0, dur, ...project.layers.flatMap((l) => [l.startMs, l.endMs])]) {
      const d = Math.abs(raw - tgt);
      if (d < bestD) {
        bestD = d;
        best = tgt;
      }
    }
    onSeek(Math.round(best));
  };

  // A grid layer shows its per-cell child rows while it's in the expanded set.
  // Selecting a grid auto-expands it (below), but the chevron can then collapse
  // it back — even while it stays selected.
  const gridExpanded = (l: Layer) => l.kind.kind === "framegrid" && expanded.has(l.id);

  // Which cells (row-major) of a grid get a child row: the ones carrying their
  // own effects or keyframes (the ones you'd want to retime).
  const gridChildRows = (l: Layer): { cell: number; label: string; times: number[] }[] => {
    if (l.kind.kind !== "framegrid") return [];
    const cols = l.kind.cols || 1;
    const out: { cell: number; label: string; times: number[] }[] = [];
    l.kind.cells.forEach((c, i) => {
      const times = cellKeyTimes(c);
      if (c.effects.length === 0 && times.length === 0) return;
      out.push({
        cell: i,
        label: `Cell #${i + 1} (r${Math.floor(i / cols) + 1} c${(i % cols) + 1})`,
        times,
      });
    });
    return out;
  };

  const toggleExpanded = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Convert an absolute clientX into comp ms over the (scrolling) track width.
  const msFromX = (clientX: number): number => {
    const el = tracksRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return Math.round(pct * dur);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    // Prevent the browser from starting a text selection on the ruler's tick
    // labels — dragging a selection also auto-scrolls the timeline.
    e.preventDefault();
    seekFromX(e.clientX);
    const move = (ev: MouseEvent) => seekFromX(ev.clientX);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Shift-drag across the ruler to select the export range. A near-zero drag
  // (a click) clears any range back to the whole comp.
  const MIN_RANGE_MS = 10;
  const startRangeSelect = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const anchor = msFromX(e.clientX);
    let cur = anchor;
    onSetExportRange({ inMs: anchor, outMs: anchor });
    const move = (ev: MouseEvent) => {
      cur = msFromX(ev.clientX);
      onSetExportRange({ inMs: Math.min(anchor, cur), outMs: Math.max(anchor, cur) });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const inMs = Math.min(anchor, cur);
      const outMs = Math.max(anchor, cur);
      onSetExportRange(outMs - inMs < MIN_RANGE_MS ? null : { inMs, outMs });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Drag one edge of an existing export range.
  const startRangeEdge = (e: React.MouseEvent, edge: "in" | "out") => {
    e.preventDefault();
    e.stopPropagation();
    if (!exportRange) return;
    const fixed = edge === "in" ? exportRange.outMs : exportRange.inMs;
    const move = (ev: MouseEvent) => {
      const m = msFromX(ev.clientX);
      if (edge === "in") onSetExportRange({ inMs: Math.min(m, fixed - MIN_RANGE_MS), outMs: fixed });
      else onSetExportRange({ inMs: fixed, outMs: Math.max(m, fixed + MIN_RANGE_MS) });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Corner buttons: set the in/out point to the playhead, or clear the range.
  const setRangeIn = () => {
    const outMs = exportRange?.outMs ?? dur;
    onSetExportRange({ inMs: Math.max(0, Math.min(time, outMs - MIN_RANGE_MS)), outMs });
  };
  const setRangeOut = () => {
    const inMs = exportRange?.inMs ?? 0;
    onSetExportRange({ inMs, outMs: Math.min(dur, Math.max(time, inMs + MIN_RANGE_MS)) });
  };

  // Ruler press: Shift-drag paints the export range (the section that gets
  // rendered); a plain press scrubs the playhead.
  const onRulerMouseDown = (e: React.MouseEvent) => {
    if (e.shiftKey) startRangeSelect(e);
    else onMouseDown(e);
  };

  // Rubber-band select: drag across empty track space to draw a box; every layer
  // whose block it touches becomes selected. Uses client-rect intersection so it
  // works regardless of zoom/scroll.
  const startMarquee = (e: React.MouseEvent) => {
    const inner = tracksRef.current;
    if (!inner || e.button !== 0) return;
    e.preventDefault(); // stop the native text selection
    const rect0 = inner.getBoundingClientRect();
    const start = { cx: e.clientX, cy: e.clientY, rx: e.clientX - rect0.left, ry: e.clientY - rect0.top };
    setMarquee({ x: start.rx, y: start.ry, w: 0, h: 0 });
    let moved = false;
    const move = (ev: MouseEvent) => {
      moved = true;
      const rect = inner.getBoundingClientRect();
      const rx = ev.clientX - rect.left;
      const ry = ev.clientY - rect.top;
      setMarquee({ x: Math.min(start.rx, rx), y: Math.min(start.ry, ry), w: Math.abs(rx - start.rx), h: Math.abs(ry - start.ry) });
      const l = Math.min(start.cx, ev.clientX), r = Math.max(start.cx, ev.clientX);
      const t = Math.min(start.cy, ev.clientY), b = Math.max(start.cy, ev.clientY);
      const hits: number[] = [];
      inner.querySelectorAll<HTMLElement>(".tl-block[data-lid]").forEach((el) => {
        const bb = el.getBoundingClientRect();
        if (bb.right >= l && bb.left <= r && bb.bottom >= t && bb.top <= b) {
          hits.push(Number(el.dataset.lid));
        }
      });
      onSelectMany(hits);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setMarquee(null);
      if (!moved) onSelect(null); // a plain click on empty space clears selection
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

  // Drag the divider between the layers column and the tracks to resize it.
  const startLabelsResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = labelsW;
    const move = (ev: MouseEvent) => onResizeLabels(startW + (ev.clientX - startX));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div className="timeline">
      <div
        className="tl-labels-resizer"
        style={{ left: labelsW - 3 }}
        title="Drag to resize the layers column"
        onMouseDown={startLabelsResize}
      />
      <div className="tl-grid" style={{ gridTemplateColumns: `${labelsW}px 1fr` }}>
        <div className="tl-corner">
          <span className="tl-corner-label">Layers</span>
          <span className="tl-range-btns">
            <button onClick={setRangeIn} title="Set export range start at the playhead (or Shift-drag the ruler)">[</button>
            <button onClick={setRangeOut} title="Set export range end at the playhead">]</button>
            <button
              className={exportRange ? "active" : ""}
              onClick={() => onSetExportRange(null)}
              disabled={!exportRange}
              title={exportRange ? "Clear export range (export whole comp)" : "No export range — whole comp exports"}
            >
              ⤫
            </button>
          </span>
          <span className="tl-zoom">
            <button onClick={() => zoomBy(1 / 1.5)} title="Zoom out (Ctrl+wheel)">−</button>
            <button onClick={() => setZoom(1)} title="Reset zoom">
              {Math.round(zoom * 100)}%
            </button>
            <button onClick={() => zoomBy(1.5)} title="Zoom in (Ctrl+wheel)">＋</button>
          </span>
        </div>

        <div
          className="tl-ruler"
          ref={rulerRef}
          onMouseDown={onRulerMouseDown}
          title="Click or drag to move the playhead · Shift-drag to select the export range"
        >
          <div className="tl-ruler-inner" ref={rulerInnerRef} style={{ width: `${zoom * 100}%` }}>
            {exportRange && (
              <div
                className="tl-range"
                style={{
                  left: `${(exportRange.inMs / dur) * 100}%`,
                  width: `${((exportRange.outMs - exportRange.inMs) / dur) * 100}%`,
                }}
                title={`Export range ${(exportRange.inMs / 1000).toFixed(2)}s – ${(exportRange.outMs / 1000).toFixed(2)}s`}
              >
                <span
                  className="tl-range-handle tl-range-in"
                  onMouseDown={(e) => startRangeEdge(e, "in")}
                />
                <span
                  className="tl-range-handle tl-range-out"
                  onMouseDown={(e) => startRangeEdge(e, "out")}
                />
              </div>
            )}
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
          {layers.map((l) => {
            const childRows = gridChildRows(l);
            const showChildren = gridExpanded(l);
            const isGrid = l.kind.kind === "framegrid";
            return (
            <Fragment key={l.id}>
            <div
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
              title={
                l.kind.kind === "group"
                  ? "Group · double-click to enter · click to select · drag to reorder"
                  : "Click to select · Ctrl/Shift-click to multi-select · drag onto another layer to reorder"
              }
              onMouseDown={(e) => startRowDrag(e, l)}
              onDoubleClick={() => l.kind.kind === "group" && onEnterGroup(l.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.nativeEvent.stopPropagation();
                onLayerContextMenu(l.id, e.clientX, e.clientY);
              }}
            >
              {isGrid && childRows.length > 0 ? (
                <button
                  className="tl-expand"
                  title={showChildren ? "Hide cell rows" : "Show cell rows"}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpanded(l.id);
                  }}
                >
                  {showChildren ? "▾" : "▸"}
                </button>
              ) : (
                <button
                  className={"dot" + (l.hidden ? "" : " on")}
                  title={l.hidden ? "Show layer" : "Hide layer"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleHidden(l.id);
                  }}
                />
              )}
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
            {showChildren &&
              childRows.map((cr) => (
                <div
                  key={`c${cr.cell}`}
                  className={
                    "tl-label tl-child-label" +
                    (selectedCell === cr.cell && l.id === selectedId ? " selected" : "")
                  }
                  title="Click to select this cell · right-click to copy/paste its effects"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectCell(l.id, cr.cell);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.nativeEvent.stopPropagation();
                    onCellContextMenu(l.id, cr.cell, e.clientX, e.clientY);
                  }}
                >
                  <span className="tl-child-tick">└</span>
                  <span className="tl-label-name">{cr.label}</span>
                </div>
              ))}
            </Fragment>
            );
          })}
          </div>
        </div>

        <div
          className="tl-tracks-scroll"
          ref={scrollRef}
          onScroll={onTracksScroll}
        >
          <div
            className={"tl-tracks-inner" + (razor ? " razor" : "")}
            ref={tracksRef}
            style={{ width: `${zoom * 100}%` }}
            onMouseDown={(e) => {
              // A press on empty track space (not on a block) starts a rubber-band
              // selection; a plain click there clears the selection. It never
              // scrubs the playhead (that's the ruler's job).
              if (!(e.target as HTMLElement).closest(".tl-block")) startMarquee(e);
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
            const childRows = gridChildRows(l);
            const showChildren = gridExpanded(l);
            return (
              <Fragment key={l.id}>
              <div className={"tl-track" + (l.hidden ? " hidden" : "")}>
                <div
                  data-lid={l.id}
                  className={"tl-block" + (selectedIds.includes(l.id) ? " selected" : "")}
                  style={{ left: `${left}%`, width: `${width}%`, background: kindColor(l) }}
                  title={`${(sMs / 1000).toFixed(2)}s – ${(eMs / 1000).toFixed(2)}s · drag to move, edges to trim · right-click for effects`}
                  onMouseDown={(e) => startBlockDrag(e, l, "move")}
                  onDoubleClick={() => l.kind.kind === "group" && onEnterGroup(l.id)}
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
                    const dragging =
                      kfDrag != null && kfDrag.id === l.id && kfDrag.cell == null && kfDrag.fromMs === tm;
                    const effTm = dragging ? kfDrag!.toMs : tm;
                    return (
                      <button
                        key={i}
                        className={"tl-kf" + (dragging ? " dragging" : "")}
                        title="Drag to retime · click to delete"
                        style={{ left: `${((effTm - sMs) / span) * 100}%` }}
                        onMouseDown={(e) => startKfDrag(e, l, tm)}
                      />
                    );
                  })}
                </div>
              </div>
              {showChildren &&
                childRows.map((cr) => (
                  <div
                    key={`c${cr.cell}`}
                    className={
                      "tl-track tl-child-track" +
                      (selectedCell === cr.cell && l.id === selectedId ? " selected" : "")
                    }
                    onMouseDown={(e) => {
                      // A press on empty child-row space selects the cell (but not
                      // on a diamond — that starts a keyframe drag).
                      if (!(e.target as HTMLElement).closest(".tl-kf")) onSelectCell(l.id, cr.cell);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.nativeEvent.stopPropagation();
                      onCellContextMenu(l.id, cr.cell, e.clientX, e.clientY);
                    }}
                  >
                    {/* Faint bar marking the grid layer's span for context. */}
                    <div className="tl-child-span" style={{ left: `${left}%`, width: `${width}%` }} />
                    {cr.times.map((tm, i) => {
                      const dragging =
                        kfDrag != null &&
                        kfDrag.id === l.id &&
                        kfDrag.cell === cr.cell &&
                        kfDrag.fromMs === tm;
                      const effTm = dragging ? kfDrag!.toMs : tm;
                      return (
                        <button
                          key={i}
                          className={"tl-kf tl-cell-kf" + (dragging ? " dragging" : "")}
                          title="Drag to retime · click to delete"
                          style={{ left: `${(effTm / dur) * 100}%` }}
                          onMouseDown={(e) => startCellKfDrag(e, l.id, cr.cell, tm)}
                        />
                      );
                    })}
                  </div>
                ))}
              </Fragment>
            );
          })}
            {exportRange && (
              <div
                className="tl-range-band"
                style={{
                  left: `${(exportRange.inMs / dur) * 100}%`,
                  width: `${((exportRange.outMs - exportRange.inMs) / dur) * 100}%`,
                }}
              />
            )}
            <div className="tl-playhead" style={{ left: `${(time / dur) * 100}%` }} />
            {marquee && (
              <div
                className="tl-marquee"
                style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
