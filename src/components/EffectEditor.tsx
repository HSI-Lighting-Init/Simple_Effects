// An isolated overlay for tuning an image's effects on the flat image — away
// from the rest of the scene. Stack as many effects as you like and see them
// composited live; the effects live on the layer, so closing returns them to
// the main scene. Reuses the same EffectsSection as the inspector.
import { useEffect, useRef, useState } from "react";
import { EffectsSection } from "./Inspector";
import { applyEffects } from "../lib/effects";
import type { ResolvedEffect } from "../bindings/ResolvedEffect";
import type { Rgba } from "../bindings/Rgba";

type EffectParam =
  | "amount"
  | "radius"
  | "degrees"
  | "position"
  | "softness"
  | "intensity"
  | "scale"
  | "speed"
  | "complexity"
  | "contrast"
  | "brightness"
  | "opacity";

// Draws the image with its effect stack onto a canvas (guaranteed-correct
// preview — the exact same filter + wipe + shine pipeline the scene uses).
function EffectPreviewCanvas({ src, effects }: { src?: string; effects: ResolvedEffect[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!src) {
      setImg(null);
      return;
    }
    const im = new window.Image();
    im.onload = () => setImg(im);
    im.src = src;
    return () => {
      im.onload = null;
    };
  }, [src]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !img) return;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const scratch = scratchRef.current ?? (scratchRef.current = document.createElement("canvas"));
    const tex = applyEffects(scratch, img, w, h, effects);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(tex, 0, 0, w, h);
  }, [img, effects]);

  return <canvas ref={canvasRef} className="fx-preview-canvas" />;
}

export default function EffectEditor({
  layerId,
  name,
  src,
  effects,
  onAddEffect,
  onRemoveEffect,
  onKeyEffect,
  onSetWipeStatic,
  onSetShineStatic,
  onClose,
}: {
  layerId: number;
  name: string;
  src?: string;
  effects: ResolvedEffect[];
  onAddEffect: (layerId: number, kind: string) => void;
  onRemoveEffect: (layerId: number, index: number) => void;
  onKeyEffect: (
    layerId: number,
    index: number,
    param: EffectParam,
    value: number,
    seedStart: boolean
  ) => void;
  onSetWipeStatic: (layerId: number, index: number, angle: number, invert: boolean) => void;
  onSetShineStatic: (layerId: number, index: number, tint: Rgba, blend: number) => void;
  onClose: () => void;
}) {
  return (
    <div className="fx-editor-backdrop">
      <div className="fx-editor">
        <div className="fx-editor-head">
          <span>Effect editor — {name}</span>
          <button className="insp-btn active" onClick={onClose}>
            ✓ Done — back to scene
          </button>
        </div>
        <div className="fx-editor-body">
          <div className="fx-editor-stage">
            <EffectPreviewCanvas src={src} effects={effects} />
          </div>
          <div className="fx-editor-panel">
            <EffectsSection
              layerId={layerId}
              effects={effects}
              onAddEffect={onAddEffect}
              onRemoveEffect={onRemoveEffect}
              onKeyEffect={onKeyEffect}
              onSetWipeStatic={onSetWipeStatic}
              onSetShineStatic={onSetShineStatic}
            />
            <p className="insp-hint">
              Stack as many effects as you want — they composite top-to-bottom and
              stay on the image when you go back to the scene. Keyframe a wipe's
              Position to make it sweep.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
