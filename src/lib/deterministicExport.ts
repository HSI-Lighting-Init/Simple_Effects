// Deterministic frame-by-frame export.
//
// The old export captured the preview canvas in REAL TIME via captureStream +
// MediaRecorder: if a frame couldn't render within its interval the canvas
// simply didn't change, so the file kept its container fps but had far fewer
// unique frames (the stutter), and timing depended on machine load.
//
// This renders each frame explicitly — set the time, wait for the canvas to
// actually paint, then hand that exact image to a WebCodecs VideoEncoder with a
// precise timestamp (frameIndex / fps). Encode speed no longer affects output
// timing: the result is exactly `fps`, every frame present, deterministic.
// Encoded as VP9 into a WebM (muxed in-browser); MP4 is produced by transcoding
// that WebM through the existing ffmpeg path.

import { Muxer, ArrayBufferTarget } from "webm-muxer";

/** Bitrate (bits/s) for compression level 1..5 (1 = best quality / largest). */
export function bitrateForLevel(level: number): number {
  return ([24, 14, 8, 5, 3][level - 1] ?? 8) * 1_000_000;
}

/** Is the WebCodecs deterministic path available in this webview? */
export function isDeterministicSupported(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

const VP9_CODEC = "vp09.00.10.08"; // profile 0, level 1.0, 8-bit

export interface DeterministicOpts {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  bitrate: number;
  /** Render the comp at `tMs` and resolve once the canvas has painted it. */
  renderFrame: (tMs: number, frameIndex: number) => Promise<void>;
  /** Called after each frame is rendered (for the live preview probe trace). */
  onFrameRendered?: (tMs: number, frameIndex: number) => void;
  /** 0..1 progress for the UI. */
  onProgress?: (frac: number) => void;
  /** Abort flag — checked each frame. */
  shouldAbort?: () => boolean;
}

/**
 * Render every frame and encode to a WebM (VP9). Returns the WebM bytes.
 * Throws if WebCodecs / the VP9 config isn't supported (caller should fall back).
 */
export async function encodeDeterministicWebm(opts: DeterministicOpts): Promise<Uint8Array> {
  const { canvas, width, height, fps, durationMs, bitrate, renderFrame } = opts;
  if (!isDeterministicSupported()) throw new Error("WebCodecs not available");

  const support = await VideoEncoder.isConfigSupported({ codec: VP9_CODEC, width, height, bitrate, framerate: fps });
  if (!support.supported) throw new Error("VP9 encode config not supported");

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "V_VP9", width, height, frameRate: fps },
    firstTimestampBehavior: "offset",
  });

  let encodeError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encodeError = e;
    },
  });
  encoder.configure({ codec: VP9_CODEC, width, height, bitrate, framerate: fps });

  const frameCount = Math.max(1, Math.round((durationMs / 1000) * fps));
  const frameDurUs = Math.round(1_000_000 / fps);
  const keyEvery = Math.max(1, Math.round(fps * 2)); // keyframe ~every 2s

  try {
    for (let f = 0; f < frameCount; f++) {
      if (opts.shouldAbort?.()) throw new Error("export aborted");
      if (encodeError) throw encodeError;
      const tMs = Math.round((f * 1000) / fps);
      await renderFrame(tMs, f);
      opts.onFrameRendered?.(tMs, f);
      const frame = new VideoFrame(canvas, { timestamp: f * frameDurUs, duration: frameDurUs });
      encoder.encode(frame, { keyFrame: f % keyEvery === 0 });
      frame.close();
      // Don't let the encoder queue run away on big comps.
      if (encoder.encodeQueueSize > 8) {
        await new Promise((r) => setTimeout(r, 0));
      }
      opts.onProgress?.((f + 1) / frameCount);
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    return new Uint8Array(muxer.target.buffer);
  } finally {
    try {
      encoder.close();
    } catch {
      /* already closed / errored */
    }
  }
}
