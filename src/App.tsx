import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import Konva from "konva";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import Preview from "./components/Preview";
import Timeline from "./components/Timeline";
import Inspector from "./components/Inspector";
import MediaPanel from "./components/MediaPanel";
import AudioLayers from "./components/AudioLayers";
import {
  mediaKind,
  getVideoMeta,
  getAudioMeta,
  getVideoPoster,
  seekVideosForFrame,
  IMPORT_EXTENSIONS,
} from "./lib/media";
import RecorderPanel from "./components/RecorderPanel";
import ContextMenu from "./components/ContextMenu";
import MenuBar, { type MenuDef } from "./components/MenuBar";
import CompSettings from "./components/CompSettings";
import UiSizeDialog from "./components/UiSizeDialog";
import EffectEditor from "./components/EffectEditor";
import ExportDialog from "./components/ExportDialog";
import TransitionsDemo from "./components/TransitionsDemo";
import {
  addEffect,
  addFrameGrid,
  setMedia as apiSetMedia,
  addImageLayer,
  addVideoLayer,
  addAudioLayer,
  placeLayer,
  combineLayers,
  explodeLayer,
  enterGroup,
  exitGroup,
  addShapeLayer,
  addShape2dLayer,
  setShape2d,
  setCellImage,
  clearCellImage,
  setGridBackground,
  clearGridBackground,
  setCellTransition,
  setAllCellsTransition,
  setCellZoom,
  setCellPan,
  setGridVertices,
  setGridConstrain,
  setGridLineWidth,
  setGridLineColor,
  clearGridLineColor,
  mergeCell,
  splitCell,
  addCellEffect,
  removeCellEffect,
  keyCellEffect,
  setCellWipeStatic,
  setCellShineStatic,
  setCellGpuFxStatic,
  pasteCellEffects,
  pasteCellEffectsAll,
  moveCellKeyframesAt,
  deleteCellKeyframesAt,
  linkEffect,
  addLinkedEffect,
  removeLinkedEffectItem,
  keyLinkedEffect,
  setLinkedWipeStatic,
  removeLinkedGroup,
  setLinkedMember,
  unlinkCell,
  addTextLayer,
  addAdjustmentLayer,
  setCompSize,
  setCompDuration,
  setCompFps,
  setLayerRange,
  scaleLayerToFit,
  setLayerTransition,
  reorderLayers,
  saveProjectFile,
  openProjectFile,
  newProject,
  takeLaunchFile,
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
  setShineStatic,
  setGpuFxStatic,
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
  setTextFontStyle,
  listFonts,
  setTextStyle,
  setTextAnimators,
  setTextLayerStyles,
  setTextPerChar3d,
  undo,
} from "./lib/api";
import type { EffectParam } from "./lib/api";
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
  setProbeDebug,
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
import type { Effect } from "./bindings/Effect";
import type { SurfaceShape } from "./bindings/SurfaceShape";
import type { VectorShape } from "./bindings/VectorShape";
import type { Shape2DStyle } from "./bindings/Shape2DStyle";
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

