// Thin typed wrappers over the Tauri command surface. Types are the ts-rs
// bindings generated from the Rust model (`cargo test` regenerates them).
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../bindings/Project";
import type { ResolvedLayer } from "../bindings/ResolvedLayer";
import type { TransformEdit } from "../bindings/TransformEdit";
import type { ShapedText } from "../bindings/ShapedText";
import type { LetterAnimation } from "../bindings/LetterAnimation";
import type { Font } from "../bindings/Font";
import type { FontFace } from "../bindings/FontFace";
import type { Rgba } from "../bindings/Rgba";
import type { Effect } from "../bindings/Effect";
import type { SurfaceShape } from "../bindings/SurfaceShape";
import type { ConstrainMode } from "../bindings/ConstrainMode";
import type { TextStyle } from "../bindings/TextStyle";
import type { TextAnimator } from "../bindings/TextAnimator";
import type { TextLayerStyles } from "../bindings/TextLayerStyles";

export const getProject = () => invoke<Project>("get_project");

export const setProject = (project: Project) =>
  invoke<void>("set_project", { project });

/** Start a fresh, blank project (clears the timeline and undo/redo history). */
export const newProject = () => invoke<Project>("new_project");

/** Set the composition resolution (workspace size / orientation). */
export const setCompSize = (width: number, height: number) =>
  invoke<Project>("set_comp_size", { width, height });

/** Set the composition length (ms); layers running past the end are trimmed. */
export const setCompDuration = (durationMs: number) =>
  invoke<Project>("set_comp_duration", { durationMs });

/** Set the composition frame rate (fps) — the render/export rate. */
export const setCompFps = (fps: number) =>
  invoke<Project>("set_comp_fps", { fps });

/** Set one layer's play range [startMs, endMs] (when it appears on the timeline). */
export const setLayerRange = (layerId: number, startMs: number, endMs: number) =>
  invoke<Project>("set_layer_range", { layerId, startMs, endMs });

/** Scale an image layer to contain within the comp and centre it. */
export const scaleLayerToFit = (layerId: number) =>
  invoke<Project>("scale_layer_to_fit", { layerId });

/** Retime a keyframe: move all of a layer's keys at `fromMs` to `toMs`. */
export const moveKeyframesAt = (layerId: number, fromMs: number, toMs: number) =>
  invoke<Project>("move_keyframes_at", { layerId, fromMs, toMs });

/** Set (or clear with kind "none") a layer's in/out transition. */
export const setLayerTransition = (
  layerId: number,
  slot: "in" | "out",
  kind: "none" | "dissolve" | "slide" | "wipe",
  durMs: number,
  direction: number,
  engine?: string | null,
  params?: string | null
) =>
  invoke<Project>("set_layer_transition", {
    layerId,
    slot,
    kind,
    durMs,
    direction,
    engine: engine ?? null,
    params: params ?? null,
  });

/** Reorder the layer stack. `order` lists every layer id bottom-first (last on top). */
export const reorderLayers = (order: number[]) =>
  invoke<Project>("reorder_layers", { order });

/** Save the whole project to a .sefx file (pretty JSON). */
export const saveProjectFile = (path: string) =>
  invoke<void>("save_project_file", { path });

/** Open a .sefx project file, replacing the current project. */
export const openProjectFile = (path: string) =>
  invoke<Project>("open_project_file", { path });

/** A .sefx path the app was launched with (double-clicked file), consumed once. */
export const takeLaunchFile = () => invoke<string | null>("take_launch_file");

/** Resolve every layer's transform at one playhead time (comp ms). */
export const evaluateAt = (tMs: number) =>
  invoke<ResolvedLayer[]>("evaluate_at", { tMs });

export const addImageLayer = (path: string) =>
  invoke<Project>("add_image_layer", { path });

/** Add a video layer (natural size + duration are read on the frontend). */
export const addVideoLayer = (path: string, width: number, height: number, durationMs: number) =>
  invoke<Project>("add_video_layer", { path, width, height, durationMs });

