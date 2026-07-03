// Headless audio playback controller. Renders nothing; it owns one
// <HTMLAudioElement> per audio layer and keeps them synced to the playhead:
// during playback each plays over its [start, end] range at the right offset,
// and scrubbing/pausing pauses them. (This is preview playback only; the export
// muxes the same clips into the output file via ffmpeg — see `export_video`.)
import { useEffect, useRef } from "react";
import type { Project } from "../bindings/Project";
import { getMediaUrl } from "../lib/media";

export default function AudioLayers({
  project,
  timeMs,
  playing,
}: {
  project: Project;
  timeMs: number;
  playing: boolean;
}) {
  const els = useRef<Map<number, HTMLAudioElement>>(new Map());
  const audioLayers = project.layers.filter((l) => l.kind.kind === "audio");
  // Key changes only when the set of audio layers / their sources change.
  const sig = audioLayers
    .map((l) => `${l.id}:${l.kind.kind === "audio" ? l.kind.src : ""}`)
    .join("|");

  // Create / dispose elements as audio layers come and go.
  useEffect(() => {
    const ids = new Set(audioLayers.map((l) => l.id));
    for (const [id, el] of els.current) {
      if (!ids.has(id)) {
        el.pause();
        el.removeAttribute("src");
        el.load();
        els.current.delete(id);
      }
    }
    for (const l of audioLayers) {
      if (l.kind.kind !== "audio") continue;
      if (!els.current.has(l.id)) {
        const a = new Audio();
        a.preload = "auto";
        els.current.set(l.id, a);
        getMediaUrl(l.kind.src)
          .then((url) => {
            a.src = url;
          })
          .catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Sync playback whenever the playhead or play-state changes.
  useEffect(() => {
    for (const l of audioLayers) {
      if (l.kind.kind !== "audio") continue;
      const a = els.current.get(l.id);
      if (!a) continue;
      const durMs = l.kind.durationMs;
      const inRange = timeMs >= l.startMs && timeMs < l.endMs;
      const localSec = Math.max(0, (timeMs - l.startMs) / 1000);
      const target = durMs > 0 ? Math.min(localSec, durMs / 1000) : localSec;
      if (playing && inRange && !l.hidden) {
        if (a.paused) {
          try {
            a.currentTime = target;
          } catch {
            /* not seekable yet */
          }
          a.play().catch(() => {});
        } else if (Math.abs(a.currentTime - target) > 0.35) {
          try {
            a.currentTime = target;
          } catch {
            /* ignore */
          }
        }
      } else if (!a.paused) {
        a.pause();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeMs, playing, sig]);

  // Pause everything on unmount.
  useEffect(
    () => () => {
      for (const a of els.current.values()) a.pause();
    },
    []
  );

  return null;
}
