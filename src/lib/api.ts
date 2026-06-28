// Thin typed wrappers over the Tauri command surface. Types are the ts-rs
// bindings generated from the Rust model (`cargo test` regenerates them).
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../bindings/Project";
import type { ResolvedLayer } from "../bindings/ResolvedLayer";
import type { TransformEdit } from "../bindings/TransformEdit";
import type { ShapedText } from "../bindings/ShapedText";
import type { LetterAnimation } from "../bindings/LetterAnimation";

export const getProject = () => invoke<Project>("get_project");

export const setProject = (project: Project) =>
  invoke<void>("set_project", { project });

/** Resolve every layer's transform at one playhead time (comp ms). */
export const evaluateAt = (tMs: number) =>
  invoke<ResolvedLayer[]>("evaluate_at", { tMs });

export const addImageLayer = (path: string) =>
  invoke<Project>("add_image_layer", { path });

export const addTextLayer = (content: string, size: number) =>
  invoke<Project>("add_text_layer", { content, size });

export const setTextContent = (layerId: number, content: string, size: number) =>
  invoke<Project>("set_text_content", { layerId, content, size });

export const setTextAnim = (layerId: number, anim: LetterAnimation | null) =>
  invoke<Project>("set_text_anim", { layerId, anim });

/** Shaped glyph outlines for a text layer (Arabic intact), for the preview. */
export const getShaped = (layerId: number) =>
  invoke<ShapedText | null>("get_shaped", { layerId });

/**
 * Write a transform edit as keyframes at `tMs` for one layer. `seedStart` (true
 * for canvas drags) drops a keyframe at the layer's start holding the old value
 * when a track was empty, so a single edit animates from the start instead of
 * jumping. Snapshot ("◆ Key") passes false.
 */
export const editKeyframes = (
  layerId: number,
  tMs: number,
  edit: TransformEdit,
  seedStart: boolean
) => invoke<Project>("edit_keyframes", { layerId, tMs, edit, seedStart });

/** Read an image off disk as a data: URL the webview can render. */
export const loadImageDataUrl = (path: string) =>
  invoke<string>("load_image_data_url", { path });
