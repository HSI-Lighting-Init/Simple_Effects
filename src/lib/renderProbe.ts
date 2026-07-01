// Render probe — per-frame export diagnostics, for arbitrary (complex) frames.
//
// The export is a REAL-TIME capture of the preview canvas: the render loop calls
// the Rust evaluator per frame and MediaRecorder samples the canvas at the comp
// fps. If a frame can't render within one interval the canvas just doesn't
// change that tick, so the encoded video keeps its container fps but has far
// fewer UNIQUE images per second (the stutter).
//
// Two monitors run on every decoded output frame (and on the live preview):
//   1. WHOLE-FRAME MOTION — each frame is downscaled to a small grid and we take
//      the mean luminance change vs the previous frame. This works for ANY
//      content (not just our calibration lines): motion≈0 ⇒ a duplicate/frozen
//      frame, a spike ⇒ a jump. Unique-frame counting / effective fps come from
//      this, so it stays honest on complex scenes.
//   2. MARKER LINES — optional calibration: a mid-row, local-contrast search for
//      a black line on white / white line on black (so the black letterbox bars
//      don't fool it), plus CMYK band colours. Great when the top layers are the
//      calibration images.
//
// After export we decode the produced video frame by frame (true mediaTime per
// frame) and report expected vs unique vs missing frames, a per-second
// histogram, the motion series, and whether the first frame is stale.

export const EXPECTED = { blackLineX: 270, whiteLineX: 540 } as const;
const GRID_W = 32;
const GRID_H = 18; // 16:9 → 576 cells
const MOTION_CHANGE = 2.0; // mean per-cell luma change (0..255) that counts as "changed"

export interface BandSample {
  x: number;
  r: number;
  g: number;
  b: number;
  name: string;
}

export interface ProbeFrame {
  tMs: number;
  /** Whole-frame mean luminance change vs the previous frame (0..255). */
  motion: number;
  /** Did the picture change vs the previous frame (motion over threshold)? */
  changed: boolean;
  /** Marker lines (comp px) + detection contrast (confidence 0..255). */
  blackLineX: number;
  blackContrast: number;
  whiteLineX: number;
  whiteContrast: number;
  bands: BandSample[];
}

export interface OutputStats {
  targetFps: number;
  durationMs: number;
  expectedFrames: number;
  decodedFrames: number;
  uniqueFrames: number;
  presentedFps: number;
  effectiveFps: number;
  missingFrames: number;
  longestFreezeMs: number;
  staleFirstFrame: boolean;
  /** Unique-content frames per 1-second bucket. */
  perSecond: number[];
}

/** A layer's active effects/transitions, so the dump self-documents what it tests. */
export interface LayerSubject {
  layerId: number;
  name: string;
  transitionIn: { engine: string | null; kind: string; durMs: number; direction: number; params: string | null } | null;
  transitionOut: { engine: string | null; kind: string; durMs: number; direction: number; params: string | null } | null;
  effects: string[];
  /** For text layers: whether a fill/stroke style is set, and how many animators. */
  textStyle?: boolean;
  textAnimators?: number;
}
export interface ProbeSubject {
  /** Distinct transition-engine ids in play (e.g. ["parallaxCamera"]). */
  transitions: string[];
  /** Distinct effect kinds in play (e.g. ["blur","wipe"]). */
  effectKinds: string[];
  /** Per-layer detail. */
  layers: LayerSubject[];
}

export interface ProbeReport {
  startedAt: string;
  comp: { width: number; height: number; fps: number; durationMs: number };
  /** What's being tested: the active transitions/effects by name. */
  subject: ProbeSubject | null;
  expected: { blackLineX: number; whiteLineX: number };
  preview: ProbeFrame[];
  output: ProbeFrame[];
}

let enabled = false;
let report: ProbeReport | null = null;
// Scratch state for the two monitors (reset per run).
let tiny: HTMLCanvasElement | null = null;
let prevPreviewGrid: Float32Array | null = null;
let prevOutputGrid: Float32Array | null = null;

