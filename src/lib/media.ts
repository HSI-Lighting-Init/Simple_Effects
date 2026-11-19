// Media (video / audio) helpers: file-type detection, a blob-URL cache, metadata
// probing, and a registry of live <video> elements so the deterministic export
// can seek every video to the exact frame before it captures the canvas.
//
// Playback and export still load files as blob object URLs: blob URLs are
// same-origin, so drawing a video frame onto a canvas never taints it — which
// keeps the WebCodecs export working. Probes (size / length / poster) read the
// file URL directly instead: that only fetches the byte ranges they need, so a
// large file never gets copied into memory just to show its bin thumbnail.
import { convertFileSrc } from "@tauri-apps/api/core";
import { mediaVideoOffset } from "./api";
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    urlCache.set(path, url);
    urlPending.delete(path);
    return url;
  })().catch((e) => {
    // Name the file (a bare "TypeError: Failed to fetch" reached the export
    // dialog), and don't cache the failure, so the next caller retries.
    urlPending.delete(path);
    throw new Error(`Couldn't load ${path}: ${e}`);
  });
  urlPending.set(path, p);
  return p;
}

/** Read a video's natural size + duration (via a throwaway element). */
export async function getVideoMeta(
  path: string
): Promise<{ width: number; height: number; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    // Release the decoder / partial load as soon as the answer is in.
    const release = () => {
      v.removeAttribute("src");
      v.load();
    };
    v.onloadedmetadata = () => {
      const meta = {
        width: v.videoWidth || 1,
        height: v.videoHeight || 1,
        durationMs: Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : 0,
      };
      release();
      resolve(meta);
    };
    v.onerror = () => {
      release();
      reject(new Error("video metadata failed"));
    };
    v.src = convertFileSrc(path);
  });
}

/** Read an audio clip's duration (via a throwaway element). */
export async function getAudioMeta(path: string): Promise<{ durationMs: number }> {
  return new Promise((resolve, reject) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    const release = () => {
      a.removeAttribute("src");
      a.load();
    };
    a.onloadedmetadata = () => {
      const meta = { durationMs: Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : 0 };
      release();
      resolve(meta);
    };
    a.onerror = () => {
      release();
      reject(new Error("audio metadata failed"));
    };
    a.src = convertFileSrc(path);
  });
}

class PosterTimeout extends Error {
  constructor() {
    super("poster timed out");
  }
}

/** Poster from one URL: first frame, 160 px wide, JPEG 0.7. */
function posterFrom(url: string, crossOrigin: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    if (crossOrigin) v.crossOrigin = "anonymous";
    let settled = false;
    let timer = 0;
    const release = () => {
      v.removeAttribute("src");
      v.load();
    };
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      release();
      done();
    };
    // A load that never settles must not hold up the rest of the bin. Generous: a
    // read can queue behind another file being copied for playback.
    timer = window.setTimeout(() => finish(() => reject(new PosterTimeout())), 30_000);
    const grab = () => {
      try {
        const cv = document.createElement("canvas");
        const scale = 160 / Math.max(1, v.videoWidth);
        cv.width = Math.max(1, Math.round(v.videoWidth * scale));
        cv.height = Math.max(1, Math.round(v.videoHeight * scale));
        cv.getContext("2d")!.drawImage(v, 0, 0, cv.width, cv.height);
        const png = cv.toDataURL("image/jpeg", 0.7);
        finish(() => resolve(png));
      } catch (e) {
        finish(() => reject(e));
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
    v.onerror = () => finish(() => reject(new Error("poster failed")));
    v.src = url;
  });
}

/** Generate a poster thumbnail (data URL) from a video's first frame. Reads the
 *  file directly first; if that load fails or drawing it is refused (a
 *  release-build origin may differ), fall back to the canvas-safe blob URL. A
 *  slow load doesn't fall back: copying the whole file would only queue more. */
export async function getVideoPoster(path: string): Promise<string> {
  try {
    return await posterFrom(convertFileSrc(path), true);
  } catch (e) {
    if (e instanceof PosterTimeout) throw e;
    return posterFrom(await getMediaUrl(path), false);
  }
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
  /** When the file's first video frame is stamped (s). Of the file this element
   *  actually loads (a proxy has its own); set before `ready`. */
  offsetSec: number;
}
const videoPool = new Map<number, PooledVideo>();

// path → video start offset, read once per file from its MP4 boxes. Unknown
// (other containers, unreadable) is 0: the browser's own mapping, as before.
const videoOffsets = new Map<string, Promise<number>>();
function videoOffset(path: string): Promise<number> {
  let p = videoOffsets.get(path);
  if (!p) {
    p = mediaVideoOffset(path)
      .then((s) => (typeof s === "number" && Number.isFinite(s) && s > 0 ? s : 0))
      .catch(() => 0);
    videoOffsets.set(path, p);
  }
  return p;
}

