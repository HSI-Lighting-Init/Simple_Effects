import type { Layer } from "../bindings/Layer";

/** A sound's link: the video it came from, and whether it's tucked. */
function linkOf(l: Layer): { video: number; tucked: boolean } | null {
  if (l.kind.kind !== "audio") return null;
  const video = l.kind.linkedVideo;
  return video == null ? null : { video, tucked: l.kind.tucked };
}

/** The sound's linked video id when that video is in `layers`. */
export function soundOwner(layers: Layer[], soundId: number): number | null {
  const l = layers.find((x) => x.id === soundId);
  const k = l && linkOf(l);
  if (!k) return null;
  return layers.some((x) => x.id === k.video) ? k.video : null;
}

/** Tucked only when the flag is on and the linked video is in the list. */
export function isTucked(l: Layer, layers: Layer[]): boolean {
  const k = linkOf(l);
  return !!k && k.tucked && layers.some((x) => x.id === k.video);
}

/** Every sound linked to `videoId` (tucked or shown), in list order. */
export function linkedSounds(layers: Layer[], videoId: number): Layer[] {
  if (!layers.some((l) => l.id === videoId)) return [];
  return layers.filter((l) => linkOf(l)?.video === videoId);
}

/** `videoId`'s tucked sounds, in list order. */
export function tuckedSounds(layers: Layer[], videoId: number): Layer[] {
  if (!layers.some((l) => l.id === videoId)) return [];
  return layers.filter((l) => {
    const k = linkOf(l);
    return k?.video === videoId && k.tucked;
  });
}
