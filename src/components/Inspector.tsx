// Right-hand inspector. For text layers it edits content (Arabic/RTL aware),
// font, colour, size (height), and the per-letter animation preset + timing.
import { useEffect, useState, type ReactNode } from "react";
import type { Layer } from "../bindings/Layer";
import type { LetterAnimation } from "../bindings/LetterAnimation";
import type { LetterPreset } from "../bindings/LetterPreset";
import type { Font } from "../bindings/Font";
import type { Rgba } from "../bindings/Rgba";
import type { SurfaceShape } from "../bindings/SurfaceShape";
import type { Decal } from "../bindings/Decal";
import type { ResolvedEffect } from "../bindings/ResolvedEffect";

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

const FACE_LABELS = ["Front", "Back", "Left", "Right", "Top", "Bottom"];

export interface ShapeParams {
  width: number;
  height: number;
  depth: number;
  perspective: number;
  focalLength: number;
  coverage: number;
  radius: number;
}

interface ShapeRef {
  id: number;
  name: string;
  shape: SurfaceShape;
}

// Controls for a Shape3D object: keyframeable 3D rotation (the spin), camera,
// and dimensions. Rotations key the playhead (set_shape_rotation_key); the rest
// is a single set_shape_params call.
function ShapeInspector({
  layerId,
  shape,
  params,
  angles,
  onShapeParams,
  onShapeRotKey,
}: {
  layerId: number;
  shape: SurfaceShape;
  params: ShapeParams;
  angles: { x: number; y: number; z: number } | null;
  onShapeParams: (layerId: number, p: ShapeParams) => void;
  onShapeRotKey: (
    layerId: number,
    axis: "x" | "y" | "z",
    value: number,
    seedStart: boolean
  ) => void;
}) {
  const set = (p: Partial<ShapeParams>) => onShapeParams(layerId, { ...params, ...p });
  const a = angles ?? { x: 0, y: 0, z: 0 };
  const rotRow = (label: string, axis: "x" | "y" | "z", value: number) => (
    <div className="insp-field">
      <div className="surf-rot-head">
        <span>{label}</span>
        <span className="muted">{Math.round(value)}°</span>
        <button
          className="insp-btn tiny"
          title="Spin in from 0° (keyframe from the layer start to here)"
          onClick={() => onShapeRotKey(layerId, axis, value || 90, true)}
        >
          ◆ spin
        </button>
      </div>
      <input
        type="range"
        min={-180}
        max={180}
        step={1}
        value={value}
        onChange={(e) => onShapeRotKey(layerId, axis, Number(e.target.value), false)}
      />
    </div>
  );

  return (
    <div className="insp-body">
      <div className="insp-sep">{shape === "box" ? "Box" : "Cylinder"} — 3D object</div>
      <p className="insp-hint">
        Move / scale / rotate it on the canvas like any layer. Add images, then
        pin each to this shape from the image's inspector.
      </p>

      <div className="insp-sep">Rotation (keyframe to spin)</div>
      {rotRow("X — tilt", "x", a.x)}
      {rotRow("Y — turn", "y", a.y)}
      {rotRow("Z — roll", "z", a.z)}
      <p className="insp-hint">
        Drag a rotation, move the playhead, drag again → it spins between. Or
        press <b>◆ spin</b> to animate from 0° at the layer start to here.
      </p>

      <div className="insp-sep">Camera</div>
      <label className="insp-field">
        Perspective {params.perspective.toFixed(2)}
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={params.perspective}
          onChange={(e) => set({ perspective: Number(e.target.value) })}
        />
      </label>
      <label className="insp-field">
        Focal length
        <input
          type="number"
          min={100}
          max={5000}
          step={50}
          value={Math.round(params.focalLength)}
          onChange={(e) => set({ focalLength: Number(e.target.value) })}
        />
      </label>

      <div className="insp-sep">Size</div>
      <div className="row2">
        <label className="insp-field">
          Width
          <input
            type="number"
            min={1}
            value={Math.round(params.width)}
            onChange={(e) => set({ width: Number(e.target.value) })}
          />
        </label>
        <label className="insp-field">
          Height
          <input
            type="number"
            min={1}
            value={Math.round(params.height)}
            onChange={(e) => set({ height: Number(e.target.value) })}
          />
        </label>
      </div>
      {shape === "box" ? (
        <label className="insp-field">
          Depth
          <input
            type="number"
            min={0}
            value={Math.round(params.depth)}
            onChange={(e) => set({ depth: Number(e.target.value) })}
          />
        </label>
      ) : (
        <>
          <label className="insp-field">
            Radius
            <input
              type="number"
              min={1}
              value={Math.round(params.radius)}
              onChange={(e) => set({ radius: Number(e.target.value) })}
            />
          </label>
          <label className="insp-field">
            Coverage {Math.round(params.coverage)}°
            <input
              type="range"
              min={10}
              max={360}
              step={5}
              value={params.coverage}
              onChange={(e) => set({ coverage: Number(e.target.value) })}
            />
          </label>
        </>
      )}
    </div>
  );
}