export function isProbeEnabled(): boolean {
  return enabled;
}
export function setProbeEnabled(v: boolean): void {
  enabled = v;
}
export function lastReport(): ProbeReport | null {
  return report;
}

export function beginProbeRun(comp: ProbeReport["comp"], startedAt: string, subject: ProbeSubject | null = null): void {
  report = { startedAt, comp, subject, expected: { ...EXPECTED }, preview: [], output: [] };
  prevPreviewGrid = null;
  prevOutputGrid = null;
  if (!tiny) {
    tiny = document.createElement("canvas");
    tiny.width = GRID_W;
    tiny.height = GRID_H;
  }
}

function classify(r: number, g: number, b: number): string {
  const lo = (v: number) => v < 80;
  const hi = (v: number) => v > 170;
  if (lo(r) && lo(g) && lo(b)) return "black";
  if (hi(r) && hi(g) && hi(b)) return "white";
  if (lo(r) && hi(g) && hi(b)) return "cyan";
  if (hi(r) && lo(g) && hi(b)) return "magenta";
  if (hi(r) && hi(g) && lo(b)) return "yellow";
  if (hi(r) && lo(g) && lo(b)) return "red";
  if (lo(r) && hi(g) && lo(b)) return "green";
  if (lo(r) && lo(g) && hi(b)) return "blue";
  return `rgb(${r},${g},${b})`;
}

const lumAt = (row: Uint8ClampedArray, x: number) => {
  const i = x * 4;
  return 0.299 * row[i] + 0.587 * row[i + 1] + 0.114 * row[i + 2];
};

/** Downscale `src` to the grid and return per-cell luminance. */
function gridLuminance(src: CanvasImageSource): Float32Array | null {
  if (!tiny) return null;
  const ctx = tiny.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, GRID_W, GRID_H);
  ctx.drawImage(src, 0, 0, GRID_W, GRID_H);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, GRID_W, GRID_H).data;
  } catch {
    return null;
  }
  const out = new Float32Array(GRID_W * GRID_H);
  for (let c = 0; c < out.length; c++) {
    const i = c * 4;
    out[c] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return out;
}

/** Mean absolute per-cell luminance difference between two grids. */
function gridMotion(a: Float32Array | null, b: Float32Array): number {
  if (!a) return 255; // first frame: treat as full change
  let sum = 0;
  for (let i = 0; i < b.length; i++) sum += Math.abs(b[i] - a[i]);
  return sum / b.length;
}

/** Mid-row marker analysis: local-contrast line search + band colours. */
function analyzeMarkers(
  rowCtx: CanvasRenderingContext2D,
  w: number,
  h: number,
  compWidth: number
): Pick<ProbeFrame, "blackLineX" | "blackContrast" | "whiteLineX" | "whiteContrast" | "bands"> | null {
  if (w === 0 || h === 0) return null;
  let row: Uint8ClampedArray;
  try {
    row = rowCtx.getImageData(0, Math.floor(h / 2), w, 1).data;
  } catch {
    return null;
  }
  const toComp = compWidth / w;
  const WIN = Math.min(40, Math.max(6, Math.round(w * 0.015)));
  let blackX = 0,
    blackC = -1,
    whiteX = 0,
    whiteC = -1;
  for (let x = 0; x < w; x++) {
    const l = lumAt(row, x);
    const bg = (lumAt(row, Math.max(0, x - WIN)) + lumAt(row, Math.min(w - 1, x + WIN))) / 2;
    if (bg - l > blackC) {
      blackC = bg - l;
      blackX = x;
    }
    if (l - bg > whiteC) {
      whiteC = l - bg;
      whiteX = x;
    }
  }
  const bands: BandSample[] = [0.125, 0.375, 0.625, 0.875].map((f) => {
    const x = Math.min(w - 1, Math.floor(w * f));
    const i = x * 4;
    return { x: Math.round(x * toComp), r: row[i], g: row[i + 1], b: row[i + 2], name: classify(row[i], row[i + 1], row[i + 2]) };
  });
  return {
    blackLineX: Math.round(blackX * toComp),
    blackContrast: Math.round(blackC),
    whiteLineX: Math.round(whiteX * toComp),
    whiteContrast: Math.round(whiteC),
    bands,
  };
}

