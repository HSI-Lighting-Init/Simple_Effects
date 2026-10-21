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

import { Muxer, StreamTarget } from "webm-muxer";

/** Bitrate (bits/s) for compression level 1..5 (1 = best quality / largest). */
export function bitrateForLevel(level: number): number {
  return ([24, 14, 8, 5, 3][level - 1] ?? 8) * 1_000_000;
}

/** Is the WebCodecs deterministic path available in this webview? */
export function isDeterministicSupported(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

const VP9_CODEC = "vp09.00.10.08"; // profile 0, level 1.0, 8-bit

/** Muxer writes are batched into slices of this size before being handed off. */
const UPLOAD_CHUNK = 8 * 1024 * 1024;
/** Stop rendering while this much encoded data is still waiting to be uploaded. */
const MAX_PENDING_BYTES = 64 * 1024 * 1024;

/**
 * A webm-muxer target that streams the WebM out instead of accumulating it.
 * `onData(bytes, position)` is called IN ORDER, one at a time (the muxer also
 * writes at earlier positions when it patches headers on finalize, so the sink
 * must write at `position`, not append). Memory stays flat however long or
 * high-bitrate the render is — the old `ArrayBufferTarget` + base64 route threw
 * "Array buffer allocation failed" at ~1 GiB and silently produced an empty
 * upload at ~384 MB.
 */
export function createUploadTarget(onData: (data: Uint8Array, position: number) => Promise<void>) {
  let queue: Promise<void> = Promise.resolve();
  let failure: unknown = null;
  let pending = 0;
  let size = 0;
  const target = new StreamTarget({
    chunked: true,
    chunkSize: UPLOAD_CHUNK,
    onData: (data, position) => {
      const copy = data.slice(); // the muxer may reuse its buffer after we return
      size = Math.max(size, position + copy.byteLength);
      pending += copy.byteLength;
      queue = queue
        .then(() => (failure ? undefined : onData(copy, position)))
        .catch((e) => {
          failure ??= e;
        })
        .then(() => {
          pending -= copy.byteLength;
        });
    },
  });
  return {
    target,
    /** Total WebM length so far (final once the muxer is finalized). */
    get size() {
      return size;
    },
    /** Surface a failed upload; with `all`, or when too much is buffered, wait for the queue first. */
    async settle(all = false) {
      if (all || pending > MAX_PENDING_BYTES) await queue;
      if (failure) throw failure;
    },
  };
}

export interface DeterministicOpts {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  bitrate: number;
  /** Render the comp at `tMs` and resolve once the canvas has painted it. */
  renderFrame: (tMs: number, frameIndex: number) => Promise<void>;
  /** Receives the WebM as it's muxed — see `createUploadTarget`. */
  onData: (data: Uint8Array, position: number) => Promise<void>;
  /** Called after each frame is rendered (for the live preview probe trace). */
  onFrameRendered?: (tMs: number, frameIndex: number) => void;
  /** 0..1 progress for the UI. */
  onProgress?: (frac: number) => void;
  /** Called once the render loop is done and the final encoder flush begins. */
  onFlush?: () => void;
  /** Abort flag — checked each frame. */
  shouldAbort?: () => boolean;
}

/**
 * Render every frame and encode to a WebM (VP9), streamed through `onData`.
 * Returns the WebM's total length in bytes.
 * Throws if WebCodecs / the VP9 config isn't supported (caller should fall back).
 */
export async function encodeDeterministicWebm(opts: DeterministicOpts): Promise<number> {
  const { canvas, width, height, fps, durationMs, bitrate, renderFrame } = opts;
  if (!isDeterministicSupported()) throw new Error("WebCodecs not available");

  // Prefer constant bitrate so the WebM output size tracks the target (variable
  // bitrate undershoots badly on simple content); fall back to the default if the
  // platform can't do CBR VP9. For MP4 the intermediate is re-encoded by ffmpeg
  // anyway, so this mainly makes direct WebM exports match the size estimate.
  const baseCfg: VideoEncoderConfig = { codec: VP9_CODEC, width, height, bitrate, framerate: fps };
  let config: VideoEncoderConfig = { ...baseCfg, bitrateMode: "constant" };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) {
    config = baseCfg;
    if (!(await VideoEncoder.isConfigSupported(config)).supported)
      throw new Error("VP9 encode config not supported");
  }

  const upload = createUploadTarget(opts.onData);
  const muxer = new Muxer({
    target: upload.target,
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
  encoder.configure(config);

  const frameCount = Math.max(1, Math.round((durationMs / 1000) * fps));
  const frameDurUs = Math.round(1_000_000 / fps);
  const keyEvery = Math.max(1, Math.round(fps * 2)); // keyframe ~every 2s

  try {
    for (let f = 0; f < frameCount; f++) {
      if (opts.shouldAbort?.()) throw new Error("export aborted");
      if (encodeError) throw encodeError;
      await upload.settle();
      const tMs = Math.round((f * 1000) / fps);
      await renderFrame(tMs, f);
      opts.onFrameRendered?.(tMs, f);
      const frame = new VideoFrame(canvas, { timestamp: f * frameDurUs, duration: frameDurUs });
      encoder.encode(frame, { keyFrame: f % keyEvery === 0 });
      frame.close();
      // Backpressure: BLOCK until the encoder drains below the threshold before
      // rendering the next frame. This was an `if` that yielded a single task and
      // then kept queuing, so the software VP9 encoder fell far behind and the
      // whole backlog was deferred to flush() — which showed as the export
      // hanging at "100%". A `while` keeps the encoder in step with rendering so
      // progress is honest and flush() at the end is near-instant.
      while (encoder.encodeQueueSize > 8) {
        if (encodeError) throw encodeError;
        await new Promise((r) => setTimeout(r, 6));
      }
      opts.onProgress?.((f + 1) / frameCount);
    }
    // Drain whatever's left; with the bounded queue above this is only a handful
    // of frames, so it returns quickly instead of processing a huge backlog.
    opts.onFlush?.();
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    await upload.settle(true);
    return upload.size;
  } finally {
    try {
      encoder.close();
    } catch {
      /* already closed / errored */
    }
  }
}
