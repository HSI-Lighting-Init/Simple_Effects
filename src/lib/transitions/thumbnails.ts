// Transition preview-thumbnail generator.
//
// Renders a transition at a few progress points into a filmstrip canvas (or data
// URL), for pickers/galleries. Works with any Clip pair; when no clips are given
// it synthesises two labelled placeholder frames so a thumbnail can be produced
// offline (e.g. to pre-bake a gallery).

import type { Clip } from "./types";
import { createTransition, REGISTRY } from "./registry";

export interface ThumbnailOptions {
  /** Cell width/height in px (thumb is `frames * cellW` wide). */
  cellW?: number;
  cellH?: number;
  /** Number of progress samples across the strip. */
  frames?: number;
  /** Params forwarded to the transition. */
  params?: Record<string, unknown>;
  fromClip?: Clip;
  toClip?: Clip;
}

/** Build a simple labelled placeholder clip (used when no real clip is supplied). */
export function placeholderClip(label: string, bg: string, w = 320, h = 180): Clip {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d");
  if (ctx) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    // corner markers so motion is visible in a thumbnail
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(8, 8, 40, 40);
    ctx.fillRect(w - 48, h - 48, 40, 40);
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.round(h / 5)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, w / 2, h / 2);
  }
  return { source: cv, width: w, height: h };
}

/** Render a filmstrip thumbnail for one transition id into `target`. */
export function renderThumbnail(id: string, target: HTMLCanvasElement, opts: ThumbnailOptions = {}): HTMLCanvasElement {
  const cellW = opts.cellW ?? 160;
  const cellH = opts.cellH ?? 90;
  const frames = Math.max(2, opts.frames ?? 4);
  const from = opts.fromClip ?? placeholderClip("A", "#2b6cb0", cellW, cellH);
  const to = opts.toClip ?? placeholderClip("B", "#c05621", cellW, cellH);

  const tr = createTransition(id, from, to, { outWidth: cellW, outHeight: cellH, ...opts.params });
  target.width = cellW * frames;
  target.height = cellH;
  const ctx = target.getContext("2d");
  if (!ctx) return target;

  const cell = document.createElement("canvas");
  cell.width = cellW;
  cell.height = cellH;
  for (let i = 0; i < frames; i++) {
    const p = frames === 1 ? 0.5 : i / (frames - 1);
    tr.render(cell, p);
    ctx.drawImage(cell, i * cellW, 0);
  }
  return target;
}

/** Render a thumbnail and return it as a PNG data URL. */
export function thumbnailDataUrl(id: string, opts: ThumbnailOptions = {}): string {
  const cv = document.createElement("canvas");
  renderThumbnail(id, cv, opts);
  return cv.toDataURL("image/png");
}

/** Generate data-URL thumbnails for every registered transition. */
export function generateAllThumbnails(opts: ThumbnailOptions = {}): { id: string; label: string; category: string; url: string }[] {
  return REGISTRY.map((m) => ({
    id: m.id,
    label: m.label,
    category: m.category,
    url: thumbnailDataUrl(m.id, opts),
  }));
}