/** Add an audio layer (duration is read on the frontend). */
export const addAudioLayer = (path: string, durationMs: number) =>
  invoke<Project>("add_audio_layer", { path, durationMs });

/** Re-time a just-added layer to start at `startMs` and slot it above `aboveId`
 *  (null = top). Folds into the preceding add's undo step. */
export const placeLayer = (layerId: number, startMs: number, aboveId: number | null) =>
  invoke<Project>("place_layer", { layerId, startMs, aboveId });

/** Combine layers (current scope) into one nested Group (precomp). */
export const combineLayers = (ids: number[]) =>
  invoke<Project>("combine_layers", { ids });

/** Explode (ungroup) a Group back into the current scope. */
export const explodeLayer = (groupId: number) =>
  invoke<Project>("explode_layer", { groupId });

/** Enter a group to edit its children (swaps the editing scope). */
export const enterGroup = (groupId: number) =>
  invoke<Project>("enter_group", { groupId });

/** Leave the current group, re-nesting the edits. */
export const exitGroup = () => invoke<Project>("exit_group");

/** How many groups deep the editing scope is (0 = root comp). */
export const navDepth = () => invoke<number>("nav_depth");

/** Show/hide a layer (the layer-list on/off toggle). */
export const setLayerHidden = (layerId: number, hidden: boolean) =>
  invoke<Project>("set_layer_hidden", { layerId, hidden });

export const addTextLayer = (content: string, size: number) =>
  invoke<Project>("add_text_layer", { content, size });

/** Add a whole-comp adjustment layer (seeded with a shiny-clouds effect). */
export const addAdjustmentLayer = () => invoke<Project>("add_adjustment_layer");

export const setTextContent = (layerId: number, content: string, size: number) =>
  invoke<Project>("set_text_content", { layerId, content, size });

export const setTextColor = (
  layerId: number,
  color: Rgba,
  tMs: number,
  seedStart: boolean
) => invoke<Project>("set_text_color", { layerId, color, tMs, seedStart });

export const clearTextColorKeys = (layerId: number, color: Rgba) =>
  invoke<Project>("clear_text_color_keys", { layerId, color });

export const setTextFont = (layerId: number, font: Font) =>
  invoke<Project>("set_text_font", { layerId, font });

/** Set a text layer's weight (100..900) and italic; re-shapes the glyphs. */
export const setTextFontStyle = (layerId: number, weight: number, italic: boolean) =>
  invoke<Project>("set_text_font_style", { layerId, weight, italic });

/** Every selectable font family (built-ins first, then installed system fonts). */
export const listFonts = () => invoke<string[]>("list_fonts");

/** The available styles (faces) of one family — Regular, Bold, Medium, etc. */
export const fontStyles = (family: string) => invoke<FontFace[]>("font_styles", { family });

/** Set (or clear with null) the typographic + fill/stroke style on a text layer. */
export const setTextStyle = (layerId: number, style: TextStyle | null) =>
  invoke<Project>("set_text_style", { layerId, style });

/** Set a text layer's After Effects-style per-character animators. */
export const setTextAnimators = (layerId: number, animators: TextAnimator[]) =>
  invoke<Project>("set_text_animators", { layerId, animators });

/** Set (or clear with null) a text layer's whole-layer styles. */
export const setTextLayerStyles = (layerId: number, styles: TextLayerStyles | null) =>
  invoke<Project>("set_text_layer_styles", { layerId, styles });

/** Toggle per-character 3D on a text layer + set its base rotation controls (deg). */
export const setTextPerChar3d = (layerId: number, enabled: boolean, rx: number, ry: number, spread: number) =>
  invoke<Project>("set_text_per_char_3d", { layerId, enabled, rx, ry, spread });

/** A single glyph's manual pose (decompose mode) at one instant. */
export interface LetterPose {
  dx: number;
  dy: number;
  rotation: number;
  scale: number;
}

