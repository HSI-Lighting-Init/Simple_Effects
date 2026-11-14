// Export options: container (MP4 / MKV / WebM) and video codec (H.264 / H.265 /
// AV1 / VP9), constant quality (a 1–5 level → CRF) or a target size (bitrate,
// 2-pass), subtitles burned in or as a track, and Advanced encoder speed,
// 10-bit and audio bitrate. Remembered between exports (exportSettings.ts).
// Shows the estimated size and render time. Codecs the installed ffmpeg can't
// encode are disabled; without ffmpeg, offer a one-click winget install.
import { useEffect, useMemo, useState } from "react";
import { ffmpegStatus, installFfmpeg } from "../lib/api";
import { getExportSpeed, setExportSpeed, type ExportSpeed } from "../lib/deterministicExport";
import {
  AUDIO_KBPS,
  SOFTWARE_ENCODER,
  bitrateForSize,
  codecsFor,
  estimateQualitySize,
  formatBytes,
  loadExportSettings,
  qualityRf,
  saveExportSettings,
  sizeForBitrate,
  type Container,
  type ExportSettings,
  type VideoCodec,
} from "../lib/exportSettings";

const LEVELS = [
  "Near original — largest file",
  "High quality",
  "Balanced",
  "Smaller file",
  "Highest compression — smallest file",
];

const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];

/** Compact fps label (trims trailing zeros on fractional rates). */
function fpsText(f: number): string {
  return `${Number.isInteger(f) ? f : f.toFixed(3).replace(/0+$/, "")} fps`;
}

// Preset bitrates offered in the dropdown (Mbps). "Custom" reveals a number box.
const BITRATE_PRESETS = [3, 5, 8, 14, 24, 40, 60];

const CONTAINERS: { id: Container; label: string }[] = [
  { id: "mp4", label: "MP4" },
  { id: "mkv", label: "MKV" },
  { id: "webm", label: "WebM" },
];

const CODEC_LABEL: Record<VideoCodec, string> = { h264: "H.264", h265: "H.265", av1: "AV1", vp9: "VP9" };
const CODEC_HINT: Record<VideoCodec, string> = {
  h264: "Plays everywhere. Best for Instagram, TikTok, WhatsApp.",
  h265: "About 30% smaller than H.264. Some Windows PCs need the HEVC extension to play it.",
  av1: "Smallest file. Slower to encode; older phones can't play it smoothly.",
  vp9: "For the web. Encodes slowly on the CPU.",
};

const SUBTITLE_HINT = {
  burn: "Drawn into the video with your fonts. Works everywhere, including social apps.",
  track: "A track viewers switch on and off, in the player's own font. Social apps ignore it.",
  both: "Drawn in, plus a track that's off by default.",
};

// localStorage key holding the last measured render cost (ms per frame), used to
// estimate how long the next export will take. Calibrated after each export.
const MS_PER_FRAME_KEY = "sefx.export.msPerFrame"; // exact mode
const MS_PER_FRAME_FAST_KEY = "sefx.export.msPerFrame.fast";
// Rough first-run guesses per mode (the first real export replaces them).
const DEFAULT_MS_PER_FRAME = 90;
const DEFAULT_MS_PER_FRAME_FAST = 30;

