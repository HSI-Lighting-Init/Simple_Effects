// Export options: choose MP4 (H.264 via ffmpeg) or WebM, a 1–5 compression
// level (1 = near original / largest file, 5 = highest compression / smallest),
// and a target bitrate. Shows the estimated output file size and render time.
// MP4 needs ffmpeg; if it's missing, offer a one-click winget install.
import { useEffect, useMemo, useState } from "react";
import { ffmpegStatus, installFfmpeg } from "../lib/api";
import { bitrateForLevel } from "../lib/deterministicExport";

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

// localStorage key holding the last measured render cost (ms per frame), used to
// estimate how long the next export will take. Calibrated after each export.
const MS_PER_FRAME_KEY = "sefx.export.msPerFrame";
const DEFAULT_MS_PER_FRAME = 90; // rough first-run guess (deterministic path)

function readMsPerFrame(): number {
  const v = Number(localStorage.getItem(MS_PER_FRAME_KEY));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MS_PER_FRAME;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
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
  onExport,
  onClose,
}: {
  defaultFps: number;
  durationMs: number;
  /** When exporting a selected section, the "in – out" label to show; else null. */
  rangeLabel: string | null;
  width: number;
  height: number;
  onExport: (
    format: "mp4" | "webm",
    level: number,
    fps: number,
    burnFps: boolean,
    bitrate: number,
    rateMode: "quality" | "bitrate",
  ) => void;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<"mp4" | "webm">("mp4");
  // Rate control: "quality" drives the encoder by a 1–5 compression level
  // (constant quality / variable size); "bitrate" targets an exact bits/s (so
  // the file size ≈ bitrate × duration). Only one control is shown at a time.
  const [rateMode, setRateMode] = useState<"quality" | "bitrate">("quality");
  const [level, setLevel] = useState(2);
  const [fps, setFps] = useState(defaultFps);
  const [burnFps, setBurnFps] = useState(false);
  // Target bitrate in bits/s. Follows the compression level unless the user picks
  // a preset or a custom value (then `bitrateTouched` stops the level from
  // overriding their choice).
  const [bitrate, setBitrate] = useState(() => bitrateForLevel(2));
  const [bitrateTouched, setBitrateTouched] = useState(false);
  const [ffmpeg, setFfmpeg] = useState<string | null | "checking">("checking");
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    ffmpegStatus()
      .then((p) => setFfmpeg(p))
      .catch(() => setFfmpeg(null));
  }, []);

  // Moving the compression slider re-derives the bitrate (unless the user has
  // explicitly overridden it via the bitrate control).
  const onLevel = (lv: number) => {
    setLevel(lv);
    if (!bitrateTouched) setBitrate(bitrateForLevel(lv));
  };

  const mbps = bitrate / 1_000_000;
  const isPreset = BITRATE_PRESETS.includes(Math.round(mbps));

  // The bitrate the output actually targets: the user's value in bitrate mode,
  // or the compression level's preset bitrate in quality mode. Both modes encode
  // at that target (constrained ABR), so the size estimate holds for both.
  const effBitrate = rateMode === "bitrate" ? bitrate : bitrateForLevel(level);

  // Estimated output size ≈ bitrate × duration (video only; export has no audio
  // track). Estimated render time ≈ frame count × last measured ms/frame.
  const { sizeStr, timeStr, frames } = useMemo(() => {
    const durSec = durationMs / 1000;
    const sizeBytes = (effBitrate * durSec) / 8;
    const nFrames = Math.max(1, Math.ceil(durSec * fps));
    const est = (nFrames * readMsPerFrame()) / 1000;
    return { sizeStr: formatBytes(sizeBytes), timeStr: formatDuration(est), frames: nFrames };
  }, [effBitrate, durationMs, fps]);

  // Quick reference: the estimated file size at each compression level, so the
  // trade-off is visible without dragging the slider through all five.
  const levelSizes = useMemo(() => {
    const durSec = durationMs / 1000;
    return LEVELS.map((_, i) => formatBytes((bitrateForLevel(i + 1) * durSec) / 8));
  }, [durationMs]);

  const checking = ffmpeg === "checking";
  const needFfmpeg = format === "mp4" && ffmpeg === null;

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
          <label className="insp-field">
            Format
            <div className="seg">
              <button
                className={"seg-btn" + (format === "mp4" ? " active" : "")}
                onClick={() => setFormat("mp4")}
              >
                MP4 · H.264
              </button>
              <button
                className={"seg-btn" + (format === "webm" ? " active" : "")}
                onClick={() => setFormat("webm")}
              >
                WebM · VP9
              </button>
            </div>
          </label>

          <label className="insp-field">
            Frame rate
            <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
              {!FPS_OPTIONS.includes(fps) && <option value={fps}>{fpsText(fps)}</option>}
              {FPS_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {fpsText(f)}
                </option>
              ))}
            </select>
          </label>

          <label className="insp-field">
            Rate control
            <div className="seg">
              <button
                className={"seg-btn" + (rateMode === "quality" ? " active" : "")}
                onClick={() => setRateMode("quality")}
              >
                Quality (level)
              </button>
              <button
                className={"seg-btn" + (rateMode === "bitrate" ? " active" : "")}
                onClick={() => setRateMode("bitrate")}
              >
                Bitrate (target size)
              </button>
            </div>
            <span className="muted">
              {rateMode === "quality"
                ? "Preset levels — file size ≈ the level's bitrate × duration."
                : "Exact bitrate — file size ≈ bitrate × duration."}
            </span>
          </label>

          {rateMode === "quality" ? (
            <label className="insp-field">
              Compression — level {level}
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={level}
                onChange={(e) => onLevel(Number(e.target.value))}
              />
              <span className="muted">{LEVELS[level - 1]}</span>
              <div className="export-levels">
                {levelSizes.map((s, i) => (
                  <span
                    key={i}
                    className={"export-level" + (i + 1 === level ? " active" : "")}
                    title={LEVELS[i]}
                    onClick={() => onLevel(i + 1)}
                  >
                    L{i + 1} · ~{s}
                  </span>
                ))}
              </div>
            </label>
          ) : (
            <label className="insp-field">
              Bitrate
              <select
                value={isPreset ? String(Math.round(mbps)) : "custom"}
                onChange={(e) => {
                  setBitrateTouched(true);
                  if (e.target.value !== "custom") {
                    setBitrate(Number(e.target.value) * 1_000_000);
                  }
                }}
              >
                {BITRATE_PRESETS.map((m) => (
                  <option key={m} value={String(m)}>
                    {m} Mbps
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
              {!isPreset && (
                <input
                  type="number"
                  min={0.5}
                  max={200}
                  step={0.5}
                  value={Number(mbps.toFixed(1))}
                  onChange={(e) => {
                    setBitrateTouched(true);
                    const v = Math.max(0.1, Number(e.target.value) || 0);
                    setBitrate(Math.round(v * 1_000_000));
                  }}
                />
              )}
              <span className="muted">{mbps.toFixed(1)} Mbps target</span>
            </label>
          )}

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
            <input
              type="checkbox"
              checked={burnFps}
              onChange={(e) => setBurnFps(e.target.checked)}
            />
            Show FPS on the video (burned-in label)
          </label>

          {format === "mp4" &&
            (checking ? (
              <p className="insp-hint">Checking for ffmpeg…</p>
            ) : ffmpeg ? (
              <p className="insp-hint">MP4 encodes with ffmpeg ✓</p>
            ) : (
              <div className="insp-field">
                <p className="insp-hint">
                  MP4 needs ffmpeg (H.264 encoder). Install it once, or export WebM instead.
                </p>
                <button className="insp-btn" disabled={installing} onClick={doInstall}>
                  {installing ? "Installing ffmpeg…" : "Install ffmpeg (winget)"}
                </button>
              </div>
            ))}
        </div>
        <div className="modal-actions">
          <button className="insp-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="insp-btn active"
            disabled={needFfmpeg || checking || installing}
            onClick={() => {
              onExport(format, level, fps, burnFps, bitrate, rateMode);
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
