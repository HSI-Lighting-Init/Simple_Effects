// The media bin: a staging area (left of the preview) for images you've imported
// but haven't necessarily placed on the timeline yet. Import via the file dialog
// or by dropping files onto the app; click a thumbnail to drop it onto the
// timeline as a new image layer.
import type { DragEvent as ReactDragEvent } from "react";
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
}

/** Just the file name (for the label under each thumbnail). */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export default function MediaPanel({ media, thumbs, onImport, onAddToTimeline, onRemove }: Props) {
  // Let an item be dragged onto the preview/timeline (a future drop target can
  // read the path from dataTransfer); clicking is the primary "add" action.
  const onDragStart = (e: ReactDragEvent, path: string) => {
    e.dataTransfer.setData("application/x-sefx-media", path);
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <aside className="media-panel">
      <div className="media-head">
        <span className="media-title">Media</span>
        <button className="media-import" onClick={onImport} title="Import images…">
          ＋ Import
        </button>
      </div>
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
              title={`${baseName(path)} (${kind})\nClick to add to the timeline`}
              draggable
              onDragStart={(e) => onDragStart(e, path)}
              onClick={() => onAddToTimeline(path)}
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