/** Key one glyph's manual transform at `tMs` (decompose mode) — keyframeable so
 * each letter can be animated over time. */
export const setLetterOverride = (
  layerId: number,
  index: number,
  pose: LetterPose,
  tMs: number,
  seedStart: boolean
) =>
  invoke<Project>("set_letter_override", {
    layerId,
    index,
    dx: pose.dx,
    dy: pose.dy,
    rotation: pose.rotation,
    scale: pose.scale,
    tMs,
    seedStart,
  });

/** Clear all manual per-glyph overrides on a text layer. */
export const clearLetterOverrides = (layerId: number) =>
  invoke<Project>("clear_letter_overrides", { layerId });

/** Key one glyph's fill colour at `tMs` (decompose mode) — colour a letter
 * individually, keyframeable over time. */
export const setLetterColor = (
  layerId: number,
  index: number,
  color: Rgba,
  tMs: number,
  seedStart: boolean
) => invoke<Project>("set_letter_color", { layerId, index, color, tMs, seedStart });

/** Revert one glyph's colour to the layer colour. */
export const clearLetterColor = (layerId: number, index: number) =>
  invoke<Project>("clear_letter_color", { layerId, index });

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

/** Add a multi-frame grid (rows×cols) of image cells. */
export const addFrameGrid = (rows: number, cols: number) =>
  invoke<Project>("add_frame_grid", { rows, cols });

/** Keep only the paths that still exist on disk (prunes the persisted media bin). */
export const filterExistingFiles = (paths: string[]) =>
  invoke<string[]>("filter_existing_files", { paths });

/** Set the project's media bin (imported file paths). Saved with the project. */
export const setMedia = (media: string[]) => invoke<Project>("set_media", { media });

/** Set (or replace) the image in one grid cell (row-major index). */
export const setCellImage = (layerId: number, cell: number, path: string) =>
  invoke<Project>("set_cell_image", { layerId, cell, path });

/** Set a frame grid's shared background image (each cell shows its slice). */
export const setGridBackground = (layerId: number, path: string) =>
  invoke<Project>("set_grid_background", { layerId, path });

/** Clear a frame grid's shared background (cells revert to their own images). */
export const clearGridBackground = (layerId: number) =>
  invoke<Project>("clear_grid_background", { layerId });

/** Clear the image from one grid cell. */
export const clearCellImage = (layerId: number, cell: number) =>
  invoke<Project>("clear_cell_image", { layerId, cell });

/** Set (or clear, engine=null) a grid cell's in/out transition. */
export const setCellTransition = (
  layerId: number,
  cell: number,
  slot: "in" | "out",
  durMs: number,
  direction: number,
  engine: string | null,
  params: string | null
) => invoke<Project>("set_cell_transition", { layerId, cell, slot, durMs, direction, engine, params });

/** Set (or clear, engine=null) the SAME in/out transition on every grid cell. */
export const setAllCellsTransition = (
  layerId: number,
  slot: "in" | "out",
  durMs: number,
  direction: number,
  engine: string | null,
  params: string | null
) => invoke<Project>("set_all_cells_transition", { layerId, slot, durMs, direction, engine, params });

/** Keyframe a grid cell's image zoom at the playhead (1 = fit, >1 = zoomed in). */
export const setCellZoom = (
  layerId: number,
  cell: number,
  zoom: number,
  tMs: number,
  seedStart: boolean
) => invoke<Project>("set_cell_zoom", { layerId, cell, zoom, tMs, seedStart });

/** Keyframe a grid cell's image pan (position within its cell, fractions of the
 *  cell; 0 = centred) on both axes at the playhead. */
export const setCellPan = (
  layerId: number,
  cell: number,
  x: number,
  y: number,
  tMs: number,
  seedStart: boolean
) => invoke<Project>("set_cell_pan", { layerId, cell, x, y, tMs, seedStart });

