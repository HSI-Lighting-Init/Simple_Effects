import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import Preview from "./components/Preview";
import Timeline from "./components/Timeline";
import Inspector from "./components/Inspector";
import {
  addImageLayer,
  addTextLayer,
  editKeyframes,
  evaluateAt,
  getProject,
  loadImageDataUrl,
  setTextAnim,
  setTextContent,
} from "./lib/api";
import type { Project } from "./bindings/Project";
import type { ResolvedLayer } from "./bindings/ResolvedLayer";
import type { TransformEdit } from "./bindings/TransformEdit";
import type { LetterAnimation } from "./bindings/LetterAnimation";
import "./App.css";

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [resolved, setResolved] = useState<Record<number, ResolvedLayer>>({});
  const [images, setImages] = useState<Record<string, string>>({});
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Refs the rAF loop reads without re-subscribing.
  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const rafRef = useRef(0);
  const durationRef = useRef(4000);
  const evalBusy = useRef(false);

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
    },
    [applyTime]
  );

  const stop = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    cancelAnimationFrame(rafRef.current);
  }, []);

  const play = useCallback(() => {
    if (playingRef.current) return;
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
  }, [applyTime]);

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
    if (p.layers.length) setSelectedId(p.layers[p.layers.length - 1].id);
    await resolveImages(p);
    await applyTime(timeRef.current);
  }, [resolveImages, applyTime]);

  const onAddText = useCallback(async () => {
    const p = await addTextLayer("سلام", 140);
    setProject(p);
    if (p.layers.length) setSelectedId(p.layers[p.layers.length - 1].id);
    await applyTime(timeRef.current);
  }, [applyTime]);

  // Edit a text layer's content/size; re-shapes on the Rust side.
  const onSetContent = useCallback(
    async (layerId: number, content: string, size: number) => {
      const p = await setTextContent(layerId, content, size);
      setProject(p);
      await applyTime(timeRef.current);
    },
    [applyTime]
  );

  // Pick / clear / retune a text layer's per-letter preset.
  const onSetAnim = useCallback(
    async (layerId: number, anim: LetterAnimation | null) => {
      const p = await setTextAnim(layerId, anim);
      setProject(p);
      await applyTime(timeRef.current);
    },
    [applyTime]
  );

  // A canvas edit (drag/scale/rotate) → keyframes at the current playhead.
  const onCommit = useCallback(
    async (layerId: number, edit: TransformEdit) => {
      const p = await editKeyframes(layerId, Math.round(timeRef.current), edit, true);
      setProject(p);
      durationRef.current = p.durationMs;
      await applyTime(timeRef.current);
    },
    [applyTime]
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
  }, [selectedId, resolved, applyTime]);

  // Esc clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
        {selectedLayer && (
          <span className="selinfo">▸ {selectedLayer.name}</span>
        )}
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
            onSelect={setSelectedId}
            onCommit={onCommit}
          />
        </main>
        <Inspector layer={selectedLayer} onContent={onSetContent} onAnim={onSetAnim} />
      </div>

      <Timeline
        project={project}
        time={time}
        resolved={resolved}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onSeek={(t) => {
          if (playingRef.current) stop();
          seek(t);
        }}
      />
    </div>
  );
}