/** Land inside the wanted frame, not on its boundary. A browser shows the frame
 *  with pts <= currentTime and quantizes currentTime, so a seek to exactly a
 *  frame's timestamp can read one frame early (measured: a seek to 2.033333 s
 *  settled at 2.033332 s and showed the frame stamped 2.000 s). 1 ms is above that
 *  rounding and below a frame at any rate up to 240 fps. */
export const SEEK_BIAS_SEC = 0.001;

/** THE place clip time becomes media time. An editor puts a clip's first video
 *  frame at clip time 0; a browser's timeline starts at the file's time zero, so
 *  when the first video frame is stamped later (B-frame delay, edit list) clip
 *  time t lives at media time t + `offsetSec`. Reading it at t shows the previous
 *  frame.
 *  `durationSec` is the element's length (undefined = unknown, no end clamp). */
export function toMediaTime(
  clipSec: number,
  offsetSec: number,
  durationSec?: number
): { wanted: number; target: number; atEnd: boolean } {
  const wanted = Math.max(0, clipSec) + offsetSec + SEEK_BIAS_SEC;
  if (durationSec === undefined || !Number.isFinite(durationSec)) return { wanted, target: wanted, atEnd: false };
  const last = durationSec - 0.05;
  return { wanted, target: Math.min(wanted, Math.max(0, last)), atEnd: wanted >= last };
}

// Export-only short-GOP stand-ins (original path → proxy path; see makeSeekProxy).
// loadVideo resolves through this, so swapping it rebuilds every pooled element.
let seekProxies = new Map<string, string>();

/** Install (or with null, remove) the export's seek proxies. */
export function setSeekProxies(next: Map<string, string> | null) {
  const oldProxies = new Set(seekProxies.values());
  // Release the old proxies' blobs: they're only needed while exporting.
  for (const proxy of oldProxies) {
    const url = urlCache.get(proxy);
    if (url) URL.revokeObjectURL(url);
    urlCache.delete(proxy);
  }
  seekProxies = next ?? new Map();
  slowSeeksLogged = 0;
  // A pooled element may still point at an old proxy path whose blob URL was
  // just revoked (this is the post-export stale-frame case). Drop it so the
  // next loadVideo builds a fresh element from the current mapping: the
  // original after an export, a new proxy before the next one.
  for (const [layerId, entry] of [...videoPool]) {
    if (oldProxies.has(entry.src)) dropVideo(layerId);
  }
}

/** The file a video layer's element actually loads (its proxy while exporting). */
export function videoSrc(src: string): string {
  return seekProxies.get(src) ?? src;
}

/** CLIP time (s) a video layer shows at its first frame (not media time; see
 *  `toMediaTime`). */
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
  const entry: PooledVideo = { src, el, ready: false, whenReady: null as never, offsetSec: 0 };
  entry.whenReady = Promise.all([getMediaUrl(src), videoOffset(src)]).then(
    ([url, offset]) =>
      new Promise<HTMLVideoElement>((resolve, reject) => {
        entry.offsetSec = offset;
        const done = () => {
          entry.ready = true;
          resolve(el);
        };
        // Without this a file the browser can't decode left whenReady pending forever.
        el.onerror = () => reject(new Error(`Couldn't decode ${src}: ${el.error?.message || "unsupported video"}`));
        el.onloadeddata = () => {
          const t = toMediaTime(startSec, offset, el.duration || 0).target;
          if (t > 0.02) {
            el.addEventListener("seeked", done, { once: true });
            el.currentTime = t;
            setTimeout(done, 1500); // never leave the layer blank if the seek event is lost
          } else done();
        };
        el.src = url;
      })
  );
  entry.whenReady.catch(() => {}); // Preview's warm-up never awaits it; real waiters still see the error
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
  /** The layer's first-frame CLIP time (for loadVideo's initial park). */
  startSec: number;
  /** CLIP time (in-point, speed and reverse applied) — not media time. The file's
   *  start offset is added here, once, by `toMediaTime`. */
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
      // Same mapping and end clamp as VideoNode, so its sync effect doesn't re-seek after us.
      const t = toMediaTime(timeSec, entry.offsetSec, v.duration).target;
      // `currentTime` already reads the target while a seek is still in flight
      // (VideoNode's sync effect assigns it first), so also wait out `seeking`;
      // otherwise the paint captures the previous frame.
      const needSeek = Math.abs(v.currentTime - t) >= 0.001;
      if (entry.ready && (needSeek || v.seeking)) {
        let onSeeked = () => {};
        await timeout(
          new Promise<void>((resolve) => {
            onSeeked = resolve;
            v.addEventListener("seeked", onSeeked, { once: true });
            if (!needSeek) return;
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
