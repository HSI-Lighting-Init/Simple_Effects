// "New Template" — the cylinder carousel builder. Pick a set of images, choose
// how long each is held and how fast it snaps to the next, optionally fade them
// in/out, and the app assembles a rotating cylinder with the images wrapped
// evenly around it (snapping between them, looping seamlessly).
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export default function TemplateDialog({
  onCreate,
  onClose,
}: {
  onCreate: (images: string[], pauseMs: number, rotateMs: number, transition: string | null) => void;
  onClose: () => void;
}) {
  const [images, setImages] = useState<string[]>([]);
  const [pauseMs, setPauseMs] = useState(1200); // hold on each image
  const [rotateMs, setRotateMs] = useState(600); // snap time between images
  const [fade, setFade] = useState(true);
  const [busy, setBusy] = useState(false);

  const addImages = async () => {
    const sel = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    });
    if (!sel) return;
    const paths = Array.isArray(sel) ? sel : [sel];
    setImages((prev) => [...prev, ...paths]);
  };

  const removeAt = (i: number) => setImages((prev) => prev.filter((_, j) => j !== i));
  const move = (i: number, dir: -1 | 1) =>
    setImages((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const n = images.length;
  const cycle = pauseMs + rotateMs;
  const loopSec = (n * cycle) / 1000;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">New template · Cylinder carousel</div>
        <div className="modal-body">
          <p className="insp-hint">
            Images wrap evenly around a rotating cylinder. It snaps to each image,
            holds, then rotates to the next — looping seamlessly.
          </p>

          <div className="insp-field">
            <div className="row2">
              <button className="insp-btn" onClick={addImages}>
                ＋ Add images…
              </button>
              <span className="muted" style={{ alignSelf: "center" }}>
                {n} image{n === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          {n > 0 && (
            <div className="tmpl-list">
              {images.map((p, i) => (
                <div className="tmpl-row" key={`${p}-${i}`}>
                  <span className="tmpl-idx">{i + 1}</span>
                  <span className="tmpl-name" title={p}>
                    {baseName(p)}
                  </span>
                  <button className="tmpl-mini" title="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                    ▲
                  </button>
                  <button className="tmpl-mini" title="Move down" onClick={() => move(i, 1)} disabled={i === n - 1}>
                    ▼
                  </button>
                  <button className="tmpl-mini" title="Remove" onClick={() => removeAt(i)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <label className="insp-field">
            <span className="row2" style={{ justifyContent: "space-between" }}>
              <span>Hold on each image</span>
              <span className="row2" style={{ gap: 4, alignItems: "center" }}>
                <input
                  className="an-num-box"
                  type="number"
                  min={0}
                  step={0.1}
                  value={Math.round(pauseMs / 10) / 100}
                  onChange={(e) => e.target.value !== "" && setPauseMs(Math.max(0, Number(e.target.value) * 1000))}
                />
                <span className="muted">s</span>
              </span>
            </span>
            <input type="range" min={0} max={Math.max(5000, pauseMs)} step={50} value={pauseMs} onChange={(e) => setPauseMs(Number(e.target.value))} />
          </label>
          <label className="insp-field">
            <span className="row2" style={{ justifyContent: "space-between" }}>
              <span>Snap time (rotate to next)</span>
              <span className="row2" style={{ gap: 4, alignItems: "center" }}>
                <input
                  className="an-num-box"
                  type="number"
                  min={0.05}
                  step={0.1}
                  value={Math.round(rotateMs / 10) / 100}
                  onChange={(e) => e.target.value !== "" && setRotateMs(Math.max(50, Number(e.target.value) * 1000))}
                />
                <span className="muted">s</span>
              </span>
            </span>
            <input type="range" min={100} max={Math.max(3000, rotateMs)} step={50} value={rotateMs} onChange={(e) => setRotateMs(Number(e.target.value))} />
          </label>

          <label className="surf-face">
            <input type="checkbox" checked={fade} onChange={(e) => setFade(e.target.checked)} />
            Fade each image in / out
          </label>

          {n > 0 && (
            <p className="insp-hint">
              Full loop ≈ {loopSec.toFixed(1)}s ({n} × {(cycle / 1000).toFixed(2)}s). The comp is
              extended to fit if needed.
            </p>
          )}
        </div>
        <div className="modal-actions">
          <button className="insp-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="insp-btn active"
            disabled={n === 0 || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onCreate(images, pauseMs, rotateMs, fade ? "fade" : null);
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Building…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
