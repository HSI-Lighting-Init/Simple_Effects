import { useCallback, useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";

import Preview from "./components/Preview";
import Timeline from "./components/Timeline";
import Inspector from "./components/Inspector";
import RecorderPanel from "./components/RecorderPanel";
import {
  addImageLayer,
  addTextLayer,
  clearLetterOverrides,
  editKeyframes,
  setDecomposeKey,
  setLetterOverride,
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
import "./App.css";

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
  }, [doUndo, doRedo]);

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

  return (
    <div className="app">
      <header className="toolbar">
        <span className="brand">simple · effects</span>
        <button onClick={onOpenImage}>＋ Image</button>
        <button onClick={onAddText}>＋ Text</button>
        <button className="primary" onClick={playing ? stop : play}>
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button onClick={setKeyHere} disabled={!selectedLayer} title="Add keyframe at playhead">
          ◆ Key
        </button>
        <button onClick={doUndo} title="Undo (Ctrl+Z)">↶</button>
        <button onClick={doRedo} title="Redo (Ctrl+Shift+Z)">↷</button>
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
          />
        </main>
        <Inspector
          layer={selectedLayer}
          decomposed={selectedLayer != null && decomposeId === selectedLayer.id}
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
    </div>
  );
}
