// Composition (workspace) settings: pick a resolution preset or enter a custom
// width/height, swap orientation, and apply. Layers keep their positions.
import { useState } from "react";

const PRESETS: { label: string; w: number; h: number }[] = [
  { label: "1920 × 1080 — Landscape (16:9)", w: 1920, h: 1080 },
  { label: "1280 × 720 — Landscape (16:9)", w: 1280, h: 720 },
  { label: "1080 × 1920 — Portrait (9:16)", w: 1080, h: 1920 },
  { label: "720 × 1280 — Portrait (9:16)", w: 720, h: 1280 },
  { label: "1080 × 1350 — Portrait (4:5)", w: 1080, h: 1350 },
  { label: "1080 × 1080 — Square (1:1)", w: 1080, h: 1080 },
  { label: "3840 × 2160 — 4K Landscape", w: 3840, h: 2160 },
];

// Standard editing frame rates (the comp/timeline runs at this rate).
const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];

/** Label a frame rate, tagging the common broadcast/film variants. */
function fpsLabel(f: number): string {
  const tag: Record<number, string> = {
    23.976: " — Film (NTSC)",
    24: " — Film",
    25: " — PAL",
    29.97: " — NTSC",
    30: "",
    50: " — PAL HFR",
    59.94: " — NTSC HFR",
    60: "",
  };
  const n = Number.isInteger(f) ? String(f) : f.toFixed(3).replace(/0+$/, "");
  return `${n} fps${tag[f] ?? ""}`;
}

export default function CompSettings({
  width,
  height,
  durationMs,
  fps,
  onApply,
  onClose,
}: {
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  onApply: (w: number, h: number, durationMs: number, fps: number) => void;
  onClose: () => void;
}) {
  const [w, setW] = useState(width);
  const [h, setH] = useState(height);
  // Edited in seconds (friendlier), stored as ms.
  const [secs, setSecs] = useState(durationMs / 1000);
  const [fpsVal, setFpsVal] = useState(fps);
  const orientation = w > h ? "Landscape" : w < h ? "Portrait" : "Square";
  const presetValue = PRESETS.some((p) => p.w === w && p.h === h) ? `${w}x${h}` : "";

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Composition settings</div>
        <div className="modal-body">
          <label className="insp-field">
            Preset
            <select
              value={presetValue}
              onChange={(e) => {
                const p = PRESETS.find((p) => `${p.w}x${p.h}` === e.target.value);
                if (p) {
                  setW(p.w);
                  setH(p.h);
                }
              }}
            >
              <option value="">Custom…</option>
              {PRESETS.map((p) => (
                <option key={p.label} value={`${p.w}x${p.h}`}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <div className="row2">
            <label className="insp-field">
              Width
              <input
                type="number"
                min={16}
                max={8192}
                value={w}
                onChange={(e) => setW(Number(e.target.value))}
              />
            </label>
            <label className="insp-field">
              Height
              <input
                type="number"
                min={16}
                max={8192}
                value={h}
                onChange={(e) => setH(Number(e.target.value))}
              />
            </label>
          </div>
          <div className="row2">
            <button
              className="insp-btn"
              onClick={() => {
                setW(h);
                setH(w);
              }}
            >
              ⟲ Swap W/H
            </button>
            <span className="muted" style={{ alignSelf: "center" }}>
              {w}×{h} · {orientation}
            </span>
          </div>
          <div className="row2">
            <label className="insp-field">
              Duration (seconds)
              <input
                type="number"
                min={0.1}
                max={3600}
                step={0.5}
                value={secs}
                onChange={(e) => setSecs(Number(e.target.value))}
              />
            </label>
            <label className="insp-field">
              Frame rate
              <select value={fpsVal} onChange={(e) => setFpsVal(Number(e.target.value))}>
                {!FPS_OPTIONS.includes(fpsVal) && (
                  <option value={fpsVal}>{fpsLabel(fpsVal)}</option>
                )}
                {FPS_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {fpsLabel(f)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="modal-actions">
          <button className="insp-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="insp-btn active"
            onClick={() => {
              onApply(Math.round(w), Math.round(h), Math.round(secs * 1000), fpsVal);
              onClose();
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