/** Build a ProbeFrame from a source canvas, computing motion vs `prevGrid`. */
function buildFrame(
  src: HTMLCanvasElement,
  tMs: number,
  compWidth: number,
  prevGrid: Float32Array | null
): { frame: ProbeFrame; grid: Float32Array } | null {
  const rowCtx = src.getContext("2d");
  if (!rowCtx) return null;
  const markers = analyzeMarkers(rowCtx, src.width, src.height, compWidth);
  if (!markers) return null;
  const grid = gridLuminance(src);
  if (!grid) return null;
  const motion = gridMotion(prevGrid, grid);
  return {
    grid,
    frame: { tMs: Math.round(tMs), motion: +motion.toFixed(2), changed: motion >= MOTION_CHANGE, ...markers },
  };
}

/** Sample the live render canvas (intended/preview trace) at comp time `tMs`. */
export function probePreview(canvas: HTMLCanvasElement, tMs: number): void {
  if (!report) return;
  const r = buildFrame(canvas, tMs, report.comp.width, prevPreviewGrid);
  if (!r) return;
  prevPreviewGrid = r.grid;
  report.preview.push(r.frame);
}

interface VFCMetadata {
  mediaTime: number;
}
type VFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, md: VFCMetadata) => void) => number;
};

/** Decode the exported BLOB frame by frame and build the output trace. */
export async function analyzeOutputVideo(blob: Blob): Promise<void> {
  if (!report) return;
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video") as VFCVideo;
  video.muted = true;
  (video as HTMLVideoElement).playsInline = true;
  video.src = url;
  video.style.cssText = "position:fixed;left:-10000px;width:1px;height:1px";
  document.body.appendChild(video);
  const cleanup = () => {
    try {
      video.pause();
    } catch {
      /* ignore */
    }
    document.body.removeChild(video);
    URL.revokeObjectURL(url);
  };

  // Reusable full-size frame canvas (decode target).
  const frameCv = document.createElement("canvas");

  const push = (tMs: number) => {
    const r = buildFrame(frameCv, tMs, report!.comp.width, prevOutputGrid);
    if (!r) return;
    prevOutputGrid = r.grid;
    report!.output.push(r.frame);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("video decode failed"));
    });
    frameCv.width = video.videoWidth || report.comp.width;
    frameCv.height = video.videoHeight || report.comp.height;
    const fctx = frameCv.getContext("2d", { willReadFrequently: true });
    if (!fctx) return;

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, report!.comp.durationMs * 1.5 + 4000);

      if (video.requestVideoFrameCallback) {
        const onFrame = (_n: number, md: VFCMetadata) => {
          fctx.drawImage(video, 0, 0, frameCv.width, frameCv.height);
          push(md.mediaTime * 1000);
          if (video.ended) {
            finish();
            return;
          }
          video.requestVideoFrameCallback!(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
        video.onended = finish;
        void video.play().catch(finish);
      } else {
        const step = 1 / Math.max(1, report!.comp.fps);
        let t = 0;
        const seekNext = () => {
          if (t > video.duration + 1e-3) {
            finish();
            return;
          }
          video.currentTime = t;
        };
        video.onseeked = () => {
          fctx.drawImage(video, 0, 0, frameCv.width, frameCv.height);
          push(t * 1000);
          t += step;
          seekNext();
        };
        seekNext();
      }
    });
  } finally {
    cleanup();
  }
}

