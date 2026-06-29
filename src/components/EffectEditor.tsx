// An isolated overlay for tuning an image's effects on the flat image — away
// from the rest of the scene. Stack as many effects as you like and see them
// composited live; the effects live on the layer, so closing returns them to
// the main scene. Reuses the same EffectsSection as the inspector.
import { useEffect, useRef, useState } from "react";
import { EffectsSection } from "./Inspector";
import { buildFilter, wipeEffects, applyWipe } from "../lib/effects";
import type { ResolvedEffect } from "../bindings/ResolvedEffect";

type EffectParam = "amount" | "radius" | "degrees" | "position" | "softness";

// Draws the image with its effect stack onto a canvas (guaranteed-correct
// preview — same filter + wipe pipeline the scene uses).
function EffectPreviewCanvas({ src, effects }: { src?: string; effects: ResolvedEffect[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
    ctx.clearRect(0, 0, w, h);
    ctx.filter = buildFilter(effects);
    ctx.drawImage(img, 0, 0, w, h);
    ctx.filter = "none";
    for (const wp of wipeEffects(effects)) applyWipe(ctx, w, h, wp);
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
