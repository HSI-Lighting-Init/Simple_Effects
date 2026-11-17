// The media bin: a staging area (left of the preview) for images you've imported
// but haven't necessarily placed on the timeline yet. Import via the file dialog
// or by dropping files onto the app; click a thumbnail to add it to the timeline,
// drag it onto the timeline to place it there.
import type { MouseEvent as ReactMouseEvent } from "react";
import { mediaKind } from "../lib/media";

interface Props {
  /** Absolute image paths in the bin, in import order. */
  media: string[];
  /** path → data: URL thumbnail (shared with the layer image cache). */
  thumbs: Record<string, string>;
  /** Open the multi-select import dialog. */
  onImport: () => void;
  /** Add this media item to the timeline as a new image layer. */
  onAddToTimeline: (path: string) => void;
  /** Remove an item from the bin (does not touch layers already using it). */
  onRemove: (path: string) => void;
  /** The pointer moved past the drag threshold: a drag of `path` has started. */
  onDragToTimeline: (path: string) => void;
  /** Files loaded so far while the bin is importing; null when idle. */
  progress?: { done: number; total: number } | null;
}

/** Just the file name (for the label under each thumbnail). */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export default function MediaPanel({ media, thumbs, onImport, onAddToTimeline, onRemove, onDragToTimeline, progress }: Props) {
  // Click adds; dragging past a few pixels hands the path to the timeline, which
  // owns the drop. Not HTML5 drag-and-drop: WebView2 swallows it on Windows.
  const startPress = (e: ReactMouseEvent, path: string) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".media-remove")) return;
    e.preventDefault(); // stop the native text selection while dragging
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev: MouseEvent) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) <= 4) return;
      off();
      onDragToTimeline(path);
    };
    // A release before the threshold is still a click.
    const up = () => {
      off();
      onAddToTimeline(path);
    };
    const off = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <aside className="media-panel">
      <div className="media-head">
        <span className="media-title">Media</span>
        <button className="media-import" onClick={onImport} title="Import images…">
          ＋ Import
        </button>
      </div>
      {progress && progress.total > 0 && (
        <div className="media-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
          <span className="media-progress-label">
            Importing {Math.min(progress.done + 1, progress.total)} of {progress.total}…
          </span>
          <div className="media-progress-track">
            {/* A sliver even at 0 so a single big file doesn't look stuck. */}
            <div className="media-progress-fill" style={{ width: `${Math.max(6, (progress.done / progress.total) * 100)}%` }} />
          </div>
        </div>
      )}
      {media.length === 0 ? (
        <div className="media-empty">
          Drop images here
          <span className="muted">or use ＋ Import</span>
        </div>
      ) : (
        <div className="media-grid">
          {media.map((path) => {
            const kind = mediaKind(path) ?? "image";
            return (
            <div
              key={path}
              className="media-item"
              title={`${baseName(path)} (${kind})\nClick to add to the timeline, drag to place it`}
              onMouseDown={(e) => startPress(e, path)}
            >
              <div className="media-thumb">
                {thumbs[path] ? (
                  <img src={thumbs[path]} alt={baseName(path)} draggable={false} />
                ) : (
                  <span className="media-icon">{kind === "audio" ? "♪" : kind === "video" ? "▶" : "…"}</span>
                )}
                {kind !== "image" && <span className="media-badge">{kind === "audio" ? "AUDIO" : "VIDEO"}</span>}
              </div>
              <span className="media-name">{baseName(path)}</span>
              <button
                className="media-remove"
                title="Remove from bin"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(path);
                }}
              >
                ✕
              </button>
            </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
