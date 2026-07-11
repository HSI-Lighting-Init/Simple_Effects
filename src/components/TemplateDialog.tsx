// "New Template" — the template builder. Pick a template type (rotating cylinder
// carousel, rotating cube carousel, or an assembling photo grid), add a set of
// images, tune the timing, and the app assembles it. The backend owns the actual
// layer/keyframe construction; this dialog just gathers the inputs.
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** What the dialog emits — a discriminated spec the parent dispatches to the
 *  matching backend command. */
export type TemplateSpec =
  | { kind: "cylinder"; images: string[]; pauseMs: number; rotateMs: number; transition: string | null }
  | { kind: "box"; images: string[]; pauseMs: number; rotateMs: number; transition: string | null }
  | { kind: "grid"; images: string[]; staggerMs: number; fadeMs: number; holdMs: number; fadeOut: boolean }
  | { kind: "gridcall"; images: string[]; holdMs: number; shrinkMs: number; bounceMs: number; finalHoldMs: number };

type Kind = TemplateSpec["kind"];

// A number box that edits a millisecond value as seconds, accepting any value the
// user types (no upper bound) — clamped only to a small floor.
function SecondsField({
  label,
  ms,
  min,
  onChange,
}: {
  label: string;
  ms: number;
  min: number;
  onChange: (ms: number) => void;
}) {
  return (
    <label className="insp-field">
      <span className="row2" style={{ justifyContent: "space-between" }}>
        <span>{label}</span>
        <span className="row2" style={{ gap: 4, alignItems: "center" }}>
          <input
            className="an-num-box"
            type="number"
            min={min / 1000}
            step={0.1}
            value={Math.round(ms / 10) / 100}
            onChange={(e) => e.target.value !== "" && onChange(Math.max(min, Number(e.target.value) * 1000))}
          />
          <span className="muted">s</span>
        </span>
      </span>
    </label>
  );
}