// Controls for a layer (image OR text) pinned to a 3D shape: choose the shape +
// face, and place it on the surface. Placement is keyframeable — the sliders key
// the value at the playhead, so moving the playhead and re-placing animates the
// decal across the surface (in-betweens filled automatically). The live values
// come from `placement` (sampled at the playhead by the evaluator).
function DecalControls({
  layerId,
  attach,
  placement,
  visible,
  shapes,
  onAttachToShape,
  onKeyDecal,
  onSetDecalFace,
  onRevealFace,
  onDecalKeyAll,
}: {
  layerId: number;
  attach: Decal | null;
  placement: { u: number; v: number; scale: number; rotation: number } | null;
  visible: boolean;
  shapes: ShapeRef[];
  onAttachToShape: (layerId: number, shapeId: number | null, face: number) => void;
  onKeyDecal: (
    layerId: number,
    prop: "u" | "v" | "scale" | "rotation",
    value: number,
    seedStart: boolean
  ) => void;
  onSetDecalFace: (layerId: number, face: number) => void;
  onRevealFace: (shapeId: number, face: number) => void;
  onDecalKeyAll: (layerId: number) => void;
}) {
  const parent = attach ? shapes.find((s) => s.id === attach.shapeId) ?? null : null;
  const isBox = parent?.shape === "box";
  const p = placement ?? { u: 0.5, v: 0.5, scale: 0.5, rotation: 0 };

  return (
    <div className="insp-body">
      <div className="insp-sep">On 3D surface</div>
      {shapes.length === 0 && (
        <p className="insp-hint">
          Add a Box or Cylinder, then pin this here — or right-click the shape →
          Insert — to map it onto the surface.
        </p>
      )}
      {shapes.length > 0 && (
        <label className="insp-field">
          Pin to shape
          <select
            value={attach ? String(attach.shapeId) : "none"}
            onChange={(e) => {
              const v = e.target.value;
              onAttachToShape(layerId, v === "none" ? null : Number(v), attach?.face ?? 0);
            }}
          >
            <option value="none">Flat (not pinned)</option>
            {shapes.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {attach && (
        <>
          {isBox && (
            <label className="insp-field">
              Face
              <select
                value={String(attach.face)}
                onChange={(e) => onSetDecalFace(layerId, Number(e.target.value))}
              >
                {FACE_LABELS.map((lbl, i) => (
                  <option key={lbl} value={String(i)}>
                    {lbl}
                  </option>
                ))}
              </select>
            </label>
          )}
          {isBox && (
            <button
              className="insp-btn"
              onClick={() => onRevealFace(attach.shapeId, attach.face)}
            >
              ⟳ Turn box to this face
            </button>
          )}
          {isBox && !visible && (
            <p className="insp-hint">
              This face ({FACE_LABELS[attach.face] ?? attach.face}) is turned away
              from the camera, so it isn't drawn. Click “Turn box to this face”, or
              rotate the box, to bring it into view.
            </p>
          )}
          <p className="insp-hint">
            On the canvas: drag the round handle to move it, the square to size
            it. Move the playhead and re-place to animate — in-betweens are built
            for you.
          </p>
          <label className="insp-field">
            {isBox ? "Size" : "Height (wrap)"} {p.scale.toFixed(2)}
            <input
              type="range"
              min={0.05}
              max={4}
              step={0.01}
              value={p.scale}
              onChange={(e) => onKeyDecal(layerId, "scale", Number(e.target.value), false)}
            />
          </label>
          {isBox && (
            <label className="insp-field">
              Rotation {Math.round(p.rotation)}°
              <input
                type="range"
                min={-180}
                max={180}
                step={1}
                value={p.rotation}
                onChange={(e) => onKeyDecal(layerId, "rotation", Number(e.target.value), false)}
              />
            </label>
          )}
          <div className="row2">
            <label className="insp-field">
              Across (u) {p.u.toFixed(2)}
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={p.u}
                onChange={(e) => onKeyDecal(layerId, "u", Number(e.target.value), false)}
              />
            </label>
            <label className="insp-field">
              Down (v) {p.v.toFixed(2)}
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={p.v}
                onChange={(e) => onKeyDecal(layerId, "v", Number(e.target.value), false)}
              />
            </label>
          </div>
          <button className="insp-btn" onClick={() => onDecalKeyAll(layerId)}>
            ◆ Key placement here
          </button>
        </>
      )}
    </div>
  );
}

const EFFECT_TYPES: { kind: string; label: string }[] = [
  { kind: "grayscale", label: "Black & white" },
  { kind: "brightness", label: "Brightness" },
  { kind: "contrast", label: "Contrast" },
  { kind: "saturate", label: "Saturation" },
  { kind: "blur", label: "Blur" },
  { kind: "hue", label: "Hue shift" },
  { kind: "invert", label: "Invert" },
  { kind: "wipe", label: "Wipe / fade" },
];

type EffectParam = "amount" | "radius" | "degrees" | "position" | "softness";
type KeyEffect = (
  layerId: number,
  index: number,
  param: EffectParam,
  value: number,
  seedStart: boolean
) => void;
type SetWipeStatic = (layerId: number, index: number, angle: number, invert: boolean) => void;

function effSlider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void
) {
  return (
    <label className="insp-field">
      {label} {value.toFixed(2)}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

// One row of the effect stack — the controls vary by effect kind. Live values
// come from the sampled effect; the sliders key at the playhead so effects
// animate (e.g. a wipe's Position swept 0→1).
function EffectRow({
  layerId,
  index,
  eff,
  onRemove,
  onKey,
  onSetWipeStatic,
}: {
  layerId: number;
  index: number;
  eff: ResolvedEffect;
  onRemove: (layerId: number, index: number) => void;
  onKey: KeyEffect;
  onSetWipeStatic: SetWipeStatic;
}) {
  const label = EFFECT_TYPES.find((t) => t.kind === eff.kind)?.label ?? eff.kind;
  const key = (param: EffectParam, value: number) => onKey(layerId, index, param, value, false);
  let body: ReactNode = null;
  switch (eff.kind) {
    case "grayscale":
    case "invert":
      body = effSlider("Amount", eff.amount, 0, 1, 0.01, (v) => key("amount", v));
      break;
    case "brightness":
      body = effSlider("Brightness", eff.amount, 0, 3, 0.01, (v) => key("amount", v));
      break;
    case "contrast":
      body = effSlider("Contrast", eff.amount, 0, 3, 0.01, (v) => key("amount", v));
      break;
    case "saturate":
      body = effSlider("Saturation", eff.amount, 0, 3, 0.01, (v) => key("amount", v));
      break;
    case "blur":
      body = effSlider("Radius (px)", eff.radius, 0, 50, 0.5, (v) => key("radius", v));
      break;
    case "hue":
      body = effSlider("Degrees", eff.degrees, 0, 360, 1, (v) => key("degrees", v));
      break;
    case "wipe":
      body = (
        <>
          {effSlider("Position", eff.position, 0, 1, 0.01, (v) => key("position", v))}
          {effSlider("Softness", eff.softness, 0, 1, 0.01, (v) => key("softness", v))}
          {effSlider("Angle", eff.angle, 0, 360, 1, (v) =>
            onSetWipeStatic(layerId, index, v, eff.invert)
          )}
          <label className="surf-face">
            <input
              type="checkbox"
              checked={eff.invert}
              onChange={(e) => onSetWipeStatic(layerId, index, eff.angle, e.target.checked)}
            />
            Invert (flip side)
          </label>
          <p className="insp-hint">
            Keyframe <b>Position</b> (move the playhead, drag) to sweep the fade across.
          </p>
        </>
      );
      break;
  }
  return (
    <div className="effect-row">
      <div className="effect-head">
        <span>{label}</span>
        <button
          className="insp-btn tiny"
          title="Remove effect"
          onClick={() => onRemove(layerId, index)}
        >
          ✕
        </button>
      </div>
      {body}
    </div>
  );
}

// The effect stack for a layer: add from the dropdown, then each effect's
// keyframeable controls. Reused by the isolated Effect Editor overlay.
export function EffectsSection({
  layerId,
  effects,
  onAddEffect,
  onRemoveEffect,
  onKeyEffect,
  onSetWipeStatic,
}: {
  layerId: number;
  effects: ResolvedEffect[];
  onAddEffect: (layerId: number, kind: string) => void;
  onRemoveEffect: (layerId: number, index: number) => void;
  onKeyEffect: KeyEffect;
  onSetWipeStatic: SetWipeStatic;
}) {
  return (
    <div className="insp-body">
      <div className="insp-sep">Effects</div>
      <label className="insp-field">
        Add effect
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) onAddEffect(layerId, e.target.value);
          }}
        >
          <option value="">＋ Add…</option>
          {EFFECT_TYPES.map((t) => (
            <option key={t.kind} value={t.kind}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      {effects.length === 0 && (
        <p className="insp-hint">
          Add black &amp; white, blur, a left→right wipe, brightness… they stack in order.
        </p>
      )}
      {effects.map((eff, i) => (
        <EffectRow
          key={i}
          layerId={layerId}
          index={i}
          eff={eff}
          onRemove={onRemoveEffect}
          onKey={onKeyEffect}
          onSetWipeStatic={onSetWipeStatic}
        />
      ))}
    </div>
  );
}

interface Props {
  layer: Layer | null;
  decomposed: boolean;
  shapes: ShapeRef[];
  shapeAngles: { x: number; y: number; z: number } | null;
  decalPlacement: { u: number; v: number; scale: number; rotation: number } | null;
  decalVisible: boolean;
  resolvedEffects: ResolvedEffect[];
  onAddEffect: (layerId: number, kind: string) => void;
  onRemoveEffect: (layerId: number, index: number) => void;
  onKeyEffect: KeyEffect;
  onSetWipeStatic: SetWipeStatic;
  onShapeParams: (layerId: number, p: ShapeParams) => void;
  onShapeRotKey: (
    layerId: number,
    axis: "x" | "y" | "z",
    value: number,
    seedStart: boolean
  ) => void;
  onAttachToShape: (layerId: number, shapeId: number | null, face: number) => void;
  onKeyDecal: (
    layerId: number,
    prop: "u" | "v" | "scale" | "rotation",
    value: number,
    seedStart: boolean
  ) => void;
  onSetDecalFace: (layerId: number, face: number) => void;
  onRevealFace: (shapeId: number, face: number) => void;
  onDecalKeyAll: (layerId: number) => void;
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
  shapes,
  shapeAngles,
  decalPlacement,
  decalVisible,
  resolvedEffects,
  onAddEffect,
  onRemoveEffect,
  onKeyEffect,
  onSetWipeStatic,
  onShapeParams,
  onShapeRotKey,
  onAttachToShape,
  onKeyDecal,
  onSetDecalFace,
  onRevealFace,
  onDecalKeyAll,
  onContent,
  onColor,
  onFont,
  onAnim,
  onToggleDecompose,
  onClearParts,
  onDecomposeKey,
}: Props) {
  const decalControls = layer && (layer.kind.kind === "image" || layer.kind.kind === "text") && (
    <DecalControls
      layerId={layer.id}
      attach={layer.attach}
      placement={decalPlacement}
      visible={decalVisible}
      shapes={shapes}
      onAttachToShape={onAttachToShape}
      onKeyDecal={onKeyDecal}
      onSetDecalFace={onSetDecalFace}
      onRevealFace={onRevealFace}
      onDecalKeyAll={onDecalKeyAll}
    />
  );
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
      {layer && layer.kind.kind === "shape3d" && (
        <ShapeInspector
          layerId={layer.id}
          shape={layer.kind.shape}
          params={{
            width: layer.kind.width,
            height: layer.kind.height,
            depth: layer.kind.depth,
            perspective: layer.kind.perspective,
            focalLength: layer.kind.focal_length,
            coverage: layer.kind.coverage,
            radius: layer.kind.radius,
          }}
          angles={shapeAngles}
          onShapeParams={onShapeParams}
          onShapeRotKey={onShapeRotKey}
        />
      )}
      {decalControls}
      {layer && layer.kind.kind === "image" && (
        <EffectsSection
          layerId={layer.id}
          effects={resolvedEffects}
          onAddEffect={onAddEffect}
          onRemoveEffect={onRemoveEffect}
          onKeyEffect={onKeyEffect}
          onSetWipeStatic={onSetWipeStatic}
        />
      )}
      {layer && layer.kind.kind === "colorpatch" && (
        <span className="muted">
          {layer.kind.kind} layer — drag on the canvas to move/scale, ◆ Key to set a keyframe.
        </span>
      )}
    </aside>
  );
}
