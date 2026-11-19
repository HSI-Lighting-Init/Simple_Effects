import type { Layer } from "../bindings/Layer";

/**
 * Video source paths that must seek their ORIGINAL during export, not the
 * short-GOP seek proxy: the clip's layer carries Ultra Key (WP8). The proxy is a
 * second lossy H.264 4:2:0 encode, and the keyer measures exactly the chroma
 * edges that encode changes.
 *
 * The video-element pool is keyed by source path, so a path is either proxy or
 * original for the whole export. If one layer on a path is keyed, that path
 * stays on the original; an unkeyed layer sharing it only seeks slower.
 */
export function keyedVideoSources(layers: Layer[]): Set<string> {
  const keyed = new Set<string>();
  const walk = (list: Layer[]) => {
    for (const l of list) {
      if (l.kind.kind === "video" && l.effects.some((e) => e.kind === "ultrakey")) keyed.add(l.kind.src);
      if (l.kind.kind === "group") walk(l.kind.children);
    }
  };
  walk(layers);
  return keyed;
}
