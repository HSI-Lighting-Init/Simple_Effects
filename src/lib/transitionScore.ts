// Phase (roadmap docs/TEMPLATE_EXTRACTOR_ROADMAP.md, transition-family matching):
// given a transition boundary measured in a real reference video, figure out
// which of the app's ~25 transition engines (src/lib/transitions/*.ts) it most
// resembles. The actual rendering needs a browser Canvas and happens live in
// the app (candidates rendered at a few progress points, same points sampled
// from the real video); this module is the pure, DOM-free half — scoring
// already-rendered pixel buffers and ranking candidates by how well they
// match. No `document`/`ImageData`/Canvas here, so it runs under plain
// Node/vitest same as the rest of src/lib.

/** RGBA (or RGB) pixel buffer for one frame, as you'd get from
 *  CanvasRenderingContext2D.getImageData(...).data or similar. */
export interface FrameBuffer {
  width: number;
  height: number;
  /** Length >= width*height*channels. */
  data: Uint8ClampedArray | Uint8Array;
  /** 3 (RGB) or 4 (RGBA, alpha ignored). Default 4. */
  channels?: number;
}

// Downsample every frame to this fixed luminance grid before scoring. Small
// and size-independent on purpose: this is for coarse "which transition
// family" ranking, not pixel-perfect diffing, so a real video frame and a
// freshly-rendered candidate at slightly different resolutions still compare
// cleanly.
const GRID = 32;

// Standard SSIM stability constants (Wang et al.) for an 8-bit luminance
// range (L = 255).
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

/** Box-downsample a frame to a GRID x GRID luminance grid (Rec. 601 luma). */
function toLuminanceGrid(fb: FrameBuffer): Float64Array {
  const { width, height, data } = fb;
  const channels = fb.channels ?? 4;
  const grid = new Float64Array(GRID * GRID);
  for (let gy = 0; gy < GRID; gy++) {
    const y0 = Math.floor((gy * height) / GRID);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / GRID));
    for (let gx = 0; gx < GRID; gx++) {
      const x0 = Math.floor((gx * width) / GRID);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / GRID));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          const idx = (y * width + x) * channels;
          sum += 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          count++;
        }
      }
      grid[gy * GRID + gx] = count > 0 ? sum / count : 0;
    }
  }
  return grid;
}

/** Structural-similarity-flavoured score between two same-size frames, 0..1,
 *  1 = identical. Downsamples internally to a small fixed grid (luminance
 *  only), then computes SSIM using a SINGLE GLOBAL WINDOW over that whole
 *  grid (one mean/variance/covariance over all 32*32 samples), rather than
 *  sliding local windows: the grid is already tiny and coarse by design (see
 *  GRID above), so per-window subdivision buys little extra fidelity here and
 *  a global window keeps this a few lines instead of a windowing loop. It's
 *  still real SSIM (luminance + contrast + structure via mean/variance/
 *  covariance), not MSE dressed up — just evaluated over one region. */
export function frameSimilarity(a: FrameBuffer, b: FrameBuffer): number {
  const ga = toLuminanceGrid(a);
  const gb = toLuminanceGrid(b);
  const n = ga.length;

  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += ga[i];
    sumB += gb[i];
  }
  const muA = sumA / n;
  const muB = sumB / n;

  let varA = 0;
  let varB = 0;
  let cov = 0;
  for (let i = 0; i < n; i++) {
    const da = ga[i] - muA;
    const db = gb[i] - muB;
    varA += da * da;
    varB += db * db;
    cov += da * db;
  }
  varA /= n;
  varB /= n;
  cov /= n;

  const numerator = (2 * muA * muB + C1) * (2 * cov + C2);
  const denominator = (muA * muA + muB * muB + C1) * (varA + varB + C2);
  const ssim = denominator === 0 ? 1 : numerator / denominator;
  // SSIM can go slightly negative for strongly anti-correlated content; this
  // scorer only needs "how close" (0..1), not the signed structural sign.
  return Math.max(0, Math.min(1, ssim));
}

export interface TransitionCandidate {
  /** REGISTRY id, e.g. "crossDissolve", "wipeLeft" — opaque to this module. */
  id: string;
  /** Rendered frames for this candidate at specific progress points, same
   *  progress values used for every candidate and for the observed frames. */
  frames: { progress: number; frame: FrameBuffer }[];
}

export interface TransitionRankResult {
  id: string;
  /** Mean frameSimilarity across all matched (by progress) observed/candidate
   *  frame pairs, 0..1, higher is better. */
  score: number;
}

/** The candidate frame whose progress is closest to `progress`. */
function nearestByProgress<T extends { progress: number }>(frames: T[], progress: number): T {
  let best = frames[0];
  let bestDist = Math.abs(best.progress - progress);
  for (let i = 1; i < frames.length; i++) {
    const dist = Math.abs(frames[i].progress - progress);
    if (dist < bestDist) {
      best = frames[i];
      bestDist = dist;
    }
  }
  return best;
}

/** Rank every candidate by how closely its rendered frames match the
 *  observed real frames at the same progress points (matched by nearest
 *  progress, not exact float equality). Returns candidates sorted
 *  best-first. */
export function rankTransitions(
  observed: { progress: number; frame: FrameBuffer }[],
  candidates: TransitionCandidate[]
): TransitionRankResult[] {
  const results = candidates.map((candidate) => {
    if (observed.length === 0 || candidate.frames.length === 0) {
      return { id: candidate.id, score: 0 };
    }
    let total = 0;
    for (const obs of observed) {
      const match = nearestByProgress(candidate.frames, obs.progress);
      total += frameSimilarity(obs.frame, match.frame);
    }
    return { id: candidate.id, score: total / observed.length };
  });
  results.sort((a, b) => b.score - a.score);
  return results;
}
