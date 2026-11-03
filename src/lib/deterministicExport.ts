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
import { Muxer as Mp4Muxer, StreamTarget as Mp4StreamTarget } from "mp4-muxer";

/** Bitrate (bits/s) for compression level 1..5 (1 = best quality / largest). */
export function bitrateForLevel(level: number): number {
  return ([24, 14, 8, 5, 3][level - 1] ?? 8) * 1_000_000;
}

/** Is the WebCodecs deterministic path available in this webview? */
export function isDeterministicSupported(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

/**
 * Render speed. "exact" is the original slow, fully conservative pipeline
 * (waits two screen refreshes per frame, CPU VP9 → x264 `medium`). "fast" skips
 * those waits, uses the GPU H.264 encoder when it can (straight to MP4, no
 * second encode) and faster ffmpeg settings. Remembered between sessions.
 */
export type ExportSpeed = "fast" | "exact";
const SPEED_KEY = "sefx.export.speed";

export function getExportSpeed(): ExportSpeed {
  try {
    return localStorage.getItem(SPEED_KEY) === "exact" ? "exact" : "fast";
  } catch {
    return "fast";
  }
}

export function setExportSpeed(s: ExportSpeed) {
  try {
    localStorage.setItem(SPEED_KEY, s);
  } catch {
    /* localStorage unavailable: the choice just isn't remembered */
  }
}

/** Where the time went in the last render (ms) — filled in by the encode loop. */
export interface ExportStats {
  /** Total spent inside `renderFrame` (evaluate + seek + paint). */
  renderMs: number;
  /** Total spent waiting for the encoder to drain. */
  encoderWaitMs: number;
  /** Final encoder flush + mux finalize + last upload. */
  flushMs: number;
  frames: number;
  codec: ExportCodec;
}

export type ExportCodec = "vp9" | "h264";

/**
 * A WebCodecs H.264 config this PC can encode (GPU first), or null — odd frame
 * sizes (H.264 needs even), or no H.264 encoder in the webview. Callers fall back
 * to the VP9 path on null.
 */
export async function pickH264Config(
  width: number,
  height: number,
  fps: number,
  bitrate: number
): Promise<VideoEncoderConfig | null> {
  if (!isDeterministicSupported() || width % 2 || height % 2) return null;
  for (const hardwareAcceleration of ["prefer-hardware", "no-preference"] as const) {
    // High profile, level 5.2 / 5.1 / 4.2 — the higher levels cover 4K and 60 fps.
    for (const codec of ["avc1.640034", "avc1.640033", "avc1.64002A"]) {
      for (const bitrateMode of ["constant", "variable"] as const) {
        const cfg: VideoEncoderConfig = {
          codec,
          width,
          height,
          bitrate,
          framerate: fps,
          hardwareAcceleration,
          bitrateMode,
          latencyMode: "quality",
          avc: { format: "avc" },
        };
        try {
          if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg;
        } catch {
          /* try the next combination */
        }
      }
    }
  }
  return null;
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
type StreamOpts = { onData: (data: Uint8Array, position: number) => void; chunked: boolean; chunkSize: number };

export function createUploadTarget<T = StreamTarget>(
  onData: (data: Uint8Array, position: number) => Promise<void>,
  // Which muxer's StreamTarget to build (WebM by default; MP4 for the H.264 path).
  make: (o: StreamOpts) => T = ((o: StreamOpts) => new StreamTarget(o)) as unknown as (o: StreamOpts) => T
) {
  let queue: Promise<void> = Promise.resolve();
  let failure: unknown = null;
  let pending = 0;
  let size = 0;
  const target = make({
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
  /** "vp9" (default): WebM. "h264": GPU H.264 straight into an MP4 (see `pickH264Config`). */
  codec?: ExportCodec;
  /** Filled in as the render runs — where the time went. */
  stats?: ExportStats;
  /** Render the comp at `tMs` and resolve once the canvas has painted it. */
  renderFrame: (tMs: number, frameIndex: number) => Promise<void>;
  /** Receives the file as it's muxed — see `createUploadTarget`. */
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

/** Resolve on the encoder's next `dequeue` (or after `capMs`, so a missed event can't hang). */
function nextDequeue(encoder: VideoEncoder, capMs = 40): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer = 0;
    const done = () => {
      encoder.removeEventListener("dequeue", done);
      clearTimeout(timer);
      resolve();
    };
    encoder.addEventListener("dequeue", done);
    timer = window.setTimeout(done, capMs);
  });
}

/**
 * Render every frame and encode it (VP9 → WebM by default, or GPU H.264 → MP4),
 * streamed through `onData`. Returns the file's total length in bytes.
 * Throws if WebCodecs / the codec config isn't supported (caller should fall back).
 */
export async function encodeDeterministicWebm(opts: DeterministicOpts): Promise<number> {
  const { canvas, width, height, fps, durationMs, bitrate, renderFrame } = opts;
  if (!isDeterministicSupported()) throw new Error("WebCodecs not available");
  const codec: ExportCodec = opts.codec ?? "vp9";
  const stats: ExportStats = opts.stats ?? { renderMs: 0, encoderWaitMs: 0, flushMs: 0, frames: 0, codec };
  stats.codec = codec;

  let config: VideoEncoderConfig;
  let upload: { settle: (all?: boolean) => Promise<void>; readonly size: number };
  let addChunk: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void;
  let finalize: () => void;

  if (codec === "h264") {
    const cfg = await pickH264Config(width, height, fps, bitrate);
    if (!cfg) throw new Error("H.264 encoder not available for this frame size");
    config = cfg;
    const u = createUploadTarget(opts.onData, (o) => new Mp4StreamTarget(o));
    upload = u;
    // fastStart:false = index at the end, so memory stays flat; Rust moves it to
    // the front (`+faststart`) while it muxes the audio.
    const muxer = new Mp4Muxer({
      target: u.target,
      video: { codec: "avc", width, height, frameRate: fps },
      fastStart: false,
      firstTimestampBehavior: "offset",
    });
    addChunk = (c, m) => muxer.addVideoChunk(c, m);
    finalize = () => muxer.finalize();
  } else {
    // Prefer constant bitrate so the WebM output size tracks the target (variable
    // bitrate undershoots badly on simple content); fall back to the default if the
    // platform can't do CBR VP9. For MP4 the intermediate is re-encoded by ffmpeg
    // anyway, so this mainly makes direct WebM exports match the size estimate.
    const baseCfg: VideoEncoderConfig = { codec: VP9_CODEC, width, height, bitrate, framerate: fps };
    config = { ...baseCfg, bitrateMode: "constant" };
    if (!(await VideoEncoder.isConfigSupported(config)).supported) {
      config = baseCfg;
      if (!(await VideoEncoder.isConfigSupported(config)).supported)
        throw new Error("VP9 encode config not supported");
    }
    const u = createUploadTarget(opts.onData);
    upload = u;
    const muxer = new Muxer({
      target: u.target,
      video: { codec: "V_VP9", width, height, frameRate: fps },
      firstTimestampBehavior: "offset",
    });
    addChunk = (c, m) => muxer.addVideoChunk(c, m);
    finalize = () => muxer.finalize();
  }

  let encodeError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      // A muxer failure (e.g. missing codec description) must fail the export, not
      // vanish as an uncaught error inside this callback and yield a broken file.
      try {
        addChunk(chunk, meta);
      } catch (e) {
        encodeError ??= e;
      }
    },
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
      const r0 = performance.now();
      await renderFrame(tMs, f);
      stats.renderMs += performance.now() - r0;
      opts.onFrameRendered?.(tMs, f);
      const frame = new VideoFrame(canvas, { timestamp: f * frameDurUs, duration: frameDurUs });
      encoder.encode(frame, { keyFrame: f % keyEvery === 0 });
      frame.close();
      // Backpressure: BLOCK until the encoder drains below the threshold before
      // rendering the next frame. This was an `if` that yielded a single task and
      // then kept queuing, so the software VP9 encoder fell far behind and the
      // whole backlog was deferred to flush() — which showed as the export
      // hanging at "100%". A `while` keeps the encoder in step with rendering so
      // progress is honest and flush() at the end is near-instant. Waiting on the
      // encoder's own `dequeue` event wakes the instant a slot frees, instead of
      // sleeping in 6 ms (clamped to ≥ 4 ms) steps.
      const w0 = performance.now();
      while (encoder.encodeQueueSize > 8) {
        if (encodeError) throw encodeError;
        await nextDequeue(encoder);
      }
      stats.encoderWaitMs += performance.now() - w0;
      stats.frames = f + 1;
      opts.onProgress?.((f + 1) / frameCount);
    }
    // Drain whatever's left; with the bounded queue above this is only a handful
    // of frames, so it returns quickly instead of processing a huge backlog.
    opts.onFlush?.();
    const fl0 = performance.now();
    await encoder.flush();
    if (encodeError) throw encodeError;
    finalize();
    await upload.settle(true);
    stats.flushMs = performance.now() - fl0;
    return upload.size;
  } finally {
    try {
      encoder.close();
    } catch {
      /* already closed / errored */
    }
  }
}
