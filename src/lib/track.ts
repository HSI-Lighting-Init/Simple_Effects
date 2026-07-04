// A frontend copy of the backend's single-track sampler (src-tauri/src/eval.rs
// `sample_track` + `ease`). The backend is the source of truth for what the
// renderer shows; this mirror exists ONLY so the decompose editor can place a
// glyph at its keyframed pose for the current playhead time (so you can drag it
// to key a new pose at that time). Keep the two in sync.
import type { Track } from "../bindings/Track";
import type { Easing } from "../bindings/Easing";
import type { ColorKey } from "../bindings/ColorKey";
import type { Rgba } from "../bindings/Rgba";

function ease(easing: Easing, u: number): number {
  const x = Math.max(0, Math.min(1, u));
  switch (easing) {
    case "linear":
      return x;
    case "easeIn":
      return x * x;
    case "easeOut":
      return 1 - (1 - x) * (1 - x);
    case "easeInOut":
      return x * x * (3 - 2 * x);
    case "hold":
      return 0; // handled before this is called
  }
}

/** Sample a keyframe track at comp time `tMs` (clamps outside the key range). */
export function sampleTrack(track: Track, tMs: number): number {
  const keys = track.keys;
  if (keys.length === 0) return track.default;
  if (tMs <= keys[0].timeMs) return keys[0].value;
  const last = keys[keys.length - 1];
  if (tMs >= last.timeMs) return last.value;

  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].timeMs <= tMs) i += 1;
  const k0 = keys[i];
  const k1 = keys[i + 1];
  if (k0.easing === "hold") return k0.value;
  const span = Math.max(1, k1.timeMs - k0.timeMs);
  const u = (tMs - k0.timeMs) / span;
  return k0.value + (k1.value - k0.value) * ease(k0.easing, u);
}

/** A keyframeless track that always reads `v` (mirrors `Track::constant`). */
export function constTrack(v: number): Track {
  return { keys: [], default: v };
}

/** Whether a track carries any keyframes (i.e. the "stopwatch" is on). */
export function isKeyed(track: Track): boolean {
  return track.keys.length > 0;
}

/** Insert or replace the keyframe at `tMs` (linear), keeping keys time-sorted.
 * Editing a keyed track upserts at the playhead; the `default` tracks the first
 * key so an empty track that gets its first key still reads sensibly. */
export function upsertKey(track: Track, tMs: number, value: number): Track {
  const keys = track.keys.filter((k) => k.timeMs !== tMs);
  keys.push({ timeMs: tMs, value, easing: "linear" });
  keys.sort((a, b) => a.timeMs - b.timeMs);
  return { keys, default: track.keys.length ? track.default : value };
}

function mix(a: number, b: number, t: number): number {
  return Math.round(Math.max(0, Math.min(255, a + (b - a) * t)));
}

/** Sample a colour keyframe list at comp time `tMs` (mirrors backend
 * `sample_color`). Empty list → `fallback`. */
export function sampleColor(keys: ColorKey[], fallback: Rgba, tMs: number): Rgba {
  if (keys.length === 0) return fallback;
  if (tMs <= keys[0].timeMs) return keys[0].color;
  const last = keys[keys.length - 1];
  if (tMs >= last.timeMs) return last.color;

  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].timeMs <= tMs) i += 1;
  const k0 = keys[i];
  const k1 = keys[i + 1];
  if (k0.easing === "hold") return k0.color;
  const span = Math.max(1, k1.timeMs - k0.timeMs);
  const e = ease(k0.easing, (tMs - k0.timeMs) / span);
  const a = k0.color;
  const b = k1.color;
  return { r: mix(a.r, b.r, e), g: mix(a.g, b.g, e), b: mix(a.b, b.b, e), a: mix(a.a, b.a, e) };
}