/** Frame-rate + motion statistics for the decoded output. */
export function outputStats(): OutputStats | null {
  if (!report || report.output.length === 0) return null;
  const out = report.output;
  const { fps, durationMs } = report.comp;
  const span = Math.max(1, out[out.length - 1].tMs - out[0].tMs);
  const uniqueFrames = out.filter((f) => f.changed).length;
  const expectedFrames = Math.round((durationMs / 1000) * fps);
  const buckets = Math.max(1, Math.ceil(durationMs / 1000));
  const perSecond = new Array(buckets).fill(0);
  for (const f of out) {
    if (f.changed) perSecond[Math.min(buckets - 1, Math.floor(f.tMs / 1000))]++;
  }
  // Longest run of unchanged (frozen) frames, in ms.
  let longestFreezeMs = 0;
  let runStart = 0;
  for (let i = 1; i < out.length; i++) {
    if (out[i].changed) {
      longestFreezeMs = Math.max(longestFreezeMs, out[i].tMs - out[runStart].tMs);
      runStart = i;
    }
  }
  if (out.length) longestFreezeMs = Math.max(longestFreezeMs, out[out.length - 1].tMs - out[runStart].tMs);
  // Stale first frame: frame 0 differs a lot from frame 1 AND frame 1→2 is small
  // (i.e. the clip "really" starts at frame 1 and frame 0 is leftover canvas).
  const staleFirstFrame =
    out.length >= 3 && out[1].motion > 12 && out[2].motion < out[1].motion * 0.5;

  return {
    targetFps: fps,
    durationMs,
    expectedFrames,
    decodedFrames: out.length,
    uniqueFrames,
    presentedFps: +((out.length / span) * 1000).toFixed(1),
    effectiveFps: +((uniqueFrames / span) * 1000).toFixed(1),
    missingFrames: Math.max(0, expectedFrames - uniqueFrames),
    longestFreezeMs,
    staleFirstFrame,
    perSecond,
  };
}

export function probeSummary(): string {
  if (!report) return "No render probe captured yet.";
  const { preview, output, comp } = report;
  if (preview.length === 0 && output.length === 0) return "Probe ran but captured no frames.";
  let head = `Render probe — ${comp.width}×${comp.height} @${comp.fps}fps, ${(comp.durationMs / 1000).toFixed(2)}s\n`;
  const subj = report.subject;
  if (subj && (subj.transitions.length || subj.effectKinds.length)) {
    if (subj.transitions.length) head += `  transitions: ${subj.transitions.join(", ")}\n`;
    if (subj.effectKinds.length) head += `  effects: ${subj.effectKinds.join(", ")}\n`;
  }

  if (output.length === 0) {
    return head + `Preview samples: ${preview.length}\n\n(No output frames decoded — re-export with the probe on.)`;
  }
  const s = outputStats()!;
  const fpsBlock =
    "WHOLE-FRAME MONITOR (works for any content)\n" +
    `  expected:  ${s.expectedFrames} frames (${s.targetFps}fps × ${(s.durationMs / 1000).toFixed(2)}s)\n` +
    `  decoded:   ${s.decodedFrames} presented (~${s.presentedFps} fps container)\n` +
    `  UNIQUE:    ${s.uniqueFrames} → ~${s.effectiveFps} fps real motion\n` +
    `  MISSING:   ${s.missingFrames} vs target   longest freeze: ${s.longestFreezeMs}ms\n` +
    (s.staleFirstFrame ? "  ⚠ first frame looks STALE (leftover canvas before t=0)\n" : "") +
    `  unique/sec: [${s.perSecond.join(", ")}]\n`;

  // Show the strongest motion frames (jumps) and marker line at those times.
  const moving = output
    .filter((f) => f.changed)
    .slice(0, 14)
    .map(
      (f) =>
        `  t=${f.tMs}ms  motion ${f.motion}  black@${f.blackLineX}(c${f.blackContrast}) white@${f.whiteLineX}(c${f.whiteContrast})`
    )
    .join("\n");

  const verdict =
    s.effectiveFps < s.targetFps * 0.5
      ? `\n⚠ ~${s.effectiveFps} fps real motion vs ${s.targetFps} target — ${s.missingFrames} frames duplicated/missing (realtime capture can't keep up).`
      : `\n✓ ~${s.effectiveFps} fps real motion (target ${s.targetFps}).`;

  return head + fpsBlock + "\nMOTION FRAMES\n" + moving + "\n" + verdict;
}

export function probeReportJson(): string {
  if (!report) return JSON.stringify({ error: "no probe report" }, null, 2);
  return JSON.stringify({ ...report, stats: outputStats() }, null, 2);
}
