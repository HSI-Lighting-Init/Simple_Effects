// Thin typed wrappers over the Tauri command surface. Types are the ts-rs
// bindings generated from the Rust model (`cargo test` regenerates them).
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../bindings/Project";
import type { ResolvedLayer } from "../bindings/ResolvedLayer";
import type { TransformEdit } from "../bindings/TransformEdit";
import type { ShapedText } from "../bindings/ShapedText";
import type { LetterAnimation } from "../bindings/LetterAnimation";
import type { Font } from "../bindings/Font";
import type { Rgba } from "../bindings/Rgba";
import type { LetterOverride } from "../bindings/LetterOverride";
import type { SurfaceShape } from "../bindings/SurfaceShape";
import type { Decal } from "../bindings/Decal";

export const getProject = () => invoke<Project>("get_project");

export const setProject = (project: Project) =>
  invoke<void>("set_project", { project });

/** Resolve every layer's transform at one playhead time (comp ms). */
export const evaluateAt = (tMs: number) =>
  invoke<ResolvedLayer[]>("evaluate_at", { tMs });

export const addImageLayer = (path: string) =>
  invoke<Project>("add_image_layer", { path });

/** Show/hide a layer (the layer-list on/off toggle). */
export const setLayerHidden = (layerId: number, hidden: boolean) =>
  invoke<Project>("set_layer_hidden", { layerId, hidden });

export const addTextLayer = (content: string, size: number) =>
  invoke<Project>("add_text_layer", { content, size });

export const setTextContent = (layerId: number, content: string, size: number) =>
  invoke<Project>("set_text_content", { layerId, content, size });

export const setTextColor = (layerId: number, color: Rgba) =>
  invoke<Project>("set_text_color", { layerId, color });

export const setTextFont = (layerId: number, font: Font) =>
  invoke<Project>("set_text_font", { layerId, font });

/** Set one glyph's manual transform (decompose mode). */
export const setLetterOverride = (layerId: number, index: number, part: LetterOverride) =>
  invoke<Project>("set_letter_override", { layerId, index, part });

/** Clear all manual per-glyph overrides on a text layer. */
export const clearLetterOverrides = (layerId: number) =>
  invoke<Project>("clear_letter_overrides", { layerId });

/** Key the decompose amount (0..1) at a time — animates the decompose effect. */
export const setDecomposeKey = (
  layerId: number,
  tMs: number,
  value: number,
  seedStart: boolean
) => invoke<Project>("set_decompose_key", { layerId, tMs, value, seedStart });

export const setTextAnim = (layerId: number, anim: LetterAnimation | null) =>
  invoke<Project>("set_text_anim", { layerId, anim });

/** Add an invisible 3D box/cylinder object that images can be pinned to. */
export const addShapeLayer = (shape: SurfaceShape) =>
  invoke<Project>("add_shape_layer", { shape });

/** Set a shape's dimensions + camera (rotations are keyframed separately). */
export const setShapeParams = (
  layerId: number,
  width: number,
  height: number,
  depth: number,
  perspective: number,
  focalLength: number,
  coverage: number,
  radius: number
) =>
  invoke<Project>("set_shape_params", {
    layerId,
    width,
    height,
    depth,
    perspective,
    focalLength,
    coverage,
    radius,
  });

/** Key one 3D-rotation axis ("x"|"y"|"z") of a shape — animates the spin. */
export const setShapeRotationKey = (
  layerId: number,
  axis: "x" | "y" | "z",
  tMs: number,
  value: number,
  seedStart: boolean
) => invoke<Project>("set_shape_rotation_key", { layerId, axis, tMs, value, seedStart });

/** Pin an image to a shape (decal), or detach with `shapeId = null`. */
export const attachImage = (imageId: number, shapeId: number | null, face: number) =>
  invoke<Project>("attach_image", { imageId, shapeId, face });

/** Update a pinned image's placement (face + u/v/scale/rotation). */
export const setDecal = (imageId: number, decal: Decal) =>
  invoke<Project>("set_decal", { imageId, decal });

/**
 * Drop an image onto a shape's surface at comp point (x, y). Returns the new
 * project if the point was over a shape (image pinned there), or `null` if not
 * (the caller treats it as an ordinary move). Works for a flat image being
 * dropped and for a decal's handle being dragged across the surface.
 */
export const dropImageOnShape = (imageId: number, x: number, y: number, tMs: number) =>
  invoke<Project | null>("drop_image_on_shape", { imageId, x, y, tMs });

/** Shaped glyph outlines for a text layer (Arabic intact), for the preview. */
export const getShaped = (layerId: number) =>
  invoke<ShapedText | null>("get_shaped", { layerId });

/** Undo the last mutation; returns the restored project or null if nothing to undo. */
export const undo = () => invoke<Project | null>("undo");

/** Redo the last undone mutation; returns the restored project or null. */
export const redo = () => invoke<Project | null>("redo");

/** Write text to an absolute path (used by the session recorder to save its log). */
export const saveTextFile = (path: string, contents: string) =>
  invoke<void>("save_text_file", { path, contents });

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