/** Move grid lattice vertices to new local positions (keyframed at the playhead).
 *  Each update is the new absolute local (x,y) for the vertex `index`. */
export const setGridVertices = (
  layerId: number,
  updates: { index: number; x: number; y: number }[],
  tMs: number,
  seedStart: boolean
) => invoke<Project>("set_grid_vertices", { layerId, updates, tMs, seedStart });

/** Set a grid's vertex-drag constraint mode. */
export const setGridConstrain = (layerId: number, mode: ConstrainMode) =>
  invoke<Project>("set_grid_constrain", { layerId, mode });

/** Set the grid's line thickness in layer-local px (0 = hidden). */
export const setGridLineWidth = (layerId: number, width: number) =>
  invoke<Project>("set_grid_line_width", { layerId, width });

/** Keyframe the grid line colour at the playhead (so it can animate). */
export const setGridLineColor = (layerId: number, color: Rgba, tMs: number, seedStart: boolean) =>
  invoke<Project>("set_grid_line_color", { layerId, color, tMs, seedStart });

/** Clear the grid line-colour keyframes, freezing it at `color`. */
export const clearGridLineColor = (layerId: number, color: Rgba) =>
  invoke<Project>("clear_grid_line_color", { layerId, color });

/** Merge a grid cell with its neighbour ("right" or "down") into a merged block. */
export const mergeCell = (layerId: number, cell: number, dir: "right" | "down") =>
  invoke<Project>("merge_cell", { layerId, cell, dir });

/** Split a merged cell back into single slots. */
export const splitCell = (layerId: number, cell: number) =>
  invoke<Project>("split_cell", { layerId, cell });

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

/** All keyframeable effect-parameter names across every effect kind. */
export type EffectParam =
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
  | "opacity"
  | "detail"
  | "extra";

/** Key one effect parameter at a time (animates the effect). */
export const keyEffect = (
  layerId: number,
  index: number,
  param: EffectParam,
  tMs: number,
  value: number,
  seedStart: boolean
) => invoke<Project>("key_effect", { layerId, index, param, tMs, value, seedStart });

/** Set a wipe effect's static fields (angle + invert). */
export const setWipeStatic = (layerId: number, index: number, angle: number, invert: boolean) =>
  invoke<Project>("set_wipe_static", { layerId, index, angle, invert });

/** Set a shiny-clouds effect's static fields (tint + blend mode). */
export const setShineStatic = (layerId: number, index: number, tint: Rgba, blend: number) =>
  invoke<Project>("set_shine_static", { layerId, index, tint, blend });

/** Set a GPU-overlay effect's static fields (effect, tints, flare pos, blend). */
export const setGpuFxStatic = (
  layerId: number,
  index: number,
  effect: number,
  tint: Rgba,
  tint2: Rgba,
  posX: number,
  posY: number,
  blend: number
) => invoke<Project>("set_gpufx_static", { layerId, index, effect, tint, tint2, posX, posY, blend });

// --- Per-cell effects (multi-frame grid) ---
export const addCellEffect = (layerId: number, cell: number, kind: string) =>
  invoke<Project>("add_cell_effect", { layerId, cell, kind });

export const removeCellEffect = (layerId: number, cell: number, index: number) =>
  invoke<Project>("remove_cell_effect", { layerId, cell, index });

export const keyCellEffect = (
  layerId: number,
  cell: number,
  index: number,
  param: EffectParam,
  tMs: number,
  value: number,
  seedStart: boolean
) => invoke<Project>("key_cell_effect", { layerId, cell, index, param, tMs, value, seedStart });

export const setCellWipeStatic = (
  layerId: number,
  cell: number,
  index: number,
  angle: number,
  invert: boolean
) => invoke<Project>("set_cell_wipe_static", { layerId, cell, index, angle, invert });

export const setCellShineStatic = (
  layerId: number,
  cell: number,
  index: number,
  tint: Rgba,
  blend: number
) => invoke<Project>("set_cell_shine_static", { layerId, cell, index, tint, blend });