// Resizable-panel layout: the built-in defaults, the persistence key, and the
// clamp bounds for each panel. The user drags the splitters to resize live, then
// saves the current sizes as the default via Window → UI size.
const UI_LAYOUT_KEY = "sefx.uiLayout";
type UiLayout = { mediaW: number; inspectorW: number; timelineH: number; labelsW: number };
const DEFAULT_LAYOUT: UiLayout = { mediaW: 180, inspectorW: 300, timelineH: 224, labelsW: 160 };
const LAYOUT_BOUNDS = {
  mediaW: [120, 420] as const,
  inspectorW: [200, 760] as const,
  timelineH: [120, 900] as const,
  labelsW: [100, 480] as const,
};
function clampLayout(key: keyof UiLayout, v: unknown): number {
  const [lo, hi] = LAYOUT_BOUNDS[key];
  return typeof v === "number" && Number.isFinite(v)
    ? Math.max(lo, Math.min(hi, v))
    : DEFAULT_LAYOUT[key];
}
function loadUiLayout(): UiLayout {
  try {
    const v = JSON.parse(localStorage.getItem(UI_LAYOUT_KEY) || "{}") as Partial<UiLayout>;
    return {
      mediaW: clampLayout("mediaW", v.mediaW),
      inspectorW: clampLayout("inspectorW", v.inspectorW),
      timelineH: clampLayout("timelineH", v.timelineH),
      labelsW: clampLayout("labelsW", v.labelsW),
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

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
  // The live Konva preview Stage — used to force a synchronous redraw per frame
  // during deterministic export (the `Konva.stages` global can be empty under
  // bundler dedup, so we draw THIS stage directly instead).
  const previewStageRef = useRef<Konva.Stage | null>(null);
  const [images, setImages] = useState<Record<string, string>>({});
  const [fonts, setFonts] = useState<string[]>([]);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Resizable panels: media-bin width, inspector width, timeline height, and the
  // timeline's layers-column width (px). Dragged live via splitters; the default
  // (loaded here) is saved via Window → UI size.
  const savedLayout = useRef(loadUiLayout()).current;
  const [inspectorW, setInspectorW] = useState(savedLayout.inspectorW);
  const [mediaW, setMediaW] = useState(savedLayout.mediaW);
  const [timelineH, setTimelineH] = useState(savedLayout.timelineH);
  const [labelsW, setLabelsW] = useState(savedLayout.labelsW);
  const [showUiSize, setShowUiSize] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Multi-selection of layers (timeline area): every selected id, with
  // `selectedId` as the primary (drives the inspector / preview transformer).
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  // Group-editing breadcrumb: each entry is a group we've descended into (root =
  // empty). The Rust side swaps the editing scope; this is the UI trail.
  const [groupPath, setGroupPath] = useState<{ id: number; name: string }[]>([]);
  // The media bin (imported image/video/audio paths, not necessarily placed yet).
  // It belongs to the project: saved into the .sefx file and restored on open, so
  // a new project starts empty while a saved file reopens with its media.
  const [media, setMedia] = useState<string[]>([]);
  // Thumbnails for non-image media (video poster frames), path → data URL.
  const [mediaThumbs, setMediaThumbs] = useState<Record<string, string>>({});
  // True while an OS file drag is hovering the window (shows the drop overlay).
  const [fileDragging, setFileDragging] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recCount, setRecCount] = useState(0);
  const [showRecorder, setShowRecorder] = useState(false);
  const [decomposeId, setDecomposeId] = useState<number | null>(null);
  const [selectedPart, setSelectedPart] = useState<number | null>(null);
  // The grid cell currently selected for image editing (row-major index).
  const [selectedCell, setSelectedCell] = useState<{ layerId: number; cell: number } | null>(null);
  // Multi-frame grid creation dialog (null = closed).
  const [gridDialog, setGridDialog] = useState<{ rows: number; cols: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<
    { x: number; y: number; shapeId?: number; layerId?: number; cell?: number } | null
  >(null);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState("");
  const exportingRef = useRef(false);
  const [showCompSettings, setShowCompSettings] = useState(false);
  const [fxEditorId, setFxEditorId] = useState<number | null>(null);
  const [showExportDialog, setShowExportDialog] = useState(false);
  // Optional export range [inMs, outMs] — the section of the comp to render.
  // Null = export the whole comp. Set by Shift-dragging the timeline ruler. A ref
  // mirrors it so the export loop (a stable callback) can read the latest value.
  const [exportRange, setExportRange] = useState<{ inMs: number; outMs: number } | null>(null);
  const exportRangeRef = useRef(exportRange);
  exportRangeRef.current = exportRange;
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
  const selectedIdsRef = useRef<number[]>([]);
  const lastSeekRecRef = useRef(0);
  // Monotonic counter for style edits (shape2d / shape3d params). Each edit does
  // an optimistic project update, then awaits the backend. Because invoke
  // responses can arrive out of order, an earlier edit's response could land
  // after a later one and overwrite it (dropping the newer keyframe). The guard
  // makes the post-await setProject apply only when it's still the latest edit.
  const styleEditSeq = useRef(0);

  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { resolvedRef.current = resolved; }, [resolved]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  const groupPathRef = useRef<{ id: number; name: string }[]>([]);
  useEffect(() => { groupPathRef.current = groupPath; }, [groupPath]);

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
      // Every image path referenced anywhere: flat image layers + grid cells.
      const srcs: string[] = [];
      for (const layer of p.layers) {
        if (layer.kind.kind === "image") srcs.push(layer.kind.src);
        else if (layer.kind.kind === "framegrid") {
          for (const cell of layer.kind.cells) if (cell.src) srcs.push(cell.src);
          if (layer.kind.background) srcs.push(layer.kind.background);
        }
      }
      for (const src of srcs) {
        if (!images[src] && !next[src]) {
          try {
            next[src] = await loadImageDataUrl(src);
          } catch (e) {
            console.warn("load image", src, e);
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
      await loadProjectMedia(p);
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

  // Drag the vertical splitter to resize the media bin (left panel).
  const startMediaResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = mediaW;
    const move = (ev: MouseEvent) => {
      setMediaW(Math.max(120, Math.min(420, startW + (ev.clientX - startX))));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // Drag the vertical splitter to resize the inspector (right panel). Dragging
  // left widens it (it's anchored to the right edge).
  const startInspectorResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = inspectorW;
    const move = (ev: MouseEvent) => {
      setInspectorW(Math.max(200, Math.min(760, startW - (ev.clientX - startX))));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // Drag the horizontal splitter to resize the timeline (bottom panel). Dragging
  // up makes it taller (it's anchored to the bottom edge).
  const startTimelineResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = timelineH;
    const move = (ev: MouseEvent) => {
      const max = window.innerHeight - 220;
      setTimelineH(Math.max(120, Math.min(max, startH - (ev.clientY - startY))));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };

  // Save the current panel sizes as the default layout (persisted). Reset restores
  // the built-in defaults. Both apply immediately.
  const saveUiLayout = useCallback(() => {
    const layout: UiLayout = { mediaW, inspectorW, timelineH, labelsW };
    try {
      localStorage.setItem(UI_LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* ignore quota / unavailable */
    }
  }, [mediaW, inspectorW, timelineH, labelsW]);

  const resetUiLayout = useCallback(() => {
    setMediaW(DEFAULT_LAYOUT.mediaW);
    setInspectorW(DEFAULT_LAYOUT.inspectorW);
    setTimelineH(DEFAULT_LAYOUT.timelineH);
    setLabelsW(DEFAULT_LAYOUT.labelsW);
    try {
      localStorage.removeItem(UI_LAYOUT_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const setLayoutValue = useCallback((key: keyof UiLayout, v: number) => {
    const val = clampLayout(key, v);
    if (key === "mediaW") setMediaW(val);
    else if (key === "inspectorW") setInspectorW(val);
    else if (key === "timelineH") setTimelineH(val);
    else setLabelsW(val);
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
    const above = selectedIdRef.current;
    let p = await addImageLayer(selected);
    // Select the layer we just added so it's ready to move/scale.
    const newId = p.layers.length ? p.layers[p.layers.length - 1].id : null;
    if (newId != null) {
      p = await placeLayer(newId, Math.round(timeRef.current), above);
      setSelectedId(newId);
    }
    setProject(p);
    await resolveImages(p);
    await applyTime(timeRef.current);
    recordAction("add_image", { layerId: newId, path: selected });
  }, [resolveImages, applyTime, recordAction]);

  // --- Media bin ---------------------------------------------------------
  // Load thumbnails for a set of media paths (image data URLs / video poster
  // frames) into the shared caches. Best-effort — a failed thumbnail just leaves
  // the placeholder icon.
  const loadMediaThumbs = useCallback(async (paths: string[]) => {
    const imgThumbs: Record<string, string> = {};
    const vidThumbs: Record<string, string> = {};
    for (const src of paths) {
      const kind = mediaKind(src);
      try {
        if (kind === "image") imgThumbs[src] = await loadImageDataUrl(src);
        else if (kind === "video") vidThumbs[src] = await getVideoPoster(src);
      } catch (e) {
        console.warn("thumbnail", src, e);
      }
    }
    if (Object.keys(imgThumbs).length) setImages((m) => ({ ...m, ...imgThumbs }));
    if (Object.keys(vidThumbs).length) setMediaThumbs((m) => ({ ...m, ...vidThumbs }));
  }, []);

  // Add image/video/audio files to the bin (dedup) and load their thumbnails.
  // Load a project's saved media bin into the display state (+ thumbnails). Used
  // on initial load and when opening a file, so a saved project reopens with its
  // media and a new/blank project shows an empty bin.
  const loadProjectMedia = useCallback(
    async (p: Project) => {
      const list = p.media ?? [];
      setMedia(list);
      setMediaThumbs({});
      if (list.length) await loadMediaThumbs(list);
    },
    [loadMediaThumbs]
  );

  // Accepts dialog or OS-drop paths. Adds to the bin (dedup) and persists the new
  // list onto the project (so it's saved with the file) — the project is the
  // single source of truth for the bin.
  const addMediaPaths = useCallback(async (paths: string[]) => {
    const supported = paths.filter((p) => mediaKind(p) != null);
    if (!supported.length) return;
    const cur = projectRef.current?.media ?? [];
    const seen = new Set(cur);
    const additions = supported.filter((p) => !seen.has(p));
    if (additions.length) {
      const next = [...cur, ...additions];
      const proj = await apiSetMedia(next);
      setProject(proj);
      setMedia(next);
    }
    await loadMediaThumbs(supported);
    recordAction("media_import", { count: supported.length });
  }, [loadMediaThumbs, recordAction]);

  const onImportMedia = useCallback(async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: "Media", extensions: IMPORT_EXTENSIONS }],
    });
    const paths = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
    if (paths.length) await addMediaPaths(paths);
  }, [addMediaPaths]);

  const onAddMediaToTimeline = useCallback(async (path: string) => {
    const kind = mediaKind(path);
    // Capture the layer selected at add-time — the new one slots just above it.
    const above = selectedIdRef.current;
    let p: Project;
    if (kind === "video") {
      const meta = await getVideoMeta(path).catch(() => ({ width: 1280, height: 720, durationMs: 0 }));
      p = await addVideoLayer(path, meta.width, meta.height, meta.durationMs);
    } else if (kind === "audio") {
      const meta = await getAudioMeta(path).catch(() => ({ durationMs: 0 }));
      p = await addAudioLayer(path, meta.durationMs);
    } else {
      p = await addImageLayer(path);
      await resolveImages(p);
    }
    const newId = p.layers.length ? p.layers[p.layers.length - 1].id : null;
    // Drop it at the playhead and directly above the previously selected layer.
    if (newId != null) {
      p = await placeLayer(newId, Math.round(timeRef.current), above);
      setSelectedId(newId);
    }
    setProject(p);
    durationRef.current = p.durationMs;
    await applyTime(timeRef.current);
    recordAction("add_media", { layerId: newId, path, kind });
  }, [resolveImages, applyTime, recordAction]);

  const onRemoveMedia = useCallback(async (path: string) => {
    const next = (projectRef.current?.media ?? []).filter((p) => p !== path);
    const proj = await apiSetMedia(next);
    setProject(proj);
    setMedia(next);
  }, []);

  // OS file drag-and-drop: WebView2 hands file drops to Tauri (not the DOM), so
  // we listen on the webview and add any dropped images to the media bin.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "over") setFileDragging(true);
        else if (p.type === "leave") setFileDragging(false);
        else if (p.type === "drop") {
          setFileDragging(false);
          if (p.paths?.length) void addMediaPaths(p.paths);
        }
      })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addMediaPaths]);

  const onAddText = useCallback(async () => {
    const above = selectedIdRef.current;
    let p = await addTextLayer("سلام", 140);
    const newId = p.layers.length ? p.layers[p.layers.length - 1].id : null;
    // Slot at the playhead, directly above the previously selected layer.
    if (newId != null) {
      p = await placeLayer(newId, Math.round(timeRef.current), above);
      setSelectedId(newId);
    }
    setProject(p);
    await applyTime(timeRef.current);
    recordAction("add_text", { layerId: newId });
  }, [applyTime, recordAction]);

  // Add a whole-comp adjustment layer (seeded with a shiny-clouds effect).
  const onAddAdjustment = useCallback(async () => {
    const above = selectedIdRef.current;
    let p = await addAdjustmentLayer();
    const newId = p.layers.length ? p.layers[p.layers.length - 1].id : null;
    if (newId != null) {
      p = await placeLayer(newId, Math.round(timeRef.current), above);
      setSelectedId(newId);
    }
    setProject(p);
    durationRef.current = p.durationMs;
    await applyTime(timeRef.current);
    recordAction("add_adjustment", { layerId: newId });
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
      const above = selectedIdRef.current;
      let p = await addShapeLayer(shape);
      const newId = p.layers.length ? p.layers[p.layers.length - 1].id : null;
      if (newId != null) {
        p = await placeLayer(newId, Math.round(timeRef.current), above);
        setSelectedId(newId);
      }
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("add_shape", { shape, layerId: newId });
    },
    [applyTime, recordAction]
  );

  // Add a 2D vector shape (rectangle/circle/polygon) at the playhead, above the
  // selected layer — same placement flow as the other layer types.
  const onAddShape2d = useCallback(
    async (shape: VectorShape) => {
      const above = selectedIdRef.current;
      let p = await addShape2dLayer(shape);
      const newId = p.layers.length ? p.layers[p.layers.length - 1].id : null;
      if (newId != null) {
        p = await placeLayer(newId, Math.round(timeRef.current), above);
        setSelectedId(newId);
      }
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("add_shape2d", { shape, layerId: newId });
    },
    [applyTime, recordAction]
  );

  // Edit a Shape2D layer's paint style (fill/border/glow/shadow — the inspector
  // builds the colour keys + tracks and sends the whole style).
  const onSetShape2d = useCallback(
    async (layerId: number, style: Shape2DStyle) => {
      // Optimistically reflect the edit in the layer immediately, so the
      // inspector re-renders with the new style (keyframe state + tracks) before
      // the async round-trip returns. Without this, keyframing a second property
      // right after a first can build on the pre-round-trip style and clobber the
      // first keyframe.
      const seq = ++styleEditSeq.current;
      setProject((prev) =>
        prev
          ? {
              ...prev,
              layers: prev.layers.map((l) =>
                l.id === layerId && l.kind.kind === "shape2d"
                  ? { ...l, kind: { ...l.kind, style } }
                  : l
              ),
            }
          : prev
      );
      const p = await setShape2d(layerId, style);
      // Ignore a response that a newer edit has already superseded (out-of-order
      // invoke resolution would otherwise revert the newer keyframe).
      if (seq === styleEditSeq.current) setProject(p);
      await applyTime(timeRef.current);
      recordAction("set_shape2d", { layerId });
    },
    [applyTime, recordAction]
  );

  // Create a multi-frame grid (rows×cols) and select it.
  const onAddFrameGrid = useCallback(
    async (rows: number, cols: number) => {
      const above = selectedIdRef.current;
      let p = await addFrameGrid(rows, cols);
      const newId = p.layers.length ? p.layers[p.layers.length - 1].id : null;
      if (newId != null) {
        p = await placeLayer(newId, Math.round(timeRef.current), above);
        setSelectedId(newId);
      }
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("add_frame_grid", { rows, cols, layerId: newId });
    },
    [applyTime, recordAction]
  );

  // A grid cell was clicked → select the layer and mark the cell for editing.
  const onPickCell = useCallback((layerId: number, cell: number) => {
    setSelectedId(layerId);
    setSelectedCell({ layerId, cell });
  }, []);

  // Clipboard for a grid cell's whole effect stack (copy one cell → paste onto
  // others). Held in state so the context menu's "Paste" enables reactively.
  const [cellClip, setCellClip] = useState<Effect[] | null>(null);

  // Copy one cell's effect stack (a deep clone so later edits don't mutate it).
  const onCopyCellEffects = useCallback((layerId: number, cell: number) => {
    const layer = projectRef.current?.layers.find((l) => l.id === layerId);
    if (layer?.kind.kind !== "framegrid") return;
    const fx = layer.kind.cells[cell]?.effects ?? [];
    setCellClip(structuredClone(fx));
  }, []);

  // Paste the clipboard onto one cell (replaces its stack). `effects` overrides
  // the clipboard (used for "clear" by passing []).
  const onPasteCellEffects = useCallback(
    async (layerId: number, cell: number, effects?: Effect[]) => {
      const fx = effects ?? cellClip;
      if (!fx) return;
      const p = await pasteCellEffects(layerId, cell, structuredClone(fx));
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("paste_cell_effects", { layerId, cell });
    },
    [cellClip, applyTime, recordAction]
  );

  // Paste the clipboard onto every cell of the grid at once (one undo step).
  const onPasteCellEffectsAll = useCallback(
    async (layerId: number) => {
      if (!cellClip) return;
      const p = await pasteCellEffectsAll(layerId, structuredClone(cellClip), null);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("paste_cell_effects_all", { layerId });
    },
    [cellClip, applyTime, recordAction]
  );

  // Retime / delete a single cell's effect keyframes from its child timeline.
  const onMoveCellKeyframe = useCallback(
    async (layerId: number, cell: number, fromMs: number, toMs: number) => {
      const p = await moveCellKeyframesAt(layerId, cell, fromMs, toMs);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("move_cell_keyframe", { layerId, cell, fromMs, toMs });
    },
    [applyTime, recordAction]
  );

  const onDeleteCellKeyframe = useCallback(
    async (layerId: number, cell: number, tMs: number) => {
      const p = await deleteCellKeyframesAt(layerId, cell, tMs);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("delete_cell_keyframe", { layerId, cell, tMs });
    },
    [applyTime, recordAction]
  );

  // Set (or replace) the selected cell's image via a file picker.
  const onSetCellImage = useCallback(
    async (layerId: number, cell: number) => {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
      });
      if (typeof selected !== "string") return;
      const p = await setCellImage(layerId, cell, selected);
      setProject(p);
      await resolveImages(p);
      await applyTime(timeRef.current);
      recordAction("set_cell_image", { layerId, cell, path: selected });
    },
    [resolveImages, applyTime, recordAction]
  );

  const onClearCellImage = useCallback(
    async (layerId: number, cell: number) => {
      const p = await clearCellImage(layerId, cell);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("clear_cell_image", { layerId, cell });
    },
    [applyTime, recordAction]
  );

  // Set / clear the grid's shared background image (each cell shows its slice).
  const onSetGridBackground = useCallback(
    async (layerId: number) => {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
      });
      if (typeof selected !== "string") return;
      const p = await setGridBackground(layerId, selected);
      setProject(p);
      await resolveImages(p);
      await applyTime(timeRef.current);
      recordAction("set_grid_background", { layerId, path: selected });
    },
    [resolveImages, applyTime, recordAction]
  );
  const onClearGridBackground = useCallback(
    async (layerId: number) => {
      const p = await clearGridBackground(layerId);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("clear_grid_background", { layerId });
    },
    [applyTime, recordAction]
  );

  // Commit dragged grid vertices (keyframed at the playhead).
  const onMoveVertices = useCallback(
    async (layerId: number, updates: { index: number; x: number; y: number }[]) => {
      const t = Math.round(timeRef.current);
      const layer = projectRef.current?.layers.find((l) => l.id === layerId);
      const seedStart = layer ? t > layer.startMs : false;
      const p = await setGridVertices(layerId, updates, t, seedStart);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("move_grid_vertices", { layerId, count: updates.length, timeMs: t });
    },
    [applyTime, recordAction]
  );

  // Merge the selected cell with its right/down neighbour.
  const onMergeCell = useCallback(
    async (layerId: number, cell: number, dir: "right" | "down") => {
      const p = await mergeCell(layerId, cell, dir);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("merge_cell", { layerId, cell, dir });
    },
    [applyTime, recordAction]
  );

  // Split a merged cell back into single slots.
  const onSplitCell = useCallback(
    async (layerId: number, cell: number) => {
      const p = await splitCell(layerId, cell);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("split_cell", { layerId, cell });
    },
    [applyTime, recordAction]
  );

  // Switch a grid's vertex-drag constraint (free-form / rails).
  const onSetGridConstrain = useCallback(
    async (layerId: number, mode: "freeform" | "rails") => {
      const p = await setGridConstrain(layerId, mode);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("set_grid_constrain", { layerId, mode });
    },
    [applyTime, recordAction]
  );

  const onSetGridLineWidth = useCallback(
    async (layerId: number, width: number) => {
      const p = await setGridLineWidth(layerId, width);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("set_grid_line_width", { layerId, width });
    },
    [applyTime, recordAction]
  );

  const onSetGridLineColor = useCallback(
    async (layerId: number, color: Rgba) => {
      const p = await setGridLineColor(layerId, color, Math.round(timeRef.current), true);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("set_grid_line_color", { layerId });
    },
    [applyTime, recordAction]
  );

  const onClearGridLineColor = useCallback(
    async (layerId: number, color: Rgba) => {
      const p = await clearGridLineColor(layerId, color);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("clear_grid_line_color", { layerId });
    },
    [applyTime, recordAction]
  );

  // Set (or clear) a grid cell's in/out transition.
  const onSetCellTransition = useCallback(
    async (
      layerId: number,
      cell: number,
      slot: "in" | "out",
      durMs: number,
      direction: number,
      engine: string | null,
      params: string | null
    ) => {
      const p = await setCellTransition(layerId, cell, slot, durMs, direction, engine, params);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("set_cell_transition", { layerId, cell, slot, engine });
    },
    [applyTime, recordAction]
  );

  // Apply (or clear) the same transition on EVERY cell of a grid at once.
  const onSetAllCellsTransition = useCallback(
    async (
      layerId: number,
      slot: "in" | "out",
      durMs: number,
      direction: number,
      engine: string | null,
      params: string | null
    ) => {
      const p = await setAllCellsTransition(layerId, slot, durMs, direction, engine, params);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("set_all_cells_transition", { layerId, slot, engine });
    },
    [applyTime, recordAction]
  );

  // Keyframe a grid cell's image zoom at the playhead.
  const onSetCellZoom = useCallback(
    async (layerId: number, cell: number, zoom: number) => {
      const t = Math.round(timeRef.current);
      const layer = projectRef.current?.layers.find((l) => l.id === layerId);
      const seedStart = layer ? t > layer.startMs : false;
      const p = await setCellZoom(layerId, cell, zoom, t, seedStart);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("set_cell_zoom", { layerId, cell, zoom, timeMs: t });
    },
    [applyTime, recordAction]
  );

  // Pan a cell's image within its window (keyframed at the playhead).
  const onSetCellPan = useCallback(
    async (layerId: number, cell: number, x: number, y: number) => {
      const t = Math.round(timeRef.current);
      const layer = projectRef.current?.layers.find((l) => l.id === layerId);
      const seedStart = layer ? t > layer.startMs : false;
      const p = await setCellPan(layerId, cell, x, y, t, seedStart);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("set_cell_pan", { layerId, cell, x, y, timeMs: t });
    },
    [applyTime, recordAction]
  );

  // Shape dimensions + camera (rotations are keyed separately).
  const onShapeParams = useCallback(
    async (layerId: number, params: ShapeParams) => {
      // Optimistically apply the tracks to the layer so the inspector re-renders
      // with the new keyframe state before the round-trip returns — otherwise
      // keyframing a second dimension right after a first can clobber it (same
      // guard as onSetShape2d).
      const seq = ++styleEditSeq.current;
      setProject((prev) =>
        prev
          ? {
              ...prev,
              layers: prev.layers.map((l) =>
                l.id === layerId && l.kind.kind === "shape3d"
                  ? {
                      ...l,
                      kind: {
                        ...l.kind,
                        width: params.width,
                        height: params.height,
                        depth: params.depth,
                        perspective: params.perspective,
                        focal_length: params.focalLength,
                        coverage: params.coverage,
                        radius: params.radius,
                      },
                    }
                  : l
              ),
            }
          : prev
      );
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
      if (seq === styleEditSeq.current) setProject(p);
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
      param: EffectParam,
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

  const onSetShineStatic = useCallback(
    async (layerId: number, index: number, tint: Rgba, blend: number) => {
      const p = await setShineStatic(layerId, index, tint, blend);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("shine_static", { layerId, index, blend });
    },
    [applyTime, recordAction]
  );

  const onSetGpuFxStatic = useCallback(
    async (
      layerId: number,
      index: number,
      effect: number,
      tint: Rgba,
      tint2: Rgba,
      posX: number,
      posY: number,
      blend: number
    ) => {
      const p = await setGpuFxStatic(layerId, index, effect, tint, tint2, posX, posY, blend);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("gpufx_static", { layerId, index, effect, blend });
    },
    [applyTime, recordAction]
  );

  // Drag the Flap hinge line in the preview → set its axis (pos_x), preserving
  // the effect's other static fields.
  const onSetFlapAxis = useCallback(
    async (layerId: number, index: number, axis: number) => {
      const layer = projectRef.current?.layers.find((l) => l.id === layerId);
      const eff = layer?.effects[index];
      if (!eff || eff.kind !== "gpuoverlay") return;
      const p = await setGpuFxStatic(layerId, index, eff.effect, eff.tint, eff.tint2, axis, eff.posY, eff.blend);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("flap_axis", { layerId, index, axis });
    },
    [applyTime, recordAction]
  );

  // Per-cell effect stack (multi-frame grid). Mirror the layer-effect handlers,
  // threading the selected cell index.
  const onAddCellEffect = useCallback(
    async (layerId: number, cell: number, kind: string) => {
      const p = await addCellEffect(layerId, cell, kind);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("add_cell_effect", { layerId, cell, kind });
    },
    [applyTime, recordAction]
  );
  const onRemoveCellEffect = useCallback(
    async (layerId: number, cell: number, index: number) => {
      const p = await removeCellEffect(layerId, cell, index);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("remove_cell_effect", { layerId, cell, index });
    },
    [applyTime, recordAction]
  );
  const onKeyCellEffect = useCallback(
    async (
      layerId: number,
      cell: number,
      index: number,
      param: EffectParam,
      value: number,
      seedStart: boolean
    ) => {
      const p = await keyCellEffect(layerId, cell, index, param, Math.round(timeRef.current), value, seedStart);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("key_cell_effect", { layerId, cell, index, param, value });
    },
    [applyTime, recordAction]
  );
  const onSetCellWipeStatic = useCallback(
    async (layerId: number, cell: number, index: number, angle: number, invert: boolean) => {
      const p = await setCellWipeStatic(layerId, cell, index, angle, invert);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("cell_wipe_static", { layerId, cell, index, angle, invert });
    },
    [applyTime, recordAction]
  );
  const onSetCellShineStatic = useCallback(
    async (layerId: number, cell: number, index: number, tint: Rgba, blend: number) => {
      const p = await setCellShineStatic(layerId, cell, index, tint, blend);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("cell_shine_static", { layerId, cell, index, blend });
    },
    [applyTime, recordAction]
  );
  const onSetCellGpuFxStatic = useCallback(
    async (
      layerId: number,
      cell: number,
      index: number,
      effect: number,
      tint: Rgba,
      tint2: Rgba,
      posX: number,
      posY: number,
      blend: number
    ) => {
      const p = await setCellGpuFxStatic(layerId, cell, index, effect, tint, tint2, posX, posY, blend);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("cell_gpufx_static", { layerId, cell, index, effect, blend });
    },
    [applyTime, recordAction]
  );

  // Linked (shared) effect groups. A thin wrapper per command; all keyframe/edit
  // at the playhead and re-resolve.
  const runGridEdit = useCallback(
    async (p: Promise<Project>, action: string, data: Record<string, unknown>) => {
      const proj = await p;
      setProject(proj);
      await applyTime(timeRef.current);
      recordAction(action, data);
    },
    [applyTime, recordAction]
  );
  const onLinkEffect = useCallback(
    (layerId: number, kind: string, cells: number[]) =>
      runGridEdit(linkEffect(layerId, kind, cells), "link_effect", { layerId, kind, count: cells.length }),
    [runGridEdit]
  );
  const onAddLinkedEffect = useCallback(
    (layerId: number, groupId: number, kind: string) =>
      runGridEdit(addLinkedEffect(layerId, groupId, kind), "add_linked_effect", { layerId, groupId, kind }),
    [runGridEdit]
  );
  const onRemoveLinkedEffectItem = useCallback(
    (layerId: number, groupId: number, index: number) =>
      runGridEdit(removeLinkedEffectItem(layerId, groupId, index), "remove_linked_effect", { layerId, groupId, index }),
    [runGridEdit]
  );
  const onKeyLinkedEffect = useCallback(
    (
      layerId: number,
      groupId: number,
      index: number,
      param: EffectParam,
      value: number,
      seedStart: boolean
    ) =>
      runGridEdit(
        keyLinkedEffect(layerId, groupId, index, param, Math.round(timeRef.current), value, seedStart),
        "key_linked_effect",
        { layerId, groupId, index, param, value }
      ),
    [runGridEdit]
  );
  const onSetLinkedWipeStatic = useCallback(
    (layerId: number, groupId: number, index: number, angle: number, invert: boolean) =>
      runGridEdit(setLinkedWipeStatic(layerId, groupId, index, angle, invert), "linked_wipe_static", { layerId, groupId, index }),
    [runGridEdit]
  );
  const onRemoveLinkedGroup = useCallback(
    (layerId: number, groupId: number) =>
      runGridEdit(removeLinkedGroup(layerId, groupId), "remove_linked_group", { layerId, groupId }),
    [runGridEdit]
  );
  const onSetLinkedMember = useCallback(
    (layerId: number, groupId: number, cell: number, member: boolean) =>
      runGridEdit(setLinkedMember(layerId, groupId, cell, member), "set_linked_member", { layerId, groupId, cell, member }),
    [runGridEdit]
  );
  const onUnlinkCell = useCallback(
    (layerId: number, groupId: number, cell: number) =>
      runGridEdit(unlinkCell(layerId, groupId, cell), "unlink_cell", { layerId, groupId, cell }),
    [runGridEdit]
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

  // Right-click a grid cell (in the preview or a cell's timeline row) → open the
  // cell effects copy/paste menu (and select that cell).
  const onCellContextMenu = useCallback((layerId: number, cell: number, x: number, y: number) => {
    setSelectedId(layerId);
    setSelectedCell({ layerId, cell });
    setCtxMenu({ x, y, layerId, cell });
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
      await ensureRootScope(); // save the whole tree, not a group's inner scope
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
      await ensureRootScope(); // save the whole tree, not a group's inner scope
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

  // Load a specific .sefx path into the editor (shared by the Open dialog and
  // the "launched with a file" startup path).
  const loadProjectPath = useCallback(
    async (path: string) => {
      try {
        stop();
        const p = await openProjectFile(path);
        pristineRef.current = true; // a freshly-opened file is not "unsaved"
        setProject(p);
        setDirty(false);
        durationRef.current = p.durationMs;
        filePathRef.current = path;
        setFileName(baseName(path));
        setSelectedId(null);
        setDecomposeId(null);
        await resolveImages(p);
        await loadProjectMedia(p);
        seek(0);
        recordAction("open_project", { path });
      } catch (e) {
        alert(`Open failed: ${e}`);
      }
    },
    [stop, resolveImages, seek, recordAction, loadProjectMedia],
  );

  // Open a .sefx project, replacing the current one and loading its images.
  const doOpenProject = useCallback(async () => {
    const selected = await open({ multiple: false, filters: SEFX_FILTER });
    if (typeof selected !== "string") return;
    await loadProjectPath(selected);
  }, [loadProjectPath]);

  // Start a fresh, blank project. Warns first if there are unsaved changes.
  const doNewProject = useCallback(async () => {
    if (dirty && !window.confirm("Discard unsaved changes and start a new project?")) return;
    stop();
    const p = await newProject();
    pristineRef.current = true; // a brand-new project isn't "unsaved" yet
    setProject(p);
    setDirty(false);
    durationRef.current = p.durationMs;
    filePathRef.current = null; // unbound from any file → next Save prompts
    setFileName(null);
    setSelectedId(null);
    setSelectedIds([]);
    setDecomposeId(null);
    setGroupPath([]);
    // A brand-new project starts with an empty media bin (the backend's blank
    // project has no media either).
    setMedia([]);
    setMediaThumbs({});
    await resolveImages(p);
    seek(0);
    recordAction("new_project", {});
  }, [dirty, stop, resolveImages, seek, recordAction]);

  // If the app was launched by double-clicking a .sefx file, open it on startup
  // instead of showing the blank default project. Runs exactly once.
  const openedLaunchFile = useRef(false);
  useEffect(() => {
    if (openedLaunchFile.current) return;
    openedLaunchFile.current = true;
    void (async () => {
      const path = await takeLaunchFile();
      if (path) await loadProjectPath(path);
    })();
  }, [loadProjectPath]);

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
    async (
      format: "mp4" | "webm",
      level: number,
      fps: number,
      burnFps: boolean,
      bitrate: number,
      rateMode: "quality" | "bitrate",
    ) => {
      if (exportingRef.current) return;
      // The bitrate the frame encoder targets: the user's value in bitrate mode,
      // or one derived from the compression level in quality mode (WebCodecs has
      // no CRF, so quality mode still needs a generous target for the WebM pass).
      const encodeBitrate = rateMode === "bitrate" ? bitrate : bitrateForLevel(level);
      // Render the whole comp, not a group's inner scope.
      const rootP = await ensureRootScope();
      let p = rootP ?? projectRef.current;
      if (!p) return;
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
        // Export range: render only [inMs, outMs] of the comp (defaults to the
        // whole comp). Frames are rendered at the ABSOLUTE comp time `inMs + tMs`,
        // but the encoded video timeline starts at 0 — so `duration` here is the
        // range LENGTH, and audio clips are shifted by `inMs` below.
        const range = exportRangeRef.current;
        const inMs = range ? Math.max(0, Math.min(range.inMs, p.durationMs)) : 0;
        const outMs = range ? Math.max(inMs + 1, Math.min(range.outMs, p.durationMs)) : p.durationMs;
        const duration = outMs - inMs;
        // Frame count for this render — used to calibrate the render-time estimate
        // shown in the export dialog on the next run.
        const totalFrames = Math.max(1, Math.ceil((duration / 1000) * fps));
        const renderStartedAt = performance.now();

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
            videoBitsPerSecond: encodeBitrate,
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
                await applyTime(outMs);
                if (probing) {
                  await awaitPaint();
                  probePreview(canvas, outMs);
                }
                resolve();
                return;
              }
              setExportMsg(`Rendering… ${Math.round((t / duration) * 100)}%`);
              await applyTime(inMs + t);
              if (probing && t - lastProbe >= 150) {
                lastProbe = t;
                await awaitPaint();
                probePreview(canvas, inMs + t);
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
        // Diagnostic: the transition factor sampled per frame. If these vary but
        // the captured pixels don't, the freeze is in the capture/paint path, not
        // the evaluator. If they're constant, it's the backend/transition.
        const dbgFactors: (number | null)[] = [];
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
              bitrate: encodeBitrate,
              renderFrame: async (relMs) => {
                // The encoder counts from 0; shift into absolute comp time so a
                // partial export renders the right section (inMs = 0 for a full comp).
                const tMs = inMs + relMs;
                // Evaluate this exact frame and push it to the preview via a NORMAL
                // state update. We deliberately do NOT use flushSync here: react-konva
                // renders the Stage's children through its OWN concurrent reconciler
                // and drains it with flushSyncWork() inside a layout effect. Wrapping
                // our setState in ReactDOM's flushSync can defer that inner drain
                // (nested sync work on a different root) instead of applying it — which
                // left the Konva nodes on the OLD sceneFunc and froze every frame.
                //
                // Instead: set state, then yield across enough ticks that React commits
                // AND react-konva commits + batch-draws on its own, THEN force one final
                // synchronous stage draw right before the frame is grabbed.
                const layers = await evaluateAt(tMs);
                const map: Record<number, ResolvedLayer> = {};
                for (const l of layers) map[l.id] = l;
                // Sample the first active transition factor for the diagnostic trace.
                const withTr = layers.find((l) => l.transition);
                dbgFactors.push(withTr?.transition ? withTr.transition.factor : null);
                setResolved(map);
                setTime(tMs);
                // Seek every video layer to this exact source-time and wait for the
                // decode, so the captured frame shows the right video content.
                const videoTargets = p.layers
                  .filter((l) => l.kind.kind === "video")
                  .map((l) => {
                    const durMs = l.kind.kind === "video" ? l.kind.durationMs : 0;
                    const localSec = Math.max(0, (tMs - l.startMs) / 1000);
                    return {
                      layerId: l.id,
                      timeSec: durMs > 0 ? Math.min(localSec, durMs / 1000 - 0.001) : localSec,
                    };
                  });
                if (videoTargets.length) await seekVideosForFrame(videoTargets);
                // Yield: microtask drain + two animation frames. This lets React's
                // async commit and react-konva's reconciler+batchDraw fully run.
                await Promise.resolve();
                await awaitPaint();
                // Belt-and-suspenders: force a synchronous repaint of the exact stage
                // (and any others) so the captured canvas holds THIS frame.
                previewStageRef.current?.draw();
                for (const st of Konva.stages) st.draw();
              },
              onFrameRendered: probing ? (relMs) => probePreview(canvas, inMs + relMs) : undefined,
              onProgress: (frac) => {
                const pct = Math.round(frac * 100);
                if (pct !== lastPct) {
                  lastPct = pct;
                  setExportMsg(`Rendering frame-accurate… ${pct}%`);
                }
              },
              onFlush: () => setExportMsg("Finalizing video…"),
              shouldAbort: () => !exportingRef.current,
            });
            blob = new Blob([bytes], { type: "video/webm" });
          } catch (e) {
            // Don't fail silently: a swallowed error here means we fall back to
            // the realtime capture, which freezes when the main thread is busy —
            // exactly the "single repeated frame" symptom. Surface it loudly so
            // it's diagnosable instead of masquerading as a broken effect.
            console.error("deterministic export failed; falling back to realtime capture", e);
            setExportMsg(`Frame-accurate export failed (${e}) — using realtime capture…`);
            blob = null;
          }
        }
        if (!blob) blob = await realtimeCapture();

        // Decode the produced video and probe its real frames (output trace).
        if (probing) {
          // Summarise the per-frame transition factors: how many DISTINCT values
          // the evaluator produced across the render. >1 means the data animates.
          const nonNull = dbgFactors.filter((f): f is number => f != null);
          const distinct = new Set(nonNull.map((f) => f.toFixed(3)));
          setProbeDebug({
            transitionFactors: {
              frames: dbgFactors.length,
              withTransition: nonNull.length,
              distinctValues: distinct.size,
              first: dbgFactors[0] ?? null,
              min: nonNull.length ? Math.min(...nonNull) : null,
              max: nonNull.length ? Math.max(...nonNull) : null,
              sample: dbgFactors.slice(0, 30),
            },
          });
          setExportMsg("Analysing output video…");
          try {
            await analyzeOutputVideo(blob);
          } catch (e) {
            console.warn("output probe failed", e);
          }
          record("render_probe", lastProbeReport());
        }

        // Collect the comp's audio clips so ffmpeg can mux them into the output:
        // each plays from its start at its comp offset, for its trimmed length.
        // Clip each audio layer to the export range: `startMs` is its position in
        // the exported timeline (0 at inMs), `sourceInMs` is how far into the file
        // to start (so a clip that begins before the range plays from the middle).
        const audioTracks = p.layers
          .filter((l) => l.kind.kind === "audio" && !l.hidden && l.endMs > inMs && l.startMs < outMs)
          .map((l) => {
            const durMs = l.kind.kind === "audio" ? l.kind.durationMs : 0;
            const clipStart = Math.max(l.startMs, inMs);
            const clipEnd = Math.min(l.endMs, outMs);
            const sourceInMs = clipStart - l.startMs; // offset into the source file
            let playMs = clipEnd - clipStart;
            if (durMs > 0) playMs = Math.min(playMs, Math.max(0, durMs - sourceInMs));
            return {
              path: l.kind.kind === "audio" ? l.kind.src : "",
              startMs: clipStart - inMs,
              playMs,
              sourceInMs,
            };
          })
          .filter((a) => a.path && a.playMs > 0);

        setExportMsg(
          audioTracks.length
            ? "Muxing audio (ffmpeg)…"
            : format === "mp4"
              ? "Encoding MP4 (ffmpeg)…"
              : "Saving…"
        );
        const base64 = await blobToBase64(blob);
        // MP4 transcode: in "bitrate" mode target the user's bitrate (size ≈
        // bitrate × duration); in "quality" mode use CRF from the compression
        // level (constant quality, variable size). WebM is copied through as-is.
        await exportVideo(base64, path, format, rateMode, level, bitrate, audioTracks, duration);
        // Calibrate the render-time estimate: record how long this export took
        // per frame so the dialog can predict the next one more accurately.
        const msPerFrame = (performance.now() - renderStartedAt) / totalFrames;
        if (Number.isFinite(msPerFrame) && msPerFrame > 0) {
          try {
            localStorage.setItem("sefx.export.msPerFrame", String(Math.round(msPerFrame)));
          } catch {
            /* localStorage may be unavailable; the estimate just stays at its default */
          }
        }
        recordAction("export_video", { path, format, level, deterministic: isDeterministicSupported() });
        alert(`Saved video:\n${path}`);
      } catch (e) {
        alert(`Export failed: ${e}`);
      } finally {
        exportingRef.current = false;
        setExporting(false);
        setFpsOverlay(null);
        setExportMsg("");
        // Restore the playhead the export loop scrubbed away.
        setTime(timeRef.current);
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

  const onSetFontStyle = useCallback(
    async (layerId: number, weight: number, italic: boolean) => {
      const p = await setTextFontStyle(layerId, weight, italic);
      setProject(p);
      await applyTime(timeRef.current);
      recordAction("text_font_style", { layerId, weight, italic });
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

  // User-initiated selection is recorded. `additive` (Ctrl/⌘/Shift-click in the
  // timeline) toggles the layer in/out of a multi-selection; otherwise it becomes
  // the sole selection. The primary (`selectedId`) drives the inspector/preview.
  const selectLayer = useCallback(
    (id: number | null, additive = false) => {
      if (id == null) {
        setSelectedId(null);
        setSelectedIds([]);
      } else if (additive) {
        setSelectedIds((cur) => {
          if (cur.includes(id)) {
            const next = cur.filter((x) => x !== id);
            setSelectedId(next.length ? next[next.length - 1] : null);
            return next;
          }
          setSelectedId(id);
          return [...cur, id];
        });
      } else {
        setSelectedId(id);
        setSelectedIds([id]);
      }
      // Leave decompose mode if we're selecting a different layer.
      setDecomposeId((cur) => (cur != null && cur !== id ? null : cur));
      setSelectedPart(null);
      recordAction("select", { layerId: id, additive });
    },
    [recordAction]
  );

  // Replace the whole multi-selection (marquee / drag-select in the timeline).
  // The primary selection becomes the last layer in the box (or null if empty).
  const selectMany = useCallback((ids: number[]) => {
    setSelectedIds(ids);
    setSelectedId(ids.length ? ids[ids.length - 1] : null);
    setSelectedPart(null);
  }, []);

  // Keep the multi-selection consistent with the primary selection for every
  // internal single-select (adding a layer, paste, delete, undo, etc. all call
  // `setSelectedId` directly): if the primary lands outside the current
  // multi-selection, collapse the selection to just it.
  useEffect(() => {
    if (selectedId == null) {
      setSelectedIds((cur) => (cur.length ? [] : cur));
    } else {
      setSelectedIds((cur) => (cur.includes(selectedId) ? cur : [selectedId]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // --- Groups (precomp) ---------------------------------------------------
  // Combine the current multi-selection into a nested group and select it.
  const onCombineLayers = useCallback(async () => {
    const ids = selectedIdsRef.current;
    if (ids.length < 2) return;
    const p = await combineLayers(ids);
    setProject(p);
    durationRef.current = p.durationMs;
    // The new group is the layer whose id is the max (freshly minted).
    const newId = p.layers.reduce((m, l) => Math.max(m, l.id), 0);
    setSelectedId(newId);
    await resolveImages(p);
    await applyTime(timeRef.current);
    recordAction("combine_layers", { count: ids.length, groupId: newId });
  }, [resolveImages, applyTime, recordAction]);

  // Explode (ungroup) a group back into the current scope.
  const onExplodeLayer = useCallback(async (groupId: number) => {
    const p = await explodeLayer(groupId);
    setProject(p);
    durationRef.current = p.durationMs;
    setSelectedId(null);
    await resolveImages(p);
    await applyTime(timeRef.current);
    recordAction("explode_layer", { groupId });
  }, [resolveImages, applyTime, recordAction]);

  // Enter a group to edit its children (swaps the editing scope).
  const onEnterGroup = useCallback(async (groupId: number) => {
    const name = projectRef.current?.layers.find((l) => l.id === groupId)?.name ?? "Group";
    const p = await enterGroup(groupId);
    setProject(p);
    durationRef.current = p.durationMs;
    setGroupPath((cur) => [...cur, { id: groupId, name }]);
    setSelectedId(null);
    setSelectedIds([]);
    await resolveImages(p);
    await applyTime(timeRef.current);
    recordAction("enter_group", { groupId });
  }, [resolveImages, applyTime, recordAction]);

  // Leave the current group (re-nesting the edits). `toDepth` exits repeatedly
  // until the breadcrumb is that deep (used to pop to any crumb / to the root).
  const onExitGroup = useCallback(async (toDepth = 0) => {
    let p: Project | null = null;
    let depth = groupPath.length;
    while (depth > toDepth) {
      p = await exitGroup();
      depth -= 1;
    }
    if (!p) return;
    setProject(p);
    durationRef.current = p.durationMs;
    setGroupPath((cur) => cur.slice(0, toDepth));
    setSelectedId(null);
    setSelectedIds([]);
    await resolveImages(p);
    await applyTime(timeRef.current);
    recordAction("exit_group", { toDepth });
  }, [groupPath, resolveImages, applyTime, recordAction]);

  // Pop out of every group back to the root comp (re-nesting all edits). Call
  // before save/export so the full tree is what's persisted/rendered.
  const ensureRootScope = useCallback(async (): Promise<Project | null> => {
    if (groupPathRef.current.length === 0) return null;
    let p: Project | null = null;
    for (let i = groupPathRef.current.length; i > 0; i--) p = await exitGroup();
    setGroupPath([]);
    setSelectedId(null);
    setSelectedIds([]);
    if (p) {
      setProject(p);
      durationRef.current = p.durationMs;
      await resolveImages(p);
      await applyTime(timeRef.current);
    }
    return p;
  }, [resolveImages, applyTime]);

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
        const ids = selectedIdsRef.current;
        const sel = selectedIdRef.current;
        if (decomposeId == null && (ids.length || sel != null)) {
          e.preventDefault();
          // Delete every selected layer (multi-select). Order doesn't matter —
          // ids are independent objects.
          const toDelete = ids.length ? ids : sel != null ? [sel] : [];
          void (async () => {
            for (const id of toDelete) await onDeleteLayer(id);
          })();
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
      if (mod && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        void doNewProject();
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
    doNewProject,
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
  // The selected layer's transform sampled at the playhead (for the Inspector's
  // numeric Position / Transform fields).
  const transformNow = (() => {
    const r = selectedId != null ? resolved[selectedId] : null;
    return r
      ? { x: r.x, y: r.y, scaleX: r.scaleX, scaleY: r.scaleY, rotation: r.rotation, opacity: r.opacity }
      : null;
  })();
  // The selected text layer's fill colour AT THE PLAYHEAD (so the swatch shows the
  // keyframed colour at the current time, not the static/first-key colour).
  const textColorNow = (selectedId != null ? resolved[selectedId]?.color : null) ?? null;
  // The selected decomposed letter's resolved fill at the playhead (for its swatch).
  const letterColorNow =
    selectedId != null && selectedPart != null
      ? resolved[selectedId]?.letters[selectedPart]?.fill ?? null
      : null;
  // The selected grid cell's zoom AT THE PLAYHEAD (for the inspector's slider).
  const selectedResolvedCell =
    selectedCell != null && selectedCell.layerId === selectedId
      ? resolved[selectedId]?.frameGrid?.cells[selectedCell.cell] ?? null
      : null;
  const cellZoomNow = selectedResolvedCell?.zoom ?? null;
  const cellPanNow = selectedResolvedCell
    ? { x: selectedResolvedCell.panX, y: selectedResolvedCell.panY }
    : null;
  const cellMerged = selectedResolvedCell
    ? selectedResolvedCell.rowSpan > 1 || selectedResolvedCell.colSpan > 1
    : false;
  const cellEffects = selectedResolvedCell?.effects ?? [];
  const gridLinked = selectedId != null ? resolved[selectedId]?.frameGrid?.linked ?? [] : [];
  // Grid line style at the playhead (colour may be keyframed) for the inspector.
  const gridLineWidth = (selectedId != null ? resolved[selectedId]?.frameGrid?.lineWidth : null) ?? 0;
  const gridHasBackground = !!(selectedId != null && resolved[selectedId]?.frameGrid?.background);
  const gridLineColor =
    (selectedId != null ? resolved[selectedId]?.frameGrid?.lineColor : null) ??
    ({ r: 255, g: 255, b: 255, a: 255 } as Rgba);
  // The selected cell's in/out transitions (from the project model, not resolved).
  const selectedGridCell =
    selectedLayer?.kind.kind === "framegrid" && selectedCell != null && selectedCell.layerId === selectedId
      ? selectedLayer.kind.cells[selectedCell.cell] ?? null
      : null;
  // Representative transitions for the "apply to all cells" control (cell 0).
  const gridFirstCell =
    selectedLayer?.kind.kind === "framegrid" ? selectedLayer.kind.cells[0] ?? null : null;
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
        { label: "New", onClick: () => void doNewProject(), shortcut: "Ctrl+N" },
        { separator: true },
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
        { separator: true },
        {
          label: "Combine into Group",
          onClick: () => void onCombineLayers(),
          disabled: selectedIds.length < 2,
        },
        {
          label: "Enter Group",
          onClick: () => selectedId != null && void onEnterGroup(selectedId),
          disabled:
            selectedId == null ||
            project.layers.find((l) => l.id === selectedId)?.kind.kind !== "group",
        },
        {
          label: "Explode Group",
          onClick: () => selectedId != null && void onExplodeLayer(selectedId),
          disabled:
            selectedId == null ||
            project.layers.find((l) => l.id === selectedId)?.kind.kind !== "group",
        },
      ],
    },
    {
      title: "Add",
      items: [
        { label: "Text", onClick: onAddText },
        { label: "Image…", onClick: onOpenImage },
        { separator: true },
        { label: "Rectangle", onClick: () => onAddShape2d("rectangle") },
        { label: "Circle", onClick: () => onAddShape2d("circle") },
        { label: "Polygon", onClick: () => onAddShape2d("polygon") },
        { label: "Arrow", onClick: () => onAddShape2d("arrow") },
        { separator: true },
        { label: "3D Box", onClick: () => onAddShape("box") },
        { label: "3D Cylinder", onClick: () => onAddShape("cylinder") },
        { separator: true },
        { label: "Multi-Frame Grid…", onClick: () => setGridDialog({ rows: 2, cols: 2 }) },
        { separator: true },
        { label: "Adjustment Layer (Shiny Clouds)", onClick: onAddAdjustment },
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
          label: "UI size…",
          onClick: () => setShowUiSize(true),
        },
        { separator: true },
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
    <div
      className="app"
      style={{ gridTemplateRows: `30px 48px 1fr 6px ${timelineH}px` }}
    >
      <MenuBar menus={menus} />
      {fileDragging && (
        <div className="drop-overlay">
          <div className="drop-card">⤓ Drop media (image / video / audio) to add it to the bin</div>
        </div>
      )}
      <AudioLayers project={project} timeMs={time} playing={playing} />
      <header className="toolbar">
        <span className="brand" title={`build ${__BUILD_STAMP__}`}>simple · effects</span>
        <span className="build-stamp" title="Build timestamp — confirms the running app is the latest build">
          {__BUILD_STAMP__}
        </span>
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
        <button
          onClick={onCombineLayers}
          disabled={selectedIds.length < 2}
          title="Combine the selected layers into a group (precomp)"
        >
          ⧉ Combine
        </button>
        {groupPath.length > 0 && (
          <span className="group-crumbs" title="You're editing inside a group">
            <button className="crumb" onClick={() => onExitGroup(0)} title="Back to the root comp">
              ⌂ Root
            </button>
            {groupPath.map((g, i) => (
              <span key={`${g.id}-${i}`}>
                <span className="crumb-sep">›</span>
                <button
                  className="crumb"
                  onClick={() => onExitGroup(i + 1)}
                  title={`Go to ${g.name}`}
                >
                  {g.name}
                </button>
              </span>
            ))}
          </span>
        )}
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

      <div
        className="mid"
        style={{ gridTemplateColumns: `${mediaW}px 6px 1fr 6px ${inspectorW}px` }}
      >
        <MediaPanel
          media={media}
          thumbs={{ ...images, ...mediaThumbs }}
          onImport={onImportMedia}
          onAddToTimeline={onAddMediaToTimeline}
          onRemove={onRemoveMedia}
        />
        <div
          className="v-resizer"
          onMouseDown={startMediaResize}
          title="Drag to resize the media bin"
        />
        <main className="stage-area">
          <Preview
            project={project}
            resolved={resolved}
            stageRef={previewStageRef}
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
            onPickCell={onPickCell}
            onCellContextMenu={onCellContextMenu}
            onMoveVertices={onMoveVertices}
            onEnterGroup={onEnterGroup}
            onSetFlapAxis={onSetFlapAxis}
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
        <div
          className="v-resizer"
          onMouseDown={startInspectorResize}
          title="Drag to resize the inspector"
        />
        <Inspector
          layer={selectedLayer}
          timeMs={time}
          compWidth={project.width}
          compHeight={project.height}
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
          onSetShineStatic={onSetShineStatic}
          onSetGpuFxStatic={onSetGpuFxStatic}
          onShapeParams={onShapeParams}
          onShapeRotKey={onShapeRotKey}
          onSetShape2d={onSetShape2d}
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
          onFontStyle={onSetFontStyle}
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
          transformNow={transformNow}
          onCommitTransform={onCommit}
          selectedCell={selectedCell?.layerId === selectedLayer?.id ? selectedCell?.cell ?? null : null}
          cellZoomNow={cellZoomNow}
          cellMerged={cellMerged}
          cellPanNow={cellPanNow}
          cellEffects={cellEffects}
          cellTransitionIn={selectedGridCell?.transitionIn ?? null}
          cellTransitionOut={selectedGridCell?.transitionOut ?? null}
          allCellsTransitionIn={gridFirstCell?.transitionIn ?? null}
          allCellsTransitionOut={gridFirstCell?.transitionOut ?? null}
          onSetCellImage={onSetCellImage}
          onClearCellImage={onClearCellImage}
          onSetCellZoom={onSetCellZoom}
          onSetCellPan={onSetCellPan}
          onSetCellTransition={onSetCellTransition}
          onSetAllCellsTransition={onSetAllCellsTransition}
          onSetGridConstrain={onSetGridConstrain}
          lineWidth={gridLineWidth}
          lineColor={gridLineColor}
          onSetGridLineWidth={onSetGridLineWidth}
          onSetGridLineColor={onSetGridLineColor}
          onClearGridLineColor={onClearGridLineColor}
          hasBackground={gridHasBackground}
          onSetGridBackground={onSetGridBackground}
          onClearGridBackground={onClearGridBackground}
          onMergeCell={onMergeCell}
          onSplitCell={onSplitCell}
          onAddCellEffect={onAddCellEffect}
          onRemoveCellEffect={onRemoveCellEffect}
          onKeyCellEffect={onKeyCellEffect}
          onSetCellWipeStatic={onSetCellWipeStatic}
          onSetCellShineStatic={onSetCellShineStatic}
          onSetCellGpuFxStatic={onSetCellGpuFxStatic}
          gridLinked={gridLinked}
          onLinkEffect={onLinkEffect}
          onAddLinkedEffect={onAddLinkedEffect}
          onRemoveLinkedEffectItem={onRemoveLinkedEffectItem}
          onKeyLinkedEffect={onKeyLinkedEffect}
          onSetLinkedWipeStatic={onSetLinkedWipeStatic}
          onRemoveLinkedGroup={onRemoveLinkedGroup}
          onSetLinkedMember={onSetLinkedMember}
          onUnlinkCell={onUnlinkCell}
        />
      </div>

      <div
        className="h-resizer"
        onMouseDown={startTimelineResize}
        title="Drag to resize the timeline"
      />

      <Timeline
        project={project}
        time={time}
        selectedId={selectedId}
        selectedIds={selectedIds}
        onSelect={selectLayer}
        onSelectMany={selectMany}
        onToggleHidden={onToggleHidden}
        onSeek={(t) => {
          if (playingRef.current) stop();
          seek(t);
        }}
        onDeleteLayer={onDeleteLayer}
        onDeleteKeyframe={onDeleteKeyframe}
        onMoveKeyframe={onMoveKeyframe}
        onLayerContextMenu={onLayerContextMenu}
        selectedCell={selectedCell?.layerId === selectedId ? selectedCell?.cell ?? null : null}
        onSelectCell={onPickCell}
        onCellContextMenu={onCellContextMenu}
        onMoveCellKeyframe={onMoveCellKeyframe}
        onDeleteCellKeyframe={onDeleteCellKeyframe}
        onSetLayerRange={onSetLayerRange}
        onReorder={onReorder}
        razor={razor}
        onSplitLayer={onSplitLayer}
        onEnterGroup={onEnterGroup}
        labelsW={labelsW}
        onResizeLabels={(w) => setLayoutValue("labelsW", w)}
        exportRange={exportRange}
        onSetExportRange={setExportRange}
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
              : ctxMenu.cell != null && ctxMenu.layerId != null
                ? [
                    { label: `Cell #${ctxMenu.cell + 1}` },
                    {
                      label: "⧉ Copy cell effects",
                      onClick: () => onCopyCellEffects(ctxMenu.layerId!, ctxMenu.cell!),
                    },
                    cellClip
                      ? {
                          label: `⧉ Paste effects (${cellClip.length})`,
                          onClick: () => void onPasteCellEffects(ctxMenu.layerId!, ctxMenu.cell!),
                        }
                      : { label: "⧉ Paste effects — copy a cell first" },
                    ...(cellClip
                      ? [
                          {
                            label: "⧉ Paste to all cells",
                            onClick: () => void onPasteCellEffectsAll(ctxMenu.layerId!),
                          },
                        ]
                      : []),
                    {
                      label: "⊘ Clear cell effects",
                      onClick: () => void onPasteCellEffects(ctxMenu.layerId!, ctxMenu.cell!, []),
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
                    ...(selectedIds.length >= 2
                      ? [{ label: "⧉ Combine into group", onClick: () => onCombineLayers() }]
                      : []),
                    ...(project.layers.find((l) => l.id === ctxMenu.layerId)?.kind.kind === "group"
                      ? [
                          { label: "↳ Enter group", onClick: () => onEnterGroup(ctxMenu.layerId!) },
                          { label: "⋆ Explode group", onClick: () => onExplodeLayer(ctxMenu.layerId!) },
                        ]
                      : []),
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

      {showUiSize && (
        <UiSizeDialog
          values={{ mediaW, inspectorW, timelineH, labelsW }}
          bounds={LAYOUT_BOUNDS}
          onSet={setLayoutValue}
          onSave={saveUiLayout}
          onReset={resetUiLayout}
          onClose={() => setShowUiSize(false)}
        />
      )}

      {showExportDialog && (
        <ExportDialog
          defaultFps={project.fps}
          durationMs={
            exportRange
              ? Math.max(1, Math.min(exportRange.outMs, project.durationMs) - Math.max(0, exportRange.inMs))
              : project.durationMs
          }
          rangeLabel={
            exportRange
              ? `${(exportRange.inMs / 1000).toFixed(2)}s – ${(exportRange.outMs / 1000).toFixed(2)}s`
              : null
          }
          width={project.width}
          height={project.height}
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
          onSetShineStatic={onSetShineStatic}
          onSetGpuFxStatic={onSetGpuFxStatic}
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
      {gridDialog && (
        <div className="modal-backdrop" onMouseDown={() => setGridDialog(null)}>
          <div className="modal-box" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="modal-title">New multi-frame grid</h3>
            <p className="modal-text">Choose the grid size. You can warp the vertices after.</p>
            <div className="modal-row">
              <label className="modal-field">
                Columns
                <input
                  type="number"
                  min={1}
                  max={32}
                  value={gridDialog.cols}
                  onChange={(e) =>
                    setGridDialog((g) => (g ? { ...g, cols: clampGrid(e.target.value) } : g))
                  }
                />
              </label>
              <span className="modal-times">×</span>
              <label className="modal-field">
                Rows
                <input
                  type="number"
                  min={1}
                  max={32}
                  value={gridDialog.rows}
                  onChange={(e) =>
                    setGridDialog((g) => (g ? { ...g, rows: clampGrid(e.target.value) } : g))
                  }
                />
              </label>
            </div>
            <div className="modal-actions">
              <button className="insp-btn" onClick={() => setGridDialog(null)}>
                Cancel
              </button>
              <button
                className="insp-btn active"
                onClick={() => {
                  const { rows, cols } = gridDialog;
                  setGridDialog(null);
                  onAddFrameGrid(rows, cols);
                }}
              >
                Create {gridDialog.cols}×{gridDialog.rows}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Clamp a grid-dimension text input to 1..32. */
function clampGrid(v: string): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(32, n));
}
