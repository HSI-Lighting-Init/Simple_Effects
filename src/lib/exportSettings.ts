// Export settings: what the Export dialog chooses (container, codec, constant
// quality or a target size, encoder speed, subtitles, audio), remembered between
// exports. Rust's `ExportSettings` (src-tauri/src/lib.rs) is the other half of
// this shape; `quality_value` there is the table `qualityRf` mirrors.
import type { Layer } from "../bindings/Layer";

export type Container = "mp4" | "mkv" | "webm";
export type VideoCodec = "h264" | "h265" | "av1" | "vp9";
export type EncoderSpeed = "faster" | "balanced" | "smaller";
export type SubtitleMode = "burn" | "track" | "both";
export type RateMode = "quality" | "bitrate";

export interface ExportSettings {
  container: Container;
  codec: VideoCodec;
  /** "quality": constant quality (CRF), size varies. "bitrate": hit `bitrate` (2-pass). */
  rateMode: RateMode;
  /** 1 (near original) … 5 (smallest). */
  level: number;
  /** Target bits/s in bitrate mode. */
  bitrate: number;
  encoderSpeed: EncoderSpeed;
  /** 10-bit H.265 / AV1. */
  tenBit: boolean;
  audioKbps: number;
  /** Subtitles group: only in the pixels / only a soft track / both. */
  subtitleMode: SubtitleMode;
  /** Also save an .srt next to the video. */
  subtitleSidecar: boolean;
  /** Not remembered: the dialog starts from the comp's. */
  fps: number;
  /** Not remembered: a debug overlay. */
  burnFps: boolean;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  container: "mp4",
  codec: "h264",
  rateMode: "quality",
  level: 2,
  bitrate: 14_000_000,
  encoderSpeed: "balanced",
  tenBit: true,
  audioKbps: 192,
  subtitleMode: "burn",
  subtitleSidecar: false,
  fps: 30,
  burnFps: false,
};

export const AUDIO_KBPS = [128, 160, 192, 320];

const CODECS: Record<Container, VideoCodec[]> = {
  mp4: ["h264", "h265", "av1"],
  mkv: ["h264", "h265", "av1"],
  webm: ["vp9", "av1"],
};
/** Codecs a container can carry (matches Rust `codec_fits`). */
export const codecsFor = (c: Container): VideoCodec[] => CODECS[c];

/** The ffmpeg encoder each codec needs (as `ffmpeg_status` lists them). */
export const SOFTWARE_ENCODER: Record<VideoCodec, string> = {
  h264: "libx264",
  h265: "libx265",
  av1: "libsvtav1",
  vp9: "libvpx-vp9",
};

// Mirrors Rust `quality_value`, software column.
const RF: Record<VideoCodec, number[]> = {
  h264: [16, 18, 20, 23, 26],
  h265: [20, 22, 25, 28, 31],
  av1: [25, 30, 35, 40, 45],
  vp9: [24, 28, 32, 38, 44],
};
/** The CRF ("RF" in HandBrake) a quality level encodes at. */
export const qualityRf = (codec: VideoCodec, level: number): number =>
  RF[codec][Math.min(5, Math.max(1, Math.round(level))) - 1];

const MB = 1024 * 1024;

/** Video bits/s that makes a `mb`-megabyte file of `durationMs`, leaving room for the audio. */
export function bitrateForSize(mb: number, durationMs: number, audioKbps: number): number {
  const secs = Math.max(0.001, durationMs / 1000);
  return Math.max(100_000, Math.round((mb * 8 * MB) / secs - audioKbps * 1000));
}

/** File size (MB) of `bps` video plus the audio over `durationMs`. */
export function sizeForBitrate(bps: number, durationMs: number, audioKbps: number): number {
  return ((bps + audioKbps * 1000) * (durationMs / 1000)) / 8 / MB;
}

/** Bitrate for the frame encoder when ffmpeg re-encodes afterwards: generous
 *  (~0.4 bits per pixel) so it isn't what limits the final quality. It's a temp file. */
export function intermediateBitrate(width: number, height: number, fps: number): number {
  return Math.min(120_000_000, Math.max(24_000_000, Math.round(0.4 * width * height * fps)));
}

// Fast mode's GPU H.264 (WebCodecs quantizer mode): the fixed QP per quality
// level, matched to x264's VMAF per level like Rust's `quality_value` (NVENC
// constqp on SE-test-assets synthetic-1, 2026-11-13).
const GPU_H264_QP = [22, 23, 25, 28, 30];
// The GPU file ffmpeg re-encodes (H.265 / AV1, or any target size but H.264's):
// near-lossless, and its size follows the content. A fixed ~25 Mbps intermediate
// made Fast exports ~1.8× slower than encoding the final stream directly.
const INTERMEDIATE_QP = 18;