export const setCellGpuFxStatic = (
  layerId: number,
  cell: number,
  index: number,
  effect: number,
  tint: Rgba,
  tint2: Rgba,
  posX: number,
  posY: number,
  blend: number
) => invoke<Project>("set_cell_gpufx_static", { layerId, cell, index, effect, tint, tint2, posX, posY, blend });

// Copy/paste a cell's whole effect stack. `pasteCellEffects` replaces one cell's
// stack; `pasteCellEffectsAll` stamps it onto every cell (optionally skipping the
// source cell). Retime/delete a cell's keyframes from its child timeline.
export const pasteCellEffects = (layerId: number, cell: number, effects: Effect[]) =>
  invoke<Project>("paste_cell_effects", { layerId, cell, effects });

export const pasteCellEffectsAll = (layerId: number, effects: Effect[], except: number | null) =>
  invoke<Project>("paste_cell_effects_all", { layerId, effects, except });

export const moveCellKeyframesAt = (layerId: number, cell: number, fromMs: number, toMs: number) =>
  invoke<Project>("move_cell_keyframes_at", { layerId, cell, fromMs, toMs });

export const deleteCellKeyframesAt = (layerId: number, cell: number, tMs: number) =>
  invoke<Project>("delete_cell_keyframes_at", { layerId, cell, tMs });

// --- Linked (shared) effect groups (multi-frame grid) ---
export const linkEffect = (layerId: number, kind: string, cells: number[]) =>
  invoke<Project>("link_effect", { layerId, kind, cells });

export const addLinkedEffect = (layerId: number, groupId: number, kind: string) =>
  invoke<Project>("add_linked_effect", { layerId, groupId, kind });

export const removeLinkedEffectItem = (layerId: number, groupId: number, index: number) =>
  invoke<Project>("remove_linked_effect_item", { layerId, groupId, index });

export const keyLinkedEffect = (
  layerId: number,
  groupId: number,
  index: number,
  param: EffectParam,
  tMs: number,
  value: number,
  seedStart: boolean
) => invoke<Project>("key_linked_effect", { layerId, groupId, index, param, tMs, value, seedStart });

export const setLinkedWipeStatic = (
  layerId: number,
  groupId: number,
  index: number,
  angle: number,
  invert: boolean
) => invoke<Project>("set_linked_wipe_static", { layerId, groupId, index, angle, invert });

export const removeLinkedGroup = (layerId: number, groupId: number) =>
  invoke<Project>("remove_linked_group", { layerId, groupId });

export const setLinkedMember = (layerId: number, groupId: number, cell: number, member: boolean) =>
  invoke<Project>("set_linked_member", { layerId, groupId, cell, member });

export const unlinkCell = (layerId: number, groupId: number, cell: number) =>
  invoke<Project>("unlink_cell", { layerId, groupId, cell });

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
/** One audio clip to mux into the export: source path, comp start, play length. */
export interface AudioTrackSpec {
  path: string;
  startMs: number;
  playMs: number;
}

export const exportVideo = (
  base64: string,
  path: string,
  format: "mp4" | "webm",
  level: number,
  audio: AudioTrackSpec[],
  durationMs: number
) =>
  invoke<void>("export_video", {
    webmBase64: base64,
    path,
    format,
    level,
    audio,
    durationMs,
  });

/** Delete a layer (object). Shapes detach any layers pinned to them. */
export const deleteLayer = (layerId: number) =>
  invoke<Project>("delete_layer", { layerId });

/** Duplicate a layer (copy/paste); returns the project with the clone on top. */
export const duplicateLayer = (layerId: number) =>
  invoke<Project>("duplicate_layer", { layerId });

/** Split ("cut") a layer at `tMs` into two independent segments. */
export const splitLayer = (layerId: number, tMs: number) =>
  invoke<Project>("split_layer", { layerId, tMs });

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
