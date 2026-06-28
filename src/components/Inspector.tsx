// Right-hand inspector. For text layers it edits content (Arabic/RTL aware),
// font, colour, size (height), and the per-letter animation preset + timing.
import { useEffect, useState } from "react";
import type { Layer } from "../bindings/Layer";
import type { LetterAnimation } from "../bindings/LetterAnimation";
import type { LetterPreset } from "../bindings/LetterPreset";
import type { Font } from "../bindings/Font";
import type { Rgba } from "../bindings/Rgba";

const PRESETS: { value: LetterPreset | "none"; label: string }[] = [
  { value: "none", label: "None (static)" },
  { value: "fadeIn", label: "Fade in" },
  { value: "scalePop", label: "Scale pop" },
  { value: "riseUp", label: "Rise up" },
  { value: "scatterIn", label: "Explode / gather (scatter)" },
  { value: "typewriter", label: "Typewriter" },
];

const FONTS: { value: Font; label: string }[] = [
  { value: "vazirmatn", label: "Vazirmatn" },
  { value: "sahel", label: "Sahel" },
  { value: "shabnam", label: "Shabnam" },
  { value: "gandom", label: "Gandom (bold)" },
];

function rgbToHex(c: Rgba): string {
  const h = (n: number) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
function hexToRgb(hex: string): Rgba {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return { r: 255, g: 255, b: 255, a: 255 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a: 255 };
}

function TextInspector({
  layerId,
  content: content0,
  size: size0,
  color,
  font,
  anim,
  decomposed,
  onContent,
  onColor,
  onFont,
  onAnim,
  onToggleDecompose,
  onClearParts,
  onDecomposeKey,
}: {
  layerId: number;
  content: string;
  size: number;
  color: Rgba;
  font: Font;
  anim: LetterAnimation | null;
  decomposed: boolean;
  onContent: (layerId: number, content: string, size: number) => void;
  onColor: (layerId: number, color: Rgba) => void;
  onFont: (layerId: number, font: Font) => void;
  onAnim: (layerId: number, anim: LetterAnimation | null) => void;
  onToggleDecompose: (layerId: number) => void;
  onClearParts: (layerId: number) => void;
  onDecomposeKey: (layerId: number, value: number) => void;
}) {
  const [content, setContent] = useState(content0);
  const [size, setSize] = useState(size0);
  useEffect(() => {
    setContent(content0);
    setSize(size0);
  }, [layerId, content0, size0]);

  const preset: LetterPreset | "none" = anim?.preset ?? "none";

  const commitContent = () => {
    if (content !== content0 || size !== size0) onContent(layerId, content, size);
  };

  const pickPreset = (p: LetterPreset | "none") => {
    if (p === "none") return onAnim(layerId, null);
    onAnim(layerId, {
      preset: p,
      startMs: anim?.startMs ?? 200,
      durationMs: anim?.durationMs ?? 700,
      staggerMs: anim?.staggerMs ?? 70,
      areaPx: anim?.areaPx ?? 500,
    });
  };

  const setTiming = (patch: Partial<LetterAnimation>) => {
    if (anim) onAnim(layerId, { ...anim, ...patch });
  };

  return (
    <div className="insp-body">
      <label className="insp-field">
        Text
        <textarea
          className="insp-text"
          dir="auto"
          rows={2}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onBlur={commitContent}
        />
      </label>

      <label className="insp-field">
        Font
        <select value={font} onChange={(e) => onFont(layerId, e.target.value as Font)}>
          {FONTS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </label>

      <div className="row2">
        <label className="insp-field">
          Size (height)
          <input
            type="number"
            min={8}
            max={400}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            onBlur={commitContent}
          />
        </label>
        <label className="insp-field">
          Colour
          <input
            type="color"
            className="insp-color"
            value={rgbToHex(color)}
            onChange={(e) => onColor(layerId, hexToRgb(e.target.value))}
          />
        </label>
      </div>

      <div className="insp-sep">Per-letter effect</div>
      <label className="insp-field">
        Preset
        <select value={preset} onChange={(e) => pickPreset(e.target.value as LetterPreset | "none")}>
          {PRESETS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      {anim && (
        <>
          {anim.preset === "scatterIn" && (
            <label className="insp-field">
              Explode area (px radius)
              <input
                type="number"
                min={0}
                max={4000}
                step={20}
                value={Math.round(anim.areaPx)}
                onChange={(e) => setTiming({ areaPx: Number(e.target.value) })}
              />
            </label>
          )}
          <label className="insp-field">
            Start (ms)
            <input
              type="number"
              min={0}
              value={anim.startMs}
              onChange={(e) => setTiming({ startMs: Number(e.target.value) })}
            />
          </label>
          <label className="insp-field">
            Letter duration (ms)
            <input
              type="number"
              min={1}
              value={anim.durationMs}
              onChange={(e) => setTiming({ durationMs: Number(e.target.value) })}
            />
          </label>
          <label className="insp-field">
            Stagger per letter (ms)
            <input
              type="number"
              min={0}
              value={anim.staggerMs}
              onChange={(e) => setTiming({ staggerMs: Number(e.target.value) })}
            />
          </label>
          <p className="insp-hint">Scrub or press Play to see the letters animate.</p>
        </>
      )}

      <div className="insp-sep">Decompose (per-letter)</div>
      <button
        className={"insp-btn" + (decomposed ? " active" : "")}
        onClick={() => onToggleDecompose(layerId)}
      >
        {decomposed ? "● Decomposing — done" : "Decompose letters"}
      </button>
      {decomposed && (
        <>
          <p className="insp-hint">
            Click a letter, then drag to move and use the handles to rotate/scale. Esc exits.
          </p>
          <p className="insp-hint">
            Animate it: move the playhead and key <b>Composed</b> where the letters should be
            together, <b>Decomposed</b> where they're apart — it transitions between.
          </p>
          <div className="row2">
            <button className="insp-btn" onClick={() => onDecomposeKey(layerId, 0)}>
              ◆ Composed
            </button>
            <button className="insp-btn" onClick={() => onDecomposeKey(layerId, 1)}>
              ◆ Decomposed
            </button>
          </div>
          <button className="insp-btn" onClick={() => onClearParts(layerId)}>
            Reset letters
          </button>
        </>
      )}
    </div>
  );
}

interface Props {
  layer: Layer | null;
  decomposed: boolean;
  onContent: (layerId: number, content: string, size: number) => void;
  onColor: (layerId: number, color: Rgba) => void;
  onFont: (layerId: number, font: Font) => void;
  onAnim: (layerId: number, anim: LetterAnimation | null) => void;
  onToggleDecompose: (layerId: number) => void;
  onClearParts: (layerId: number) => void;
  onDecomposeKey: (layerId: number, value: number) => void;
}

export default function Inspector({
  layer,
  decomposed,
  onContent,
  onColor,
  onFont,
  onAnim,
  onToggleDecompose,
  onClearParts,
  onDecomposeKey,
}: Props) {
  return (
    <aside className="inspector">
      <div className="panel-title">{layer ? layer.name : "Inspector"}</div>
      {!layer && <span className="muted">Select a layer to edit it.</span>}
      {layer && layer.kind.kind === "text" && (
        <TextInspector
          layerId={layer.id}
          content={layer.kind.content}
          size={layer.kind.size}
          color={layer.kind.color}
          font={layer.kind.font}
          anim={layer.kind.anim}
          decomposed={decomposed}
          onContent={onContent}
          onColor={onColor}
          onFont={onFont}
          onAnim={onAnim}
          onToggleDecompose={onToggleDecompose}
          onClearParts={onClearParts}
          onDecomposeKey={onDecomposeKey}
        />
      )}
      {layer && layer.kind.kind !== "text" && (
        <span className="muted">
          {layer.kind.kind} layer — drag on the canvas to move/scale, ◆ Key to set a keyframe.
        </span>
      )}
    </aside>
  );
}
