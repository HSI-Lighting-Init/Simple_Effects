// A "mixed" video-template builder: the video opens with plain Ken-Burns slides,
// transitions into one or two feature segments (cylinder carousel / rotating cube
// / assembling grid), then back out to plain slides. The user fills a SEPARATE
// bucket of images for each part — plain slides, and each feature — so they have
// full control over which images go where, and the video is a coherent mix.
import { useState, type Dispatch, type SetStateAction } from "react";
import { open } from "@tauri-apps/plugin-dialog";

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function kindLabel(kind: string): string {
  return kind === "box" ? "Cube" : kind === "grid" ? "Grid" : "Carousel";
}

export const MIXED_TEMPLATES: { id: string; label: string; kindA: string; kindB: string; blurb: string }[] = [
  { id: "carousel", label: "Carousel showcase", kindA: "cylinder", kindB: "", blurb: "Plain slides ease in, transition into a spinning cylinder carousel, then back out to plain slides." },
  { id: "box", label: "Cube showcase", kindA: "box", kindB: "", blurb: "Plain slides transition into a rotating cube, then back to plain slides." },
  { id: "grid", label: "Grid showcase", kindA: "grid", kindB: "", blurb: "Plain slides transition into an assembling photo grid, then back to plain slides." },
  { id: "cyl-grid", label: "Carousel + Grid", kindA: "cylinder", kindB: "grid", blurb: "Plain → cylinder carousel → photo grid → plain, all cross-fading." },
  { id: "grid-box", label: "Grid + Cube", kindA: "grid", kindB: "box", blurb: "Plain → photo grid → rotating cube → plain, all cross-fading." },
];

/** One labelled bucket of images with its own add / reorder / remove controls. */
function ImageBucket({
  title,
  hint,
  images,
  setImages,
}: {
  title: string;
  hint: string;
  images: string[];
  setImages: Dispatch<SetStateAction<string[]>>;
}) {
  const add = async () => {
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
      const n = prev.slice();
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  return (
    <div className="insp-field" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
      <div className="row2" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <b>{title}</b>
        <button className="insp-btn" onClick={add}>
          ＋ Add
        </button>
      </div>
      <span className="muted" style={{ fontSize: 11 }}>{hint}</span>
      {images.length > 0 && (
        <div className="tmpl-list" style={{ marginTop: 4 }}>
          {images.map((p, i) => (
            <div className="tmpl-row" key={`${p}-${i}`}>
              <span className="tmpl-idx">{i + 1}</span>
              <span className="tmpl-name" title={p}>
                {baseName(p)}
              </span>
              <button className="tmpl-mini" title="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                ▲
              </button>
              <button className="tmpl-mini" title="Move down" onClick={() => move(i, 1)} disabled={i === images.length - 1}>
                ▼
              </button>
              <button className="tmpl-mini" title="Remove" onClick={() => removeAt(i)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MixedTemplateDialog({
  templateId,
  onCreate,
  onClose,
}: {
  templateId: string;
  onCreate: (
    plain: string[],
    featureA: string[],
    featureB: string[],
    kindA: string,
    kindB: string,
    totalMs: number
  ) => void | Promise<void>;
  onClose: () => void;
}) {
  const meta = MIXED_TEMPLATES.find((t) => t.id === templateId) ?? MIXED_TEMPLATES[0];
  const hasB = meta.kindB !== "";
  const [plain, setPlain] = useState<string[]>([]);
  const [featureA, setFeatureA] = useState<string[]>([]);
  const [featureB, setFeatureB] = useState<string[]>([]);
  const [seconds, setSeconds] = useState(35);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = plain.length + featureA.length + featureB.length;
  const canCreate = featureA.length >= 1 && (!hasB || featureB.length >= 1) && !busy;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Template · {meta.label}</div>
        <div className="modal-body">
          <p className="insp-hint">{meta.blurb}</p>
          <p className="insp-hint">
            Add images to each part below. The <b>plain slides</b> play as a Ken-Burns
            slideshow (split into an intro before the feature{hasB ? "s" : ""} and an outro
            after); the <b>{kindLabel(meta.kindA).toLowerCase()}{hasB ? ` and ${kindLabel(meta.kindB).toLowerCase()}` : ""}</b> images
            go into that segment. Order matters within each part.
          </p>

          <ImageBucket
            title="Plain slides"
            hint="Shown as a slideshow before and after the feature — leave empty for feature only."
            images={plain}
            setImages={setPlain}
          />
          <ImageBucket
            title={`${kindLabel(meta.kindA)} images`}
            hint={`These wrap into the ${kindLabel(meta.kindA).toLowerCase()} segment.`}
            images={featureA}
            setImages={setFeatureA}
          />
          {hasB && (
            <ImageBucket
              title={`${kindLabel(meta.kindB)} images`}
              hint={`These go into the ${kindLabel(meta.kindB).toLowerCase()} segment.`}
              images={featureB}
              setImages={setFeatureB}
            />
          )}

          <label className="insp-field" style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
            <span className="row2" style={{ justifyContent: "space-between" }}>
              <span>Total length ({total} image{total === 1 ? "" : "s"})</span>
              <span className="row2" style={{ gap: 4, alignItems: "center" }}>
                <input
                  className="an-num-box"
                  type="number"
                  min={6}
                  step={1}
                  value={seconds}
                  onChange={(e) => e.target.value !== "" && setSeconds(Math.max(6, Number(e.target.value)))}
                />
                <span className="muted">s</span>
              </span>
            </span>
          </label>

          <p className="insp-hint">
            Each slide gets a bottom-right "text here" caption you can edit afterwards.
            Everything is added as editable layers.
          </p>
          {!canCreate && !busy && (
            <p className="insp-hint">
              Add at least one {kindLabel(meta.kindA).toLowerCase()} image
              {hasB ? ` and one ${kindLabel(meta.kindB).toLowerCase()} image` : ""} to continue.
            </p>
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
              setBusy(true);
              setError(null);
              try {
                await onCreate(plain, featureA, featureB, meta.kindA, meta.kindB, Math.round(seconds * 1000));
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
