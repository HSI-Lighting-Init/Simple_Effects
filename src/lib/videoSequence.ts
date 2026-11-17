import type { Layer } from "../bindings/Layer";

/** Part of the play-one-after-another sequence: a video, or a flat image (an
 *  image pinned to a 3D shape is a decal, not a clip). */
const isClipLayer = (l: Layer): boolean =>
  l.kind.kind === "video" || (l.kind.kind === "image" && l.attach == null);

/** The latest end time of any clip layer (null when there is none). */
export function clipsEndMs(layers: Layer[]): number | null {
  let end: number | null = null;
  for (const l of layers) {
    if (isClipLayer(l)) end = end == null ? l.endMs : Math.max(end, l.endMs);
  }
  return end;
}

/** Where a dropped media file lands: a clip snaps to the nearest clip edge (and
 *  ripples later layers) or to the playhead when that is nearer (no ripple — it
 *  stacks there, like adding at the playhead); anything else lands at the
 *  pointer untouched. */
export function mediaDropTarget(
  layers: Layer[],
  ms: number,
  isClip: boolean,
  playheadMs?: number,
): { ms: number; ripple: boolean } {
  if (!isClip) return { ms, ripple: false };
  const edges: number[] = [];
  for (const l of layers) {
    if (isClipLayer(l)) edges.push(l.startMs, l.endMs);
  }
  if (edges.length === 0) return { ms: playheadMs ?? ms, ripple: false };
  let best = edges[0];
  for (const e of edges) {
    const d = Math.abs(e - ms);
    const bestD = Math.abs(best - ms);
    if (d < bestD || (d === bestD && e < best)) best = e; // ties → earlier edge
  }
  // An edge wins ties, so a playhead sitting on an edge still inserts there.
  if (playheadMs != null && Math.abs(playheadMs - ms) < Math.abs(best - ms))
    return { ms: playheadMs, ripple: false };
  return { ms: best, ripple: true };
}
