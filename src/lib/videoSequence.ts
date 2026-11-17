import type { Layer } from "../bindings/Layer";

/** The latest end time of any video layer (null when there is none). */
export function videoEndMs(layers: Layer[]): number | null {
  let end: number | null = null;
  for (const l of layers) {
    if (l.kind.kind === "video") end = end == null ? l.endMs : Math.max(end, l.endMs);
  }
  return end;
}

/** Where a dropped media file lands: a video snaps to the nearest video edge and
 *  ripples later layers; anything else lands at the pointer untouched. */
export function mediaDropTarget(
  layers: Layer[],
  ms: number,
  isVideo: boolean,
): { ms: number; ripple: boolean } {
  if (!isVideo) return { ms, ripple: false };
  const edges: number[] = [];
  for (const l of layers) {
    if (l.kind.kind === "video") edges.push(l.startMs, l.endMs);
  }
  if (edges.length === 0) return { ms, ripple: false };
  let best = edges[0];
  for (const e of edges) {
    const d = Math.abs(e - ms);
    const bestD = Math.abs(best - ms);
    if (d < bestD || (d === bestD && e < best)) best = e; // ties → earlier edge
  }
  return { ms: best, ripple: true };
}
