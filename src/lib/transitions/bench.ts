// Performance benchmark harness for all transitions.
//
// Times `render()` across the progress range at a chosen resolution and reports
// mean ms/frame and an estimated sustainable FPS. Runs in the browser/renderer
// (needs a real canvas). `benchmarkAll` sweeps every registered transition;
// `RESOLUTIONS` covers the 1080p and 4K targets from the Stage-4 spec.
//
// Usage (from the app / a dev console):
//   import { benchmarkAll, RESOLUTIONS } from "./lib/transitions/bench";
//   const rows = await benchmarkAll(RESOLUTIONS.fhd);
//   console.table(rows);

import type { Clip } from "./types";
import { createTransition, REGISTRY } from "./registry";
import { placeholderClip } from "./thumbnails";

export interface Resolution {
  label: string;
  width: number;
  height: number;
}
export const RESOLUTIONS = {
  hd: { label: "720p", width: 1280, height: 720 } as Resolution,
  fhd: { label: "1080p", width: 1920, height: 1080 } as Resolution,
  uhd: { label: "4K", width: 3840, height: 2160 } as Resolution,
};

export interface BenchRow {
  id: string;
  category: string;
  resolution: string;
  frames: number;
  meanMs: number;
  p95Ms: number;
  fps: number;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Benchmark a single transition at a resolution. */
export function benchmark(id: string, res: Resolution, frames = 60, params: Record<string, unknown> = {}): BenchRow {
  const from: Clip = placeholderClip("A", "#2b6cb0", res.width, res.height);
  const to: Clip = placeholderClip("B", "#c05621", res.width, res.height);
  const tr = createTransition(id, from, to, { outWidth: res.width, outHeight: res.height, ...params });
  const target = document.createElement("canvas");
  const meta = REGISTRY.find((m) => m.id === id);

  // Warm up (first frame allocates scratch canvases).
  tr.render(target, 0);

  const samples: number[] = [];
  for (let i = 0; i < frames; i++) {
    const p = i / (frames - 1);
    const t0 = now();
    tr.render(target, p);
    samples.push(now() - t0);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  return {
    id,
    category: meta?.category ?? "?",
    resolution: res.label,
    frames,
    meanMs: +mean.toFixed(3),
    p95Ms: +p95.toFixed(3),
    fps: mean > 0 ? Math.round(1000 / mean) : 0,
  };
}

/** Benchmark every registered transition at a resolution. */
export function benchmarkAll(res: Resolution = RESOLUTIONS.fhd, frames = 30): BenchRow[] {
  return REGISTRY.map((m) => benchmark(m.id, res, frames));
}
