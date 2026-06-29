// The timeline. One track per layer (top layer on top), so every image you add
// gets its own row. Blocks show each layer's [startMs, endMs] range; diamonds
// mark keyframes; the playhead is draggable to scrub.
import { useRef } from "react";
import type { Project } from "../bindings/Project";
import type { Layer } from "../bindings/Layer";

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
  onLayerContextMenu: (id: number, x: number, y: number) => void;
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
  onLayerContextMenu,
}: Props) {
  const tracksRef = useRef<HTMLDivElement>(null);
  const dur = project.durationMs || 1;
  const layers = [...project.layers].reverse();

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
        <div className="tl-corner">Layers</div>

        <div className="tl-ruler">
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

        <div className="tl-labels">
          {layers.map((l) => (
            <div
              key={l.id}
              className={
                "tl-label" +
                (l.id === selectedId ? " selected" : "") +
                (l.hidden ? " hidden" : "")
              }
              onClick={() => onSelect(l.id)}
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

        <div className="tl-tracks" ref={tracksRef} onMouseDown={onMouseDown}>
          {layers.map((l) => {
            const left = (l.startMs / dur) * 100;
            const width = ((l.endMs - l.startMs) / dur) * 100;
            const span = Math.max(1, l.endMs - l.startMs);
            return (
              <div key={l.id} className={"tl-track" + (l.hidden ? " hidden" : "")}>
                <div
                  className="tl-block"
                  style={{ left: `${left}%`, width: `${width}%`, background: kindColor(l) }}
                >
                  <span className="tl-block-name">{l.name}</span>
                  {keyframeTimes(l).map((tm, i) => (
                    <button
                      key={i}
                      className="tl-kf"
                      title="Delete keyframe"
                      style={{ left: `${((tm - l.startMs) / span) * 100}%` }}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteKeyframe(l.id, tm);
                      }}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          <div className="tl-playhead" style={{ left: `${(time / dur) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
