// Transition-family matching: given a real cut in a reference video, figure
// out which of the app's REGISTRY engines it most resembles. This is the
// DOM/Canvas half (see src/lib/transitionScore.ts for the pure scoring math
// this drives) — renders every candidate engine at a few progress points
// using two real frames pulled from the reference as clip A/B, extracts real
// observed frames from the reference at those same progress points, and
// ranks candidates by src/lib/transitionScore.ts's frameSimilarity.
import { REGISTRY, createTransition } from "./transitions";
import { extractVideoFrames } from "./api";
import { rankTransitions, type FrameBuffer, type TransitionRankResult } from "./transitionScore";

const OUT_SIZE = 96; // coarse on purpose — transitionScore downsamples to 32x32 anyway

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.src = dataUrl;
    img.decode().then(() => resolve(img)).catch(() => {
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("failed to load frame image"));
    });
  });
}

function canvasFrame(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = OUT_SIZE;
  canvas.height = OUT_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not get a 2D context");
  return { canvas, ctx };
}

function toFrameBuffer(ctx: CanvasRenderingContext2D): FrameBuffer {
  const { data } = ctx.getImageData(0, 0, OUT_SIZE, OUT_SIZE);
  return { width: OUT_SIZE, height: OUT_SIZE, data, channels: 4 };
}

export interface MatchTransitionOptions {
  /** Absolute video time (ms) of a clean, pre-transition frame — clip A. */
  beforeMs: number;
  /** Absolute video time (ms) of a clean, post-transition frame — clip B. */
  afterMs: number;
  /** The transition window itself, [windowStartMs, windowEndMs]. */
  windowStartMs: number;
  windowEndMs: number;
  /** How many points across the window to compare (progress 0..1 evenly
   *  spaced across the window). Default 4. */
  sampleCount?: number;
  /** How many top candidates to return. Default 3. */
  topN?: number;
}

/** Rank every REGISTRY transition engine by how closely it reproduces the
 *  real observed frames across a real transition window. Needs a live
 *  browser (Canvas) — this is why it's a separate module from the pure
 *  transitionScore.ts, and why it's only reachable as an agent tool, not
 *  called from Rust. */
export async function matchTransition(videoPath: string, opts: MatchTransitionOptions): Promise<TransitionRankResult[]> {
  const sampleCount = Math.max(2, opts.sampleCount ?? 4);
  const topN = opts.topN ?? 3;
  const progresses = Array.from({ length: sampleCount }, (_, i) => i / (sampleCount - 1));
  const observedTimes = progresses.map((p) => Math.round(opts.windowStartMs + p * (opts.windowEndMs - opts.windowStartMs)));

  const allTimes = [opts.beforeMs, opts.afterMs, ...observedTimes];
  const frames = await extractVideoFrames(videoPath, allTimes, OUT_SIZE * 2);
  const byTime = new Map(frames.map(([t, url]) => [t, url]));

  const beforeUrl = byTime.get(opts.beforeMs);
  const afterUrl = byTime.get(opts.afterMs);
  if (!beforeUrl || !afterUrl) throw new Error("could not extract the before/after reference frames");
  const [beforeImg, afterImg] = await Promise.all([loadImage(beforeUrl), loadImage(afterUrl)]);
  const clipA = { source: beforeImg, width: beforeImg.naturalWidth, height: beforeImg.naturalHeight };
  const clipB = { source: afterImg, width: afterImg.naturalWidth, height: afterImg.naturalHeight };

  // Real observed frames -> FrameBuffers, matched to their progress point.
  const observed: { progress: number; frame: FrameBuffer }[] = [];
  for (let i = 0; i < observedTimes.length; i++) {
    const url = byTime.get(observedTimes[i]);
    if (!url) continue;
    const img = await loadImage(url);
    const { canvas, ctx } = canvasFrame();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    observed.push({ progress: progresses[i], frame: toFrameBuffer(ctx) });
  }
  if (observed.length === 0) throw new Error("no observed frames could be extracted in the transition window");

  const candidates = REGISTRY.map((meta) => {
    try {
      const tr = createTransition(meta.id, clipA, clipB, { outWidth: OUT_SIZE, outHeight: OUT_SIZE });
      const { canvas, ctx } = canvasFrame();
      const framesForId = progresses.map((p) => {
        tr.render(canvas, p);
        return { progress: p, frame: toFrameBuffer(ctx) };
      });
      return { id: meta.id, frames: framesForId };
    } catch {
      return { id: meta.id, frames: [] }; // a transition that can't build on these clips just scores 0
    }
  });

  return rankTransitions(observed, candidates).slice(0, topN);
}
