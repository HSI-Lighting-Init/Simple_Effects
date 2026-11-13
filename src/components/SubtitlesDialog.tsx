// Right-click a video/audio clip → Generate Subtitles from Speech… Picks a
// language and a speech model, downloads the model the first time, then
// transcribes the part of the clip the timeline plays (offline, via ffmpeg's
// Whisper filter) into a "Subtitles" group of editable text layers.
import { useState } from "react";
import type { SubtitleResult } from "../bindings/SubtitleResult";
import {
  cancelExport,
  downloadWhisperModel,
  transcribeLayer,
  updateFfmpeg,
  whisperModelReady,
  type SpeechQuality,
} from "../lib/api";

const LANGUAGES: [string, string][] = [
  ["auto", "Auto-detect"],
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["ar", "Arabic"],
  ["fa", "Persian"],
  // Not Chinese/Japanese: the subtitle font (Vazirmatn) has no CJK glyphs, and
  // CJK lines have no spaces to wrap at.
];

/** The Rust side's cancel error (`EXPORT_CANCELLED`). */
const CANCELLED = "export cancelled";

export function SubtitlesDialog({
  layerId,
  layerName,
  onClose,
  onDone,
}: {
  layerId: number;
  layerName: string;
  onClose: () => void;
  onDone: (r: SubtitleResult) => void;
}) {
  const [language, setLanguage] = useState("auto");
  const [quality, setQuality] = useState<SpeechQuality>("fast");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = status != null;

  const generate = async () => {
    setError(null);
    try {
      if (!(await whisperModelReady(quality))) {
        setStatus("Downloading speech model… (only the first time)");
        await downloadWhisperModel(quality);
      }
      setStatus("Transcribing…");
      onDone(await transcribeLayer(layerId, quality, language));
    } catch (e) {
      const msg = String(e);
      if (msg !== CANCELLED) setError(msg);
    } finally {
      setStatus(null);
    }
  };

  const update = async () => {
    setError(null);
    setStatus("Updating ffmpeg… (this can take a few minutes)");
    try {
      await updateFfmpeg();
    } catch (e) {
      setError(String(e));
    } finally {
      setStatus(null);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Generate subtitles · {layerName}</div>
        <div className="modal-body">
          <p className="insp-hint">
            Listens to the part of this clip that's on the timeline and adds each spoken line as a
            text layer in a "Subtitles" group. It runs on this computer — nothing is uploaded.
          </p>

          <label className="insp-field">
            <span className="row2" style={{ justifyContent: "space-between" }}>
              <span>Language</span>
              <select value={language} disabled={busy} onChange={(e) => setLanguage(e.target.value)}>
                {LANGUAGES.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </span>
          </label>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label className="surf-face">
              <input
                type="radio"
                name="speech-quality"
                checked={quality === "fast"}
                disabled={busy}
                onChange={() => setQuality("fast")}
              />
              Fast (≈148 MB download once)
            </label>
            <label className="surf-face">
              <input
                type="radio"
                name="speech-quality"
                checked={quality === "accurate"}
                disabled={busy}
                onChange={() => setQuality("accurate")}
              />
              Accurate (≈574 MB download once)
            </label>
          </div>

          {status && <p className="insp-hint">{status}</p>}
          {error && (
            <p className="insp-hint" style={{ color: "#e06c5c" }}>
              {error}
            </p>
          )}
          {error?.includes("needs ffmpeg 8") && !busy && (
            <button className="insp-btn" onClick={() => void update()}>
              Update ffmpeg
            </button>
          )}
        </div>
        <div className="modal-actions">
          {busy ? (
            <button className="insp-btn" onClick={() => void cancelExport()}>
              Cancel
            </button>
          ) : (
            <button className="insp-btn" onClick={onClose}>
              Close
            </button>
          )}
          <button className="insp-btn active" disabled={busy} onClick={() => void generate()}>
            Generate
          </button>
        </div>
      </div>
    </div>
  );
}
