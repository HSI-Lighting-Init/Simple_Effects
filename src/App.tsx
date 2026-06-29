import { useCallback, useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";

import Preview from "./components/Preview";
import Timeline from "./components/Timeline";
import Inspector from "./components/Inspector";
import RecorderPanel from "./components/RecorderPanel";
import ContextMenu from "./components/ContextMenu";
import MenuBar, { type MenuDef } from "./components/MenuBar";
import CompSettings from "./components/CompSettings";
import EffectEditor from "./components/EffectEditor";
import ExportDialog from "./components/ExportDialog";
import {
  addEffect,
  addImageLayer,
  addShapeLayer,
  addTextLayer,
  setCompSize,
  attachToShape,
  clearKeyframes,
  clearLetterOverrides,
  deleteKeyframesAt,
  deleteLayer,
  dropImageOnShape,
  editKeyframes,
  exportVideo,
  keyDecal,
  keyEffect,
  removeEffect,
  setDecomposeKey,
  setDecalFace,
  setLetterOverride,
  setShapeParams,
  setShapeRotationKey,
  setWipeStatic,
  evaluateAt,
  getProject,
  loadImageDataUrl,
  redo,
  saveTextFile,
  setLayerHidden,
  setTextAnim,
  setTextColor,
  setTextContent,
  setTextFont,
  undo,
} from "./lib/api";
import {
  clearRecording,
  describeTarget,
  eventCount,
  isRecording,
  record,
  startRecording,
  stopRecording,
} from "./lib/recorder";
import type { Project } from "./bindings/Project";
import type { ResolvedLayer } from "./bindings/ResolvedLayer";
import type { TransformEdit } from "./bindings/TransformEdit";
import type { LetterAnimation } from "./bindings/LetterAnimation";
import type { Font } from "./bindings/Font";
import type { Rgba } from "./bindings/Rgba";
import type { LetterOverride } from "./bindings/LetterOverride";
import type { SurfaceShape } from "./bindings/SurfaceShape";
import type { ShapeParams } from "./components/Inspector";
import "./App.css";

/** Read a Blob into a base64 string (no data-URL prefix) for the Rust file save. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const s = reader.result as string;
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Box faces, in `box_face_basis` order (index = the `face` value). */
const FACE_LABELS = ["Front", "Back", "Left", "Right", "Top", "Bottom"];

/**
 * A pleasant 3/4 view `[rotationX, rotationY]` (degrees) that brings each box
 * face toward the camera, so the image you just dropped on it is visible at once.
 */
const FACE_VIEW: Record<number, [number, number]> = {
  0: [-12, -22], // front
  1: [-12, 158], // back
  2: [-12, 68], // left
  3: [-12, -68], // right
  4: [-68, -22], // top
  5: [68, -22], // bottom
};

/** True if `shapeId` is a box whose spin isn't animated (safe to auto-orient). */
function revealableBox(p: Project, shapeId: number): boolean {
  const k = p.layers.find((l) => l.id === shapeId)?.kind;
  if (!k || k.kind !== "shape3d" || k.shape !== "box") return false;
  const animated =
    k.rotation_x.keys.length >= 2 ||
    k.rotation_y.keys.length >= 2 ||
    k.rotation_z.keys.length >= 2;
  return !animated;
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [resolved, setResolved] = useState<Record<number, ResolvedLayer>>({});
  const [images, setImages] = useState<Record<string, string>>({});
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [recCount, setRecCount] = useState(0);
  const [showRecorder, setShowRecorder] = useState(false);
  const [decomposeId, setDecomposeId] = useState<number | null>(null);
  const [selectedPart, setSelectedPart] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<
    { x: number; y: number; shapeId?: number; layerId?: number } | null
  >(null);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState("");
  const exportingRef = useRef(false);
  const [showCompSettings, setShowCompSettings] = useState(false);
  const [fxEditorId, setFxEditorId] = useState<number | null>(null);
  const [showExportDialog, setShowExportDialog] = useState(false);

  // Refs the rAF loop reads without re-subscribing.
  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const rafRef = useRef(0);
  const durationRef = useRef(4000);
  const evalBusy = useRef(false);
  // Mirrors of state that the recorder / global listeners read without
  // re-subscribing their effects.
  const projectRef = useRef<Project | null>(null);
  const resolvedRef = useRef<Record<number, ResolvedLayer>>({});
  const selectedIdRef = useRef<number | null>(null);
  const lastSeekRecRef = useRef(0);

  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { resolvedRef.current = resolved; }, [resolved]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  // A compact snapshot of the scene (every layer's resolved transform + the
  // kind-specific bits) for the recorder.
  const sceneSnapshot = useCallback(() => {
    const p = projectRef.current;
    if (!p) return null;
    const res = resolvedRef.current;
    return {
      timeMs: Math.round(timeRef.current),
      selectedId: selectedIdRef.current,
      layers: p.layers.map((l) => {
        const r = res[l.id];
        const base: Record<string, unknown> = {
          id: l.id,
          name: l.name,
          kind: l.kind.kind,
          x: r?.x, y: r?.y,
          scaleX: r?.scaleX, scaleY: r?.scaleY,
          rotation: r?.rotation, opacity: r?.opacity,
          visible: r?.visible,
        };
        if (l.kind.kind === "image") {
          base.src = l.kind.src;
          base.naturalW = l.kind.width;
          base.naturalH = l.kind.height;
        } else if (l.kind.kind === "text") {
          base.content = l.kind.content;
          base.size = l.kind.size;
          base.anim = l.kind.anim;
          base.glyphsAnimated = r?.letters?.length ?? 0;
        } else if (l.kind.kind === "colorpatch") {
          base.w = l.kind.width;
          base.h = l.kind.height;
        }
        return base;
      }),
    };
  }, []);

  // Record a semantic action, tagging it with the current time + scene.
  const recordAction = useCallback(
    (type: string, data: Record<string, unknown> = {}) => {
      if (!isRecording()) return;
      record(type, { ...data, timeMs: Math.round(timeRef.current), scene: sceneSnapshot() });
      setRecCount(eventCount());
    },
    [sceneSnapshot]
  );

  // Resolve any image-layer paths that we don't have a data URL for yet.
  const resolveImages = useCallback(
    async (p: Project) => {
      const next: Record<string, string> = {};
      for (const layer of p.layers) {
        if (layer.kind.kind === "image") {
          const src = layer.kind.src;
          if (!images[src] && !next[src]) {
            try {
              next[src] = await loadImageDataUrl(src);
            } catch (e) {
              console.warn("load image", src, e);
            }
          }
        }
      }
      if (Object.keys(next).length) setImages((m) => ({ ...m, ...next }));
    },
    [images]
  );

  // Pull resolved transforms for a given time and push them to the preview.
  const applyTime = useCallback(async (t: number) => {
    const layers = await evaluateAt(Math.round(t));
    const map: Record<number, ResolvedLayer> = {};
    for (const l of layers) map[l.id] = l;
    setResolved(map);
  }, []);

  // Initial load.
  useEffect(() => {
    (async () => {
      const p = await getProject();
      setProject(p);
      durationRef.current = p.durationMs;
      await resolveImages(p);
      await applyTime(0);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seek = useCallback(
    (t: number) => {
      timeRef.current = t;
      setTime(t);
      void applyTime(t);
      if (isRecording()) {
        const now = performance.now();
        if (now - lastSeekRecRef.current > 120) {
          lastSeekRecRef.current = now;
          recordAction("seek", { toMs: Math.round(t) });
        }
      }
    },
    [applyTime, recordAction]
  );

  const stop = useCallback(() => {
    if (playingRef.current) recordAction("pause");
    playingRef.current = false;
    setPlaying(false);
    cancelAnimationFrame(rafRef.current);
  }, [recordAction]);

  const play = useCallback(() => {
    if (playingRef.current) return;
    recordAction("play");
    playingRef.current = true;
    setPlaying(true);
    let startWall = performance.now();
    let startTime = timeRef.current >= durationRef.current ? 0 : timeRef.current;

    const tick = async () => {
      if (!playingRef.current) return;
      let t = startTime + (performance.now() - startWall);
      if (t >= durationRef.current) {
        // Loop.
        t = t % durationRef.current;
        startWall = performance.now();
        startTime = t;
      }
      timeRef.current = t;
      setTime(t);
      // Skip a frame rather than queue overlapping IPC calls.
      if (!evalBusy.current) {
        evalBusy.current = true;
        try {
          await applyTime(t);
        } finally {
          evalBusy.current = false;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [applyTime, recordAction]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const onOpenImage = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    });
    if (typeof selected !== "string") return;
    const p = await addImageLayer(selected);
    setProject(p);
    // Select the layer we just added so it's ready to move/scale.
    const newId = p.layers.length ? p.layers[p.layers.length - 1].id : null;
    if (newId != null) setSelectedId(newId);
    await resolveImages(p);
    await applyTime(timeRef.current);
    recordAction("add_image", { layerId: newId, path: selected });
  }, [resolveImages, applyTime, recordAction]);

  const onAddText = useCallback(async () => {
    const p = await addTextLayer("سلام", 140);
    setProject(p);
    const newId = p.layers.length ? p.layers[p.layers.length - 1].id : null;
    if (newId != null) setSelectedId(newId);
    await applyTime(timeRef.current);
    recordAction("add_text", { layerId: newId });
  }, [applyTime, recordAction]);

  // Edit a text layer's content/size; re-shapes on the Rust side.
  const onSetContent = useCallback(
    async (layerId: number, content: string, size: number) => {
      const p = await setTextContent(layerId, content, size);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("text_content", { layerId, content, size });
    },
    [applyTime, recordAction]
  );

  // Decompose mode: per-glyph manual transforms.
  const onCommitPart = useCallback(
    async (layerId: number, index: number, part: LetterOverride) => {
      const p = await setLetterOverride(layerId, index, part);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("letter_move", { layerId, index, part });
    },
    [applyTime, recordAction]
  );

  const onClearParts = useCallback(
    async (layerId: number) => {
      const p = await clearLetterOverrides(layerId);
      setProject(p);
      setSelectedPart(null);
      await applyTime(timeRef.current);
      recordAction("letters_reset", { layerId });
    },
    [applyTime, recordAction]
  );

  const toggleDecompose = useCallback((layerId: number) => {
    setDecomposeId((cur) => (cur === layerId ? null : layerId));
    setSelectedPart(null);
  }, []);

  // Key the decompose amount (0 composed / 1 decomposed) at the playhead so the
  // explode/gather animates over time.
  const onDecomposeKey = useCallback(
    async (layerId: number, value: number) => {
      const p = await setDecomposeKey(layerId, Math.round(timeRef.current), value, true);
      setProject(p);
      durationRef.current = p.durationMs;
      await applyTime(timeRef.current);
      recordAction("decompose_key", { layerId, value });
    },
    [applyTime, recordAction]
  );

  // Add an invisible 3D box/cylinder object and select it.
  const onAddShape = useCallback(
    async (shape: SurfaceShape) => {
      const p = await addShapeLayer(shape);
      setProject(p);
      const newId = p.layers.length ? p.layers[p.layers.length - 1].id : null;
      if (newId != null) setSelectedId(newId);
      await applyTime(timeRef.current);
      recordAction("add_shape", { shape, layerId: newId });
    },
    [applyTime, recordAction]
  );

  // Shape dimensions + camera (rotations are keyed separately).
  const onShapeParams = useCallback(
    async (layerId: number, params: ShapeParams) => {
      const p = await setShapeParams(
        layerId,
        params.width,
        params.height,
        params.depth,
        params.perspective,
        params.focalLength,
        params.coverage,
        params.radius
      );
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("shape_params", { layerId, params });
    },
    [applyTime, recordAction]
  );

  // Key a shape's 3D rotation at the playhead so it spins.
  const onShapeRotKey = useCallback(
    async (layerId: number, axis: "x" | "y" | "z", value: number, seedStart: boolean) => {
      const p = await setShapeRotationKey(
        layerId,
        axis,
        Math.round(timeRef.current),
        value,
        seedStart
      );
      setProject(p);
      durationRef.current = p.durationMs;
      await applyTime(timeRef.current);
      recordAction("shape_rot", { layerId, axis, value });
    },
    [applyTime, recordAction]
  );

  // Orient a box so the given face turns toward the camera (a 3/4 view). Used to
  // reveal a face right after dropping an image on it, and from the inspector's
  // "Turn box to this face" button. Keys X/Y rotation at the playhead.
  const onRevealFace = useCallback(
    async (shapeId: number, face: number) => {
      const [rx, ry] = FACE_VIEW[face] ?? FACE_VIEW[0];
      const t = Math.round(timeRef.current);
      await setShapeRotationKey(shapeId, "x", t, rx, false);
      const p = await setShapeRotationKey(shapeId, "y", t, ry, false);
      setProject(p);
      durationRef.current = p.durationMs;
      await applyTime(timeRef.current);
      recordAction("reveal_face", { shapeId, face });
    },
    [applyTime, recordAction]
  );

  // Pin a layer (image or text) to a shape, or detach with shapeId null.
  const onAttachToShape = useCallback(
    async (layerId: number, shapeId: number | null, face: number) => {
      const p = await attachToShape(layerId, shapeId, face);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("attach", { layerId, shapeId, face });
    },
    [applyTime, recordAction]
  );

  // Key one decal placement track at the playhead — this is what animates it.
  const onKeyDecal = useCallback(
    async (
      layerId: number,
      prop: "u" | "v" | "scale" | "rotation",
      value: number,
      seedStart: boolean
    ) => {
      const p = await keyDecal(layerId, prop, Math.round(timeRef.current), value, seedStart);
      setProject(p);
      durationRef.current = p.durationMs;
      await applyTime(timeRef.current);
      recordAction("key_decal", { layerId, prop, value });
    },
    [applyTime, recordAction]
  );

  const onSetDecalFace = useCallback(
    async (layerId: number, face: number) => {
      const p = await setDecalFace(layerId, face);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("decal_face", { layerId, face });
    },
    [applyTime, recordAction]
  );

  // Drag of the decal's square handle → key its scale (animates from the start).
  const onDecalScale = useCallback(
    (layerId: number, scale: number) => onKeyDecal(layerId, "scale", scale, true),
    [onKeyDecal]
  );

  // "◆ Key placement": pin the decal's current sampled placement at this frame.
  const onDecalKeyAll = useCallback(
    async (layerId: number) => {
      const s = resolvedRef.current[layerId]?.surface;
      if (!s) return;
      const tMs = Math.round(timeRef.current);
      let p: Project | null = null;
      p = await keyDecal(layerId, "u", tMs, s.u, false);
      p = await keyDecal(layerId, "v", tMs, s.v, false);
      p = await keyDecal(layerId, "scale", tMs, s.scale, false);
      p = await keyDecal(layerId, "rotation", tMs, s.rotation, false);
      if (p) {
        setProject(p);
        durationRef.current = p.durationMs;
      }
      await applyTime(timeRef.current);
      recordAction("decal_key_all", { layerId });
    },
    [applyTime, recordAction]
  );

  // Drag a layer (or a decal's move handle) onto a shape's surface at comp (x,y).
  // If it lands on a shape, Rust pins it and keys u/v; otherwise a flat image
  // falls back to an ordinary move, and a decal dragged off-surface snaps back.
  const onImageDrop = useCallback(
    async (imageId: number, x: number, y: number) => {
      const tMs = Math.round(timeRef.current);
      const dropped = await dropImageOnShape(imageId, x, y, tMs);
      if (dropped) {
        setProject(dropped);
        durationRef.current = dropped.durationMs;
        await applyTime(timeRef.current);
        recordAction("image_drop", { imageId, x, y, attached: true });
        return;
      }
      // Not over a shape: a flat image commits the move; a decal stays put.
      const layer = projectRef.current?.layers.find((l) => l.id === imageId);
      const isDecal = !!layer?.attach;
      if (!isDecal) {
        const p = await editKeyframes(imageId, tMs, { x, y }, true);
        setProject(p);
        durationRef.current = p.durationMs;
        recordAction("image_drop", { imageId, x, y, attached: false });
      }
      await applyTime(timeRef.current);
    },
    [applyTime, recordAction]
  );

  // Right-click a shape → open the insert menu (and select the shape).
  const onShapeContextMenu = useCallback(
    (shapeId: number, x: number, y: number) => {
      setSelectedId(shapeId);
      setCtxMenu({ x, y, shapeId });
      recordAction("shape_contextmenu", { shapeId });
    },
    [recordAction]
  );

  // Insert an image / text layer already pinned to a shape's surface, on the
  // chosen `face` (box: 0..5; cylinder ignores it and wraps).
  const onInsertImageOnShape = useCallback(
    async (shapeId: number, face = 0) => {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
      });
      if (typeof selected !== "string") return;
      const added = await addImageLayer(selected);
      const newId = added.layers.length ? added.layers[added.layers.length - 1].id : null;
      const p = newId != null ? await attachToShape(newId, shapeId, face) : added;
      setProject(p);
      if (newId != null) setSelectedId(newId);
      await resolveImages(p);
      // Turn a (static) box to show the chosen face so the image lands in view.
      if (revealableBox(p, shapeId)) await onRevealFace(shapeId, face);
      else await applyTime(timeRef.current);
      recordAction("insert_image_on_shape", { shapeId, newId, face });
    },
    [resolveImages, applyTime, recordAction, onRevealFace]
  );

  const onInsertTextOnShape = useCallback(
    async (shapeId: number, face = 0) => {
      const added = await addTextLayer("Text", 160);
      const newId = added.layers.length ? added.layers[added.layers.length - 1].id : null;
      const p = newId != null ? await attachToShape(newId, shapeId, face) : added;
      setProject(p);
      if (newId != null) setSelectedId(newId);
      if (revealableBox(p, shapeId)) await onRevealFace(shapeId, face);
      else await applyTime(timeRef.current);
      recordAction("insert_text_on_shape", { shapeId, newId, face });
    },
    [applyTime, recordAction, onRevealFace]
  );

  // Effect stack: add / remove / key a parameter / set wipe statics.
  const onAddEffect = useCallback(
    async (layerId: number, kind: string) => {
      const p = await addEffect(layerId, kind);
      setProject(p);
      durationRef.current = p.durationMs;
      await applyTime(timeRef.current);
      recordAction("add_effect", { layerId, kind });
    },
    [applyTime, recordAction]
  );

  const onRemoveEffect = useCallback(
    async (layerId: number, index: number) => {
      const p = await removeEffect(layerId, index);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("remove_effect", { layerId, index });
    },
    [applyTime, recordAction]
  );

  const onKeyEffect = useCallback(
    async (
      layerId: number,
      index: number,
      param: "amount" | "radius" | "degrees" | "position" | "softness",
      value: number,
      seedStart: boolean
    ) => {
      const p = await keyEffect(layerId, index, param, Math.round(timeRef.current), value, seedStart);
      setProject(p);
      durationRef.current = p.durationMs;
      await applyTime(timeRef.current);
      recordAction("key_effect", { layerId, index, param, value });
    },
    [applyTime, recordAction]
  );

  const onSetWipeStatic = useCallback(
    async (layerId: number, index: number, angle: number, invert: boolean) => {
      const p = await setWipeStatic(layerId, index, angle, invert);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("wipe_static", { layerId, index, angle, invert });
    },
    [applyTime, recordAction]
  );

  // Delete a whole layer (object). Deselects + exits decompose if it was active.
  const onDeleteLayer = useCallback(
    async (layerId: number) => {
      const p = await deleteLayer(layerId);
      setProject(p);
      durationRef.current = p.durationMs;
      setSelectedId((cur) => (cur === layerId ? null : cur));
      setDecomposeId((cur) => (cur === layerId ? null : cur));
      await applyTime(timeRef.current);
      recordAction("delete_layer", { layerId });
    },
    [applyTime, recordAction]
  );

  // Delete every keyframe at one time on a layer (clicking a timeline diamond).
  const onDeleteKeyframe = useCallback(
    async (layerId: number, tMs: number) => {
      const p = await deleteKeyframesAt(layerId, tMs);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("delete_keyframe", { layerId, tMs });
    },
    [applyTime, recordAction]
  );

  // Clear ALL keyframes on a layer (delete its tracks), freezing it as it looks now.
  const onClearKeyframes = useCallback(
    async (layerId: number) => {
      const p = await clearKeyframes(layerId, Math.round(timeRef.current));
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("clear_keyframes", { layerId });
    },
    [applyTime, recordAction]
  );

  // Right-click a timeline layer row → open its delete menu.
  const onLayerContextMenu = useCallback((layerId: number, x: number, y: number) => {
    setSelectedId(layerId);
    setCtxMenu({ x, y, layerId });
  }, []);

  // Change the composition resolution / orientation.
  const onSetCompSize = useCallback(
    async (w: number, h: number) => {
      const p = await setCompSize(w, h);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("comp_size", { w, h });
    },
    [applyTime, recordAction]
  );

  // Render the comp to a video: full-resolution canvas captured in real time to
  // WebM, then saved as-is (webm) or transcoded to MP4 (H.264) by Rust/ffmpeg.
  // `level` 1..5 = compression; for WebM it also sets the recording bitrate.
  const onExport = useCallback(
    async (format: "mp4" | "webm", level: number) => {
      const p = projectRef.current;
      if (!p || exportingRef.current) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const path = await save({
        defaultPath: `render-${stamp}.${format}`,
        filters: [{ name: `${format.toUpperCase()} video`, extensions: [format] }],
      });
      if (!path) return;

      stop();
      setSelectedId(null);
      exportingRef.current = true;
      setExporting(true);
      setExportMsg("Preparing…");
      try {
        // Let the preview re-render at full resolution (export scale) first.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const canvas = document.querySelector(".preview-stage canvas") as HTMLCanvasElement | null;
        if (!canvas) throw new Error("preview canvas not found");
        const fps = p.fps || 30;
        const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
          ? "video/webm;codecs=vp9"
          : "video/webm";
        // MP4 records at high quality (ffmpeg controls the final compression via
        // CRF); WebM is written as-is, so the recording bitrate is the knob.
        const webmMbps = [24, 14, 8, 5, 3][level - 1] ?? 8;
        const bitrate = (format === "mp4" ? 24 : webmMbps) * 1_000_000;
        const stream = canvas.captureStream(fps);
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
        const chunks: BlobPart[] = [];
        rec.ondataavailable = (e) => {
          if (e.data.size) chunks.push(e.data);
        };
        const stopped = new Promise<void>((res) => {
          rec.onstop = () => res();
        });
        rec.start();

        // Play 0 → duration in real time; the canvas updates feed the recorder.
        const duration = p.durationMs;
        const startWall = performance.now();
        await new Promise<void>((resolve) => {
          const tick = async () => {
            const t = performance.now() - startWall;
            if (t >= duration) {
              await applyTime(duration);
              resolve();
              return;
            }
            setExportMsg(`Rendering… ${Math.round((t / duration) * 100)}%`);
            await applyTime(t);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await new Promise((r) => setTimeout(r, 250)); // flush last frame
        rec.stop();
        await stopped;

        setExportMsg(format === "mp4" ? "Encoding MP4 (ffmpeg)…" : "Saving…");
        const blob = new Blob(chunks, { type: mime });
        const base64 = await blobToBase64(blob);
        await exportVideo(base64, path, format, level);
        recordAction("export_video", { path, format, level });
        alert(`Saved video:\n${path}`);
      } catch (e) {
        alert(`Export failed: ${e}`);
      } finally {
        exportingRef.current = false;
        setExporting(false);
        setExportMsg("");
        await applyTime(timeRef.current);
      }
    },
    [stop, applyTime, recordAction]
  );

  // Show/hide a layer from the timeline's layer list.
  const onToggleHidden = useCallback(
    async (layerId: number) => {
      const layer = projectRef.current?.layers.find((l) => l.id === layerId);
      const hidden = !(layer?.hidden ?? false);
      const p = await setLayerHidden(layerId, hidden);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("toggle_hidden", { layerId, hidden });
    },
    [applyTime, recordAction]
  );

  const onSetColor = useCallback(
    async (layerId: number, color: Rgba) => {
      const p = await setTextColor(layerId, color);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("text_color", { layerId, color });
    },
    [applyTime, recordAction]
  );

  const onSetFont = useCallback(
    async (layerId: number, font: Font) => {
      const p = await setTextFont(layerId, font);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("text_font", { layerId, font });
    },
    [applyTime, recordAction]
  );

  // Pick / clear / retune a text layer's per-letter preset.
  const onSetAnim = useCallback(
    async (layerId: number, anim: LetterAnimation | null) => {
      const p = await setTextAnim(layerId, anim);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("preset", { layerId, anim });
    },
    [applyTime, recordAction]
  );

  // A canvas edit (drag/scale/rotate) → keyframes at the current playhead.
  const onCommit = useCallback(
    async (layerId: number, edit: TransformEdit) => {
      const p = await editKeyframes(layerId, Math.round(timeRef.current), edit, true);
      setProject(p);
      durationRef.current = p.durationMs;
      await applyTime(timeRef.current);
      recordAction("transform_commit", { layerId, edit });
    },
    [applyTime, recordAction]
  );

  // "◆ Key": pin the selected layer's current look as keyframes at this frame.
  const setKeyHere = useCallback(async () => {
    if (selectedId == null) return;
    const r = resolved[selectedId];
    if (!r) return;
    const edit: TransformEdit = {
      x: r.x,
      y: r.y,
      scaleX: r.scaleX,
      scaleY: r.scaleY,
      rotation: r.rotation,
      opacity: r.opacity,
    };
    const p = await editKeyframes(selectedId, Math.round(timeRef.current), edit, false);
    setProject(p);
    await applyTime(timeRef.current);
    recordAction("keyframe", { layerId: selectedId });
  }, [selectedId, resolved, applyTime, recordAction]);

  // User-initiated selection is recorded; internal auto-selects use setSelectedId.
  const selectLayer = useCallback(
    (id: number | null) => {
      setSelectedId(id);
      // Leave decompose mode if we're selecting a different layer.
      setDecomposeId((cur) => (cur != null && cur !== id ? null : cur));
      setSelectedPart(null);
      recordAction("select", { layerId: id });
    },
    [recordAction]
  );

  const doUndo = useCallback(async () => {
    const p = await undo();
    if (!p) return;
    setProject(p);
    durationRef.current = p.durationMs;
    if (selectedIdRef.current != null && !p.layers.some((l) => l.id === selectedIdRef.current)) {
      setSelectedId(null);
    }
    await resolveImages(p);
    await applyTime(timeRef.current);
    recordAction("undo");
  }, [applyTime, resolveImages, recordAction]);

  const doRedo = useCallback(async () => {
    const p = await redo();
    if (!p) return;
    setProject(p);
    durationRef.current = p.durationMs;
    await resolveImages(p);
    await applyTime(timeRef.current);
    recordAction("redo");
  }, [applyTime, resolveImages, recordAction]);

  // Session recorder: start clears + begins capture; stop ends it (events are
  // kept so they can be copied/saved); clear discards.
  const startRec = useCallback(() => {
    const canvas = document.querySelector(".preview-stage canvas") as HTMLCanvasElement | null;
    const rect = canvas?.getBoundingClientRect();
    const p = projectRef.current;
    startRecording({
      app: "Simple Effects",
      comp: p ? { width: p.width, height: p.height, fps: p.fps, durationMs: p.durationMs } : null,
      windowSize: { w: window.innerWidth, h: window.innerHeight },
      canvasRect: rect
        ? {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
        : null,
    });
    record("start", { project: p, scene: sceneSnapshot() });
    setRecording(true);
    setRecCount(eventCount());
  }, [sceneSnapshot]);

  const stopRec = useCallback(() => {
    if (isRecording()) record("stop", { project: projectRef.current, scene: sceneSnapshot() });
    stopRecording();
    setRecording(false);
    setRecCount(eventCount());
  }, [sceneSnapshot]);

  const clearRec = useCallback(() => {
    clearRecording();
    setRecCount(0);
  }, []);

  const onSaveRecording = useCallback(async (json: string) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const path = await save({
      defaultPath: `session-${stamp}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    try {
      await saveTextFile(path, json);
      alert(`Saved to:\n${path}`);
    } catch (e) {
      alert(`Save failed: ${e}`);
    }
  }, []);

  // Keyboard: Esc deselects; Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField =
        !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "Escape") {
        setSelectedPart(null);
        setDecomposeId(null);
        setSelectedId(null);
        return;
      }
      // Delete / Backspace removes the selected layer (not while in decompose
      // per-glyph editing, where it may mean something else).
      if ((e.key === "Delete" || e.key === "Backspace") && !inField) {
        const sel = selectedIdRef.current;
        if (sel != null && decomposeId == null) {
          e.preventDefault();
          void onDeleteLayer(sel);
        }
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "z" || e.key === "Z")) {
        if (inField) return; // let the text field handle its own undo
        e.preventDefault();
        if (e.shiftKey) void doRedo();
        else void doUndo();
      } else if (mod && (e.key === "y" || e.key === "Y")) {
        if (inField) return;
        e.preventDefault();
        void doRedo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doUndo, doRedo, onDeleteLayer, decomposeId]);

  // Global capture for the session recorder: clicks, JS errors, window resizes.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!isRecording()) return;
      record("click", {
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        button: e.button,
        target: describeTarget(e.target as Element | null),
      });
      setRecCount(eventCount());
    };
    const onError = (e: ErrorEvent) => {
      if (!isRecording()) return;
      record("error", {
        message: e.message,
        source: e.filename,
        line: e.lineno,
        col: e.colno,
        stack: e.error?.stack,
      });
      setRecCount(eventCount());
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (!isRecording()) return;
      record("unhandledRejection", { reason: String(e.reason) });
      setRecCount(eventCount());
    };
    const onResize = () => {
      if (!isRecording()) return;
      record("resize", { w: window.innerWidth, h: window.innerHeight });
      setRecCount(eventCount());
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  if (!project) return <div className="loading">Loading…</div>;

  const selectedLayer = project.layers.find((l) => l.id === selectedId) ?? null;
  // All 3D-shape objects, for the "pin to shape" picker.
  const shapes = project.layers
    .filter((l) => l.kind.kind === "shape3d")
    .map((l) => ({
      id: l.id,
      name: l.name,
      shape: l.kind.kind === "shape3d" ? l.kind.shape : "box",
    }));
  // Sampled 3D rotation of the selected shape (feeds the inspector sliders).
  const selFrame = selectedId != null ? resolved[selectedId]?.shape : null;
  const shapeAngles = selFrame
    ? { x: selFrame.rotationX, y: selFrame.rotationY, z: selFrame.rotationZ }
    : null;
  // Sampled decal placement of the selected pinned layer (feeds its sliders).
  const selDecal = selectedId != null ? resolved[selectedId]?.surface : null;
  const decalPlacement = selDecal
    ? { u: selDecal.u, v: selDecal.v, scale: selDecal.scale, rotation: selDecal.rotation }
    : null;
  // Is the selected decal actually drawing? (Empty quads = its face is turned
  // away from the camera — the renderer culls it, which can read as "not applied".)
  const decalVisible = !!selDecal && selDecal.quads.length > 0;
  // The selected layer's effect stack, sampled at the playhead (for the sliders).
  const resolvedEffects = (selectedId != null ? resolved[selectedId]?.effects : null) ?? [];
  // The image layer open in the isolated Effect Editor (if any).
  const fxLayer = fxEditorId != null ? project.layers.find((l) => l.id === fxEditorId) ?? null : null;

  const isImageSelected = selectedLayer?.kind.kind === "image";
  const effectKinds: [string, string][] = [
    ["grayscale", "Black & White"],
    ["brightness", "Brightness"],
    ["contrast", "Contrast"],
    ["saturate", "Saturation"],
    ["blur", "Blur"],
    ["hue", "Hue Shift"],
    ["invert", "Invert"],
    ["wipe", "Wipe / Fade"],
  ];

  const menus: MenuDef[] = [
    {
      title: "File",
      items: [
        { label: "Import Image…", onClick: onOpenImage },
        { separator: true },
        {
          label: "Export Video…",
          onClick: () => setShowExportDialog(true),
          disabled: exporting,
        },
      ],
    },
    {
      title: "Edit",
      items: [
        { label: "Undo", onClick: () => void doUndo(), shortcut: "Ctrl+Z" },
        { label: "Redo", onClick: () => void doRedo(), shortcut: "Ctrl+Shift+Z" },
        { separator: true },
        {
          label: "Delete Layer",
          onClick: () => selectedId != null && onDeleteLayer(selectedId),
          disabled: selectedId == null,
          shortcut: "Del",
        },
        {
          label: "Clear Keyframes",
          onClick: () => selectedId != null && onClearKeyframes(selectedId),
          disabled: selectedId == null,
        },
      ],
    },
    {
      title: "Add",
      items: [
        { label: "Text", onClick: onAddText },
        { label: "Image…", onClick: onOpenImage },
        { separator: true },
        { label: "3D Box", onClick: () => onAddShape("box") },
        { label: "3D Cylinder", onClick: () => onAddShape("cylinder") },
      ],
    },
    {
      title: "Effect",
      items: [
        {
          label: "Open Effect Editor…",
          onClick: () => isImageSelected && selectedId != null && setFxEditorId(selectedId),
          disabled: !isImageSelected,
        },
        { separator: true },
        ...effectKinds.map(([kind, label]) => ({
          label,
          onClick: () => selectedId != null && onAddEffect(selectedId, kind),
          disabled: !isImageSelected,
        })),
      ],
    },
    {
      title: "Composition",
      items: [
        { label: "Composition Settings…", onClick: () => setShowCompSettings(true) },
        { separator: true },
        {
          label: playing ? "Pause" : "Play",
          onClick: () => (playing ? stop() : play()),
          shortcut: "Space",
        },
        {
          label: "Add Keyframe (selected)",
          onClick: setKeyHere,
          disabled: !selectedLayer,
        },
        { separator: true },
        { label: "Export Video…", onClick: () => setShowExportDialog(true), disabled: exporting },
      ],
    },
    {
      title: "Window",
      items: [
        {
          label: (showRecorder ? "Hide" : "Show") + " Session Recorder",
          onClick: () => setShowRecorder((s) => !s),
        },
      ],
    },
    {
      title: "Help",
      items: [
        {
          label: "About Simple Effects",
          onClick: () =>
            alert(
              "Simple Effects — a mini After Effects.\nTauri + React + Rust.\n\n" +
                "Add images, text and 3D shapes; pin layers onto box/cylinder surfaces; " +
                "apply effects; keyframe everything; export to WebM."
            ),
        },
      ],
    },
  ];

  return (
    <div className="app">
      <MenuBar menus={menus} />
      <header className="toolbar">
        <span className="brand">simple · effects</span>
        <button className="primary" onClick={playing ? stop : play}>
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button onClick={setKeyHere} disabled={!selectedLayer} title="Add keyframe at playhead">
          ◆ Key
        </button>
        <button onClick={doUndo} title="Undo (Ctrl+Z)">↶</button>
        <button onClick={doRedo} title="Redo (Ctrl+Shift+Z)">↷</button>
        <button
          onClick={() => setShowExportDialog(true)}
          disabled={exporting}
          title="Export the comp to a video (MP4 / WebM)"
        >
          {exporting ? "● Exporting…" : "⤓ Export"}
        </button>
        <button
          className={recording ? "rec on" : "rec"}
          onClick={() => setShowRecorder((s) => !s)}
          title="Session recorder (floating window) — capture a bug repro"
        >
          {recording ? `● Rec · ${recCount}` : "● Rec"}
        </button>
        {selectedLayer && <span className="selinfo">▸ {selectedLayer.name}</span>}
        <span className="time">
          {(time / 1000).toFixed(2)}s / {(project.durationMs / 1000).toFixed(2)}s
        </span>
        <span className="meta">
          {project.width}×{project.height} · {project.fps}fps
        </span>
      </header>

      <div className="mid">
        <main className="stage-area">
          <Preview
            project={project}
            resolved={resolved}
            images={images}
            selectedId={selectedId}
            playing={playing}
            decomposeId={decomposeId}
            selectedPart={selectedPart}
            onSelect={selectLayer}
            onCommit={onCommit}
            onSelectPart={setSelectedPart}
            onCommitPart={onCommitPart}
            onImageDrop={onImageDrop}
            onDecalScale={onDecalScale}
            onShapeContextMenu={onShapeContextMenu}
            exporting={exporting}
          />
          {exporting && (
            <div className="export-overlay">
              <div className="export-card">
                <div className="spinner" />
                <div>{exportMsg || "Rendering…"}</div>
                <div className="muted">Recording the full-resolution canvas — don't switch away.</div>
              </div>
            </div>
          )}
        </main>
        <Inspector
          layer={selectedLayer}
          decomposed={selectedLayer != null && decomposeId === selectedLayer.id}
          shapes={shapes}
          shapeAngles={shapeAngles}
          decalPlacement={decalPlacement}
          decalVisible={decalVisible}
          resolvedEffects={resolvedEffects}
          onAddEffect={onAddEffect}
          onRemoveEffect={onRemoveEffect}
          onKeyEffect={onKeyEffect}
          onSetWipeStatic={onSetWipeStatic}
          onShapeParams={onShapeParams}
          onShapeRotKey={onShapeRotKey}
          onAttachToShape={onAttachToShape}
          onKeyDecal={onKeyDecal}
          onSetDecalFace={onSetDecalFace}
          onRevealFace={onRevealFace}
          onDecalKeyAll={onDecalKeyAll}
          onContent={onSetContent}
          onColor={onSetColor}
          onFont={onSetFont}
          onAnim={onSetAnim}
          onToggleDecompose={toggleDecompose}
          onClearParts={onClearParts}
          onDecomposeKey={onDecomposeKey}
        />
      </div>

      <Timeline
        project={project}
        time={time}
        selectedId={selectedId}
        onSelect={selectLayer}
        onToggleHidden={onToggleHidden}
        onSeek={(t) => {
          if (playingRef.current) stop();
          seek(t);
        }}
        onDeleteLayer={onDeleteLayer}
        onDeleteKeyframe={onDeleteKeyframe}
        onLayerContextMenu={onLayerContextMenu}
      />

      {showRecorder && (
        <RecorderPanel
          recording={recording}
          recCount={recCount}
          onStart={startRec}
          onStop={stopRec}
          onClear={clearRec}
          onClose={() => setShowRecorder(false)}
          onSaveFile={onSaveRecording}
        />
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={
            ctxMenu.shapeId != null
              ? shapes.find((s) => s.id === ctxMenu.shapeId)?.shape === "box"
                ? [
                    {
                      label: "＋ Insert image on face",
                      submenu: FACE_LABELS.map((f, i) => ({
                        label: f,
                        onClick: () => onInsertImageOnShape(ctxMenu.shapeId!, i),
                      })),
                    },
                    {
                      label: "＋ Insert text on face",
                      submenu: FACE_LABELS.map((f, i) => ({
                        label: f,
                        onClick: () => onInsertTextOnShape(ctxMenu.shapeId!, i),
                      })),
                    },
                  ]
                : [
                    {
                      label: "＋ Insert image on surface",
                      onClick: () => onInsertImageOnShape(ctxMenu.shapeId!, 0),
                    },
                    {
                      label: "＋ Insert text on surface",
                      onClick: () => onInsertTextOnShape(ctxMenu.shapeId!, 0),
                    },
                  ]
              : ctxMenu.layerId != null
                ? [
                    {
                      label: "⊘ Clear all keyframes",
                      onClick: () => onClearKeyframes(ctxMenu.layerId!),
                    },
                    {
                      label: "✕ Delete layer",
                      onClick: () => onDeleteLayer(ctxMenu.layerId!),
                    },
                  ]
                : []
          }
        />
      )}

      {showCompSettings && (
        <CompSettings
          width={project.width}
          height={project.height}
          onApply={onSetCompSize}
          onClose={() => setShowCompSettings(false)}
        />
      )}

      {showExportDialog && (
        <ExportDialog onExport={onExport} onClose={() => setShowExportDialog(false)} />
      )}

      {fxLayer && fxLayer.kind.kind === "image" && (
        <EffectEditor
          layerId={fxLayer.id}
          name={fxLayer.name}
          src={images[fxLayer.kind.src]}
          effects={resolved[fxLayer.id]?.effects ?? []}
          onAddEffect={onAddEffect}
          onRemoveEffect={onRemoveEffect}
          onKeyEffect={onKeyEffect}
          onSetWipeStatic={onSetWipeStatic}
          onClose={() => setFxEditorId(null)}
        />
      )}
    </div>
  );
}