/** What the render must do for `s` (`wantH264`: Fast's GPU H.264 path is tried).
 *  `copied`: the frame encoder's file IS the output's video at the target bitrate
 *  (mirrors Rust `can_copy`). `gpuQp`: encode the GPU H.264 at this fixed QP —
 *  the level's when it's the final H.264 (Rust keeps it: `uploadFinal`),
 *  INTERMEDIATE_QP when ffmpeg re-encodes it; null: encode at a bitrate.
 *  `burnSubtitles`: the Subtitles group stays in the pixels — always, unless
 *  it's a track-only export that ffmpeg can actually mux (without ffmpeg the
 *  track would be dropped). */
export function exportPlan(s: ExportSettings, wantH264: boolean, haveFfmpeg: boolean) {
  const sameStream = s.container === "webm" ? s.codec === "vp9" : s.codec === "h264" && wantH264;
  const copied = sameStream && (s.rateMode === "bitrate" || !haveFfmpeg);
  const gpu = wantH264 && s.container !== "webm";
  const gpuQp = !gpu || copied ? null : s.codec === "h264" ? GPU_H264_QP[Math.min(5, Math.max(1, s.level)) - 1] : INTERMEDIATE_QP;
  return { copied, gpuQp, burnSubtitles: s.subtitleMode !== "track" || !haveFfmpeg };
}

/** Saved settings (or anything else) → valid settings. */
export function normalizeExportSettings(raw: unknown): ExportSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_EXPORT_SETTINGS;
  const pick = <T>(v: unknown, allowed: readonly T[], def: T): T => (allowed.includes(v as T) ? (v as T) : def);
  const num = (v: unknown, lo: number, hi: number, def: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
  const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
  const container = pick(r.container, ["mp4", "mkv", "webm"] as const, d.container);
  return {
    container,
    codec: pick(r.codec, codecsFor(container), codecsFor(container)[0]),
    rateMode: pick(r.rateMode, ["quality", "bitrate"] as const, d.rateMode),
    level: Math.round(num(r.level, 1, 5, d.level)),
    bitrate: Math.round(num(r.bitrate, 100_000, 400_000_000, d.bitrate)),
    encoderSpeed: pick(r.encoderSpeed, ["faster", "balanced", "smaller"] as const, d.encoderSpeed),
    tenBit: bool(r.tenBit, d.tenBit),
    audioKbps: pick(r.audioKbps, AUDIO_KBPS, d.audioKbps),
    subtitleMode: pick(r.subtitleMode, ["burn", "track", "both"] as const, d.subtitleMode),
    subtitleSidecar: bool(r.subtitleSidecar, d.subtitleSidecar),
    fps: num(r.fps, 1, 240, d.fps),
    burnFps: bool(r.burnFps, d.burnFps),
  };
}

const SETTINGS_KEY = "sefx.export.settings";

export function loadExportSettings(): ExportSettings {
  try {
    return normalizeExportSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_EXPORT_SETTINGS };
  }
}

export function saveExportSettings(s: ExportSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, fps: undefined, burnFps: undefined }));
  } catch {
    /* localStorage unavailable: the choice just isn't remembered */
  }
}

// Constant quality has no exact size, so the estimate learns from the last
// export with the same codec and level: bits per pixel per frame.
const bppKey = (codec: VideoCodec, level: number) => `sefx.export.bpp.${codec}.${level}`;

export function recordQualitySize(codec: VideoCodec, level: number, bytes: number, pixelFrames: number) {
  if (!(bytes > 0 && pixelFrames > 0)) return;
  try {
    localStorage.setItem(bppKey(codec, level), String((bytes * 8) / pixelFrames));
  } catch {
    /* no estimate next time */
  }
}

/** Bytes, or null with no history ("varies with content"). */
export function estimateQualitySize(codec: VideoCodec, level: number, pixelFrames: number): number | null {
  try {
    const bpp = Number(localStorage.getItem(bppKey(codec, level)));
    return bpp > 0 && Number.isFinite(bpp) ? (bpp * pixelFrames) / 8 : null;
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

/** Visible top-level "Subtitles" groups (what Import Subtitles / speech detection make). */
export function subtitleGroups(layers: Layer[]): Layer[] {
  return layers.filter((l) => !l.hidden && l.kind.kind === "group" && l.name === "Subtitles");
}

/** Their visible text lines as cues for [inMs, outMs], clipped to the group and
 *  the range and shifted so inMs is 0 (export time). Sorted by start. */
export function subtitleCues(layers: Layer[], inMs: number, outMs: number): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const g of subtitleGroups(layers)) {
    if (g.kind.kind !== "group") continue;
    for (const c of g.kind.children) {
      if (c.hidden || c.kind.kind !== "text" || !c.kind.content.trim()) continue;
      const start = Math.max(c.startMs, g.startMs, inMs);
      const end = Math.min(c.endMs, g.endMs, outMs);
      if (end > start) cues.push({ startMs: start - inMs, endMs: end - inMs, text: c.kind.content });
    }
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}
