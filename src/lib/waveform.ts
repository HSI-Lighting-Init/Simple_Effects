// Decode a media file's audio to a compact peak array and render it to a PNG
// data URL for the timeline (à la Premiere's waveform strip). Works for audio
// files and for videos that carry an audio track — decodeAudioData reads the
// audio stream out of the container. Everything is cached by source path so we
// decode each file at most once per session.
import { getMediaUrl } from "./media";

/** ~1000 magnitude buckets (0..1) is plenty to draw a smooth waveform at any zoom. */
const BUCKETS = 1000;

export interface Peaks {
  /** Per-bucket peak magnitude, 0..1. */
  mags: number[];
  durationMs: number;
}

const peakCache = new Map<string, Promise<Peaks | null>>();
const pngCache = new Map<string, string>();

// A single shared AudioContext (creating many trips the per-context limit).
let ctx: AudioContext | null = null;
function audioCtx(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Decode `src`'s audio into peak buckets, or null if it has no decodable audio
 *  (a video without an audio track, an unsupported codec, or a read error). */
export function loadAudioPeaks(src: string): Promise<Peaks | null> {
  const hit = peakCache.get(src);
  if (hit) return hit;
  const job = (async (): Promise<Peaks | null> => {
    const ac = audioCtx();
    if (!ac) return null;
    try {
      const url = await getMediaUrl(src);
      const buf = await (await fetch(url)).arrayBuffer();
      const audio = await ac.decodeAudioData(buf);
      if (!audio || audio.length === 0 || audio.numberOfChannels === 0) return null;
      const chan = audio.getChannelData(0);
      const step = Math.max(1, Math.floor(chan.length / BUCKETS));
      const mags: number[] = [];
      let globalMax = 1e-6;
      for (let b = 0; b < BUCKETS; b++) {
        let peak = 0;
        const start = b * step;
        const end = Math.min(chan.length, start + step);
        for (let i = start; i < end; i++) {
          const a = Math.abs(chan[i]);
          if (a > peak) peak = a;
        }
        mags.push(peak);
        if (peak > globalMax) globalMax = peak;
      }
      // Normalise so quiet clips still show a readable waveform.
      for (let i = 0; i < mags.length; i++) mags[i] = mags[i] / globalMax;
      return { mags, durationMs: Math.round(audio.duration * 1000) };
    } catch {
      return null;
    }
  })();
  peakCache.set(src, job);
  return job;
}

/** Render peaks to a smooth, filled mirrored-envelope waveform PNG (à la
 *  Premiere) for use as a block background. A solid silhouette scales cleanly
 *  when the block stretches, so it stays crisp at any zoom. Cached by source
 *  path. Returns null if the file has no audio. */
export async function waveformPng(src: string): Promise<string | null> {
  const cached = pngCache.get(src);
  if (cached) return cached;
  const peaks = await loadAudioPeaks(src);
  if (!peaks) return null;

  const w = BUCKETS;
  const h = 220;
  const mid = h / 2;
  const pad = 6; // keep the loudest peaks a hair off the top/bottom edges
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d");
  if (!g) return null;

  // A darker translucent lane seats the waveform so it reads clearly against the
  // block's colour (rounded so it looks like a proper audio track).
  const r = 14;
  g.fillStyle = "rgba(8, 20, 34, 0.34)";
  g.beginPath();
  g.moveTo(r, 0);
  g.arcTo(w, 0, w, h, r);
  g.arcTo(w, h, 0, h, r);
  g.arcTo(0, h, 0, 0, r);
  g.arcTo(0, 0, w, 0, r);
  g.closePath();
  g.fill();

  // amp() lifts quiet detail with a gentle gamma so the shape stays lively
  // instead of a flat slab, and guarantees a visible baseline.
  const amp = (m: number) => Math.max(1.5, Math.pow(Math.min(1, m), 0.72) * (mid - pad));

  // One filled silhouette: top envelope left→right, bottom envelope right→left.
  g.beginPath();
  g.moveTo(0, mid - amp(peaks.mags[0]));
  for (let x = 1; x < peaks.mags.length; x++) g.lineTo(x, mid - amp(peaks.mags[x]));
  for (let x = peaks.mags.length - 1; x >= 0; x--) g.lineTo(x, mid + amp(peaks.mags[x]));
  g.closePath();

  // Vertical gradient: bright core fading toward the edges, for a little depth.
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0.0, "rgba(214, 240, 255, 0.55)");
  grad.addColorStop(0.5, "rgba(255, 255, 255, 0.95)");
  grad.addColorStop(1.0, "rgba(214, 240, 255, 0.55)");
  g.fillStyle = grad;
  g.fill();

  // Crisp centre line ties the two halves together.
  g.strokeStyle = "rgba(255, 255, 255, 0.5)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, mid);
  g.lineTo(w, mid);
  g.stroke();

  const url = cv.toDataURL("image/png");
  pngCache.set(src, url);
  return url;
}

/** Whether `src` has a decodable audio track (used at import time to decide
 *  whether to split off an audio layer). */
export async function hasAudio(src: string): Promise<boolean> {
  return (await loadAudioPeaks(src)) != null;
}
