// Media (video / audio) helpers: file-type detection, a blob-URL cache, metadata
// probing, and a registry of live <video> elements so the deterministic export
// can seek every video to the exact frame before it captures the canvas.
//
// We load files as blob object URLs (fetched through Tauri's asset protocol)
// rather than the asset URL directly: blob URLs are same-origin, so drawing a
// video frame onto a canvas never taints it — which keeps the WebCodecs export
// working.
import { convertFileSrc } from "@tauri-apps/api/core";

export type MediaKind = "image" | "video" | "audio";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
const VIDEO_EXTS = ["mp4", "webm", "mov", "mkv", "avi", "m4v", "ogv"];
const AUDIO_EXTS = ["mp3", "wav", "ogg", "m4a", "aac", "flac"];

/** Every extension the importer accepts, for the file dialog filter. */
export const IMPORT_EXTENSIONS = [...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS];

/** Classify a path by extension (null = unsupported). */
export function mediaKind(path: string): MediaKind | null {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (VIDEO_EXTS.includes(ext)) return "video";
  if (AUDIO_EXTS.includes(ext)) return "audio";
  return null;
}

// path → blob object URL (canvas-safe). Fetched once, then cached.
const urlCache = new Map<string, string>();
const urlPending = new Map<string, Promise<string>>();

/** Resolve a file path to a same-origin blob object URL (cached). */
export function getMediaUrl(path: string): Promise<string> {
  const hit = urlCache.get(path);
  if (hit) return Promise.resolve(hit);
  const pending = urlPending.get(path);
  if (pending) return pending;
  const p = (async () => {
    const res = await fetch(convertFileSrc(path));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    urlCache.set(path, url);
    urlPending.delete(path);
    return url;
  })();
  urlPending.set(path, p);
  return p;
}

/** Read a video's natural size + duration (via a throwaway element). */
export async function getVideoMeta(
  path: string
): Promise<{ width: number; height: number; durationMs: number }> {
  const url = await getMediaUrl(path);
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () =>
      resolve({
        width: v.videoWidth || 1,
        height: v.videoHeight || 1,
        durationMs: Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : 0,
      });
    v.onerror = () => reject(new Error("video metadata failed"));
    v.src = url;
  });
}

/** Read an audio clip's duration (via a throwaway element). */
export async function getAudioMeta(path: string): Promise<{ durationMs: number }> {
  const url = await getMediaUrl(path);
  return new Promise((resolve, reject) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.onloadedmetadata = () =>
      resolve({ durationMs: Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : 0 });
    a.onerror = () => reject(new Error("audio metadata failed"));
    a.src = url;
  });
}

/** Generate a poster thumbnail (data URL) from a video's first frame. */
export async function getVideoPoster(path: string): Promise<string> {
  const url = await getMediaUrl(path);
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.crossOrigin = "anonymous";
    const grab = () => {
      try {
        const cv = document.createElement("canvas");
        const scale = 160 / Math.max(1, v.videoWidth);
        cv.width = Math.max(1, Math.round(v.videoWidth * scale));
        cv.height = Math.max(1, Math.round(v.videoHeight * scale));
        cv.getContext("2d")!.drawImage(v, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL("image/jpeg", 0.7));
      } catch (e) {
        reject(e);
      }
    };
    v.onseeked = grab;
    v.onloadeddata = () => {
      // Seek slightly in so we don't grab a black leading frame.
      try {
        v.currentTime = Math.min(0.1, (v.duration || 1) / 2);
      } catch {
        grab();
      }
    };
    v.onerror = () => reject(new Error("poster failed"));
    v.src = url;
  });
}

// --- Warm <video> pool, keyed by layer ---
// A VideoNode mounts only when its layer's range starts. Building the element then
// (fetch blob → load → first frame → seek to the clip's in-point) left the layer
// drawing NOTHING for the first frames of every video clip: a flash of background
// at each cut in the live preview, worst between split clips that hard-cut straight
// into the next element. Export never showed it because it waits for each frame.
// Preview now warms elements ahead of time and parks them paused on their first
// frame, already seeked to the in-point; VideoNode just picks them up.
export interface PooledVideo {
  src: string;
  el: HTMLVideoElement;
  ready: boolean;
  whenReady: Promise<HTMLVideoElement>;
}
const videoPool = new Map<number, PooledVideo>();

/** Source time (s) a video layer shows at its first frame. */
export function videoStartSec(
  inMs: number,
  speed: number,
  reverse: boolean,
  startMs: number,
  endMs: number
): number {
  const spd = speed > 0 ? speed : 1;
  return inMs / 1000 + (reverse ? Math.max(0, endMs - startMs) / 1000 * spd : 0);
}

/** The layer's pooled element (created + loading if new). Idempotent per (layer, src). */
export function loadVideo(layerId: number, src: string, startSec = 0): PooledVideo {
  const hit = videoPool.get(layerId);
  if (hit && hit.src === src) return hit;
  dropVideo(layerId);
  const el = document.createElement("video");
  el.playsInline = true;
  el.preload = "auto";
  // Always silent: sound comes from the layer's separate audio layer, so deleting
  // or hiding that layer removes it and preview matches export.
  el.muted = true;
  const entry: PooledVideo = { src, el, ready: false, whenReady: null as never };
  entry.whenReady = getMediaUrl(src).then(
    (url) =>
      new Promise<HTMLVideoElement>((resolve) => {
        const done = () => {
          entry.ready = true;
          resolve(el);
        };
        el.onloadeddata = () => {
          const t = Math.min(startSec, Math.max(0, (el.duration || 0) - 0.05));
          if (t > 0.02) {
            el.addEventListener("seeked", done, { once: true });
            el.currentTime = t;
            setTimeout(done, 1500); // never leave the layer blank if the seek event is lost
          } else done();
        };
        el.src = url;
      })
  );
  videoPool.set(layerId, entry);
  return entry;
}

/** Tear down a layer's pooled element (layer far from the playhead / replaced). */
export function dropVideo(layerId: number) {
  const e = videoPool.get(layerId);
  if (!e) return;
  videoPool.delete(layerId);
  e.el.pause();
  e.el.removeAttribute("src");
  e.el.load();
}

// --- Live <video> element registry (used by the export to seek per frame) ---
const videoEls = new Map<number, HTMLVideoElement>();

/** VideoNode registers its element so the export can seek it (null = remove). */
export function registerVideoEl(layerId: number, el: HTMLVideoElement | null) {
  if (el) videoEls.set(layerId, el);
  else videoEls.delete(layerId);
}

/** Seek every listed video to its target source-time and await the seek to land
 *  (so the export captures the correct frame). */
export async function seekVideosForFrame(
  targets: { layerId: number; timeSec: number }[]
): Promise<void> {
  await Promise.all(
    targets.map(({ layerId, timeSec }) => {
      const v = videoEls.get(layerId);
      if (!v || v.readyState < 1) return Promise.resolve();
      if (Math.abs(v.currentTime - timeSec) < 0.001) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          v.removeEventListener("seeked", done);
          resolve();
        };
        v.addEventListener("seeked", done);
        try {
          v.currentTime = timeSec;
        } catch {
          done();
        }
        setTimeout(done, 250); // safety: never hang the export
      });
    })
  );
}
