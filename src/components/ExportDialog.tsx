// Export options: choose MP4 (H.264 via ffmpeg) or WebM, and a 1–5 compression
// level (1 = near original / largest file, 5 = highest compression / smallest).
// MP4 needs ffmpeg; if it's missing, offer a one-click winget install.
import { useEffect, useState } from "react";
import { ffmpegStatus, installFfmpeg } from "../lib/api";

const LEVELS = [
  "Near original — largest file",
  "High quality",
  "Balanced",
  "Smaller file",
  "Highest compression — smallest file",
];

const FPS_OPTIONS = [24, 25, 30, 50, 60];

export default function ExportDialog({
  defaultFps,
  onExport,
  onClose,
}: {
  defaultFps: number;
  onExport: (format: "mp4" | "webm", level: number, fps: number, burnFps: boolean) => void;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<"mp4" | "webm">("mp4");
  const [level, setLevel] = useState(2);
  const [fps, setFps] = useState(defaultFps);
  const [burnFps, setBurnFps] = useState(false);
  const [ffmpeg, setFfmpeg] = useState<string | null | "checking">("checking");
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    ffmpegStatus()
      .then((p) => setFfmpeg(p))
      .catch(() => setFfmpeg(null));
  }, []);

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
              {FPS_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </select>
          </label>

          <label className="insp-field">
            Compression — level {level}
            <input
              type="range"
              min={1}
              max={5}
              step={1}
              value={level}
              onChange={(e) => setLevel(Number(e.target.value))}
            />
            <span className="muted">{LEVELS[level - 1]}</span>
          </label>

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
              onExport(format, level, fps, burnFps);
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
