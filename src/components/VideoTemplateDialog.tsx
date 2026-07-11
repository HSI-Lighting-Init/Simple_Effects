// A full-video slideshow template builder. The Templates menu picks a style and
// opens this; the user adds their images (aim for ~10), optionally types a
// caption per slide, sets the length, and the app assembles a complete video —
// images sequenced with the style's transitions + Ken Burns motion, a coherent
// colour grade, and captions that fade / slide in and out on each slide.
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export const VIDEO_STYLES: { id: string; label: string; blurb: string }[] = [
  { id: "cinematic", label: "Cinematic", blurb: "Slow cross-dissolves and gentle Ken Burns zoom, a warm rich grade, and elegant lower-third captions that rise in." },
  { id: "dynamic", label: "Dynamic", blurb: "Punchy slide / zoom / wipe / whip-pan transitions that cycle per slide, with bold centred captions that slide in." },
  { id: "energetic", label: "Energetic", blurb: "Fast glitch / zoom / shatter cuts with a punchy contrasty grade and bold captions that pop up." },
  { id: "elegant", label: "Elegant", blurb: "Minimal slow fades and a soft muted grade, with light centred captions that fade gently." },
];

export default function VideoTemplateDialog({
  style,
  onCreate,
  onClose,
}: {
  style: string;
  onCreate: (images: string[], captions: string[], style: string, totalMs: number) => void | Promise<void>;
  onClose: () => void;
}) {
  const meta = VIDEO_STYLES.find((s) => s.id === style) ?? VIDEO_STYLES[0];
  const [images, setImages] = useState<string[]>([]);
  const [captions, setCaptions] = useState<string[]>([]);
  const [seconds, setSeconds] = useState(35);
  const [busy, setBusy] = useState(false);

  const addImages = async () => {
    const sel = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    });
    if (!sel) return;
    const paths = Array.isArray(sel) ? sel : [sel];
    setImages((prev) => [...prev, ...paths]);
    setCaptions((prev) => [...prev, ...paths.map(() => "")]);
  };

  const removeAt = (i: number) => {
    setImages((prev) => prev.filter((_, j) => j !== i));
    setCaptions((prev) => prev.filter((_, j) => j !== i));
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= images.length) return;
    setImages((prev) => {
      const n = prev.slice();
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
    setCaptions((prev) => {
      const n = prev.slice();
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  };
  const setCaption = (i: number, v: string) =>
    setCaptions((prev) => prev.map((c, j) => (j === i ? v : c)));

  const n = images.length;
  const per = n > 0 ? seconds / n : 0;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Template · {meta.label} video</div>
        <div className="modal-body">
          <p className="insp-hint">{meta.blurb}</p>

          <div className="insp-field">
            <div className="row2">
              <button className="insp-btn" onClick={addImages}>
                ＋ Add images…
              </button>
              <span className="muted" style={{ alignSelf: "center" }}>
                {n} image{n === 1 ? "" : "s"}
                {n > 0 ? ` · ~${per.toFixed(1)}s each` : " — aim for ~10"}
              </span>
            </div>
          </div>

          {n > 0 && (
            <div className="tmpl-list">
              {images.map((p, i) => (
                <div className="tmpl-row" key={`${p}-${i}`}>
                  <span className="tmpl-idx">{i + 1}</span>
                  <input
                    className="tmpl-caption"
                    type="text"
                    placeholder={`Caption for ${baseName(p)} (optional)`}
                    value={captions[i] ?? ""}
                    onChange={(e) => setCaption(i, e.target.value)}
                    title={p}
                  />
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
              <span>Total length</span>
              <span className="row2" style={{ gap: 4, alignItems: "center" }}>
                <input
                  className="an-num-box"
                  type="number"
                  min={4}
                  step={1}
                  value={seconds}
                  onChange={(e) => e.target.value !== "" && setSeconds(Math.max(4, Number(e.target.value)))}
                />
                <span className="muted">s</span>
              </span>
            </span>
          </label>

          <p className="insp-hint">
            Captions are optional — leave one blank to show that slide with no text.
            The images, transitions and captions are added as editable layers, so you
            can tweak anything afterwards.
          </p>
        </div>
        <div className="modal-actions">
          <button className="insp-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="insp-btn active"
            disabled={n < 2 || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onCreate(images, captions, style, Math.round(seconds * 1000));
                onClose();
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
