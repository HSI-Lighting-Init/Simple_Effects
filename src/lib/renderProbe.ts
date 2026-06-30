// Render marker probe — calibration diagnostics for the export pipeline.
//
// The idea: keep a few CALIBRATION images as the top layers of the comp, each
// with a known feature at a known place:
//   - a black vertical line at x = 270 px
//   - a white vertical line at x = 540 px
//   - a CMYK band image (cyan / magenta / yellow / black across the width)
//
// During an export we read the ACTUAL rendered output frame at its mid-height
// row and detect where those features really landed and what colours show. If
// the render scales, offsets, crops, mistimes, or mis-colours anything, the
// detected positions/colours drift from the expected ones — so a bug report can
// point at "black line read 268 not 270 at t=1000ms" instead of a vague "it
// looks off". The probe never touches the images themselves; it only measures
// the composited output, so it reflects exactly what the video will contain.

/** Expected feature positions from the calibration images (comp pixels). */
export const EXPECTED = { blackLineX: 270, whiteLineX: 540 } as const;

export interface BandSample {
  /** Sample x in comp pixels. */
  x: number;
  r: number;
  g: number;
  b: number;
  /** Nearest named colour (cyan/magenta/yellow/black/…). */
  name: string;
}

export interface ProbeFrame {
  frame: number;
  tMs: number;
  /** Row (canvas px) that was sampled — mid height. */
  rowY: number;
  /** Darkest column, in COMP pixels, and its luminance 0..255 (the black line). */
  blackLineX: number;
  blackLum: number;
  /** Brightest column, in COMP pixels, and its luminance (the white line). */
  whiteLineX: number;
  whiteLum: number;
  /** Colours at the four CMYK band centres (1/8, 3/8, 5/8, 7/8 of width). */
  bands: BandSample[];
}

export interface ProbeReport {
  startedAt: string;
  comp: { width: number; height: number; fps: number; durationMs: number };
  /** Canvas backing-store size the frames were read at (comp px × pixelRatio). */
  canvas: { width: number; height: number };
  expected: { blackLineX: number; whiteLineX: number };
  frames: ProbeFrame[];
}

let enabled = false;
let report: ProbeReport | null = null;

export function isProbeEnabled(): boolean {
  return enabled;
}
export function setProbeEnabled(v: boolean): void {
  enabled = v;
}
export function lastReport(): ProbeReport | null {
  return report;
}

/** Start a fresh probe run for one export. */
export function beginProbeRun(
  comp: ProbeReport["comp"],
  canvas: ProbeReport["canvas"],
  startedAt: string
): void {
  report = { startedAt, comp, canvas, expected: { ...EXPECTED }, frames: [] };
}

/** Classify an RGB triple into a coarse named colour (for the CMYK bands). */
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

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * Sample one rendered frame off the export canvas. Reads the mid-height row,
 * finds the darkest and brightest columns (the calibration lines), and samples
 * the four band centres. Positions are converted to COMP pixels so they compare
 * directly to the expected marks regardless of canvas scale / pixelRatio.
 */
export function probeCanvas(canvas: HTMLCanvasElement, tMs: number): void {
  if (!report) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return;
  const rowY = Math.floor(h / 2);
  let row: Uint8ClampedArray;
  try {
    row = ctx.getImageData(0, rowY, w, 1).data;
  } catch {
    return; // tainted canvas — shouldn't happen with data: URL images
  }
  const toComp = report.comp.width / w; // canvas px → comp px

  let minLum = Infinity,
    minX = 0,
    maxLum = -1,
    maxX = 0;
  for (let x = 0; x < w; x++) {
    const i = x * 4;
    const l = lum(row[i], row[i + 1], row[i + 2]);
    if (l < minLum) {
      minLum = l;
      minX = x;
    }
    if (l > maxLum) {
      maxLum = l;
      maxX = x;
    }
  }

  const bands: BandSample[] = [0.125, 0.375, 0.625, 0.875].map((f) => {
    const x = Math.min(w - 1, Math.floor(w * f));
    const i = x * 4;
    const r = row[i],
      g = row[i + 1],
      b = row[i + 2];
    return { x: Math.round(x * toComp), r, g, b, name: classify(r, g, b) };
  });

  report.frames.push({
    frame: report.frames.length,
    tMs: Math.round(tMs),
    rowY,
    blackLineX: Math.round(minX * toComp),
    blackLum: Math.round(minLum),
    whiteLineX: Math.round(maxX * toComp),
    whiteLum: Math.round(maxLum),
    bands,
  });
}

/** A short, human-readable summary of the last probe run (for the panel). */
export function probeSummary(): string {
  if (!report || report.frames.length === 0) return "No render probe captured yet.";
  const { frames, comp, expected } = report;
  const dev = (got: number, exp: number) => {
    const d = got - exp;
    return d === 0 ? "✓" : `${d > 0 ? "+" : ""}${d}px`;
  };
  const blackDriftMax = Math.max(...frames.map((f) => Math.abs(f.blackLineX - expected.blackLineX)));
  const whiteDriftMax = Math.max(...frames.map((f) => Math.abs(f.whiteLineX - expected.whiteLineX)));
  const head =
    `Render probe — ${comp.width}×${comp.height} @${comp.fps}fps · ${frames.length} frames\n` +
    `Expected: black line @${expected.blackLineX}px, white line @${expected.whiteLineX}px, CMYK bands\n` +
    `Max drift: black ${blackDriftMax}px, white ${whiteDriftMax}px\n`;
  const lines = frames.map((f) => {
    const bands = f.bands.map((b) => b.name).join(",");
    return (
      `t=${f.tMs}ms  black@${f.blackLineX}(${dev(f.blackLineX, expected.blackLineX)},lum ${f.blackLum})` +
      `  white@${f.whiteLineX}(${dev(f.whiteLineX, expected.whiteLineX)},lum ${f.whiteLum})  [${bands}]`
    );
  });
  return head + lines.join("\n");
}

/** The full report as pretty JSON (for copy / save). */
export function probeReportJson(): string {
  return JSON.stringify(report ?? { error: "no probe report" }, null, 2);
}
