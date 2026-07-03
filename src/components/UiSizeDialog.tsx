// UI size settings. The user resizes the panels live (by dragging the splitters,
// or by nudging the numbers here), then saves the current sizes as the default
// layout that the app opens with next time.
import { useState } from "react";

export type UiSizeKey = "mediaW" | "inspectorW" | "timelineH" | "labelsW";

const FIELDS: { key: UiSizeKey; label: string; hint: string }[] = [
  { key: "mediaW", label: "Media bin width", hint: "left panel" },
  { key: "inspectorW", label: "Inspector width", hint: "right panel" },
  { key: "timelineH", label: "Timeline height", hint: "bottom panel" },
  { key: "labelsW", label: "Layers column width", hint: "timeline layer names" },
];

export default function UiSizeDialog({
  values,
  bounds,
  onSet,
  onSave,
  onReset,
  onClose,
}: {
  values: Record<UiSizeKey, number>;
  bounds: Record<UiSizeKey, readonly [number, number]>;
  onSet: (key: UiSizeKey, value: number) => void;
  onSave: () => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [saved, setSaved] = useState(false);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">UI size</div>
        <div className="modal-body">
          <p className="insp-hint" style={{ margin: "0 0 4px" }}>
            Drag the panel splitters to resize, or nudge the numbers below. Then
            <b> Save as default</b> so the app opens at these sizes next time.
          </p>
          {FIELDS.map((f) => {
            const [lo, hi] = bounds[f.key];
            return (
              <label className="insp-field insp-slider" key={f.key}>
                <span className="insp-slider-head">
                  <span>
                    {f.label} <span className="muted">· {f.hint}</span>
                  </span>
                  <input
                    className="insp-num wide"
                    type="number"
                    min={lo}
                    max={hi}
                    step={1}
                    value={Math.round(values[f.key])}
                    onChange={(e) => {
                      if (e.target.value !== "") {
                        onSet(f.key, Number(e.target.value));
                        setSaved(false);
                      }
                    }}
                  />
                </span>
                <input
                  type="range"
                  min={lo}
                  max={hi}
                  step={1}
                  value={values[f.key]}
                  onChange={(e) => {
                    onSet(f.key, Number(e.target.value));
                    setSaved(false);
                  }}
                />
              </label>
            );
          })}
        </div>
        <div className="modal-actions">
          <button
            className="insp-btn"
            onClick={() => {
              onReset();
              setSaved(false);
            }}
          >
            Reset to defaults
          </button>
          <span style={{ flex: 1 }} />
          {saved && (
            <span className="muted" style={{ alignSelf: "center" }}>
              Saved ✓
            </span>
          )}
          <button
            className="insp-btn active"
            onClick={() => {
              onSave();
              setSaved(true);
            }}
          >
            Save as default
          </button>
          <button className="insp-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
