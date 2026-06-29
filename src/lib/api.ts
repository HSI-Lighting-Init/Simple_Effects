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

export const getProject = () => invoke<Project>("get_project");

export const setProject = (project: Project) =>
  invoke<void>("set_project", { project });

/** Set the composition resolution (workspace size / orientation). */
export const setCompSize = (width: number, height: number) =>
  invoke<Project>("set_comp_size", { width, height });

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

/** Pin a layer (image or text) to a shape as a decal, or detach with `null`. */
export const attachToShape = (layerId: number, shapeId: number | null, face: number) =>
  invoke<Project>("attach_to_shape", { layerId, shapeId, face });

/** Key one decal placement track ("u"|"v"|"scale"|"rotation") at a time. */
export const keyDecal = (
  layerId: number,
  prop: "u" | "v" | "scale" | "rotation",
  tMs: number,
  value: number,
  seedStart: boolean
) => invoke<Project>("key_decal", { layerId, prop, tMs, value, seedStart });

/** Set which box face a decal sits on (not keyframed). */
export const setDecalFace = (layerId: number, face: number) =>
  invoke<Project>("set_decal_face", { layerId, face });

/** Append a default effect of the given kind to a layer's effect stack. */
export const addEffect = (layerId: number, kind: string) =>
  invoke<Project>("add_effect", { layerId, kind });

/** Remove the effect at `index`. */
export const removeEffect = (layerId: number, index: number) =>
  invoke<Project>("remove_effect", { layerId, index });

/** Key one effect parameter at a time (animates the effect). */
export const keyEffect = (
  layerId: number,
  index: number,
  param: "amount" | "radius" | "degrees" | "position" | "softness",
  tMs: number,
  value: number,
  seedStart: boolean
) => invoke<Project>("key_effect", { layerId, index, param, tMs, value, seedStart });

/** Set a wipe effect's static fields (angle + invert). */
export const setWipeStatic = (layerId: number, index: number, angle: number, invert: boolean) =>
  invoke<Project>("set_wipe_static", { layerId, index, angle, invert });

/** Write raw bytes (base64) to a path — used to save the exported video. */
export const saveBinaryFile = (path: string, base64: string) =>
  invoke<void>("save_binary_file", { path, base64 });

/** The located ffmpeg path, or null if not installed (gates MP4 export). */
export const ffmpegStatus = () => invoke<string | null>("ffmpeg_status");

/** Install ffmpeg via winget (one-time). Resolves when found, rejects on error. */
export const installFfmpeg = () => invoke<string>("install_ffmpeg");

/**
 * Save the recorded WebM as the chosen `format` ("webm" as-is, or "mp4" via
 * ffmpeg H.264). `level` 1..5 = compression (1 near-original/largest,
 * 5 highest-compression/smallest).
 */
export const exportVideo = (
  base64: string,
  path: string,
  format: "mp4" | "webm",
  level: number
) => invoke<void>("export_video", { webmBase64: base64, path, format, level });

/** Delete a layer (object). Shapes detach any layers pinned to them. */
export const deleteLayer = (layerId: number) =>
  invoke<Project>("delete_layer", { layerId });

/** Delete all keyframes at one time on a layer (one timeline diamond). */
export const deleteKeyframesAt = (layerId: number, tMs: number) =>
  invoke<Project>("delete_keyframes_at", { layerId, tMs });

/** Clear ALL keyframes on a layer, freezing it at its look at `tMs`. */
export const clearKeyframes = (layerId: number, tMs: number) =>
  invoke<Project>("clear_keyframes", { layerId, tMs });

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
