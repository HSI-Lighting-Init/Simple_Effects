// Right-hand inspector. For text layers it edits the content (Arabic/RTL aware),
// size, and the per-letter animation preset + timing. Other layers get a hint.
import { useEffect, useState } from "react";
import type { Layer } from "../bindings/Layer";
import type { LetterAnimation } from "../bindings/LetterAnimation";
import type { LetterPreset } from "../bindings/LetterPreset";

const PRESETS: { value: LetterPreset | "none"; label: string }[] = [
  { value: "none", label: "None (static)" },
  { value: "fadeIn", label: "Fade in" },
  { value: "scalePop", label: "Scale pop" },
  { value: "riseUp", label: "Rise up" },
  { value: "scatterIn", label: "Scatter in" },
  { value: "typewriter", label: "Typewriter" },
];

function TextInspector({
  layerId,
  content: content0,
  size: size0,
  anim,
  onContent,
  onAnim,
}: {
  layerId: number;
  content: string;
  size: number;
  anim: LetterAnimation | null;
  onContent: (layerId: number, content: string, size: number) => void;
  onAnim: (layerId: number, anim: LetterAnimation | null) => void;
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
        Font size
        <input
          type="number"
          min={8}
          max={400}
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          onBlur={commitContent}
        />
      </label>

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
          <p className="insp-hint">
            Scrub or press Play to see the letters animate in sequence.
          </p>
        </>
      )}
    </div>
  );
}

interface Props {
  layer: Layer | null;
  onContent: (layerId: number, content: string, size: number) => void;
  onAnim: (layerId: number, anim: LetterAnimation | null) => void;
}

export default function Inspector({ layer, onContent, onAnim }: Props) {
  return (
    <aside className="inspector">
      <div className="panel-title">{layer ? layer.name : "Inspector"}</div>
      {!layer && <span className="muted">Select a layer to edit it.</span>}
      {layer && layer.kind.kind === "text" && (
        <TextInspector
          layerId={layer.id}
          content={layer.kind.content}
          size={layer.kind.size}
          anim={layer.kind.anim}
          onContent={onContent}
          onAnim={onAnim}
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