export default function TemplateDialog({
  onCreate,
  onClose,
}: {
  onCreate: (spec: TemplateSpec) => void | Promise<void>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<Kind>("cylinder");
  const [images, setImages] = useState<string[]>([]);
  // Carousel (cylinder / cube) timing.
  const [pauseMs, setPauseMs] = useState(1200); // hold on each image
  const [rotateMs, setRotateMs] = useState(600); // snap / rotate time
  const [fade, setFade] = useState(true);
  // Grid timing.
  const [staggerMs, setStaggerMs] = useState(200); // gap between each image landing
  const [gridFadeMs, setGridFadeMs] = useState(500); // per-image fade duration
  const [holdMs, setHoldMs] = useState(2000); // how long the finished wall holds
  const [gridFadeOut, setGridFadeOut] = useState(false);
  // Grid-call timing.
  const [gcHoldMs, setGcHoldMs] = useState(700); // big-at-centre hold per image
  const [gcShrinkMs, setGcShrinkMs] = useState(500); // shrink-and-slide to cell
  const [gcBounceMs, setGcBounceMs] = useState(300); // closing zoom-out / back, each way
  const [gcFinalMs, setGcFinalMs] = useState(1500); // hold after the bounce
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
  const isCarousel = kind === "cylinder" || kind === "box";

  // Duration estimate per template.
  let estimate = "";
  if (n > 0) {
    if (kind === "cylinder") {
      const loop = (n * (pauseMs + rotateMs)) / 1000;
      estimate = `Full loop ≈ ${loop.toFixed(1)}s (${n} × ${((pauseMs + rotateMs) / 1000).toFixed(2)}s), seamless.`;
    } else if (kind === "box") {
      const dur = ((n - 1) * (pauseMs + rotateMs) + pauseMs) / 1000;
      estimate = `Runs ≈ ${dur.toFixed(1)}s. Cube flips through ${n} face${n === 1 ? "" : "s"} and holds on the last.`;
    } else if (kind === "grid") {
      const dur = ((n - 1) * staggerMs + gridFadeMs + holdMs + (gridFadeOut ? gridFadeMs : 0)) / 1000;
      const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      const rows = Math.ceil(n / cols);
      estimate = `${cols}×${rows} grid, ≈ ${dur.toFixed(1)}s to assemble${gridFadeOut ? " and break out" : ""}.`;
    } else {
      const dur = (n * (gcHoldMs + gcShrinkMs) + 2 * gcBounceMs + gcFinalMs) / 1000;
      const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      const rows = Math.ceil(n / cols);
      estimate = `${cols}×${rows} grid, built one image at a time ≈ ${dur.toFixed(1)}s, then a closing zoom.`;
    }
  }

  const submit = async () => {
    setBusy(true);
    try {
      if (kind === "grid") {
        await onCreate({ kind, images, staggerMs, fadeMs: gridFadeMs, holdMs, fadeOut: gridFadeOut });
      } else if (kind === "gridcall") {
        await onCreate({ kind, images, holdMs: gcHoldMs, shrinkMs: gcShrinkMs, bounceMs: gcBounceMs, finalHoldMs: gcFinalMs });
      } else {
        await onCreate({ kind, images, pauseMs, rotateMs, transition: fade ? "fade" : null });
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const TABS: { id: Kind; label: string; blurb: string }[] = [
    { id: "cylinder", label: "Cylinder carousel", blurb: "Images wrap around a rotating cylinder, snapping between them — loops seamlessly." },
    { id: "box", label: "Cube carousel", blurb: "Images sit on a cube's faces; it snaps 90° through them. Best as a multiple of 4 for a clean wrap." },
    { id: "grid", label: "Photo grid", blurb: "Images assemble into a centred grid, fading in one after another, then hold." },
    { id: "gridcall", label: "Grid call", blurb: "Each image appears large at the centre, then shrinks into its cell — one after another — building the grid. When it's complete the whole grid zooms out a little and springs back." },
  ];
  const active = TABS.find((t) => t.id === kind)!;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Image carousel</div>
        <div className="modal-body">
          <div className="tmpl-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={"insp-btn" + (kind === t.id ? " active" : "")}
                onClick={() => setKind(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="insp-hint">{active.blurb}</p>

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

          {isCarousel ? (
            <>
              <SecondsField label="Hold on each image" ms={pauseMs} min={0} onChange={setPauseMs} />
              <SecondsField label={kind === "box" ? "Flip time (rotate to next)" : "Snap time (rotate to next)"} ms={rotateMs} min={50} onChange={setRotateMs} />
              <label className="surf-face">
                <input type="checkbox" checked={fade} onChange={(e) => setFade(e.target.checked)} />
                {kind === "box" ? "Fade the cube in / out" : "Fade each image in / out"}
              </label>
            </>
          ) : kind === "grid" ? (
            <>
              <SecondsField label="Stagger (gap between each landing)" ms={staggerMs} min={0} onChange={setStaggerMs} />
              <SecondsField label="Fade-in duration (each image)" ms={gridFadeMs} min={0} onChange={setGridFadeMs} />
              <SecondsField label="Hold after assembled" ms={holdMs} min={0} onChange={setHoldMs} />
              <label className="surf-face">
                <input type="checkbox" checked={gridFadeOut} onChange={(e) => setGridFadeOut(e.target.checked)} />
                Break out (fade the wall away at the end)
              </label>
            </>
          ) : (
            <>
              <SecondsField label="Hold each image large (centre)" ms={gcHoldMs} min={0} onChange={setGcHoldMs} />
              <SecondsField label="Shrink into cell" ms={gcShrinkMs} min={50} onChange={setGcShrinkMs} />
              <SecondsField label="Closing zoom (each way, 0 = off)" ms={gcBounceMs} min={0} onChange={setGcBounceMs} />
              <SecondsField label="Hold at the end" ms={gcFinalMs} min={0} onChange={setGcFinalMs} />
            </>
          )}

          {estimate && <p className="insp-hint">{estimate} The comp is extended to fit if needed.</p>}
        </div>
        <div className="modal-actions">
          <button className="insp-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="insp-btn active" disabled={n === 0 || busy} onClick={submit}>
            {busy ? "Building…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