function readMsPerFrame(speed: ExportSpeed): number {
  const fast = speed === "fast";
  const v = Number(localStorage.getItem(fast ? MS_PER_FRAME_FAST_KEY : MS_PER_FRAME_KEY));
  return Number.isFinite(v) && v > 0 ? v : fast ? DEFAULT_MS_PER_FRAME_FAST : DEFAULT_MS_PER_FRAME;
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export default function ExportDialog({
  defaultFps,
  durationMs,
  rangeLabel,
  width,
  height,
  hasAudio,
  hasSubtitles,
  onExport,
  onClose,
}: {
  defaultFps: number;
  durationMs: number;
  /** When exporting a selected section, the "in – out" label to show; else null. */
  rangeLabel: string | null;
  width: number;
  height: number;
  /** The comp has audio clips (shows the audio bitrate). */
  hasAudio: boolean;
  /** The comp has a Subtitles group (shows the subtitle options). */
  hasSubtitles: boolean;
  onExport: (settings: ExportSettings) => void;
  onClose: () => void;
}) {
  // Everything but the frame rate (the comp's) and the FPS label is remembered.
  const [s, setS] = useState<ExportSettings>(() => ({ ...loadExportSettings(), fps: defaultFps, burnFps: false }));
  const set = (patch: Partial<ExportSettings>) => setS((prev) => ({ ...prev, ...patch }));
  // Render speed: "fast" (GPU encode, no extra waits) or "exact" (the slow,
  // conservative pipeline). Remembered on its own; applied when Export is pressed.
  const [speed, setSpeed] = useState<ExportSpeed>(() => getExportSpeed());
  const [ffmpeg, setFfmpeg] = useState<{ path: string; encoders: string[] } | null | "checking">("checking");
  const [installing, setInstalling] = useState(false);
  // The MB / Mbps boxes' text while it's being typed in (so "2." isn't
  // reformatted to "2", and "5" on the way to "50" doesn't close the box).
  const [mbText, setMbText] = useState<string | null>(null);
  const [mbpsText, setMbpsText] = useState<string | null>(null);
  // "Custom…" was picked: keep the Mbps box open even at a preset value.
  const [customBitrate, setCustomBitrate] = useState(false);

  useEffect(() => {
    ffmpegStatus()
      .then((p) => setFfmpeg(p))
      .catch(() => setFfmpeg(null));
  }, []);

  const checking = ffmpeg === "checking";
  const info = checking ? null : ffmpeg;
  const audioKbps = hasAudio ? s.audioKbps : 0;

  /** Why `codec` can't be exported right now, or null if it can. */
  const codecBlocked = (codec: VideoCodec): string | null => {
    if (checking) return null;
    if (!info) return s.container === "webm" && codec === "vp9" ? null : "Needs ffmpeg (install it below).";
    const enc = SOFTWARE_ENCODER[codec];
    // An empty list means the encoder list couldn't be read: don't block on that.
    return info.encoders.length && !info.encoders.includes(enc) ? `This ffmpeg (${info.path}) has no ${enc} encoder.` : null;
  };
  const blocked = codecBlocked(s.codec);

  const pickContainer = (container: Container) => {
    const allowed = codecsFor(container);
    set({ container, codec: allowed.includes(s.codec) ? s.codec : allowed[0] });
  };

  const mbps = s.bitrate / 1_000_000;
  const showCustom = customBitrate || !BITRATE_PRESETS.includes(Math.round(mbps * 10) / 10);
  const sizeMb = sizeForBitrate(s.bitrate, durationMs, audioKbps);

  // Estimated output size: exact for a target size; from the last export at this
  // codec + level for constant quality (none yet → "varies with content").
  // Estimated render time ≈ frame count × last measured ms/frame.
  const { sizeStr, timeStr, frames } = useMemo(() => {
    const nFrames = Math.max(1, Math.ceil((durationMs / 1000) * s.fps));
    const est = (nFrames * readMsPerFrame(speed)) / 1000;
    let size: string;
    if (s.rateMode === "bitrate") size = formatBytes(sizeMb * 1024 * 1024);
    else {
      const q = estimateQualitySize(s.codec, s.level, width * height * nFrames);
      size = q == null ? "Varies with content" : `~${formatBytes(q)}`;
    }
    return { sizeStr: size, timeStr: formatDuration(est), frames: nFrames };
  }, [s.rateMode, s.codec, s.level, s.fps, sizeMb, durationMs, speed, width, height]);

  const needFfmpeg = ffmpeg === null && !(s.container === "webm" && s.codec === "vp9");

  const doInstall = async () => {
    setInstalling(true);
    try {
      await installFfmpeg();
      setFfmpeg(await ffmpegStatus());
    } catch (e) {
      alert(`ffmpeg install failed: ${e}`);
    } finally {
      setInstalling(false);
    }
  };

  const seg = <T extends string>(value: T, current: T, label: string, onPick: (v: T) => void, title?: string, disabled?: boolean) => (
    <button
      key={value}
      className={"seg-btn" + (value === current ? " active" : "")}
      title={title}
      disabled={disabled}
      onClick={() => onPick(value)}
    >
      {label}
    </button>
  );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Export video</div>
        <div className="modal-body">
          {rangeLabel && (
            <div className="export-range-note">
              Exporting selected range <strong>{rangeLabel}</strong> — clear it on the
              timeline (⤫) to export the whole comp.
            </div>
          )}
          {/* Rows of buttons are <div>s: a <label> sends any click on its text
              (the hints) to its first button. */}
          <div className="insp-field">
            Container
            <div className="seg">{CONTAINERS.map((c) => seg(c.id, s.container, c.label, pickContainer))}</div>
            {s.container === "mkv" && (
              <span className="muted">For archive, VLC and switchable subtitles. Social apps won't accept MKV.</span>
            )}
          </div>

          <div className="insp-field">
            Video codec
            <div className="seg">
              {codecsFor(s.container).map((c) =>
                seg(c, s.codec, CODEC_LABEL[c], (codec) => set({ codec }), codecBlocked(c) ?? undefined, !!codecBlocked(c))
              )}
            </div>
            <span className="muted">{blocked ?? CODEC_HINT[s.codec]}</span>
          </div>

          <div className="insp-field">
            Render speed
            <div className="seg">
              {seg("fast", speed, "Fast", setSpeed)}
              {seg("exact", speed, "Exact (slow)", setSpeed)}
            </div>
            <span className="muted">
              {speed === "fast"
                ? "Uses the GPU encoder when available and skips extra waits. Several times faster; the file may be slightly larger/softer."
                : "Original pipeline: waits for every frame to fully paint and encodes on the CPU. Slowest, most conservative — use it if Fast ever shows a glitch."}
            </span>
          </div>

          <label className="insp-field">
            Frame rate
            <select value={s.fps} onChange={(e) => set({ fps: Number(e.target.value) })}>
              {!FPS_OPTIONS.includes(s.fps) && <option value={s.fps}>{fpsText(s.fps)}</option>}
              {FPS_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {fpsText(f)}
                </option>
              ))}
            </select>
          </label>

          <div className="insp-field">
            Quality
            <div className="seg">
              {seg("quality", s.rateMode, "Constant quality", (rateMode) => set({ rateMode }))}
              {seg("bitrate", s.rateMode, "Target size", (rateMode) => set({ rateMode }))}
            </div>
            <span className="muted">
              {s.rateMode === "quality"
                ? "The smallest file for the chosen look — the size depends on the content."
                : "Hits the size you set (2-pass encode; constant bitrate on the GPU)."}
            </span>
          </div>

          {s.rateMode === "quality" ? (
            <label className="insp-field">
              Level {s.level}
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={s.level}
                onChange={(e) => set({ level: Number(e.target.value) })}
              />
              <span className="muted">
                {LEVELS[s.level - 1]} · RF {qualityRf(s.codec, s.level)}
              </span>
            </label>
          ) : (
            <div className="insp-field">
              Bitrate
              <select
                value={showCustom ? "custom" : String(Math.round(mbps * 10) / 10)}
                onChange={(e) => {
                  setCustomBitrate(e.target.value === "custom");
                  if (e.target.value !== "custom") set({ bitrate: Number(e.target.value) * 1_000_000 });
                }}
              >
                {BITRATE_PRESETS.map((m) => (
                  <option key={m} value={String(m)}>
                    {m} Mbps
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
              {showCustom && (
                <span>
                  <input
                    type="number"
                    min={0.1}
                    max={400}
                    step={0.5}
                    value={mbpsText ?? mbps.toFixed(1)}
                    onChange={(e) => {
                      setMbpsText(e.target.value);
                      const v = Number(e.target.value);
                      if (v > 0) set({ bitrate: Math.round(Math.min(400, v) * 1_000_000) });
                    }}
                    onBlur={() => setMbpsText(null)}
                  />{" "}
                  Mbps
                </span>
              )}
              <span className="muted">or a file size:</span>
              <span>
                <input
                  type="number"
                  min={0.1}
                  step={1}
                  value={mbText ?? sizeMb.toFixed(1)}
                  onChange={(e) => {
                    setMbText(e.target.value);
                    const mb = Number(e.target.value);
                    if (mb > 0) set({ bitrate: bitrateForSize(mb, durationMs, audioKbps) });
                  }}
                  onBlur={() => setMbText(null)}
                />{" "}
                MB
              </span>
            </div>
          )}

          {hasSubtitles && (
            <div className="insp-field">
              Subtitles
              <div className="seg">
                {seg("burn", s.subtitleMode, "Burned in", (subtitleMode) => set({ subtitleMode }))}
                {seg("track", s.subtitleMode, "Separate track", (subtitleMode) => set({ subtitleMode }))}
                {seg("both", s.subtitleMode, "Both", (subtitleMode) => set({ subtitleMode }))}
              </div>
              <span className="muted">{SUBTITLE_HINT[s.subtitleMode]}</span>
              <label className="surf-face">
                <input
                  type="checkbox"
                  checked={s.subtitleSidecar}
                  onChange={(e) => set({ subtitleSidecar: e.target.checked })}
                />
                Also save an .srt file next to the video
              </label>
            </div>
          )}

          <details className="insp-field">
            <summary>Advanced</summary>
            <div className="insp-field">
              Encoder speed
              <div className="seg">
                {seg("faster", s.encoderSpeed, "Faster", (encoderSpeed) => set({ encoderSpeed }))}
                {seg("balanced", s.encoderSpeed, "Balanced", (encoderSpeed) => set({ encoderSpeed }))}
                {seg("smaller", s.encoderSpeed, "Smaller file", (encoderSpeed) => set({ encoderSpeed }))}
              </div>
              <span className="muted">Slower encoding fits the same quality into a smaller file.</span>
            </div>
            {(s.codec === "h265" || s.codec === "av1") && (
              <label className="surf-face">
                <input type="checkbox" checked={s.tenBit} onChange={(e) => set({ tenBit: e.target.checked })} />
                10-bit colour (less banding in gradients)
              </label>
            )}
            {hasAudio && (
              <label className="insp-field">
                Audio ({s.container === "webm" ? "Opus" : "AAC"})
                <select value={s.audioKbps} onChange={(e) => set({ audioKbps: Number(e.target.value) })}>
                  {AUDIO_KBPS.map((k) => (
                    <option key={k} value={k}>
                      {k} kbps
                    </option>
                  ))}
                </select>
              </label>
            )}
          </details>

          <div className="export-estimate">
            <div>
              <span className="muted">Resolution</span>
              <strong>
                {width}×{height}
              </strong>
            </div>
            <div>
              <span className="muted">Estimated size</span>
              <strong>{sizeStr}</strong>
            </div>
            <div>
              <span className="muted">Estimated render</span>
              <strong>~{timeStr}</strong>
            </div>
            <div>
              <span className="muted">Frames</span>
              <strong>{frames}</strong>
            </div>
          </div>

          <label className="surf-face">
            <input type="checkbox" checked={s.burnFps} onChange={(e) => set({ burnFps: e.target.checked })} />
            Show FPS on the video (burned-in label)
          </label>

          {checking ? (
            <p className="insp-hint">Checking for ffmpeg…</p>
          ) : info ? (
            <p className="insp-hint">Encodes with ffmpeg ✓</p>
          ) : (
            <div className="insp-field">
              <p className="insp-hint">
                MP4, MKV, H.265 and AV1 need ffmpeg. Install it once, or export WebM · VP9 instead.
              </p>
              <button className="insp-btn" disabled={installing} onClick={doInstall}>
                {installing ? "Installing ffmpeg…" : "Install ffmpeg (winget)"}
              </button>
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button className="insp-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="insp-btn active"
            disabled={needFfmpeg || checking || installing || !!blocked}
            onClick={() => {
              setExportSpeed(speed);
              saveExportSettings(s);
              onExport(s);
              onClose();
            }}
          >
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
