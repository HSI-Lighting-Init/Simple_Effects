// A before/after reveal template. Pick a "before" and an "after" image; the
// backend fills the frame with the before, lays the after on top behind a hard
// wipe, and sweeps a divider bar across so the before is pushed out to one side
// while the after replaces it. Choose the sweep orientation and total length.
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** A single labelled image slot with a pick / replace button. */
function ImageSlot({
  title,
  hint,
  path,
  setPath,
}: {
  title: string;
  hint: string;
  path: string | null;
  setPath: (p: string | null) => void;
}) {
  const pick = async () => {
    const sel = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    });
    if (typeof sel === "string") setPath(sel);
  };
  return (
    <div className="insp-field" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
      <div className="row2" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <b>{title}</b>
        <button className="insp-btn" onClick={pick}>
          {path ? "Replace…" : "＋ Choose…"}
        </button>
      </div>
      <span className="muted" style={{ fontSize: 11 }}>{hint}</span>
      {path && (
        <div className="tmpl-list" style={{ marginTop: 4 }}>
          <div className="tmpl-row">
            <span className="tmpl-name" title={path}>{baseName(path)}</span>
            <button className="tmpl-mini" title="Remove" onClick={() => setPath(null)}>
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function BeforeAfterDialog({
  onCreate,
  onClose,
}: {
  onCreate: (
    before: string,
    after: string,
    orientation: string,
    totalMs: number
  ) => void | Promise<void>;
  onClose: () => void;
}) {
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<"horizontal" | "vertical">("horizontal");
  const [seconds, setSeconds] = useState(6);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCreate = !!before && !!after && !busy;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Template · Before / After</div>
        <div className="modal-body">
          <p className="insp-hint">
            The <b>before</b> image fills the frame, then a divider bar sweeps across —
            pushing it out to one side while the <b>after</b> image replaces it. Great for
            edit comparisons.
          </p>

          <ImageSlot
            title="Before"
            hint="Shown first, full frame."
            path={before}
            setPath={setBefore}
          />
          <ImageSlot
            title="After"
            hint="Revealed by the sweeping divider."
            path={after}
            setPath={setAfter}
          />

          <div className="insp-field" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
            <b>Sweep</b>
            <div className="row2" style={{ gap: 6, marginTop: 4 }}>
              <button
                className={"insp-btn" + (orientation === "horizontal" ? " active" : "")}
                onClick={() => setOrientation("horizontal")}
              >
                Horizontal ↔
              </button>
              <button
                className={"insp-btn" + (orientation === "vertical" ? " active" : "")}
                onClick={() => setOrientation("vertical")}
              >
                Vertical ↕
              </button>
            </div>
          </div>

          <label className="insp-field" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
            <span className="row2" style={{ justifyContent: "space-between" }}>
              <span>Total length</span>
              <span className="row2" style={{ gap: 4, alignItems: "center" }}>
                <input
                  className="an-num-box"
                  type="number"
                  min={2}
                  step={1}
                  value={seconds}
                  onChange={(e) => e.target.value !== "" && setSeconds(Math.max(2, Number(e.target.value)))}
                />
                <span className="muted">s</span>
              </span>
            </span>
          </label>

          <p className="insp-hint">
            Everything is added as editable layers — the divider bar and the wipe's timing
            can be tweaked afterwards.
          </p>
          {!canCreate && !busy && (
            <p className="insp-hint">Choose a before and an after image to continue.</p>
          )}
          {error && <p className="insp-hint" style={{ color: "#e06a5c" }}>{error}</p>}
        </div>
        <div className="modal-actions">
          <button className="insp-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="insp-btn active"
            disabled={!canCreate}
            onClick={async () => {
              if (!before || !after) return;
              setBusy(true);
              setError(null);
              try {
                await onCreate(before, after, orientation, Math.round(seconds * 1000));
                onClose();
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Building…" : "Create video"}
          </button>
        </div>
      </div>
    </div>
  );
}
