import { useCallback, useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";

import Preview from "./components/Preview";
import Timeline from "./components/Timeline";
import Inspector from "./components/Inspector";
import RecorderPanel from "./components/RecorderPanel";
import ContextMenu from "./components/ContextMenu";
import MenuBar, { type MenuDef } from "./components/MenuBar";
import CompSettings from "./components/CompSettings";
import EffectEditor from "./components/EffectEditor";
import ExportDialog from "./components/ExportDialog";
import TransitionsDemo from "./components/TransitionsDemo";
import {
  addEffect,
  addImageLayer,
  addShapeLayer,
  addTextLayer,
  setCompSize,
  setCompDuration,
  setCompFps,
  setLayerRange,
  scaleLayerToFit,
  setLayerTransition,
  reorderLayers,
  saveProjectFile,
  openProjectFile,
  attachToShape,
  clearKeyframes,
  clearLetterOverrides,
  deleteKeyframesAt,
  moveKeyframesAt,
  deleteLayer,
  duplicateLayer,
  splitLayer,
  dropImageOnShape,
  editKeyframes,
  exportVideo,
  keyDecal,
  keyEffect,
  removeEffect,
  setDecomposeKey,
  setDecalFace,
  setLetterOverride,
  setLetterColor,
  clearLetterColor,
  type LetterPose,
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
  clearTextColorKeys,
  setTextContent,
  setTextFont,
  listFonts,
  setTextStyle,
  setTextAnimators,
  setTextLayerStyles,
  setTextPerChar3d,
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
import {
  beginProbeRun,
  isProbeEnabled,
  probePreview,
  analyzeOutputVideo,
  lastReport as lastProbeReport,
} from "./lib/renderProbe";
import {
  encodeDeterministicWebm,
  isDeterministicSupported,
  bitrateForLevel,
} from "./lib/deterministicExport";
import type { Project } from "./bindings/Project";
import type { ResolvedLayer } from "./bindings/ResolvedLayer";
import type { TransformEdit } from "./bindings/TransformEdit";
import type { LetterAnimation } from "./bindings/LetterAnimation";
import type { Font } from "./bindings/Font";
import type { Rgba } from "./bindings/Rgba";
import type { SurfaceShape } from "./bindings/SurfaceShape";
import type { TextStyle } from "./bindings/TextStyle";
import type { TextAnimator } from "./bindings/TextAnimator";
import type { TextLayerStyles } from "./bindings/TextLayerStyles";
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

/** Last path segment (Windows or POSIX separators) — the file's display name. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Dialog filter for Simple Effects project files. */
const SEFX_FILTER = [{ name: "Simple Effects Project", extensions: ["sefx"] }];

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
  const [fonts, setFonts] = useState<string[]>([]);
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
  // Live preview frame rate (measured during playback) and the FPS label burned
  // into the video while exporting (null = off).
  const [previewFps, setPreviewFps] = useState(0);
  const [fpsOverlay, setFpsOverlay] = useState<number | null>(null);
  const fpsFramesRef = useRef(0);
  const fpsLastRef = useRef(0);
  // The .sefx file the project is bound to (null = never saved). `fileName` is
  // just its display name for the title bar / toolbar.
  const filePathRef = useRef<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  // Unsaved-changes tracking for the close-confirmation prompt.
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const pristineRef = useRef(true); // suppress the dirty mark on load/open
  const [showClosePrompt, setShowClosePrompt] = useState(false);
  // Layer copy/paste clipboard (holds the copied layer's id).
  const copiedLayerRef = useRef<number | null>(null);
  // Razor (cut) tool: when on, clicking a timeline block splits it there.
  const [razor, setRazor] = useState(false);
  const [showTransitions, setShowTransitions] = useState(false);

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
    // Load installed font families for the picker (built-ins first).
    listFonts().then(setFonts).catch(() => setFonts(["Vazirmatn", "Sahel", "Shabnam", "Gandom"]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-scan installed fonts (picks up fonts installed while the app is running).
  const refreshFonts = useCallback(() => {
    listFonts().then(setFonts).catch(() => {});
  }, []);

  // Mirror `dirty` into a ref the (non-React) window close handler can read.
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Any edit replaces `project` with a new object → mark it unsaved. The initial
  // load and Open are pristine (suppressed via pristineRef).
  useEffect(() => {
    if (!project) return;
    if (pristineRef.current) {
      pristineRef.current = false;
      return;
    }
    setDirty(true);
  }, [project]);

  // Intercept the OS window close: if there are unsaved changes, cancel it and
  // show the Save / Don't-save / Cancel prompt instead.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((event) => {
        if (!dirtyRef.current) return; // clean → allow the close
        event.preventDefault();
        setShowClosePrompt(true);
      })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => unlisten?.();
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
    setPreviewFps(0);
    cancelAnimationFrame(rafRef.current);
  }, [recordAction]);

  const play = useCallback(() => {
    if (playingRef.current) return;
    recordAction("play");
    playingRef.current = true;
    setPlaying(true);
    let startWall = performance.now();
    let startTime = timeRef.current >= durationRef.current ? 0 : timeRef.current;
    // Reset the FPS meter for this run.
    fpsFramesRef.current = 0;
    fpsLastRef.current = performance.now();

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
      // Skip a frame rather than queue overlapping IPC calls. Each completed
      // render counts toward the live preview FPS, recomputed ~3×/second.
      if (!evalBusy.current) {
        evalBusy.current = true;
        try {
          await applyTime(t);
          fpsFramesRef.current += 1;
          const now = performance.now();
          const span = now - fpsLastRef.current;
          if (span >= 333) {
            setPreviewFps(Math.round((fpsFramesRef.current * 1000) / span));
            fpsFramesRef.current = 0;
            fpsLastRef.current = now;
          }
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

  // Decompose mode: per-glyph manual transforms, keyed at the playhead so each
  // letter can be animated over time (drag at t1, drag at t2 → it tweens).
  const onCommitPart = useCallback(
    async (layerId: number, index: number, pose: LetterPose) => {
      const t = Math.round(timeRef.current);
      const layer = projectRef.current?.layers.find((l) => l.id === layerId);
      const seedStart = layer ? t > layer.startMs : false;
      const p = await setLetterOverride(layerId, index, pose, t, seedStart);
      setProject(p);
      durationRef.current = p.durationMs;
      await applyTime(timeRef.current);
      recordAction("letter_move", { layerId, index, pose, timeMs: t });
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

  // Colour one decomposed letter at the playhead (keyframeable per letter).
  const onLetterColor = useCallback(
    async (layerId: number, index: number, color: Rgba) => {
      const t = Math.round(timeRef.current);
      const layer = projectRef.current?.layers.find((l) => l.id === layerId);
      const seedStart = layer ? t > layer.startMs : false;
      const p = await setLetterColor(layerId, index, color, t, seedStart);
      setProject(p);
      durationRef.current = p.durationMs;
      await applyTime(timeRef.current);
      recordAction("letter_color", { layerId, index, color, timeMs: t });
    },
    [applyTime, recordAction]
  );

  const onClearLetterColor = useCallback(
    async (layerId: number, index: number) => {
      const p = await clearLetterColor(layerId, index);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("letter_color_clear", { layerId, index });
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

  // Duplicate a layer (clone with a fresh id, on top) and select the clone.
  const duplicateLayerById = useCallback(
    async (srcId: number) => {
      if (!projectRef.current?.layers.some((l) => l.id === srcId)) return;
      const p = await duplicateLayer(srcId);
      setProject(p);
      durationRef.current = p.durationMs;
      const newId = p.layers.reduce((m, l) => Math.max(m, l.id), 0);
      setSelectedId(newId);
      await resolveImages(p);
      await applyTime(timeRef.current);
      recordAction("duplicate_layer", { srcId, newId });
    },
    [resolveImages, applyTime, recordAction]
  );

  // Copy the selected layer to the clipboard; paste clones whatever was copied.
  const onCopyLayer = useCallback(() => {
    if (selectedIdRef.current != null) {
      copiedLayerRef.current = selectedIdRef.current;
      recordAction("copy_layer", { layerId: copiedLayerRef.current });
    }
  }, [recordAction]);

  const onPasteLayer = useCallback(() => {
    if (copiedLayerRef.current != null) void duplicateLayerById(copiedLayerRef.current);
  }, [duplicateLayerById]);

  const onDuplicateLayer = useCallback(() => {
    if (selectedIdRef.current != null) void duplicateLayerById(selectedIdRef.current);
  }, [duplicateLayerById]);

  // Cut a layer at a time into two segments; selects the new (second) segment.
  const onSplitLayer = useCallback(
    async (layerId: number, tMs: number) => {
      try {
        const p = await splitLayer(layerId, tMs);
        setProject(p);
        durationRef.current = p.durationMs;
        setSelectedId(p.layers.reduce((m, l) => Math.max(m, l.id), 0));
        await applyTime(timeRef.current);
        recordAction("split_layer", { layerId, tMs });
      } catch {
        // cut point outside the layer — ignore
      }
    },
    [applyTime, recordAction]
  );

  // Split the selected layer at the current playhead.
  const onSplitAtPlayhead = useCallback(() => {
    if (selectedIdRef.current != null) void onSplitLayer(selectedIdRef.current, Math.round(timeRef.current));
  }, [onSplitLayer]);

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

  // Set/clear a layer's in/out transition.
  const onSetLayerTransition = useCallback(
    async (
      layerId: number,
      slot: "in" | "out",
      kind: "none" | "dissolve" | "slide" | "wipe",
      durMs: number,
      direction: number,
      engine?: string | null,
      params?: string | null
    ) => {
      const p = await setLayerTransition(layerId, slot, kind, durMs, direction, engine, params);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("layer_transition", { layerId, slot, kind, durMs, direction, engine });
    },
    [applyTime, recordAction]
  );

  // Retime a keyframe by dragging its timeline diamond.
  const onMoveKeyframe = useCallback(
    async (layerId: number, fromMs: number, toMs: number) => {
      const p = await moveKeyframesAt(layerId, fromMs, toMs);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("move_keyframe", { layerId, fromMs, toMs });
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

  // Change the composition resolution / orientation and/or its length.
  const onApplyComp = useCallback(
    async (w: number, h: number, durationMs: number) => {
      let p = await setCompSize(w, h);
      if (durationMs !== p.durationMs) {
        p = await setCompDuration(durationMs);
      }
      setProject(p);
      durationRef.current = p.durationMs;
      // Keep the playhead inside the (possibly shorter) comp.
      if (timeRef.current > p.durationMs) seek(p.durationMs);
      else await applyTime(timeRef.current);
      recordAction("comp_settings", { w, h, durationMs: p.durationMs });
    },
    [applyTime, seek, recordAction]
  );

  // Scale an image layer to fit (contain) the composition and centre it.
  const onScaleToFit = useCallback(
    async (layerId: number) => {
      const p = await scaleLayerToFit(layerId);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("scale_to_fit", { layerId });
    },
    [applyTime, recordAction]
  );

  // Trim/move a layer's play range on the timeline (drag the block or its edges).
  const onSetLayerRange = useCallback(
    async (layerId: number, startMs: number, endMs: number) => {
      const p = await setLayerRange(layerId, startMs, endMs);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("layer_range", { layerId, startMs, endMs });
    },
    [applyTime, recordAction]
  );

  // Reorder the layer stack (drag one timeline row onto another). `order` is the
  // full id list bottom-first.
  const onReorder = useCallback(
    async (order: number[]) => {
      const p = await reorderLayers(order);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("reorder_layers", { order });
    },
    [applyTime, recordAction]
  );

  // Save As: always prompt for a .sefx path, write, and bind the project to it.
  // Returns true when the file was actually written.
  const doSaveAs = useCallback(async (): Promise<boolean> => {
    const path = await save({
      defaultPath: filePathRef.current ?? "untitled.sefx",
      filters: SEFX_FILTER,
    });
    if (!path) return false;
    try {
      await saveProjectFile(path);
      filePathRef.current = path;
      setFileName(baseName(path));
      setDirty(false);
      recordAction("save_as", { path });
      return true;
    } catch (e) {
      alert(`Save failed: ${e}`);
      return false;
    }
  }, [recordAction]);

  // Save: write to the bound file, or fall back to Save As if there isn't one.
  const doSave = useCallback(async (): Promise<boolean> => {
    if (!filePathRef.current) {
      return doSaveAs();
    }
    try {
      await saveProjectFile(filePathRef.current);
      setDirty(false);
      recordAction("save", { path: filePathRef.current });
      return true;
    } catch (e) {
      alert(`Save failed: ${e}`);
      return false;
    }
  }, [doSaveAs, recordAction]);

  // Close-confirmation prompt actions.
  const closeWithoutSaving = useCallback(async () => {
    setShowClosePrompt(false);
    await getCurrentWindow().destroy();
  }, []);
  const saveThenClose = useCallback(async () => {
    const ok = await doSave();
    if (ok) await getCurrentWindow().destroy();
    // If Save As was cancelled, keep the prompt open so nothing is lost.
  }, [doSave]);

  // Open a .sefx project, replacing the current one and loading its images.
  const doOpenProject = useCallback(async () => {
    const selected = await open({ multiple: false, filters: SEFX_FILTER });
    if (typeof selected !== "string") return;
    try {
      stop();
      const p = await openProjectFile(selected);
      pristineRef.current = true; // a freshly-opened file is not "unsaved"
      setProject(p);
      setDirty(false);
      durationRef.current = p.durationMs;
      filePathRef.current = selected;
      setFileName(baseName(selected));
      setSelectedId(null);
      setDecomposeId(null);
      await resolveImages(p);
      seek(0);
      recordAction("open_project", { path: selected });
    } catch (e) {
      alert(`Open failed: ${e}`);
    }
  }, [stop, resolveImages, seek, recordAction]);

  // Reflect the bound file name (and unsaved-changes dot) in the window title.
  useEffect(() => {
    document.title = `${dirty ? "• " : ""}${fileName ?? "Untitled"} — Simple Effects`;
  }, [fileName, dirty]);

  // Render the comp to a video. Preferred path is DETERMINISTIC: render every
  // frame at full resolution, then encode it with an exact timestamp via
  // WebCodecs (VP9 → WebM) so the output is exactly `fps` with no dropped or
  // duplicated frames regardless of how fast rendering is. Falls back to a
  // real-time MediaRecorder capture if WebCodecs isn't available. MP4 is the
  // WebM transcoded by Rust/ffmpeg. `level` 1..5 = compression/bitrate.
  const onExport = useCallback(
    async (format: "mp4" | "webm", level: number, fps: number, burnFps: boolean) => {
      let p = projectRef.current;
      if (!p || exportingRef.current) return;
      // Persist the chosen frame rate as the comp's fps (keeps toolbar/preview in
      // sync and is what the capture runs at).
      if (fps !== p.fps) {
        p = await setCompFps(fps);
        setProject(p);
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const path = await save({
        defaultPath: `render-${stamp}.${format}`,
        filters: [{ name: `${format.toUpperCase()} video`, extensions: [format] }],
      });
      if (!path) return;

      stop();
      setSelectedId(null);
      // Burn the fps label into the frames if requested.
      setFpsOverlay(burnFps ? fps : null);
      exportingRef.current = true;
      setExporting(true);
      setExportMsg("Preparing…");
      try {
        // Let the preview re-render at full resolution (export scale) first.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const canvas = document.querySelector(".preview-stage canvas") as HTMLCanvasElement | null;
        if (!canvas) throw new Error("preview canvas not found");
        const probing = isProbeEnabled();
        if (probing) {
          // Record what's being tested so the dump self-documents the effect(s).
          const trInfo = (t: (typeof p.layers)[number]["transitionIn"]) =>
            t ? { engine: t.engine, kind: t.kind, durMs: t.durMs, direction: t.direction, params: t.params } : null;
          const subjectLayers = p.layers.map((l) => ({
            layerId: l.id,
            name: l.name,
            transitionIn: trInfo(l.transitionIn),
            transitionOut: trInfo(l.transitionOut),
            effects: l.effects.map((e) => e.kind),
            textStyle: l.kind.kind === "text" ? !!l.kind.style : undefined,
            textAnimators: l.kind.kind === "text" ? l.kind.animators.length : undefined,
          }));
          const transitions = [
            ...new Set(
              subjectLayers
                .flatMap((s) => [s.transitionIn, s.transitionOut])
                .filter((t): t is NonNullable<typeof t> => !!t)
                .map((t) => t.engine ?? t.kind)
            ),
          ];
          const effectKinds = [...new Set(subjectLayers.flatMap((s) => s.effects))];
          beginProbeRun(
            { width: p.width, height: p.height, fps: p.fps, durationMs: p.durationMs },
            new Date().toISOString(),
            { transitions, effectKinds, layers: subjectLayers }
          );
        }
        const duration = p.durationMs;
        const bitrate = bitrateForLevel(level);

        // Wait for the canvas to actually paint the latest applied time.
        const awaitPaint = () =>
          new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

        // Realtime capture (fallback) — captures the canvas via MediaRecorder as
        // the comp plays in wall-clock time. Used only when WebCodecs is absent.
        const realtimeCapture = async (): Promise<Blob> => {
          const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
            ? "video/webm;codecs=vp9"
            : "video/webm";
          const rec = new MediaRecorder(canvas.captureStream(fps), {
            mimeType: mime,
            videoBitsPerSecond: bitrate,
          });
          const chunks: BlobPart[] = [];
          rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
          const stopped = new Promise<void>((res) => (rec.onstop = () => res()));
          rec.start();
          const startWall = performance.now();
          let lastProbe = -Infinity;
          await new Promise<void>((resolve) => {
            const tick = async () => {
              const t = performance.now() - startWall;
              if (t >= duration) {
                await applyTime(duration);
                if (probing) {
                  await awaitPaint();
                  probePreview(canvas, duration);
                }
                resolve();
                return;
              }
              setExportMsg(`Rendering… ${Math.round((t / duration) * 100)}%`);
              await applyTime(t);
              if (probing && t - lastProbe >= 150) {
                lastProbe = t;
                await awaitPaint();
                probePreview(canvas, t);
              }
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
          await new Promise((r) => setTimeout(r, 250));
          rec.stop();
          await stopped;
          return new Blob(chunks, { type: mime });
        };

        // Deterministic path: render each frame, encode with an exact timestamp.
        let blob: Blob | null = null;
        if (isDeterministicSupported()) {
          try {
            setExportMsg("Rendering frames…");
            let lastPct = -1;
            const bytes = await encodeDeterministicWebm({
              canvas,
              width: p.width,
              height: p.height,
              fps,
              durationMs: duration,
              bitrate,
              renderFrame: async (tMs) => {
                await applyTime(tMs);
                await awaitPaint();
              },
              onFrameRendered: probing ? (tMs) => probePreview(canvas, tMs) : undefined,
              onProgress: (frac) => {
                const pct = Math.round(frac * 100);
                if (pct !== lastPct) {
                  lastPct = pct;
                  setExportMsg(`Rendering frame-accurate… ${pct}%`);
                }
              },
              shouldAbort: () => !exportingRef.current,
            });
            blob = new Blob([bytes], { type: "video/webm" });
          } catch (e) {
            console.warn("deterministic export failed; falling back to realtime", e);
            blob = null;
          }
        }
        if (!blob) blob = await realtimeCapture();

        // Decode the produced video and probe its real frames (output trace).
        if (probing) {
          setExportMsg("Analysing output video…");
          try {
            await analyzeOutputVideo(blob);
          } catch (e) {
            console.warn("output probe failed", e);
          }
          record("render_probe", lastProbeReport());
        }

        setExportMsg(format === "mp4" ? "Encoding MP4 (ffmpeg)…" : "Saving…");
        const base64 = await blobToBase64(blob);
        await exportVideo(base64, path, format, level);
        recordAction("export_video", { path, format, level, deterministic: isDeterministicSupported() });
        alert(`Saved video:\n${path}`);
      } catch (e) {
        alert(`Export failed: ${e}`);
      } finally {
        exportingRef.current = false;
        setExporting(false);
        setFpsOverlay(null);
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
      const t = Math.round(timeRef.current);
      const layer = projectRef.current?.layers.find((l) => l.id === layerId);
      const seedStart = layer ? t > layer.startMs : false;
      const p = await setTextColor(layerId, color, t, seedStart);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("text_color", { layerId, color, timeMs: t });
    },
    [applyTime, recordAction]
  );

  const onClearColorKeys = useCallback(
    async (layerId: number, color: Rgba) => {
      const p = await clearTextColorKeys(layerId, color);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("text_color_clear", { layerId });
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

  // Set / clear a text layer's typographic + fill/stroke style.
  const onSetTextStyle = useCallback(
    async (layerId: number, style: TextStyle | null) => {
      const p = await setTextStyle(layerId, style);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("text_style", { layerId });
    },
    [applyTime, recordAction]
  );

  // Set a text layer's per-character animators.
  const onSetTextAnimators = useCallback(
    async (layerId: number, animators: TextAnimator[]) => {
      const p = await setTextAnimators(layerId, animators);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("text_animators", { layerId });
    },
    [applyTime, recordAction]
  );

  // Set / clear a text layer's whole-layer styles.
  const onSetTextLayerStyles = useCallback(
    async (layerId: number, styles: TextLayerStyles | null) => {
      const p = await setTextLayerStyles(layerId, styles);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("text_layer_styles", { layerId });
    },
    [applyTime, recordAction]
  );

  // Toggle per-character 3D on a text layer + its base rotation controls.
  const onSetTextPerChar3d = useCallback(
    async (layerId: number, enabled: boolean, rx: number, ry: number, spread: number) => {
      const p = await setTextPerChar3d(layerId, enabled, rx, ry, spread);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("text_3d", { layerId, enabled });
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
        setRazor(false);
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
      // Transport + playhead navigation (not while typing in a field).
      if (!inField) {
        // Space toggles play/pause globally — no need to focus the button first.
        if (e.key === " " || e.code === "Space") {
          e.preventDefault();
          if (playingRef.current) stop();
          else play();
          return;
        }
        // Left/Right step the playhead by one frame.
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const fps = projectRef.current?.fps || 30;
          const step = 1000 / fps;
          const dir = e.key === "ArrowLeft" ? -1 : 1;
          const t = Math.max(0, Math.min(durationRef.current, timeRef.current + dir * step));
          seek(Math.round(t));
          return;
        }
        // Up/Down jump the playhead to the end/start of the layer it's in
        // (the selected layer, else the topmost layer under the playhead).
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const p = projectRef.current;
          if (!p) return;
          const now = timeRef.current;
          let layer = p.layers.find((l) => l.id === selectedIdRef.current) ?? null;
          if (!layer) {
            for (let i = p.layers.length - 1; i >= 0; i--) {
              const l = p.layers[i];
              if (now >= l.startMs && now <= l.endMs) {
                layer = l;
                break;
              }
            }
          }
          if (!layer) return;
          seek(e.key === "ArrowUp" ? layer.endMs : layer.startMs);
          return;
        }
      }
      const mod = e.ctrlKey || e.metaKey;
      // File ops work even from a text field (no browser default to preserve).
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (e.shiftKey) void doSaveAs();
        else void doSave();
        return;
      }
      if (mod && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        void doOpenProject();
        return;
      }
      // Layer copy/paste/duplicate — only outside text fields (so inputs keep
      // their native clipboard behaviour).
      if (mod && (e.key === "c" || e.key === "C")) {
        if (inField || selectedIdRef.current == null) return;
        e.preventDefault();
        onCopyLayer();
        return;
      }
      if (mod && (e.key === "v" || e.key === "V")) {
        if (inField || copiedLayerRef.current == null) return;
        e.preventDefault();
        onPasteLayer();
        return;
      }
      if (mod && (e.key === "d" || e.key === "D")) {
        if (inField || selectedIdRef.current == null) return;
        e.preventDefault();
        onDuplicateLayer();
        return;
      }
      if (mod && (e.key === "k" || e.key === "K")) {
        if (inField || selectedIdRef.current == null) return;
        e.preventDefault();
        onSplitAtPlayhead();
        return;
      }
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
  }, [
    doUndo,
    doRedo,
    onDeleteLayer,
    decomposeId,
    doSave,
    doSaveAs,
    doOpenProject,
    onCopyLayer,
    onPasteLayer,
    onDuplicateLayer,
    onSplitAtPlayhead,
    seek,
    play,
    stop,
  ]);

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
  // The selected text layer's fill colour AT THE PLAYHEAD (so the swatch shows the
  // keyframed colour at the current time, not the static/first-key colour).
  const textColorNow = (selectedId != null ? resolved[selectedId]?.color : null) ?? null;
  // The selected decomposed letter's resolved fill at the playhead (for its swatch).
  const letterColorNow =
    selectedId != null && selectedPart != null
      ? resolved[selectedId]?.letters[selectedPart]?.fill ?? null
      : null;
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
  // A curated shortcut list of transition-engine effects for the clip right-click
  // menu (the full library lives in the Inspector's Transitions section).
  const transitionShortlist: [string, string][] = [
    ["fade", "Fade"],
    ["crossDissolve", "Cross Dissolve"],
    ["slide", "Slide"],
    ["horizontalWipe", "Wipe"],
    ["cube", "Cube"],
    ["cardFlip3d", "Card Flip"],
    ["zoomIn", "Zoom In"],
    ["glitch", "Glitch"],
    ["shatter", "Shatter"],
    ["whipPan", "Whip Pan"],
    ["pageTurn", "Page Turn"],
  ];
  const transitionSubmenu = (lid: number, slot: "in" | "out") => [
    { label: "None", onClick: () => onSetLayerTransition(lid, slot, "none", 800, 0, null) },
    ...transitionShortlist.map(([id, label]) => ({
      label,
      onClick: () => onSetLayerTransition(lid, slot, "dissolve", 800, 0, id),
    })),
  ];

  const menus: MenuDef[] = [
    {
      title: "File",
      items: [
        { label: "Open…", onClick: () => void doOpenProject(), shortcut: "Ctrl+O" },
        { label: "Save", onClick: () => void doSave(), shortcut: "Ctrl+S" },
        { label: "Save As…", onClick: () => void doSaveAs(), shortcut: "Ctrl+Shift+S" },
        { separator: true },
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
          label: "Copy Layer",
          onClick: onCopyLayer,
          disabled: selectedId == null,
          shortcut: "Ctrl+C",
        },
        {
          label: "Paste Layer",
          onClick: onPasteLayer,
          shortcut: "Ctrl+V",
        },
        {
          label: "Duplicate Layer",
          onClick: onDuplicateLayer,
          disabled: selectedId == null,
          shortcut: "Ctrl+D",
        },
        {
          label: "Split at Playhead",
          onClick: onSplitAtPlayhead,
          disabled: selectedId == null,
          shortcut: "Ctrl+K",
        },
        {
          label: (razor ? "✓ " : "") + "Cut Tool (click to split)",
          onClick: () => setRazor((v) => !v),
        },
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
        {
          label: "Transitions Demo…",
          onClick: () => setShowTransitions(true),
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
        <span className="filename" title={filePathRef.current ?? "Unsaved project"}>
          {fileName ?? "Untitled"}
          {dirty && <span className="dirty-dot" title="Unsaved changes"> •</span>}
        </span>
        <button
          className="primary"
          onClick={(e) => {
            // Blur so the button doesn't keep focus — otherwise Space would fire
            // both this button's native activation and the global toggle.
            e.currentTarget.blur();
            if (playing) stop();
            else play();
          }}
        >
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button onClick={setKeyHere} disabled={!selectedLayer} title="Add keyframe at playhead">
          ◆ Key
        </button>
        <button onClick={doUndo} title="Undo (Ctrl+Z)">↶</button>
        <button onClick={doRedo} title="Redo (Ctrl+Shift+Z)">↷</button>
        <button
          className={razor ? "cut on" : "cut"}
          onClick={() => setRazor((v) => !v)}
          title="Cut tool — click a timeline block to split it (Ctrl+K splits at playhead; Esc exits)"
        >
          ✂
        </button>
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
        <span
          className="fps"
          title="Live preview frame rate while playing (target is the comp fps)"
        >
          {playing ? `${previewFps} fps` : `${project.fps} fps`}
        </span>
        <span className="meta">
          {project.width}×{project.height}
        </span>
      </header>

      <div className="mid">
        <main className="stage-area">
          <Preview
            project={project}
            resolved={resolved}
            images={images}
            timeMs={time}
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
            onLayerContextMenu={onLayerContextMenu}
            exporting={exporting}
            fpsOverlay={fpsOverlay}
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
          fonts={fonts}
          onRefreshFonts={refreshFonts}
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
          textColorNow={textColorNow}
          selectedPart={selectedPart}
          letterColorNow={letterColorNow}
          onContent={onSetContent}
          onColor={onSetColor}
          onClearColorKeys={onClearColorKeys}
          onFont={onSetFont}
          onAnim={onSetAnim}
          onSetTextStyle={onSetTextStyle}
          onSetTextAnimators={onSetTextAnimators}
          onSetTextLayerStyles={onSetTextLayerStyles}
          onSetTextPerChar3d={onSetTextPerChar3d}
          onToggleDecompose={toggleDecompose}
          onClearParts={onClearParts}
          onLetterColor={onLetterColor}
          onClearLetterColor={onClearLetterColor}
          onDecomposeKey={onDecomposeKey}
          onSetLayerTransition={onSetLayerTransition}
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
        onMoveKeyframe={onMoveKeyframe}
        onLayerContextMenu={onLayerContextMenu}
        onSetLayerRange={onSetLayerRange}
        onReorder={onReorder}
        razor={razor}
        onSplitLayer={onSplitLayer}
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
                    ...(project.layers.find((l) => l.id === ctxMenu.layerId)?.kind.kind === "image"
                      ? [
                          {
                            label: "⤢ Scale to fit",
                            onClick: () => onScaleToFit(ctxMenu.layerId!),
                          },
                          {
                            label: "＋ Add effect",
                            submenu: [
                              ...effectKinds.map(([kind, label]) => ({
                                label,
                                onClick: () => onAddEffect(ctxMenu.layerId!, kind),
                              })),
                              // The transition-engine effects (from the demo),
                              // applied as this clip's IN transition.
                              ...transitionShortlist.map(([id, label]) => ({
                                label: `⇋ ${label} (in)`,
                                onClick: () => onSetLayerTransition(ctxMenu.layerId!, "in", "dissolve", 800, 0, id),
                              })),
                            ],
                          },
                          {
                            label: "✎ Open effect editor…",
                            onClick: () => setFxEditorId(ctxMenu.layerId!),
                          },
                          {
                            label: "⇋ Transition in",
                            submenu: transitionSubmenu(ctxMenu.layerId!, "in"),
                          },
                          {
                            label: "⇋ Transition out",
                            submenu: transitionSubmenu(ctxMenu.layerId!, "out"),
                          },
                        ]
                      : [{ label: "Effects — image layers only" }]),
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
          durationMs={project.durationMs}
          onApply={onApplyComp}
          onClose={() => setShowCompSettings(false)}
        />
      )}

      {showExportDialog && (
        <ExportDialog
          defaultFps={project.fps}
          onExport={onExport}
          onClose={() => setShowExportDialog(false)}
        />
      )}

      {showTransitions && <TransitionsDemo onClose={() => setShowTransitions(false)} />}

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

      {showClosePrompt && (
        <div className="modal-backdrop" onMouseDown={() => setShowClosePrompt(false)}>
          <div className="modal-box" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Unsaved changes</h3>
            <p className="modal-text">
              You have unsaved changes{fileName ? ` in “${fileName}”` : ""}. Do you want to save
              before closing?
            </p>
            <div className="modal-actions">
              <button className="insp-btn" onClick={() => setShowClosePrompt(false)}>
                Cancel
              </button>
              <button className="insp-btn modal-danger" onClick={closeWithoutSaving}>
                Close without saving
              </button>
              <button className="insp-btn active" onClick={saveThenClose}>
                Save &amp; close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
