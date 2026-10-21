// Media (video / audio) helpers: file-type detection, a blob-URL cache, metadata
// probing, and a registry of live <video> elements so the deterministic export
// can seek every video to the exact frame before it captures the canvas.
//
// We load files as blob object URLs (fetched through Tauri's asset protocol)
// rather than the asset URL directly: blob URLs are same-origin, so drawing a
// video frame onto a canvas never taints it — which keeps the WebCodecs export
// working.
import { convertFileSrc } from "@tauri-apps/api/core";
import { record } from "./recorder";

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

// Export-only short-GOP stand-ins (original path → proxy path; see makeSeekProxy).
// loadVideo resolves through this, so swapping it rebuilds every pooled element.
let seekProxies = new Map<string, string>();

/** Install (or with null, remove) the export's seek proxies. */
export function setSeekProxies(next: Map<string, string> | null) {
  // Release the old proxies' blobs: they're only needed while exporting.
  for (const proxy of seekProxies.values()) {
    const url = urlCache.get(proxy);
    if (url) URL.revokeObjectURL(url);
    urlCache.delete(proxy);
  }
  seekProxies = next ?? new Map();
  slowSeeksLogged = 0;
}

/** The file a video layer's element actually loads (its proxy while exporting). */
export function videoSrc(src: string): string {
  return seekProxies.get(src) ?? src;
}

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
  src = videoSrc(src);
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

// --- Per-frame seeking for the deterministic export ---
/** Only a hung decoder hits this. The old 250 ms cap was hit by merely SLOW ones:
 *  the frame was captured before the seek landed, so on slower PCs video froze in
 *  the render wherever seeks were expensive (late in long-GOP clips). */
const SEEK_TIMEOUT_MS = 10_000;
const SLOW_SEEK_MS = 250;
let slowSeeksLogged = 0;

export interface VideoSeekTarget {
  layerId: number;
  src: string;
  /** The layer's first-frame source time (for loadVideo's initial park). */
  startSec: number;
  timeSec: number;
}

/** Bring each on-screen video's pooled element to its target source-time and wait
 *  for that frame to decode, however long it takes — a slow PC makes the export
 *  slower, never wrong. Loads the element first if it isn't warm yet. */
export async function seekVideosForFrame(targets: VideoSeekTarget[]): Promise<void> {
  await Promise.all(
    targets.map(async ({ layerId, src, startSec, timeSec }) => {
      const t0 = performance.now();
      let timedOut = false;
      const timeout = async <T>(p: Promise<T>) => {
        let timer = 0;
        await Promise.race([
          p,
          new Promise<void>((r) => {
            timer = window.setTimeout(() => {
              timedOut = true;
              r();
            }, SEEK_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timer);
      };
      const entry = loadVideo(layerId, src, startSec);
      await timeout(entry.whenReady);
      const v = entry.el;
      // Same end clamp as VideoNode, so its sync effect doesn't re-seek after us.
      const t = Number.isFinite(v.duration) ? Math.min(timeSec, Math.max(0, v.duration - 0.05)) : timeSec;
      if (entry.ready && Math.abs(v.currentTime - t) >= 0.001) {
        let onSeeked = () => {};
        await timeout(
          new Promise<void>((resolve) => {
            onSeeked = resolve;
            v.addEventListener("seeked", onSeeked, { once: true });
            try {
              v.currentTime = t;
            } catch {
              resolve();
            }
          })
        );
        v.removeEventListener("seeked", onSeeked);
      }
      const ms = performance.now() - t0;
      if ((ms > SLOW_SEEK_MS || timedOut) && slowSeeksLogged++ < 300)
        record("slow_seek", { layerId, timeSec: +t.toFixed(3), ms: Math.round(ms), timedOut, proxy: entry.src !== src });
    })
  );
}
