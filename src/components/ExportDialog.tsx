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

export default function ExportDialog({
  onExport,
  onClose,
}: {
  onExport: (format: "mp4" | "webm", level: number) => void;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<"mp4" | "webm">("mp4");
  const [level, setLevel] = useState(2);
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
              onExport(format, level);
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
